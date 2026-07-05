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

/**
 * Tenant users double as organizations (drives org mapping). The /users rows
 * often all carry the RESELLER's email, so each user's backed-up tenant
 * DOMAIN (GET /users/{id}/tenants, called with that user's own token) is the
 * human-readable label.
 */
export async function listDropsuiteOrgs(http: HttpTransport, cfg: DropsuiteCfg): Promise<Array<{ id: string; name: string }>> {
  const users = toArray<DropsuiteUser>(await dsGet(http, cfg, 'users', cfg.accessToken), ['users']).filter(
    (u) => u.id !== undefined && u.customer_deactivated !== true,
  );
  const out: Array<{ id: string; name: string }> = [];
  for (const u of users.slice(0, 50)) {
    let name = u.email ?? `User ${String(u.id)}`;
    try {
      const tenants = toArray<Json>(await dsGet(http, cfg, `users/${encodeURIComponent(String(u.id))}/tenants`, u.authentication_token ?? cfg.accessToken), ['data']);
      const domains = tenants.map((t) => (typeof t['domain'] === 'string' ? (t['domain'] as string) : '')).filter(Boolean);
      if (domains.length > 0) name = `${domains.join(', ')} (${String(u.id)})`;
    } catch {
      // fall back to the email label
    }
    out.push({ id: String(u.id), name });
  }
  return out;
}

export interface DropsuiteAccountRow {
  email?: string;
  last_backup?: string | null;
  current_backup_status?: string;
  errors?: Record<string, unknown> | string;
  deactivated_since?: string | null;
  flg_deleted?: boolean;
  /** Bytes of backed-up data for this mailbox. */
  storage?: number;
  /** Emails protected in this mailbox. */
  msg_count?: number | null;
  /** Owning tenant user — carries the seat counters. */
  user?: { seats_used?: number; seats_available?: number; archive?: boolean } | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const toGb = (bytes: number) => round1(bytes / 1024 ** 3);
const STALE_DAYS = 7;

/** Normalize per-account backup rows into seat + health metrics (with drill-down). */
export function normalizeDropsuiteAccounts(rows: DropsuiteAccountRow[], now = Date.now()): MetricValue[] {
  const active = rows.filter((r) => r.flg_deleted !== true && !r.deactivated_since);
  const withErrors = active.filter((r) => {
    if (typeof r.errors === 'string') return r.errors.trim() !== '';
    return r.errors !== undefined && r.errors !== null && Object.keys(r.errors).length > 0;
  });
  const details = active.slice(0, 100).map((r) => ({
    mailbox: r.email ?? '',
    status: r.current_backup_status ?? '',
    lastBackup: (r.last_backup ?? '').slice(0, 10),
    emails: r.msg_count ?? 0,
    dataGb: typeof r.storage === 'number' ? toGb(r.storage) : 0,
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
  // Mailboxes that have a backup history but haven't completed one recently —
  // the silent-failure case an error object doesn't catch.
  const stale = active.filter((r) => {
    const t = r.last_backup ? Date.parse(r.last_backup) : NaN;
    return Number.isFinite(t) && now - t > STALE_DAYS * 24 * 3600 * 1000;
  });
  if (stale.length > 0) {
    out.push({
      ...metric('backup.stale_mailboxes', `Mailboxes not backed up in ${STALE_DAYS}+ days`, stale.length, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: false }),
      details: stale.slice(0, 100).map((r) => ({ mailbox: r.email ?? '', lastBackup: (r.last_backup ?? '').slice(0, 10) })),
    });
  }
  const bytes = active.reduce((sum, r) => sum + (typeof r.storage === 'number' ? r.storage : 0), 0);
  if (bytes > 0) {
    out.push(metric('backup.email_data_gb', 'Email backup data protected', toGb(bytes), { category: 'backup', source: 'dropsuite', unit: 'GB', higherIsBetter: true }));
  }
  const messages = active.reduce((sum, r) => sum + (typeof r.msg_count === 'number' ? r.msg_count : 0), 0);
  if (messages > 0) {
    out.push(metric('backup.emails_protected', 'Emails protected', messages, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: true }));
  }
  const seats = active.map((r) => r.user?.seats_used).find((v) => typeof v === 'number');
  if (typeof seats === 'number' && seats > 0) {
    out.push(metric('backup.seats_used', 'Backup seats in use', seats, { category: 'backup', source: 'dropsuite', unit: 'count' }));
  }
  return out;
}

interface DropsuiteDriveRow {
  email?: string;
  domain_name?: string;
  site_count?: number;
  file_count?: number;
  storage?: number;
  last_backup?: string | null;
  deactivated_since?: string | null;
}

/** OneDrive backup coverage (GET /onedrives). */
export function normalizeDropsuiteOneDrives(rows: DropsuiteDriveRow[]): MetricValue[] {
  const active = rows.filter((r) => !r.deactivated_since);
  if (active.length === 0) return [];
  const out: MetricValue[] = [
    {
      ...metric('backup.onedrive_accounts', 'OneDrive accounts backed up', active.length, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: true }),
      details: active.slice(0, 100).map((r) => ({
        account: r.email ?? '',
        files: r.file_count ?? 0,
        dataGb: typeof r.storage === 'number' ? toGb(r.storage) : 0,
        lastBackup: (r.last_backup ?? '').slice(0, 10),
      })),
    },
  ];
  const bytes = active.reduce((sum, r) => sum + (typeof r.storage === 'number' ? r.storage : 0), 0);
  if (bytes > 0) out.push(metric('backup.onedrive_data_gb', 'OneDrive backup data', toGb(bytes), { category: 'backup', source: 'dropsuite', unit: 'GB', higherIsBetter: true }));
  return out;
}

/** SharePoint backup coverage (GET /sharepoints/domains). */
export function normalizeDropsuiteSharePoint(rows: DropsuiteDriveRow[]): MetricValue[] {
  const active = rows.filter((r) => !r.deactivated_since);
  if (active.length === 0) return [];
  const sites = active.reduce((sum, r) => sum + (typeof r.site_count === 'number' ? r.site_count : 0), 0);
  if (sites === 0) return [];
  const out: MetricValue[] = [
    {
      ...metric('backup.sharepoint_sites', 'SharePoint sites backed up', sites, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: true }),
      details: active.slice(0, 100).map((r) => ({
        domain: r.domain_name ?? '',
        sites: r.site_count ?? 0,
        files: r.file_count ?? 0,
        dataGb: typeof r.storage === 'number' ? toGb(r.storage) : 0,
      })),
    },
  ];
  const bytes = active.reduce((sum, r) => sum + (typeof r.storage === 'number' ? r.storage : 0), 0);
  if (bytes > 0) out.push(metric('backup.sharepoint_data_gb', 'SharePoint backup data', toGb(bytes), { category: 'backup', source: 'dropsuite', unit: 'GB', higherIsBetter: true }));
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
  const token = user.authentication_token;
  let rows: DropsuiteAccountRow[] = [];
  try {
    rows = toArray<DropsuiteAccountRow>(await dsGet(http, cfg, 'accounts', token), ['accounts']);
  } catch (e) {
    return { source: 'dropsuite', metrics: [], warnings: [`Dropsuite accounts unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
  if (rows.length === 0) warnings.push('Dropsuite returned no backed-up accounts for this tenant.');
  const metrics = normalizeDropsuiteAccounts(rows);

  // Not every tenant licenses every product — a 403/404 here just means "not
  // backed up with Dropsuite", so only real failures become warnings.
  const optional = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      if (!/responded (403|404)/.test(msg)) warnings.push(`Dropsuite ${label} unavailable: ${msg}`);
    }
  };

  await optional('connection failures', async () => {
    const failures = toArray<DropsuiteAccountRow>(await dsGet(http, cfg, 'accounts/connection_failures', token), ['result_set']);
    if (failures.length > 0) {
      metrics.push({
        ...metric('backup.connection_failures', 'Mailboxes with connection failures', failures.length, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter: false }),
        details: failures.slice(0, 100).map((r) => ({ mailbox: r.email ?? '', lastBackup: (r.last_backup ?? '').slice(0, 10) })),
      });
    }
  });
  await optional('OneDrive backups', async () => {
    metrics.push(...normalizeDropsuiteOneDrives(await dsPageAll(http, cfg, 'onedrives', token)));
  });
  await optional('SharePoint backups', async () => {
    metrics.push(...normalizeDropsuiteSharePoint(await dsPageAll(http, cfg, 'sharepoints/domains', token)));
  });

  return { source: 'dropsuite', metrics, warnings };
}

/** Page through a 25-per-page Dropsuite list endpoint (capped). */
async function dsPageAll<T>(http: HttpTransport, cfg: DropsuiteCfg, path: string, token: string, maxPages = 40): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = toArray<T>(await dsGet(http, cfg, path, token, { page }), ['result_set', 'data']);
    out.push(...rows);
    if (rows.length < 25) break;
  }
  return out;
}
