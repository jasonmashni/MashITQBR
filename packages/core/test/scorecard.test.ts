import { describe, it, expect } from 'vitest';
import { computeScorecard, ratingFor, findSeedSnapshot, SAFEGUARDS } from '@mashit/core';

describe('blended CIS/NIST maturity scorecard', () => {
  const kpca = findSeedSnapshot('kpca', '2026-Q1')!;
  const card = computeScorecard(kpca);

  it('produces an overall score and rating', () => {
    expect(card.overall.score).not.toBeNull();
    expect(card.overall.score!).toBeGreaterThan(0);
    expect(card.overall.score!).toBeLessThanOrEqual(100);
    expect(['green', 'amber', 'red']).toContain(card.overall.rating);
  });

  it('covers all six NIST CSF 2.0 functions', () => {
    const fns = card.functions.map((f) => f.function);
    expect(fns).toEqual(['GOVERN', 'IDENTIFY', 'PROTECT', 'DETECT', 'RESPOND', 'RECOVER']);
  });

  it('scores measured safeguards and flags unmeasured ones honestly', () => {
    const mfa = card.safeguards.find((s) => s.id === 'mfa')!;
    // KPCA QBR does not state an MFA coverage %, so it must read as unknown, not 0.
    expect(mfa.measured).toBe(false);
    expect(mfa.rating).toBe('unknown');

    const patching = card.safeguards.find((s) => s.id === 'patching')!;
    expect(patching.measured).toBe(true);
    expect(patching.score).toBe(87);
    expect(patching.rating).toBe('green');

    const email = card.safeguards.find((s) => s.id === 'email_security')!;
    expect(email.score).toBe(100); // zero malicious clicks
  });

  it('reports coverage between 0 and 1 and never exceeds full weight', () => {
    expect(card.overall.coverage).toBeGreaterThan(0);
    expect(card.overall.coverage).toBeLessThanOrEqual(1);
  });

  it('sorts remediations worst-first and only includes measured amber/red', () => {
    for (const r of card.remediations) {
      expect(r.measured).toBe(true);
      expect(['amber', 'red']).toContain(r.rating);
    }
    const scores = card.remediations.map((r) => r.score as number);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });

  it('honors weight overrides', () => {
    const boosted = computeScorecard(kpca, { patching: 100 });
    const base = computeScorecard(kpca);
    expect(boosted.overall.score).not.toBe(base.overall.score);
  });

  it('rating thresholds behave at the boundaries', () => {
    expect(ratingFor(80)).toBe('green');
    expect(ratingFor(79.9)).toBe('amber');
    expect(ratingFor(50)).toBe('amber');
    expect(ratingFor(49.9)).toBe('red');
    expect(ratingFor(null)).toBe('unknown');
  });

  it('every safeguard maps to a CIS control and a NIST function', () => {
    for (const s of SAFEGUARDS) {
      expect(s.cisControl).toMatch(/^CIS \d/);
      expect(s.nistFunction).toBeTruthy();
      expect(s.weight).toBeGreaterThan(0);
    }
  });
});
