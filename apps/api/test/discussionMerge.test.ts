import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-discmerge-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

async function seed(period: string) {
  const { getDataStore } = await import('../src/store/index.js');
  await getDataStore().putDiscussion({
    clientId: 'mp',
    period,
    items: [
      { id: 'A', topic: 'Typed by hand', sortOrder: 0 },
      { id: 'B', topic: 'From the inbox', source: 'email', sourceRef: 'm1', sortOrder: 1 },
    ],
  });
}

describe('putDiscussion knownIds', () => {
  it('keeps a stored item the client never loaded', async () => {
    const h = await import('../src/handlers.js');
    await seed('2030-Q1');
    const res = await h.putDiscussion('mp', '2030-Q1', { items: [{ id: 'A', topic: 'Edited', sortOrder: 0 }], knownIds: ['A'] });
    expect(res.status).toBe(200);
    const items = (res.json as { items: Array<{ id: string; topic: string; sortOrder?: number }> }).items;
    expect(items.map((i) => [i.id, i.topic, i.sortOrder])).toEqual([
      ['A', 'Edited', 0],
      ['B', 'From the inbox', 1],
    ]);
  });

  it('deletes a stored item the client loaded and removed', async () => {
    const h = await import('../src/handlers.js');
    await seed('2030-Q2');
    const res = await h.putDiscussion('mp', '2030-Q2', { items: [{ id: 'A', topic: 'Typed by hand' }], knownIds: ['A', 'B'] });
    expect((res.json as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['A']);
  });

  it('without knownIds the body replaces the list as before', async () => {
    const h = await import('../src/handlers.js');
    await seed('2030-Q3');
    const res = await h.putDiscussion('mp', '2030-Q3', { items: [{ id: 'A', topic: 'Typed by hand' }] });
    expect((res.json as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['A']);
    expect(res.json).not.toHaveProperty('knownIds');
  });
});
