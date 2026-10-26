import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse, HttpTransport } from '@mashit/integrations';
import { JsonDataStore } from '../src/store/index.js';
import type { DataStore } from '../src/store/types.js';
import type { SecretStore } from '../src/store/secretStore.js';
import { ensureQbrParentTicket, pushAction } from '../src/actions.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-halo-parent-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secrets: SecretStore = {
  async set() {},
  async get(name) {
    return name === 'halo--clientSecret' ? 'shh' : undefined;
  },
  async delete() {},
};

async function haloConn(store: DataStore, clientId: string) {
  const now = new Date().toISOString();
  await store.upsertConnection({
    id: 'halo',
    type: 'halo',
    label: 'Halo',
    config: { baseUrl: 'https://parent.halopsa.com', clientId },
    secretRefs: { clientSecret: 'halo--clientSecret' },
    createdAt: now,
    updatedAt: now,
  });
}

/** A fake Halo that numbers created records from 500 and records every POST body. */
function fakeHalo(opts: { ticket?: (id: string) => HttpResponse; failTicketPost?: HttpResponse } = {}) {
  const posts: Array<{ path: string; body: Array<Record<string, unknown>> }> = [];
  let next = 500;
  const http: HttpTransport = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (req.url.includes('/auth/token')) return { status: 200, json: { access_token: 't', expires_in: 3600 } };
      const path = new URL(req.url).pathname.replace(/^\/api\//, '');
      if (req.method === 'POST') {
        const body = JSON.parse(req.body ?? '[]') as Array<Record<string, unknown>>;
        posts.push({ path, body });
        if (path === 'Tickets' && opts.failTicketPost) return opts.failTicketPost;
        return { status: 201, json: { id: next++, status_name: 'New' } };
      }
      const m = /^Tickets\/(\d+)$/.exec(path);
      if (m) return opts.ticket ? opts.ticket(m[1]!) : { status: 200, json: { id: Number(m[1]) } };
      return { status: 404, json: {} };
    },
  };
  return { http, posts };
}

describe('pushAction with a direct Halo connection', () => {
  it('creates a Halo opportunity through /api/Opportunities, not the legacy MCP', async () => {
    const store = new JsonDataStore(join(dir, 'opp'));
    await haloConn(store, 'opp-direct');
    const { http, posts } = fakeHalo();
    const res = await pushAction({ store, secrets, http }, {
      target: 'halo_opportunity', title: 'Server refresh', detail: 'Host is out of warranty', externalClientRef: '35', value: 12000, valueKind: 'one_time',
    });
    expect(res).toEqual({ system: 'halo', id: '500', status: 'New' });
    expect(posts).toEqual([{ path: 'Opportunities', body: [{ summary: 'Server refresh', details: 'Host is out of warranty', client_id: 35, oppvalue_oneoff: 12000 }] }]);
  });

  it('files a ticket under the parent it is given', async () => {
    const store = new JsonDataStore(join(dir, 'child'));
    await haloConn(store, 'child-direct');
    const { http, posts } = fakeHalo();
    const res = await pushAction({ store, secrets, http }, { target: 'halo_ticket', title: 'Replace LAP-006', detail: '', externalClientRef: '35', parentTicketId: '77' });
    expect(res.parentId).toBe('77');
    expect(posts[0]!.body[0]!['parent_id']).toBe(77);
  });
});

describe('ensureQbrParentTicket', () => {
  const base = { clientName: 'ANP Enertech', periodLabel: 'Q3 2026', externalClientRef: '35', ticketTypeId: '3', agentId: '7', team: 'Service Desk' };

  it('creates "QBR - client - quarter" with the routing of the first ticket', async () => {
    const store = new JsonDataStore(join(dir, 'create'));
    await haloConn(store, 'parent-create');
    const { http, posts } = fakeHalo();
    const out = await ensureQbrParentTicket({ store, secrets, http }, { ...base, periodLabel: 'Q1 2026' });
    expect(out).toEqual({ id: '500', created: true });
    expect(posts[0]!.path).toBe('Tickets');
    expect(posts[0]!.body[0]).toMatchObject({ summary: 'QBR - ANP Enertech - Q1 2026', client_id: 35, tickettype_id: 3, agent_id: 7, team: 'Service Desk' });
    expect(posts[0]!.body[0]).not.toHaveProperty('parent_id');
  });

  it('reuses a stored parent that Halo still has', async () => {
    const store = new JsonDataStore(join(dir, 'reuse'));
    await haloConn(store, 'parent-reuse');
    const { http, posts } = fakeHalo();
    expect(await ensureQbrParentTicket({ store, secrets, http }, { ...base, periodLabel: 'Q2 2026', existingId: '41' })).toEqual({ id: '41', created: false });
    expect(posts).toHaveLength(0);
  });

  it('replaces a stored parent that Halo no longer has or reports deleted', async () => {
    const store = new JsonDataStore(join(dir, 'gone'));
    await haloConn(store, 'parent-gone');
    const missing = fakeHalo({ ticket: () => ({ status: 404, json: 'Ticket not found' }) });
    expect(await ensureQbrParentTicket({ store, secrets, http: missing.http }, { ...base, periodLabel: 'Q4 2025', existingId: '41' })).toEqual({ id: '500', created: true });
    const deleted = fakeHalo({ ticket: (id) => ({ status: 200, json: { id: Number(id), deleted: true } }) });
    expect(await ensureQbrParentTicket({ store, secrets, http: deleted.http }, { ...base, periodLabel: 'Q3 2025', existingId: '42' })).toMatchObject({ created: true });
  });

  it('keeps a stored parent when Halo is only having trouble', async () => {
    const store = new JsonDataStore(join(dir, 'flaky'));
    await haloConn(store, 'parent-flaky');
    const { http, posts } = fakeHalo({ ticket: () => ({ status: 503, json: {} }) });
    expect(await ensureQbrParentTicket({ store, secrets, http }, { ...base, periodLabel: 'Q2 2025', existingId: '43' })).toEqual({ id: '43', created: false });
    expect(posts).toHaveLength(0);
  });

  it('makes one parent when two pushes race', async () => {
    const store = new JsonDataStore(join(dir, 'race'));
    await haloConn(store, 'parent-race');
    const { http, posts } = fakeHalo();
    const [a, b] = await Promise.all([
      ensureQbrParentTicket({ store, secrets, http }, { ...base, periodLabel: 'Q1 2025' }),
      ensureQbrParentTicket({ store, secrets, http }, { ...base, periodLabel: 'Q1 2025' }),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(posts).toHaveLength(1);
  });

  it('answers undefined without a direct Halo connection', async () => {
    const store = new JsonDataStore(join(dir, 'none'));
    const { http } = fakeHalo();
    expect(await ensureQbrParentTicket({ store, secrets, http }, base)).toBeUndefined();
  });
});

describe('pushQbrAction files tickets under the QBR ticket', () => {
  let hdir: string;
  beforeAll(() => {
    hdir = mkdtempSync(join(tmpdir(), 'qbr-halo-parent-h-'));
    process.env['QBR_DATA_DIR'] = hdir;
    delete process.env['AzureWebJobsStorage'];
  });
  afterAll(async () => {
    (await import('../src/handlers.js')).__setIntegrationsForTests(undefined);
    rmSync(hdir, { recursive: true, force: true });
    delete process.env['QBR_DATA_DIR'];
  });

  async function wire(http: HttpTransport, connClientId: string) {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const store = getDataStore();
    await h.listClients(); // seeds anp
    await h.updateClient('anp', { integrationRefs: { halo: '35' } });
    await haloConn(store, connClientId);
    h.__setIntegrationsForTests(async () => ({ store, secrets, http }));
    return { h, store };
  }

  it('creates the QBR ticket once and files every ticket from that quarter under it', async () => {
    const { http, posts } = fakeHalo();
    const { h, store } = await wire(http, 'handler-parent');
    const fields = { target: 'halo_ticket' as const, ticketTypeId: '3', agentId: '7', team: 'Service Desk' };

    const first = await h.pushQbrAction('anp', '2026-Q3', { ...fields, title: 'Replace firewall', detail: 'EOL in March' });
    const second = await h.pushQbrAction('anp', '2026-Q3', { ...fields, title: 'MFA for shared mailbox' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const tickets = posts.filter((p) => p.path === 'Tickets').map((p) => p.body[0]!);
    expect(tickets).toHaveLength(3);
    expect(tickets[0]!['summary']).toMatch(/^QBR - .+ - Q3 2026$/);
    expect(tickets[1]).toMatchObject({ summary: 'Replace firewall', parent_id: 500 });
    expect(tickets[2]).toMatchObject({ summary: 'MFA for shared mailbox', parent_id: 500 });
    expect((first.json as { parentId?: string }).parentId).toBe('500');
    expect((await store.getQbr('anp', '2026-Q3'))?.haloParentTicket?.id).toBe('500');
  });

  it('pushes nothing when Halo refuses the QBR ticket, and says why', async () => {
    const { http, posts } = fakeHalo({ failTicketPost: { status: 400, json: { message: 'Ticket type is not valid for this client' } } });
    const { h } = await wire(http, 'handler-refused');
    const res = await h.pushQbrAction('anp', '2026-Q2', { target: 'halo_ticket', title: 'Replace firewall' });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe(
      'Could not create the QBR ticket in Halo, so nothing was pushed. Halo responded 400 for /api/Tickets: Ticket type is not valid for this client',
    );
    expect(posts).toHaveLength(1);
  });
});
