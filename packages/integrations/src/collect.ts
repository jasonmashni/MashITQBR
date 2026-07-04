import type { MetricSnapshot, MetricValue } from '@mashit/core';
import type { CollectResult } from './types.js';

export interface AssembledSnapshot {
  snapshot: MetricSnapshot;
  /** Coverage gaps and conflicts surfaced during assembly. */
  warnings: string[];
}

// Per-metric budget for drill-down rows: keeps the whole snapshot comfortably
// inside a 1MB Table Storage entity even with dozens of detail-carrying
// metrics.
const DETAILS_JSON_BUDGET = 16_000;

/** Trim a metric's drill-down rows to the per-metric JSON budget. */
export function trimMetricDetails(m: MetricValue): MetricValue {
  if (!m.details?.length) return m;
  let rows = m.details.slice(0, 100);
  while (rows.length > 1 && JSON.stringify(rows).length > DETAILS_JSON_BUDGET) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
  }
  return rows.length === m.details.length ? m : { ...m, details: rows };
}

/**
 * Merge per-integration collect results into a single metric snapshot. Metric
 * keys are de-duplicated (first source wins); conflicts and per-source warnings
 * are surfaced so the QBR builder can flag coverage gaps.
 */
export function assembleSnapshot(
  clientId: string,
  period: string,
  results: CollectResult[],
  capturedAt: string,
): AssembledSnapshot {
  const byKey = new Map<string, MetricValue>();
  const warnings: string[] = [];

  for (const r of results) {
    for (const w of r.warnings) warnings.push(`[${r.source}] ${w}`);
    for (const m of r.metrics) {
      const existing = byKey.get(m.key);
      if (existing) {
        warnings.push(`Metric "${m.key}" reported by both ${existing.source} and ${m.source}; kept ${existing.source}.`);
        continue;
      }
      byKey.set(m.key, trimMetricDetails(m));
    }
  }

  return {
    snapshot: { clientId, period, capturedAt, metrics: [...byKey.values()] },
    warnings,
  };
}

/**
 * Run a set of collectors concurrently, isolating failures so one bad
 * integration doesn't abort the whole pull. A thrown collector becomes a
 * warning-only result.
 */
export async function runCollectors(
  collectors: Array<{ source: CollectResult['source']; run: () => Promise<CollectResult> }>,
): Promise<CollectResult[]> {
  return Promise.all(
    collectors.map(async ({ source, run }) => {
      try {
        return await run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { source, metrics: [], warnings: [`Collection failed: ${message}`] };
      }
    }),
  );
}
