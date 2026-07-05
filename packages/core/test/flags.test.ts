import { describe, it, expect } from 'vitest';
import { computeFlags, type MetricSnapshot, type MetricValue } from '@mashit/core';

const snap = (metrics: Array<[string, number]>): MetricSnapshot => ({
  clientId: 'c1',
  period: '2026-Q2',
  capturedAt: '2026-07-01T00:00:00.000Z',
  metrics: metrics.map(([key, value]): MetricValue => ({ key, label: key, value, source: 'manual', category: 'security' })),
});

describe('computeFlags', () => {
  it('flags posture gaps, failures, and expired hardware with severities', () => {
    const flags = computeFlags(
      snap([
        ['patch.compliance_pct', 55], // red (<60)
        ['identity.mfa_coverage_pct', 85], // amber
        ['backup.failed_jobs', 2], // red
        ['assets.warranty_expired', 4], // amber
        ['vuln.critical', 1], // red
      ]),
    );
    const labels = flags.map((f) => f.label);
    expect(labels).toContain('Patch compliance 55%');
    expect(labels).toContain('MFA coverage 85%');
    expect(labels).toContain('2 failing backups');
    expect(labels).toContain('4 devices out of warranty');
    expect(labels).toContain('1 critical vulnerability');
    // Reds sort before ambers; capped at 5.
    expect(flags[0]!.severity).toBe('red');
    expect(flags.length).toBeLessThanOrEqual(5);
  });

  it('flags a maturity rating drop and a spend spike QoQ', () => {
    const current = snap([['finance.quarter_invoiced', 15000]]);
    const previous = snap([['finance.quarter_invoiced', 10000]]);
    const flags = computeFlags(current, previous, { current: 'amber', previous: 'green' });
    expect(flags.map((f) => f.label)).toContain('Maturity dropped (green → amber)');
    expect(flags.map((f) => f.label)).toContain('Spend up 50% QoQ');
  });

  it('flags agreements up for renewal', () => {
    const flags = computeFlags(snap([['finance.contracts_expiring', 2]]));
    expect(flags.map((f) => f.label)).toContain('2 agreements up for renewal');
    expect(computeFlags(snap([['finance.contracts_expiring', 1]])).map((f) => f.label)).toContain('1 agreement up for renewal');
  });

  it('stays quiet when posture is healthy', () => {
    const flags = computeFlags(
      snap([
        ['patch.compliance_pct', 95],
        ['identity.mfa_coverage_pct', 98],
        ['backup.failed_jobs', 0],
        ['assets.warranty_expired', 0],
      ]),
      undefined,
      { current: 'green', previous: 'green' },
    );
    expect(flags).toHaveLength(0);
  });

  it('handles a missing snapshot', () => {
    expect(computeFlags(undefined)).toHaveLength(0);
  });
});
