import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type McpTransport } from './types.js';
import { toArray, unwrapMcp } from './util.js';
import { parseJsonLines, parsePipeRows } from './mcpText.js';

/** Normalized per-device posture used to compute endpoint metrics. */
export interface NinjaDevicePosture {
  antivirusActive?: boolean;
  patchesInstalled?: number;
  patchesTotal?: number;
  warrantyExpired?: boolean;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Compute endpoint-posture metrics from per-device records. */
export function normalizeNinjaPosture(devices: NinjaDevicePosture[]): MetricValue[] {
  const out: MetricValue[] = [];
  const n = devices.length;
  out.push(metric('endpoints.managed', 'Managed devices', n, { category: 'infrastructure', source: 'ninja', unit: 'count' }));
  if (n === 0) return out;

  const avActive = devices.filter((d) => d.antivirusActive).length;
  out.push(
    metric('endpoints.av_coverage_pct', 'AV coverage', round((100 * avActive) / n), {
      category: 'security',
      source: 'ninja',
      unit: '%',
      higherIsBetter: true,
    }),
  );

  let installed = 0;
  let total = 0;
  for (const d of devices) {
    if (typeof d.patchesInstalled === 'number') installed += d.patchesInstalled;
    if (typeof d.patchesTotal === 'number') total += d.patchesTotal;
  }
  if (total > 0) {
    out.push(
      metric('patch.compliance_pct', 'Patch compliance', round((100 * installed) / total), {
        category: 'security',
        source: 'ninja',
        unit: '%',
        higherIsBetter: true,
      }),
    );
  }

  const expired = devices.filter((d) => d.warrantyExpired).length;
  out.push(
    metric('assets.warranty_expired', 'Devices out of warranty', expired, {
      category: 'infrastructure',
      source: 'ninja',
      unit: 'count',
      higherIsBetter: false,
    }),
  );

  return out;
}

/**
 * Map a raw Ninja device record (from MCP) into normalized posture. Ninja stores
 * warranty in custom fields, so warranty is read from a custom-field bag.
 */
export function mapNinjaDevice(raw: Record<string, unknown>): NinjaDevicePosture {
  const av = raw['antivirusStatus'] ?? raw['avStatus'];
  const cf = (raw['customFields'] ?? raw['fields'] ?? {}) as Record<string, unknown>;
  const warranty = cf['warrantyExpired'] ?? raw['warrantyExpired'];
  return {
    antivirusActive: typeof av === 'string' ? /active|enabled|on/i.test(av) : Boolean(av),
    patchesInstalled: numberOrUndef(raw['patchesInstalled']),
    patchesTotal: numberOrUndef(raw['patchesTotal']),
    warrantyExpired: typeof warranty === 'boolean' ? warranty : undefined,
  };
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Page through a MASH MCP cursor tool ('after' id) collecting text pages. */
async function pageText(
  mcp: McpTransport,
  tool: string,
  args: Record<string, unknown>,
  extract: (text: string) => Array<{ id?: string; deviceId?: unknown }>,
  maxPages = 10,
): Promise<Array<Record<string, unknown>>> {
  const pageSize = 200;
  const out: Array<Record<string, unknown>> = [];
  let after: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await mcp.callTool(tool, { ...args, page_size: pageSize, ...(after !== undefined ? { after } : {}) });
    const payload = unwrapMcp(result);
    if (typeof payload !== 'string') {
      // Structured output — take it as-is (single page).
      return toArray<Record<string, unknown>>(payload, ['devices', 'results']);
    }
    const rows = extract(payload) as Array<Record<string, unknown>>;
    out.push(...rows);
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1]!;
    const cursor = Number(last['id'] ?? last['deviceId']);
    if (!Number.isFinite(cursor)) break;
    after = cursor;
  }
  return out;
}

/**
 * Collect Ninja endpoint posture via the MASH MCP server.
 *
 * Live MASH MCP formats (captured): device lists are `[id] NAME | Org: n | …`
 * pipe rows; the query_* batch tools emit one JSON object per line and accept
 * a NinjaOne device_filter (org scoping). Structured JSON, if the server ever
 * returns it, takes the legacy per-device path automatically.
 */
export async function collectNinja(ctx: CollectorContext, mcp: McpTransport): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'ninja', metrics: [], warnings: ['No NinjaOne organization mapped for this client.'] };
  }
  const orgId = Number(ctx.externalRef);
  const orgRef = Number.isFinite(orgId) ? orgId : ctx.externalRef;

  const deviceResult = await mcp.callTool('ninja_list_organization_devices', { organization_id: orgRef, page_size: 200 });
  const devicePayload = unwrapMcp(deviceResult);

  // Structured payload → legacy per-device normalization (richer if available).
  if (typeof devicePayload !== 'string') {
    const raw = toArray<Record<string, unknown>>(devicePayload, ['devices']);
    const devices = raw.map(mapNinjaDevice);
    const warnings = devices.length ? [] : ['No NinjaOne devices returned — verify organization mapping and API scope.'];
    return { source: 'ninja', metrics: normalizeNinjaPosture(devices), warnings };
  }

  const warnings: string[] = [];
  const metrics: MetricValue[] = [];

  // Devices (pipe rows, cursor-paged).
  let deviceRows = parsePipeRows(devicePayload);
  if (deviceRows.length === 200) {
    const more = await pageText(mcp, 'ninja_list_organization_devices', { organization_id: orgRef }, (t) => parsePipeRows(t));
    if (more.length > deviceRows.length) deviceRows = more as unknown as typeof deviceRows;
  }
  const deviceCount = deviceRows.length;
  metrics.push(metric('endpoints.managed', 'Managed devices', deviceCount, { category: 'infrastructure', source: 'ninja', unit: 'count' }));
  if (deviceCount === 0) {
    warnings.push('No NinjaOne devices returned — verify organization mapping.');
    return { source: 'ninja', metrics, warnings };
  }

  // Antivirus coverage (JSON-lines, org-scoped via NinjaOne device filter).
  try {
    const avRows = await pageText(
      mcp,
      'ninja_query_antivirus_status',
      { device_filter: `org = ${String(orgRef)}` },
      (t) => parseJsonLines(t) as never,
    );
    if (avRows.length > 0) {
      const on = avRows.filter((r) => String(r['productState'] ?? '').toUpperCase() === 'ON').length;
      const current = avRows.filter((r) => /up.?to.?date/i.test(String(r['definitionStatus'] ?? ''))).length;
      metrics.push(
        metric('endpoints.av_coverage_pct', 'AV coverage', round1((100 * on) / avRows.length), {
          category: 'security',
          source: 'ninja',
          unit: '%',
          higherIsBetter: true,
        }),
        metric('endpoints.av_definitions_pct', 'AV definitions current', round1((100 * current) / avRows.length), {
          category: 'security',
          source: 'ninja',
          unit: '%',
          higherIsBetter: true,
        }),
      );
    } else {
      warnings.push('NinjaOne antivirus query returned no rows for this organization.');
    }
  } catch (e) {
    warnings.push(`NinjaOne antivirus query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Pending OS patches (JSON-lines; each row is one pending patch on a device).
  try {
    const patchRows = await pageText(
      mcp,
      'ninja_query_os_patches',
      { device_filter: `org = ${String(orgRef)}` },
      (t) => parseJsonLines(t) as never,
    );
    const devicesWithPending = new Set(patchRows.map((r) => String(r['deviceId'] ?? ''))).size;
    metrics.push(
      metric('patch.pending', 'Pending OS patches', patchRows.length, { category: 'security', source: 'ninja', unit: 'count', higherIsBetter: false }),
      metric('patch.compliance_pct', 'Patch compliance', round1((100 * Math.max(0, deviceCount - devicesWithPending)) / deviceCount), {
        category: 'security',
        source: 'ninja',
        unit: '%',
        higherIsBetter: true,
      }),
    );
  } catch (e) {
    warnings.push(`NinjaOne patch query failed: ${e instanceof Error ? e.message : 'error'}`);
  }

  warnings.push('Warranty/lifecycle lives in NinjaOne custom fields, which the MCP text output does not expose — track via manual metrics for now.');
  return { source: 'ninja', metrics, warnings };
}
