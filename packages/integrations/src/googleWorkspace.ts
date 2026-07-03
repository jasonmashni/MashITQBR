import { createSign } from 'node:crypto';
import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';

/**
 * Google Workspace client — read-only Admin SDK Directory access via a
 * service account with domain-wide delegation, impersonating a Workspace
 * admin. This integration is inherently per-client (one Workspace domain per
 * connection), so the connection binds to a single QBR client rather than
 * using the org-mapping modal.
 *
 * Setup in Google Cloud: create a service account + JSON key, enable the
 * Admin SDK API, then in Google Admin → Security → API controls → domain-wide
 * delegation, authorize the service account's client id for scope
 * `https://www.googleapis.com/auth/admin.directory.user.readonly`.
 */

export interface GoogleWorkspaceCfg {
  /** Workspace admin the service account impersonates (delegated subject). */
  adminEmail: string;
  /** Directory customer id (default `my_customer` = the admin's domain). */
  customer?: string;
  /** Full service-account JSON key (kept in the secret store). */
  serviceAccountJson: string;
  /** Test overrides. */
  tokenUrl?: string;
  apiUrl?: string;
}

type Json = Record<string, unknown>;

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

const b64url = (input: Buffer | string) =>
  (typeof input === 'string' ? Buffer.from(input) : input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Exchange a signed service-account JWT for an access token (RFC 7523). */
export async function googleWorkspaceToken(http: HttpTransport, cfg: GoogleWorkspaceCfg): Promise<string> {
  let key: { client_email?: string; private_key?: string };
  try {
    key = JSON.parse(cfg.serviceAccountJson) as { client_email?: string; private_key?: string };
  } catch {
    throw new Error('Google Workspace service-account key is not valid JSON — paste the full downloaded key file.');
  }
  if (!key.client_email || !key.private_key) throw new Error('Service-account key is missing client_email/private_key.');

  const cacheKey = `${key.client_email}|${cfg.adminEmail}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const tokenUrl = cfg.tokenUrl ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, sub: cfg.adminEmail, aud: tokenUrl, scope: SCOPE, iat: now, exp: now + 3600 }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(key.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await http.request({
    method: 'POST',
    url: tokenUrl,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const json = (res.json ?? {}) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (res.status < 200 || res.status >= 300 || !token) {
    const detail = typeof json['error_description'] === 'string' ? json['error_description'] : '';
    throw new Error(`Google Workspace token exchange failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

export interface GoogleWorkspaceUser {
  suspended?: boolean;
  archived?: boolean;
  isEnrolledIn2Sv?: boolean;
}

/** Normalize directory users into identity metrics (2SV = Google's MFA). */
export function normalizeGoogleWorkspaceUsers(users: GoogleWorkspaceUser[]): MetricValue[] {
  const active = users.filter((u) => u.suspended !== true && u.archived !== true);
  const out: MetricValue[] = [
    metric('identity.users', 'Google Workspace users', active.length, { category: 'identity', source: 'googleworkspace', unit: 'count' }),
  ];
  if (active.length > 0) {
    const enrolled = active.filter((u) => u.isEnrolledIn2Sv === true).length;
    out.push(
      metric('identity.mfa_coverage_pct', '2-Step Verification coverage', Math.round((1000 * enrolled) / active.length) / 10, {
        category: 'identity',
        source: 'googleworkspace',
        unit: '%',
        higherIsBetter: true,
      }),
      metric('identity.users_without_mfa', 'Users without 2SV', active.length - enrolled, {
        category: 'identity',
        source: 'googleworkspace',
        unit: 'count',
        higherIsBetter: false,
      }),
    );
  }
  const suspended = users.filter((u) => u.suspended === true).length;
  if (suspended > 0) {
    out.push(metric('identity.suspended_users', 'Suspended accounts', suspended, { category: 'identity', source: 'googleworkspace', unit: 'count' }));
  }
  return out;
}

/** Collect Google Workspace identity posture for the bound client. */
export async function collectGoogleWorkspace(ctx: CollectorContext, http: HttpTransport, cfg: GoogleWorkspaceCfg): Promise<CollectResult> {
  const api = (cfg.apiUrl ?? 'https://admin.googleapis.com').replace(/\/+$/, '');
  const customer = cfg.customer || 'my_customer';
  try {
    const token = await googleWorkspaceToken(http, cfg);
    const users: GoogleWorkspaceUser[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ customer, maxResults: '500', ...(pageToken ? { pageToken } : {}) }).toString();
      const res = await http.request({
        method: 'GET',
        url: `${api}/admin/directory/v1/users?${qs}`,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`Directory API responded ${res.status}`);
      const json = (res.json ?? {}) as Json;
      users.push(...((json['users'] as GoogleWorkspaceUser[] | undefined) ?? []));
      pageToken = typeof json['nextPageToken'] === 'string' ? (json['nextPageToken'] as string) : undefined;
      if (!pageToken) break;
    }
    const warnings = users.length === 0 ? ['Google Workspace returned no users — check the admin email and domain-wide delegation.'] : [];
    return { source: 'googleworkspace', metrics: normalizeGoogleWorkspaceUsers(users), warnings };
  } catch (e) {
    return { source: 'googleworkspace', metrics: [], warnings: [`Google Workspace unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
}
