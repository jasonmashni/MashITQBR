import { describe, it, expect } from 'vitest';
import { mapNinjaDevice, normalizeNinjaPosture } from '@mashit/integrations';

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
