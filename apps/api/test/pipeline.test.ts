import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionMcpTransport, type HttpRequest, type HttpResponse } from '@mashit/integrations';
import { JsonDataStore, LocalSecretStore } from '../src/store/index.js';
import { saveConnection } from '../src/connections.js';
import { importHaloClients, syncClientMetrics, type Integrations } from '../src/integrationsService.js';
import { pushAction } from '../src/actions.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-pipe-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const text = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('importHaloClients', () => {
  it('imports Halo clients via MCP and upserts them', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const mcp = functionMcpTransport(async (name) => {
      expect(name).toBe('halo_list_clients');
      return text([{ id: 42, name: 'ANP Enertech', sector_name: 'Manufacturing' }]);
    });
    const clients = await importHaloClients({ store, secrets, mcp });
    expect(clients[0]!.id).toBe('halo-42');
    expect(clients[0]!.integrationRefs?.halo).toBe('42');
    expect((await store.getClient('halo-42'))?.name).toBe('ANP Enertech');
  });
});

describe('syncClientMetrics', () => {
  it('pulls Halo (MCP) + Huntress (HTTP) and persists a snapshot', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    await store.upsertClient({ id: 'c1', name: 'Acme', integrationRefs: { halo: '42', huntress: 'org1' } });
    await saveConnection(store, secrets, {
      type: 'huntress', label: 'Huntress', config: { baseUrl: 'https://api.huntress.io/v1' },
      secrets: { apiKey: 'k', apiSecret: 's' },
    });

    const mcp = functionMcpTransport(async (name) =>
      name === 'halo_list_tickets' ? text([{ tickettype_name: 'Incident' }, { tickettype_name: 'Change Request' }]) : text([]),
    );
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('/reports?')) return { status: 200, json: { reports: [{ agents_count: 26 }], pagination: {} } };
        if (req.url.includes('/organizations/')) return { status: 200, json: { organization: { actual_usages: {} } } };
        return { status: 200, json: { identities: [], pagination: {} } };
      },
    };

    const intg: Integrations = { store, secrets, mcp, http };
    const { snapshot } = await syncClientMetrics(intg, 'c1', '2026-Q1', '2026-03-31T00:00:00.000Z');
    const by = Object.fromEntries(snapshot.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(2);
    expect(by['huntress.endpoints']).toBe(26);
    // persisted
    expect((await store.getSnapshot('c1', '2026-Q1'))?.metrics.length).toBeGreaterThan(0);
  });
});

describe('pushAction', () => {
  it('creates a Halo ticket via MCP and returns its id', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    const mcp = functionMcpTransport(async (name) => {
      expect(name).toBe('halo_create_ticket');
      return text({ id: 5678, status: 'New' });
    });
    const res = await pushAction({ store, secrets, mcp }, {
      target: 'halo_ticket', title: 'Replace LAP-006', detail: 'Warranty expired', externalClientRef: '42',
    });
    expect(res).toEqual({ system: 'halo', id: '5678', status: 'New' });
  });

  it('creates a Zomentum opportunity via REST and returns its id', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    await saveConnection(store, secrets, { type: 'zomentum', label: 'Zomentum', config: { baseUrl: 'https://api.zomentum.com' }, secrets: { token: 'zt' } });
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        expect(req.url).toContain('/opportunities');
        expect(req.headers?.['Authorization']).toBe('Bearer zt');
        return { status: 200, json: { id: 'opp-1', stage: 'Qualification' } };
      },
    };
    const res = await pushAction({ store, secrets, http }, {
      target: 'zomentum_opportunity', title: 'Hardware refresh', detail: '4 devices EOL', externalClientRef: 'z-1',
    });
    expect(res).toEqual({ system: 'zomentum', id: 'opp-1', status: 'Qualification' });
  });
});

describe('syncQbr (handler) over fake integrations', () => {
  let hdir: string;
  beforeAll(() => {
    hdir = mkdtempSync(join(tmpdir(), 'qbr-pipe-h-'));
    process.env['QBR_DATA_DIR'] = hdir;
    delete process.env['AzureWebJobsStorage'];
  });
  afterAll(async () => {
    (await import('../src/handlers.js')).__setIntegrationsForTests(undefined);
    rmSync(hdir, { recursive: true, force: true });
    delete process.env['QBR_DATA_DIR'];
  });

  type Secrets = { get(k: string): Promise<string | undefined>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> };
  const memSecrets = (): Secrets => {
    const m = new Map<string, string>();
    return {
      async set(k, v) { m.set(k, v); },
      async get(k) { return m.get(k); },
      async delete(k) { m.delete(k); },
    };
  };
  const huntressHttp = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (req.url.includes('/reports?')) return { status: 200, json: { reports: [{ agents_count: 26 }], pagination: {} } };
      if (req.url.includes('/organizations/')) return { status: 200, json: { organization: { actual_usages: {} } } };
      return { status: 200, json: { identities: [], pagination: {} } };
    },
  };

  async function wire(secrets: Secrets) {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const store = getDataStore();
    await h.listClients(); // seeds anp + its snapshots
    await h.updateClient('anp', { integrationRefs: { huntress: 'org1' } });
    for (const c of await store.listConnections()) if (c.type === 'huntress') await store.deleteConnection(c.id);
    await saveConnection(store, secrets, { type: 'huntress', label: 'Huntress', config: { baseUrl: 'https://api.huntress.io/v1' }, secrets: { apiKey: 'k', apiSecret: 's' } });
    h.__setIntegrationsForTests(async () => ({ store, secrets, http: huntressHttp }));
    return h;
  }

  it('re-sync keeps manual and pdf metrics and persists warnings', async () => {
    const h = await wire(memSecrets());
    await h.putManualMetrics('anp', '2026-Q2', { metrics: [{ label: 'Synology backup success', value: 98, unit: '%', category: 'backup' }] });
    await h.importDocumentMetrics('anp', '2026-Q2', { source: 'pdf:checkpoint', metrics: [{ key: 'email.phishing', label: 'Phishing', value: 12, category: 'security' }] });
    const res = await h.syncQbr('anp', '2026-Q2');
    expect(res.status).toBe(200);
    const body = (await h.getMetrics('anp', '2026-Q2')).json as { snapshot: { metrics: Array<{ key: string }>; warnings?: string[] }; warnings: string[] };
    const keys = body.snapshot.metrics.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['manual.synology_backup_success', 'email.phishing', 'huntress.endpoints']));
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0); // Huntress always reports its known gaps
    expect(body.snapshot.warnings).toEqual(body.warnings);
  });

  it('a kept metric whose key a collector now reports is dropped with a warning', async () => {
    const h = await wire(memSecrets());
    await h.importDocumentMetrics('anp', '2026-Q2', { source: 'pdf:huntress', metrics: [{ key: 'huntress.endpoints', label: 'Endpoints', value: 3, category: 'security' }] });
    await h.syncQbr('anp', '2026-Q2');
    const body = (await h.getMetrics('anp', '2026-Q2')).json as { snapshot: { metrics: Array<{ key: string; value: unknown }> }; warnings: string[] };
    const hits = body.snapshot.metrics.filter((m) => m.key === 'huntress.endpoints');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe(26);
    expect(body.warnings.some((w) => w.includes('huntress.endpoints'))).toBe(true);
  });

  it('a sync where every collector failed keeps the previous snapshot and does not advance', async () => {
    const broken = memSecrets();
    broken.get = async () => {
      throw new Error('vault unreachable');
    };
    const h = await wire(broken);
    const metricsOf = async () => ((await h.getMetrics('anp', '2026-Q1')).json as { snapshot: { metrics: unknown[] } }).snapshot.metrics.length;
    const before = await metricsOf();
    expect(before).toBeGreaterThan(0);
    const res = await h.syncQbr('anp', '2026-Q1');
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/previous data kept/);
    expect(await metricsOf()).toBe(before);
    expect(((await h.getQbr('anp', '2026-Q1', null)).json as { meta: { status: string } }).meta.status).not.toBe('data_synced');
  });
});
