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
