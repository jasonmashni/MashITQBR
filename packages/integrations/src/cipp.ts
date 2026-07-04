import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * CIPP client — Microsoft 365 posture per tenant. Auth is an Entra
 * client-credentials token against the CIPP-API app registration (scope
 * `api://{appId}/.default`); every List* endpoint takes `tenantFilter`
 * (the tenant's default domain). Endpoints per the CIPP OpenAPI spec:
 * ListTenants (mapping), ListMFAUsers, ListUserCounts, ListLicenses,
 * ListConditionalAccessPolicies.
 */

export interface CippCfg {
  /** CIPP instance URL, e.g. https://cipp.mashit.net */
  baseUrl: string;
  /** Entra tenant id (or domain) of the MSP tenant that hosts the app reg. */
  tenantId: string;
  /** CIPP-API app registration (application/client) id. */
  clientId: string;
  clientSecret: string;
  /** Override the token scope (defaults to api://{clientId}/.default). */
  scope?: string;
  /** Test override for the login endpoint. */
  tokenUrl?: string;
}

type Json = Record<string, unknown>;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function cippToken(http: HttpTransport, cfg: CippCfg): Promise<string> {
  const key = `${cfg.baseUrl}|${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: cfg.scope ?? `api://${cfg.clientId}/.default`,
  }).toString();
  const res = await http.request({
    method: 'POST',
    url: cfg.tokenUrl ?? `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const json = (res.json ?? {}) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (res.status < 200 || res.status >= 300 || !token) {
    const detail = typeof json['error_description'] === 'string' ? (json['error_description'] as string).split('\n')[0] : '';
    throw new Error(`CIPP token exchange failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function cippGet(http: HttpTransport, cfg: CippCfg, endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await cippToken(http, cfg);
  const qs = new URLSearchParams(params).toString();
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/${endpoint}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) {
    const hint =
      res.status === 401
        ? ' — a 401 from CIPP usually means the Client ID is not a CIPP-API client: in CIPP go to Application Settings → API clients, create one, and use ITS Application ID + secret (not the CIPP-SAM app registration).'
        : '';
    throw new Error(`CIPP responded ${res.status} for /api/${endpoint}${hint}`);
  }
  return res.json;
}

/** Managed tenants (drives org mapping — id is the default domain). */
export async function listCippTenants(http: HttpTransport, cfg: CippCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await cippGet(http, cfg, 'ListTenants', { AllTenantSelector: 'false' });
  return toArray<Json>(json, ['Results', 'tenants'])
    .filter((t) => typeof t['defaultDomainName'] === 'string')
    .map((t) => ({
      id: t['defaultDomainName'] as string,
      name: typeof t['displayName'] === 'string' ? (t['displayName'] as string) : (t['defaultDomainName'] as string),
    }));
}

const truthy = (v: unknown) => v === true || v === 'true' || v === 'True' || v === 'Yes';
const asNum = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** MFA registration coverage over enabled users (CIPP ListMFAUsers rows). */
export function normalizeCippMfa(rows: Json[]): MetricValue[] {
  const enabled = rows.filter((r) => r['AccountEnabled'] !== false && r['AccountEnabled'] !== 'false');
  if (enabled.length === 0) return [];
  const registered = enabled.filter((r) => truthy(r['MFARegistration'] ?? r['mfaRegistered'])).length;
  return [
    metric('identity.mfa_coverage_pct', 'MFA registration coverage', Math.round((1000 * registered) / enabled.length) / 10, {
      category: 'identity',
      source: 'cipp',
      unit: '%',
      higherIsBetter: true,
    }),
    metric('identity.users_without_mfa', 'Users without MFA', enabled.length - registered, {
      category: 'identity',
      source: 'cipp',
      unit: 'count',
      higherIsBetter: false,
    }),
  ];
}

/** User counts (ListUserCounts: Users / LicUsers / Guests / Gas). */
export function normalizeCippUserCounts(json: unknown): MetricValue[] {
  const row = (Array.isArray(json) ? json[0] : json) as Json | undefined;
  if (!row) return [];
  const out: MetricValue[] = [];
  const id = (k: string, l: string, v: number | undefined, higherIsBetter?: boolean) => {
    if (v !== undefined) out.push(metric(k, l, v, { category: 'identity', source: 'cipp', unit: 'count', higherIsBetter }));
  };
  id('identity.users', 'Microsoft 365 users', asNum(row['Users'] ?? row['users']));
  id('identity.licensed_users', 'Licensed users', asNum(row['LicUsers'] ?? row['licUsers']));
  id('identity.guests', 'Guest accounts', asNum(row['Guests'] ?? row['guests']));
  id('identity.global_admins', 'Global administrators', asNum(row['Gas'] ?? row['gas'] ?? row['GlobalAdmins']), false);
  return out;
}

/** Intune-managed device fleet + compliance (ListDevices rows). */
export function normalizeCippDevices(rows: Json[]): MetricValue[] {
  if (rows.length === 0) return [];
  const out: MetricValue[] = [
    metric('devices.m365_managed', 'Microsoft 365 managed devices', rows.length, { category: 'infrastructure', source: 'cipp', unit: 'count' }),
  ];
  const withState = rows.filter((r) => typeof (r['complianceState'] ?? r['ComplianceState']) === 'string');
  if (withState.length > 0) {
    const compliant = withState.filter((r) => String(r['complianceState'] ?? r['ComplianceState']).toLowerCase() === 'compliant').length;
    out.push(
      metric('devices.compliant_pct', 'Device compliance (Intune)', Math.round((1000 * compliant) / withState.length) / 10, {
        category: 'security',
        source: 'cipp',
        unit: '%',
        higherIsBetter: true,
      }),
    );
  }
  return out;
}

/** Conditional Access posture (enabled policy count). */
export function normalizeCippCa(rows: Json[]): MetricValue[] {
  const enabled = rows.filter((r) => String(r['state'] ?? r['State'] ?? '').toLowerCase() === 'enabled').length;
  return [
    metric('identity.ca_policies', 'Conditional Access policies (enabled)', enabled, { category: 'identity', source: 'cipp', unit: 'count', higherIsBetter: true }),
  ];
}

/** License waste: assigned vs purchased across SKUs (tolerant field names). */
export function normalizeCippLicenses(rows: Json[]): MetricValue[] {
  let used = 0;
  let total = 0;
  let recognized = 0;
  for (const r of rows) {
    const u = asNum(r['CountUsed'] ?? r['countUsed'] ?? r['consumedUnits']);
    const a = asNum(r['CountAvailable'] ?? r['countAvailable'] ?? r['availableUnits']);
    const t = asNum(r['TotalLicenses'] ?? r['totalLicenses'] ?? r['prepaidUnits']);
    if (u === undefined) continue;
    recognized++;
    used += u;
    total += t !== undefined ? t : u + (a ?? 0);
  }
  if (recognized === 0) return [];
  const out = [metric('licenses.assigned', 'Licenses assigned', used, { category: 'spend', source: 'cipp', unit: 'count' })];
  if (total > used) {
    out.push(metric('licenses.unassigned', 'Licenses paid but unassigned', total - used, { category: 'spend', source: 'cipp', unit: 'count', higherIsBetter: false }));
  }
  return out;
}

/** Collect Microsoft 365 posture for a tenant via CIPP. */
export async function collectCipp(ctx: CollectorContext, http: HttpTransport, cfg: CippCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'cipp', metrics: [], warnings: ['No Microsoft 365 tenant mapped for this client (map the tenant domain via CIPP).'] };
  }
  const tenantFilter = ctx.externalRef;
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];
  const pull = async (endpoint: string, normalize: (json: unknown) => MetricValue[]) => {
    try {
      metrics.push(...normalize(await cippGet(http, cfg, endpoint, { tenantFilter })));
    } catch (e) {
      warnings.push(`CIPP ${endpoint} failed: ${e instanceof Error ? e.message : 'error'}`);
    }
  };

  await pull('ListMFAUsers', (j) => normalizeCippMfa(toArray<Json>(j, ['Results'])));
  await pull('ListUserCounts', normalizeCippUserCounts);
  await pull('ListDevices', (j) => normalizeCippDevices(toArray<Json>(j, ['Results'])));
  await pull('ListConditionalAccessPolicies', (j) => normalizeCippCa(toArray<Json>(j, ['Results'])));
  await pull('ListLicenses', (j) => normalizeCippLicenses(toArray<Json>(j, ['Results'])));

  if (metrics.length === 0) warnings.push('CIPP returned no usable data for this tenant.');
  return { source: 'cipp', metrics, warnings };
}
