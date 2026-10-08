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
    // ANP's seed covers too little of the scorecard to score (coverage 0.38):
    // no overall number, by design.
    expect(anp['score']).toBeNull();
    expect(anp['rating']).toBe('unknown');
    expect(anp['confidence']).toBe('low');
    expect(anp['status']).toBe('draft');
    const kpca = body.clients.find((c) => c['clientId'] === 'kpca')!;
    expect(typeof kpca['score']).toBe('number');
    expect(kpca['rating']).toBe('green');
  });

  it('carries current-quarter triage: a client with no data this quarter is not started', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.getOverview('2026-Q3');
    const body = res.json as {
      quarterEndsInDays: number;
      clients: Array<{
        clientId: string;
        currentPeriod: string;
        current: { hasData: boolean; status: string; meetingAt: string | null; packageSentAt: string | null; meetingSkipped: boolean };
        lastCompletedPeriod: string | null;
        triage: string;
        period: string | null;
        confidence: string;
      }>;
    };
    expect(typeof body.quarterEndsInDays).toBe('number');
    expect(body.quarterEndsInDays).toBeGreaterThanOrEqual(0);
    const anp = body.clients.find((c) => c.clientId === 'anp')!;
    expect(anp.currentPeriod).toBe('2026-Q3');
    expect(anp.current).toEqual({ hasData: false, status: 'draft', meetingAt: null, packageSentAt: null, meetingSkipped: false, locks: null });
    expect(anp.triage).toBe('not_started');
    // Existing fields keep rendering: the newest quarter with data is still reported.
    expect(anp.period).toBe('2026-Q1');
    expect(['low', 'medium', 'high']).toContain(anp.confidence);
  });

  it('a Halo-only client reports low scorecard confidence', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await store.upsertClient({ id: 'haloonly', name: 'Halo Only Co' });
    await store.putSnapshot({
      clientId: 'haloonly',
      period: '2026-Q3',
      capturedAt: '2026-09-30T00:00:00.000Z',
      metrics: [
        { key: 'tickets.total', label: 'Tickets', value: 40, source: 'halo', category: 'operations' },
        { key: 'finance.quarter_invoiced', label: 'Invoiced', value: 12000, source: 'halo', category: 'spend' },
      ],
    });
    const body = (await h.getOverview('2026-Q3')).json as { clients: Array<{ clientId: string; confidence: string; triage: string; current: { hasData: boolean } }> };
    const row = body.clients.find((c) => c.clientId === 'haloonly')!;
    expect(row.confidence).toBe('low');
    expect(row.current.hasData).toBe(true);
    expect(row.triage).toBe('needs_scheduling');
  });

  it('lastCompletedPeriod is the newest of the last 8 quarters at completed or later', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q3', { status: 'completed' });
    await h.putStatus('anp', '2026-Q2', { status: 'dispositioned' });
    const body = (await h.getOverview('2026-Q3')).json as { clients: Array<{ clientId: string; lastCompletedPeriod: string | null }> };
    expect(body.clients.find((c) => c.clientId === 'anp')!.lastCompletedPeriod).toBe('2026-Q2');
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

  it('period and overview rows carry the quarter locks', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    const locks = { final: { at: '2026-01-20T00:00:00Z', by: 'jason', version: 1 } };
    const existing = await store.getQbr('kpca', '2025-Q4');
    await store.upsertQbr({ status: 'dispositioned', ...existing, clientId: 'kpca', period: '2025-Q4', locks, updatedAt: new Date().toISOString() });
    const periods = (await h.getPeriods('kpca', '2026-Q1')).json as { periods: Array<{ period: string; locks?: unknown }> };
    expect(periods.periods.find((p) => p.period === '2025-Q4')?.locks).toEqual(locks);
    expect(periods.periods.find((p) => p.period === '2024-Q1')?.locks).toBeUndefined();
    const over = (await h.getOverview('2025-Q4')).json as { clients: Array<{ clientId: string; current: { locks: unknown } }> };
    expect(over.clients.find((c) => c.clientId === 'kpca')?.current.locks).toEqual(locks);
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

  it('reads the review-engagement signal from a past meeting and stamps heldAt on completion', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    const past = new Date(Date.now() - 20 * 86_400_000).toISOString();

    // Before any meeting, health flags "no QBR held yet".
    let res = await h.getOverview('2026-Q1');
    let anp = (res.json as { clients: Array<{ clientId: string; health: { drivers: string[] } }> }).clients.find((c) => c.clientId === 'anp')!;
    expect(anp.health.drivers.join(' ')).toMatch(/no qbr held/i);

    // A meeting whose time has already passed counts as held — the penalty lifts.
    await h.putSchedule('anp', '2026-Q1', { scheduledAt: past });
    res = await h.getOverview('2026-Q1');
    anp = (res.json as { clients: Array<{ clientId: string; health: { drivers: string[] } }> }).clients.find((c) => c.clientId === 'anp')!;
    expect(anp.health.drivers.join(' ')).not.toMatch(/no qbr held/i);

    // Completing the QBR stamps heldAt from the (past) scheduled time.
    await h.putStatus('anp', '2026-Q1', { status: 'completed' });
    const rec = await store.getQbr('anp', '2026-Q1');
    expect(rec?.meeting?.heldAt).toBe(past);
  });

  it('dispositioning a skipped meeting completes the QBR without stamping heldAt', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();

    // Guard: the report package must have gone out first.
    expect((await h.dispositionQbrSkipped('mp', '2026-Q1', { reason: 'client passed' })).status).toBe(409);

    // Marking the package sent stamps packageSentAt; then the skip closes the quarter.
    await h.markPackageSent('mp', '2026-Q1');
    const res = await h.dispositionQbrSkipped('mp', '2026-Q1', { reason: 'Client declined — emailed report only' });
    expect(res.status).toBe(200);
    const rec = await store.getQbr('mp', '2026-Q1');
    // The skip is the quarter's disposition: lock 2 freezes it at dispositioned.
    expect(rec?.status).toBe('dispositioned');
    expect(rec?.locks?.final).toBeTruthy();
    expect(rec?.meetingSkipped?.reason).toBe('Client declined — emailed report only');
    expect(rec?.meeting?.heldAt).toBeUndefined();

    // Engagement signal stays honest: the quarter closed, but no QBR was held.
    const over = await h.getOverview('2026-Q1');
    const mp = (over.json as { clients: Array<{ clientId: string; status: string; health: { drivers: string[] } }> }).clients.find(
      (c) => c.clientId === 'mp',
    )!;
    expect(mp.status).toBe('dispositioned');
    expect(mp.health.drivers.join(' ')).toMatch(/no qbr held/i);

    // Later stage changes must not backfill heldAt on a skipped quarter.
    await h.putStatus('mp', '2026-Q1', { status: 'actions_pushed' });
    expect((await store.getQbr('mp', '2026-Q1'))?.meeting?.heldAt).toBeUndefined();
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
