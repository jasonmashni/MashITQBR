import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the store to a temp dir BEFORE handlers create their module-level store.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-overview-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

describe('overview + periods endpoints', () => {
  it('rolls up seeded clients with scorecards in one call', async () => {
    const h = await import('../src/handlers.js');
    // Pin "current" so the seed quarters (2026-Q1/2025-Q4) are in the window.
    const res = await h.getOverview('2026-Q1');
    expect(res.status).toBe(200);
    const body = res.json as { currentPeriod: string; clients: Array<Record<string, unknown>> };
    expect(body.currentPeriod).toBe('2026-Q1');
    expect(body.clients.length).toBeGreaterThanOrEqual(3);
    const anp = body.clients.find((c) => c['clientId'] === 'anp')!;
    expect(anp['period']).toBe('2026-Q1');
    expect(typeof anp['score']).toBe('number');
    expect(anp['status']).toBe('draft');
  });

  it('lists which of the last 8 quarters have data (seeds count)', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.getPeriods('anp', '2026-Q1');
    const body = res.json as { periods: Array<{ period: string; hasSnapshot: boolean }> };
    expect(body.periods).toHaveLength(8);
    const by = Object.fromEntries(body.periods.map((p) => [p.period, p.hasSnapshot]));
    expect(by['2026-Q1']).toBe(true); // seed
    expect(by['2025-Q4']).toBe(true); // seed (previous quarter)
    expect(by['2025-Q1']).toBe(false);
  });

  it('ignores a malformed ?current override', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.getPeriods('anp', 'DROP TABLE');
    const body = res.json as { currentPeriod: string };
    expect(/^\d{4}-Q[1-4]$/.test(body.currentPeriod)).toBe(true);
  });

  it('carries an account-health rollup on every overview row', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.getOverview('2026-Q1');
    const body = res.json as { clients: Array<{ health?: { score: number; rating: string; drivers: string[] } }> };
    const anp = body.clients.find((c) => (c as { clientId?: string }).clientId === 'anp') as {
      health?: { score: number; rating: string; drivers: string[] };
    };
    expect(anp.health).toBeTruthy();
    expect(typeof anp.health!.score).toBe('number');
    expect(['green', 'amber', 'red', 'unknown']).toContain(anp.health!.rating);
    expect(Array.isArray(anp.health!.drivers)).toBe(true);
  });

  it('sums open opportunity value into the roadmap figure and clears on empty', async () => {
    const h = await import('../src/handlers.js');
    // A one-time and a recurring open card → annualized roadmap value.
    const a = (await h.putOpportunity('anp', { title: 'Server refresh', value: 15000, valueKind: 'one_time' })).json as {
      opportunity: { id: string; value?: number; valueKind?: string };
    };
    await h.putOpportunity('anp', { title: 'Co-managed uplift', value: 500, valueKind: 'recurring' });
    // A closed card must not count toward the pipeline.
    await h.putOpportunity('anp', { title: 'Old idea', value: 99000, valueKind: 'one_time', status: 'closed' });
    expect(a.opportunity.value).toBe(15000);

    let res = await h.getOverview('2026-Q1');
    let anp = (res.json as { clients: Array<{ clientId: string; roadmapValue: number; roadmapCount: number }> }).clients.find(
      (c) => c.clientId === 'anp',
    )!;
    expect(anp.roadmapValue).toBe(15000 + 500 * 12);
    expect(anp.roadmapCount).toBe(2);

    // Clearing the value (null) drops it back out of the pipeline.
    await h.putOpportunity('anp', { id: a.opportunity.id, title: 'Server refresh', value: null });
    res = await h.getOverview('2026-Q1');
    anp = (res.json as { clients: Array<{ clientId: string; roadmapValue: number; roadmapCount: number }> }).clients.find(
      (c) => c.clientId === 'anp',
    )!;
    expect(anp.roadmapValue).toBe(500 * 12);
    expect(anp.roadmapCount).toBe(1);
  });
});
