import { describe, expect, it } from 'vitest';
import { lastPeriods, parsePeriodId } from '../src/periods.js';
import { chooseLandingPeriod, nextPeriodIn } from '../src/pages/workspace/landing.js';

describe('parsePeriodId', () => {
  it('parses valid ids and rejects junk', () => {
    expect(parsePeriodId('2026-Q3')).toEqual({ year: 2026, quarter: 3 });
    expect(parsePeriodId('2026-Q5')).toBeNull();
    expect(parsePeriodId('Q3-2026')).toBeNull();
    expect(parsePeriodId('')).toBeNull();
  });
});

describe('lastPeriods', () => {
  it('walks quarters back, newest first', () => {
    expect(lastPeriods('2026-Q3', 4)).toEqual(['2026-Q3', '2026-Q2', '2026-Q1', '2025-Q4']);
  });

  it('wraps across year boundaries', () => {
    expect(lastPeriods('2026-Q1', 8)).toEqual([
      '2026-Q1',
      '2025-Q4',
      '2025-Q3',
      '2025-Q2',
      '2025-Q1',
      '2024-Q4',
      '2024-Q3',
      '2024-Q2',
    ]);
  });

  it('returns the input untouched when malformed', () => {
    expect(lastPeriods('bogus', 4)).toEqual(['bogus']);
  });
});

describe('chooseLandingPeriod', () => {
  const lock = { at: '2026-07-20T00:00:00Z', by: 'jason', version: 2 };
  const list = (rows: Array<[string, boolean, boolean?]>) => rows.map(([period, hasSnapshot, final]) => ({ period, hasSnapshot, locks: final ? { final: lock } : undefined }));

  it('lands on the open quarter: data and no final lock', () => {
    expect(chooseLandingPeriod(list([['2026-Q3', true], ['2026-Q2', true, true], ['2026-Q1', true, true]]), null)).toBe('2026-Q3');
  });

  it('falls back to the newest final quarter when nothing is open', () => {
    expect(chooseLandingPeriod(list([['2026-Q3', false], ['2026-Q2', true, true], ['2026-Q1', true, true]]), null)).toBe('2026-Q2');
  });

  it('an unfinalized quarter older than the newest final one is not the landing quarter', () => {
    expect(chooseLandingPeriod(list([['2026-Q3', false], ['2026-Q2', true, true], ['2026-Q1', true]]), null)).toBe('2026-Q2');
  });

  it('lands on the newest quarter when nothing has data', () => {
    expect(chooseLandingPeriod(list([['2026-Q3', false], ['2026-Q2', false]]), null)).toBe('2026-Q3');
    expect(chooseLandingPeriod([], null)).toBeUndefined();
  });

  it('?period= wins when it is in the list', () => {
    const l = list([['2026-Q3', true], ['2026-Q2', true, true]]);
    expect(chooseLandingPeriod(l, '2026-Q2')).toBe('2026-Q2');
    expect(chooseLandingPeriod(l, '2019-Q1')).toBe('2026-Q3');
  });

  it('nextPeriodIn finds the following quarter only when the list has it', () => {
    const l = list([['2026-Q3', false], ['2026-Q2', true, true]]);
    expect(nextPeriodIn(l, '2026-Q2')).toBe('2026-Q3');
    expect(nextPeriodIn(l, '2026-Q3')).toBeUndefined();
  });
});
