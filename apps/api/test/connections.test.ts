import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonDataStore, LocalSecretStore } from '../src/store/index.js';
import { removeConnection, resolveSecret, saveConnection } from '../src/connections.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-conn-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('saveConnection', () => {
  it('writes secret values to the secret store and keeps only refs on the record', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, {
      type: 'checkpoint',
      label: 'Check Point HEC',
      config: { baseUrl: 'https://cloudinfra-gw.portal.checkpoint.com' },
      secrets: { token: 'super-secret-token' },
    });

    // The record must not contain the secret value — only a reference.
    const serialized = JSON.stringify(conn);
    expect(serialized).not.toContain('super-secret-token');
    expect(conn.secretRefs['token']).toBe(`conn-${conn.id}--token`);
    expect(conn.config['baseUrl']).toContain('checkpoint.com');

    // The value is retrievable from the secret store.
    expect(await resolveSecret(secrets, conn, 'token')).toBe('super-secret-token');
    expect(await secrets.get(conn.secretRefs['token']!)).toBe('super-secret-token');
  });

  it('leaves an existing secret unchanged when the field is blank on update', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const created = await saveConnection(store, secrets, { type: 'huntress', label: 'H', secrets: { apiKey: 'k1' } });
    const updated = await saveConnection(store, secrets, { id: created.id, type: 'huntress', label: 'H (renamed)', secrets: { apiKey: '' } });
    expect(updated.label).toBe('H (renamed)');
    expect(await resolveSecret(secrets, updated, 'apiKey')).toBe('k1'); // unchanged
  });

  it('purges secrets on delete', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, { type: 'zomentum', label: 'Z', secrets: { token: 't' } });
    await removeConnection(store, secrets, conn.id);
    expect(await store.getConnection(conn.id)).toBeUndefined();
    expect(await secrets.get(conn.secretRefs['token']!)).toBeUndefined();
  });
});

describe('secret store safety in Azure', () => {
  const saved = { site: process.env['WEBSITE_INSTANCE_ID'], kv: process.env['KEY_VAULT_URL'], data: process.env['QBR_DATA_DIR'] };
  let hdir: string;
  beforeAll(() => {
    hdir = mkdtempSync(join(tmpdir(), 'qbr-conn-h-'));
    process.env['QBR_DATA_DIR'] = hdir;
    delete process.env['AzureWebJobsStorage'];
    delete process.env['KEY_VAULT_URL'];
  });
  afterAll(() => {
    rmSync(hdir, { recursive: true, force: true });
    for (const [k, v] of [['WEBSITE_INSTANCE_ID', saved.site], ['KEY_VAULT_URL', saved.kv], ['QBR_DATA_DIR', saved.data]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('behaves as before outside Azure', async () => {
    delete process.env['WEBSITE_INSTANCE_ID'];
    const h = await import('../src/handlers.js');
    expect(((await h.getSystem()).json as { secretStore: string }).secretStore).toBe('local');
    const res = await h.saveIntegration({ type: 'huntress', label: 'H', secrets: { apiKey: 'k', apiSecret: 's' } });
    expect(res.status).toBe(200);
  });

  it('in Azure without Key Vault: reports local-insecure and refuses to store secrets', async () => {
    process.env['WEBSITE_INSTANCE_ID'] = 'abc';
    const h = await import('../src/handlers.js');
    expect(((await h.getSystem()).json as { secretStore: string }).secretStore).toBe('local-insecure');
    const res = await h.saveIntegration({ type: 'huntress', label: 'H2', secrets: { apiKey: 'k', apiSecret: 's' } });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toMatch(/Key Vault/);
    // A save that carries no secret values (label/config edit) is still allowed.
    expect((await h.saveIntegration({ type: 'huntress', label: 'H3', secrets: { apiKey: '' } })).status).toBe(200);
  });
});
