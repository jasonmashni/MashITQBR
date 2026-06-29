import { describe, it, expect } from 'vitest';
import { verifyFigures } from '@mashit/narrative';

describe('verifyFigures', () => {
  const allowed = [141, 47, 94, 200];

  it('passes when every cited number is traceable', () => {
    const result = verifyFigures(
      [{ label: 'ticket volume', value: '141 (up from 47, +200%)' }],
      allowed,
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('flags a fabricated figure', () => {
    const result = verifyFigures([{ label: 'uptime', value: '99.9%' }], allowed);
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.unmatched).toContain(99.9);
  });

  it('treats non-numeric values as verified', () => {
    const result = verifyFigures([{ label: 'posture', value: 'strong' }], allowed);
    expect(result.ok).toBe(true);
  });

  it('flags only the bad number in a mixed value', () => {
    const result = verifyFigures([{ label: 'mixed', value: '141 tickets and 7 outages' }], allowed);
    expect(result.ok).toBe(false);
    expect(result.failures[0]!.unmatched).toEqual([7]);
  });
});
