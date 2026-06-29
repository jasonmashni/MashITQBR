import { describe, it, expect } from 'vitest';
import type { MetricTrend } from '@mashit/core';
import { abbreviate, formatCurrency, formatPercent, formatTrend, formatValue, ratingColor } from '@mashit/report';

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

  it('formats metric values by unit', () => {
    expect(formatValue({ value: 4165, unit: 'USD' })).toBe('$4,165.00');
    expect(formatValue({ value: 87, unit: '%' })).toBe('87%');
    expect(formatValue({ value: 12_500_000, unit: 'events' })).toBe('12.5M');
    expect(formatValue({ value: 141, unit: 'count' })).toBe('141');
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

  it('maps ratings to brand colors', () => {
    expect(ratingColor('green')).toBe('#2e7d32');
    expect(ratingColor('red')).toBe('#c62828');
    expect(ratingColor('unknown')).toBe('#9e9e9e');
  });
});
