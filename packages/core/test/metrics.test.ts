import { describe, it, expect } from 'vitest';
import { computeTrends, indexTrends, findSeedSnapshot } from '@mashit/core';

describe('QoQ trend engine', () => {
  const anpQ1 = findSeedSnapshot('anp', '2026-Q1')!;
  const anpQ4 = findSeedSnapshot('anp', '2025-Q4')!;

  it('computes absolute and percentage deltas with correct direction', () => {
    const trends = indexTrends(computeTrends(anpQ1, anpQ4));
    const tickets = trends.get('tickets.total')!;
    expect(tickets.current).toBe(141);
    expect(tickets.previous).toBe(47);
    expect(tickets.deltaAbs).toBe(94);
    expect(tickets.deltaPct).toBe(200);
    expect(tickets.direction).toBe('up');
    // More tickets is not inherently good for the client.
    expect(tickets.sentiment).toBe('negative');
  });

  it('marks metrics with no prior value as n/a', () => {
    const trends = indexTrends(computeTrends(anpQ1, anpQ4));
    const phishing = trends.get('email.phishing')!;
    expect(phishing.previous).toBeNull();
    expect(phishing.direction).toBe('na');
    expect(phishing.sentiment).toBe('na');
  });

  it('only produces trends for numeric metrics', () => {
    const trends = computeTrends(anpQ1, anpQ4);
    expect(trends.every((t) => typeof t.current === 'number')).toBe(true);
  });

  it('works with no previous snapshot', () => {
    const trends = computeTrends(anpQ1);
    expect(trends.length).toBeGreaterThan(0);
    expect(trends.every((t) => t.previous === null)).toBe(true);
  });
});
