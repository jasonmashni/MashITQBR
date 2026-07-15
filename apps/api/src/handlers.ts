import {
  advanceStatus,
  CLIENT_GOAL_STATUSES,
  computeAccountHealth,
  computeFlags,
  computeScorecard,
  daysSince,
  isQbrStatus,
  lastPeriods,
  METRIC_CATEGORIES,
  parsePeriod,
  periodFor,
  previousPeriod,
  roadmapValue,
  type ClientGoal,
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
  type QbrRecord,
} from './store/index.js';
import { removeConnection, resolveSecret, saveConnection, type ConnectionInput } from './connections.js';
import { currentActor } from './requestContext.js';
import type { HeaderGet, Principal } from './auth.js';
import { graphPost, graphTokenFrom, validEmails, type FetchLike } from './graph.js';
import { directHaloConn, importHaloClients, listOrgs, syncClientMetrics, testConnection, type Integrations } from './integrationsService.js';
import { pushAction, type PushInput } from './actions.js';
import { buildEmailDraft, qbrEmailBody } from './emailDraft.js';
import { clientInboxAddress, inboxConfigFromEnv, pollReportInbox } from './reportInbox.js';
import {
  bookableWindow,
  candidateSlots,
  filterFreeSlots,
  isValidTimezone as isValidBookingTimezone,
  localToUtc,
  newBookingToken,
  resolveBookingSettings,
  slotEnd,
} from './booking.js';
import { createOrganizerEvent, deleteOrganizerEvent, getAvailabilityView, graphAppConfigFromEnv, sendOrganizerMail } from './graphApp.js';
import { renderBookingPage } from './bookingPage.js';
import { appendPdfAttachments, loadPdfAttachments, pdfFirstPages } from './pdfMerge.js';
import { createClaudeDocMatcher, type DocMatchModel } from './docMatch.js';
import { buildAgendaContext, createClaudeAgendaSuggester, offlineAgenda, type AgendaModel } from './agenda.js';
import { createClaudeDocExtractor, pdfSourceSlug, type DocExtractModel } from './docExtract.js';
import { HttpMcpTransport, memoizedMcpTransport } from './mcpClient.js';

export interface ApiResult {
  status: number;
  json?: unknown;
  html?: string;
  pdf?: Buffer;
  pptx?: Buffer;
  /** Download name for pdf/pptx payloads (Content-Disposition). */
  filename?: string;
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

/**
 * Merge-update a QBR record: read the existing row, spread it, apply the patch.
 * upsertQbr is a whole-record REPLACE in both stores, so any writer that builds
 * a fresh `{clientId, period, status, meeting, updatedAt}` literal silently
 * drops fields it doesn't mention (packageSentAt, future additions). Every
 * mutating call goes through here so nothing is lost.
 */
async function patchQbr(
  clientId: string,
  period: string,
  patch: Partial<Omit<QbrRecord, 'clientId' | 'period' | 'updatedAt'>>,
): Promise<QbrRecord> {
  const store = getDataStore();
  const existing = await store.getQbr(clientId, period);
  return store.upsertQbr({
    status: 'draft',
    ...existing,
    ...patch,
    clientId,
    period,
    updatedAt: new Date().toISOString(),
  });
}

/** Fire-and-forget in-portal notification (bell menu). */
export function notify(
  kind: string,
  title: string,
  opts: { body?: string; clientId?: string; period?: string; dedupeKey?: string } = {},
): void {
  void getDataStore()
    .appendNotification({
      id: Math.random().toString(36).slice(2, 10),
      at: new Date().toISOString(),
      kind,
      title,
      read: false,
      ...opts,
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
const CLIENT_PATCH_FIELDS = ['name', 'industry', 'hipaa', 'complianceStandard', 'qbrEnabled', 'integrationRefs', 'primaryContact'] as const;

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

/** Read a single client record (used by the Studio goals editor). */
export async function getClientRecord(id: string): Promise<ApiResult> {
  const client = await getDataStore().getClient(id);
  if (!client) return err(404, 'Unknown client');
  return ok({ client });
}

/**
 * Replace a client's strategic goals wholesale (the Studio editor sends the full
 * list). Each goal is validated + normalized: a title is required, status must
 * be one of CLIENT_GOAL_STATUSES (defaults to 'planned'), ids are preserved or
 * minted. Kept qualitative — no figures.
 */
export async function putClientGoals(id: string, body: Record<string, unknown>): Promise<ApiResult> {
  const store = getDataStore();
  const existing = await store.getClient(id);
  if (!existing) return err(404, 'Unknown client');
  const raw = Array.isArray(body['goals']) ? (body['goals'] as Array<Record<string, unknown>>) : [];
  const goals: ClientGoal[] = [];
  for (const g of raw) {
    const title = typeof g['title'] === 'string' ? g['title'].trim() : '';
    if (!title) continue; // drop blank rows silently — the editor allows empty scratch rows
    const status =
      typeof g['status'] === 'string' && (CLIENT_GOAL_STATUSES as readonly string[]).includes(g['status'])
        ? (g['status'] as ClientGoal['status'])
        : 'planned';
    const alignment = typeof g['alignment'] === 'string' && g['alignment'].trim() ? g['alignment'].trim() : undefined;
    const targetPeriod =
      typeof g['targetPeriod'] === 'string' && /^\d{4}-Q[1-4]$/.test(g['targetPeriod']) ? g['targetPeriod'] : undefined;
    const gid = typeof g['id'] === 'string' && g['id'] ? g['id'] : Math.random().toString(36).slice(2, 10);
    goals.push({ id: gid, title, status, alignment, targetPeriod });
  }
  const merged = { ...existing, goals };
  await store.upsertClient(merged);
  audit('client.goals', `client:${id}`, `${goals.length} goal(s)`);
  return ok({ client: merged });
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
    const safeName = report.model.client.name.replace(/[^\w .&()-]+/g, '').trim() || clientId;
    return { status: 200, pptx: await renderDeck(report.model), filename: `${safeName} QBR ${period}.pptx` };
  } catch (e) {
    return err(501, e instanceof Error ? e.message : 'Deck rendering unavailable');
  }
}

// ── Org settings (Mash IT branding used as the default on every deliverable) ──
export async function getOrgSettings(): Promise<ApiResult> {
  const cfg = await getDataStore().getReportConfig(ORG_SETTINGS_ID);
  return ok({ brand: cfg?.brand ?? {}, booking: cfg?.booking ?? {} });
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

  // Booking rules ride the same org record; unknown keys are dropped and
  // out-of-range values are clamped at use (resolveBookingSettings).
  const rawBooking = (body['booking'] ?? {}) as Record<string, unknown>;
  const bstr = (k: string) => (typeof rawBooking[k] === 'string' ? (rawBooking[k] as string).trim() || undefined : undefined);
  const bnum = (k: string) => (typeof rawBooking[k] === 'number' && Number.isFinite(rawBooking[k]) ? (rawBooking[k] as number) : undefined);
  const tz = bstr('timezone');
  if (tz && !isValidBookingTimezone(tz)) return err(400, `Unknown timezone: ${tz} — use an IANA name like America/Detroit.`);
  const organizer = bstr('organizerEmail');
  if (organizer && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(organizer)) return err(400, 'Organizer must be a valid email address.');
  const booking = {
    organizerEmail: organizer,
    title: bstr('title'),
    description: bstr('description'),
    durationMinutes: bnum('durationMinutes'),
    incrementMinutes: bnum('incrementMinutes'),
    daysOfWeek: Array.isArray(rawBooking['daysOfWeek'])
      ? (rawBooking['daysOfWeek'] as unknown[]).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
      : undefined,
    dayStart: bstr('dayStart'),
    dayEnd: bstr('dayEnd'),
    timezone: tz,
    leadHours: bnum('leadHours'),
    maxDaysOut: bnum('maxDaysOut'),
  };

  const existing = await getDataStore().getReportConfig(ORG_SETTINGS_ID);
  await getDataStore().putReportConfig({ ...existing, clientId: ORG_SETTINGS_ID, brand, booking });
  audit('settings.org', 'settings:org', Object.keys(brand).filter((k) => (brand as Record<string, unknown>)[k]).join(','));
  return ok({ brand, booking });
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
    if (status !== existing?.status) await patchQbr(clientId, period, { status });
  }
  return ok(saved);
}

/**
 * Consultative meeting-agenda suggestions for a QBR — 2-3 data-driven talking
 * points the author can accept (append to the agenda) or ignore. On-demand
 * (one cheap call per request), grounded in the quarter's own metrics/trends;
 * falls back to deterministic data-driven suggestions when AI is off/unavailable.
 */
export async function suggestQbrAgenda(
  clientId: string,
  period: string,
  suggester?: AgendaModel,
  exclude: string[] = [],
): Promise<ApiResult> {
  let model;
  try {
    // ai=null: the context comes from the computed metrics/scorecard, no Opus
    // narrative call needed — keeps this feature cheap.
    model = (await buildReportFor(clientId, period, null)).model;
  } catch (e) {
    return mapBuildError(e);
  }
  // `exclude` carries the talking points already on screen so Refresh advances.
  const ctx = { ...buildAgendaContext(model), exclude: exclude.length ? exclude.slice(0, 12) : undefined };
  if (ctx.movers.length === 0 && ctx.weakFunctions.length === 0 && ctx.metrics.length === 0) {
    return ok({ suggestions: [], source: 'offline', note: 'Not enough data yet — run a Sync first.' });
  }
  if (!suggester && !process.env['ANTHROPIC_API_KEY']) {
    return ok({ suggestions: offlineAgenda(ctx), source: 'offline' });
  }
  try {
    const suggest = suggester ?? createClaudeAgendaSuggester();
    const suggestions = await suggest(ctx);
    audit('qbr.agenda', `qbr:${clientId}/${period}`, `${suggestions.length} suggestion(s)`);
    return ok({ suggestions: suggestions.length ? suggestions : offlineAgenda(ctx), source: suggestions.length ? 'ai' : 'offline' });
  } catch {
    // Never fail the request — data-driven suggestions still help.
    return ok({ suggestions: offlineAgenda(ctx), source: 'offline', note: 'AI unavailable — showing data-driven suggestions.' });
  }
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
export async function storeDocument(input: {
  clientId: string;
  period: string;
  name: string;
  contentType: string;
  bytes: Buffer;
  source: string;
  /** Stable identity for sync-attached reports — survives portal renames. */
  sourceKey?: string;
}): Promise<DocumentRecord> {
  const store = getDataStore();
  const docs = await store.listDocuments(input.clientId, input.period);
  // Re-syncs update in place: match the stable sourceKey first (the user may
  // have renamed the report — AI match retitles them), then source+name.
  const existing =
    (input.sourceKey ? docs.find((d) => d.source === input.source && d.sourceKey === input.sourceKey) : undefined) ??
    docs.find((d) => d.source === input.source && d.name === input.name);
  // Keep the user's curation on refresh: name and category stay, bytes update.
  const name = existing?.name ?? input.name;
  const id = existing?.id ?? Math.random().toString(36).slice(2, 10);
  const record: DocumentRecord = {
    id,
    clientId: input.clientId,
    period: input.period,
    name,
    source: input.source,
    sourceKey: input.sourceKey ?? existing?.sourceKey,
    category: existing?.category,
    contentType: input.contentType,
    size: input.bytes.length,
    uploadedAt: new Date().toISOString(),
    uploadedBy: currentActor(),
  };
  await getDocStore().put(docPath(input.clientId, input.period, id, name), input.bytes, input.contentType);
  await store.putDocument(record);
  // A genuinely new vendor/email report pings the bell (user uploads don't —
  // they were just done by hand); refreshed content stays quiet too.
  if (!existing && input.source !== 'upload') {
    const client = await store.getClient(input.clientId).catch(() => undefined);
    notify('report', `New report for ${client?.name ?? input.clientId}`, {
      body: `${name} · ${input.source} · ${input.period}`,
      clientId: input.clientId,
      period: input.period,
    });
  }
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

/** Every document across every quarter — the client's report repository. */
export async function listClientDocuments(clientId: string): Promise<ApiResult> {
  const docs = await getDataStore().listClientDocuments(clientId);
  docs.sort((a, b) => b.period.localeCompare(a.period) || a.name.localeCompare(b.name));
  return ok({ documents: docs });
}

const PERIOD_RE = /^20\d{2}-Q[1-4]$/;

/**
 * Rename / recategorize / move a document to another quarter. Renames and
 * moves relocate the stored bytes too (the blob path embeds period + name).
 */
export async function updateQbrDocument(
  clientId: string,
  period: string,
  id: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  const store = getDataStore();
  const record = await store.getDocument(clientId, period, id);
  if (!record) return err(404, 'Unknown document');

  const newName = typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim() : record.name;
  const newPeriod = typeof body['period'] === 'string' && PERIOD_RE.test(body['period']) ? body['period'] : record.period;
  const category = typeof body['category'] === 'string' ? body['category'] || undefined : record.category;
  const updated: DocumentRecord = { ...record, name: newName, period: newPeriod, category };

  if (newName !== record.name || newPeriod !== record.period) {
    const docs = getDocStore();
    const oldPath = docPath(clientId, record.period, record.id, record.name);
    const bytes = await docs.get(oldPath);
    if (bytes) {
      await docs.put(docPath(clientId, newPeriod, record.id, newName), bytes, record.contentType);
      await docs.delete(oldPath).catch(() => undefined);
    }
    if (newPeriod !== record.period) await store.deleteDocument(clientId, record.period, record.id);
  }
  await store.putDocument(updated);
  audit(
    'document.update',
    `qbr:${clientId}/${newPeriod}`,
    `${record.name}${newName !== record.name ? ` → ${newName}` : ''}${newPeriod !== record.period ? ` (moved from ${record.period})` : ''}`,
  );
  return ok({ document: updated });
}

/**
 * AI document matcher: read a filed PDF with Claude and suggest the vendor,
 * a clean name, the quarter its content covers, and a category. Returns the
 * suggestion only — the author applies it with the Match button (which calls
 * the regular document-update route).
 */
export async function matchQbrDocument(
  clientId: string,
  period: string,
  id: string,
  matcher?: DocMatchModel,
): Promise<ApiResult> {
  if (!matcher && !process.env['ANTHROPIC_API_KEY']) {
    return err(501, 'AI document matching needs the ANTHROPIC_API_KEY app setting (same key the narrative uses).');
  }
  const store = getDataStore();
  const record = await store.getDocument(clientId, period, id);
  if (!record) return err(404, 'Unknown document');
  const isPdf = record.contentType.includes('pdf') || /\.pdf$/i.test(record.name);
  if (!isPdf) return err(400, 'AI matching currently reads PDFs only.');
  const bytes = await getDocStore().get(docPath(clientId, period, record.id, record.name));
  if (!bytes) return err(404, 'Document content missing');
  const client = await store.getClient(clientId);

  const model = matcher ?? createClaudeDocMatcher();
  try {
    // Identification (vendor/period/title) lives in the first pages — capping
    // what we send cuts the per-document token cost sharply on long reports.
    const capped = await pdfFirstPages(bytes, 6);
    const suggestion = await model({
      pdfBase64: capped.toString('base64'),
      clientName: client?.name ?? clientId,
      currentName: record.name,
      currentPeriod: record.period,
      periods: lastPeriods(periodFor(new Date()).id, 8),
    });
    if (!PERIOD_RE.test(suggestion.suggestedPeriod)) suggestion.suggestedPeriod = record.period;
    audit('document.match', `qbr:${clientId}/${period}`, `${record.name} → ${suggestion.suggestedName} (${suggestion.suggestedPeriod}, ${suggestion.confidence})`);
    return ok({ suggestion, document: record });
  } catch (e) {
    return err(502, `AI matching failed: ${e instanceof Error ? e.message : 'error'}`);
  }
}

/**
 * AI metric extraction: read a filed vendor PDF (Check Point checkup,
 * Dropsuite digest, a previous QBR…) and suggest quarter-scoped metrics for
 * the snapshot. Returns suggestions only — the author reviews and imports via
 * importDocumentMetrics.
 */
export async function extractQbrDocument(
  clientId: string,
  period: string,
  id: string,
  extractor?: DocExtractModel,
): Promise<ApiResult> {
  if (!extractor && !process.env['ANTHROPIC_API_KEY']) {
    return err(501, 'AI metric extraction needs the ANTHROPIC_API_KEY app setting (same key the narrative uses).');
  }
  const store = getDataStore();
  const record = await store.getDocument(clientId, period, id);
  if (!record) return err(404, 'Unknown document');
  const isPdf = record.contentType.includes('pdf') || /\.pdf$/i.test(record.name);
  if (!isPdf) return err(400, 'AI extraction currently reads PDFs only.');
  const bytes = await getDocStore().get(docPath(clientId, period, record.id, record.name));
  if (!bytes) return err(404, 'Document content missing');
  const client = await store.getClient(clientId);

  // Canonical keys from this client's snapshots (this quarter + neighbors) so
  // the extractor reuses them — that's what makes QoQ trending line up.
  const knownKeys = new Map<string, string>();
  const ds = storeDataSource(store);
  for (const p of [record.period, previousPeriod(record.period).id, periodFor(new Date()).id]) {
    const snap = await ds.getSnapshot(clientId, p).catch(() => undefined);
    for (const m of snap?.metrics ?? []) if (!knownKeys.has(m.key)) knownKeys.set(m.key, m.label);
  }

  const model = extractor ?? createClaudeDocExtractor();
  try {
    // 30 pages covers every vendor report we've seen (Check Point checkups
    // run ~11) while keeping token spend bounded on oversized uploads.
    const capped = await pdfFirstPages(bytes, 30);
    const extraction = await model({
      pdfBase64: capped.toString('base64'),
      clientName: client?.name ?? clientId,
      period: record.period,
      knownKeys: [...knownKeys.entries()].map(([key, label]) => ({ key, label })),
      docCategory: record.category,
    });
    audit('document.extract', `qbr:${clientId}/${record.period}`, `${record.name} → ${extraction.metrics.length} metric(s)`);
    return ok({ extraction, source: pdfSourceSlug(extraction.vendor), document: record });
  } catch (e) {
    return err(502, `AI extraction failed: ${e instanceof Error ? e.message : 'error'}`);
  }
}

/**
 * Import reviewed document metrics into the quarter's snapshot under a
 * `pdf:<vendor>` source. Re-importing the same source replaces its previous
 * rows; a missing snapshot (previous-QBR ingestion) is created.
 */
export async function importDocumentMetrics(clientId: string, period: string, body: Record<string, unknown>): Promise<ApiResult> {
  const source = (typeof body['source'] === 'string' ? body['source'].trim() : '') as `pdf:${string}`;
  if (!/^pdf:[a-z0-9-]{1,40}$/.test(source)) return err(400, 'source must look like pdf:<vendor>.');
  if (!PERIOD_RE.test(period)) return err(400, 'Invalid period.');

  const rows = Array.isArray(body['metrics']) ? (body['metrics'] as Array<Record<string, unknown>>) : [];
  const imported: MetricValue[] = [];
  for (const raw of rows) {
    const label = typeof raw['label'] === 'string' ? raw['label'].trim() : '';
    const value = raw['value'];
    const category = raw['category'];
    if (!label || (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')) {
      return err(400, 'Each metric needs a label and a value.');
    }
    if (!METRIC_CATEGORIES.includes(category as MetricCategory)) return err(400, `Unknown category: ${String(category)}`);
    const rawKey = typeof raw['key'] === 'string' ? raw['key'].trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(rawKey)) return err(400, `Invalid metric key: ${rawKey || '(empty)'}`);
    imported.push({
      key: rawKey,
      label,
      value,
      unit: typeof raw['unit'] === 'string' && raw['unit'] ? raw['unit'] : undefined,
      source,
      category: category as MetricCategory,
      higherIsBetter: typeof raw['higherIsBetter'] === 'boolean' ? raw['higherIsBetter'] : undefined,
    });
  }
  if (imported.length === 0) return err(400, 'No metrics to import.');

  const store = getDataStore();
  // Previous-QBR ingestion targets quarters that never had a sync — create.
  const base = (await storeDataSource(store).getSnapshot(clientId, period)) ?? {
    clientId,
    period,
    capturedAt: new Date().toISOString(),
    metrics: [] as MetricValue[],
  };
  const kept = base.metrics.filter((m) => m.source !== source);
  await store.putSnapshot({ ...base, clientId, period, metrics: [...kept, ...imported] });
  audit('metrics.import', `qbr:${clientId}/${period}`, `${imported.length} metric(s) from ${source}`);
  return ok({ imported: imported.length, source, period });
}

/**
 * Drop every metric a PDF import added to a quarter (`?source=pdf:<vendor>`) —
 * the undo for an import that landed in the wrong quarter or misread numbers.
 */
export async function removeImportedMetrics(clientId: string, period: string, source: string | undefined): Promise<ApiResult> {
  const src = (source ?? '').trim();
  if (!/^pdf:[a-z0-9-]{1,40}$/.test(src)) return err(400, 'source must look like pdf:<vendor> — only imported rows can be bulk-removed.');
  const store = getDataStore();
  const snapshot = await store.getSnapshot(clientId, period);
  if (!snapshot) return err(404, `No metric snapshot for ${clientId} ${period}.`);
  const kept = snapshot.metrics.filter((m) => m.source !== src);
  const removed = snapshot.metrics.length - kept.length;
  if (removed > 0) {
    await store.putSnapshot({ ...snapshot, metrics: kept });
    audit('metrics.unimport', `qbr:${clientId}/${period}`, `${removed} metric(s) from ${src} removed`);
  }
  return ok({ removed, source: src, period });
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
  // Value is optional; accept a finite non-negative number, clear it on empty/null, else keep the prior value.
  let value = existing?.value;
  if ('value' in body) {
    const raw = body['value'];
    if (raw === null || raw === '') value = undefined;
    else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) value = raw;
    else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) value = Number(raw);
  }
  const valueKind =
    body['valueKind'] === 'recurring' || body['valueKind'] === 'one_time'
      ? (body['valueKind'] as 'recurring' | 'one_time')
      : value === undefined
        ? undefined
        : (existing?.valueKind ?? 'one_time');
  const record: OpportunityRecord = {
    id,
    clientId,
    title,
    detail: typeof body['detail'] === 'string' ? body['detail'] : existing?.detail,
    status,
    owner: typeof body['owner'] === 'string' ? body['owner'] || undefined : existing?.owner,
    value,
    valueKind,
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
    if (result.filed > 0) {
      notify('report', `${result.filed} report(s) filed from the email inbox`, {
        body: 'Open the client\'s Reports tab to match and categorize them.',
      });
    }
    return ok(result);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Inbox poll failed';
    _lastInboxPoll = { at: new Date().toISOString(), ok: false, detail };
    return err(502, detail);
  }
}

// QBR-due reminders: throttled to ~2 checks/day per worker. When the current
// quarter enters its final month and a QBR-enabled client has data but no
// meeting on the calendar, ping the bell once per client/quarter.
let _lastDueCheck = 0;

/** Test hook: let the next timerTick run the due-check immediately. */
export function _resetDueCheck(): void {
  _lastDueCheck = 0;
}

export async function checkQbrDue(now: Date = new Date()): Promise<void> {
  if (Date.now() - _lastDueCheck < 12 * 3_600_000) return;
  _lastDueCheck = Date.now();
  const period = periodFor(now);
  const daysLeft = (Date.parse(`${period.end}T23:59:59Z`) - now.getTime()) / (24 * 3_600_000);
  if (daysLeft > 31) return; // nudging earlier than the last month is noise
  const store = getDataStore();
  for (const client of await store.listClients()) {
    if (client.qbrEnabled === false) continue;
    const qbr = await store.getQbr(client.id, period.id).catch(() => undefined);
    // Dedupe on the QBR record itself, not a notification scan (which only sees
    // the newest page and misses old keys once the bell fills up).
    if (qbr?.dueRemindedAt || qbr?.meeting?.scheduledAt || qbr?.status === 'completed' || qbr?.status === 'archived') continue;
    const snapshot = await store.getSnapshot(client.id, period.id).catch(() => undefined);
    if (!snapshot) continue; // no data yet — sync first, then we nudge
    await patchQbr(client.id, period.id, { dueRemindedAt: new Date().toISOString() }).catch(() => undefined);
    notify('qbr_due', `Time to schedule ${client.name}'s ${period.label} QBR`, {
      body: 'Data is in but nothing is on the calendar — send the booking link or schedule it from the Meeting tab.',
      clientId: client.id,
      period: period.id,
      dedupeKey: `qbr_due:${client.id}:${period.id}`,
    });
  }
}

/** One 5-minute platform tick: drain the report inbox + due-date reminders. */
export async function timerTick(): Promise<void> {
  await pollInbox().catch(() => undefined);
  await checkQbrDue().catch(() => undefined);
}

/** Fetch vendor-published report files surfaced during sync and attach them. */
async function attachSyncDocuments(
  clientId: string,
  period: string,
  documents: Array<{ source: string; name: string; url: string; key?: string }>,
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
        sourceKey: doc.key,
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
    await patchQbr(clientId, period, { status: advanceStatus(existing?.status, 'data_synced') });
    audit('qbr.sync', `qbr:${clientId}/${period}`, `${snapshot.metrics.length} metric(s)`);
    return ok({ metrics: snapshot.metrics.length, warnings, documents: documents.length });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'Sync failed');
  }
}

export async function putStatus(clientId: string, period: string, status: unknown): Promise<ApiResult> {
  // Manual status set is the explicit user override (incl. un-archiving) — validated, not advanced.
  if (!isQbrStatus(status)) return err(400, `Invalid status: ${String(status)}`);
  const patch: { status: QbrStatus; meeting?: QbrRecord['meeting'] } = { status };
  // Reaching a held stage stamps WHEN the review happened (if not already known)
  // so account-health's engagement signal has an authoritative date going
  // forward — use the scheduled time if it's already passed, else now.
  if (QBR_HELD_STAGES.includes(status)) {
    const existing = await getDataStore().getQbr(clientId, period);
    if (!existing?.meeting?.heldAt) {
      const sched = existing?.meeting?.scheduledAt;
      const heldAt = sched && Date.parse(sched) <= Date.now() ? sched : new Date().toISOString();
      patch.meeting = { ...existing?.meeting, heldAt };
    }
  }
  const saved = await patchQbr(clientId, period, patch);
  audit('qbr.status', `qbr:${clientId}/${period}`, status);
  return ok(saved);
}

export async function putSchedule(clientId: string, period: string, body: { scheduledAt?: string; joinUrl?: string }): Promise<ApiResult> {
  const store = getDataStore();
  const existing = await store.getQbr(clientId, period);
  const meeting = { ...existing?.meeting, scheduledAt: body.scheduledAt, joinUrl: body.joinUrl };
  // Only a real date advances to scheduled; clearing the date leaves status be
  // (use Cancel / reschedule to step back). Set dates never demote later stages.
  const status = body.scheduledAt ? advanceStatus(existing?.status, 'scheduled') : (existing?.status ?? 'draft');
  const saved = await patchQbr(clientId, period, { status, meeting });
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
    if (status !== existing?.status) await patchQbr(clientId, period, { status });
    return ok(result);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'Push failed');
  }
}

// ── Email draft (.eml opens in Outlook as an unsent message + PDF attached) ──
/** Keep the draft inside typical Exchange send limits. */
const MAX_EMAIL_ATTACHMENT_TOTAL = 20 * 1024 * 1024;

/** Absolute origin for links in outbound email (proxy headers, then env). */
function originFrom(header?: HeaderGet): string | undefined {
  const env = process.env['PUBLIC_BASE_URL']?.trim().replace(/\/+$/, '');
  const host = header?.('x-forwarded-host') ?? header?.('host');
  if (!host) return env || undefined;
  const proto = header?.('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function getEmailDraft(clientId: string, period: string, ai: string | null, header?: HeaderGet): Promise<ApiResult> {
  let report;
  try {
    report = await buildReportFor(clientId, period, ai);
  } catch (e) {
    return mapBuildError(e);
  }
  const store = getDataStore();
  const client = await store.getClient(clientId);
  const brand = report.model.brand;

  // Until a meeting is on the calendar, the draft carries the self-scheduling
  // link (created on demand) so the client can pick a time themselves.
  let bookingUrl: string | undefined;
  try {
    const qbr = await store.getQbr(clientId, period);
    const origin = originFrom(header);
    if (!qbr?.meeting?.scheduledAt && origin) {
      const r = await ensureBookingLink(clientId, period);
      const path = (r.json as { path?: string } | undefined)?.path;
      if (r.status === 200 && path) bookingUrl = `${origin}${path}`;
    }
  } catch {
    // The draft is still useful without the link.
  }

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
      senderName: me !== 'system' && me !== 'anonymous' && !me.includes('@') ? me : undefined,
      bookingUrl,
    }),
    attachments,
  });
  audit('qbr.email_draft', `qbr:${clientId}/${period}`, `${client?.primaryContact?.email ?? 'no recipient'} · ${attachments.length} attachment(s)`);
  // Stamp the pipeline: generating the package marks the "send" step done.
  try {
    await patchQbr(clientId, period, { packageSentAt: new Date().toISOString() });
  } catch {
    // Stamp is best-effort.
  }
  return { status: 200, file: { bytes: eml, contentType: 'message/rfc822', filename: `QBR-${clientId}-${period}.eml` } };
}

// ── Client-facing booking (public /book/{token} + portal management) ─────────
const BOOKING_TOKEN_RE = /^[a-z0-9]{16,64}$/;
const LOCAL_SLOT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function orgBookingContext() {
  const store = getDataStore();
  const org = await store.getReportConfig(ORG_SETTINGS_ID).catch(() => undefined);
  return {
    store,
    settings: resolveBookingSettings(org?.booking),
    brand: org?.brand ?? {},
    graph: graphAppConfigFromEnv(),
  };
}

/** Friendly timezone label, e.g. "Eastern Time (Detroit)". */
function tzLabel(tz: string): string {
  const city = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return name ? `${name} (${city})` : tz;
  } catch {
    return tz;
  }
}

/** Portal: get (or create) the scheduling link for a client/period. */
export async function ensureBookingLink(clientId: string, period: string): Promise<ApiResult> {
  if (!PERIOD_RE.test(period)) return err(400, 'Invalid period.');
  const store = getDataStore();
  await ensureSeeded(store);
  const client = await store.getClient(clientId);
  if (!client) return err(404, 'Unknown client');
  let booking = await store.findBooking(clientId, period);
  if (!booking || booking.status === 'cancelled') {
    booking = await store.putBooking({
      token: newBookingToken(),
      clientId,
      period,
      status: 'open',
      createdAt: new Date().toISOString(),
      createdBy: currentActor(),
    });
    audit('booking.create', `qbr:${clientId}/${period}`, `link ${booking.token.slice(0, 6)}…`);
  }
  return ok({ booking, path: `/book/${booking.token}` });
}

/** Portal: current booking state for a client/period (no auto-create). */
export async function getBookingState(clientId: string, period: string): Promise<ApiResult> {
  const store = getDataStore();
  const booking = await store.findBooking(clientId, period);
  const { settings, graph } = await orgBookingContext();
  return ok({
    booking: booking ?? null,
    // Only an OPEN link is a live shareable link — a cancelled/booked one must
    // NOT show a "copy" box, or the UI gets stuck on a dead link after a cancel.
    path: booking?.status === 'open' ? `/book/${booking.token}` : null,
    configured: Boolean(settings.organizerEmail),
    calendarConnected: Boolean(graph && settings.organizerEmail),
  });
}

/** Public: page shell. */
export function getBookingPage(token: string): ApiResult {
  if (!BOOKING_TOKEN_RE.test(token)) return { status: 404, html: '<h1>Not found</h1>' };
  return { status: 200, html: renderBookingPage(token) };
}

/** Public: booking metadata for the page (no ids beyond display names). */
export async function publicBookingInfo(token: string): Promise<ApiResult> {
  if (!BOOKING_TOKEN_RE.test(token)) return err(404, 'Unknown link');
  const { store, settings, brand } = await orgBookingContext();
  const booking = await store.getBooking(token);
  if (!booking) return err(404, 'Unknown link');
  const client = await store.getClient(booking.clientId);
  return ok({
    status: booking.status,
    orgName: brand.name || 'Mash IT',
    brand: { logo: brand.logoDataUri, primary: brand.primary, accent: brand.accent },
    clientName: client?.name ?? 'your organization',
    periodLabel: parsePeriod(booking.period).label,
    title: settings.title,
    description: settings.description,
    durationMinutes: settings.durationMinutes,
    timezone: settings.timezone,
    tzLabel: tzLabel(settings.timezone),
    window: bookableWindow(settings, new Date()),
    booked: booking.status === 'booked' ? { start: booking.start, inviteSent: Boolean(booking.eventId) } : undefined,
  });
}

/** Public: open slots for a date range (configured windows minus busy times). */
export async function publicBookingSlots(token: string, from: string | null, to: string | null): Promise<ApiResult> {
  if (!BOOKING_TOKEN_RE.test(token)) return err(404, 'Unknown link');
  if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to) || to < from) return err(400, 'from/to must be YYYY-MM-DD.');
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 62 * 24 * 3_600_000) return err(400, 'Range too large.');
  const { store, settings, graph } = await orgBookingContext();
  const booking = await store.getBooking(token);
  if (!booking) return err(404, 'Unknown link');
  if (booking.status !== 'open') return ok({ slots: [], calendarChecked: false });

  let slots = candidateSlots(settings, from, to, new Date());
  let calendarChecked = false;
  if (slots.length > 0 && graph && settings.organizerEmail) {
    const viewStart = `${slots[0]!.slice(0, 10)}T00:00`;
    const lastDay = slots[slots.length - 1]!.slice(0, 10);
    const view = await getAvailabilityView(graph, settings.organizerEmail, viewStart, `${lastDay}T23:59`, settings.timezone, settings.incrementMinutes);
    if (view) {
      slots = filterFreeSlots(slots, view, viewStart, settings);
      calendarChecked = true;
    }
  }
  return ok({ slots, calendarChecked });
}

/** Public: book a slot — creates the Teams invite and schedules the QBR. */
export async function publicBook(token: string, body: Record<string, unknown>): Promise<ApiResult> {
  if (!BOOKING_TOKEN_RE.test(token)) return err(404, 'Unknown link');
  const { store, settings, brand, graph } = await orgBookingContext();
  const booking = await store.getBooking(token);
  if (!booking) return err(404, 'Unknown link');
  if (booking.status !== 'open') return err(409, 'This link has already been used — contact your account manager to reschedule.');

  const start = typeof body['start'] === 'string' ? body['start'] : '';
  const name = typeof body['name'] === 'string' ? body['name'].trim().slice(0, 120) : '';
  const email = typeof body['email'] === 'string' ? body['email'].trim().slice(0, 200) : '';
  const notes = typeof body['notes'] === 'string' ? body['notes'].trim().slice(0, 1000) : '';
  const extras = (Array.isArray(body['attendees']) ? body['attendees'] : [])
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
    .slice(0, 10);
  if (!LOCAL_SLOT_RE.test(start)) return err(400, 'Pick a time slot first.');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'Please provide your name and a valid email.');

  // The chosen slot must still be a legal candidate (weekday/window/lead/max).
  const day = start.slice(0, 10);
  if (!candidateSlots(settings, day, day, new Date()).includes(start)) {
    return err(409, 'That time is no longer available — please pick another.');
  }
  // …and still free on the organizer's calendar (when we can check).
  if (graph && settings.organizerEmail) {
    const view = await getAvailabilityView(graph, settings.organizerEmail, `${day}T00:00`, `${day}T23:59`, settings.timezone, settings.incrementMinutes);
    if (view && filterFreeSlots([start], view, `${day}T00:00`, settings).length === 0) {
      return err(409, 'That time was just taken — please pick another.');
    }
  }

  const client = await store.getClient(booking.clientId);
  const end = slotEnd(start, settings);
  const periodLabel = parsePeriod(booking.period).label;
  const orgName = brand.name || 'Mash IT';

  // Claim the slot BEFORE creating the calendar event, so a double-submit (two
  // tabs/devices) can't mint two Teams invites: re-read and flip to 'booked'
  // first; if someone else already claimed it, bail. Not DB-level CAS — the
  // stores don't offer conditional writes — but it closes the practical window
  // (and the booking page disables its button on submit).
  const fresh = await store.getBooking(token);
  if (!fresh || fresh.status !== 'open') return err(409, 'That time was just taken — please pick another.');
  const claimed = await store.putBooking({
    ...fresh,
    status: 'booked',
    start,
    end,
    timezone: settings.timezone,
    attendeeName: name,
    attendeeEmail: email,
    extraAttendees: extras.length ? extras : undefined,
    notes: notes || undefined,
    bookedAt: new Date().toISOString(),
  });

  let eventId: string | undefined;
  let joinUrl: string | undefined;
  if (graph && settings.organizerEmail) {
    try {
      const html = [
        `<p>${escapeHtml(settings.title)} — ${escapeHtml(client?.name ?? '')} (${escapeHtml(periodLabel)}).</p>`,
        settings.description ? `<p>${escapeHtml(settings.description)}</p>` : '',
        notes ? `<p><b>Requested topics:</b> ${escapeHtml(notes)}</p>` : '',
        `<p>Booked by ${escapeHtml(name)} via the ${escapeHtml(orgName)} scheduling page.</p>`,
      ].join('');
      const created = await createOrganizerEvent(graph, settings.organizerEmail, {
        subject: `${settings.title} — ${client?.name ?? booking.clientId} (${periodLabel})`,
        bodyHtml: html,
        startLocal: start,
        endLocal: end,
        timezone: settings.timezone,
        attendees: [{ email, name }, ...extras.map((e) => ({ email: e }))],
      });
      eventId = created.eventId || undefined;
      joinUrl = created.joinUrl;
    } catch {
      // The booking still lands; the organizer sends the invite by hand.
    }
  }

  const updated = eventId || joinUrl ? await store.putBooking({ ...claimed, eventId, joinUrl }) : claimed;

  // Reflect it on the QBR record so the workspace shows the meeting.
  try {
    const existing = await store.getQbr(booking.clientId, booking.period);
    const scheduledAt = localToUtc(start, settings.timezone).toISOString();
    await patchQbr(booking.clientId, booking.period, {
      status: advanceStatus(existing?.status, 'scheduled'),
      meeting: { ...existing?.meeting, scheduledAt, joinUrl, eventId, attendees: [email, ...extras] },
    });
  } catch {
    // Booking record is the source of truth; workspace sync is best-effort.
  }

  const whenLabel = new Date(localToUtc(start, settings.timezone)).toLocaleString('en-US', {
    timeZone: settings.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  audit('booking.booked', `qbr:${booking.clientId}/${booking.period}`, `${name} <${email}> → ${start} (${settings.timezone})`);
  notify('booking', `${client?.name ?? booking.clientId} booked their QBR`, {
    body: `${whenLabel}${eventId ? ' — Teams invite sent.' : ' — send the invite manually (calendar not connected).'}`,
    clientId: booking.clientId,
    period: booking.period,
  });
  // Heads-up email to the organizer (the calendar invite lands silently on
  // their calendar; this is the "you got a booking" ping). Best-effort — needs
  // Mail.Send application permission; a missing grant just skips it.
  if (graph && settings.organizerEmail) {
    const mailHtml = [
      `<p><b>${escapeHtml(name)}</b> (${escapeHtml(email)}) booked their ${escapeHtml(periodLabel)} QBR.</p>`,
      `<p><b>${escapeHtml(whenLabel)}</b> (${escapeHtml(settings.timezone)})</p>`,
      extras.length ? `<p>Also invited: ${escapeHtml(extras.join(', '))}</p>` : '',
      notes ? `<p><b>Requested topics:</b> ${escapeHtml(notes)}</p>` : '',
      eventId ? '<p>The Teams invite has gone out to everyone.</p>' : '<p>Calendar not connected — send the invite by hand.</p>',
    ].join('');
    await sendOrganizerMail(graph, settings.organizerEmail, {
      subject: `QBR booked: ${client?.name ?? booking.clientId} — ${periodLabel}`,
      html: mailHtml,
      to: [settings.organizerEmail],
    }).catch(() => undefined);
  }
  return ok({ ok: true, start: updated.start, end: updated.end, timezone: settings.timezone, inviteSent: Boolean(eventId) });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Cancel a scheduled QBR meeting: delete the Teams calendar event (best-effort),
 * cancel any active booking link so a fresh one can be issued, clear the meeting
 * off the QBR record, and step the workflow back from 'scheduled'. This is the
 * portal's reschedule/cancel path — after it, "Create booking link" re-enables
 * or the author can set a new time by hand.
 */
export async function cancelQbrMeeting(clientId: string, period: string): Promise<ApiResult> {
  const store = getDataStore();
  const existing = await store.getQbr(clientId, period);
  if (!existing?.meeting?.scheduledAt && !existing?.meeting?.eventId) {
    // Nothing booked — still cancel a dangling booking link if one is open.
    const b = await store.findBooking(clientId, period);
    if (b && b.status !== 'cancelled') await store.putBooking({ ...b, status: 'cancelled' });
    return ok({ cancelled: false, note: 'No meeting was scheduled.' });
  }

  // Remove the calendar event if we created one via app-only Graph.
  const graph = graphAppConfigFromEnv();
  const { settings } = await orgBookingContext();
  if (existing.meeting.eventId && graph && settings.organizerEmail) {
    await deleteOrganizerEvent(graph, settings.organizerEmail, existing.meeting.eventId).catch(() => undefined);
  }

  // Cancel the booking record so ensureBookingLink issues a fresh link.
  const booking = await store.findBooking(clientId, period);
  if (booking && booking.status !== 'cancelled') await store.putBooking({ ...booking, status: 'cancelled' });

  // Clear the meeting and step back to data_synced (forward-only advance won't
  // demote, so set it explicitly — the meeting is gone, 'scheduled' is wrong).
  const status = existing.status === 'scheduled' ? 'data_synced' : existing.status;
  await patchQbr(clientId, period, { status, meeting: undefined });
  audit('qbr.meeting_cancel', `qbr:${clientId}/${period}`, existing.meeting.scheduledAt ?? existing.meeting.eventId ?? '');
  return ok({ cancelled: true });
}

// ── In-portal notifications ──────────────────────────────────────────────────
export async function getNotifications(limit: string | null): Promise<ApiResult> {
  const n = Math.min(100, Math.max(1, Number(limit) || 30));
  const items = await getDataStore().listNotifications(n);
  return ok({ notifications: items, unread: items.filter((i) => !i.read).length });
}

export async function markNotificationsRead(body: Record<string, unknown>): Promise<ApiResult> {
  const ids = body['ids'];
  if (ids === 'all') await getDataStore().markNotificationsRead('all');
  else if (Array.isArray(ids) && ids.every((i) => typeof i === 'string')) await getDataStore().markNotificationsRead(ids as string[]);
  else return err(400, "ids must be 'all' or an array of notification ids.");
  return ok({ ok: true });
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
  await patchQbr(clientId, period, { status: advanceStatus(existing?.status, 'scheduled'), meeting });
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

/** Order maturity ratings so a lower rank = worse (for regression checks). */
function ratingRank(r: string): number {
  return r === 'red' ? 0 : r === 'amber' ? 1 : r === 'green' ? 2 : 3;
}

/**
 * Best evidence of when a QBR was actually held, for the account-health
 * engagement signal: an explicit `heldAt`, else a scheduled meeting whose time
 * has already passed (the review happened). A future or absent meeting means it
 * hasn't been held yet.
 */
function qbrHeldDate(qbr: { meeting?: { heldAt?: string; scheduledAt?: string } } | undefined): string | undefined {
  const m = qbr?.meeting;
  if (m?.heldAt) return m.heldAt;
  if (m?.scheduledAt && Date.parse(m.scheduledAt) <= Date.now()) return m.scheduledAt;
  return undefined;
}

// Lifecycle stages that mean the review meeting has taken place.
const QBR_HELD_STAGES: QbrStatus[] = ['completed', 'dispositioned', 'actions_pushed', 'archived'];

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
      const opportunities = await store.listOpportunities(client.id).catch(() => []);

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

      // Growth pipeline (dollarized roadmap) + holistic account health — both
      // internal dashboard rollups, never rendered in the client report.
      const roadmap = roadmapValue(opportunities);
      const ratingDropped =
        rating !== 'unknown' && prevScorecard?.overall.rating && prevScorecard.overall.rating !== 'unknown'
          ? ratingRank(rating) < ratingRank(prevScorecard.overall.rating)
          : false;
      const health = computeAccountHealth({
        securityScore: scorecard?.overall.score ?? null,
        flags,
        daysSinceQbr: daysSince(qbrHeldDate(qbr)),
        ratingDropped,
        spendDeltaPct,
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
        roadmapValue: roadmap.annualValue,
        roadmapCount: roadmap.count,
        health: { score: health.score, rating: health.rating, drivers: health.drivers },
      };
    }),
  );
  return ok({ currentPeriod: current, clients: rows });
}

/** Which of the last 8 quarters have data for this client (store or seed). */
export async function getPeriods(clientId: string, currentOverride?: string | null): Promise<ApiResult> {
  const ds = storeDataSource(getDataStore());
  const store = getDataStore();
  const current = resolveCurrent(currentOverride);
  const periods = await Promise.all(
    lastPeriods(current, 8).map(async (period) => ({
      period,
      hasSnapshot: !!(await ds.getSnapshot(clientId, period)),
      // Workflow state rides along so the UI can target the NEXT quarter once
      // a QBR is completed instead of reopening the finished one.
      status: (await store.getQbr(clientId, period).catch(() => undefined))?.status,
    })),
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
    // Booking page: whether app-only Graph credentials are visible (calendar
    // availability + automatic Teams invites). Organizer email lives in org
    // settings, not env.
    bookingGraphReady: graphAppConfigFromEnv() !== null,
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
