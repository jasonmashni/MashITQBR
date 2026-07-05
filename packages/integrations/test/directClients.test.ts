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
    expect(by['endpoints.needs_attention']).toBeUndefined(); // tech-queue signal, not a QBR metric
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
    expect(normalizeNinjaBackup([], '3')).toHaveLength(0);
    expect(normalizeNinjaPatchQuarter(0, 0).map((m) => m.key)).toEqual(['patch.installed_quarter']);
  });

  it('counts only devices with real backup evidence — usage nests under references.backupUsage', () => {
    // backup/usage returns a row for EVERY device (live-verified shape): the
    // sizes nest under references.backupUsage and are all zero without a plan.
    const zeroUsage = { revisionsTotalSize: 0, cloudTotalSize: 0, localTotalSize: 0 };
    const rows = [
      { id: 1, organizationId: 3, systemName: 'MP-01', references: { backupUsage: zeroUsage } },
      { id: 2, organizationId: 3, systemName: 'MP-02', references: { backupUsage: zeroUsage } },
      { id: 3, organizationId: 3, systemName: 'MP-10-Hazelwood', references: { backupUsage: { ...zeroUsage, revisionsTotalSize: 52_428_800, cloudTotalSize: 52_428_800 } } },
    ];
    const metrics = normalizeNinjaBackup(rows, '3');
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['backup.protected_devices']).toBe(1);
    expect(metrics.find((m) => m.key === 'backup.protected_devices')!.details![0]!['device']).toBe('MP-10-Hazelwood');
  });

  it('scopes devices and every query to the selected device roles', async () => {
    const { http } = fakeHttp((req) => {
      if (req.url.includes('/ws/oauth/token')) return { status: 200, json: { access_token: 'nt', expires_in: 3600 } };
      if (req.url.includes('/v2/roles')) {
        return { status: 200, json: [{ id: 5, name: 'Windows Desktop' }, { id: 9, name: 'VMware Host' }] };
      }
      if (req.url.includes('/v2/organization/3/devices')) {
        return { status: 200, json: [{ id: 17, systemName: 'ANP-PC-01', nodeRoleId: 5 }, { id: 18, systemName: 'ANP-ESX-01', nodeRoleId: 9 }] };
      }
      if (req.url.includes('device-health')) {
        return { status: 200, json: { results: [{ deviceId: 17, healthStatus: 'HEALTHY' }, { deviceId: 18, healthStatus: 'NEEDS_ATTENTION' }] } };
      }
      if (req.url.includes('antivirus-status')) {
        return {
          status: 200,
          json: { results: [{ deviceId: 17, productState: 'ON', definitionStatus: 'UpToDate' }, { deviceId: 18, productState: 'OFF', definitionStatus: 'OutOfDate' }] },
        };
      }
      if (req.url.includes('os-patch-installs')) return { status: 200, json: { results: [{ deviceId: 18 }] } }; // filtered away
      if (req.url.includes('os-patches')) return { status: 200, json: { results: [{ deviceId: 17 }, { deviceId: 18 }] } };
      if (req.url.includes('backup/usage')) {
        return { status: 200, json: { results: [{ id: 17, organizationId: 3, totalSize: 1024 }, { id: 18, organizationId: 3, totalSize: 2048 }] } };
      }
      return { status: 404, json: {} };
    });
    const out = await collectNinjaDirect(
      { clientId: 'anp', period: P, externalRef: '3' },
      http,
      { clientId: 'ninja-roles-1', clientSecret: 's', nodeRoleIds: ['5'] },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['endpoints.managed']).toBe(1); // the VMware host is out of scope
    expect(by['endpoints.av_coverage_pct']).toBe(100); // only device 17's AV row counts
    expect(by['patch.pending']).toBe(1);
    const managed = out.metrics.find((m) => m.key === 'endpoints.managed')!;
    expect(managed.details).toHaveLength(1);
    expect(managed.details![0]).toMatchObject({ name: 'ANP-PC-01', role: 'Windows Desktop' });
    expect(String(managed.details![0]!['url'])).toContain('/#/deviceDashboard/17/');
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

describe('Dropsuite (sub-reseller API)', () => {
  it('normalizes account rows into seats + health (errors object = failing)', () => {
    const by = Object.fromEntries(
      normalizeDropsuiteAccounts([
        { email: 'a@mp.com', current_backup_status: 'Completed', errors: {} },
        { email: 'b@mp.com', current_backup_status: 'Running', errors: { host: 'connection timed out' } },
        { email: 'old@mp.com', deactivated_since: '2026-01-01', errors: {} },
      ]).map((m) => [m.key, m.value]),
    );
    expect(by['backup.protected_accounts']).toBe(2);
    expect(by['backup.failed_jobs']).toBe(1);
    expect(by['backup.success_pct']).toBe(50);
  });

  it('finds the mapped tenant user, then reads /accounts with THAT user token', async () => {
    const { http, requests } = fakeHttp((req) => {
      expect(req.headers?.['X-Reseller-Token']).toBe('rt');
      if (req.url.endsWith('/users')) {
        expect(req.headers?.['X-Access-Token']).toBe('admin-token');
        return { status: 200, json: [{ id: 29, email: 'backup@madisonpeds.com', authentication_token: 'user-token' }] };
      }
      expect(req.headers?.['X-Access-Token']).toBe('user-token');
      return { status: 200, json: [{ email: 'a@madisonpeds.com', current_backup_status: 'Completed', errors: {} }] };
    });
    const out = await collectDropsuite(
      { clientId: 'mp', period: P, externalRef: '29' },
      http,
      { baseUrl: 'https://dropsuite.us/api', resellerToken: 'rt', accessToken: 'admin-token' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['backup.protected_accounts']).toBe(1);
    expect(requests.some((r) => r.url.endsWith('/accounts'))).toBe(true);
  });

  it('adds storage, message counts, staleness, and seats from the account rows', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    const metrics = normalizeDropsuiteAccounts(
      [
        { email: 'a@mp.com', errors: {}, last_backup: '2026-06-30T12:00:00Z', storage: 2 * 1024 ** 3, msg_count: 1000, user: { seats_used: 12 } },
        { email: 'b@mp.com', errors: {}, last_backup: '2026-05-01T12:00:00Z', storage: 1024 ** 3, msg_count: 500 },
      ],
      now,
    );
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['backup.email_data_gb']).toBe(3);
    expect(by['backup.emails_protected']).toBe(1500);
    expect(by['backup.stale_mailboxes']).toBe(1); // b@ last backed up 2 months ago
    expect(by['backup.seats_used']).toBe(12);
  });

  it('collects OneDrive/SharePoint coverage and connection failures', async () => {
    const { http } = fakeHttp((req) => {
      if (req.url.endsWith('/users')) return { status: 200, json: [{ id: 29, authentication_token: 'ut' }] };
      if (req.url.includes('/accounts/connection_failures')) return { status: 200, json: { result_set: [{ email: 'x@mp.com' }] } };
      if (req.url.includes('/accounts')) return { status: 200, json: [{ email: 'a@mp.com', errors: {} }] };
      if (req.url.includes('/onedrives')) return { status: 200, json: [{ email: 'a@mp.com', storage: 1024 ** 3, file_count: 10 }] };
      if (req.url.includes('/sharepoints/domains')) return { status: 200, json: [{ domain_name: 'mp.com', site_count: 4, storage: 2 * 1024 ** 3 }] };
      return { status: 404, json: {} };
    });
    const out = await collectDropsuite({ clientId: 'mp', period: P, externalRef: '29' }, http, { resellerToken: 'rt', accessToken: 'at' });
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['backup.connection_failures']).toBe(1);
    expect(by['backup.onedrive_accounts']).toBe(1);
    expect(by['backup.onedrive_data_gb']).toBe(1);
    expect(by['backup.sharepoint_sites']).toBe(4);
    expect(by['backup.sharepoint_data_gb']).toBe(2);
    // Products a tenant doesn't license (403/404) must not spam warnings.
    expect(out.warnings).toHaveLength(0);
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
