import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscussionItem, QbrDiscussion } from '@mashit/core';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-since-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
  delete process.env['ANTHROPIC_API_KEY'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

const lock = { at: '2026-01-10T00:00:00Z', by: 'jason', version: 1 };

const previousItems: DiscussionItem[] = [
  { id: 'p-hidden', topic: 'Hidden', includeInReport: false, sortOrder: 0 },
  { id: 'p-ticket', topic: 'Clock-in tablet', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41882', status: 'Open' }, sortOrder: 1 },
  { id: 'p-sso', topic: 'SSO rollout', status: 'discussed', response: 'Phase one first', sortOrder: 2 },
  { id: 'p-wait', topic: 'Studio 5000 access', status: 'planned', sortOrder: 3 },
];

/** Previous quarter `prev` (final-locked) with the items above; current quarter `cur` with one agenda item. */
async function seed(clientId: string, prev: string, cur: string) {
  const { getDataStore } = await import('../src/store/index.js');
  const store = getDataStore();
  await store.putDiscussion({ clientId, period: prev, items: previousItems });
  await store.upsertQbr({ clientId, period: prev, status: 'completed', updatedAt: lock.at, locks: { preread: lock, final: { ...lock, version: 2 } } });
  await store.putDiscussion({ clientId, period: cur, items: [{ id: 'c1', topic: 'Firewall refresh', status: 'planned' }] });
}

const body = (sinceOverrides: unknown) => ({ items: [{ id: 'c1', topic: 'Firewall refresh', status: 'planned' }], knownIds: ['c1'], sinceOverrides });

describe('GET since', () => {
  it('returns computed and effective statuses for a final-locked previous quarter', async () => {
    const h = await import('../src/handlers.js');
    await seed('anp', '2025-Q1', '2025-Q2');
    const put = await h.putDiscussion('anp', '2025-Q2', body({ 'p-sso': { status: 'done', note: 'Live for all staff' } }));
    expect(put.status).toBe(200);

    const res = await h.getSince('anp', '2025-Q2');
    expect(res.status).toBe(200);
    const rows = (res.json as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.map((r) => [r['id'], r['computed'], r['effective']])).toEqual([
      ['p-ticket', 'in_progress', 'in_progress'],
      ['p-sso', 'in_progress', 'done'],
      ['p-wait', 'waiting', 'waiting'],
    ]);
    expect(rows[0]!['ticket']).toEqual({ id: '41882', status: 'Open' });
    expect(rows[1]!['note']).toBe('Live for all staff');
    expect(rows[1]!['override']).toMatchObject({ status: 'done', note: 'Live for all staff', by: 'system' });
  });

  it('is empty when there was no previous quarter discussion', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.getSince('anp', '2019-Q1');
    expect(res.json).toEqual({ rows: [] });
  });
});

describe('PUT discussion with sinceOverrides', () => {
  it('validates keys, status and note length', async () => {
    const h = await import('../src/handlers.js');
    await seed('anp', '2024-Q1', '2024-Q2');
    expect((await h.putDiscussion('anp', '2024-Q2', body({ nope: { status: 'done' } }))).status).toBe(400);
    expect((await h.putDiscussion('anp', '2024-Q2', body({ 'p-sso': { status: 'finished' } }))).status).toBe(400);
    expect((await h.putDiscussion('anp', '2024-Q2', body({ 'p-sso': { status: 'done', note: 'x'.repeat(201) } }))).status).toBe(400);
    expect((await h.putDiscussion('anp', '2024-Q2', body({ 'p-sso': { status: 'done', note: 42 } }))).status).toBe(400);
    expect((await h.putDiscussion('anp', '2024-Q2', body(['p-sso']))).status).toBe(400);
    const ok = await h.putDiscussion('anp', '2024-Q2', body({ 'p-sso': { status: 'dropped', note: `  ${'y'.repeat(200)}  `, at: 'forged', by: 'forged' } }));
    expect(ok.status).toBe(200);
    const saved = (ok.json as QbrDiscussion).sinceOverrides!['p-sso']!;
    expect(saved.note).toBe('y'.repeat(200));
    expect(saved.by).toBe('system');
    expect(saved.at).not.toBe('forged');
    expect(Number.isNaN(Date.parse(saved.at))).toBe(false);
  });

  it('stamps the actor, keeps the stamp when unchanged, drops an empty note, and keeps overrides on a save without them', async () => {
    const h = await import('../src/handlers.js');
    const { runWithActor } = await import('../src/requestContext.js');
    await seed('anp', '2024-Q3', '2024-Q4');
    const first = await runWithActor('jason@mashit.net', () => h.putDiscussion('anp', '2024-Q4', body({ 'p-wait': { status: 'waiting', note: '   ' } })));
    const o1 = (first.json as QbrDiscussion).sinceOverrides!['p-wait']!;
    expect(o1).toMatchObject({ status: 'waiting', by: 'jason@mashit.net' });
    expect(o1.note).toBeUndefined();
    const again = await runWithActor('anne@mashit.net', () => h.putDiscussion('anp', '2024-Q4', body({ 'p-wait': { status: 'waiting' } })));
    expect((again.json as QbrDiscussion).sinceOverrides!['p-wait']).toEqual(o1);
    const plain = await h.putDiscussion('anp', '2024-Q4', { items: [{ id: 'c1', topic: 'Firewall refresh' }], knownIds: ['c1'] });
    expect((plain.json as QbrDiscussion).sinceOverrides).toEqual({ 'p-wait': o1 });
    const cleared = await h.putDiscussion('anp', '2024-Q4', body({}));
    expect((cleared.json as QbrDiscussion).sinceOverrides ?? {}).toEqual({});
  });

  it('audits qbr.since with counts only', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    await seed('anp', '2023-Q1', '2023-Q2');
    await h.putDiscussion('anp', '2023-Q2', body({ 'p-sso': { status: 'done', note: 'Private detail' }, 'p-wait': { status: 'dropped' } }));
    await new Promise((r) => setTimeout(r, 20));
    const entry = (await getDataStore().listAudit(50)).find((e) => e.action === 'qbr.since' && e.target === 'qbr:anp/2023-Q2');
    expect(entry).toBeDefined();
    expect(entry!.detail).toBe('2 override(s)');
  });

  it('refuses on a final-locked current quarter', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    await seed('anp', '2023-Q3', '2023-Q4');
    await getDataStore().upsertQbr({ clientId: 'anp', period: '2023-Q4', status: 'completed', updatedAt: lock.at, locks: { preread: lock, final: { ...lock, version: 2 } } });
    const res = await h.putDiscussion('anp', '2023-Q4', body({ 'p-sso': { status: 'done' } }));
    expect(res.status).toBe(409);
  });

  it('accepts overrides on a pre-read-locked current quarter', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    await seed('anp', '2022-Q1', '2022-Q2');
    await getDataStore().upsertQbr({ clientId: 'anp', period: '2022-Q2', status: 'scheduled', updatedAt: lock.at, locks: { preread: lock } });
    const res = await h.putDiscussion('anp', '2022-Q2', body({ 'p-sso': { status: 'done' } }));
    expect(res.status).toBe(200);
    expect((res.json as QbrDiscussion).sinceOverrides?.['p-sso']?.status).toBe('done');
  });
});

describe('frozen packages', () => {
  it('an override set after the pre-read appears in the final package', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { loadPackageModel } = await import('../src/packages.js');
    const { SEED_SNAPSHOTS } = await import('@mashit/core');
    const store = getDataStore();
    const snap = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
    await store.putSnapshot({ ...snap, period: '2021-Q2' });
    await store.putDiscussion({ clientId: 'anp', period: '2021-Q1', items: previousItems });
    await store.putDiscussion({ clientId: 'anp', period: '2021-Q2', items: [{ id: 'c1', topic: 'Firewall refresh', status: 'planned' }] });

    expect((await h.markPackageSent('anp', '2021-Q2')).status).toBe(200);
    const put = await h.putDiscussion('anp', '2021-Q2', body({ 'p-sso': { status: 'dropped', note: 'No longer needed' } }));
    expect(put.status).toBe(200);
    expect((await h.finalizeQbr('anp', '2021-Q2')).status).toBe(200);

    const [v1, v2] = await store.listPackages('anp', '2021-Q2');
    const m1 = (await loadPackageModel(getDocStore(), v1!))!.model;
    const m2 = (await loadPackageModel(getDocStore(), v2!))!.model;
    expect(m1.sinceLastQuarter.find((r) => r.topic === 'SSO rollout')).toMatchObject({ status: 'in_progress', detail: 'Phase one first' });
    expect(m2.sinceLastQuarter.find((r) => r.topic === 'SSO rollout')).toEqual({ topic: 'SSO rollout', status: 'closed', detail: 'No longer needed' });
  });
});

describe('review fixes', () => {
  it('a stale override never blocks a save: an unchanged unknown key is pruned, a new unknown key is refused', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const store = getDataStore();
    await seed('anp', '2020-Q1', '2020-Q2');
    const stale = { status: 'done' as const, note: 'Old', at: '2020-05-01T00:00:00Z', by: 'jason' };
    await store.putDiscussion({ clientId: 'anp', period: '2020-Q2', items: [{ id: 'c1', topic: 'Firewall refresh', status: 'planned' }], sinceOverrides: { gone: stale } });

    // The web sends back what it loaded, the stale key included.
    const echoed = await h.putDiscussion('anp', '2020-Q2', body({ gone: { status: 'done', note: 'Old', at: stale.at, by: stale.by }, 'p-sso': { status: 'done' } }));
    expect(echoed.status).toBe(200);
    expect(Object.keys((echoed.json as QbrDiscussion).sinceOverrides ?? {})).toEqual(['p-sso']);

    // A plain agenda save prunes it too.
    await store.putDiscussion({ ...(await store.getDiscussion('anp', '2020-Q2'))!, sinceOverrides: { gone: stale, 'p-sso': stale } });
    const plain = await h.putDiscussion('anp', '2020-Q2', { items: [{ id: 'c1', topic: 'Firewall refresh' }], knownIds: ['c1'] });
    expect(plain.status).toBe(200);
    expect(Object.keys((plain.json as QbrDiscussion).sinceOverrides ?? {})).toEqual(['p-sso']);

    // A changed or new unknown key is still refused.
    await store.putDiscussion({ ...(await store.getDiscussion('anp', '2020-Q2'))!, sinceOverrides: { gone: stale } });
    expect((await h.putDiscussion('anp', '2020-Q2', body({ gone: { status: 'waiting', note: 'Old' } }))).status).toBe(400);
    expect((await h.putDiscussion('anp', '2020-Q2', body({ brandnew: { status: 'done' } }))).status).toBe(400);
  });

  it('a carried item takes its sourceTopic from last quarter and must name a last quarter item (HIPAA client)', async () => {
    const h = await import('../src/handlers.js');
    await seed('mp', '2020-Q3', '2020-Q4');
    const carried = { id: 'n1', topic: 'SSO rollout', status: 'planned', source: 'carried', sourceRef: 'p-sso', includeInReport: true };
    const res = await h.putDiscussion('mp', '2020-Q4', { items: [carried] });
    expect(res.status).toBe(200);
    expect((res.json as QbrDiscussion).items[0]).toMatchObject({ source: 'carried', sourceRef: 'p-sso', sourceTopic: 'SSO rollout', includeInReport: false });
    const forged = await h.putDiscussion('mp', '2020-Q4', { items: [{ ...carried, id: 'n2', sourceRef: 'not-last-quarter' }] });
    expect(forged.status).toBe(400);
  });

  it('refuses prototype-polluting item ids and keeps overrides on a null-prototype map', async () => {
    const h = await import('../src/handlers.js');
    await seed('anp', '2019-Q3', '2019-Q4');
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect((await h.putDiscussion('anp', '2019-Q4', { items: [{ id, topic: 'x' }] })).status).toBe(400);
    }
    const polluted = JSON.parse('{"__proto__": {"status": "done"}}');
    expect((await h.putDiscussion('anp', '2019-Q4', body(polluted))).status).toBe(400);
    const { normalizeSinceOverrides } = await import('../src/since.js');
    const r = await normalizeSinceOverrides('anp', '2019-Q4', { 'p-sso': { status: 'done' } }, undefined, 'me', 'now');
    expect(r.ok && Object.getPrototypeOf(r.value)).toBeNull();
  });
});

describe('last quarter cannot be read', () => {
  const UNREADABLE = 'Last quarter could not be read; try again.';
  async function failingPrevious(prev: string) {
    const { getDataStore } = await import('../src/store/index.js');
    const store = getDataStore();
    const original = store.getDiscussion.bind(store);
    return vi.spyOn(store, 'getDiscussion').mockImplementation(async (clientId, period) => {
      if (period === prev) throw new Error('storage unavailable');
      return original(clientId, period);
    });
  }

  it('GET since answers 503', async () => {
    const h = await import('../src/handlers.js');
    await seed('anp', '2018-Q1', '2018-Q2');
    const spy = await failingPrevious('2018-Q1');
    try {
      const res = await h.getSince('anp', '2018-Q2');
      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: UNREADABLE });
    } finally {
      spy.mockRestore();
    }
  });

  it('PUT keeps stored overrides unpruned, accepts stored keys, and answers 503 for a new key or a new carried item', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const store = getDataStore();
    await seed('anp', '2018-Q3', '2018-Q4');
    const kept = { status: 'done' as const, at: '2018-11-01T00:00:00Z', by: 'jason' };
    await store.putDiscussion({ ...(await store.getDiscussion('anp', '2018-Q4'))!, sinceOverrides: { 'p-sso': kept, gone: kept } });
    const spy = await failingPrevious('2018-Q3');
    try {
      const plain = await h.putDiscussion('anp', '2018-Q4', { items: [{ id: 'c1', topic: 'Firewall refresh' }], knownIds: ['c1'] });
      expect(plain.status).toBe(200);
      expect((plain.json as QbrDiscussion).sinceOverrides).toEqual({ 'p-sso': kept, gone: kept });

      const changed = await h.putDiscussion('anp', '2018-Q4', body({ 'p-sso': { status: 'waiting' }, gone: { status: 'done' } }));
      expect(changed.status).toBe(200);
      expect((changed.json as QbrDiscussion).sinceOverrides).toMatchObject({ 'p-sso': { status: 'waiting' }, gone: kept });

      const fresh = await h.putDiscussion('anp', '2018-Q4', body({ 'p-sso': { status: 'waiting' }, 'p-wait': { status: 'done' } }));
      expect(fresh.status).toBe(503);
      expect(fresh.json).toEqual({ error: UNREADABLE });

      const carried = await h.putDiscussion('anp', '2018-Q4', { items: [{ id: 'n1', topic: 'SSO rollout', source: 'carried', sourceRef: 'p-sso' }] });
      expect(carried.status).toBe(503);
      expect(carried.json).toEqual({ error: UNREADABLE });
    } finally {
      spy.mockRestore();
    }
  });
});
