import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import {
  collectDefensx,
  listDefensxCustomers,
  normalizeDefensx,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@mashit/integrations';

function fakeHttp(routes: Array<{ match: (req: HttpRequest) => boolean; respond: (req: HttpRequest) => HttpResponse }>) {
  const requests: HttpRequest[] = [];
  const http: HttpTransport = {
    async request(req) {
      requests.push(req);
      const r = routes.find((x) => x.match(req));
      return r ? r.respond(req) : { status: 404, json: { error: `no fake for ${req.url}` } };
    },
  };
  return { http, requests };
}

describe('normalizeDefensx', () => {
  it('maps the cyber-resilience score, risky users, protected users, extensions and blocked stats', () => {
    const { metrics, warnings } = normalizeDefensx({
      cyberResilience: {
        score: 82.5,
        risky_users: [
          { email: 'a@x.com', risk_score: 90 },
          { email: 'b@x.com', risk_score: 70 },
        ],
      },
      users: { data: [{ id: 1 }, { id: 2 }], pagination: { total: 42 } },
      lowRepExtensions: { data: [{ name: 'Sketchy Toolbar', reputation: 12 }] },
      blockedHostnames: { data: [{ hostname: 'bad.example', count: 500 }, { hostname: 'evil.example', count: 300 }] },
      credentialsBlocked: { data: [{ hostname: 'phish.example', count: 10 }] },
    });
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['security.cyber_resilience_score']).toBe(82.5);
    expect(by['security.risky_users']).toBe(2);
    expect(by['identity.protected_users']).toBe(42); // pagination total beats row count
    expect(by['security.risky_browser_extensions']).toBe(1);
    expect(by['security.web_threats_blocked']).toBe(800); // summed hit counts
    expect(by['security.credential_theft_blocked']).toBe(10);
    // Risky-user drill-down survives.
    const risky = metrics.find((m) => m.key === 'security.risky_users')!;
    expect(risky.details).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it('warns (naming seen fields) when the resilience score is unrecognized', () => {
    const { metrics, warnings } = normalizeDefensx({ cyberResilience: { unexpected_field: 1 } });
    expect(metrics.some((m) => m.key === 'security.cyber_resilience_score')).toBe(false);
    expect(warnings[0]).toMatch(/resilience score not recognized/i);
    expect(warnings[0]).toContain('unexpected_field');
  });

  it('falls back to the count of sites when blocked stats carry no hit counts', () => {
    const { metrics } = normalizeDefensx({
      blockedHostnames: { data: [{ hostname: 'a.example', ratio: 40 }, { hostname: 'b.example', ratio: 20 }] },
    });
    expect(metrics.find((m) => m.key === 'security.web_threats_blocked')?.value).toBe(2);
  });

  it('reads a nested summary score', () => {
    const { metrics } = normalizeDefensx({ cyberResilience: { summary: { cyber_resilience_score: 74 } } });
    expect(metrics.find((m) => m.key === 'security.cyber_resilience_score')?.value).toBe(74);
  });
});

describe('collectDefensx', () => {
  it('pulls each endpoint with a Bearer token and emits metrics', async () => {
    const period = makePeriod(2026, 2);
    const { http, requests } = fakeHttp([
      { match: (r) => r.url.includes('/cyber_resilience'), respond: () => ({ status: 200, json: { score: 88, risky_users: [{ email: 'r@x.com' }] } }) },
      { match: (r) => r.url.endsWith('/users') || r.url.includes('/users?'), respond: () => ({ status: 200, json: { data: [{ id: 1 }], pagination: { total: 25 } } }) },
      { match: (r) => r.url.includes('/browser_extensions/low_reputation'), respond: () => ({ status: 200, json: { data: [{ name: 'X', reputation: 5 }] } }) },
      { match: (r) => r.url.includes('/stats/blocked_hostnames'), respond: () => ({ status: 200, json: { data: [{ hostname: 'bad.example', count: 12 }] } }) },
      { match: (r) => r.url.includes('/stats/credentials_blocked'), respond: () => ({ status: 200, json: { data: [] } }) },
    ]);
    const out = await collectDefensx({ clientId: 'anp', period, externalRef: 'cust-77' }, http, { token: 'tok-abc' });
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['security.cyber_resilience_score']).toBe(88);
    expect(by['identity.protected_users']).toBe(25);
    expect(by['security.web_threats_blocked']).toBe(12);
    expect(out.source).toBe('defensx');
    expect(requests.every((r) => r.headers?.['Authorization'] === 'Bearer tok-abc')).toBe(true);
    expect(requests.some((r) => r.url.includes('/customers/cust-77/cyber_resilience'))).toBe(true);
  });

  it('warns instead of failing when no customer is mapped', async () => {
    const { http } = fakeHttp([]);
    const out = await collectDefensx({ clientId: 'anp', period: makePeriod(2026, 2), externalRef: '' }, http, { token: 't' });
    expect(out.metrics).toHaveLength(0);
    expect(out.warnings[0]).toMatch(/No DefensX customer mapped/);
  });

  it('degrades per-endpoint with warnings (one failure does not sink the rest)', async () => {
    const period = makePeriod(2026, 2);
    const { http } = fakeHttp([
      { match: (r) => r.url.includes('/cyber_resilience'), respond: () => ({ status: 500, json: { error: 'boom' } }) },
      { match: (r) => r.url.includes('/users'), respond: () => ({ status: 200, json: { data: [], pagination: { total: 9 } } }) },
      { match: () => true, respond: () => ({ status: 200, json: { data: [] } }) },
    ]);
    const out = await collectDefensx({ clientId: 'anp', period, externalRef: 'c1' }, http, { token: 't' });
    expect(out.metrics.find((m) => m.key === 'identity.protected_users')?.value).toBe(9);
    expect(out.warnings.some((w) => w.includes('cyber resilience unavailable'))).toBe(true);
  });
});

describe('listDefensxCustomers', () => {
  it('lists customers for the mapping dropdown', async () => {
    const { http } = fakeHttp([
      { match: (r) => r.url.includes('/customers'), respond: () => ({ status: 200, json: { data: [{ id: 10, name: 'ACME' }, { id: 11, company_name: 'Globex' }] } }) },
    ]);
    const out = await listDefensxCustomers(http, { token: 't' });
    expect(out).toEqual([{ id: '10', name: 'ACME' }, { id: '11', name: 'Globex' }]);
  });
});
