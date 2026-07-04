import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkEntityJson, joinEntityJson, JsonDataStore, LocalSecretStore } from '../src/store/index.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-store-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Table entity chunking (64KB string property cap)', () => {
  it('round-trips payloads larger than one property allows', () => {
    const big = JSON.stringify({ metrics: Array.from({ length: 3000 }, (_, i) => ({ key: `m${i}`, value: i, note: 'x'.repeat(40) })) });
    expect(big.length).toBeGreaterThan(60_000);
    const props = chunkEntityJson(big);
    expect(Object.keys(props).length).toBeGreaterThan(2);
    for (const v of Object.values(props)) expect(v.length).toBeLessThanOrEqual(30_000);
    expect(joinEntityJson({ partitionKey: 'p', rowKey: 'r', ...props })).toBe(big);
  });

  it('never splits a surrogate pair across properties', () => {
    const s = '💾'.repeat(20_000); // 40k UTF-16 units of surrogate pairs
    const props = chunkEntityJson(s);
    for (const v of Object.values(props)) {
      const last = v.charCodeAt(v.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no dangling high surrogate
    }
    expect(joinEntityJson({ partitionKey: 'p', rowKey: 'r', ...props })).toBe(s);
  });

  it('small payloads stay a single data property', () => {
    expect(Object.keys(chunkEntityJson('{"a":1}'))).toEqual(['data']);
  });
});

describe('JsonDataStore', () => {
  const store = () => new JsonDataStore(dir);

  it('round-trips clients, connections, config, discussion, and snapshots', async () => {
    const s = store();
    await s.upsertClient({ id: 'c1', name: 'Acme' });
    await s.upsertConnection({
      id: 'k1', type: 'huntress', label: 'Huntress', config: { baseUrl: 'https://api.huntress.io/v1' },
      secretRefs: { apiKey: 'conn-k1--apiKey' }, createdAt: 't', updatedAt: 't',
    });
    await s.putReportConfig({ clientId: 'c1', brand: { name: 'Acme MSP' } });
    await s.putDiscussion({ clientId: 'c1', period: '2026-Q1', items: [{ id: 'd1', topic: 'X' }], notes: 'n' });
    await s.putSnapshot({ clientId: 'c1', period: '2026-Q1', capturedAt: 't', metrics: [] });

    // fresh instance reads from disk
    const s2 = store();
    expect((await s2.listClients()).map((c) => c.id)).toContain('c1');
    expect((await s2.getConnection('k1'))?.type).toBe('huntress');
    expect((await s2.getReportConfig('c1'))?.brand?.name).toBe('Acme MSP');
    expect((await s2.getDiscussion('c1', '2026-Q1'))?.notes).toBe('n');
    expect((await s2.getSnapshot('c1', '2026-Q1'))?.period).toBe('2026-Q1');
  });

  it('deletes connections', async () => {
    const s = store();
    await s.upsertConnection({ id: 'del', type: 'zomentum', label: 'Z', config: {}, secretRefs: {}, createdAt: 't', updatedAt: 't' });
    await s.deleteConnection('del');
    expect(await s.getConnection('del')).toBeUndefined();
  });

  it('round-trips opportunity board cards per client', async () => {
    const store = new JsonDataStore(dir);
    await store.putOpportunity({ id: 'o1', clientId: 'mp', title: 'New location', status: 'idea', createdAt: 'x', updatedAt: 'x' });
    await store.putOpportunity({ id: 'o1', clientId: 'mp', title: 'New location', status: 'approved', createdAt: 'x', updatedAt: 'y' });
    await store.putOpportunity({ id: 'o2', clientId: 'anp', title: 'Server refresh', status: 'idea', createdAt: 'x', updatedAt: 'x' });
    const mp = await store.listOpportunities('mp');
    expect(mp).toHaveLength(1); // same id upserts, not duplicates
    expect(mp[0]!.status).toBe('approved');
    await store.deleteOpportunity('mp', 'o1');
    expect(await store.listOpportunities('mp')).toHaveLength(0);
    expect(await store.listOpportunities('anp')).toHaveLength(1);
  });

  it('round-trips narrative records (and tolerates legacy files without the key)', async () => {
    const s = store();
    // The store file written by earlier tests predates `narratives` — reading must not blow up.
    expect(await s.getNarrative('c1', '2026-Q1')).toBeUndefined();

    const result = {
      output: { headline: 'H', summary_paragraphs: [], highlights: [], recommendations: [], figures_referenced: [] },
      verification: { ok: true, checks: [], failures: [] },
      attempts: 1,
    };
    await s.putNarrative({ clientId: 'c1', period: '2026-Q1', inputHash: 'abc123', result, updatedAt: 't' });

    const rec = await store().getNarrative('c1', '2026-Q1');
    expect(rec?.inputHash).toBe('abc123');
    expect(rec?.result?.output.headline).toBe('H');
  });
});

describe('LocalSecretStore', () => {
  it('sets, gets, and deletes secrets', async () => {
    const secrets = new LocalSecretStore(dir);
    await secrets.set('conn-x--token', 'sk-secret');
    expect(await secrets.get('conn-x--token')).toBe('sk-secret');
    await secrets.delete('conn-x--token');
    expect(await secrets.get('conn-x--token')).toBeUndefined();
  });
});
