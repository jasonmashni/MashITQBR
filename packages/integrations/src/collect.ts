import type { MetricSnapshot, MetricValue } from '@mashit/core';
import type { CollectResult } from './types.js';

export interface AssembledSnapshot {
  snapshot: MetricSnapshot;
  /** Coverage gaps and conflicts surfaced during assembly. */
  warnings: string[];
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
      byKey.set(m.key, m);
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
