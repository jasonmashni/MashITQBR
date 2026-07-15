import { describe, expect, it } from 'vitest';
import type { MetricTrend } from '@mashit/core';
import { discussionOutcome, firstSentence, imageDims, operationalQoQ, pickMovers } from '@mashit/report';

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

describe('operationalQoQ (deck service-desk chart)', () => {
  it('keeps ticket counts in a fixed order and excludes automated alerts', () => {
    const out = operationalQoQ([
      trend('tickets.alerts', 438, 1023), // must be excluded — it dwarfs the axis
      trend('sla.breaches', 5, 17),
      trend('tickets.total', 62, 116),
      trend('finance.invoiced.other', 1444, 6147), // dollars — not a ticket count
      trend('tickets.incidents', 13, 39),
    ]);
    expect(out.map((t) => t.key)).toEqual(['tickets.total', 'tickets.incidents', 'sla.breaches']);
  });

  it('drops metrics missing a prior quarter (needs both bars)', () => {
    const out = operationalQoQ([{ ...trend('tickets.total', 62, 0), previous: null }]);
    expect(out).toHaveLength(0);
  });
});

describe('firstSentence (exec-slide bullet from a paragraph)', () => {
  it('takes the first sentence and leaves the rest for the notes', () => {
    expect(firstSentence('Incidents fell sharply. Everything else held steady.')).toBe('Incidents fell sharply.');
    expect(firstSentence('No period here')).toBe('No period here');
  });
});

describe('discussionOutcome', () => {
  it('reads "To discuss" for unanswered agenda items, never "Pending"', () => {
    expect(discussionOutcome({ disposition: 'pending', status: 'planned' })).toBe('To discuss');
    expect(discussionOutcome({ status: 'planned' })).toBe('To discuss');
    expect(discussionOutcome({ disposition: 'pending', status: 'discussed' })).toBe('Discussed');
    expect(discussionOutcome({ disposition: 'create_ticket' })).toBe('Ticket');
    expect(discussionOutcome({ disposition: 'no_action', status: 'planned' })).toBe('No action');
  });
});

describe('imageDims (deck logo aspect ratio)', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from('IHDR'),
      Buffer.from([0, 0, 1, 0x2c, 0, 0, 0, 0x64, 8, 6, 0, 0, 0]), // 300 × 100
    ]);
    expect(imageDims(`data:image/png;base64,${png.toString('base64')}`)).toEqual({ w: 300, h: 100 });
  });

  it('reads SVG dimensions from attributes and viewBox', () => {
    const svg = (markup: string) => `data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`;
    expect(imageDims(svg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="64"></svg>'))).toEqual({ w: 300, h: 64 });
    expect(imageDims(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>'))).toEqual({ w: 120, h: 40 });
  });

  it('returns undefined for unreadable input (caller keeps the raw box)', () => {
    expect(imageDims('data:image/png;base64,AAAA')).toBeUndefined();
    expect(imageDims('not-a-data-uri')).toBeUndefined();
  });
});
