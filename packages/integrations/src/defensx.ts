import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * DefensX Partner API collector (web security / DNS filtering / phishing &
 * credential protection / Remote Browser Isolation).
 *
 * Auth is a Bearer API token (generated on the DefensX portal's API Keys page);
 * data lives under `{baseUrl}/…` where baseUrl defaults to the partner v1 root.
 * A client maps to a DefensX **customer id** (externalRef). Field names aren't
 * documented per-metric, so normalizers read tolerantly from candidate fields
 * and warn (naming what they saw) when a value can't be resolved — the first
 * live sync then tells us exactly what to tune.
 */

export interface DefensxCfg {
  /** Partner API root, e.g. https://cloud.defensx.com/api/partner/v1 */
  baseUrl?: string;
  /** Bearer API token from the DefensX portal. */
  token: string;
}

type Json = Record<string, unknown>;

export const DEFENSX_BASE = 'https://cloud.defensx.com/api/partner/v1';

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const firstNum = (row: Json, keys: string[]): number | undefined => {
  for (const k of keys) {
    const n = num(row[k]);
    if (n !== undefined) return n;
  }
  return undefined;
};
const firstStr = (row: Json, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
};

/** Authenticated GET against `{baseUrl}/{path}` with query params. */
export async function defensxGet(http: HttpTransport, cfg: DefensxCfg, path: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
  const base = (cfg.baseUrl?.replace(/\/+$/, '') || DEFENSX_BASE).replace(/\/+$/, '');
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = `${base}/${path.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`DefensX responded ${res.status} for /${path}`);
  return res.json;
}

/** Extract a list from a DefensX response (bare array or a `{data|items|…}` envelope). */
function list(json: unknown, extraKeys: string[] = []): Json[] {
  return toArray<Json>(json, ['data', 'items', 'results', 'records', ...extraKeys]);
}

/** The paginated total when present, else the row count. */
function totalOf(json: unknown, rows: unknown[]): number {
  const p = (json as { pagination?: Json } | null)?.pagination;
  const t = p ? firstNum(p, ['total', 'total_count', 'totalCount', 'count', 'total_items']) : undefined;
  return t ?? rows.length;
}

export interface DefensxCustomerRow {
  id?: number | string;
  name?: string;
  company_name?: string;
}

/** All customers under the partner account (drives mapping + the connection test). */
export async function listDefensxCustomers(http: HttpTransport, cfg: DefensxCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await defensxGet(http, cfg, 'customers', { limit: 500 });
  return list(json, ['customers'])
    .filter((c) => c['id'] !== undefined && c['id'] !== null)
    .map((c) => ({ id: String(c['id']), name: firstStr(c, ['name', 'company_name', 'title']) ?? `Customer ${String(c['id'])}` }));
}

// ── Normalizer (pure — fixture-tested) ───────────────────────────────────────

const DETAIL_CAP = 50;
const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
type DetailRow = Record<string, string | number>;

const SCORE_FIELDS = ['score', 'cyber_resilience_score', 'cyberResilienceScore', 'resilience_score', 'resilienceScore', 'value'];
const RISKY_USER_ARRAYS = ['risky_users', 'riskyUsers', 'top_risky_users', 'topRiskyUsers', 'users', 'top10', 'risky_users_top10'];
const USER_NAME_FIELDS = ['name', 'email', 'username', 'user', 'display_name', 'user_email', 'userName'];
const USER_SCORE_FIELDS = ['score', 'risk_score', 'riskScore', 'risk', 'value'];
const EXT_NAME_FIELDS = ['name', 'title', 'extension_name', 'extensionName', 'display_name'];
const EXT_REP_FIELDS = ['reputation', 'reputation_score', 'reputationScore', 'score', 'rating'];
const STAT_NAME_FIELDS = ['hostname', 'host', 'name', 'category', 'category_name', 'categoryName', 'domain', 'url'];
const STAT_COUNT_FIELDS = ['count', 'hits', 'total', 'requests', 'value', 'visits'];
const STAT_RATIO_FIELDS = ['ratio', 'percentage', 'percent', 'pct'];

export interface DefensxRaw {
  cyberResilience?: unknown;
  users?: unknown;
  lowRepExtensions?: unknown;
  blockedHostnames?: unknown;
  credentialsBlocked?: unknown;
}

/** Turn the raw DefensX responses into normalized QBR metrics + coverage warnings. */
export function normalizeDefensx(raw: DefensxRaw): { metrics: MetricValue[]; warnings: string[] } {
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];
  const sec = (key: string, label: string, value: number, higherIsBetter?: boolean, details?: DetailRow[]): MetricValue =>
    metric(key, label, value, { category: 'security', source: 'defensx', unit: 'count', higherIsBetter, details });

  // ── Cyber resilience score + top risky users (the flagship posture metric).
  if (raw.cyberResilience && typeof raw.cyberResilience === 'object') {
    const cr = raw.cyberResilience as Json;
    // The score may sit on the object or on a nested summary.
    const summary = (cr['summary'] && typeof cr['summary'] === 'object' ? (cr['summary'] as Json) : cr) as Json;
    const score = firstNum(summary, SCORE_FIELDS) ?? firstNum(cr, SCORE_FIELDS);
    if (score !== undefined) {
      metrics.push(metric('security.cyber_resilience_score', 'Cyber resilience score', Math.round(score * 10) / 10, {
        category: 'security',
        source: 'defensx',
        unit: '',
        higherIsBetter: true,
      }));
    } else {
      warnings.push(`DefensX cyber-resilience score not recognized (fields seen: ${Object.keys(cr).slice(0, 15).join(', ') || 'none'}).`);
    }
    let riskyRows: Json[] = [];
    for (const k of RISKY_USER_ARRAYS) {
      if (Array.isArray(cr[k])) {
        riskyRows = cr[k] as Json[];
        break;
      }
    }
    if (riskyRows.length > 0) {
      const details: DetailRow[] = riskyRows.slice(0, DETAIL_CAP).map((u) => {
        const s = firstNum(u, USER_SCORE_FIELDS);
        return { user: clip(firstStr(u, USER_NAME_FIELDS) ?? '—'), ...(s !== undefined ? { score: Math.round(s * 10) / 10 } : {}) };
      });
      metrics.push(sec('security.risky_users', 'Risky users', riskyRows.length, false, details));
    }
  }

  // ── Protected users (coverage).
  if (raw.users !== undefined) {
    const rows = list(raw.users, ['users']);
    const count = totalOf(raw.users, rows);
    if (count > 0 || rows.length > 0) {
      metrics.push(metric('identity.protected_users', 'Protected users (DefensX)', count, { category: 'identity', source: 'defensx', unit: 'count', higherIsBetter: true }));
    }
  }

  // ── Low-reputation browser extensions (a real risk signal).
  if (raw.lowRepExtensions !== undefined) {
    const rows = list(raw.lowRepExtensions, ['browser_extensions', 'extensions']);
    if (rows.length > 0 || totalOf(raw.lowRepExtensions, rows) > 0) {
      const total = totalOf(raw.lowRepExtensions, rows);
      const details: DetailRow[] = rows.slice(0, DETAIL_CAP).map((e) => {
        const rep = firstNum(e, EXT_REP_FIELDS);
        return { extension: clip(firstStr(e, EXT_NAME_FIELDS) ?? '—'), ...(rep !== undefined ? { reputation: rep } : {}) };
      });
      metrics.push(sec('security.risky_browser_extensions', 'Risky browser extensions', total, false, details));
    }
  }

  // ── Top blocked malicious sites + credential-theft sites blocked. These are
  // "top N" stat lists; the metric sums per-entry hit counts when present (a
  // real "events blocked" number), else falls back to the count of sites. The
  // drill-down always carries the list.
  const stat = (raw: unknown, key: string, label: string): MetricValue | undefined => {
    if (raw === undefined) return undefined;
    const rows = list(raw, ['hostnames', 'stats', 'items', 'categories']);
    if (rows.length === 0) return undefined;
    let hits = 0;
    let sawHits = false;
    const details: DetailRow[] = rows.slice(0, DETAIL_CAP).map((r) => {
      const c = firstNum(r, STAT_COUNT_FIELDS);
      const ratio = firstNum(r, STAT_RATIO_FIELDS);
      if (c !== undefined) {
        hits += c;
        sawHits = true;
      }
      return {
        site: clip(firstStr(r, STAT_NAME_FIELDS) ?? '—'),
        ...(c !== undefined ? { count: c } : {}),
        ...(ratio !== undefined ? { share: `${Math.round(ratio * 10) / 10}%` } : {}),
      };
    });
    return sec(key, label, sawHits ? hits : rows.length, false, details);
  };
  const blocked = stat(raw.blockedHostnames, 'security.web_threats_blocked', 'Malicious sites blocked (top)');
  if (blocked) metrics.push(blocked);
  const creds = stat(raw.credentialsBlocked, 'security.credential_theft_blocked', 'Credential-theft sites blocked (top)');
  if (creds) metrics.push(creds);

  return { metrics, warnings };
}

/**
 * Collect DefensX metrics for a client/period: the cyber-resilience score + top
 * risky users, protected-user count, risky browser extensions, and blocked
 * malicious/credential-theft sites. Each endpoint is tolerated independently so
 * one failure doesn't sink the rest.
 */
export async function collectDefensx(ctx: CollectorContext, http: HttpTransport, cfg: DefensxCfg): Promise<CollectResult> {
  const customerId = (ctx.externalRef ?? '').trim();
  if (!customerId) {
    return { source: 'defensx', metrics: [], warnings: ['No DefensX customer mapped for this client.'] };
  }
  if (!cfg.token) {
    return { source: 'defensx', metrics: [], warnings: ['DefensX API token missing on the connection.'] };
  }
  const warnings: string[] = [];
  const raw: DefensxRaw = {};

  // Cyber resilience is scoped to a date range.
  try {
    raw.cyberResilience = await defensxGet(http, cfg, `customers/${customerId}/cyber_resilience`, { from: ctx.period.start, to: ctx.period.end });
  } catch (e) {
    warnings.push(`DefensX cyber resilience unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    raw.users = await defensxGet(http, cfg, `customers/${customerId}/users`, { limit: 500 });
  } catch (e) {
    warnings.push(`DefensX users unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    raw.lowRepExtensions = await defensxGet(http, cfg, `customers/${customerId}/browser_extensions/low_reputation`, { limit: 500 });
  } catch (e) {
    warnings.push(`DefensX browser extensions unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    raw.blockedHostnames = await defensxGet(http, cfg, `customers/${customerId}/stats/blocked_hostnames`, { from: ctx.period.start, to: ctx.period.end });
  } catch (e) {
    warnings.push(`DefensX blocked-hostname stats unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    raw.credentialsBlocked = await defensxGet(http, cfg, `customers/${customerId}/stats/credentials_blocked`, { from: ctx.period.start, to: ctx.period.end });
  } catch (e) {
    warnings.push(`DefensX credential-block stats unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  const out = normalizeDefensx(raw);
  return { source: 'defensx', metrics: out.metrics, warnings: [...warnings, ...out.warnings] };
}
