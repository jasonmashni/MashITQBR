import { describe, it, expect } from 'vitest';
import type { MetricTrend } from '@mashit/core';
import { abbreviate, formatCurrency, formatPercent, formatTrend, formatValue, ratingColor, trendDeltaText } from '@mashit/report';

describe('format helpers', () => {
  it('abbreviates large magnitudes', () => {
    expect(abbreviate(917_000)).toBe('917K');
    expect(abbreviate(12_500_000)).toBe('12.5M');
    expect(abbreviate(2_600)).toBe('2.6K');
    expect(abbreviate(42)).toBe('42');
  });

  it('formats currency and percent', () => {
    expect(formatCurrency(4801.43)).toBe('$4,801.43');
    expect(formatPercent(87)).toBe('87%');
  });

  it('whole-dollar amounts carry no cents; fractional ones keep two', () => {
    expect(formatCurrency(4165)).toBe('$4,165');
    expect(formatCurrency(441.1)).toBe('$441.10');
    expect(formatCurrency(1_250_000)).toBe('$1,250,000');
    expect(formatCurrency(-300)).toBe('-$300');
  });

  it('a move from zero reads as the honest pair, never as a percent or blank', () => {
    const fromZero: MetricTrend = {
      key: 'huntress.edr_incidents', label: 'EDR incidents', category: 'security',
      current: 3, previous: 0, deltaAbs: 3, deltaPct: null, direction: 'up', sentiment: 'negative',
    };
    expect(trendDeltaText(fromZero)).toBe('0 → 3');
    expect(formatTrend(fromZero)).toBe('▲ 0 → 3');
    // A genuine "no prior quarter" stays blank.
    expect(trendDeltaText({ ...fromZero, previous: null, deltaAbs: null, direction: 'na', sentiment: 'na' })).toBe('');
  });

  it('formats metric values by unit', () => {
    expect(formatValue({ value: 4165, unit: 'USD' })).toBe('$4,165');
    expect(formatValue({ value: 87, unit: '%' })).toBe('87%');
    expect(formatValue({ value: 12_500_000, unit: 'events' })).toBe('12.5M');
    expect(formatValue({ value: 141, unit: 'count' })).toBe('141');
    // Millions compact; fractions keep one decimal with their unit.
    expect(formatValue({ value: 68_486_683, unit: 'count' })).toBe('68.5M');
    expect(formatValue({ value: 77.83365884423256, unit: 'GB' })).toBe('77.8 GB');
    expect(formatValue({ value: 12_500, unit: 'count' })).toBe('12,500');
    expect(formatValue({ value: null })).toBe('—');
  });

  it('renders trend arrows with sign', () => {
    const up: MetricTrend = {
      key: 'tickets.total', label: 'Tickets', category: 'operations',
      current: 141, previous: 47, deltaAbs: 94, deltaPct: 200, direction: 'up', sentiment: 'negative',
    };
    expect(formatTrend(up)).toBe('▲ +200%');
    const na: MetricTrend = { ...up, previous: null, deltaAbs: null, deltaPct: null, direction: 'na', sentiment: 'na' };
    expect(formatTrend(na)).toBe('');
  });

  it('caps screaming percentages from tiny prior quarters at "prev → cur"', () => {
    const base: MetricTrend = {
      key: 'tickets.opened', label: 'Tickets opened', category: 'operations',
      current: 62, previous: 3, deltaAbs: 59, deltaPct: 1966.67, direction: 'up', sentiment: 'neutral',
    };
    expect(trendDeltaText(base)).toBe('3 → 62'); // +1966.7% told the wrong story
    expect(formatTrend(base)).toBe('▲ 3 → 62');
    expect(trendDeltaText({ ...base, current: 141, previous: 47, deltaPct: 200 })).toBe('+200%'); // sane ratios keep the percent
    expect(trendDeltaText({ ...base, current: 3, previous: 3, deltaAbs: 0, deltaPct: 0, direction: 'flat' })).toBe('flat');
  });

  it('maps ratings to the shared semantic palette', () => {
    expect(ratingColor('green')).toBe('#0e7c72');
    expect(ratingColor('amber')).toBe('#9a5b00');
    expect(ratingColor('red')).toBe('#b42318');
    expect(ratingColor('unknown')).toBe('#6b7a90');
  });
});
