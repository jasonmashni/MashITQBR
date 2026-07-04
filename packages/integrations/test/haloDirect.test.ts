import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import {
  collectHaloDirect,
  createHaloTicket,
  fetchHaloMeta,
  haloToken,
  listHaloClients,
  normalizeHaloFinance,
  tallyHaloSla,
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

  it('sums a comma-separated multi-id mapping (service + billing entities)', async () => {
    const period = makePeriod(2026, 2);
    const ticketsFor = (url: string): HttpResponse => {
      const u = new URL(url);
      const id = u.searchParams.get('client_id');
      if (u.searchParams.get('datesearch') === 'dateoccurred') {
        // Tickets live under 29 only (the "PSC" service entity).
        return { status: 200, json: { record_count: id === '29' ? 12 : 0, tickets: id === '29' ? [{ tickettype_name: 'Incident' }] : [] } };
      }
      if (u.searchParams.get('datesearch') === 'dateclosed') return { status: 200, json: { record_count: id === '29' ? 10 : 0, tickets: [] } };
      if (u.searchParams.get('open_only') === 'true') return { status: 200, json: { record_count: id === '29' ? 5 : 0, tickets: [] } };
      // Unfiltered probe (zero-fallback check for id 62): genuinely no tickets.
      return { status: 200, json: { record_count: 0, tickets: [] } };
    };
    const { http } = fakeHttp([
      tokenRoute(),
      { match: (r) => r.url.includes('/api/Tickets'), respond: (r) => ticketsFor(r.url) },
      {
        match: (r) => r.url.includes('/api/ClientContract'),
        respond: (r) => ({ status: 200, json: { contracts: r.url.includes('client_id=62') ? [{ monthlyvalue: 3000 }] : [] } }),
      },
      {
        match: (r) => r.url.includes('/api/Invoice'),
        respond: (r) => ({
          status: 200,
          json: { invoices: r.url.includes('client_id=62') ? [{ invoicedate: '2026-05-15', nettotal: 10034.25 }] : [] },
        }),
      },
    ]);
    const out = await collectHaloDirect(
      { clientId: 'mp', period, externalRef: '62, 29' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'multi-1', clientSecret: 's' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    // Tickets from 29 + finance from 62, combined on one QBR.
    expect(by['tickets.total']).toBe(12);
    expect(by['tickets.closed']).toBe(10);
    expect(by['tickets.open']).toBe(5);
    expect(by['finance.mrr']).toBe(3000);
    expect(by['finance.quarter_invoiced']).toBe(10034.25);
  });

  it('falls back to client-side date filtering when the server ignores datesearch', async () => {
    const period = makePeriod(2026, 2);
    const allTickets = [
      { id: 1, tickettype_name: 'Incident', dateoccurred: '2026-05-02T10:00:00Z', dateclosed: '2026-05-03T10:00:00Z' },
      { id: 2, tickettype_name: 'Service Request', dateoccurred: '2026-06-20T10:00:00Z' },
      { id: 3, tickettype_name: 'Incident', dateoccurred: '2026-01-05T10:00:00Z', dateclosed: '2026-04-02T10:00:00Z' }, // opened before Q2, closed in Q2
    ];
    const { http } = fakeHttp([
      tokenRoute(),
      {
        match: (r) => r.url.includes('/api/Tickets'),
        respond: (r) => {
          const u = new URL(r.url);
          // The buggy instance: any datesearch-filtered call returns nothing.
          if (u.searchParams.get('datesearch')) return { status: 200, json: { record_count: 0, tickets: [] } };
          if (u.searchParams.get('open_only') === 'true') return { status: 200, json: { record_count: 2, tickets: [] } };
          return { status: 200, json: { record_count: allTickets.length, tickets: allTickets } };
        },
      },
      { match: (r) => r.url.includes('/api/ClientContract'), respond: () => ({ status: 200, json: { contracts: [] } }) },
      { match: (r) => r.url.includes('/api/Invoice'), respond: () => ({ status: 200, json: { invoices: [] } }) },
    ]);
    const out = await collectHaloDirect(
      { clientId: 'mp', period, externalRef: '29' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'fallback-1', clientSecret: 's' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(2); // tickets 1 + 2 opened in Q2
    expect(by['tickets.closed']).toBe(2); // tickets 1 + 3 closed in Q2
    expect(by['tickets.open']).toBe(2);
    expect(by['tickets.incidents']).toBe(1);
  });
});

describe('ticket-type allowlist + SLA', () => {
  it('counts only the allowed ticket types via the server date window and tallies SLA from rows', async () => {
    const period = makePeriod(2026, 2);
    const inQ2 = [
      { id: 1, tickettype_id: 1, tickettype_name: 'Incident', dateoccurred: '2026-05-01T10:00:00Z', sla_response_state: 'Met' },
      { id: 2, tickettype_id: 1, tickettype_name: 'Incident', dateoccurred: '2026-05-02T10:00:00Z', sla_response_state: 'Breached' },
      { id: 3, tickettype_id: 9, tickettype_name: 'Alert', dateoccurred: '2026-05-03T10:00:00Z' }, // excluded type
      { id: 4, tickettype_id: 2, tickettype_name: 'Service Request', dateoccurred: '2026-04-10T10:00:00Z', dateclosed: '2026-04-12T10:00:00Z', sla_response_state: 'Met' },
    ];
    const closedInQ2 = [inQ2[3]!];
    const { http, requests } = fakeHttp([
      tokenRoute(),
      {
        match: (r) => r.url.includes('/api/Tickets'),
        respond: (r) => {
          const u = new URL(r.url);
          if (u.searchParams.get('open_only') === 'true') {
            return { status: 200, json: { record_count: 3, tickets: [{ id: 6, tickettype_id: 1 }, { id: 7, tickettype_id: 9 }, { id: 8, tickettype_id: 2 }] } };
          }
          // The instance honors datesearch — each window returns its own rows.
          if (u.searchParams.get('datesearch') === 'dateoccurred') return { status: 200, json: { record_count: inQ2.length, tickets: inQ2 } };
          if (u.searchParams.get('datesearch') === 'dateclosed') return { status: 200, json: { record_count: closedInQ2.length, tickets: closedInQ2 } };
          return { status: 200, json: { record_count: 0, tickets: [] } };
        },
      },
      { match: (r) => r.url.includes('/api/ClientContract'), respond: () => ({ status: 200, json: { contracts: [] } }) },
      { match: (r) => r.url.includes('/api/Invoice'), respond: () => ({ status: 200, json: { invoices: [] } }) },
    ]);
    const out = await collectHaloDirect(
      { clientId: 'anp', period, externalRef: '35' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'types-1', clientSecret: 's', ticketTypeIds: ['1', '2'] },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(3); // tickets 1, 2, 4 (type 9 excluded)
    expect(by['tickets.closed']).toBe(1); // ticket 4 closed in Q2
    expect(by['tickets.open']).toBe(2); // open snapshot filtered to types 1 + 2
    expect(by['sla.met_pct']).toBe(66.7); // 2 met of 3 opened-in-period with SLA state
    expect(by['sla.breaches']).toBe(1);
    // The period tallies came from the server date windows, not a recency pull.
    expect(requests.some((r) => r.url.includes('datesearch=dateoccurred'))).toBe(true);
    expect(requests.some((r) => r.url.includes('datesearch=dateclosed'))).toBe(true);
  });

  it('falls back to recent tickets when the server ignores datesearch, still type-filtered', async () => {
    const period = makePeriod(2026, 2);
    const allTickets = [
      { id: 1, tickettype_id: 1, dateoccurred: '2026-05-01T10:00:00Z', dateclosed: '2026-05-02T10:00:00Z' },
      { id: 2, tickettype_id: 9, dateoccurred: '2026-05-03T10:00:00Z' }, // excluded type
      { id: 3, tickettype_id: 1, dateoccurred: '2026-01-05T10:00:00Z' }, // outside quarter
    ];
    const { http } = fakeHttp([
      tokenRoute(),
      {
        match: (r) => r.url.includes('/api/Tickets'),
        respond: (r) => {
          const u = new URL(r.url);
          if (u.searchParams.get('datesearch')) return { status: 200, json: { record_count: 0, tickets: [] } };
          if (u.searchParams.get('open_only') === 'true') return { status: 200, json: { record_count: 0, tickets: [] } };
          return { status: 200, json: { record_count: allTickets.length, tickets: allTickets } };
        },
      },
      { match: (r) => r.url.includes('/api/ClientContract'), respond: () => ({ status: 200, json: { contracts: [] } }) },
      { match: (r) => r.url.includes('/api/Invoice'), respond: () => ({ status: 200, json: { invoices: [] } }) },
    ]);
    const out = await collectHaloDirect(
      { clientId: 'anp', period, externalRef: '35' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'types-3', clientSecret: 's', ticketTypeIds: ['1'] },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(1); // ticket 1 only (type 9 + out-of-quarter excluded)
    expect(by['tickets.closed']).toBe(1);
  });

  it('tallyHaloSla scans sla-prefixed fields tolerantly', () => {
    expect(
      tallyHaloSla([
        { sla_response_state: 'Met' },
        { slaresolutionstate: 'BREACHED' },
        { sla_status: 'Within target' },
        { sla_id: 3 }, // numeric — not counted
        { status: 'Closed' }, // not sla-keyed — not counted
      ]),
    ).toEqual({ met: 2, breached: 1 });
  });

  it('tallyHaloSla handles negations, multi-field rows, and SLA-name fields', () => {
    expect(
      tallyHaloSla([
        { sla_status: 'Not met' }, // negation must read as a breach
        { sla_response_state: 'Met', sla_resolution_state: 'Breached' }, // any breach wins the row
        { slaname: 'Respond within 4 hours', slastate: 'Breached' }, // the SLA *name* must not read as met
        { slaname: 'Respond within 4 hours' }, // only a name → not counted at all
      ]),
    ).toEqual({ met: 0, breached: 3 });
  });

  it('reports unavailable (not zeros) when list rows expose no ticket-type id', async () => {
    const period = makePeriod(2026, 2);
    // An instance whose /Tickets rows carry only the type *name* — the id
    // allowlist can't be applied, so ticket metrics must be skipped, not 0.
    const tickets = [
      { id: 1, tickettype_name: 'Incident', dateoccurred: '2026-05-01T10:00:00Z' },
      { id: 2, tickettype_name: 'Alert', dateoccurred: '2026-05-02T10:00:00Z' },
    ];
    const { http } = fakeHttp([
      tokenRoute(),
      { match: (r) => r.url.includes('/api/Tickets'), respond: () => ({ status: 200, json: { record_count: 2, tickets } }) },
      { match: (r) => r.url.includes('/api/ClientContract'), respond: () => ({ status: 200, json: { contracts: [{ monthlyvalue: 100 }] } }) },
      { match: (r) => r.url.includes('/api/Invoice'), respond: () => ({ status: 200, json: { invoices: [] } }) },
    ]);
    const out = await collectHaloDirect(
      { clientId: 'anp', period, externalRef: '35' },
      http,
      { baseUrl: 'https://x.halopsa.com', clientId: 'types-2', clientSecret: 's', ticketTypeIds: ['1'] },
    );
    expect(out.metrics.some((m) => m.key.startsWith('tickets.'))).toBe(false);
    expect(out.metrics.some((m) => m.key === 'finance.mrr')).toBe(true); // finance still flows
    expect(out.warnings.some((w) => w.includes("ticket-type filter can't be applied"))).toBe(true);
  });
});

describe('normalizeHaloFinance', () => {
  it('breaks invoiced spend into Halo line categories', () => {
    const { metrics, warnings } = normalizeHaloFinance({
      contracts: [],
      invoices: [
        {
          invoicedate: '2026-05-01',
          nettotal: 6000,
          lines: [
            { net_amount: 4500, item_group_name: 'Managed Services' },
            { net_amount: 1000, item_group_name: 'Subscriptions' },
            { net_amount: 500, item_group_name: 'Software' },
          ],
        },
        { invoicedate: '2026-06-01', nettotal: 1500, lines: [{ net_amount: 1500, item_group_name: 'Managed Services' }] },
      ],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['finance.quarter_invoiced']).toBe(7500);
    expect(by['finance.invoiced.managed_services']).toBe(6000);
    expect(by['finance.invoiced.subscriptions']).toBe(1000);
    expect(by['finance.invoiced.software']).toBe(500);
    expect(warnings).toHaveLength(0);
  });

  it('folds the tail into one Other without double-counting a Halo group named Other', () => {
    // 8 groups; Halo's own "Other" ranks 7th, "Misc" 8th — both must fold into
    // a SINGLE Other entry so the breakdown reconciles to the invoice total.
    const { metrics } = normalizeHaloFinance({
      contracts: [],
      invoices: [
        {
          invoicedate: '2026-05-01',
          nettotal: 12500,
          lines: [
            { net_amount: 5000, item_group_name: 'Managed Services' },
            { net_amount: 2000, item_group_name: 'Subscriptions' },
            { net_amount: 1500, item_group_name: 'Software' },
            { net_amount: 1200, item_group_name: 'Hardware' },
            { net_amount: 1100, item_group_name: 'Projects' },
            { net_amount: 1000, item_group_name: 'Consulting' },
            { net_amount: 400, item_group_name: 'Other' },
            { net_amount: 300, item_group_name: 'Misc' },
          ],
        },
      ],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    const breakdown = metrics.filter((m) => m.key.startsWith('finance.invoiced.'));
    expect(breakdown.reduce((s, m) => s + Number(m.value), 0)).toBe(12500);
    const others = breakdown.filter((m) => m.key === 'finance.invoiced.other');
    expect(others).toHaveLength(1);
    expect(others[0]!.value).toBe(700); // 400 (Other group) + 300 (Misc tail)
  });

  it('emits one Other even when the Other group ranks inside the top six', () => {
    const { metrics } = normalizeHaloFinance({
      contracts: [],
      invoices: [
        {
          invoicedate: '2026-05-01',
          nettotal: 11900,
          lines: [
            { net_amount: 5000, item_group_name: 'Managed Services' },
            { net_amount: 3000, item_group_name: 'Other' }, // big enough for the top 6
            { net_amount: 900, item_group_name: 'Subscriptions' },
            { net_amount: 800, item_group_name: 'Software' },
            { net_amount: 700, item_group_name: 'Hardware' },
            { net_amount: 600, item_group_name: 'Projects' },
            { net_amount: 500, item_group_name: 'Consulting' },
            { net_amount: 400, item_group_name: 'Misc' }, // the tail
          ],
        },
      ],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    const breakdown = metrics.filter((m) => m.key.startsWith('finance.invoiced.'));
    expect(breakdown.reduce((s, m) => s + Number(m.value), 0)).toBe(11900);
    const others = breakdown.filter((m) => m.key === 'finance.invoiced.other');
    expect(others).toHaveLength(1);
    expect(others[0]!.value).toBe(3400); // 3000 (Other group) + 400 (Misc tail)
  });

  it('resolves line categories through the item catalog (group, then item name)', () => {
    const { metrics } = normalizeHaloFinance({
      contracts: [],
      items: [
        { id: 5, name: 'M365 Business Premium', group_name: 'Subscriptions' },
        { id: 9, name: 'Onsite support' }, // no group — item name becomes the label
      ],
      invoices: [
        {
          invoicedate: '2026-05-01',
          nettotal: 700,
          lines: [
            { item_id: 5, net_amount: 500 },
            { item_id: 9, net_amount: 150 },
            { net_amount: 50, description: 'Shipping' }, // description fallback
          ],
        },
      ],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['finance.invoiced.subscriptions']).toBe(500);
    expect(by['finance.invoiced.onsite_support']).toBe(150);
    expect(by['finance.invoiced.shipping']).toBe(50);
  });

  it('suppresses a lone Other bucket and names the line fields it saw', () => {
    const { metrics, warnings } = normalizeHaloFinance({
      contracts: [],
      invoices: [
        { invoicedate: '2026-05-01', nettotal: 1000, lines: [{ id: 247, ihid: 1185, net_amount: 1000 }] },
      ],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    expect(metrics.map((m) => m.key)).toEqual(['finance.quarter_invoiced']); // no useless "Other" row
    expect(warnings[0]).toMatch(/line fields seen: id, ihid, net_amount/);
  });

  it('breaks the monthly bill down from contract detail items', () => {
    const { metrics } = normalizeHaloFinance({
      contracts: [{ id: 1, monthlyvalue: 2750 }],
      contractDetails: [
        {
          id: 1,
          items: [
            { monthlyprice: 2500, description: 'Managed Services Agreement' },
            { price: 25, quantity: 10, item_id: 5 }, // unit × qty, labeled via the catalog
          ],
        },
      ],
      items: [{ id: 5, name: 'M365 Business Premium', group_name: 'Subscriptions' }],
      invoices: [],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['finance.recurring.managed_services_agreement']).toBe(2500);
    expect(by['finance.recurring.subscriptions']).toBe(250);
    expect(by['finance.mrr']).toBe(2750);
  });

  it('says which contract fields it saw when no recurring items are recognizable', () => {
    const { warnings } = normalizeHaloFinance({
      contracts: [{ id: 1, monthlyvalue: 2750 }],
      contractDetails: [{ id: 1, ref: 'C-1', client_name: 'Madison Peds' }],
      invoices: [],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    expect(warnings.some((w) => /recurring/.test(w) && /contract fields seen: id, ref, client_name/.test(w))).toBe(true);
  });

  it('warns when invoices carry no line items (breakdown unavailable)', () => {
    const { metrics, warnings } = normalizeHaloFinance({
      contracts: [],
      invoices: [{ invoicedate: '2026-05-01', nettotal: 1000 }],
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
    expect(metrics.map((m) => m.key)).toEqual(['finance.quarter_invoiced']);
    expect(warnings[0]).toMatch(/no line items/);
  });

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
