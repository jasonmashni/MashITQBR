import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture the collector context Check Point is called with.
const seen: Array<{ clientId: string; externalRef?: string }> = [];
vi.mock('@mashit/integrations', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mashit/integrations')>();
  return {
    ...real,
    collectCheckpoint: async (ctx: { clientId: string; externalRef?: string }) => {
      seen.push({ clientId: ctx.clientId, externalRef: ctx.externalRef });
      return { source: 'checkpoint', metrics: [], warnings: [] };
    },
  };
});

const { JsonDataStore, LocalSecretStore } = await import('../src/store/index.js');
const { saveConnection } = await import('../src/connections.js');
const { syncClientMetrics } = await import('../src/integrationsService.js');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-cpref-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Check Point externalRef', () => {
  it('is left undefined for a client-bound connection with no tenant mapping (never the internal client id)', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    await store.upsertClient({ id: 'cp1', name: 'CP Co' });
    await saveConnection(store, secrets, { type: 'checkpoint', label: 'CP', config: { baseUrl: 'https://x', qbrClientId: 'cp1' }, secrets: { token: 't' } });
    seen.length = 0;
    await syncClientMetrics({ store, secrets, http: { request: async () => ({ status: 200, json: {} }) } }, 'cp1', '2026-Q2');
    expect(seen).toEqual([{ clientId: 'cp1', externalRef: undefined }]);
  });

  it('passes the mapped tenant when one exists', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    await store.upsertClient({ id: 'cp2', name: 'CP Two', integrationRefs: { checkpoint: 'tenant-42' } });
    await saveConnection(store, secrets, { type: 'checkpoint', label: 'CP shared', config: { baseUrl: 'https://x' }, secrets: { token: 't' } });
    seen.length = 0;
    await syncClientMetrics({ store, secrets, http: { request: async () => ({ status: 200, json: {} }) } }, 'cp2', '2026-Q2');
    expect(seen.find((s) => s.clientId === 'cp2')?.externalRef).toBe('tenant-42');
  });
});
