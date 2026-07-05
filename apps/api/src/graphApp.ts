/**
 * App-only (client-credentials) Microsoft Graph client for the booking page.
 * The public page runs with NO signed-in user, so delegated Easy Auth tokens
 * don't exist there — availability + invite creation act on the organizer's
 * calendar via application permissions instead.
 *
 * Configuration reuses the report-inbox app registration (add the
 * `Calendars.ReadWrite` APPLICATION permission + admin consent to it):
 *   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET, falling back to
 *   REPORTS_TENANT_ID / REPORTS_CLIENT_ID / REPORTS_CLIENT_SECRET.
 */

export interface GraphAppConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function graphAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GraphAppConfig | null {
  const tenantId = env['GRAPH_TENANT_ID'] || env['REPORTS_TENANT_ID'];
  const clientId = env['GRAPH_CLIENT_ID'] || env['REPORTS_CLIENT_ID'];
  const clientSecret = env['GRAPH_CLIENT_SECRET'] || env['REPORTS_CLIENT_SECRET'];
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

type Json = Record<string, unknown>;

let _token: { key: string; value: string; expiresAt: number } | undefined;

/** Test hook: drop the cached token. */
export function _resetGraphAppToken(): void {
  _token = undefined;
}

async function appToken(cfg: GraphAppConfig, fetchFn: FetchLike): Promise<string> {
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  if (_token && _token.key === key && _token.expiresAt > Date.now() + 60_000) return _token.value;
  const res = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (!res.ok || !token) {
    const desc = typeof json['error_description'] === 'string' ? json['error_description'].split(/\r?\n/)[0] : '';
    throw new Error(`Graph app token exchange failed (${res.status})${desc ? `: ${desc}` : ''}`);
  }
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  _token = { key, value: token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graphJson(cfg: GraphAppConfig, fetchFn: FetchLike, method: string, path: string, body?: unknown): Promise<Json> {
  const token = await appToken(cfg, fetchFn);
  const res = await fetchFn(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const err = (json['error'] as Json | undefined)?.['message'];
    throw new Error(`Graph ${method} ${path} responded ${res.status}${typeof err === 'string' ? `: ${err}` : ''}`);
  }
  return json;
}

/**
 * The organizer's availabilityView between two LOCAL wall-clock instants in
 * `timezone` — one char per `intervalMinutes` cell, '0' = free. Returns null
 * when the calendar can't be read (missing permission, unknown mailbox); the
 * booking page then falls back to configured windows only.
 */
export async function getAvailabilityView(
  cfg: GraphAppConfig,
  organizer: string,
  startLocal: string,
  endLocal: string,
  timezone: string,
  intervalMinutes: number,
  fetchFn: FetchLike = fetch,
): Promise<string | null> {
  try {
    const json = await graphJson(cfg, fetchFn, 'POST', `/users/${encodeURIComponent(organizer)}/calendar/getSchedule`, {
      schedules: [organizer],
      startTime: { dateTime: `${startLocal}:00`, timeZone: timezone },
      endTime: { dateTime: `${endLocal}:00`, timeZone: timezone },
      availabilityViewInterval: intervalMinutes,
    });
    const first = (json['value'] as Json[] | undefined)?.[0];
    const view = first?.['availabilityView'];
    return typeof view === 'string' && view.length > 0 ? view : null;
  } catch {
    return null;
  }
}

export interface CreatedEvent {
  eventId: string;
  joinUrl?: string;
}

/**
 * Create a Teams meeting on the organizer's calendar and invite the client.
 * Times are LOCAL wall-clock in `timezone` (Graph converts).
 */
export async function createOrganizerEvent(
  cfg: GraphAppConfig,
  organizer: string,
  event: {
    subject: string;
    bodyHtml: string;
    startLocal: string;
    endLocal: string;
    timezone: string;
    attendees: Array<{ email: string; name?: string }>;
  },
  fetchFn: FetchLike = fetch,
): Promise<CreatedEvent> {
  const json = await graphJson(cfg, fetchFn, 'POST', `/users/${encodeURIComponent(organizer)}/events`, {
    subject: event.subject,
    body: { contentType: 'HTML', content: event.bodyHtml },
    start: { dateTime: `${event.startLocal}:00`, timeZone: event.timezone },
    end: { dateTime: `${event.endLocal}:00`, timeZone: event.timezone },
    attendees: event.attendees.map((a) => ({
      type: 'required',
      emailAddress: { address: a.email, name: a.name || a.email },
    })),
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
  });
  const online = json['onlineMeeting'] as Json | undefined;
  return {
    eventId: typeof json['id'] === 'string' ? json['id'] : '',
    joinUrl: typeof online?.['joinUrl'] === 'string' ? (online['joinUrl'] as string) : undefined,
  };
}

/** Cancel/delete a previously-created calendar event (best-effort). */
export async function deleteOrganizerEvent(
  cfg: GraphAppConfig,
  organizer: string,
  eventId: string,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  await graphJson(cfg, fetchFn, 'DELETE', `/users/${encodeURIComponent(organizer)}/events/${encodeURIComponent(eventId)}`);
}

/**
 * Send a plain heads-up email from the organizer mailbox (app-only). Used to
 * ping the MSP when a client books. Needs the Mail.Send APPLICATION permission
 * on the same app registration — best-effort, so a missing grant just no-ops.
 */
export async function sendOrganizerMail(
  cfg: GraphAppConfig,
  organizer: string,
  mail: { subject: string; html: string; to: string[] },
  fetchFn: FetchLike = fetch,
): Promise<void> {
  await graphJson(cfg, fetchFn, 'POST', `/users/${encodeURIComponent(organizer)}/sendMail`, {
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: mail.to.map((a) => ({ emailAddress: { address: a } })),
    },
    saveToSentItems: false,
  });
}
