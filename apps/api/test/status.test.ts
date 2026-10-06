import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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
    const res = await h.putStatus('anp', '2025-Q3', { status: 'draft', force: true, reason: 'cleanup' });
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q3')).toBe('draft');
    const events = ((await h.getAudit('50')).json as { events: Array<{ action: string; target: string; detail?: string }> }).events;
    const entry = events.find((e) => e.target === 'qbr:anp/2025-Q3' && e.detail?.includes('override'));
    expect(entry?.detail).toContain('cleanup');
    expect(entry?.detail).toContain('override');
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
