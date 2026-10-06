import { describe, it, expect } from 'vitest';
import { extractNumbers, matchesAllowed, stripNonFigures } from '@mashit/narrative';

describe('extractNumbers', () => {
  it('parses plain integers and decimals', () => {
    expect(extractNumbers('141 tickets')).toEqual([141]);
    expect(extractNumbers('rate 99.42')).toEqual([99.42]);
  });

  it('parses thousands separators and currency', () => {
    expect(extractNumbers('$4,801.43/mo')).toEqual([4801.43]);
  });

  it('scales suffixes and word multipliers', () => {
    expect(extractNumbers('12.5M events')).toEqual([12_500_000]);
    expect(extractNumbers('12.5 million events')).toEqual([12_500_000]);
    expect(extractNumbers('72.8M logs')).toEqual([72_800_000]);
  });

  it('parses percentages as their numeric value', () => {
    expect(extractNumbers('up 200%')).toEqual([200]);
    expect(extractNumbers('87% compliance')).toEqual([87]);
  });

  it('ignores ISO dates', () => {
    expect(extractNumbers('On 2026-03-31 we closed 141 tickets')).toEqual([141]);
  });

  it('ignores period labels', () => {
    expect(extractNumbers('Q1 2026 and 2026-Q1')).toEqual([]);
    expect(extractNumbers('compared with Q3')).toEqual([]);
  });

  it('keeps a real figure that follows a quarter label', () => {
    expect(extractNumbers('In Q3 2600 email events')).toEqual([2600]);
    expect(extractNumbers('In 2600-Q3 terms')).toEqual([2600]);
  });

  it('ignores ticket subjects quoted in curly quotes', () => {
    expect(extractNumbers('3 tickets reference “windows” (e.g. “Windows 11 upgrade”, “exam room 3”)')).toEqual([3]);
  });

  it('ignores framework versions and product tokens', () => {
    expect(extractNumbers('CIS Controls v8, NIST CSF 2.0, M365, 24/7 SOC')).toEqual([]);
    expect(extractNumbers('O365 tenant')).toEqual([]);
  });

  it('drops the "/ 100" score denominator', () => {
    expect(extractNumbers('scored 72 / 100')).toEqual([72]);
    expect(extractNumbers('scored 72/100')).toEqual([72]);
  });

  it('reads a hyphen between digits as a range, not a negative', () => {
    expect(extractNumbers('3-5 days')).toEqual([3, 5]);
    expect(extractNumbers('down -5 points')).toEqual([-5]);
  });

  it('stripNonFigures removes non-figure tokens and keeps real figures', () => {
    expect(stripNonFigures('On 2026-03-31 in Q1 2026, M365 had 141 tickets')).not.toMatch(/2026|365/);
    expect(stripNonFigures('141 tickets')).toContain('141');
  });

  it('returns nothing for non-numeric text', () => {
    expect(extractNumbers('strong and stable')).toEqual([]);
    expect(extractNumbers('')).toEqual([]);
  });
});

describe('matchesAllowed', () => {
  it('matches exact and near values within tolerance', () => {
    expect(matchesAllowed(141, [141, 47])).toBe(true);
    expect(matchesAllowed(12_500_000, [12_500_000])).toBe(true);
    // 12.5M cited for 12,543,000 (within 1% relative tolerance)
    expect(matchesAllowed(12_500_000, [12_543_000])).toBe(true);
  });

  it('rejects values outside tolerance', () => {
    expect(matchesAllowed(140, [141])).toBe(false);
    expect(matchesAllowed(99.9, [141, 47, 200])).toBe(false);
  });
});
