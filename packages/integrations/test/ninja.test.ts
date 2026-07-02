import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import { collectNinja, functionMcpTransport, mapNinjaDevice, normalizeNinjaPosture } from '@mashit/integrations';

describe('normalizeNinjaPosture', () => {
  it('computes managed count, AV coverage, patch compliance, and warranty', () => {
    const by = Object.fromEntries(
      normalizeNinjaPosture([
        { antivirusActive: true, patchesInstalled: 90, patchesTotal: 100, warrantyExpired: false },
        { antivirusActive: true, patchesInstalled: 84, patchesTotal: 100, warrantyExpired: true },
        { antivirusActive: false, patchesInstalled: 100, patchesTotal: 100, warrantyExpired: true },
      ]).map((m) => [m.key, m.value]),
    );
    expect(by['endpoints.managed']).toBe(3);
    expect(by['endpoints.av_coverage_pct']).toBe(66.7); // 2 of 3
    expect(by['patch.compliance_pct']).toBe(91.3); // 274 / 300
    expect(by['assets.warranty_expired']).toBe(2);
  });

  it('returns only the managed count for an empty fleet', () => {
    const metrics = normalizeNinjaPosture([]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.value).toBe(0);
  });
});

describe('mapNinjaDevice', () => {
  it('reads AV status strings and warranty custom fields', () => {
    const d = mapNinjaDevice({ antivirusStatus: 'Active', customFields: { warrantyExpired: true } });
    expect(d.antivirusActive).toBe(true);
    expect(d.warrantyExpired).toBe(true);
  });
});

describe('collectNinja (live text formats)', () => {
  const DEVICES = `Devices for organization 3 (3 returned):
  [17] ANP-LAP-005 | Org: 3 | Role: 202 | Status: Unknown | OS:
  [24] ANP-LAP-001 | Org: 3 | Role: 202 | Status: Unknown | OS:
  [25] ANP-LAP-009 | Org: 3 | Role: 202 | Status: Unknown | OS: `;
  const AV = `Antivirus Status (3 results):
  {"productName": "Microsoft Defender Antivirus", "productState": "ON", "definitionStatus": "Up-to-Date", "deviceId": 17}
  {"productName": "Microsoft Defender Antivirus", "productState": "ON", "definitionStatus": "Up-to-Date", "deviceId": 24}
  {"productName": "Microsoft Defender Antivirus", "productState": "OFF", "definitionStatus": "Out-of-Date", "deviceId": 25}`;
  const PATCHES = `Pending OS Patches (2 results):
  {"name": "KB5058379", "deviceId": 25, "status": "APPROVED"}
  {"name": "KB5058380", "deviceId": 25, "status": "APPROVED"}`;

  it('computes device count, AV coverage, and patch compliance from text output', async () => {
    const mcp = functionMcpTransport(async (name, args) => {
      if (name === 'ninja_list_organization_devices') {
        expect(args['organization_id']).toBe(3);
        return { content: [{ type: 'text', text: DEVICES }] };
      }
      expect(String(args['device_filter'])).toBe('org = 3');
      const text = name === 'ninja_query_antivirus_status' ? AV : PATCHES;
      return { content: [{ type: 'text', text }] };
    });
    const result = await collectNinja({ clientId: 'anp', period: makePeriod(2026, 1), externalRef: '3' }, mcp);
    const by = Object.fromEntries(result.metrics.map((m) => [m.key, m.value]));
    expect(by['endpoints.managed']).toBe(3);
    expect(by['endpoints.av_coverage_pct']).toBe(66.7); // 2 of 3 ON
    expect(by['endpoints.av_definitions_pct']).toBe(66.7);
    expect(by['patch.pending']).toBe(2);
    expect(by['patch.compliance_pct']).toBe(66.7); // 1 device of 3 has pending patches
    expect(result.warnings.some((w) => /Warranty/.test(w))).toBe(true);
  });

  it('warns and stops when the org has no devices', async () => {
    const mcp = functionMcpTransport(async () => ({ content: [{ type: 'text', text: 'Devices for organization 9 (0 returned):' }] }));
    const result = await collectNinja({ clientId: 'x', period: makePeriod(2026, 1), externalRef: '9' }, mcp);
    const by = Object.fromEntries(result.metrics.map((m) => [m.key, m.value]));
    expect(by['endpoints.managed']).toBe(0);
    expect(result.warnings[0]).toMatch(/No NinjaOne devices/);
  });
});
