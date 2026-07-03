import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import {
  collectHaloDirect,
  createHaloTicket,
  fetchHaloMeta,
  haloToken,
  listHaloClients,
  normalizeHaloFinance,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@mashit/integrations';

/** Fake HTTP transport: routes by URL substring, records requests. */
function fakeHttp(routes: Array<{ match: (req: HttpRequest) => boolean; respond: (req: HttpRequest) => HttpResponse }>) {
  const requests: HttpRequest[] = [];
  const http: HttpTransport = {
    async request(req) {
      requests.push(req);
      const r = routes.find((x) => x.match(req));
      if (!r) return { status: 404, json: { error: `no fake for ${req.url}` } };
      return r.respond(req);
    },
  };
  return { http, requests };
}

const tokenRoute = (token = 'tok-1') => ({
  match: (r: HttpRequest) => r.url.includes('/auth/token'),
  respond: (r: HttpRequest) => {
    // Form-encoded client_credentials body
    expect(r.headers?.['Content-Type']).toContain('application/x-www-form-urlencoded');
    expect(r.body).toContain('grant_type=client_credentials');
    expect(r.body).toContain('scope=all');
    return { status: 200, json: { access_token: token, expires_in: 3600 } };
  },
});

describe('haloToken', () => {
  it('exchanges and caches a client_credentials token', async () => {
    const { http, requests } = fakeHttp([tokenRoute()]);
    const cfg = { baseUrl: 'https://x.halopsa.com', clientId: 'cache-test-1', clientSecret: 's' };
    expect(await haloToken(http, cfg)).toBe('tok-1');
    expect(await haloToken(http, cfg)).toBe('tok-1');
    expect(requests.length).toBe(1); // second call hit the cache
  });

  it('appends the tenant when configured and surfaces exchange failures', async () => {
    const { http, requests } = fakeHttp([
      { match: (r) => r.url.includes('/auth/token'), respond: () => ({ status: 401, json: { error_description: 'bad secret' } }) },
    ]);
    await expect(haloToken(http, { baseUrl: 'https://x.halopsa.com', clientId: 'cache-test-2', clientSecret: 'nope', tenant: 'mash' })).rejects.toThrow(
      /bad secret/,
    );
    expect(requests[0]!.url).toContain('tenant=mash');
  });
});

describe('collectHaloDirect', () => {
  it('pulls date-windowed tickets, open snapshot, and finance metrics', async () => {
    const period = makePeriod(2026, 1);
    const { http } = fakeHttp([
      tokenRoute(),
      {
        match: (r) => r.url.includes('/api/Tickets') && r.url.includes('datesearch=dateoccurred'),
        respond: () => ({
          status: 200,
          json: {
            record_count: 141,
            tickets: [
              { id: 1, tickettype_name: 'Incident' },
              { id: 2, tickettype_name: 'Service Request' },
              { id: 3, tickettype_name: 'Change Request' },
            ],
          },
        }),
      },
      {
        match: (r) => r.url.includes('/api/Tickets') && r.url.includes('datesearch=dateclosed'),
        respond: () => ({ status: 200, json: { record_count: 135, tickets: [] } }),
      },
      {
        match: (r) => r.url.includes('/api/Tickets') && r.url.includes('open_only=true'),
        respond: () => ({ status: 200, json: { record_count: 9, tickets: [] } }),
      },
      {
        match: (r) => r.url.includes('/api/ClientContract'),
        respond: () => ({ status: 200, json: { record_count: 2, contracts: [{ monthlyvalue: 4200 }, { monthlyvalue: 850 }] } }),
      },
      {
        match: (r) => r.url.includes('/api/Invoice'),
        respond: () => ({
          status: 200,
          json: {
            record_count: 3,
            invoices: [
              { invoicedate: '2026-01-15', nettotal: 5000 },
              { invoicedate: '2026-02-15', nettotal: 5100 },
              { invoicedate: '2025-11-15', nettotal: 4900 }, // outside the quarter
            ],
          },
        }),
      },
    ]);

    const out = await collectHaloDirect(
      { clientId: 'anp', period, externalRef: '35' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'collect-1', clientSecret: 's' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(141); // record_count, not row count
    expect(by['tickets.incidents']).toBe(1);
    expect(by['tickets.closed']).toBe(135);
    expect(by['tickets.open']).toBe(9);
    expect(by['finance.mrr']).toBe(5050);
    expect(by['finance.quarter_invoiced']).toBe(10100); // Nov invoice excluded
    // Sampled breakdown (3 rows of 141) warns
    expect(out.warnings.some((w) => w.includes('sampled'))).toBe(true);
  });

  it('degrades per-endpoint with warnings instead of failing the sync', async () => {
    const period = makePeriod(2026, 1);
    const { http } = fakeHttp([tokenRoute()]); // every /api call 404s
    const out = await collectHaloDirect(
      { clientId: 'anp', period, externalRef: '35' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'collect-2', clientSecret: 's' },
    );
    expect(out.metrics).toHaveLength(0);
    expect(out.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('warns when no Halo client is mapped', async () => {
    const { http } = fakeHttp([]);
    const out = await collectHaloDirect({ clientId: 'anp', period: makePeriod(2026, 1) }, http, {
      baseUrl: 'https://x.halopsa.com',
      clientId: 'collect-3',
      clientSecret: 's',
    });
    expect(out.warnings[0]).toMatch(/No Halo client mapped/);
  });
});

describe('normalizeHaloFinance', () => {
  it('warns when contracts carry no recognizable monthly value', () => {
    const { metrics, warnings } = normalizeHaloFinance({
      contracts: [{ ref: 'C-1' }],
      invoices: [],
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
    });
    expect(metrics).toHaveLength(0);
    expect(warnings[0]).toMatch(/no recognizable recurring monthly value/);
  });

  it('includes invoices dated on the inclusive period end', () => {
    const { metrics } = normalizeHaloFinance({
      contracts: [],
      invoices: [{ invoicedate: '2026-03-31', total: 100 }],
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
    });
    expect(metrics[0]!.value).toBe(100);
  });
});

describe('listHaloClients / fetchHaloMeta / createHaloTicket', () => {
  it('lists active clients and the push-modal lookup lists', async () => {
    const { http } = fakeHttp([
      tokenRoute(),
      {
        match: (r) => r.url.includes('/api/Client'),
        respond: () => ({ status: 200, json: { clients: [{ id: 35, name: 'ANP Enertech' }, { id: 36, name: 'Old Co', inactive: true }] } }),
      },
      { match: (r) => r.url.includes('/api/TicketType'), respond: () => ({ status: 200, json: [{ id: 1, name: 'Incident' }] }) },
      { match: (r) => r.url.includes('/api/Agent'), respond: () => ({ status: 200, json: [{ id: 7, name: 'Jason Mashni' }] }) },
      { match: (r) => r.url.includes('/api/Team'), respond: () => ({ status: 200, json: [{ id: 2, name: 'Service Desk' }] }) },
      { match: (r) => r.url.includes('/api/Priority'), respond: () => ({ status: 200, json: [{ id: 4, name: 'Low' }] }) },
    ]);
    const cfg = { baseUrl: 'https://x.halopsa.com', clientId: 'meta-1', clientSecret: 's' };

    const clients = await listHaloClients(http, cfg);
    expect(clients).toEqual([{ id: 35, name: 'ANP Enertech' }]);

    const meta = await fetchHaloMeta(http, cfg);
    expect(meta.ticketTypes).toEqual([{ id: '1', name: 'Incident' }]);
    expect(meta.agents[0]!.name).toBe('Jason Mashni');
    expect(meta.teams[0]!.name).toBe('Service Desk');
    expect(meta.priorities[0]!.name).toBe('Low');
  });

  it('creates a ticket with full field control (array POST body)', async () => {
    let posted: unknown;
    const { http } = fakeHttp([
      tokenRoute(),
      {
        match: (r) => r.method === 'POST' && r.url.includes('/api/Tickets'),
        respond: (r) => {
          posted = JSON.parse(r.body ?? '[]');
          return { status: 201, json: [{ id: 69696, status_id: 1 }] };
        },
      },
    ]);
    const out = await createHaloTicket(
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'push-1', clientSecret: 's' },
      { summary: 'Replace LAP-006', details: 'Warranty expired', clientId: '35', ticketTypeId: '1', agentId: '7', team: 'Service Desk', priorityId: '4' },
    );
    expect(out.id).toBe('69696');
    expect(posted).toEqual([
      { summary: 'Replace LAP-006', details: 'Warranty expired', client_id: 35, tickettype_id: 1, agent_id: 7, team: 'Service Desk', priority_id: 4 },
    ]);
  });
});
