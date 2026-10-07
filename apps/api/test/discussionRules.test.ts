import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscussionItem } from '@mashit/core';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-discrules-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

const itemsOf = (res: { json?: unknown }) => (res.json as { items: DiscussionItem[] }).items;

describe('HIPAA clients: source topics stay off the report until rewritten', () => {
  const sourced = (source: DiscussionItem['source'], topic: string, sourceTopic: string): DiscussionItem => ({
    id: `${source}-${topic}`.replace(/\W+/g, '-'),
    topic,
    sourceTopic,
    source,
    status: 'planned',
    includeInReport: true,
  });

  it('forces includeInReport false while the topic equals sourceTopic, for suggested, halo and email', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putDiscussion('mp', '2026-Q1', {
      items: [
        sourced('suggested', 'Patient chart access for Dr Smith', 'Patient chart access for Dr Smith'),
        sourced('halo', 'Printer jam in exam room', 'Printer jam in exam room'),
        sourced('email', '  Fax for Jane Doe  ', 'Fax for Jane Doe'),
      ],
    });
    expect(res.status).toBe(200);
    expect(itemsOf(res).map((i) => i.includeInReport)).toEqual([false, false, false]);
  });

  it('keeps includeInReport once the topic was rewritten', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putDiscussion('mp', '2026-Q1', {
      items: [sourced('suggested', 'Access review for clinical staff', 'Patient chart access for Dr Smith')],
    });
    expect(itemsOf(res)[0]!.includeInReport).toBe(true);
  });

  it('uses the stored sourceTopic, so dropping it from the body does not bypass the rule', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    await getDataStore().putDiscussion({ clientId: 'mp', period: '2026-Q2', items: [sourced('halo', 'Lab results for J Doe', 'Lab results for J Doe')] });
    const res = await h.putDiscussion('mp', '2026-Q2', {
      items: [{ id: 'halo-Lab-results-for-J-Doe', topic: 'Lab results for J Doe', source: 'halo', includeInReport: true }],
    });
    expect(itemsOf(res)[0]).toMatchObject({ includeInReport: false, sourceTopic: 'Lab results for J Doe' });
  });

  it('leaves non-HIPAA clients and hand-typed items alone', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putDiscussion('anp', '2026-Q1', { items: [sourced('halo', 'Printer jam', 'Printer jam')] });
    expect(itemsOf(res)[0]!.includeInReport).toBe(true);
    const typed = await h.putDiscussion('mp', '2026-Q3', { items: [{ id: 'x', topic: 'Budget for next year', includeInReport: true }] });
    expect(itemsOf(typed)[0]!.includeInReport).toBe(true);
  });
});

describe('putDiscussion validates item shapes', () => {
  it('answers 400 listing the malformed indexes and stores nothing', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const res = await h.putDiscussion('anp', '2026-Q2', {
      items: [
        { id: 'ok', topic: 'Fine' },
        { id: 'a' },
        { id: '', topic: 'No id' },
        { id: 'b', topic: '   ' },
        'junk',
        { id: 'c', topic: 'Bad status', status: 'done' },
        { id: 'd', topic: 'Discussed', status: 'discussed' },
      ],
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/1, 2, 3, 4, 5/);
    expect(await getDataStore().getDiscussion('anp', '2026-Q2')).toBeUndefined();
  });

  it('lock 1 survives a stored agenda item with no topic', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const { SEED_SNAPSHOTS } = await import('@mashit/core');
    const seed = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
    await getDataStore().putSnapshot({ ...seed, period: '2020-Q4' });
    await getDataStore().putDiscussion({ clientId: 'anp', period: '2020-Q4', items: [{ id: 'broken' } as unknown as DiscussionItem] });
    const res = await h.markPackageSent('anp', '2020-Q4');
    expect(res.status).toBe(200);
  });
});
