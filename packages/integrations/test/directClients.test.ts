import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import {
  checkpointToken,
  collectConnectSecure,
  collectDropsuite,
  collectHudu,
  collectNinjaDirect,
  collectPrintix,
  extractConnectSecureStats,
  listHuduCompanies,
  listNinjaOrgs,
  normalizeDropsuiteAccounts,
  normalizeHuduExpirations,
  normalizeNinjaAv,
  normalizeNinjaBackup,
  normalizeNinjaHealth,
  normalizeNinjaPatchQuarter,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@mashit/integrations';

function fakeHttp(handler: (req: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const http: HttpTransport = {
    async request(req) {
      requests.push(req);
      return handler(req);
    },
  };
  return { http, requests };
}

const P = makePeriod(2026, 1);

describe('NinjaOne direct', () => {
  it('exchanges a monitoring-scope token, lists orgs, and collects posture', async () => {
    const { http, requests } = fakeHttp((req) => {
      if (req.url.includes('/ws/oauth/token')) {
        expect(req.body).toContain('scope=monitoring');
        return { status: 200, json: { access_token: 'nt', expires_in: 3600 } };
      }
      if (req.url.includes('/v2/organizations')) return { status: 200, json: [{ id: 3, name: 'ANP Enertech' }] };
      if (req.url.includes('/v2/organization/3/devices')) return { status: 200, json: [{ id: 17 }, { id: 18 }] };
      if (req.url.includes('device-health')) {
        return { status: 200, json: { results: [{ deviceId: 17, healthStatus: 'HEALTHY' }, { deviceId: 18, healthStatus: 'NEEDS_ATTENTION' }] } };
      }
      if (req.url.includes('antivirus-status')) {
        return { status: 200, json: { results: [{ productState: 'ON', definitionStatus: 'UpToDate' }, { productState: 'OFF', definitionStatus: 'OutOfDate' }] } };
      }
      if (req.url.includes('os-patch-installs')) {
        // Quarterly install history: status + period window are passed through.
        const url = new URL(req.url);
        expect(url.searchParams.get('installedAfter')).toBe(P.start);
        expect(url.searchParams.get('installedBefore')).toBe(P.end);
        const status = url.searchParams.get('status');
        return { status: 200, json: { results: status === 'INSTALLED' ? [{ id: 1 }, { id: 2 }, { id: 3 }] : [{ id: 4 }] } };
      }
      if (req.url.includes('os-patches')) return { status: 200, json: { results: [{ deviceId: 17 }, { deviceId: 17 }] } };
      if (req.url.includes('backup/usage')) {
        // No org filter on this endpoint — rows from OTHER orgs must be excluded.
        return {
          status: 200,
          json: {
            results: [
              { id: 17, organizationId: 3, lastSuccessfulBackupJob: 100, lastFailedBackupJob: 50 },
              { id: 18, organizationId: 3, lastSuccessfulBackupJob: 10, lastFailedBackupJob: 90 },
              { id: 99, organizationId: 7, lastSuccessfulBackupJob: 100 },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    });

    const cfg = { clientId: 'ninja-1', clientSecret: 's' };
    expect(await listNinjaOrgs(http, cfg)).toEqual([{ id: '3', name: 'ANP Enertech' }]);

    const out = await collectNinjaDirect({ clientId: 'anp', period: P, externalRef: '3' }, http, cfg);
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['endpoints.managed']).toBe(2);
    expect(by['endpoints.offline']).toBeUndefined(); // point-in-time offline dropped
    expect(by['endpoints.needs_attention']).toBe(1);
    expect(by['endpoints.av_coverage_pct']).toBe(50);
    expect(by['patch.installed_quarter']).toBe(3);
    expect(by['patch.failed_quarter']).toBe(1);
    expect(by['patch.compliance_pct']).toBe(75); // 3 installed / 4 attempted this quarter
    expect(by['patch.pending']).toBe(2);
    expect(by['backup.protected_devices']).toBe(2); // org 7's device excluded
    expect(by['backup.failed_jobs']).toBe(1); // device 18: last failure newer than last success
    // token exchanged once (cached across the collect's calls)
    expect(requests.filter((r) => r.url.includes('/ws/oauth/token')).length).toBe(1);
  });

  it('normalizers handle empty input', () => {
    expect(normalizeNinjaAv([])).toHaveLength(0);
    expect(normalizeNinjaHealth([])).toHaveLength(0);
    expect(normalizeNinjaBackup([], '3')).toHaveLength(0);
    expect(normalizeNinjaPatchQuarter(0, 0).map((m) => m.key)).toEqual(['patch.installed_quarter']);
  });
});

describe('Hudu', () => {
  it('lists companies (paged) and splits expirations into expired vs upcoming', async () => {
    const now = Date.parse('2026-07-01');
    const metrics = normalizeHuduExpirations(
      [
        { expiration_type: 'warranty', date: '2026-05-01' }, // expired warranty
        { expiration_type: 'warranty', date: '2026-08-01' }, // upcoming
        { expiration_type: 'ssl_certificate', date: '2026-07-15' }, // upcoming
        { expiration_type: 'domain', date: '2027-06-01' }, // beyond 90 days
      ],
      now,
    );
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['assets.warranty_expired']).toBe(1);
    expect(by['assets.expiring_90d']).toBe(2);
  });

  it('collects assets + expirations for a company', async () => {
    const { http } = fakeHttp((req) => {
      if (req.url.includes('/companies/9/assets')) {
        expect(req.headers?.['x-api-key']).toBe('hk');
        return { status: 200, json: { assets: [{ id: 1 }, { id: 2 }] } };
      }
      if (req.url.includes('/expirations')) return { status: 200, json: { expirations: [] } };
      if (req.url.includes('/companies')) return { status: 200, json: { companies: [{ id: 9, name: 'KPCA' }] } };
      return { status: 404, json: {} };
    });
    const cfg = { baseUrl: 'https://x.huducloud.com', apiKey: 'hk' };
    expect(await listHuduCompanies(http, cfg)).toEqual([{ id: '9', name: 'KPCA' }]);
    const out = await collectHudu({ clientId: 'kpca', period: P, externalRef: '9' }, http, cfg);
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['docs.assets']).toBe(2);
  });
});

describe('Check Point Infinity Portal auth', () => {
  it('exchanges clientId/accessKey for a token and caches it', async () => {
    const { http, requests } = fakeHttp((req) => {
      expect(req.url).toContain('/auth/external');
      const body = JSON.parse(req.body ?? '{}') as Record<string, string>;
      expect(body['clientId']).toBe('cp-1');
      return { status: 200, json: { data: { token: 'cpt' } } };
    });
    const cfg = { baseUrl: 'https://smart-api.example', clientId: 'cp-1', accessKey: 'ak', authUrl: 'https://gw.example/auth/external' };
    expect(await checkpointToken(http, cfg)).toBe('cpt');
    expect(await checkpointToken(http, cfg)).toBe('cpt');
    expect(requests.length).toBe(1);
  });

  it('falls back to the legacy static token', async () => {
    const { http, requests } = fakeHttp(() => ({ status: 500, json: {} }));
    expect(await checkpointToken(http, { baseUrl: 'https://x', token: 'legacy' })).toBe('legacy');
    expect(requests.length).toBe(0);
  });
});

describe('Dropsuite', () => {
  it('normalizes account rows into seats + health', () => {
    const by = Object.fromEntries(
      normalizeDropsuiteAccounts([
        { status: 'active', last_backup_status: 'success' },
        { status: 'active', last_backup_status: 'failed' },
        { status: 'suspended', last_backup_status: 'success' },
      ]).map((m) => [m.key, m.value]),
    );
    expect(by['backup.protected_accounts']).toBe(2);
    expect(by['backup.failed_jobs']).toBe(1);
    expect(by['backup.success_pct']).toBe(66.7);
  });

  it('collects accounts for a mapped organization', async () => {
    const { http } = fakeHttp((req) => {
      expect(req.headers?.['Authorization']).toBe('Bearer dt');
      return { status: 200, json: { accounts: [{ status: 'active', last_backup_status: 'success' }] } };
    });
    const out = await collectDropsuite({ clientId: 'anp', period: P, externalRef: 'org-1' }, http, { token: 'dt' });
    expect(out.metrics.length).toBeGreaterThan(0);
  });
});

describe('Printix', () => {
  it('collects the printer fleet after an OAuth exchange', async () => {
    const { http } = fakeHttp((req) => {
      if (req.url.includes('/oauth/token')) return { status: 200, json: { access_token: 'pt', expires_in: 3600 } };
      return { status: 200, json: { _embedded: { printers: [{ status: 'Online' }, { status: 'Offline' }] } } };
    });
    const out = await collectPrintix(
      { clientId: 'anp', period: P },
      http,
      { tenantId: 't-1', clientId: 'printix-1', clientSecret: 's' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['printix.printers']).toBe(2);
    expect(by['printix.printers_offline']).toBe(1);
  });
});

describe('ConnectSecure', () => {
  it('extracts severity counts from varied stats shapes', () => {
    expect(extractConnectSecureStats({ data: { severity: { critical: 2, high: 9 }, total_assets: 40, compliance_score: 81 } })).toEqual({
      critical: 2,
      high: 9,
      medium: undefined,
      low: undefined,
      assets: 40,
      compliance_score: 81,
    });
    expect(extractConnectSecureStats({ CRITICAL: 1, HIGH: 3 }).critical).toBe(1);
  });

  it('collects vulnerability posture for a company', async () => {
    const { http } = fakeHttp((req) => {
      if (req.url.includes('/auth/token')) return { status: 200, json: { access_token: 'ct', expires_in: 3600 } };
      return { status: 200, json: { data: { severity: { critical: 2, high: 9, medium: 30 }, total_assets: 40, compliance_score: 81 } } };
    });
    const out = await collectConnectSecure(
      { clientId: 'anp', period: P, externalRef: 'c-1' },
      http,
      { baseUrl: 'https://pod1.example', clientId: 'cs-1', clientSecret: 's' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['vuln.critical']).toBe(2);
    expect(by['vuln.compliance_score']).toBe(81);
  });
});
