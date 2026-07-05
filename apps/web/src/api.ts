// Thin typed fetch wrapper over the QBR API. All calls are relative to the
// serving origin (the Function App also serves this SPA; Vite proxies /api in dev).
import type {
  AuditEvent,
  Client,
  ConnectionView,
  Discussion,
  DocMatchSuggestion,
  DocumentInfo,
  HaloMeta,
  Me,
  MetricRow,
  Opportunity,
  OverviewRow,
  PeriodInfo,
  QbrResponse,
  ReportConfig,
  SnapshotView,
  SystemInfo,
} from './types.js';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

export interface ConnectionInput {
  id?: string;
  type: string;
  label: string;
  config?: Record<string, string>;
  secrets?: Record<string, string>;
}

// Easy Auth Graph tokens expire hourly; /.auth/refresh renews them using the
// browser session, then the original call is retried once.
async function withAuthRefresh<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Error && e.message === 'token_expired') {
      await fetch('/.auth/refresh').catch(() => {});
      return run();
    }
    throw e;
  }
}

// Capabilities don't change while the app is open — fetch once, share everywhere.
let _system: Promise<SystemInfo> | undefined;

// Some hosts refuse to register functions on /api/system routes while serving
// every other route — try the "system"-free alias first, then the older ones.
async function fetchSystem(): Promise<SystemInfo> {
  for (const url of ['/api/capabilities', '/api/system', '/api/system-info']) {
    const res = await send('GET', url);
    if (res.ok) return res.json() as Promise<SystemInfo>;
  }
  throw new Error('System info unavailable');
}

export const api = {
  // System capabilities (memoized)
  system: () => (_system ??= fetchSystem()),
  /** Re-read the system info (e.g. after an inbox poll) and refresh the memo. */
  systemFresh: () => (_system = fetchSystem()),
  /** Drain the shared report mailbox now (the timer does this every 5 min). */
  pollInbox: () =>
    send('POST', '/api/inbox/poll').then(
      json<{ processed: number; filed: number; unrouted: number; folders?: Array<{ folder: string; total: number; unread: number }> }>,
    ),
  me: () => send('GET', '/api/me').then(json<Me>),
  audit: (limit = 100) => send('GET', `/api/audit?limit=${limit}`).then(json<{ events: AuditEvent[] }>),

  // Clients
  listClients: () => send('GET', '/api/clients').then(json<{ clients: Client[] }>),
  updateClient: (id: string, patch: Partial<Client>) => send('PUT', `/api/clients/${id}`, patch).then(json<Client>),
  importHalo: () => send('POST', '/api/clients/import/halo').then(json<{ imported: number; clients: Client[] }>),

  // QBR + report
  getQbr: (clientId: string, period: string, ai = true) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}${ai ? '' : '?ai=0'}`).then(json<QbrResponse>),
  currentPeriod: () => send('GET', '/api/period/current').then(json<{ period: string }>),
  overview: () => send('GET', '/api/overview').then(json<{ currentPeriod: string; clients: OverviewRow[] }>),
  periods: (clientId: string) =>
    send('GET', `/api/clients/${clientId}/periods`).then(json<{ currentPeriod: string; periods: PeriodInfo[] }>),

  // Narrative editor
  getNarrative: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/narrative`).then(
      json<{ edits: { headline?: string; summary_paragraphs?: string[]; highlights?: string[]; recommendations?: string[]; editedBy: string; editedAt: string } | null; hasCached: boolean }>,
    ),
  putNarrative: (
    clientId: string,
    period: string,
    edits: { headline?: string; summary_paragraphs?: string[]; highlights?: string[]; recommendations?: string[] },
  ) => send('PUT', `/api/clients/${clientId}/qbr/${period}/narrative`, edits).then(json<{ edits: unknown }>),
  regenerateNarrative: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/narrative/regenerate`).then(json<{ cleared: boolean }>),

  // Data review
  getMetrics: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/metrics`).then(json<{ snapshot: SnapshotView; excluded: string[] }>),
  putManualMetrics: (clientId: string, period: string, metrics: MetricRow[]) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/metrics`, { metrics }).then(json<{ metrics: number; manual: number }>),

  // Config + discussion
  getConfig: (clientId: string) => send('GET', `/api/clients/${clientId}/config`).then(json<ReportConfig>),
  putConfig: (clientId: string, config: ReportConfig) => send('PUT', `/api/clients/${clientId}/config`, config).then(json<ReportConfig>),
  getDiscussion: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/discussion`).then(json<Discussion>),
  putDiscussion: (clientId: string, period: string, disc: Discussion) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/discussion`, disc).then(json<Discussion>),

  // Attached documents (vendor reports + uploads)
  listDocuments: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/documents`).then(json<{ documents: DocumentInfo[] }>),
  uploadDocument: (clientId: string, period: string, body: { name: string; contentType: string; dataBase64: string }) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/documents`, body).then(json<DocumentInfo>),
  deleteDocument: (clientId: string, period: string, id: string) =>
    send('DELETE', `/api/clients/${clientId}/qbr/${period}/documents/${id}`).then(json<{ deleted: string }>),

  // Workflow
  sync: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/sync`).then(json<{ metrics: number; warnings: string[]; documents?: number }>),
  putStatus: (clientId: string, period: string, status: string) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/status`, { status }).then(json<unknown>),
  putSchedule: (clientId: string, period: string, body: { scheduledAt?: string; joinUrl?: string }) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/schedule`, body).then(json<unknown>),
  // Report repository (all quarters) + per-document updates
  listClientDocuments: (clientId: string) => send('GET', `/api/clients/${clientId}/documents`).then(json<{ documents: DocumentInfo[] }>),
  updateDocument: (clientId: string, period: string, id: string, body: { name?: string; category?: string; period?: string }) =>
    send('PATCH', `/api/clients/${clientId}/qbr/${period}/documents/${id}`, body).then(json<{ document: DocumentInfo }>),
  /** Ask the AI to read a filed PDF and suggest vendor/name/quarter/category. */
  matchDocument: (clientId: string, period: string, id: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/documents/${id}/match`).then(
      json<{ suggestion: DocMatchSuggestion; document: DocumentInfo }>,
    ),

  // Opportunity board
  listOpportunities: (clientId: string) => send('GET', `/api/clients/${clientId}/opportunities`).then(json<{ opportunities: Opportunity[] }>),
  saveOpportunity: (clientId: string, body: Partial<Opportunity>) =>
    send('POST', `/api/clients/${clientId}/opportunities`, body).then(json<{ opportunity: Opportunity }>),
  deleteOpportunity: (clientId: string, id: string) => send('DELETE', `/api/clients/${clientId}/opportunities/${id}`).then(json<unknown>),
  pushOpportunity: (clientId: string, id: string, body: { target: string; ticketTypeId?: string; agentId?: string; team?: string; priorityId?: string }) =>
    send('POST', `/api/clients/${clientId}/opportunities/${id}/push`, body).then(json<{ opportunity: Opportunity; pushed: { system: string; id: string } }>),

  haloMeta: (connectionId?: string) =>
    send('GET', `/api/integrations/halo/meta${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`).then(json<HaloMeta>),
  ninjaMeta: (connectionId?: string) =>
    send('GET', `/api/integrations/ninja/meta${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`).then(
      json<{ roles: Array<{ id: string; name: string }> }>,
    ),
  pushAction: (
    clientId: string,
    period: string,
    body: {
      actionId?: string;
      target: string;
      title?: string;
      detail?: string;
      ticketTypeId?: string;
      agentId?: string;
      team?: string;
      priorityId?: string;
    },
  ) => send('POST', `/api/clients/${clientId}/qbr/${period}/actions/push`, body).then(json<{ system: string; id: string; status?: string }>),

  // Microsoft 365 (delegated Graph via Easy Auth — token refreshed transparently)
  emailQbr: (clientId: string, period: string, payload: { to: string[]; subject?: string; bodyHtml?: string; attachDeck?: boolean }) =>
    withAuthRefresh(() => send('POST', `/api/clients/${clientId}/qbr/${period}/email`, payload).then(json<{ sent: boolean; to: string[] }>)),
  createMeeting: (clientId: string, period: string, payload: { start: string; end?: string; attendees?: string[]; subject?: string }) =>
    withAuthRefresh(() =>
      send('POST', `/api/clients/${clientId}/qbr/${period}/meeting`, payload).then(json<{ scheduledAt: string; joinUrl?: string; eventId?: string }>),
    ),

  // Org settings (default branding)
  getOrgSettings: () =>
    send('GET', '/api/settings/org').then(json<{ brand: { name?: string; logoDataUri?: string; primary?: string; accent?: string } }>),
  putOrgSettings: (brand: { name?: string; logoDataUri?: string; primary?: string; accent?: string }) =>
    send('PUT', '/api/settings/org', { brand }).then(json<{ brand: unknown }>),

  // Integrations
  listIntegrations: () => send('GET', '/api/integrations').then(json<{ integrations: ConnectionView[] }>),
  integrationOrgs: (id: string) =>
    send('GET', `/api/integrations/${id}/orgs`).then(json<{ orgs: Array<{ id: string; name: string }> | null }>),
  putMappings: (id: string, mappings: Array<{ clientId: string; externalRef?: string }>) =>
    send('PUT', `/api/integrations/${id}/mappings`, { mappings }).then(json<{ updated: number; refKey: string }>),
  createIntegration: (input: ConnectionInput) => send('POST', '/api/integrations', input).then(json<ConnectionView>),
  updateIntegration: (id: string, input: ConnectionInput) => send('PUT', `/api/integrations/${id}`, input).then(json<ConnectionView>),
  deleteIntegration: (id: string) => send('DELETE', `/api/integrations/${id}`).then(json<{ deleted: string }>),
  testIntegration: (id: string) => send('POST', `/api/integrations/${id}/test`).then(json<{ ok: boolean; error?: string; note?: string }>),
};

export const reportUrls = (clientId: string, period: string) => ({
  html: `/api/clients/${clientId}/qbr/${period}/report.html`,
  pdf: `/api/clients/${clientId}/qbr/${period}/report.pdf`,
  deck: `/api/clients/${clientId}/qbr/${period}/deck.pptx`,
  email: `/api/clients/${clientId}/qbr/${period}/email.eml`,
});

export const documentUrl = (clientId: string, period: string, id: string) =>
  `/api/clients/${clientId}/qbr/${period}/documents/${id}`;
