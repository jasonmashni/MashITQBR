import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { makePeriod } from '@mashit/core';
import {
  collectCipp,
  collectGoogleWorkspace,
  listCippTenants,
  normalizeCippDevices,
  normalizeCippLicenses,
  normalizeCippMfa,
  normalizeCippUserCounts,
  scopeCippMfaRows,
  normalizeGoogleWorkspaceUsers,
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

const P = makePeriod(2026, 2);

describe('CIPP', () => {
  const cfg = {
    baseUrl: 'https://cipp.example',
    tenantId: 'tenant-guid',
    clientId: 'app-guid',
    clientSecret: 's',
    tokenUrl: 'https://login.example/token',
  };

  it('exchanges an Entra token with the api:// scope and lists tenants', async () => {
    const { http, requests } = fakeHttp((req) => {
      if (req.url.includes('login.example')) {
        expect(req.body).toContain(encodeURIComponent('api://app-guid/.default'));
        return { status: 200, json: { access_token: 'ct', expires_in: 3600 } };
      }
      expect(req.headers?.['Authorization']).toBe('Bearer ct');
      return { status: 200, json: [{ defaultDomainName: 'madisonpeds.com', displayName: 'Madison Pediatric Associates' }] };
    });
    expect(await listCippTenants(http, cfg)).toEqual([{ id: 'madisonpeds.com', name: 'Madison Pediatric Associates' }]);
    expect(requests[0]!.url).toContain('login.example');
  });

  it('collects M365 posture per tenantFilter', async () => {
    const { http, requests } = fakeHttp((req) => {
      if (req.url.includes('login')) return { status: 200, json: { access_token: 'ct', expires_in: 3600 } };
      if (req.url.includes('ListMFAUsers')) {
        return {
          status: 200,
          json: [
            { UPN: 'a@x.com', AccountEnabled: true, MFARegistration: true },
            { UPN: 'b@x.com', AccountEnabled: true, MFARegistration: false },
            { UPN: 'old@x.com', AccountEnabled: false, MFARegistration: false },
          ],
        };
      }
      if (req.url.includes('ListUserCounts')) return { status: 200, json: { Users: '25', LicUsers: '20', Guests: '3', Gas: '2' } };
      if (req.url.includes('ListDevices')) {
        return { status: 200, json: [{ complianceState: 'compliant' }, { complianceState: 'compliant' }, { complianceState: 'noncompliant' }] };
      }
      if (req.url.includes('ListConditionalAccessPolicies')) return { status: 200, json: [{ state: 'enabled' }, { state: 'disabled' }] };
      if (req.url.includes('ListLicenses')) return { status: 200, json: [{ License: 'BP', CountUsed: 20, CountAvailable: 5 }] };
      return { status: 404, json: {} };
    });
    const out = await collectCipp({ clientId: 'mp', period: P, externalRef: 'madisonpeds.com' }, http, cfg);
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['identity.mfa_coverage_pct']).toBe(50); // 1 of 2 enabled users
    expect(by['identity.users_without_mfa']).toBe(1);
    expect(by['identity.users']).toBe(25);
    expect(by['identity.global_admins']).toBe(2);
    expect(by['devices.m365_managed']).toBe(3);
    expect(by['devices.compliant_pct']).toBe(66.7);
    expect(by['identity.ca_policies']).toBe(1);
    expect(by['licenses.assigned']).toBe(20);
    expect(by['licenses.unassigned']).toBe(5);
    // Every data call carried the tenant filter.
    for (const r of requests.filter((x) => x.url.includes('/api/List'))) {
      expect(r.url).toContain('tenantFilter=madisonpeds.com');
    }
  });

  it('scopes MFA to licensed users on the dominant domain (guests/services excluded)', () => {
    const rows = [
      { UPN: 'a@mp.com', AccountEnabled: true, MFARegistration: true, IsLicensed: true },
      { UPN: 'b@mp.com', AccountEnabled: true, MFARegistration: false, IsLicensed: true },
      { UPN: 'c@mp.com', AccountEnabled: true, MFARegistration: true, IsLicensed: true },
      { UPN: 'svc@mp.com', AccountEnabled: true, MFARegistration: false, IsLicensed: false }, // unlicensed
      { UPN: 'guest@partner.com', AccountEnabled: true, MFARegistration: false, IsLicensed: true }, // other domain
      { UPN: 'old@mp.com', AccountEnabled: false, MFARegistration: false, IsLicensed: true }, // disabled
    ];
    expect(scopeCippMfaRows(rows)).toHaveLength(3);
    const metrics = normalizeCippMfa(rows);
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['identity.mfa_coverage_pct']).toBe(66.7);
    expect(by['identity.users_without_mfa']).toBe(1);
    const details = metrics.find((m) => m.key === 'identity.mfa_coverage_pct')?.details;
    expect(details).toHaveLength(3);
    expect(details?.[0]?.['mfa']).toBe('NO'); // the gaps float to the top
  });

  it('normalizers tolerate odd shapes', () => {
    expect(normalizeCippMfa([])).toHaveLength(0);
    expect(normalizeCippUserCounts(undefined)).toHaveLength(0);
    expect(normalizeCippLicenses([{ License: 'x' }])).toHaveLength(0);
    expect(normalizeCippDevices([])).toHaveLength(0);
    // Devices without a compliance state still count the fleet.
    expect(normalizeCippDevices([{ id: 1 }]).map((m) => m.key)).toEqual(['devices.m365_managed']);
  });

  it('licenses: totals, per-SKU drill-down, and renewal dates when present', () => {
    const now = Date.parse('2026-07-15T00:00:00Z');
    const metrics = normalizeCippLicenses(
      [
        { License: 'Microsoft 365 Business Premium', CountUsed: 20, CountAvailable: 5, RenewalDate: '2026-08-30T00:00:00Z' },
        { License: 'Exchange Online (Plan 1)', TotalLicenses: 10, CountUsed: 10, ExpiryDate: '2027-01-01T00:00:00Z' },
      ],
      now,
    );
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['licenses.total']).toBe(35); // 25 + 10 purchased
    expect(by['licenses.assigned']).toBe(30); // 20 + 10 used
    expect(by['licenses.unassigned']).toBe(5); // available/unused
    expect(by['licenses.expiring_90d']).toBe(1); // only Business Premium renews within 90 days
    expect(by['licenses.next_renewal']).toBe('2026-08-30'); // earliest upcoming
    // Per-SKU drill-down rides on the total.
    const total = metrics.find((m) => m.key === 'licenses.total')!;
    expect(total.details).toHaveLength(2);
    expect(total.details?.[0]).toMatchObject({ license: 'Microsoft 365 Business Premium', purchased: 25, assigned: 20, available: 5, renews: '2026-08-30' });
  });

  it('licenses: backward-compatible with count-only rows (no dates)', () => {
    const by = Object.fromEntries(normalizeCippLicenses([{ License: 'BP', CountUsed: 20, CountAvailable: 5 }]).map((m) => [m.key, m.value]));
    expect(by['licenses.assigned']).toBe(20);
    expect(by['licenses.unassigned']).toBe(5);
    expect(by['licenses.next_renewal']).toBeUndefined();
  });
});

describe('Google Workspace', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const saJson = JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: keyPem });

  it('signs a delegated JWT and computes 2SV coverage', async () => {
    const { http, requests } = fakeHttp((req) => {
      if (req.url.includes('/token')) {
        expect(req.body).toContain('jwt-bearer');
        return { status: 200, json: { access_token: 'gt', expires_in: 3600 } };
      }
      expect(req.headers?.['Authorization']).toBe('Bearer gt');
      return {
        status: 200,
        json: {
          users: [
            { isEnrolledIn2Sv: true },
            { isEnrolledIn2Sv: false },
            { suspended: true, isEnrolledIn2Sv: false },
          ],
        },
      };
    });
    const out = await collectGoogleWorkspace(
      { clientId: 'gclient', period: P },
      http,
      { adminEmail: 'admin@client.com', serviceAccountJson: saJson, tokenUrl: 'https://oauth.example/token', apiUrl: 'https://api.example' },
    );
    const by = Object.fromEntries(out.metrics.map((m) => [m.key, m.value]));
    expect(by['identity.users']).toBe(2); // suspended excluded
    expect(by['identity.mfa_coverage_pct']).toBe(50);
    expect(by['identity.suspended_users']).toBe(1);
    // The JWT claims include the impersonated admin (sub).
    const assertion = decodeURIComponent(String(requests[0]!.body).match(/assertion=([^&]+)/)![1]!);
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64').toString());
    expect(claims.sub).toBe('admin@client.com');
    expect(claims.iss).toBe('svc@proj.iam.gserviceaccount.com');
  });

  it('rejects a malformed service-account key with a clear message', async () => {
    const { http } = fakeHttp(() => ({ status: 200, json: {} }));
    const out = await collectGoogleWorkspace({ clientId: 'g', period: P }, http, { adminEmail: 'a@b.c', serviceAccountJson: 'not-json' });
    expect(out.warnings[0]).toMatch(/not valid JSON/);
  });

  it('normalizer flags users without 2SV', () => {
    const by = Object.fromEntries(
      normalizeGoogleWorkspaceUsers([{ isEnrolledIn2Sv: true }, { isEnrolledIn2Sv: false }, { isEnrolledIn2Sv: false }]).map((m) => [m.key, m.value]),
    );
    expect(by['identity.users_without_mfa']).toBe(2);
  });
});
