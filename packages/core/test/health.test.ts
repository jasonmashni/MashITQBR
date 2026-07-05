import { describe, it, expect } from 'vitest';
import { computeAccountHealth, daysSince, type HealthSignals } from '@mashit/core';

const base: HealthSignals = { securityScore: 90, flags: [], daysSinceQbr: 10 };

describe('computeAccountHealth', () => {
  it('is green and self-explanatory when posture, activity and engagement are all healthy', () => {
    const h = computeAccountHealth(base);
    expect(h.score).toBe(90);
    expect(h.rating).toBe('green');
    expect(h.drivers[0]).toMatch(/healthy/i);
  });

  it('penalizes red flags harder than ambers and names the critical ones', () => {
    const h = computeAccountHealth({
      ...base,
      flags: [{ severity: 'red' }, { severity: 'red' }, { severity: 'amber' }],
    });
    // 90 - (2*8 + 1*3) = 71
    expect(h.score).toBe(71);
    expect(h.rating).toBe('amber');
    expect(h.drivers.join(' ')).toMatch(/2 critical flags/);
  });

  it('drags health down when the QBR is overdue', () => {
    const fresh = computeAccountHealth({ ...base, daysSinceQbr: 30 });
    const overdue = computeAccountHealth({ ...base, daysSinceQbr: 300 });
    expect(overdue.score).toBeLessThan(fresh.score);
    expect(overdue.drivers.join(' ')).toMatch(/overdue/i);
  });

  it('treats unknown security posture as a mild unknown-risk baseline', () => {
    const h = computeAccountHealth({ securityScore: null, flags: [], daysSinceQbr: 5 });
    expect(h.score).toBe(60);
    expect(h.drivers.join(' ')).toMatch(/no security data/i);
  });

  it('flags a steep spend drop as a churn signal and clamps to 0', () => {
    const h = computeAccountHealth({
      securityScore: 20,
      flags: [{ severity: 'red' }, { severity: 'red' }, { severity: 'red' }],
      daysSinceQbr: null,
      spendDeltaPct: -40,
    });
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.drivers.join(' ')).toMatch(/spend down 40%/i);
    expect(h.rating).toBe('red');
  });
});

describe('daysSince', () => {
  it('counts whole days back from a reference now', () => {
    const now = new Date('2026-07-05T00:00:00.000Z');
    expect(daysSince('2026-07-01T00:00:00.000Z', now)).toBe(4);
  });
  it('is null for absent or unparseable timestamps', () => {
    expect(daysSince(undefined)).toBeNull();
    expect(daysSince('not-a-date')).toBeNull();
  });
});
