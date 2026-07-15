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

const upnOf = (r: Json) => String(r['UPN'] ?? r['userPrincipalName'] ?? r['upn'] ?? '');

/**
 * Scope MFA rows the way the Huntress collector scopes identities: enabled
 * accounts, licensed when the report carries a license flag, and the tenant's
 * dominant UPN domain. Raw tenant lists carry guests, externals, and service
 * accounts that make the executive MFA % misleading.
 */
export function scopeCippMfaRows(rows: Json[]): Json[] {
  let active = rows.filter((r) => r['AccountEnabled'] !== false && r['AccountEnabled'] !== 'false');
  const licenseOf = (r: Json) => r['IsLicensed'] ?? r['isLicensed'] ?? r['Licensed'];
  if (active.some((r) => licenseOf(r) !== undefined)) active = active.filter((r) => truthy(licenseOf(r)));
  const counts = new Map<string, number>();
  for (const r of active) {
    const domain = upnOf(r).split('@')[1]?.toLowerCase();
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return dominant ? active.filter((r) => upnOf(r).toLowerCase().endsWith(`@${dominant}`)) : active;
}

/** MFA registration coverage over scoped users (CIPP ListMFAUsers rows). */
export function normalizeCippMfa(rows: Json[]): MetricValue[] {
  const scoped = scopeCippMfaRows(rows);
  if (scoped.length === 0) return [];
  const isRegistered = (r: Json) => truthy(r['MFARegistration'] ?? r['mfaRegistered']);
  const registered = scoped.filter(isRegistered).length;
  const details = scoped
    .slice(0, 100)
    .map((r) => ({ identity: upnOf(r), mfa: isRegistered(r) ? 'yes' : 'NO' }))
    .sort((a, b) => a.mfa.localeCompare(b.mfa)); // the gaps float to the top
  return [
    {
      ...metric('identity.mfa_coverage_pct', 'MFA coverage (licensed users)', Math.round((1000 * registered) / scoped.length) / 10, {
        category: 'identity',
        source: 'cipp',
        unit: '%',
        higherIsBetter: true,
      }),
      details,
    },
    metric('identity.users_without_mfa', 'Licensed users without MFA', scoped.length - registered, {
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

/** Friendly SKU name (CIPP surfaces a readable "License" already; fall back to the part number). */
const skuNameOf = (r: Json): string =>
  String(r['License'] ?? r['Product'] ?? r['SkuPartNumber'] ?? r['skuPartNumber'] ?? r['name'] ?? 'License').trim() || 'License';

// Renewal/expiry lives on the commerce side and only some CIPP builds surface
// it on ListLicenses — read it tolerantly and simply omit when absent.
const LICENSE_DATE_FIELDS = [
  'ExpiryDate', 'expiryDate', 'ExpirationDate', 'expirationDate', 'RenewalDate', 'renewalDate',
  'contractEndDate', 'ContractEndDate', 'nextLifecycleDateTime', 'NextLifecycleDateTime',
];
const licenseDate = (r: Json): string | undefined => {
  for (const f of LICENSE_DATE_FIELDS) {
    const v = r[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
};

/**
 * Microsoft 365 licensing across SKUs (tolerant field names). Emits the totals
 * an exec cares about — purchased, assigned, available (unused) — with a
 * per-SKU drill-down (name, counts, and renewal/expiry when CIPP surfaces it),
 * plus a renewal-soon count and the next renewal date when dates are present.
 */
export function normalizeCippLicenses(rows: Json[], now: number = Date.now()): MetricValue[] {
  let used = 0;
  let total = 0;
  let recognized = 0;
  let expiringSoon = 0;
  let next: { date: string; ms: number } | undefined;
  const skuRows: Array<Record<string, string | number>> = [];

  for (const r of rows) {
    const u = asNum(r['CountUsed'] ?? r['countUsed'] ?? r['consumedUnits']);
    const a = asNum(r['CountAvailable'] ?? r['countAvailable'] ?? r['availableUnits']);
    const t = asNum(r['TotalLicenses'] ?? r['totalLicenses'] ?? r['prepaidUnits']);
    if (u === undefined && t === undefined) continue;
    recognized++;
    const assigned = u ?? 0;
    const purchased = t !== undefined ? t : assigned + (a ?? 0);
    const available = a !== undefined ? a : Math.max(0, purchased - assigned);
    used += assigned;
    total += purchased;

    const row: Record<string, string | number> = { license: skuNameOf(r), purchased, assigned, available };
    const date = licenseDate(r);
    if (date) {
      row['renews'] = date.slice(0, 10);
      const ms = Date.parse(date);
      if (Number.isFinite(ms) && ms > now) {
        if (ms < now + 90 * 86_400_000) expiringSoon++;
        if (!next || ms < next.ms) next = { date: date.slice(0, 10), ms };
      }
    }
    skuRows.push(row);
  }
  if (recognized === 0) return [];

  const available = Math.max(0, total - used);
  const out: MetricValue[] = [
    { ...metric('licenses.total', 'Licenses purchased', total, { category: 'spend', source: 'cipp', unit: 'count' }), details: skuRows },
    metric('licenses.assigned', 'Licenses assigned', used, { category: 'spend', source: 'cipp', unit: 'count' }),
  ];
  // "Available" (paid but unassigned) — kept under the historical key for trend continuity.
  if (total > used) {
    out.push(metric('licenses.unassigned', 'Licenses available (unassigned)', available, { category: 'spend', source: 'cipp', unit: 'count', higherIsBetter: false }));
  }
  if (skuRows.some((r) => 'renews' in r)) {
    if (expiringSoon > 0) {
      out.push(metric('licenses.expiring_90d', 'License SKUs renewing within 90 days', expiringSoon, { category: 'spend', source: 'cipp', unit: 'count', higherIsBetter: false }));
    }
    if (next) out.push(metric('licenses.next_renewal', 'Next license renewal', next.date, { category: 'spend', source: 'cipp' }));
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

  try {
    const rows = toArray<Json>(await cippGet(http, cfg, 'ListMFAUsers', { tenantFilter }), ['Results']);
    const scoped = scopeCippMfaRows(rows);
    metrics.push(...normalizeCippMfa(rows));
    if (scoped.length > 0 && scoped.length < rows.length) {
      warnings.push(`MFA coverage scoped to ${scoped.length} licensed primary-domain users (of ${rows.length} identities in the tenant).`);
    }
  } catch (e) {
    warnings.push(`CIPP ListMFAUsers failed: ${e instanceof Error ? e.message : 'error'}`);
  }
  await pull('ListUserCounts', normalizeCippUserCounts);
  await pull('ListDevices', (j) => normalizeCippDevices(toArray<Json>(j, ['Results'])));
  await pull('ListConditionalAccessPolicies', (j) => normalizeCippCa(toArray<Json>(j, ['Results'])));
  await pull('ListLicenses', (j) => normalizeCippLicenses(toArray<Json>(j, ['Results'])));

  if (metrics.length === 0) warnings.push('CIPP returned no usable data for this tenant.');
  return { source: 'cipp', metrics, warnings };
}
