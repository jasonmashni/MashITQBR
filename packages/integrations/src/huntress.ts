import type { MetricValue } from '@mashit/core';
import { basicAuthHeader } from './transport.js';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';

/**
 * Subset of the Huntress Organization object we read. The Organization API
 * returns product-segmented rollups (EDR / SIEM / ITDR / SAT). Fields are read
 * defensively because the public API is in beta and shapes may shift.
 */
export interface HuntressOrg {
  id?: number | string;
  name?: string;
  stats?: {
    edr?: { agents_total?: number; agents_unresponsive?: number; agents_outdated?: number };
    itdr?: { identities?: number };
    siem?: { events?: number; storage_bytes?: number };
  };
}

export interface HuntressIncident {
  id: number | string;
  severity?: string;
  status?: string;
  sent_at?: string;
}

/** Normalize Huntress org rollups + in-period incidents into canonical metrics. */
export function normalizeHuntress(org: HuntressOrg, incidents: HuntressIncident[]): MetricValue[] {
  const out: MetricValue[] = [];
  const sec = (k: string, l: string, v: MetricValue['value'], higherIsBetter?: boolean) =>
    out.push(metric(k, l, v, { category: 'security', source: 'huntress', unit: 'count', higherIsBetter }));

  const edr = org.stats?.edr;
  if (typeof edr?.agents_total === 'number') sec('huntress.endpoints', 'Protected endpoints', edr.agents_total);
  if (typeof org.stats?.itdr?.identities === 'number')
    sec('huntress.identities', 'Protected identities', org.stats.itdr.identities);
  if (typeof org.stats?.siem?.events === 'number')
    out.push(metric('huntress.siem_logs', 'SIEM logs ingested', org.stats.siem.events, { category: 'security', source: 'huntress', unit: 'events' }));

  // Incidents are date-filtered by the API; count them for the period.
  sec('huntress.edr_incidents', 'EDR incidents', incidents.length, false);

  return out;
}

/** Warnings about Huntress data the public API does not expose (per research). */
export const HUNTRESS_GAPS = [
  'Huntress API does not expose ransomware-canary status, Managed AV, or per-learner SAT/phishing-sim results — enter manually or via CSV import.',
];

/**
 * Collect Huntress metrics for a client. Requires the org externalRef and a
 * key/secret pair (Basic auth). Network shape is best-effort; normalize is the
 * tested unit.
 */
export async function collectHuntress(
  ctx: CollectorContext,
  http: HttpTransport,
  cfg: { baseUrl?: string; apiKey: string; apiSecret: string },
): Promise<CollectResult> {
  const warnings = [...HUNTRESS_GAPS];
  if (!ctx.externalRef) {
    return { source: 'huntress', metrics: [], warnings: [...warnings, 'No Huntress organization mapped for this client.'] };
  }
  const base = cfg.baseUrl ?? 'https://api.huntress.io/v1';
  const headers = { Authorization: basicAuthHeader(cfg.apiKey, cfg.apiSecret), Accept: 'application/json' };

  const orgRes = await http.request({ method: 'GET', url: `${base}/organizations/${ctx.externalRef}`, headers });
  const incRes = await http.request({
    method: 'GET',
    url: `${base}/incident_reports?organization_id=${ctx.externalRef}&occurred_at_min=${ctx.period.start}&occurred_at_max=${ctx.period.end}`,
    headers,
  });

  const org = (orgRes.json ?? {}) as HuntressOrg;
  const incidents = extractList<HuntressIncident>(incRes.json);
  return { source: 'huntress', metrics: normalizeHuntress(org, incidents), warnings };
}

/** Huntress list endpoints wrap results; tolerate `{...}[]` or `{data|incident_reports: [...]}`. */
function extractList<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['incident_reports', 'data', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}
