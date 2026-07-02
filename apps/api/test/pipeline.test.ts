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
