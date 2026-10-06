/**
 * Code-level authentication gate (defense in depth behind Easy Auth).
 *
 * In Azure, Easy Auth should reject unauthenticated requests before they reach
 * the app. If it is ever misconfigured or switched off, this gate still refuses
 * to serve data to a caller without an `x-ms-client-principal`. Both routers
 * (Azure Functions and the local dev server) wrap every handler with it.
 */
import { principalFrom, type HeaderGet } from './auth.js';
import type { ApiResult } from './handlers.js';

/**
 * Whether every non-public route needs an Easy Auth principal.
 * `QBR_AUTH_REQUIRED=1` forces it on, `=0` forces it off (local dev);
 * otherwise it is on whenever we run on App Service (WEBSITE_INSTANCE_ID set).
 */
export function authRequired(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env['QBR_AUTH_REQUIRED'];
  if (flag === '1') return true;
  if (flag === '0') return false;
  return Boolean(env['WEBSITE_INSTANCE_ID']);
}

/** The client self-scheduling page and its API: public by design (the token authorizes). */
export function isPublicRoute(path: string): boolean {
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return p === 'book' || p.startsWith('book/') || p === 'api/book' || p.startsWith('api/book/');
}

/** Run `fn` only when the caller is allowed to reach `path`; else 401. */
export async function gate(path: string, headerGet: HeaderGet, fn: () => Promise<ApiResult> | ApiResult): Promise<ApiResult> {
  if (authRequired() && !isPublicRoute(path) && !principalFrom(headerGet)) {
    return { status: 401, json: { error: 'Not signed in' } };
  }
  return fn();
}
