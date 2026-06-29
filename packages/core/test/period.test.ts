import { describe, it, expect } from 'vitest';
import { makePeriod, parsePeriod, previousPeriod, periodFor } from '@mashit/core';

describe('period helpers', () => {
  it('builds a quarter period with correct bounds', () => {
    const p = makePeriod(2026, 1);
    expect(p).toMatchObject({ id: '2026-Q1', start: '2026-01-01', end: '2026-03-31', label: 'Q1 2026' });
  });

  it('handles Q4 end-of-year correctly', () => {
    expect(makePeriod(2025, 4)).toMatchObject({ start: '2025-10-01', end: '2025-12-31' });
  });

  it('parses period ids and rejects malformed input', () => {
    expect(parsePeriod('2026-Q3').quarter).toBe(3);
    expect(() => parsePeriod('2026-Q5')).toThrow();
    expect(() => parsePeriod('nope')).toThrow();
  });

  it('computes the previous period and wraps the year', () => {
    expect(previousPeriod('2026-Q1').id).toBe('2025-Q4');
    expect(previousPeriod('2026-Q3').id).toBe('2026-Q2');
  });

  it('derives the period containing a date', () => {
    expect(periodFor(new Date('2026-02-15T00:00:00Z')).id).toBe('2026-Q1');
    expect(periodFor(new Date('2026-11-01T00:00:00Z')).id).toBe('2026-Q4');
  });
});
