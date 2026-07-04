import type { MetricValue } from '@mashit/core';
import { basicAuthHeader } from './transport.js';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';

/**
 * Huntress collector built on the real API (api.huntress.io/v1, swagger-verified):
 * - `GET /reports?organization_id&type=quarterly_summary&period_min/max` — the
 *   QBR goldmine: per-org quarterly rollups of incidents, signals, agents,
 *   canaries, external recon, firewall posture, MAV, ITDR, and SIEM.
 * - `GET /organizations/{id}` — `actual_usages` per product (EDR agent health,
 *   SAT learners, ITDR identities, SIEM volume).
 * - `GET /identities?organization_id` — per-identity `mfa_enabled` → real MFA
 *   coverage for the maturity scorecard.
 * Pagination is `page_token`/`next_page_token` based; rate limit 60 req/min.
 */

/** Subset of the Huntress SummaryReport model we map into metrics. */
export interface HuntressSummaryReport {
  id?: number;
  type?: string;
  period?: string;
  agents_count?: number;
  windows_agent_count?: number;
  macos_agent_count?: number;
  servers_agent_count?: number;
  incidents_reported?: number;
  incidents_resolved?: number;
  signals_detected?: number;
  signals_investigated?: number;
  investigations_completed?: number;
  deployed_canaries_count?: number;
  external_ports_count?: number;
  risky_services_count?: number;
  firewall_enabled_count?: number;
  firewall_disabled_count?: number;
  blocked_malware_count?: number;
  total_mav_detection_count?: number;
  itdr_signals?: number;
  itdr_incidents_reported?: number;
  siem_ingested_logs?: number;
  siem_signals?: number;
  url?: string;
}

/** actual_usages from GET /organizations/{id}. */
export interface HuntressUsages {
  edr?: { billable_agents_count?: number; unresponsive_agents_count?: number; outdated_agents_count?: number; isolated_agents_count?: number };
  sat?: { learners_count?: number };
  itdr?: Array<{ billable_identities_count?: number; total_identities_count?: number }>;
  siem?: { current_billing_cycle?: { online_gb?: number } };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Map a Huntress summary report into canonical metrics. */
export function normalizeHuntressSummary(r: HuntressSummaryReport): MetricValue[] {
  const out: MetricValue[] = [];
  const sec = (k: string, l: string, v: number | undefined, higherIsBetter?: boolean, unit = 'count') => {
    if (typeof v === 'number') out.push(metric(k, l, v, { category: 'security', source: 'huntress', unit, higherIsBetter }));
  };

  sec('huntress.endpoints', 'Protected endpoints', r.agents_count);
  sec('huntress.edr_incidents', 'Incidents reported', r.incidents_reported, false);
  sec('huntress.incidents_resolved', 'Incidents resolved', r.incidents_resolved, true);
  sec('huntress.signals', 'Signals detected', r.signals_detected);
  sec('huntress.investigations', 'SOC investigations completed', r.investigations_completed, true);
  sec('huntress.canaries', 'Ransomware canaries deployed', r.deployed_canaries_count, true);
  sec('huntress.blocked_malware', 'Malware blocked', r.blocked_malware_count, true);
  sec('huntress.mav_detections', 'Managed AV detections', r.total_mav_detection_count);
  sec('huntress.identity_compromises', 'Identity (ITDR) incidents', r.itdr_incidents_reported, false);
  sec('huntress.itdr_signals', 'Identity signals', r.itdr_signals);
  if (typeof r.siem_ingested_logs === 'number') {
    out.push(metric('huntress.siem_logs', 'SIEM logs ingested', r.siem_ingested_logs, { category: 'security', source: 'huntress', unit: 'events' }));
  }
  sec('recon.risky_services', 'Risky exposed services', r.risky_services_count, false);
  if (typeof r.external_ports_count === 'number') {
    out.push(metric('recon.external_ports', 'External ports discovered', r.external_ports_count, { category: 'infrastructure', source: 'huntress', unit: 'count' }));
  }
  const fwOn = r.firewall_enabled_count;
  const fwOff = r.firewall_disabled_count;
  if (typeof fwOn === 'number' && typeof fwOff === 'number' && fwOn + fwOff > 0) {
    sec('endpoints.firewall_enabled_pct', 'Host firewall enabled', round1((100 * fwOn) / (fwOn + fwOff)), true, '%');
  }
  return out;
}

/** Map org actual_usages into metrics. */
export function normalizeHuntressUsage(u: HuntressUsages): MetricValue[] {
  const out: MetricValue[] = [];
  if (typeof u.edr?.unresponsive_agents_count === 'number') {
    out.push(metric('endpoints.unresponsive', 'Unresponsive agents', u.edr.unresponsive_agents_count, { category: 'security', source: 'huntress', unit: 'count', higherIsBetter: false }));
  }
  if (typeof u.edr?.outdated_agents_count === 'number') {
    out.push(metric('endpoints.agents_outdated', 'Outdated agents', u.edr.outdated_agents_count, { category: 'security', source: 'huntress', unit: 'count', higherIsBetter: false }));
  }
  if (typeof u.sat?.learners_count === 'number') {
    out.push(metric('sat.learners', 'Security awareness learners', u.sat.learners_count, { category: 'security', source: 'huntress', unit: 'count' }));
  }
  const identities = (u.itdr ?? []).reduce((sum, t) => sum + (t.billable_identities_count ?? 0), 0);
  if (identities > 0) {
    out.push(metric('identity.protected', 'Protected identities', identities, { category: 'identity', source: 'huntress', unit: 'count' }));
  }
  if (typeof u.siem?.current_billing_cycle?.online_gb === 'number') {
    out.push(metric('siem.online_gb', 'SIEM data (billing cycle)', u.siem.current_billing_cycle.online_gb, { category: 'security', source: 'huntress', unit: 'GB' }));
  }
  return out;
}

export interface HuntressIdentity {
  email?: string;
  mfa_enabled?: boolean;
  enabled?: boolean;
  billable?: boolean;
  licensed?: boolean;
}

/**
 * Scope identities to the ones an executive MFA number should describe:
 * enabled, licensed/billable when the API exposes such a flag, and belonging
 * to the organization's DOMINANT email domain — tenants accumulate guest and
 * external identities that make raw coverage misleading (a "54% MFA" that is
 * really 95% of actual staff).
 */
export function scopeHuntressIdentities<T extends HuntressIdentity>(identities: T[]): T[] {
  let active = identities.filter((i) => i.enabled !== false);
  const hasLicenseFlag = active.some((i) => typeof i.billable === 'boolean' || typeof i.licensed === 'boolean');
  if (hasLicenseFlag) active = active.filter((i) => i.billable === true || i.licensed === true);
  const counts = new Map<string, number>();
  for (const i of active) {
    const domain = (i.email ?? '').split('@')[1]?.toLowerCase();
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return dominant ? active.filter((i) => (i.email ?? '').toLowerCase().endsWith(`@${dominant}`)) : active;
}

/** MFA coverage from per-identity records (null when none). */
export function mfaCoveragePct(identities: Array<{ mfa_enabled?: boolean; enabled?: boolean }>): number | null {
  const active = identities.filter((i) => i.enabled !== false);
  if (active.length === 0) return null;
  return round1((100 * active.filter((i) => i.mfa_enabled === true).length) / active.length);
}

/** Data the Huntress API genuinely does not expose (keep the QBR honest). */
export const HUNTRESS_GAPS = [
  'Huntress does not expose per-learner SAT completion % or phishing-sim results via API — enter manually if you want them in the QBR.',
];

type Json = Record<string, unknown>;

async function getJson(http: HttpTransport, url: string, headers: Record<string, string>): Promise<Json> {
  const res = await http.request({ method: 'GET', url, headers });
  if (res.status < 200 || res.status >= 300) throw new Error(`Huntress responded ${res.status} for ${new URL(url).pathname}`);
  return (res.json ?? {}) as Json;
}

/** Follow page_token pagination collecting `key` arrays (capped). */
async function pageAll<T>(http: HttpTransport, baseUrl: string, headers: Record<string, string>, key: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}limit=500${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
    const json = await getJson(http, url, headers);
    const rows = Array.isArray(json[key]) ? (json[key] as T[]) : [];
    out.push(...rows);
    const next = (json['pagination'] as Json | undefined)?.['next_page_token'];
    if (!next || rows.length === 0) break;
    token = String(next);
  }
  return out;
}

/** Collect Huntress metrics for a client for the period. */
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
  const org = encodeURIComponent(ctx.externalRef);
  const metrics: MetricValue[] = [];
  const documents: Array<{ name: string; url: string }> = [];

  // 1) Quarterly summary report for the period (fallback: newest monthly in-period).
  try {
    const reportsUrl = `${base}/reports?organization_id=${org}&period_min=${ctx.period.start}&period_max=${ctx.period.end}`;
    let reports = await pageAll<HuntressSummaryReport>(http, `${reportsUrl}&type=quarterly_summary`, headers, 'reports', 1);
    if (reports.length === 0) {
      reports = await pageAll<HuntressSummaryReport>(http, `${reportsUrl}&type=monthly_summary`, headers, 'reports', 1);
      if (reports.length > 0) warnings.push('No Huntress quarterly summary for this period yet — using the latest monthly summary.');
    }
    const report = reports[0];
    if (report) {
      metrics.push(...normalizeHuntressSummary(report));
      // Huntress publishes the rendered summary PDF at report.url — attach it to the QBR.
      if (typeof report.url === 'string' && report.url) {
        documents.push({ name: `Huntress ${report.type ?? 'summary'} ${ctx.period.id}.pdf`, url: report.url });
      }
    } else warnings.push('No Huntress summary report found for this period (they generate after the period closes).');
  } catch (e) {
    warnings.push(`Huntress summary reports unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // 2) Current product usage (agent health, SAT learners, ITDR identities, SIEM volume).
  try {
    const orgJson = await getJson(http, `${base}/organizations/${org}`, headers);
    const usages = ((orgJson['organization'] as Json | undefined)?.['actual_usages'] ?? orgJson['actual_usages']) as HuntressUsages | undefined;
    if (usages) metrics.push(...normalizeHuntressUsage(usages));
  } catch (e) {
    warnings.push(`Huntress organization usage unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // 3) MFA coverage from identities (feeds the scorecard's Identity function).
  // Scoped to licensed identities on the org's dominant domain — the raw
  // tenant list includes guests/externals that make the number misleading.
  try {
    const identities = await pageAll<HuntressIdentity>(http, `${base}/identities?organization_id=${org}`, headers, 'identities');
    const scoped = scopeHuntressIdentities(identities);
    const pct = mfaCoveragePct(scoped);
    if (pct !== null) {
      const details = scoped
        .slice(0, 100)
        .map((i) => ({ identity: i.email ?? '', mfa: i.mfa_enabled === true ? 'yes' : 'NO' }))
        .sort((a, b) => a.mfa.localeCompare(b.mfa)); // the gaps float to the top
      metrics.push({
        ...metric('identity.mfa_coverage_pct', 'MFA coverage (licensed users)', pct, { category: 'identity', source: 'huntress', unit: '%', higherIsBetter: true }),
        details,
      });
      if (scoped.length < identities.length) {
        warnings.push(`MFA coverage scoped to ${scoped.length} licensed primary-domain identities (of ${identities.length} in the tenant).`);
      }
    }
  } catch (e) {
    warnings.push(`Huntress identities unavailable (MFA coverage skipped): ${e instanceof Error ? e.message : 'error'}`);
  }

  if (metrics.length === 0) warnings.push('Huntress returned no usable data for this organization.');
  return { source: 'huntress', metrics, warnings, documents };
}
