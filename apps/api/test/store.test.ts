import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonDataStore, LocalSecretStore } from '../src/store/index.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-store-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
