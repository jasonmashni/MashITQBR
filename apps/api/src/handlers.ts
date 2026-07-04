import {
  advanceStatus,
  computeFlags,
  computeScorecard,
  isQbrStatus,
  lastPeriods,
  periodFor,
  previousPeriod,
  type MetricCategory,
  type MetricValue,
  type QbrStatus,
} from '@mashit/core';
import { createClaudeNarrativeModel, type NarrativeModel } from '@mashit/narrative';
import { renderDeck, renderPdf } from '@mashit/report';
import { FetchHttpTransport, fetchHaloMeta, listNinjaRoles, type McpTransport } from '@mashit/integrations';
import { buildQbrReport, renderQbrHtml } from './service.js';
import {
  dataStoreKind,
  docPath,
  ensureSeeded,
  getDataStore,
  getDocStore,
  getSecretStore,
  isConnectionType,
  loadReportInputs,
  narrativeCacheFor,
  ORG_SETTINGS_ID,
  secretStoreKind,
  storeDataSource,
  toConnectionView,
  OPPORTUNITY_STATUSES,
  type DocumentRecord,
  type OpportunityRecord,
  type OpportunityStatus,
} from './store/index.js';
import { removeConnection, resolveSecret, saveConnection, type ConnectionInput } from './connections.js';
import { currentActor } from './requestContext.js';
import type { HeaderGet, Principal } from './auth.js';
import { graphPost, graphTokenFrom, validEmails, type FetchLike } from './graph.js';
import { directHaloConn, importHaloClients, listOrgs, syncClientMetrics, testConnection, type Integrations } from './integrationsService.js';
import { pushAction, type PushInput } from './actions.js';
import { buildEmailDraft, qbrEmailBody } from './emailDraft.js';
import { clientInboxAddress, inboxConfigFromEnv, pollReportInbox } from './reportInbox.js';
import { appendPdfAttachments, loadPdfAttachments } from './pdfMerge.js';
import { HttpMcpTransport, memoizedMcpTransport } from './mcpClient.js';

export interface ApiResult {
  status: number;
  json?: unknown;
  html?: string;
  pdf?: Buffer;
  pptx?: Buffer;
  /** Arbitrary file download (attached documents, .eml drafts). */
  file?: { bytes: Buffer; contentType: string; filename: string };
}
const ok = (json: unknown): ApiResult => ({ status: 200, json });
const err = (status: number, message: string): ApiResult => ({ status, json: { error: message } });

/** Map a report-build failure: 404 for a missing client/snapshot, 500 otherwise. */
export function mapBuildError(e: unknown): ApiResult {
  const message = e instanceof Error ? e.message : 'Report build failed';
  return err(/^(Unknown client|No metric snapshot)/.test(message) ? 404 : 500, message);
}

/** Fire-and-forget compliance audit entry — a storage hiccup never fails the mutation. */
function audit(action: string, target: string, detail?: string): void {
  void getDataStore()
    .appendAudit({
      id: Math.random().toString(36).slice(2, 10),
      at: new Date().toISOString(),
      actor: currentActor(),
      action,
      target,
      detail,
    })
    .catch(() => undefined);
}

function aiModel(aiParam: string | null): NarrativeModel | undefined {
  const off = aiParam === '0';
  return !off && process.env['ANTHROPIC_API_KEY'] ? createClaudeNarrativeModel() : undefined;
}

/** Build the MASH MCP transport from the configured 'mcp' connection, if any. */
async function resolveMcp(): Promise<McpTransport | undefined> {
  const store = getDataStore();
  const conn = (await store.listConnections()).find((c) => c.type === 'mcp');
  if (!conn) return undefined;
  const url = conn.config['url'] ?? conn.config['baseUrl'];
  if (!url) return undefined;
  const secrets = getSecretStore();
  const clientSecret = await resolveSecret(secrets, conn, 'clientSecret');
  const token = await resolveSecret(secrets, conn, 'token');
  // Memoized per connection version so the OAuth token cache survives requests.
  return memoizedMcpTransport(`${conn.id}@${conn.updatedAt}`, () =>
    new HttpMcpTransport(url, {
      token,
      clientId: conn.config['clientId'],
      clientSecret,
      tokenUrl: conn.config['tokenUrl'],
      tokenAuthMethod: conn.config['tokenAuthMethod'] === 'post' ? 'post' : conn.config['tokenAuthMethod'] === 'basic' ? 'basic' : undefined,
    }),
  );
}

async function buildIntegrations(): Promise<Integrations> {
  return { store: getDataStore(), secrets: getSecretStore(), mcp: await resolveMcp(), http: new FetchHttpTransport() };
}

// ── Clients + report ────────────────────────────────────────────────────────
export async function listClients(): Promise<ApiResult> {
  const store = getDataStore();
  await ensureSeeded(store);
  return ok({ clients: await store.listClients() });
}

/** Fields a client PUT may change — everything else in the body is ignored. */
const CLIENT_PATCH_FIELDS = ['name', 'industry', 'hipaa', 'qbrEnabled', 'integrationRefs', 'primaryContact'] as const;

export async function updateClient(id: string, patch: Record<string, unknown>): Promise<ApiResult> {
  const store = getDataStore();
  const existing = (await store.getClient(id)) ?? { id, name: id };
  const allowed = Object.fromEntries(
    Object.entries(patch).filter(([k]) => (CLIENT_PATCH_FIELDS as readonly string[]).includes(k)),
  );
  const merged = { ...existing, ...allowed, id };
  await store.upsertClient(merged as typeof existing);
  audit('client.update', `client:${id}`, Object.keys(allowed).join(','));
  return ok(merged);
}

export async function getQbr(clientId: string, period: string, ai: string | null): Promise<ApiResult> {
  try {
    const report = await buildReportFor(clientId, period, ai);
    const meta = (await getDataStore().getQbr(clientId, period)) ?? { clientId, period, status: 'draft' as QbrStatus };
    return ok({ model: report.model, warnings: report.warnings, verification: report.narrative.verification.ok, meta });
  } catch (e) {
    return mapBuildError(e);
  }
}

async function buildReportFor(clientId: string, period: string, ai: string | null) {
  const store = getDataStore();
  return buildQbrReport(storeDataSource(), clientId, period, {
    narrativeModel: aiModel(ai),
    narrativeCache: narrativeCacheFor(store, clientId, period),
    ...(await loadReportInputs(store, clientId, period)),
  });
}

export async function getReportHtml(clientId: string, period: string, ai: string | null): Promise<ApiResult> {
  try {
    return { status: 200, html: renderQbrHtml(await buildReportFor(clientId, period, ai)) };
  } catch (e) {
    return mapBuildError(e);
  }
}
/** The full QBR PDF: the designed report with attached PDF reports appended. */
async function buildFullPdf(clientId: string, period: string, ai: string | null): Promise<Buffer> {
  const report = await buildReportFor(clientId, period, ai);
  const pdf = await renderPdf(report.model);
  // Vendor reports ride at the back of the deliverable (appendix lists them).
  const attachments = await loadPdfAttachments(getDataStore(), getDocStore(), clientId, period).catch(() => []);
  return appendPdfAttachments(pdf, attachments);
}

export async function getReportPdf(clientId: string, period: string, ai: string | null): Promise<ApiResult> {
  try {
    return { status: 200, pdf: await buildFullPdf(clientId, period, ai) };
  } catch (e) {
    if (e instanceof Error && /^(Unknown client|No metric snapshot)/.test(e.message)) return mapBuildError(e);
    return err(501, e instanceof Error ? e.message : 'PDF rendering unavailable');
  }
}
export async function getReportDeck(clientId: string, period: string, ai: string | null): Promise<ApiResult> {
  let report;
  try {
    report = await buildReportFor(clientId, period, ai);
  } catch (e) {
    return mapBuildError(e);
  }
  try {
    return { status: 200, pptx: await renderDeck(report.model) };
  } catch (e) {
    return err(501, e instanceof Error ? e.message : 'Deck rendering unavailable');
  }
}

// ── Org settings (Mash IT branding used as the default on every deliverable) ──
export async function getOrgSettings(): Promise<ApiResult> {
  const cfg = await getDataStore().getReportConfig(ORG_SETTINGS_ID);
  return ok({ brand: cfg?.brand ?? {} });
}

export async function putOrgSettings(body: Record<string, unknown>): Promise<ApiResult> {
  const raw = (body['brand'] ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : undefined);
  const logo = str('logoDataUri');
  if (logo && !/^data:image\/(png|jpe?g|svg\+xml|webp);base64,/.test(logo)) {
    return err(400, 'Logo must be an embedded PNG/JPEG/SVG/WebP image.');
  }
  if (logo && logo.length > 700_000) return err(400, 'Logo is too large — keep it under 500 KB.');
  const brand = { name: str('name'), logoDataUri: logo, primary: str('primary'), accent: str('accent') };
  await getDataStore().putReportConfig({ clientId: ORG_SETTINGS_ID, brand });
  audit('settings.org', 'settings:org', Object.keys(brand).filter((k) => (brand as Record<string, unknown>)[k]).join(','));
  return ok({ brand });
}

// ── Config + discussion ──────────────────────────────────────────────────────
export async function getConfig(clientId: string): Promise<ApiResult> {
  return ok((await getDataStore().getReportConfig(clientId)) ?? { clientId });
}
export async function putConfig(clientId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const saved = await getDataStore().putReportConfig({ ...body, clientId } as never);
  audit('config.save', `client:${clientId}`);
  return ok(saved);
}
export async function getDiscussion(clientId: string, period: string): Promise<ApiResult> {
  return ok((await getDataStore().getDiscussion(clientId, period)) ?? { clientId, period, items: [] });
}
export async function putDiscussion(clientId: string, period: string, body: Record<string, unknown>): Promise<ApiResult> {
  const store = getDataStore();
  const items = Array.isArray(body['items']) ? (body['items'] as never[]) : [];
  const saved = await store.putDiscussion({ clientId, period, items, notes: body['notes'] as string | undefined });
  audit('discussion.save', `qbr:${clientId}/${period}`, `${saved.items.length} item(s)`);

  // Any captured non-pending disposition moves the QBR forward to 'dispositioned'.
  const dispositioned = saved.items.some((i) => i.disposition && i.disposition !== 'pending');
  if (dispositioned) {
    const existing = await store.getQbr(clientId, period);
    const status = advanceStatus(existing?.status, 'dispositioned');
    if (status !== existing?.status) {
      await store.upsertQbr({ clientId, period, status, meeting: existing?.meeting, updatedAt: new Date().toISOString() });
    }
  }
  return ok(saved);
}

// ── Narrative editor ─────────────────────────────────────────────────────────
export async function getNarrativeState(clientId: string, period: string): Promise<ApiResult> {
  const rec = await getDataStore().getNarrative(clientId, period);
  return ok({ edits: rec?.edits ?? null, hasCached: !!rec?.result });
}

/** Save author edits — undefined/blank fields fall back to the generated text. */
export async function putNarrativeEdits(clientId: string, period: string, body: Record<string, unknown>): Promise<ApiResult> {
  const lines = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.map((s) => String(s).trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  const headline = typeof body['headline'] === 'string' && body['headline'].trim() ? body['headline'].trim() : undefined;
  const summary_paragraphs = lines(body['summary_paragraphs']);
  const highlights = lines(body['highlights']);
  const recommendations = lines(body['recommendations']);

  const store = getDataStore();
  const existing = await store.getNarrative(clientId, period);
  const now = new Date().toISOString();
  const empty = !headline && !summary_paragraphs && !highlights && !recommendations;
  const edits = empty
    ? undefined
    : { headline, summary_paragraphs, highlights, recommendations, editedBy: currentActor(), editedAt: now };

  await store.putNarrative({ clientId, period, inputHash: existing?.inputHash, result: existing?.result, edits, updatedAt: now });
  audit('narrative.edit', `qbr:${clientId}/${period}`, empty ? 'edits cleared' : 'edited');
  return ok({ edits: edits ?? null });
}

/** Drop the cached AI narrative AND edits so the next build re-drafts fresh. */
export async function regenerateNarrative(clientId: string, period: string): Promise<ApiResult> {
  await getDataStore().putNarrative({ clientId, period, updatedAt: new Date().toISOString() });
  audit('narrative.regenerate', `qbr:${clientId}/${period}`);
  return ok({ cleared: true });
}

// ── Data review (raw snapshot + manual metrics) ──────────────────────────────
export async function getMetrics(clientId: string, period: string): Promise<ApiResult> {
  const store = getDataStore();
  const snapshot = await storeDataSource(store).getSnapshot(clientId, period);
  if (!snapshot) return err(404, `No metric snapshot for ${clientId} ${period} — run a Sync first.`);
  const config = await store.getReportConfig(clientId);
  return ok({ snapshot, excluded: config?.excludedMetrics ?? [] });
}

const METRIC_CATEGORIES: readonly MetricCategory[] = ['operations', 'security', 'identity', 'backup', 'infrastructure', 'spend'];

/** Replace the snapshot's manual metrics with the submitted set (add/edit/delete). */
export async function putManualMetrics(clientId: string, period: string, body: Record<string, unknown>): Promise<ApiResult> {
  const store = getDataStore();
  // Seed snapshots materialize into the store on first manual edit.
  const base = (await storeDataSource(store).getSnapshot(clientId, period)) ?? {
    clientId,
    period,
    capturedAt: new Date().toISOString(),
    metrics: [] as MetricValue[],
  };

  const manual: MetricValue[] = [];
  for (const raw of Array.isArray(body['metrics']) ? (body['metrics'] as Array<Record<string, unknown>>) : []) {
    const label = typeof raw['label'] === 'string' ? raw['label'].trim() : '';
    const value = raw['value'];
    const category = raw['category'];
    if (!label || (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')) {
      return err(400, 'Each manual metric needs a label and a value.');
    }
    if (!METRIC_CATEGORIES.includes(category as MetricCategory)) {
      return err(400, `Unknown category: ${String(category)}`);
    }
    const key = typeof raw['key'] === 'string' && raw['key'].startsWith('manual.')
      ? raw['key']
      : `manual.${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    manual.push({
      key,
      label,
      value,
      unit: typeof raw['unit'] === 'string' && raw['unit'] ? raw['unit'] : undefined,
      source: 'manual',
      category: category as MetricCategory,
      higherIsBetter: typeof raw['higherIsBetter'] === 'boolean' ? raw['higherIsBetter'] : undefined,
    });
  }

  const kept = base.metrics.filter((m) => m.source !== 'manual');
  const updated = { ...base, clientId, period, metrics: [...kept, ...manual] };
  await store.putSnapshot(updated);
  audit('metrics.manual', `qbr:${clientId}/${period}`, `${manual.length} manual metric(s)`);
  return ok({ metrics: updated.metrics.length, manual: manual.length });
}

// ── Attached documents (vendor reports + uploads) ────────────────────────────
/** Keep uploads/auto-pulls comfortably inside Functions request limits. */
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export async function listQbrDocuments(clientId: string, period: string): Promise<ApiResult> {
  const docs = await getDataStore().listDocuments(clientId, period);
  return ok({ documents: docs.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)) });
}

/** Store one document (bytes → content store, metadata → data store). */
async function storeDocument(input: {
  clientId: string;
  period: string;
  name: string;
  contentType: string;
  bytes: Buffer;
  source: string;
}): Promise<DocumentRecord> {
  const store = getDataStore();
  // Same source+name replaces the previous version (re-syncs stay tidy).
  const existing = (await store.listDocuments(input.clientId, input.period)).find(
    (d) => d.source === input.source && d.name === input.name,
  );
  const id = existing?.id ?? Math.random().toString(36).slice(2, 10);
  const record: DocumentRecord = {
    id,
    clientId: input.clientId,
    period: input.period,
    name: input.name,
    source: input.source,
    contentType: input.contentType,
    size: input.bytes.length,
    uploadedAt: new Date().toISOString(),
    uploadedBy: currentActor(),
  };
  await getDocStore().put(docPath(input.clientId, input.period, id, input.name), input.bytes, input.contentType);
  await store.putDocument(record);
  return record;
}

export async function uploadQbrDocument(
  clientId: string,
  period: string,
  body: { name?: string; contentType?: string; dataBase64?: string },
): Promise<ApiResult> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const data = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
  if (!name || !data) return err(400, 'A file name and base64 content are required.');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, 'base64');
  } catch {
    return err(400, 'Invalid base64 content.');
  }
  if (bytes.length === 0) return err(400, 'Empty file.');
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return err(400, `File is too large (${Math.round(bytes.length / 1024 / 1024)} MB) — the limit is 15 MB.`);
  }
  const record = await storeDocument({
    clientId,
    period,
    name,
    contentType: body.contentType || 'application/octet-stream',
    bytes,
    source: 'upload',
  });
  audit('document.upload', `qbr:${clientId}/${period}`, `${name} (${Math.round(bytes.length / 1024)} KB)`);
  return ok(record);
}

export async function downloadQbrDocument(clientId: string, period: string, id: string): Promise<ApiResult> {
  const record = await getDataStore().getDocument(clientId, period, id);
  if (!record) return err(404, 'Unknown document');
  const bytes = await getDocStore().get(docPath(clientId, period, record.id, record.name));
  if (!bytes) return err(404, 'Document content missing');
  return { status: 200, file: { bytes, contentType: record.contentType, filename: record.name } };
}

export async function deleteQbrDocument(clientId: string, period: string, id: string): Promise<ApiResult> {
  const store = getDataStore();
  const record = await store.getDocument(clientId, period, id);
  if (!record) return err(404, 'Unknown document');
  await getDocStore().delete(docPath(clientId, period, record.id, record.name));
  await store.deleteDocument(clientId, period, id);
  audit('document.delete', `qbr:${clientId}/${period}`, record.name);
  return ok({ deleted: id });
}

// ── Opportunity board (per-client Kanban of QBR initiatives) ─────────────────
const OPP_ORDER: Record<string, number> = { idea: 0, discussing: 1, approved: 2, pushed: 3, closed: 4 };

export async function listOpportunities(clientId: string): Promise<ApiResult> {
  const items = await getDataStore().listOpportunities(clientId);
  items.sort((a, b) => (OPP_ORDER[a.status] ?? 9) - (OPP_ORDER[b.status] ?? 9) || b.updatedAt.localeCompare(a.updatedAt));
  return ok({ opportunities: items });
}

export async function putOpportunity(clientId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
  if (!title) return err(400, 'An opportunity needs a title.');
  const status =
    typeof body['status'] === 'string' && (OPPORTUNITY_STATUSES as readonly string[]).includes(body['status'])
      ? (body['status'] as OpportunityStatus)
      : 'idea';
  const store = getDataStore();
  const id = typeof body['id'] === 'string' && body['id'] ? body['id'] : Math.random().toString(36).slice(2, 10);
  const existing = (await store.listOpportunities(clientId)).find((o) => o.id === id);
  const now = new Date().toISOString();
  const record: OpportunityRecord = {
    id,
    clientId,
    title,
    detail: typeof body['detail'] === 'string' ? body['detail'] : existing?.detail,
    status,
    sourcePeriod: typeof body['sourcePeriod'] === 'string' && body['sourcePeriod'] ? body['sourcePeriod'] : existing?.sourcePeriod,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: existing?.createdBy ?? currentActor(),
    externalRef: existing?.externalRef,
    externalKind: existing?.externalKind,
  };
  await store.putOpportunity(record);
  audit('opportunity.save', `client:${clientId}`, `${existing ? 'updated' : 'created'}: ${title.slice(0, 60)}`);
  return ok({ opportunity: record });
}

export async function deleteOpportunity(clientId: string, id: string): Promise<ApiResult> {
  await getDataStore().deleteOpportunity(clientId, id);
  audit('opportunity.delete', `client:${clientId}`, id);
  return ok({ deleted: id });
}

/** Push a board card to Halo (opportunity or ticket) and mark it pushed. */
export async function pushOpportunity(
  clientId: string,
  id: string,
  body: { target?: PushInput['target']; ticketTypeId?: string; agentId?: string; team?: string; priorityId?: string },
): Promise<ApiResult> {
  const store = getDataStore();
  const record = (await store.listOpportunities(clientId)).find((o) => o.id === id);
  if (!record) return err(404, 'Unknown opportunity');
  const client = await store.getClient(clientId);
  const refs = (client?.integrationRefs ?? {}) as Record<string, string>;
  const target = body.target ?? 'halo_opportunity';
  try {
    const result = await pushAction(await buildIntegrations(), {
      target,
      title: record.title,
      detail: record.detail ?? (record.sourcePeriod ? `Raised in the ${record.sourcePeriod} QBR.` : ''),
      externalClientRef: target.startsWith('halo') ? refs['halo'] : refs['zomentum'],
      ticketTypeId: body.ticketTypeId,
      agentId: body.agentId,
      team: body.team,
      priorityId: body.priorityId,
    });
    const updated: OpportunityRecord = { ...record, status: 'pushed', updatedAt: new Date().toISOString(), externalRef: result.id, externalKind: target };
    await store.putOpportunity(updated);
    audit('opportunity.push', `client:${clientId}`, `${result.system} #${result.id}`);
    return ok({ opportunity: updated, pushed: result });
  } catch (e) {
    return err(502, e instanceof Error ? e.message : 'Push failed');
  }
}

/**
 * Poll the shared report mailbox now (the timer does this every 5 minutes).
 * Emails forwarded to {mailbox-local}+{clientId}@… file their attachments as
 * QBR documents for that client.
 */
// Last inbox-poll outcome (in-memory, per worker) — surfaced on /api/system
// so Settings shows whether ingestion is actually WORKING, not just configured.
let _lastInboxPoll: { at: string; ok: boolean; detail: string } | undefined;

export async function pollInbox(): Promise<ApiResult> {
  const cfg = inboxConfigFromEnv();
  if (!cfg) {
    return err(501, 'Report inbox not configured — set REPORTS_MAILBOX, REPORTS_TENANT_ID, REPORTS_CLIENT_ID and REPORTS_CLIENT_SECRET.');
  }
  try {
    const result = await pollReportInbox(cfg, getDataStore(), getDocStore());
    const folderNote = result.folders?.map((f) => `${f.folder}: ${f.unread} unread of ${f.total}`).join(', ');
    _lastInboxPoll = {
      at: new Date().toISOString(),
      ok: true,
      detail: `${result.filed} attachment(s) filed, ${result.unrouted} unrouted of ${result.processed} unread message(s)${folderNote ? ` — ${folderNote}` : ''}`,
    };
    if (result.filed > 0 || result.unrouted > 0) {
      audit('inbox.poll', `mailbox:${cfg.mailbox}`, `${result.filed} filed, ${result.unrouted} unrouted of ${result.processed}`);
    }
    return ok(result);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Inbox poll failed';
    _lastInboxPoll = { at: new Date().toISOString(), ok: false, detail };
    return err(502, detail);
  }
}

/** Fetch vendor-published report files surfaced during sync and attach them. */
async function attachSyncDocuments(
  clientId: string,
  period: string,
  documents: Array<{ source: string; name: string; url: string }>,
  warnings: string[],
): Promise<void> {
  for (const doc of documents) {
    try {
      const res = await fetch(doc.url);
      if (!res.ok) throw new Error(`fetch responded ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`unexpected size ${bytes.length}`);
      await storeDocument({
        clientId,
        period,
        name: doc.name,
        contentType: res.headers.get('content-type') || 'application/pdf',
        bytes,
        source: doc.source,
      });
    } catch (e) {
      warnings.push(`[${doc.source}] Report "${doc.name}" could not be fetched: ${e instanceof Error ? e.message : 'error'}`);
    }
  }
}

// ── Integrations ─────────────────────────────────────────────────────────────
export async function listIntegrations(): Promise<ApiResult> {
  return ok({ integrations: (await getDataStore().listConnections()).map(toConnectionView) });
}
export async function saveIntegration(body: ConnectionInput): Promise<ApiResult> {
  if (!body.type || !body.label) return err(400, 'type and label are required');
  if (!isConnectionType(body.type)) return err(400, `Unknown integration type: ${String(body.type)}`);
  const conn = await saveConnection(getDataStore(), getSecretStore(), body);
  audit('integration.save', `integration:${conn.type}/${conn.id}`, conn.label);
  return ok(toConnectionView(conn));
}
export async function deleteIntegration(id: string): Promise<ApiResult> {
  await removeConnection(getDataStore(), getSecretStore(), id);
  audit('integration.delete', `integration:${id}`, 'secrets purged');
  return ok({ deleted: id });
}
export async function testIntegration(id: string): Promise<ApiResult> {
  const store = getDataStore();
  const conn = await store.getConnection(id);
  if (!conn) return err(404, 'Unknown connection');

  const outcome = await testConnection(await buildIntegrations(), conn);
  // Persist the result so the Integrations cards show real state, not 'unknown'.
  await store.upsertConnection({
    ...conn,
    status: outcome.ok ? 'ok' : 'error',
    statusMessage: outcome.message ?? outcome.note,
    updatedAt: new Date().toISOString(),
  });
  audit('integration.test', `integration:${conn.type}/${conn.id}`, outcome.ok ? 'ok' : outcome.message);
  return ok({ ok: outcome.ok, error: outcome.ok ? undefined : outcome.message, note: outcome.note });
}

/** Selectable orgs inside a tool, for dropdown-based client mapping. */
export async function getIntegrationOrgs(id: string): Promise<ApiResult> {
  const conn = await getDataStore().getConnection(id);
  if (!conn) return err(404, 'Unknown connection');
  try {
    return ok({ orgs: await listOrgs(await buildIntegrations(), conn) });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'Failed to list organizations');
  }
}

/**
 * Halo lookup lists (types/agents/teams/priorities) for the push modal and
 * the ticket-type picker — cached ~5 min per connection. The Integrations
 * edit modal passes its connectionId so the lists come from the connection
 * being edited (a second Halo instance must never leak its ids into
 * another's config); without one, the default direct-Halo connection answers.
 */
const _haloMeta = new Map<string, { at: number; data: unknown }>();
export async function getHaloMeta(connectionId?: string | null): Promise<ApiResult> {
  const store = getDataStore();
  const halo = connectionId
    ? (await store.listConnections()).find((c) => c.id === connectionId && c.type === 'halo' && c.config['baseUrl'])
    : await directHaloConn(store);
  if (!halo) {
    return err(
      404,
      connectionId
        ? 'That HaloPSA connection was not found (or has no base URL saved yet).'
        : 'No direct HaloPSA connection configured — add one under Integrations to pick ticket type/agent.',
    );
  }
  const hit = _haloMeta.get(halo.id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return ok(hit.data);
  try {
    const cfg = {
      baseUrl: halo.config['baseUrl'] ?? '',
      clientId: halo.config['clientId'] ?? '',
      clientSecret: (await resolveSecret(getSecretStore(), halo, 'clientSecret')) ?? '',
      tenant: halo.config['tenant'] || undefined,
    };
    const meta = await fetchHaloMeta(new FetchHttpTransport(), cfg);
    _haloMeta.set(halo.id, { at: Date.now(), data: meta });
    return ok(meta);
  } catch (e) {
    return err(502, e instanceof Error ? e.message : 'Halo lookup lists unavailable');
  }
}

/** NinjaOne device-role lists for the connection's "Device roles" picker — cached ~5 min per connection. */
const _ninjaMeta = new Map<string, { at: number; data: unknown }>();
export async function getNinjaMeta(connectionId?: string | null): Promise<ApiResult> {
  const conns = await getDataStore().listConnections();
  const ninja = connectionId
    ? conns.find((c) => c.id === connectionId && c.type === 'ninja')
    : conns.find((c) => c.type === 'ninja');
  if (!ninja) return err(404, 'No NinjaOne connection configured — add one under Integrations to pick device roles.');
  const hit = _ninjaMeta.get(ninja.id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return ok(hit.data);
  try {
    const cfg = {
      baseUrl: ninja.config['baseUrl'] || undefined,
      clientId: ninja.config['clientId'] ?? '',
      clientSecret: (await resolveSecret(getSecretStore(), ninja, 'clientSecret')) ?? '',
    };
    const roles = await listNinjaRoles(new FetchHttpTransport(), cfg);
    const data = { roles };
    _ninjaMeta.set(ninja.id, { at: Date.now(), data });
    return ok(data);
  } catch (e) {
    return err(502, e instanceof Error ? e.message : 'NinjaOne role list unavailable');
  }
}

// ConnectionType → the integrationRefs key the sync pipeline reads. The MCP
// connection carries Halo, so its mappings land on refs.halo.
const REF_KEY: Record<string, string> = { mcp: 'halo' };

/** Bulk-map clients to their ids inside this tool. Blank ref clears the mapping. */
export async function putIntegrationMappings(
  id: string,
  body: { mappings?: Array<{ clientId: string; externalRef?: string }> },
): Promise<ApiResult> {
  const store = getDataStore();
  const conn = await store.getConnection(id);
  if (!conn) return err(404, 'Unknown connection');
  const refKey = REF_KEY[conn.type] ?? conn.type;
  let updated = 0;
  for (const m of Array.isArray(body.mappings) ? body.mappings : []) {
    if (!m.clientId) continue;
    const client = await store.getClient(m.clientId);
    if (!client) continue;
    const refs = { ...(client.integrationRefs ?? {}) } as Record<string, string>;
    const val = (m.externalRef ?? '').trim();
    if (val) refs[refKey] = val;
    else delete refs[refKey];
    await store.upsertClient({ ...client, integrationRefs: refs as never });
    updated++;
  }
  audit('integration.map', `integration:${conn.type}/${conn.id}`, `${updated} client(s) → ${refKey}`);
  return ok({ updated, refKey });
}

// ── Live pipeline + workflow ─────────────────────────────────────────────────
export async function importHalo(): Promise<ApiResult> {
  try {
    const clients = await importHaloClients(await buildIntegrations());
    audit('client.import', 'halo', `${clients.length} client(s)`);
    return ok({ imported: clients.length, clients });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'Import failed');
  }
}

export async function syncQbr(clientId: string, period: string): Promise<ApiResult> {
  try {
    const { snapshot, warnings, documents } = await syncClientMetrics(await buildIntegrations(), clientId, period);
    // Vendor-published report files (e.g. the Huntress quarterly PDF) attach automatically.
    await attachSyncDocuments(clientId, period, documents, warnings);
    const store = getDataStore();
    const existing = await store.getQbr(clientId, period);
    // Forward-only: a re-sync must not demote a scheduled/completed QBR.
    const status = advanceStatus(existing?.status, 'data_synced');
    await store.upsertQbr({ clientId, period, status, meeting: existing?.meeting, updatedAt: new Date().toISOString() });
    audit('qbr.sync', `qbr:${clientId}/${period}`, `${snapshot.metrics.length} metric(s)`);
    return ok({ metrics: snapshot.metrics.length, warnings, documents: documents.length });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'Sync failed');
  }
}

export async function putStatus(clientId: string, period: string, status: unknown): Promise<ApiResult> {
  // Manual status set is the explicit user override (incl. un-archiving) — validated, not advanced.
  if (!isQbrStatus(status)) return err(400, `Invalid status: ${String(status)}`);
  const store = getDataStore();
  const existing = await store.getQbr(clientId, period);
  const saved = await store.upsertQbr({ clientId, period, status, meeting: existing?.meeting, updatedAt: new Date().toISOString() });
  audit('qbr.status', `qbr:${clientId}/${period}`, status);
  return ok(saved);
}

export async function putSchedule(clientId: string, period: string, body: { scheduledAt?: string; joinUrl?: string }): Promise<ApiResult> {
  const store = getDataStore();
  const existing = await store.getQbr(clientId, period);
  const meeting = { ...existing?.meeting, scheduledAt: body.scheduledAt, joinUrl: body.joinUrl };
  // Booking a meeting advances data_synced/draft to scheduled without demoting later stages.
  const status = advanceStatus(existing?.status, 'scheduled');
  const saved = await store.upsertQbr({ clientId, period, status, meeting, updatedAt: new Date().toISOString() });
  audit('qbr.schedule', `qbr:${clientId}/${period}`, body.scheduledAt);
  return ok(saved);
}

export async function pushQbrAction(
  clientId: string,
  period: string,
  body: {
    actionId?: string;
    target: PushInput['target'];
    title?: string;
    detail?: string;
    ticketTypeId?: string;
    agentId?: string;
    team?: string;
    priorityId?: string;
  },
): Promise<ApiResult> {
  try {
    const store = getDataStore();
    const client = await store.getClient(clientId);
    const disc = await store.getDiscussion(clientId, period);
    const item = disc?.items.find((i) => i.id === body.actionId);
    const refs = (client?.integrationRefs ?? {}) as Record<string, string>;
    const externalClientRef = body.target.startsWith('halo') ? refs['halo'] : refs['zomentum'];

    const result = await pushAction(await buildIntegrations(), {
      target: body.target,
      title: body.title ?? item?.topic ?? 'QBR action',
      detail: body.detail ?? item?.response ?? '',
      externalClientRef,
      ticketTypeId: body.ticketTypeId,
      agentId: body.agentId,
      team: body.team,
      priorityId: body.priorityId,
    });

    if (disc && item) {
      item.externalRef = { system: result.system, id: result.id, status: result.status };
      await store.putDiscussion(disc);
    }

    audit('action.push', `qbr:${clientId}/${period}`, `${result.system} #${result.id}`);

    // A successful push is the workflow's last mile — advance the QBR.
    const existing = await store.getQbr(clientId, period);
    const status = advanceStatus(existing?.status, 'actions_pushed');
    if (status !== existing?.status) {
      await store.upsertQbr({ clientId, period, status, meeting: existing?.meeting, updatedAt: new Date().toISOString() });
    }
    return ok(result);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'Push failed');
  }
}

// ── Email draft (.eml opens in Outlook as an unsent message + PDF attached) ──
/** Keep the draft inside typical Exchange send limits. */
const MAX_EMAIL_ATTACHMENT_TOTAL = 20 * 1024 * 1024;

export async function getEmailDraft(clientId: string, period: string, ai: string | null): Promise<ApiResult> {
  let report;
  try {
    report = await buildReportFor(clientId, period, ai);
  } catch (e) {
    return mapBuildError(e);
  }
  const store = getDataStore();
  const client = await store.getClient(clientId);
  const brand = report.model.brand;

  const attachments: Array<{ name: string; contentType: string; bytes: Buffer }> = [];
  try {
    // The full deliverable (attached PDF reports already appended at the back).
    const pdf = await buildFullPdf(clientId, period, ai);
    attachments.push({ name: `QBR-${client?.name?.replace(/[^a-zA-Z0-9 -]+/g, '') ?? clientId}-${period}.pdf`, contentType: 'application/pdf', bytes: pdf });
  } catch {
    // Draft still works without the attachment.
  }
  // Every attached report also rides along as its own file (size-capped).
  try {
    const docsStore = getDocStore();
    let total = attachments.reduce((n, a) => n + a.bytes.length, 0);
    for (const doc of await store.listDocuments(clientId, period)) {
      const bytes = await docsStore.get(docPath(clientId, period, doc.id, doc.name)).catch(() => undefined);
      if (!bytes || total + bytes.length > MAX_EMAIL_ATTACHMENT_TOTAL) continue;
      attachments.push({ name: doc.name, contentType: doc.contentType, bytes });
      total += bytes.length;
    }
  } catch {
    // Attachments are best-effort.
  }

  const subject = `${brand.orgName} QBR — ${client?.name ?? clientId} ${report.model.period.label}`;
  const me = currentActor();
  const eml = buildEmailDraft({
    to: client?.primaryContact?.email,
    subject,
    bodyText: qbrEmailBody({
      contactName: client?.primaryContact?.name,
      periodLabel: report.model.period.label,
      orgName: brand.orgName,
      senderName: me !== 'system' && !me.includes('@') ? me : undefined,
    }),
    attachments,
  });
  audit('qbr.email_draft', `qbr:${clientId}/${period}`, `${client?.primaryContact?.email ?? 'no recipient'} · ${attachments.length} attachment(s)`);
  return { status: 200, file: { bytes: eml, contentType: 'message/rfc822', filename: `QBR-${clientId}-${period}.eml` } };
}

// ── Microsoft Graph (delegated, via the Easy Auth token store) ───────────────
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Graph rejects inline attachments over ~3 MB; leave headroom for base64 + envelope. */
const MAX_ATTACHMENT_BYTES = 2.5 * 1024 * 1024;

function graphToken(header: HeaderGet): { token: string } | { error: ApiResult } {
  const { token, expired } = graphTokenFrom(header);
  if (!token) return { error: err(401, 'graph_token_missing') };
  if (expired) return { error: err(401, 'token_expired') };
  return { token };
}

/** Email the QBR as the signed-in user (Graph sendMail), optionally attaching the deck. */
export async function emailQbr(
  clientId: string,
  period: string,
  body: { to?: unknown; subject?: string; bodyHtml?: string; attachDeck?: boolean },
  header: HeaderGet,
  fetchFn?: FetchLike,
): Promise<ApiResult> {
  const auth = graphToken(header);
  if ('error' in auth) return auth.error;
  const to = validEmails(body.to);
  if (!to.length) return err(400, 'At least one valid recipient email is required.');

  const client = await getDataStore().getClient(clientId);
  const subject = body.subject?.trim() || `Mash IT QBR — ${client?.name ?? clientId} ${period}`;

  const attachments: unknown[] = [];
  if (body.attachDeck) {
    let report;
    try {
      report = await buildReportFor(clientId, period, null);
    } catch (e) {
      return mapBuildError(e);
    }
    const pptx = await renderDeck(report.model);
    if (pptx.length > MAX_ATTACHMENT_BYTES) {
      return err(400, `Deck is too large to attach (${Math.round(pptx.length / 1024)} KB) — send the report link instead.`);
    }
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: `QBR-${clientId}-${period}.pptx`,
      contentType: PPTX_MIME,
      contentBytes: pptx.toString('base64'),
    });
  }

  const res = await graphPost(
    auth.token,
    '/me/sendMail',
    {
      message: {
        subject,
        body: { contentType: 'HTML', content: body.bodyHtml ?? '' },
        toRecipients: to.map((address) => ({ emailAddress: { address } })),
        ...(attachments.length ? { attachments } : {}),
      },
      saveToSentItems: true,
    },
    fetchFn,
  );
  if (res.status !== 202) {
    const detail = (res.json as { error?: { message?: string } } | undefined)?.error?.message;
    return err(502, `Graph sendMail failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  audit('qbr.email', `qbr:${clientId}/${period}`, `${to.join(', ')}${attachments.length ? ' +deck' : ''}`);
  return ok({ sent: true, to });
}

/** Create a Teams meeting on the signed-in user's calendar and schedule the QBR. */
export async function createMeeting(
  clientId: string,
  period: string,
  body: { start?: string; end?: string; attendees?: unknown; subject?: string },
  header: HeaderGet,
  fetchFn?: FetchLike,
): Promise<ApiResult> {
  const auth = graphToken(header);
  if ('error' in auth) return auth.error;
  const start = body.start && Number.isFinite(Date.parse(body.start)) ? new Date(body.start).toISOString() : undefined;
  if (!start) return err(400, 'A valid start date/time is required.');
  const end =
    body.end && Number.isFinite(Date.parse(body.end))
      ? new Date(body.end).toISOString()
      : new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();

  const store = getDataStore();
  const client = await store.getClient(clientId);
  const subject = body.subject?.trim() || `Mash IT QBR — ${client?.name ?? clientId} ${period}`;
  const attendees = validEmails(body.attendees);

  const res = await graphPost(
    auth.token,
    '/me/events',
    {
      subject,
      start: { dateTime: start, timeZone: 'UTC' },
      end: { dateTime: end, timeZone: 'UTC' },
      attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    },
    fetchFn,
  );
  if (res.status !== 201) {
    const detail = (res.json as { error?: { message?: string } } | undefined)?.error?.message;
    return err(502, `Graph event creation failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }

  const created = res.json as { id?: string; onlineMeeting?: { joinUrl?: string } };
  const existing = await store.getQbr(clientId, period);
  const meeting = {
    ...existing?.meeting,
    scheduledAt: start,
    joinUrl: created.onlineMeeting?.joinUrl ?? existing?.meeting?.joinUrl,
    eventId: created.id,
    attendees,
  };
  const status = advanceStatus(existing?.status, 'scheduled');
  await store.upsertQbr({ clientId, period, status, meeting, updatedAt: new Date().toISOString() });
  audit('qbr.meeting', `qbr:${clientId}/${period}`, `${start} · ${attendees.join(', ') || 'no attendees'}`);
  return ok({ scheduledAt: start, joinUrl: meeting.joinUrl, eventId: created.id });
}

export function currentPeriod(): ApiResult {
  return ok({ period: periodFor(new Date()).id });
}

/** Numeric metric lookup on a snapshot. */
function snapshotNum(s: { metrics: Array<{ key: string; value: unknown }> } | undefined, key: string): number | null {
  const v = s?.metrics.find((m) => m.key === key)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Admin dashboard rollup in one call: for each QBR-enabled client, the newest
 * snapshot within the last 4 quarters scored with computeScorecard, plus the
 * numbers an admin actually works from — last QBR + workflow state, rating,
 * MRR, spend vs last quarter, and attention flags. No narrative/report build.
 */
export async function getOverview(currentOverride?: string | null): Promise<ApiResult> {
  const store = getDataStore();
  await ensureSeeded(store);
  const ds = storeDataSource(store);
  const current = resolveCurrent(currentOverride);
  const candidates = lastPeriods(current, 4);
  const clients = (await store.listClients()).filter((c) => c.qbrEnabled !== false);

  const rows = await Promise.all(
    clients.map(async (client) => {
      let period: string | undefined;
      let snapshot;
      for (const p of candidates) {
        snapshot = await ds.getSnapshot(client.id, p);
        if (snapshot) {
          period = p;
          break;
        }
      }
      const previous = period ? await ds.getSnapshot(client.id, previousPeriod(period).id) : undefined;
      const scorecard = snapshot ? computeScorecard(snapshot) : undefined;
      const prevScorecard = previous ? computeScorecard(previous) : undefined;
      const qbr = period ? await store.getQbr(client.id, period) : undefined;

      const mrr = snapshotNum(snapshot, 'finance.mrr');
      const spendNow = snapshotNum(snapshot, 'finance.quarter_invoiced');
      const spendPrev = snapshotNum(previous, 'finance.quarter_invoiced');
      const spendDeltaPct =
        spendNow !== null && spendPrev !== null && spendPrev !== 0 ? Math.round(((spendNow - spendPrev) / spendPrev) * 1000) / 10 : null;

      const rating = scorecard?.overall.rating ?? 'unknown';
      const flags = computeFlags(snapshot, previous, {
        current: rating,
        previous: prevScorecard?.overall.rating,
      });

      return {
        clientId: client.id,
        name: client.name,
        industry: client.industry,
        hipaa: client.hipaa,
        period: period ?? null,
        score: scorecard?.overall.score ?? null,
        rating,
        status: qbr?.status ?? 'draft',
        meetingAt: qbr?.meeting?.scheduledAt ?? null,
        mrr,
        spend: spendNow,
        spendDeltaPct,
        flags,
      };
    }),
  );
  return ok({ currentPeriod: current, clients: rows });
}

/** Which of the last 8 quarters have data for this client (store or seed). */
export async function getPeriods(clientId: string, currentOverride?: string | null): Promise<ApiResult> {
  const ds = storeDataSource(getDataStore());
  const current = resolveCurrent(currentOverride);
  const periods = await Promise.all(
    lastPeriods(current, 8).map(async (period) => ({ period, hasSnapshot: !!(await ds.getSnapshot(clientId, period)) })),
  );
  return ok({ currentPeriod: current, periods });
}

/** Honor a well-formed ?current= override (useful for tests/debugging). */
function resolveCurrent(override?: string | null): string {
  return override && /^\d{4}-Q[1-4]$/.test(override) ? override : periodFor(new Date()).id;
}

// PDF rendering rides pdfmake (pure JS) — available everywhere it's installed.
let _pdfAvailable: Promise<boolean> | undefined;
function pdfAvailable(): Promise<boolean> {
  const spec = 'pdfmake';
  _pdfAvailable ??= import(spec).then(
    () => true,
    () => false,
  );
  return _pdfAvailable;
}

// Build stamp written by assemble-deploy.mjs next to the bundle (absent in dev).
let _build: { sha?: string; builtAt?: string } | null | undefined;
async function buildStamp(): Promise<{ sha?: string; builtAt?: string } | null> {
  if (_build !== undefined) return _build;
  try {
    const { readFile } = await import('node:fs/promises');
    _build = JSON.parse(await readFile(new URL('./build.json', import.meta.url), 'utf8')) as { sha?: string; builtAt?: string };
  } catch {
    _build = null;
  }
  return _build;
}

/** Runtime capabilities — lets the UI gate features and show accurate copy. */
export async function getSystem(): Promise<ApiResult> {
  return ok({
    build: await buildStamp(),
    dataStore: dataStoreKind(),
    secretStore: secretStoreKind(),
    ai: !!process.env['ANTHROPIC_API_KEY'],
    pdfAvailable: await pdfAvailable(),
    // The shared report mailbox, when configured — the UI derives each
    // client's forwarding address from it — plus how the last poll went.
    reportsMailbox: inboxConfigFromEnv()?.mailbox ?? null,
    inboxLastPoll: _lastInboxPoll ?? null,
    // Presence only (never values) — lets Settings name exactly which app
    // setting the API can't see when the inbox reads "not configured".
    inboxEnvSeen: {
      REPORTS_MAILBOX: !!process.env['REPORTS_MAILBOX'],
      REPORTS_TENANT_ID: !!process.env['REPORTS_TENANT_ID'],
      REPORTS_CLIENT_ID: !!process.env['REPORTS_CLIENT_ID'],
      REPORTS_CLIENT_SECRET: !!process.env['REPORTS_CLIENT_SECRET'],
    },
  });
}

export { clientInboxAddress };

/** The signed-in user (Easy Auth). Local dev (JSON store) gets a fallback identity. */
export async function getMe(principal: Principal | undefined): Promise<ApiResult> {
  if (principal) return ok(principal);
  if (dataStoreKind() === 'json') return ok({ name: 'Local Dev', roles: [], dev: true });
  // In production Easy Auth fronts every request — never fabricate identity.
  return err(401, 'Not signed in');
}

/** Latest audit entries, newest first. */
export async function getAudit(limitParam: string | null): Promise<ApiResult> {
  const limit = Math.min(500, Math.max(1, Number(limitParam) || 100));
  return ok({ events: await getDataStore().listAudit(limit) });
}
