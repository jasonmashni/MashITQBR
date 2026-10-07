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

describe('scorecard honesty on thin data', () => {
  it('an empty snapshot is unknown, not 80/green', () => {
    const card = computeScorecard({ clientId: 'x', period: '2026-Q3', capturedAt: '2026-09-30T00:00:00Z', metrics: [] });
    expect(card.overall.score).toBeNull();
    expect(card.overall.rating).toBe('unknown');
    expect(card.overall.confidence).toBe('low');
    expect(card.safeguards.find((s) => s.id === 'governance')!.measured).toBe(false);
  });
  it('a Halo-only snapshot (tickets + spend) is unknown', () => {
    const card = computeScorecard({ clientId: 'x', period: '2026-Q3', capturedAt: '2026-09-30T00:00:00Z', metrics: [
      { key: 'tickets.total', label: 'Total tickets', value: 141, source: 'halo', category: 'operations' },
      { key: 'finance.mrr', label: 'MRR', value: 4000, unit: 'USD', source: 'halo', category: 'spend' },
    ] });
    expect(card.overall.score).toBeNull();
    expect(card.overall.rating).toBe('unknown');
  });
  it('absent penalty inputs do not score as perfect', () => {
    const card = computeScorecard({ clientId: 'x', period: '2026-Q3', capturedAt: '2026-09-30T00:00:00Z', metrics: [
      { key: 'email.events_total', label: 'Email events', value: 2600, source: 'checkpoint', category: 'security' },
      { key: 'huntress.m365_events', label: 'M365 events', value: 917000, source: 'huntress', category: 'security' },
      { key: 'huntress.endpoints', label: 'Endpoints', value: 103, source: 'huntress', category: 'security' },
    ] });
    for (const id of ['email_security', 'identity_threat', 'edr']) {
      const s = card.safeguards.find((x) => x.id === id)!;
      expect(s.measured, id).toBe(false);
    }
  });
});
