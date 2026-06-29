import { describe, it, expect } from 'vitest';
import { extractNumbers, matchesAllowed } from '@mashit/narrative';

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
