// Thin typed fetch wrapper over the QBR API. All calls are relative to the
// serving origin (the Function App also serves this SPA; Vite proxies /api in dev).
import { notifications } from '@mantine/notifications';
import type {
  AuditEvent,
  BookingInfo,
  BookingSettings,
  Client,
  ClientGoal,
  ConnectionView,
  Discussion,
  DocExtraction,
  DocMatchSuggestion,
  DocumentInfo,
  HaloMeta,
  Me,
  MetricRow,
  NotificationInfo,
  Opportunity,
  Overview,
  PackageStage,
  PeriodInfo,
  SuggestedConversationsResponse,
  QbrMeta,
  QbrResponse,
  QbrStatus,
  ReportConfig,
  SnapshotView,
  SystemInfo,
} from './types.js';

/**
 * A status change that reaches lock 2 can save while the final package fails
 * to store; the API says so in `warning`, and every caller shows it.
 */
function showLockWarning<T>(r: T): T {
  const warning = (r as { warning?: unknown } | null)?.warning;
  if (typeof warning === 'string' && warning) notifications.show({ color: 'watch', title: 'Final package not stored', message: warning });
  return r;
}

/** Thrown for a non-2xx response; `status` lets callers tell 401 from 409 from 500. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // A redirect to a login page, or a host error page: keep the status text.
      if (res.status === 401 || res.redirected) message = 'Not signed in';
    }
    throw new ApiError(message, res.status);
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

// Capabilities don't change while the app is open: fetch once, share everywhere.
// A failed fetch is NOT memoized, so one cold-start error cannot hide the AI
// buttons for the whole session.
let _system: Promise<SystemInfo> | undefined;

// Some hosts refuse to register functions on /api/system routes while serving
// every other route: try the "system"-free alias first, then the older ones.
async function fetchSystem(): Promise<SystemInfo> {
  let lastStatus = 0;
  for (const url of ['/api/capabilities', '/api/system', '/api/system-info']) {
    const res = await send('GET', url);
    if (res.ok) return res.json() as Promise<SystemInfo>;
    lastStatus = res.status;
    if (res.status === 401) break;
  }
  throw new ApiError(lastStatus === 401 ? 'Not signed in' : 'System info unavailable', lastStatus || 503);
}

export const api = {
  // System capabilities (memoized while the call succeeds)
  system: () =>
    (_system ??= fetchSystem().catch((e: unknown) => {
      _system = undefined;
      throw e;
    })),
  /** Re-read the system info (e.g. after an inbox poll) and refresh the memo. */
  systemFresh: () =>
    (_system = fetchSystem().catch((e: unknown) => {
      _system = undefined;
      throw e;
    })),
  /** Drain the shared report mailbox now (the timer does this every 5 min). */
  pollInbox: () =>
    send('POST', '/api/inbox/poll').then(
      json<{
        processed: number;
        filed: number;
        unrouted: number;
        /** Senders outside the mailbox domain or the allowlist, or mail from Junk (not filed). */
        untrusted?: number;
        /** Messages whose processing threw (categorized "QBR: failed"). */
        failed?: Array<{ id: string; subject?: string; error: string }>;
        folders?: Array<{ folder: string; total: number; unread: number }>;
      }>,
    ),
  me: () => send('GET', '/api/me').then(json<Me>),
  audit: (limit = 100) => send('GET', `/api/audit?limit=${limit}`).then(json<{ events: AuditEvent[] }>),

  // Clients
  listClients: () => send('GET', '/api/clients').then(json<{ clients: Client[] }>),
  getClient: (id: string) => send('GET', `/api/clients/${id}`).then(json<{ client: Client }>),
  updateClient: (id: string, patch: Partial<Client>) => send('PUT', `/api/clients/${id}`, patch).then(json<Client>),
  putClientGoals: (id: string, goals: ClientGoal[]) =>
    send('PUT', `/api/clients/${id}/goals`, { goals }).then(json<{ client: Client }>),
  importHalo: () => send('POST', '/api/clients/import/halo').then(json<{ imported: number; clients: Client[] }>),

  // QBR + report
  getQbr: (clientId: string, period: string, ai = true) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}${ai ? '' : '?ai=0'}`).then(json<QbrResponse>),
  currentPeriod: () => send('GET', '/api/period/current').then(json<{ period: string }>),
  overview: () => send('GET', '/api/overview').then(json<Overview>),
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
  /** Approve the narrative: moves the QBR forward to narrative_approved, never backwards. */
  approveNarrative: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/narrative/approve`).then(json<QbrMeta>),

  // Data review
  getMetrics: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/metrics`).then(json<{ snapshot: SnapshotView; excluded: string[]; warnings?: string[] }>),
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
  /**
   * Set the lifecycle status. Forward moves just happen; a backwards move
   * needs `force: true` and a reason, and is written to the audit log.
   */
  putStatus: (clientId: string, period: string, body: { status: QbrStatus; force?: boolean; reason?: string }) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/status`, body).then(json<QbrMeta & { warning?: string }>).then(showLockWarning),
  /** Record that the report package went out (the explicit "Send package" step). */
  markPackageSent: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/package/sent`).then(json<QbrMeta>),
  /** Lock 2 on demand: store the final package and make the quarter read-only. */
  finalize: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/finalize`).then(json<QbrMeta>),
  /** Audited reopen: `final` reopens the agenda and decisions, `preread` reopens everything. */
  reopen: (clientId: string, period: string, body: { stage: PackageStage; reason: string }) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/reopen`, body).then(json<QbrMeta>),
  /** Client skipped the meeting: record the disposition and store the final package. */
  dispositionSkipped: (clientId: string, period: string, reason?: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/disposition`, reason ? { reason } : {})
      .then(json<QbrMeta & { warning?: string }>)
      .then(showLockWarning),
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
  /** Ask the AI to read a filed PDF and extract QBR metrics for review. */
  extractDocument: (clientId: string, period: string, id: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/documents/${id}/extract`).then(
      json<{ extraction: DocExtraction; source: string; document: DocumentInfo }>,
    ),
  /** Import reviewed document metrics into the quarter's snapshot. */
  importDocMetrics: (clientId: string, period: string, body: { source: string; metrics: DocExtraction['metrics'] }) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/metrics/import`, body).then(json<{ imported: number; source: string; period: string }>),
  /** Undo a document import: drop every metric that source added to the quarter. */
  removeImportedMetrics: (clientId: string, period: string, source: string) =>
    send('DELETE', `/api/clients/${clientId}/qbr/${period}/metrics/import?source=${encodeURIComponent(source)}`).then(
      json<{ removed: number; source: string; period: string }>,
    ),

  // Opportunity board
  listOpportunities: (clientId: string) => send('GET', `/api/clients/${clientId}/opportunities`).then(json<{ opportunities: Opportunity[] }>),
  // `value: null` explicitly clears an estimate (undefined would be dropped by JSON.stringify and keep the old value).
  saveOpportunity: (clientId: string, body: Omit<Partial<Opportunity>, 'value'> & { value?: number | null }) =>
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

  // Microsoft 365 (delegated Graph via Easy Auth; token refreshed transparently)
  emailQbr: (clientId: string, period: string, payload: { to: string[]; subject?: string; bodyHtml?: string; attachDeck?: boolean }) =>
    withAuthRefresh(() => send('POST', `/api/clients/${clientId}/qbr/${period}/email`, payload).then(json<{ sent: boolean; to: string[] }>)),
  createMeeting: (clientId: string, period: string, payload: { start: string; end?: string; attendees?: string[]; subject?: string }) =>
    withAuthRefresh(() =>
      send('POST', `/api/clients/${clientId}/qbr/${period}/meeting`, payload).then(json<{ scheduledAt: string; joinUrl?: string; eventId?: string }>),
    ),

  // Org settings (default branding + booking rules)
  getOrgSettings: () =>
    send('GET', '/api/settings/org').then(
      json<{ brand: { name?: string; logoDataUri?: string; primary?: string; accent?: string }; booking: BookingSettings }>,
    ),
  putOrgSettings: (brand: { name?: string; logoDataUri?: string; primary?: string; accent?: string }, booking?: BookingSettings) =>
    send('PUT', '/api/settings/org', { brand, booking }).then(json<{ brand: unknown; booking: BookingSettings }>),

  // Client self-scheduling (booking links)
  getBooking: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/booking`).then(
      json<{ booking: BookingInfo | null; path: string | null; configured: boolean; calendarConnected: boolean }>,
    ),
  createBookingLink: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/booking`).then(json<{ booking: BookingInfo; path: string }>),
  /** Cancel the scheduled meeting: deletes the Teams event, reopens booking. */
  cancelMeeting: (clientId: string, period: string) =>
    send('DELETE', `/api/clients/${clientId}/qbr/${period}/meeting`).then(json<{ cancelled: boolean }>),
  /** Client + industry intelligence (web-search-backed) for QBR prep. */
  researchClient: (clientId: string) =>
    send('POST', `/api/clients/${clientId}/research`).then(
      json<{
        available: boolean;
        note?: string;
        research?: {
          summary: string;
          trends: Array<{ title: string; insight: string; relevance: string; sourceName?: string; sourceUrl?: string }>;
          suggestedGoals: Array<{ title: string; alignment: string }>;
          recommendations: string[];
          sourced: boolean;
        };
      }>,
    ),
  /** Consultative agenda suggestions from the quarter's data (2-3 talking points).
   * Pass `exclude` (topics already shown) so Refresh surfaces different ones. */
  suggestAgenda: (clientId: string, period: string, exclude: string[] = []) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/agenda`, { exclude }).then(
      json<{ suggestions: Array<{ topic: string; rationale: string }>; source: 'ai' | 'offline'; note?: string }>,
    ),
  suggestedConversations: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/conversations/suggested`).then(json<SuggestedConversationsResponse>),

  // In-portal notifications (bell)
  notifications: (limit = 30) =>
    send('GET', `/api/notifications?limit=${limit}`).then(json<{ notifications: NotificationInfo[]; unread: number }>),
  markNotificationsRead: (ids: string[] | 'all') => send('POST', '/api/notifications/read', { ids }).then(json<unknown>),

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
