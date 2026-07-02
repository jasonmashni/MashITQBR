import type { HeaderGet } from './auth.js';

/**
 * Microsoft Graph, delegated as the signed-in user, with no MSAL in the app:
 * App Service Easy Auth's token store injects the user's Graph access token
 * on every request once the Entra provider is configured with the Graph
 * scopes (see README). Tokens last ~60–90 min; when stale the SPA calls
 * /.auth/refresh (browser session cookie) and retries.
 */
export function graphTokenFrom(get: HeaderGet): { token?: string; expired?: boolean } {
  const token = get('x-ms-token-aad-access-token') ?? undefined;
  if (!token) return {};
  const expiresOn = get('x-ms-token-aad-expires-on');
  if (expiresOn) {
    const exp = Date.parse(expiresOn);
    if (Number.isFinite(exp) && exp < Date.now() + 60_000) return { token, expired: true };
  }
  return { token };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GraphResult {
  status: number;
  json: unknown;
}

/** POST to Graph v1.0 as the user. */
export async function graphPost(token: string, path: string, body: unknown, fetchFn: FetchLike = fetch): Promise<GraphResult> {
  const res = await fetchFn(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validEmails(v: unknown): string[] {
  return (Array.isArray(v) ? v : [])
    .map((e) => String(e).trim())
    .filter((e) => EMAIL_RE.test(e));
}
