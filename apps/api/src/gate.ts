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

let warnedOverride = false;
let warnedEasyAuth = false;

/**
 * Whether every non-public route needs an Easy Auth principal.
 * On App Service (WEBSITE_INSTANCE_ID set) it is always on: the
 * `QBR_AUTH_REQUIRED=0` override is local-only and ignored there, with a
 * one-time warning. Elsewhere `QBR_AUTH_REQUIRED=1` turns it on.
 */
export function authRequired(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env['QBR_AUTH_REQUIRED'];
  if (env['WEBSITE_INSTANCE_ID']) {
    if (flag === '0' && !warnedOverride) {
      warnedOverride = true;
      console.warn('QBR_AUTH_REQUIRED=0 is ignored on App Service; the API still requires an Easy Auth principal.');
    }
    return true;
  }
  return flag === '1';
}

/**
 * On App Service, the platform sets WEBSITE_AUTH_ENABLED=True when Easy Auth is
 * on. Without it nothing strips a client-supplied `x-ms-client-principal`
 * header, so the header cannot be trusted and every gated route fails closed.
 */
export function easyAuthMissing(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env['WEBSITE_INSTANCE_ID']) && (env['WEBSITE_AUTH_ENABLED'] ?? '').trim().toLowerCase() !== 'true';
}

/** The client self-scheduling page and its API: public by design (the token authorizes). */
export function isPublicRoute(path: string): boolean {
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return p === 'book' || p.startsWith('book/') || p === 'api/book' || p.startsWith('api/book/');
}

/** Run `fn` only when the caller is allowed to reach `path`; else 401. */
export async function gate(path: string, headerGet: HeaderGet, fn: () => Promise<ApiResult> | ApiResult): Promise<ApiResult> {
  if (isPublicRoute(path) || !authRequired()) return fn();
  if (easyAuthMissing()) {
    if (!warnedEasyAuth) {
      warnedEasyAuth = true;
      console.error('Easy Auth is not enabled on this app (WEBSITE_AUTH_ENABLED is not True); refusing every gated route.');
    }
    return { status: 401, json: { error: 'Sign-in is not configured on this app' } };
  }
  if (!principalFrom(headerGet)) {
    return { status: 401, json: { error: 'Not signed in' } };
  }
  return fn();
}
