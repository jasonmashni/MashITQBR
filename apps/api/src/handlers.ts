import {
  advanceStatus,
  computeScorecard,
  isQbrStatus,
  lastPeriods,
  periodFor,
  type MetricCategory,
  type MetricValue,
  type QbrStatus,
} from '@mashit/core';
import { createClaudeNarrativeModel, type NarrativeModel } from '@mashit/narrative';
import { renderDeck, renderPdf } from '@mashit/report';
import { FetchHttpTransport, type McpTransport } from '@mashit/integrations';
import { buildQbrReport, renderQbrHtml } from './service.js';
import {
  dataStoreKind,
  ensureSeeded,
  getDataStore,
  getSecretStore,
  isConnectionType,
  loadReportInputs,
  narrativeCacheFor,
  secretStoreKind,
  storeDataSource,
  toConnectionView,
} from './store/index.js';
import { removeConnection, resolveSecret, saveConnection, type ConnectionInput } from './connections.js';
import { currentActor } from './requestContext.js';
import type { Principal } from './auth.js';
import { importHaloClients, listOrgs, syncClientMetrics, testConnection, type Integrations } from './integrationsService.js';
import { pushAction, type PushInput } from './actions.js';
import { HttpMcpTransport, memoizedMcpTransport } from './mcpClient.js';

export interface ApiResult {
  status: number;
  json?: unknown;
  html?: string;
  pdf?: Buffer;
  pptx?: Buffer;
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
export async function getReportPdf(clientId: string, period: string, ai: string | null): Promise<ApiResult> {
  let html: string;
  try {
    html = renderQbrHtml(await buildReportFor(clientId, period, ai));
  } catch (e) {
    return mapBuildError(e); // a missing client shouldn't read as "PDF unavailable"
  }
  try {
    const pdf = await renderPdf(html, { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] });
    return { status: 200, pdf };
  } catch (e) {
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
    const { snapshot, warnings } = await syncClientMetrics(await buildIntegrations(), clientId, period);
    const store = getDataStore();
    const existing = await store.getQbr(clientId, period);
    // Forward-only: a re-sync must not demote a scheduled/completed QBR.
    const status = advanceStatus(existing?.status, 'data_synced');
    await store.upsertQbr({ clientId, period, status, meeting: existing?.meeting, updatedAt: new Date().toISOString() });
    audit('qbr.sync', `qbr:${clientId}/${period}`, `${snapshot.metrics.length} metric(s)`);
    return ok({ metrics: snapshot.metrics.length, warnings });
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
  body: { actionId?: string; target: PushInput['target']; title?: string; detail?: string },
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

export function currentPeriod(): ApiResult {
  return ok({ period: periodFor(new Date()).id });
}

/**
 * Dashboard rollup in one call: for each QBR-enabled client, the newest
 * snapshot within the last 4 quarters scored with computeScorecard only —
 * no narrative or report build.
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
      const scorecard = snapshot ? computeScorecard(snapshot) : undefined;
      const qbr = period ? await store.getQbr(client.id, period) : undefined;
      return {
        clientId: client.id,
        name: client.name,
        industry: client.industry,
        hipaa: client.hipaa,
        period: period ?? null,
        score: scorecard?.overall.score ?? null,
        rating: scorecard?.overall.rating ?? 'unknown',
        status: qbr?.status ?? 'draft',
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

// Playwright is an optional external; on Azure Consumption it isn't installed.
// Variable specifier avoids a hard compile-time dependency (same as renderPdf).
let _pdfAvailable: Promise<boolean> | undefined;
function pdfAvailable(): Promise<boolean> {
  const spec = 'playwright';
  _pdfAvailable ??= import(spec).then(
    () => true,
    () => false,
  );
  return _pdfAvailable;
}

/** Runtime capabilities — lets the UI gate features and show accurate copy. */
export async function getSystem(): Promise<ApiResult> {
  return ok({
    dataStore: dataStoreKind(),
    secretStore: secretStoreKind(),
    ai: !!process.env['ANTHROPIC_API_KEY'],
    pdfAvailable: await pdfAvailable(),
  });
}

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
