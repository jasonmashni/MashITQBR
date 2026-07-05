import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-goals-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

describe('client goals endpoint', () => {
  it('validates, normalizes and persists goals; getClientRecord reads them back', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await store.upsertClient({ id: 'gx', name: 'Goal Co' });

    const res = await h.putClientGoals('gx', {
      goals: [
        { title: '  Open two clinics  ', alignment: 'Sizing rollout.', status: 'on_track', targetPeriod: '2026-Q4' },
        { title: 'HIPAA readiness', status: 'nonsense', targetPeriod: 'not-a-quarter' }, // bad status + target → defaults/undefined
        { title: '   ' }, // blank → dropped
      ],
    });
    expect(res.status).toBe(200);
    const goals = (res.json as { client: { goals: Array<Record<string, unknown>> } }).client.goals;
    expect(goals).toHaveLength(2);
    expect(goals[0]!['title']).toBe('Open two clinics'); // trimmed
    expect(goals[0]!['status']).toBe('on_track');
    expect(goals[0]!['targetPeriod']).toBe('2026-Q4');
    expect(typeof goals[0]!['id']).toBe('string');
    expect(goals[1]!['status']).toBe('planned'); // bad status defaulted
    expect(goals[1]!['targetPeriod']).toBeUndefined(); // malformed target dropped

    const read = await h.getClientRecord('gx');
    expect(read.status).toBe(200);
    expect((read.json as { client: { goals: unknown[] } }).client.goals).toHaveLength(2);
  });

  it('404s for an unknown client on both read and write', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.getClientRecord('nope')).status).toBe(404);
    expect((await h.putClientGoals('nope', { goals: [] })).status).toBe(404);
  });
});
