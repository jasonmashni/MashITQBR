import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import { collectHuntress, normalizeHuntress, type HttpRequest, type HttpResponse } from '@mashit/integrations';

describe('normalizeHuntress', () => {
  it('maps org rollups and counts in-period incidents', () => {
    const metrics = normalizeHuntress(
      { stats: { edr: { agents_total: 80 }, itdr: { identities: 580 }, siem: { events: 72_800_000 } } },
      [
        { id: 1, severity: 'low' },
        { id: 2, severity: 'high' },
      ],
    );
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['huntress.endpoints']).toBe(80);
    expect(by['huntress.identities']).toBe(580);
    expect(by['huntress.siem_logs']).toBe(72_800_000);
    expect(by['huntress.edr_incidents']).toBe(2);
  });

  it('omits metrics whose source data is absent', () => {
    const metrics = normalizeHuntress({}, []);
    const keys = metrics.map((m) => m.key);
    expect(keys).toContain('huntress.edr_incidents'); // always counts (0)
    expect(keys).not.toContain('huntress.endpoints');
  });
});

describe('collectHuntress', () => {
  it('fetches org + incidents and surfaces API gaps as warnings', async () => {
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('/organizations/')) {
          return { status: 200, json: { stats: { edr: { agents_total: 26 } } } };
        }
        return { status: 200, json: { incident_reports: [{ id: 9 }] } };
      },
    };
    const result = await collectHuntress(
      { clientId: 'mp', period: makePeriod(2026, 1), externalRef: '123' },
      http,
      { apiKey: 'k', apiSecret: 's' },
    );
    const by = Object.fromEntries(result.metrics.map((m) => [m.key, m.value]));
    expect(by['huntress.endpoints']).toBe(26);
    expect(by['huntress.edr_incidents']).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/canary|SAT|Managed AV/i);
  });

  it('warns and returns nothing when no org is mapped', async () => {
    const http = { async request(): Promise<HttpResponse> { return { status: 200, json: {} }; } };
    const result = await collectHuntress({ clientId: 'x', period: makePeriod(2026, 1) }, http, {
      apiKey: 'k',
      apiSecret: 's',
    });
    expect(result.metrics).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/No Huntress organization/);
  });
});
