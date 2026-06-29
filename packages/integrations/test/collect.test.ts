import { describe, it, expect } from 'vitest';
import { computeScorecard } from '@mashit/core';
import { assembleSnapshot, runCollectors, metric, type CollectResult } from '@mashit/integrations';

describe('assembleSnapshot', () => {
  it('merges metrics, dedupes by key, and aggregates warnings', () => {
    const results: CollectResult[] = [
      {
        source: 'halo',
        metrics: [metric('tickets.total', 'Total tickets', 30, { category: 'operations', source: 'halo', unit: 'count' })],
        warnings: [],
      },
      {
        source: 'huntress',
        metrics: [
          metric('huntress.endpoints', 'Endpoints', 80, { category: 'security', source: 'huntress', unit: 'count' }),
          // duplicate key from a second source — first wins, conflict warned
          metric('tickets.total', 'Total tickets', 99, { category: 'operations', source: 'huntress', unit: 'count' }),
        ],
        warnings: ['SAT data requires manual entry'],
      },
    ];
    const { snapshot, warnings } = assembleSnapshot('kpca', '2026-Q1', results, '2026-03-31T00:00:00.000Z');
    const by = Object.fromEntries(snapshot.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(30); // halo kept
    expect(by['huntress.endpoints']).toBe(80);
    expect(warnings.some((w) => w.includes('manual entry'))).toBe(true);
    expect(warnings.some((w) => w.includes('kept halo'))).toBe(true);
  });

  it('produces a snapshot that the core scorecard can consume', () => {
    const results: CollectResult[] = [
      {
        source: 'ninja',
        metrics: [
          metric('patch.compliance_pct', 'Patch compliance', 92, { category: 'security', source: 'ninja', unit: '%', higherIsBetter: true }),
          metric('huntress.endpoints', 'Endpoints', 26, { category: 'security', source: 'huntress', unit: 'count' }),
        ],
        warnings: [],
      },
    ];
    const { snapshot } = assembleSnapshot('mp', '2026-Q1', results, '2026-03-31T00:00:00.000Z');
    const card = computeScorecard(snapshot);
    expect(card.overall.score).not.toBeNull();
    const patching = card.safeguards.find((s) => s.id === 'patching')!;
    expect(patching.score).toBe(92);
  });
});

describe('runCollectors', () => {
  it('isolates a failing collector as a warning-only result', async () => {
    const results = await runCollectors([
      { source: 'halo', run: async () => ({ source: 'halo', metrics: [], warnings: [] }) },
      {
        source: 'checkpoint',
        run: async () => {
          throw new Error('token expired');
        },
      },
    ]);
    expect(results).toHaveLength(2);
    const cp = results.find((r) => r.source === 'checkpoint')!;
    expect(cp.warnings[0]).toMatch(/Collection failed: token expired/);
  });
});
