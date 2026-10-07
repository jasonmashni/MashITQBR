import { describe, it, expect } from 'vitest';
import { makePeriod, parsePeriod, previousPeriod, periodFor, fiscalYearOf, planningPeriodFor, isPlanningPeriod, fiscalPeriods } from '@mashit/core';

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

describe('fiscal year helpers', () => {
  it('labels fiscal years by the year they end', () => {
    expect(fiscalYearOf('2026-Q3', 1)).toEqual({ label: 2026, startPeriod: '2026-Q1', endPeriod: '2026-Q4', startMonth: 1 });
    expect(fiscalYearOf('2026-Q3', 7)).toEqual({ label: 2027, startPeriod: '2026-Q3', endPeriod: '2027-Q2', startMonth: 7 });
    expect(fiscalYearOf('2026-Q2', 7).label).toBe(2026);
  });
  it('finds the review quarter before the fiscal year turns', () => {
    expect(planningPeriodFor(2027, 1)).toBe('2026-Q3');
    expect(planningPeriodFor(2027, 4)).toBe('2025-Q4');
    expect(planningPeriodFor(2027, 7)).toBe('2026-Q1');
    expect(planningPeriodFor(2027, 10)).toBe('2026-Q2');
    expect(isPlanningPeriod('2026-Q3', 1)).toBe(true);
    expect(isPlanningPeriod('2026-Q2', 1)).toBe(false);
    expect(isPlanningPeriod('2026-Q1', 7)).toBe(true);
  });
  it('rejects malformed ids and treats undefined start month as January', () => {
    expect(() => fiscalYearOf('nope')).toThrow(/Invalid period id/);
    expect(isPlanningPeriod('2026-Q3', undefined)).toBe(true);
    expect(fiscalPeriods(2027, 7)).toEqual(['2026-Q3', '2026-Q4', '2027-Q1', '2027-Q2']);
  });
  it('handles all four start quarters for one fiscal year', () => {
    expect(fiscalPeriods(2027, 1)).toEqual(['2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4']);
    expect(fiscalPeriods(2027, 4)).toEqual(['2026-Q2', '2026-Q3', '2026-Q4', '2027-Q1']);
    expect(fiscalYearOf('2027-Q1', 4)).toMatchObject({ label: 2027, startPeriod: '2026-Q2', endPeriod: '2027-Q1' });
    expect(fiscalYearOf('2026-Q4', 10)).toMatchObject({ label: 2027, startPeriod: '2026-Q4', endPeriod: '2027-Q3' });
    expect(isPlanningPeriod('2025-Q4', 4)).toBe(true);
    expect(isPlanningPeriod('2026-Q2', 10)).toBe(true);
  });
});
