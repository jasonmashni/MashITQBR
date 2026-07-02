import { describe, expect, it } from 'vitest';
import { lastPeriods, parsePeriodId } from '../src/periods.js';

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
