import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * Direct Hudu API client. Auth is a static `x-api-key` header; data lives
 * under `{baseUrl}/api/v1`. The QBR-grade signals are the documentation
 * footprint (assets) and the expirations register (warranty / domain / SSL),
 * which feed the infrastructure-refresh section of the report.
 */

export interface HuduCfg {
  /** Instance base URL, e.g. https://mashit.huducloud.com */
  baseUrl: string;
  apiKey: string;
}

type Json = Record<string, unknown>;

async function huduGet(http: HttpTransport, cfg: HuduCfg, path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  // Tolerate a base URL pasted with the API path already on it.
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  const url = `${base}/api/v1/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { 'x-api-key': cfg.apiKey.trim(), Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) {
    const hint =
      res.status === 401
        ? ' — a 401 from Hudu means the API key is wrong, revoked, or lacks access: in Hudu go to Admin → API Keys, create a key (no extra permissions needed for read), and paste it exactly.'
        : '';
    throw new Error(`Hudu responded ${res.status} for /api/v1/${path}${hint}`);
  }
  return res.json;
}

/** Companies in this Hudu instance (drives org mapping). */
export async function listHuduCompanies(http: HttpTransport, cfg: HuduCfg): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const json = await huduGet(http, cfg, 'companies', { page, page_size: 100 });
    const rows = toArray<Json>(json, ['companies']);
    for (const r of rows) {
      if (r['id'] !== undefined) out.push({ id: String(r['id']), name: typeof r['name'] === 'string' ? r['name'] : `Company ${String(r['id'])}` });
    }
    if (rows.length < 100) break;
  }
  return out;
}

export interface HuduExpiration {
  expiration_type?: string; // domain | ssl_certificate | warranty | asset_field | article_expiration
  date?: string;
}

/** Count expirations by type, split into already-expired vs upcoming (≤90 days). */
export function normalizeHuduExpirations(rows: HuduExpiration[], now: number): MetricValue[] {
  const soon = now + 90 * 24 * 3600 * 1000;
  let warrantyExpired = 0;
  const upcoming: HuduExpiration[] = [];
  for (const r of rows) {
    const at = r.date ? Date.parse(r.date) : NaN;
    if (!Number.isFinite(at)) continue;
    const type = (r.expiration_type ?? '').toLowerCase();
    if (at < now && type.includes('warranty')) warrantyExpired++;
    else if (at >= now && at <= soon) upcoming.push(r);
  }
  const infra = (k: string, l: string, v: number) =>
    metric(k, l, v, { category: 'infrastructure', source: 'hudu', unit: 'count', higherIsBetter: false });
  return [
    infra('assets.warranty_expired', 'Assets out of warranty', warrantyExpired),
    {
      ...infra('assets.expiring_90d', 'Expirations in next 90 days', upcoming.length),
      // What exactly is expiring (domain / SSL / warranty) and when.
      details: upcoming
        .slice(0, 100)
        .map((r) => ({ type: r.expiration_type ?? '', date: (r.date ?? '').slice(0, 10) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
  ];
}

/** Collect Hudu documentation + expiration metrics for a company. */
export async function collectHudu(ctx: CollectorContext, http: HttpTransport, cfg: HuduCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'hudu', metrics: [], warnings: ['No Hudu company mapped for this client.'] };
  }
  const companyId = ctx.externalRef;
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];

  try {
    const json = await huduGet(http, cfg, `companies/${encodeURIComponent(companyId)}/assets`, { page_size: 1 });
    // Hudu list endpoints don't return totals; fall back to paging the count.
    const first = toArray<Json>(json, ['assets']);
    if (first.length > 0) {
      let count = 0;
      for (let page = 1; page <= 20; page++) {
        const rows = toArray<Json>(await huduGet(http, cfg, `companies/${encodeURIComponent(companyId)}/assets`, { page, page_size: 250 }), ['assets']);
        count += rows.length;
        if (rows.length < 250) break;
      }
      metrics.push(metric('docs.assets', 'Documented assets', count, { category: 'infrastructure', source: 'hudu', unit: 'count' }));
    }
  } catch (e) {
    warnings.push(`Hudu assets unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  try {
    const rows: HuduExpiration[] = [];
    for (let page = 1; page <= 10; page++) {
      const pageRows = toArray<HuduExpiration>(
        await huduGet(http, cfg, 'expirations', { company_id: companyId, page, page_size: 250 }),
        ['expirations'],
      );
      rows.push(...pageRows);
      if (pageRows.length < 250) break;
    }
    metrics.push(...normalizeHuduExpirations(rows, Date.now()));
  } catch (e) {
    warnings.push(`Hudu expirations unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Documentation health: the KB + credential coverage Mash IT maintains for
  // this client. Counts only — never the content.
  const countAll = async (path: string, key: string): Promise<number> => {
    let count = 0;
    for (let page = 1; page <= 20; page++) {
      const rows = toArray<Json>(await huduGet(http, cfg, path, { company_id: companyId, page, page_size: 250 }), [key]);
      count += rows.length;
      if (rows.length < 250) break;
    }
    return count;
  };
  try {
    const articles = await countAll('articles', 'articles');
    if (articles > 0) {
      metrics.push(metric('docs.articles', 'Knowledge-base articles', articles, { category: 'operations', source: 'hudu', unit: 'count', higherIsBetter: true }));
    }
  } catch (e) {
    warnings.push(`Hudu articles unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    const passwords = await countAll('asset_passwords', 'asset_passwords');
    if (passwords > 0) {
      metrics.push(metric('docs.passwords', 'Credentials documented', passwords, { category: 'operations', source: 'hudu', unit: 'count', higherIsBetter: true }));
    }
  } catch {
    // Password reads depend on the key's permissions — stay quiet when denied.
  }

  return { source: 'hudu', metrics, warnings };
}
