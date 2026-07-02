// Thin typed fetch wrapper over the QBR API. All calls are relative to the
// serving origin (the Function App also serves this SPA; Vite proxies /api in dev).
import type {
  Client,
  ConnectionView,
  Discussion,
  QbrResponse,
  ReportConfig,
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

// Capabilities don't change while the app is open — fetch once, share everywhere.
let _system: Promise<SystemInfo> | undefined;

export const api = {
  // System capabilities (memoized)
  system: () => (_system ??= send('GET', '/api/system').then(json<SystemInfo>)),

  // Clients
  listClients: () => send('GET', '/api/clients').then(json<{ clients: Client[] }>),
  updateClient: (id: string, patch: Partial<Client>) => send('PUT', `/api/clients/${id}`, patch).then(json<Client>),
  importHalo: () => send('POST', '/api/clients/import/halo').then(json<{ imported: number; clients: Client[] }>),

  // QBR + report
  getQbr: (clientId: string, period: string, ai = true) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}${ai ? '' : '?ai=0'}`).then(json<QbrResponse>),
  currentPeriod: () => send('GET', '/api/period/current').then(json<{ period: string }>),

  // Config + discussion
  getConfig: (clientId: string) => send('GET', `/api/clients/${clientId}/config`).then(json<ReportConfig>),
  putConfig: (clientId: string, config: ReportConfig) => send('PUT', `/api/clients/${clientId}/config`, config).then(json<ReportConfig>),
  getDiscussion: (clientId: string, period: string) =>
    send('GET', `/api/clients/${clientId}/qbr/${period}/discussion`).then(json<Discussion>),
  putDiscussion: (clientId: string, period: string, disc: Discussion) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/discussion`, disc).then(json<Discussion>),

  // Workflow
  sync: (clientId: string, period: string) =>
    send('POST', `/api/clients/${clientId}/qbr/${period}/sync`).then(json<{ metrics: number; warnings: string[] }>),
  putStatus: (clientId: string, period: string, status: string) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/status`, { status }).then(json<unknown>),
  putSchedule: (clientId: string, period: string, body: { scheduledAt?: string; joinUrl?: string }) =>
    send('PUT', `/api/clients/${clientId}/qbr/${period}/schedule`, body).then(json<unknown>),
  pushAction: (
    clientId: string,
    period: string,
    body: { actionId?: string; target: string; title?: string; detail?: string },
  ) => send('POST', `/api/clients/${clientId}/qbr/${period}/actions/push`, body).then(json<{ system: string; id: string; status?: string }>),

  // Integrations
  listIntegrations: () => send('GET', '/api/integrations').then(json<{ integrations: ConnectionView[] }>),
  createIntegration: (input: ConnectionInput) => send('POST', '/api/integrations', input).then(json<ConnectionView>),
  updateIntegration: (id: string, input: ConnectionInput) => send('PUT', `/api/integrations/${id}`, input).then(json<ConnectionView>),
  deleteIntegration: (id: string) => send('DELETE', `/api/integrations/${id}`).then(json<{ deleted: string }>),
  testIntegration: (id: string) => send('POST', `/api/integrations/${id}/test`).then(json<{ ok: boolean; error?: string; note?: string }>),
};

export const reportUrls = (clientId: string, period: string) => ({
  html: `/api/clients/${clientId}/qbr/${period}/report.html`,
  pdf: `/api/clients/${clientId}/qbr/${period}/report.pdf`,
  deck: `/api/clients/${clientId}/qbr/${period}/deck.pptx`,
});
