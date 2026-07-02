import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionMcpTransport, type HttpRequest, type HttpResponse } from '@mashit/integrations';
import { JsonDataStore, LocalSecretStore } from '../src/store/index.js';
import { saveConnection } from '../src/connections.js';
import { listOrgs, testConnection, type Integrations } from '../src/integrationsService.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-test-conn-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const text = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('testConnection', () => {
  it('pings Huntress /account with basic auth (baseUrl already includes /v1)', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, {
      type: 'huntress',
      label: 'Huntress',
      config: { baseUrl: 'https://api.huntress.io/v1' },
      secrets: { apiKey: 'k', apiSecret: 's' },
    });
    let url = '';
    let auth = '';
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        url = req.url;
        auth = req.headers?.['Authorization'] ?? '';
        return { status: 200, json: {} };
      },
    };
    const out = await testConnection({ store, secrets, http }, conn);
    expect(out.ok).toBe(true);
    expect(url).toBe('https://api.huntress.io/v1/account'); // no doubled /v1
    expect(auth).toBe(`Basic ${Buffer.from('k:s').toString('base64')}`);
  });

  it('reports an auth failure with the response status', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, {
      type: 'zomentum',
      label: 'Zomentum',
      config: {},
      secrets: { token: 'bad' },
    });
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        expect(req.url).toBe('https://api.zomentum.com/v1/opportunities');
        expect(req.headers?.['Authorization']).toBe('Bearer bad');
        return { status: 401, json: {} };
      },
    };
    const out = await testConnection({ store, secrets, http }, conn);
    expect(out.ok).toBe(false);
    expect(out.message).toContain('401');
  });

  it('probes the MASH MCP and reports transport failures', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, { type: 'mcp', label: 'MCP', config: { url: 'https://mcp' } });

    const okMcp = functionMcpTransport(async (name) => {
      expect(name).toBe('halo_list_clients');
      return text([]);
    });
    expect((await testConnection({ store, secrets, mcp: okMcp }, conn)).ok).toBe(true);

    const badMcp = functionMcpTransport(async () => {
      throw new Error('401 unauthorized');
    });
    const bad = await testConnection({ store, secrets, mcp: badMcp }, conn);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('401');

    // No MCP transport configured at all
    const none: Integrations = { store, secrets };
    expect((await testConnection(none, conn)).ok).toBe(false);
  });

  it('reports saved-only for types without a live probe', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, { type: 'checkpoint', label: 'HEC', config: {}, secrets: { token: 't' } });
    const out = await testConnection({ store, secrets }, conn);
    expect(out.ok).toBe(true);
    expect(out.note).toMatch(/next sync/);
  });
});

describe('listOrgs', () => {
  it('pages through Huntress organizations', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const conn = await saveConnection(store, secrets, {
      type: 'huntress',
      label: 'H',
      config: { baseUrl: 'https://api.huntress.io/v1' },
      secrets: { apiKey: 'k', apiSecret: 's' },
    });
    const pages: Record<string, unknown> = {
      first: { organizations: [{ id: 1, name: 'ANP' }], pagination: { next_page_token: 'tok2' } },
      tok2: { organizations: [{ id: 2, name: 'KPCA' }], pagination: {} },
    };
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        const token = new URL(req.url).searchParams.get('page_token') ?? 'first';
        return { status: 200, json: pages[token] ?? { organizations: [] } };
      },
    };
    const orgs = await listOrgs({ store, secrets, http }, conn);
    expect(orgs).toEqual([
      { id: '1', name: 'ANP' },
      { id: '2', name: 'KPCA' },
    ]);
  });

  it('lists Halo clients through the MCP and returns null for unlistable types', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const mcpConn = await saveConnection(store, secrets, { type: 'mcp', label: 'MCP', config: { url: 'https://x/mcp' } });
    const mcp = functionMcpTransport(async () => text([{ id: 42, name: 'ANP Enertech' }]));
    expect(await listOrgs({ store, secrets, mcp }, mcpConn)).toEqual([{ id: '42', name: 'ANP Enertech' }]);

    const cpConn = await saveConnection(store, secrets, { type: 'checkpoint', label: 'HEC', config: {} });
    expect(await listOrgs({ store, secrets }, cpConn)).toBeNull();
  });
});
