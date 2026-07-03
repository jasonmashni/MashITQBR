import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * ConnectSecure (CyberCNS) vulnerability-management client. Auth is per-tenant
 * client_id/client_secret exchanged for a bearer token; companies are the org
 * unit. The QBR signals — open critical/high vulnerabilities and the compliance
 * score — feed the maturity scorecard's Identify function and the flags system.
 */

export interface ConnectSecureCfg {
  /** Pod/instance base URL, e.g. https://pod<id>.myconnectsecure.com */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** ConnectSecure tenant name (multi-tenant pods). */
  tenant?: string;
}

type Json = Record<string, unknown>;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function connectSecureToken(http: HttpTransport, cfg: ConnectSecureCfg): Promise<string> {
  const key = `${cfg.baseUrl}|${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await http.request({
    method: 'POST',
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/api/v4/auth/token`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...(cfg.tenant ? { tenant: cfg.tenant } : {}) }),
  });
  const json = (res.json ?? {}) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : typeof json['token'] === 'string' ? (json['token'] as string) : '';
  if (res.status < 200 || res.status >= 300 || !token) throw new Error(`ConnectSecure token exchange failed (${res.status})`);
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function csGet(http: HttpTransport, cfg: ConnectSecureCfg, path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const token = await connectSecureToken(http, cfg);
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v4/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`ConnectSecure responded ${res.status} for /api/v4/${path}`);
  return res.json;
}

/** Companies in this ConnectSecure tenant (drives org mapping). */
export async function listConnectSecureCompanies(http: HttpTransport, cfg: ConnectSecureCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await csGet(http, cfg, 'companies', { limit: 500 });
  return toArray<Json>(json, ['companies', 'rows'])
    .filter((c) => c['id'] !== undefined)
    .map((c) => ({ id: String(c['id']), name: typeof c['name'] === 'string' ? c['name'] : `Company ${String(c['id'])}` }));
}

export interface ConnectSecureStats {
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  assets?: number;
  compliance_score?: number;
}

/** Normalize a company's vulnerability stats into scorecard-ready metrics. */
export function normalizeConnectSecureStats(s: ConnectSecureStats): MetricValue[] {
  const out: MetricValue[] = [];
  const sec = (k: string, l: string, v: number | undefined, higherIsBetter = false) => {
    if (typeof v === 'number') out.push(metric(k, l, v, { category: 'security', source: 'connectsecure', unit: 'count', higherIsBetter }));
  };
  sec('vuln.critical', 'Critical vulnerabilities', s.critical);
  sec('vuln.high', 'High vulnerabilities', s.high);
  sec('vuln.medium', 'Medium vulnerabilities', s.medium);
  if (typeof s.assets === 'number') {
    out.push(metric('vuln.scanned_assets', 'Assets scanned', s.assets, { category: 'security', source: 'connectsecure', unit: 'count' }));
  }
  if (typeof s.compliance_score === 'number') {
    out.push(metric('vuln.compliance_score', 'Vulnerability compliance score', s.compliance_score, { category: 'security', source: 'connectsecure', unit: '%', higherIsBetter: true }));
  }
  return out;
}

/** Tolerantly pluck severity counts from whatever stats shape the pod returns. */
export function extractConnectSecureStats(json: unknown): ConnectSecureStats {
  const root = (json ?? {}) as Json;
  const data = (root['data'] ?? root['stats'] ?? root) as Json;
  const sev = (data['severity'] ?? data['vulnerabilities'] ?? data) as Json;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    critical: n(sev['critical'] ?? sev['CRITICAL']),
    high: n(sev['high'] ?? sev['HIGH']),
    medium: n(sev['medium'] ?? sev['MEDIUM']),
    low: n(sev['low'] ?? sev['LOW']),
    assets: n(data['assets'] ?? data['total_assets'] ?? data['asset_count']),
    compliance_score: n(data['compliance_score'] ?? data['score']),
  };
}

/** Collect ConnectSecure vulnerability posture for a company. */
export async function collectConnectSecure(ctx: CollectorContext, http: HttpTransport, cfg: ConnectSecureCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'connectsecure', metrics: [], warnings: ['No ConnectSecure company mapped for this client.'] };
  }
  try {
    const json = await csGet(http, cfg, `companies/${encodeURIComponent(ctx.externalRef)}/stats`, {});
    const metrics = normalizeConnectSecureStats(extractConnectSecureStats(json));
    const warnings = metrics.length ? [] : ['ConnectSecure returned no vulnerability stats for this company.'];
    return { source: 'connectsecure', metrics, warnings };
  } catch (e) {
    return { source: 'connectsecure', metrics: [], warnings: [`ConnectSecure unavailable: ${e instanceof Error ? e.message : 'error'}`] };
  }
}
