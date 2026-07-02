import { advanceStatus, isQbrStatus, periodFor, type QbrStatus } from '@mashit/core';
import { createClaudeNarrativeModel, type NarrativeModel } from '@mashit/narrative';
import { renderDeck, renderPdf } from '@mashit/report';
import { FetchHttpTransport, type McpTransport } from '@mashit/integrations';
import { buildQbrReport, renderQbrHtml } from './service.js';
import {
  ensureSeeded,
  getDataStore,
  getSecretStore,
  isConnectionType,
  loadReportInputs,
  narrativeCacheFor,
  storeDataSource,
  toConnectionView,
} from './store/index.js';
import { removeConnection, resolveSecret, saveConnection, type ConnectionInput } from './connections.js';
import { importHaloClients, syncClientMetrics, type Integrations } from './integrationsService.js';
import { pushAction, type PushInput } from './actions.js';
import { HttpMcpTransport } from './mcpClient.js';

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
  const token = await resolveSecret(getSecretStore(), conn, 'token');
  return new HttpMcpTransport(url, token);
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
const CLIENT_PATCH_FIELDS = ['name', 'industry', 'hipaa', 'integrationRefs', 'primaryContact'] as const;

export async function updateClient(id: string, patch: Record<string, unknown>): Promise<ApiResult> {
  const store = getDataStore();
  const existing = (await store.getClient(id)) ?? { id, name: id };
  const allowed = Object.fromEntries(
    Object.entries(patch).filter(([k]) => (CLIENT_PATCH_FIELDS as readonly string[]).includes(k)),
  );
  const merged = { ...existing, ...allowed, id };
  await store.upsertClient(merged as typeof existing);
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
  return ok(await getDataStore().putReportConfig({ ...body, clientId } as never));
}
export async function getDiscussion(clientId: string, period: string): Promise<ApiResult> {
  return ok((await getDataStore().getDiscussion(clientId, period)) ?? { clientId, period, items: [] });
}
export async function putDiscussion(clientId: string, period: string, body: Record<string, unknown>): Promise<ApiResult> {
  const store = getDataStore();
  const items = Array.isArray(body['items']) ? (body['items'] as never[]) : [];
  const saved = await store.putDiscussion({ clientId, period, items, notes: body['notes'] as string | undefined });

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

// ── Integrations ─────────────────────────────────────────────────────────────
export async function listIntegrations(): Promise<ApiResult> {
  return ok({ integrations: (await getDataStore().listConnections()).map(toConnectionView) });
}
export async function saveIntegration(body: ConnectionInput): Promise<ApiResult> {
  if (!body.type || !body.label) return err(400, 'type and label are required');
  if (!isConnectionType(body.type)) return err(400, `Unknown integration type: ${String(body.type)}`);
  const conn = await saveConnection(getDataStore(), getSecretStore(), body);
  return ok(toConnectionView(conn));
}
export async function deleteIntegration(id: string): Promise<ApiResult> {
  await removeConnection(getDataStore(), getSecretStore(), id);
  return ok({ deleted: id });
}
export async function testIntegration(id: string): Promise<ApiResult> {
  const conn = await getDataStore().getConnection(id);
  if (!conn) return err(404, 'Unknown connection');
  if (conn.type === 'mcp') {
    try {
      const mcp = await resolveMcp();
      if (!mcp) return err(400, 'MCP connection missing URL');
      await mcp.callTool('halo_list_clients', {});
      return ok({ ok: true });
    } catch (e) {
      return ok({ ok: false, error: e instanceof Error ? e.message : 'connection failed' });
    }
  }
  return ok({ ok: true, note: 'Saved. Live test runs on next sync.' });
}

// ── Live pipeline + workflow ─────────────────────────────────────────────────
export async function importHalo(): Promise<ApiResult> {
  try {
    const clients = await importHaloClients(await buildIntegrations());
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
  return ok(await store.upsertQbr({ clientId, period, status, meeting: existing?.meeting, updatedAt: new Date().toISOString() }));
}

export async function putSchedule(clientId: string, period: string, body: { scheduledAt?: string; joinUrl?: string }): Promise<ApiResult> {
  const store = getDataStore();
  const existing = await store.getQbr(clientId, period);
  const meeting = { ...existing?.meeting, scheduledAt: body.scheduledAt, joinUrl: body.joinUrl };
  // Booking a meeting advances data_synced/draft to scheduled without demoting later stages.
  const status = advanceStatus(existing?.status, 'scheduled');
  return ok(await store.upsertQbr({ clientId, period, status, meeting, updatedAt: new Date().toISOString() }));
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
