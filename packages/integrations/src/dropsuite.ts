import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * Dropsuite (email/M365 backup) sub-reseller API client, built on the "Rest
 * API Document For Sub-reseller v1.0" PDF:
 * - Auth is TWO headers on every call: `X-Reseller-Token` (the reseller
 *   token) and `X-Access-Token` (an authentication token).
 * - `GET /users` (with the RESELLER's admin token as X-Access-Token) lists
 *   tenant users — "these are also organizations" — each carrying its own
 *   per-user `authentication_token`.
 * - `GET /accounts` (with THAT USER's token as X-Access-Token) lists the
 *   tenant's backed-up mailboxes: email, last_backup, current_backup_status,
 *   errors, deactivated_since.
 */

export interface DropsuiteCfg {
  /** API base, e.g. https://dropsuite.us/api */
  baseUrl?: string;
  /** X-Reseller-Token. */
  resellerToken: string;
  /** The reseller's admin authentication token (X-Access-Token for /users). */
  accessToken: string;
}

type Json = Record<string, unknown>;

const base = (cfg: DropsuiteCfg) => (cfg.baseUrl ?? 'https://dropsuite.us/api').replace(/\/+$/, '');

async function dsGet(
  http: HttpTransport,
  cfg: DropsuiteCfg,
  path: string,
  accessToken: string,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = `${base(cfg)}/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({
    method: 'GET',
    url,
    headers: { 'X-Reseller-Token': cfg.resellerToken, 'X-Access-Token': accessToken, Accept: 'application/json' },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Dropsuite responded ${res.status} for /${path}`);
  return res.json;
}

interface DropsuiteUser {
  id?: number | string;
  email?: string;
  authentication_token?: string;
  organization_id?: number | string;
  seats_used?: number;
  customer_deactivated?: boolean;
}

/** Tenant users double as organizations (drives org mapping). */
export async function listDropsuiteOrgs(http: HttpTransport, cfg: DropsuiteCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await dsGet(http, cfg, 'users', cfg.accessToken);
  return toArray<DropsuiteUser>(json, ['users'])
    .filter((u) => u.id !== undefined && u.customer_deactivated !== true)
    .map((u) => ({ id: String(u.id), name: u.email ?? `User ${String(u.id)}` }));
}

export interface DropsuiteAccountRow {
  email?: string;
  last_backup?: string | null;
  current_backup_status?: string;
  errors?: Record<string, unknown> | string;
  deactivated_since?: string | null;
  flg_deleted?: boolean;
}

/** Normalize per-account backup rows into seat + health metrics (with drill-down). */
export function normalizeDropsuiteAccounts(rows: DropsuiteAccountRow[]): MetricValue[] {
  const active = rows.filter((r) => r.flg_deleted !== true && !r.deactivated_since);
  const withErrors = active.filter((r) => {
    if (typeof r.errors === 'string') return r.errors.trim() !== '';
    return r.errors !== undefined && r.errors !== null && Object.keys(r.errors).length > 0;
  });
  const details = active.slice(0, 100).map((r) => ({
    mailbox: r.email ?? '',
    status: r.current_backup_status ?? '',
    lastBackup: (r.last_backup ?? '').slice(0, 10),
  }));
  const out: MetricValue[] = [
    {
      ...metric('backup.protected_accounts', 'Backed-up mailboxes', active.length, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: true }),
      details,
    },
  ];
  if (withErrors.length > 0) {
    out.push({
      ...metric('backup.failed_jobs', 'Mailboxes with backup errors', withErrors.length, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: false }),
      details: withErrors.slice(0, 100).map((r) => ({
        mailbox: r.email ?? '',
        error: typeof r.errors === 'string' ? r.errors.slice(0, 120) : JSON.stringify(r.errors ?? {}).slice(0, 120),
      })),
    });
  }
  if (active.length > 0) {
    const pct = Math.round((1000 * (active.length - withErrors.length)) / active.length) / 10;
    out.push(metric('backup.success_pct', 'Backup success rate', pct, { category: 'backup', source: 'dropsuite', unit: '%', higherIsBetter: true }));
  }
  return out;
}

/** Collect Dropsuite backup posture for a mapped tenant user. */
export async function collectDropsuite(ctx: CollectorContext, http: HttpTransport, cfg: DropsuiteCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'dropsuite', metrics: [], warnings: ['No Dropsuite organization mapped for this client.'] };
  }
  // The mapped tenant user carries its own access token for /accounts.
  let user: DropsuiteUser | undefined;
  try {
    const users = toArray<DropsuiteUser>(await dsGet(http, cfg, 'users', cfg.accessToken), ['users']);
    user = users.find((u) => String(u.id) === String(ctx.externalRef) || String(u.organization_id ?? '') === String(ctx.externalRef));
  } catch (e) {
    return { source: 'dropsuite', metrics: [], warnings: [`Dropsuite users unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
  if (!user?.authentication_token) {
    return { source: 'dropsuite', metrics: [], warnings: [`Dropsuite tenant user ${ctx.externalRef} not found (re-map this client under Integrations).`] };
  }

  const warnings: string[] = [];
  let rows: DropsuiteAccountRow[] = [];
  try {
    rows = toArray<DropsuiteAccountRow>(await dsGet(http, cfg, 'accounts', user.authentication_token), ['accounts']);
  } catch (e) {
    return { source: 'dropsuite', metrics: [], warnings: [`Dropsuite accounts unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
  if (rows.length === 0) warnings.push('Dropsuite returned no backed-up accounts for this tenant.');
  return { source: 'dropsuite', metrics: normalizeDropsuiteAccounts(rows), warnings };
}
