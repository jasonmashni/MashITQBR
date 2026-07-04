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
  /**
   * Device-role ids to report on (from the connection's "Device roles"
   * picker — e.g. Windows Desktop, Windows Laptop, Mac). Empty/absent =
   * report on every device. When set, all queries are filtered to devices
   * carrying these roles.
   */
  nodeRoleIds?: string[];
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

/** Device roles in this tenant (drives the connection's "Device roles" picker). */
export async function listNinjaRoles(http: HttpTransport, cfg: NinjaCfg): Promise<Array<{ id: string; name: string }>> {
  const json = await ninjaGet(http, cfg, 'roles', {});
  return toArray<Json>(json, ['roles'])
    .filter((r) => r['id'] !== undefined)
    .map((r) => ({ id: String(r['id']), name: typeof r['name'] === 'string' ? r['name'] : `Role ${String(r['id'])}` }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Query results (`/v2/queries/*`) come back as {results: [...]} with a cursor. */
async function queryAll(
  http: HttpTransport,
  cfg: NinjaCfg,
  path: string,
  extraParams: Record<string, string | number>,
  maxPages = 5,
): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string | number> = { ...extraParams, pageSize: 1000 };
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

/**
 * Quarterly patch compliance from the install history: patches that INSTALLED
 * vs FAILED during the period. This answers "how well did patching go this
 * quarter" rather than "how many patches are pending mid-cycle right now".
 */
export function normalizeNinjaPatchQuarter(installed: number, failed: number): MetricValue[] {
  const out: MetricValue[] = [
    metric('patch.installed_quarter', 'Patches installed this quarter', installed, { category: 'security', source: 'ninja', unit: 'count', higherIsBetter: true }),
  ];
  if (failed > 0) {
    out.push(metric('patch.failed_quarter', 'Patch failures this quarter', failed, { category: 'security', source: 'ninja', unit: 'count', higherIsBetter: false }));
  }
  if (installed + failed > 0) {
    out.push(
      metric('patch.compliance_pct', 'Patch success rate (quarter)', round1((100 * installed) / (installed + failed)), {
        category: 'security',
        source: 'ninja',
        unit: '%',
        higherIsBetter: true,
      }),
    );
  }
  return out;
}

/** Fields on a backup-usage row that prove data is ACTUALLY backed up. */
const BACKUP_EVIDENCE_FIELDS = [
  'totalSize',
  'totalSizeOnDisk',
  'revisionsTotalSize',
  'backupTotalSize',
  'usedStorage',
  'usedBytes',
  'totalFiles',
  'fileCount',
  'lastSuccessfulBackupJob',
];

/**
 * Backup usage rows carry organizationId (the endpoint has no org filter) —
 * and the endpoint returns a row for EVERY device when the backup module is
 * on, with zero usage for devices that have no backup plan. Only devices
 * with real backup evidence count as protected.
 */
export function normalizeNinjaBackup(rows: Json[], orgId: string, deviceName?: (id: string) => string | undefined): MetricValue[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inOrg = rows.filter((r) => String(r['organizationId'] ?? '') === String(orgId));
  const byDevice = new Map<string, Json>();
  for (const r of inOrg) byDevice.set(String(r['id'] ?? r['deviceId'] ?? byDevice.size), r);
  if (byDevice.size === 0) return [];
  const protectedRows: Array<Record<string, string | number>> = [];
  let failing = 0;
  for (const [id, r] of byDevice) {
    const hasBackup = BACKUP_EVIDENCE_FIELDS.some((f) => num(r[f]) > 0);
    if (!hasBackup) continue;
    protectedRows.push({ device: deviceName?.(id) ?? id });
    const ok = num(r['lastSuccessfulBackupJob']);
    const bad = num(r['lastFailedBackupJob']);
    if (bad > ok) failing++;
  }
  const out: MetricValue[] = [
    {
      ...metric('backup.protected_devices', 'Devices with backup', protectedRows.length, { category: 'backup', source: 'ninja', unit: 'count', higherIsBetter: true }),
      details: protectedRows.slice(0, 100),
    },
  ];
  if (failing > 0) {
    out.push(metric('backup.failed_jobs', 'Devices with failing backups', failing, { category: 'backup', source: 'ninja', unit: 'count', higherIsBetter: false }));
  }
  return out;
}

/** Devices whose latest health status needs attention (not point-in-time offline). */
export function normalizeNinjaHealth(rows: Json[]): MetricValue[] {
  if (rows.length === 0) return [];
  const unhealthy = rows.filter((r) => {
    const h = String(r['healthStatus'] ?? '').toUpperCase();
    return h !== '' && h !== 'HEALTHY' && h !== 'UNKNOWN';
  }).length;
  return [
    metric('endpoints.needs_attention', 'Devices needing attention', unhealthy, { category: 'infrastructure', source: 'ninja', unit: 'count', higherIsBetter: false }),
  ];
}

/** Collect NinjaOne endpoint posture for an organization via the direct API. */
export async function collectNinjaDirect(ctx: CollectorContext, http: HttpTransport, cfg: NinjaCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'ninja', metrics: [], warnings: ['No NinjaOne organization mapped for this client.'] };
  }
  const orgId = ctx.externalRef;
  const df = { df: `org = ${orgId}` };
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];
  const roleFilter = cfg.nodeRoleIds?.length ? new Set(cfg.nodeRoleIds.map(String)) : undefined;

  // Role names for drill-down labels (best effort; ids still work without).
  let roleNames = new Map<string, string>();
  if (roleFilter) {
    try {
      roleNames = new Map((await listNinjaRoles(http, cfg)).map((r) => [r.id, r.name]));
    } catch {
      // ids alone are fine
    }
  }

  // Devices in the organization — the role filter applies here, and the
  // surviving device ids scope every query below.
  let devices: Json[] = [];
  let allowedIds: Set<string> | undefined;
  const deviceNames = new Map<string, string>();
  try {
    const all = toArray<Json>(await ninjaGet(http, cfg, `organization/${encodeURIComponent(orgId)}/devices`, { pageSize: 1000 }), ['devices']);
    devices = roleFilter ? all.filter((d) => roleFilter.has(String(d['nodeRoleId'] ?? d['roleId'] ?? ''))) : all;
    if (roleFilter) {
      allowedIds = new Set(devices.map((d) => String(d['id'] ?? '')));
      if (all.length > 0 && devices.length === 0) {
        warnings.push('NinjaOne: no devices in this organization carry the selected device roles — check the connection’s "Device roles" picker.');
      }
    }
    const deviceRows = devices.slice(0, 100).map((d) => {
      const name = firstStrOf(d, ['systemName', 'dnsName', 'displayName', 'name']) ?? `#${String(d['id'] ?? '')}`;
      deviceNames.set(String(d['id'] ?? ''), name);
      return { name, role: roleNames.get(String(d['nodeRoleId'] ?? '')) ?? String(d['nodeRoleId'] ?? '') };
    });
    for (const d of devices) {
      const id = String(d['id'] ?? '');
      if (!deviceNames.has(id)) deviceNames.set(id, firstStrOf(d, ['systemName', 'dnsName', 'displayName', 'name']) ?? `#${id}`);
    }
    metrics.push({
      ...metric('endpoints.managed', 'Managed devices', devices.length, { category: 'infrastructure', source: 'ninja', unit: 'count' }),
      details: deviceRows,
    });
  } catch (e) {
    warnings.push(`NinjaOne devices unavailable: ${e instanceof Error ? e.message : 'error'}`);
    if (roleFilter) warnings.push('NinjaOne: the device-role filter could not be applied (device list unavailable) — other queries are unfiltered.');
  }

  // Query rows carry deviceId — scope them to the role-filtered device set.
  const scoped = (rows: Json[]) => (allowedIds ? rows.filter((r) => allowedIds.has(String(r['deviceId'] ?? r['id'] ?? ''))) : rows);

  // Device health (persistent condition, unlike point-in-time offline).
  try {
    const health = scoped(await queryAll(http, cfg, 'queries/device-health', df));
    metrics.push(...normalizeNinjaHealth(health));
  } catch (e) {
    warnings.push(`NinjaOne device-health query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Antivirus coverage (org-scoped query).
  try {
    const av = scoped(await queryAll(http, cfg, 'queries/antivirus-status', df));
    if (av.length > 0) metrics.push(...normalizeNinjaAv(av));
    else warnings.push('NinjaOne antivirus query returned no rows for this organization.');
  } catch (e) {
    warnings.push(`NinjaOne antivirus query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Quarterly patch compliance from the install history (INSTALLED vs FAILED
  // during the period), plus the current pending count as a snapshot.
  try {
    const installed = scoped(await queryAll(http, cfg, 'queries/os-patch-installs', {
      ...df,
      status: 'INSTALLED',
      installedAfter: ctx.period.start,
      installedBefore: ctx.period.end,
    }));
    const failed = scoped(await queryAll(http, cfg, 'queries/os-patch-installs', {
      ...df,
      status: 'FAILED',
      installedAfter: ctx.period.start,
      installedBefore: ctx.period.end,
    }));
    metrics.push(...normalizeNinjaPatchQuarter(installed.length, failed.length));
  } catch (e) {
    warnings.push(`NinjaOne patch-install history failed: ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    const pending = scoped(await queryAll(http, cfg, 'queries/os-patches', df));
    metrics.push(metric('patch.pending', 'Pending OS patches', pending.length, { category: 'security', source: 'ninja', unit: 'count', higherIsBetter: false }));
  } catch (e) {
    warnings.push(`NinjaOne patch query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Backup usage — the endpoint has no org filter, so filter rows by their
  // organizationId (counting all rows was wildly wrong for multi-org tenants).
  try {
    const backup = scoped(await queryAll(http, cfg, 'queries/backup/usage', {}));
    metrics.push(...normalizeNinjaBackup(backup, orgId, (id) => deviceNames.get(id)));
  } catch {
    // Backup module may not be licensed — not worth a warning.
  }

  if (metrics.length === 0) warnings.push('NinjaOne returned no usable data for this organization.');
  return { source: 'ninja', metrics, warnings };
}

function firstStrOf(row: Json, keys: string[]): string | undefined {
  for (const k of keys) if (typeof row[k] === 'string' && row[k]) return row[k] as string;
  return undefined;
}
