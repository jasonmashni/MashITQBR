import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * Dropsuite (email/M365 backup) reseller API client. Auth is a bearer token;
 * the reseller tier is read-only GET. The QBR signals are protected seats and
 * backup health for the mapped organization.
 */

export interface DropsuiteCfg {
  /** API base, e.g. https://api.dropsuite.com */
  baseUrl?: string;
  token: string;
}

type Json = Record<string, unknown>;

const base = (cfg: DropsuiteCfg) => (cfg.baseUrl ?? 'https://api.dropsuite.com').replace(/\/+$/, '');

async function dsGet(http: HttpTransport, cfg: DropsuiteCfg, path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = `${base(cfg)}/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`Dropsuite responded ${res.status} for /${path}`);
  return res.json;
}

/** Organizations under the reseller account (drives org mapping). */
export async function listDropsuiteOrgs(http: HttpTransport, cfg: DropsuiteCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await dsGet(http, cfg, 'organizations', { per_page: 500 });
  return toArray<Json>(json, ['organizations'])
    .filter((o) => o['id'] !== undefined)
    .map((o) => ({
      id: String(o['id']),
      name: typeof o['name'] === 'string' ? o['name'] : typeof o['organization_name'] === 'string' ? (o['organization_name'] as string) : `Org ${String(o['id'])}`,
    }));
}

export interface DropsuiteAccountRow {
  status?: string; // active | suspended | …
  last_backup_status?: string; // success | failed | …
  last_backup_at?: string;
}

/** Normalize per-account backup rows into seat + health metrics. */
export function normalizeDropsuiteAccounts(rows: DropsuiteAccountRow[]): MetricValue[] {
  const bk = (k: string, l: string, v: number, higherIsBetter?: boolean) =>
    metric(k, l, v, { category: 'backup', source: 'dropsuite', unit: 'count', higherIsBetter });
  const active = rows.filter((r) => (r.status ?? 'active').toLowerCase() === 'active');
  const failed = rows.filter((r) => /fail|error/i.test(r.last_backup_status ?? '')).length;
  const out = [bk('backup.protected_accounts', 'Backed-up mailboxes', active.length, true), bk('backup.failed_jobs', 'Failing backups', failed, false)];
  if (rows.length > 0) {
    const pct = Math.round((1000 * (rows.length - failed)) / rows.length) / 10;
    out.push(metric('backup.success_pct', 'Backup success rate', pct, { category: 'backup', source: 'dropsuite', unit: '%', higherIsBetter: true }));
  }
  return out;
}

/** Collect Dropsuite backup posture for an organization. */
export async function collectDropsuite(ctx: CollectorContext, http: HttpTransport, cfg: DropsuiteCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'dropsuite', metrics: [], warnings: ['No Dropsuite organization mapped for this client.'] };
  }
  const warnings: string[] = [];
  const rows: DropsuiteAccountRow[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const json = await dsGet(http, cfg, 'accounts', { organization_id: ctx.externalRef, page, per_page: 500 });
      const pageRows = toArray<DropsuiteAccountRow>(json, ['accounts', 'users']);
      rows.push(...pageRows);
      if (pageRows.length < 500) break;
    }
  } catch (e) {
    return { source: 'dropsuite', metrics: [], warnings: [`Dropsuite accounts unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
  if (rows.length === 0) warnings.push('Dropsuite returned no accounts for this organization.');
  return { source: 'dropsuite', metrics: normalizeDropsuiteAccounts(rows), warnings };
}
