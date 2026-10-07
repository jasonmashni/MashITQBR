import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { QbrRecord } from '../src/store/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-status-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

const statusOf = async (period: string) => {
  const store = (await import('../src/store/index.js')).getDataStore();
  return (await store.getQbr('anp', period))?.status;
};

describe('approveNarrative', () => {
  it('advances a synced QBR to narrative_approved', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q1', { status: 'data_synced' });
    const res = await h.approveNarrative('anp', '2025-Q1');
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q1')).toBe('narrative_approved');
  });

  it('never regresses a QBR that is already completed', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putStatus('anp', '2025-Q2', { status: 'completed', force: true, reason: 'test setup' })).status).toBe(200);
    const res = await h.approveNarrative('anp', '2025-Q2');
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q2')).toBe('completed');
  });

  it('refuses to approve before the data is synced', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.approveNarrative('anp', '2023-Q2');
    expect(res.status).toBe(409);
    expect(await statusOf('2023-Q2')).toBeUndefined();
  });
});

describe('markPackageSent', () => {
  it('404s an unknown client', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.markPackageSent('nope', '2026-Q1')).status).toBe(404);
  });

  it('409s a period with no snapshot', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.markPackageSent('anp', '2019-Q1')).status).toBe(409);
  });

  it('409s an archived QBR', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('kpca', '2026-Q1', { status: 'archived' });
    const res = await h.markPackageSent('kpca', '2026-Q1');
    expect(res.status).toBe(409);
    const store = (await import('../src/store/index.js')).getDataStore();
    expect((await store.getQbr('kpca', '2026-Q1'))?.packageSentAt).toBeUndefined();
  });

  it('keeps the first packageSentAt on a repeat call', async () => {
    const h = await import('../src/handlers.js');
    const first = await h.markPackageSent('anp', '2026-Q1');
    expect(first.status).toBe(200);
    const stamped = (first.json as { packageSentAt?: string }).packageSentAt;
    expect(stamped).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    const again = await h.markPackageSent('anp', '2026-Q1');
    expect(again.status).toBe(200);
    expect((again.json as { packageSentAt?: string }).packageSentAt).toBe(stamped);
  });
});

describe('putStatus', () => {
  it('refuses a backwards move without force', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q3', { status: 'scheduled' });
    const res = await h.putStatus('anp', '2025-Q3', { status: 'draft' });
    expect(res.status).toBe(409);
    expect(await statusOf('2025-Q3')).toBe('scheduled');
  });

  it('requires a reason for a forced override', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putStatus('anp', '2025-Q3', { status: 'draft', force: true });
    expect(res.status).toBe(400);
    expect(await statusOf('2025-Q3')).toBe('scheduled');
  });

  it('applies a forced backwards move and audits the reason', async () => {
    const h = await import('../src/handlers.js');
    const { runWithActor } = await import('../src/requestContext.js');
    const res = await runWithActor('tech@mashit.net', () => h.putStatus('anp', '2025-Q3', { status: 'draft', force: true, reason: 'cleanup' }));
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q3')).toBe('draft');
    const events = ((await h.getAudit('50')).json as { events: Array<{ action: string; target: string; actor: string; detail?: string }> }).events;
    const entry = events.find((e) => e.target === 'qbr:anp/2025-Q3' && e.detail?.includes('override'));
    expect(entry?.detail).toContain('cleanup');
    expect(entry?.detail).toContain('override');
    expect(entry?.actor).toBe('tech@mashit.net');
  });

  it('a forced move below completed clears meeting.heldAt', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await h.putStatus('anp', '2023-Q1', { status: 'completed' });
    expect((await store.getQbr('anp', '2023-Q1'))?.meeting?.heldAt).toBeTruthy();
    expect((await h.putStatus('anp', '2023-Q1', { status: 'scheduled', force: true, reason: 'meeting did not happen' })).status).toBe(200);
    const rec = await store.getQbr('anp', '2023-Q1');
    expect(rec?.status).toBe('scheduled');
    expect(rec?.meeting?.heldAt).toBeUndefined();
  });

  it('advances on a forward move without force', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q4', { status: 'data_synced' });
    const res = await h.putStatus('anp', '2025-Q4', { status: 'scheduled' });
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q4')).toBe('scheduled');
  });

  it('treats the same status as a no-op success and rejects unknown statuses', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putStatus('anp', '2025-Q4', { status: 'scheduled' })).status).toBe(200);
    expect((await h.putStatus('anp', '2025-Q4', { status: 'bogus' })).status).toBe(400);
  });

  it('un-archiving is a backwards move and needs an override', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2024-Q4', { status: 'archived' });
    expect((await h.putStatus('anp', '2024-Q4', { status: 'completed' })).status).toBe(409);
    expect((await h.putStatus('anp', '2024-Q4', { status: 'completed', force: true, reason: 'reopened' })).status).toBe(200);
  });
});

describe('locked quarters refuse writes', () => {
  const setLocks = async (period: string, locks: QbrRecord['locks']) => {
    const store = (await import('../src/store/index.js')).getDataStore();
    const existing = await store.getQbr('anp', period);
    await store.upsertQbr({ status: 'scheduled', ...existing, clientId: 'anp', period, locks, updatedAt: new Date().toISOString() });
  };
  const lock = { at: '2026-06-01T00:00:00Z', by: 'jason', version: 1 };

  it('a preread lock refuses data writes with 409 but keeps the agenda open', async () => {
    const h = await import('../src/handlers.js');
    await setLocks('2024-Q1', { preread: lock });
    const sync = await h.syncQbr('anp', '2024-Q1');
    expect(sync.status).toBe(409);
    expect(sync.json).toEqual({ error: 'locked', stage: 'preread' });
    const edits = await h.putNarrativeEdits('anp', '2024-Q1', { headline: 'New' });
    expect(edits).toEqual({ status: 409, json: { error: 'locked', stage: 'preread' } });
    for (const res of [
      await h.regenerateNarrative('anp', '2024-Q1'),
      await h.putManualMetrics('anp', '2024-Q1', { metrics: [] }),
      await h.importDocumentMetrics('anp', '2024-Q1', { source: 'pdf:x', metrics: [] }),
      await h.removeImportedMetrics('anp', '2024-Q1', 'pdf:x'),
      await h.uploadQbrDocument('anp', '2024-Q1', { name: 'a.pdf', dataBase64: 'AAAA' }),
      await h.updateQbrDocument('anp', '2024-Q1', 'x', { name: 'b' }),
      await h.deleteQbrDocument('anp', '2024-Q1', 'x'),
    ]) {
      expect(res.status).toBe(409);
    }
    const disc = await h.putDiscussion('anp', '2024-Q1', { items: [], notes: 'Agenda still open' });
    expect(disc.status).toBe(200);
    const sched = await h.putSchedule('anp', '2024-Q1', { scheduledAt: '2024-03-10T15:00:00Z' });
    expect(sched.status).toBe(200);
  });

  it('a final lock also refuses discussion and schedule writes', async () => {
    const h = await import('../src/handlers.js');
    await setLocks('2024-Q1', { preread: lock, final: { ...lock, version: 2 } });
    expect(await h.putDiscussion('anp', '2024-Q1', { items: [], notes: 'Too late' })).toEqual({ status: 409, json: { error: 'locked', stage: 'final' } });
    expect((await h.putSchedule('anp', '2024-Q1', { scheduledAt: '2024-03-11T15:00:00Z' })).status).toBe(409);
    expect((await h.syncQbr('anp', '2024-Q1')).json).toEqual({ error: 'locked', stage: 'final' });
  });
});
