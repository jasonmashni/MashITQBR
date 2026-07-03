import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * Direct NinjaOne API client (replaces the MASH MCP path for Ninja data).
 *
 * Auth is OAuth2 client_credentials against `{region}/ws/oauth/token` with the
 * read-only `monitoring` scope; data lives under `{region}/v2`. The org-scoped
 * queries use NinjaOne's device-filter syntax (`df=org = <id>`).
 */

export interface NinjaCfg {
  /** Region app URL, e.g. https://app.ninjarmm.com (or eu./oc. variants). */
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
}

type Json = Record<string, unknown>;

const DEFAULT_BASE = 'https://app.ninjarmm.com';
const base = (cfg: NinjaCfg) => (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Exchange (and cache) an OAuth2 client_credentials token (scope `monitoring`). */
export async function ninjaToken(http: HttpTransport, cfg: NinjaCfg): Promise<string> {
  const key = `${base(cfg)}|${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'monitoring',
  }).toString();
  const res = await http.request({
    method: 'POST',
    url: `${base(cfg)}/ws/oauth/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const json = (res.json ?? {}) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (res.status < 200 || res.status >= 300 || !token) {
    throw new Error(`NinjaOne token exchange failed (${res.status})`);
  }
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function ninjaGet(http: HttpTransport, cfg: NinjaCfg, path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const token = await ninjaToken(http, cfg);
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = `${base(cfg)}/v2/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`NinjaOne responded ${res.status} for /v2/${path}`);
  return res.json;
}

/** Organizations in this Ninja tenant (drives org mapping). */
export async function listNinjaOrgs(http: HttpTransport, cfg: NinjaCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await ninjaGet(http, cfg, 'organizations', { pageSize: 1000 });
  return toArray<Json>(json, ['organizations'])
    .filter((o) => o['id'] !== undefined)
    .map((o) => ({ id: String(o['id']), name: typeof o['name'] === 'string' ? o['name'] : `Org ${String(o['id'])}` }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Query results (`/v2/queries/*`) come back as {results: [...]} with a cursor. */
async function queryAll(http: HttpTransport, cfg: NinjaCfg, path: string, orgId: string, maxPages = 5): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string | number> = { df: `org = ${orgId}`, pageSize: 1000 };
    if (cursor) params['cursor'] = cursor;
    const json = (await ninjaGet(http, cfg, path, params)) as Json | null;
    const rows = toArray<Json>(json, ['results']);
    out.push(...rows);
    const next = ((json?.['cursor'] as Json | undefined)?.['name'] ?? json?.['cursor']) as string | undefined;
    if (!next || typeof next !== 'string' || rows.length === 0) break;
    cursor = next;
  }
  return out;
}

/** Normalize AV rows (one per device) into coverage metrics. */
export function normalizeNinjaAv(rows: Json[]): MetricValue[] {
  if (rows.length === 0) return [];
  const on = rows.filter((r) => String(r['productState'] ?? '').toUpperCase() === 'ON').length;
  const current = rows.filter((r) => /up.?to.?date/i.test(String(r['definitionStatus'] ?? ''))).length;
  return [
    metric('endpoints.av_coverage_pct', 'AV coverage', round1((100 * on) / rows.length), { category: 'security', source: 'ninja', unit: '%', higherIsBetter: true }),
    metric('endpoints.av_definitions_pct', 'AV definitions current', round1((100 * current) / rows.length), { category: 'security', source: 'ninja', unit: '%', higherIsBetter: true }),
  ];
}

/** Normalize pending-patch rows (one per pending patch) into patch metrics. */
export function normalizeNinjaPatches(rows: Json[], deviceCount: number): MetricValue[] {
  const devicesWithPending = new Set(rows.map((r) => String(r['deviceId'] ?? ''))).size;
  const out: MetricValue[] = [
    metric('patch.pending', 'Pending OS patches', rows.length, { category: 'security', source: 'ninja', unit: 'count', higherIsBetter: false }),
  ];
  if (deviceCount > 0) {
    out.push(
      metric('patch.compliance_pct', 'Patch compliance', round1((100 * Math.max(0, deviceCount - devicesWithPending)) / deviceCount), {
        category: 'security',
        source: 'ninja',
        unit: '%',
        higherIsBetter: true,
      }),
    );
  }
  return out;
}

/** Collect NinjaOne endpoint posture for an organization via the direct API. */
export async function collectNinjaDirect(ctx: CollectorContext, http: HttpTransport, cfg: NinjaCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'ninja', metrics: [], warnings: ['No NinjaOne organization mapped for this client.'] };
  }
  const orgId = ctx.externalRef;
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];

  // Devices in the organization.
  let devices: Json[] = [];
  try {
    devices = toArray<Json>(await ninjaGet(http, cfg, `organization/${encodeURIComponent(orgId)}/devices`, { pageSize: 1000 }), ['devices']);
    metrics.push(metric('endpoints.managed', 'Managed devices', devices.length, { category: 'infrastructure', source: 'ninja', unit: 'count' }));
    const offline = devices.filter((d) => d['offline'] === true).length;
    if (devices.length > 0) {
      metrics.push(metric('endpoints.offline', 'Devices offline', offline, { category: 'infrastructure', source: 'ninja', unit: 'count', higherIsBetter: false }));
    }
  } catch (e) {
    warnings.push(`NinjaOne devices unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Antivirus coverage (org-scoped query).
  try {
    const av = await queryAll(http, cfg, 'queries/antivirus-status', orgId);
    if (av.length > 0) metrics.push(...normalizeNinjaAv(av));
    else warnings.push('NinjaOne antivirus query returned no rows for this organization.');
  } catch (e) {
    warnings.push(`NinjaOne antivirus query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Pending OS patches (org-scoped query; rows are pending patches per device).
  try {
    const patches = await queryAll(http, cfg, 'queries/os-patches', orgId);
    metrics.push(...normalizeNinjaPatches(patches, devices.length));
  } catch (e) {
    warnings.push(`NinjaOne patch query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Backup usage (per-device rows; devices with backup enabled).
  try {
    const backup = await queryAll(http, cfg, 'queries/backup/usage', orgId);
    if (backup.length > 0) {
      metrics.push(metric('backup.protected_devices', 'Devices with backup', backup.length, { category: 'backup', source: 'ninja', unit: 'count', higherIsBetter: true }));
    }
  } catch {
    // Backup module may not be licensed — not worth a warning.
  }

  if (metrics.length === 0) warnings.push('NinjaOne returned no usable data for this organization.');
  return { source: 'ninja', metrics, warnings };
}
