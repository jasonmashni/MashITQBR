import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type McpTransport } from './types.js';
import { toArray, unwrapMcp } from './util.js';

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

/** Collect Ninja endpoint posture via the MASH MCP server. */
export async function collectNinja(ctx: CollectorContext, mcp: McpTransport): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'ninja', metrics: [], warnings: ['No NinjaOne organization mapped for this client.'] };
  }
  const result = await mcp.callTool('ninja_list_organization_devices', { organizationId: ctx.externalRef });
  const raw = toArray<Record<string, unknown>>(unwrapMcp(result), ['devices']);
  const devices = raw.map(mapNinjaDevice);
  const warnings = devices.length
    ? []
    : ['No NinjaOne devices returned — verify organization mapping and API scope.'];
  return { source: 'ninja', metrics: normalizeNinjaPosture(devices), warnings };
}
