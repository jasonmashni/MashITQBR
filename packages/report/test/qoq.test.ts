import { describe, expect, it } from 'vitest';
import type { MetricTrend } from '@mashit/core';
import { pickMovers } from '@mashit/report';

const trend = (key: string, current: number, previous: number): MetricTrend => ({
  key,
  label: key,
  category: 'security',
  current,
  previous,
  deltaAbs: current - previous,
  deltaPct: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
  direction: current > previous ? 'up' : 'down',
  sentiment: 'neutral',
});

describe('deck QoQ movers', () => {
  it('excludes telemetry-volume metrics that wreck the shared axis', () => {
    const picked = pickMovers([
      trend('huntress.siem_logs', 90_000, 40_000), // excluded by key
      trend('backup.emails_protected', 250_000, 200_000), // excluded by magnitude
      trend('tickets.open', 12, 4),
      trend('huntress.edr_incidents', 3, 1),
      trend('identity.mfa_coverage_pct', 92, 80),
    ]);
    const keys = picked.map((t) => t.key);
    expect(keys).not.toContain('huntress.siem_logs');
    expect(keys).not.toContain('backup.emails_protected');
    expect(keys).toEqual(['tickets.open', 'huntress.edr_incidents', 'identity.mfa_coverage_pct']); // biggest % change first
  });

  it('drops metrics with no prior-quarter value or a zero base', () => {
    const picked = pickMovers([
      { ...trend('a.new', 5, 0), previous: null, deltaPct: null },
      trend('b.zero_base', 5, 0),
      trend('c.real', 10, 5),
    ]);
    expect(picked.map((t) => t.key)).toEqual(['c.real']);
  });
});
