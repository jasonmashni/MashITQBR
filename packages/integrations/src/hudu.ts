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
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v1/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { 'x-api-key': cfg.apiKey, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`Hudu responded ${res.status} for /api/v1/${path}`);
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
  let expiringSoon = 0;
  for (const r of rows) {
    const at = r.date ? Date.parse(r.date) : NaN;
    if (!Number.isFinite(at)) continue;
    const type = (r.expiration_type ?? '').toLowerCase();
    if (at < now && type.includes('warranty')) warrantyExpired++;
    else if (at >= now && at <= soon) expiringSoon++;
  }
  const infra = (k: string, l: string, v: number) =>
    metric(k, l, v, { category: 'infrastructure', source: 'hudu', unit: 'count', higherIsBetter: false });
  return [infra('assets.warranty_expired', 'Assets out of warranty', warrantyExpired), infra('assets.expiring_90d', 'Expirations in next 90 days', expiringSoon)];
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

  return { source: 'hudu', metrics, warnings };
}
