import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import {
  collectHuntress,
  mfaCoveragePct,
  normalizeHuntressSummary,
  scopeHuntressIdentities,
  normalizeHuntressUsage,
  type HttpRequest,
  type HttpResponse,
} from '@mashit/integrations';

describe('scopeHuntressIdentities', () => {
  it('keeps licensed identities on the dominant domain only', () => {
    const identities = [
      { email: 'a@madisonpeds.com', mfa_enabled: true, billable: true },
      { email: 'b@madisonpeds.com', mfa_enabled: false, billable: true },
      { email: 'guest@gmail.com', mfa_enabled: false, billable: true }, // external guest
      { email: 'svc@madisonpeds.com', mfa_enabled: false, billable: false }, // unlicensed
    ];
    const scoped = scopeHuntressIdentities(identities);
    expect(scoped.map((i) => i.email)).toEqual(['a@madisonpeds.com', 'b@madisonpeds.com']);
    expect(mfaCoveragePct(scoped)).toBe(50); // no more misleading tenant-wide 25%
  });

  it('keeps everything when no license flag exists (older API shapes)', () => {
    const scoped = scopeHuntressIdentities([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
    expect(scoped).toHaveLength(2);
  });
});

describe('normalizeHuntressSummary', () => {
  it('maps the quarterly summary rollups into canonical metrics', () => {
    const by = Object.fromEntries(
      normalizeHuntressSummary({
        agents_count: 26,
        incidents_reported: 3,
        incidents_resolved: 3,
        signals_detected: 120,
        investigations_completed: 45,
        deployed_canaries_count: 24,
        external_ports_count: 12,
        risky_services_count: 1,
        firewall_enabled_count: 24,
        firewall_disabled_count: 2,
        blocked_malware_count: 5,
        itdr_incidents_reported: 0,
        siem_ingested_logs: 250000,
      }).map((m) => [m.key, m.value]),
    );
    expect(by['huntress.endpoints']).toBe(26);
    expect(by['huntress.edr_incidents']).toBe(3);
    expect(by['huntress.canaries']).toBe(24);
    expect(by['recon.risky_services']).toBe(1);
    expect(by['endpoints.firewall_enabled_pct']).toBe(92.3); // 24 of 26
    expect(by['huntress.identity_compromises']).toBe(0);
    expect(by['huntress.siem_logs']).toBe(250000);
  });

  it('emits nothing for absent fields', () => {
    expect(normalizeHuntressSummary({})).toHaveLength(0);
  });
});

describe('normalizeHuntressUsage / mfaCoveragePct', () => {
  it('maps actual_usages and computes MFA coverage over enabled identities', () => {
    const by = Object.fromEntries(
      normalizeHuntressUsage({
        edr: { billable_agents_count: 26, unresponsive_agents_count: 2, outdated_agents_count: 1 },
        sat: { learners_count: 25 },
        itdr: [{ billable_identities_count: 40 }, { billable_identities_count: 10 }],
        siem: { current_billing_cycle: { online_gb: 12.3 } },
      }).map((m) => [m.key, m.value]),
    );
    expect(by['endpoints.unresponsive']).toBe(2);
    expect(by['sat.learners']).toBe(25);
    expect(by['identity.protected']).toBe(50);
    expect(by['siem.online_gb']).toBe(12.3);

    expect(
      mfaCoveragePct([
        { mfa_enabled: true, enabled: true },
        { mfa_enabled: true, enabled: true },
        { mfa_enabled: false, enabled: true },
        { mfa_enabled: false, enabled: false }, // disabled identity excluded
      ]),
    ).toBe(66.7);
    expect(mfaCoveragePct([])).toBeNull();
  });
});

describe('collectHuntress', () => {
  it('pulls summary + usage + MFA through the real endpoint shapes', async () => {
    const seen: string[] = [];
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        seen.push(req.url);
        expect(req.headers?.['Authorization']).toContain('Basic ');
        if (req.url.includes('/reports?') && req.url.includes('type=quarterly_summary')) {
          return { status: 200, json: { reports: [{ agents_count: 26, incidents_reported: 2 }], pagination: {} } };
        }
        if (req.url.includes('/organizations/org1')) {
          return { status: 200, json: { organization: { actual_usages: { sat: { learners_count: 25 } } } } };
        }
        if (req.url.includes('/identities?')) {
          return {
            status: 200,
            json: { identities: [{ mfa_enabled: true, enabled: true }, { mfa_enabled: false, enabled: true }], pagination: {} },
          };
        }
        return { status: 404, json: {} };
      },
    };
    const result = await collectHuntress(
      { clientId: 'anp', period: makePeriod(2026, 1), externalRef: 'org1' },
      http,
      { baseUrl: 'https://api.huntress.io/v1', apiKey: 'k', apiSecret: 's' },
    );
    const by = Object.fromEntries(result.metrics.map((m) => [m.key, m.value]));
    expect(by['huntress.endpoints']).toBe(26);
    expect(by['sat.learners']).toBe(25);
    expect(by['identity.mfa_coverage_pct']).toBe(50);
    expect(seen.some((u) => u.includes('period_min=2026-01-01'))).toBe(true);
  });

  it('falls back to a monthly summary with a warning', async () => {
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('type=quarterly_summary')) return { status: 200, json: { reports: [], pagination: {} } };
        if (req.url.includes('type=monthly_summary')) return { status: 200, json: { reports: [{ agents_count: 9 }], pagination: {} } };
        return { status: 200, json: { organization: {}, identities: [], pagination: {} } };
      },
    };
    const result = await collectHuntress(
      { clientId: 'x', period: makePeriod(2026, 1), externalRef: '7' },
      http,
      { apiKey: 'k', apiSecret: 's' },
    );
    const by = Object.fromEntries(result.metrics.map((m) => [m.key, m.value]));
    expect(by['huntress.endpoints']).toBe(9);
    expect(result.warnings.some((w) => /monthly summary/.test(w))).toBe(true);
  });

  it('warns when unmapped', async () => {
    const http = { async request(): Promise<HttpResponse> { return { status: 200, json: {} }; } };
    const result = await collectHuntress({ clientId: 'x', period: makePeriod(2026, 1) }, http, { apiKey: 'k', apiSecret: 's' });
    expect(result.metrics).toHaveLength(0);
    expect(result.warnings.some((w) => /No Huntress organization mapped/.test(w))).toBe(true);
  });
});
