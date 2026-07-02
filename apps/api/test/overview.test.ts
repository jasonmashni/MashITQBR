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
});
