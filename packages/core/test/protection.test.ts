import { describe, it, expect } from 'vitest';
import { computeScorecard, findSeedSnapshot, PROTECTION_QUESTIONS, protectionRows, type MetricSnapshot } from '@mashit/core';

const anp = findSeedSnapshot('anp', '2026-Q1')!;

describe('protection questions', () => {
  it('defines the five questions in order with their safeguards', () => {
    expect(PROTECTION_QUESTIONS.map((q) => q.id)).toEqual(['get_in', 'know', 'recover', 'keep_up', 'run_well']);
    expect(PROTECTION_QUESTIONS.map((q) => q.question)).toEqual([
      'Can someone get in?',
      'Would we know, and how fast would we act?',
      'Could we recover?',
      'Are we keeping up?',
      'Are we running it well?',
    ]);
    expect(PROTECTION_QUESTIONS.find((q) => q.id === 'know')!.safeguards).toEqual(['edr', 'identity_threat', 'siem', 'incident_response']);
    expect(PROTECTION_QUESTIONS.find((q) => q.id === 'keep_up')!.safeguards).toEqual(['patching', 'asset_inventory']);
  });

  it('groups the ANP scorecard into five rows in order', () => {
    const rows = protectionRows(computeScorecard(anp));
    expect(rows.map((r) => r.id)).toEqual(['get_in', 'know', 'recover', 'keep_up', 'run_well']);
    const getIn = rows[0]!;
    expect(getIn.question).toBe('Can someone get in?');
    expect(getIn.safeguards.map((s) => s.id)).toEqual(['mfa', 'email_security']);
    // Distinct NIST functions of the group, each with the scorecard's function score.
    const sc = computeScorecard(anp);
    expect(getIn.functions).toEqual([{ function: 'PROTECT', score: sc.functions.find((f) => f.function === 'PROTECT')!.score }]);
    const know = rows[1]!;
    expect(know.functions.map((f) => f.function)).toEqual(['DETECT', 'RESPOND']);
  });

  it('rates a question by its worst measured safeguard', () => {
    // 10 devices past warranty scores asset_inventory 50 (amber).
    const amberAssets: MetricSnapshot = {
      ...anp,
      metrics: anp.metrics.map((m) => (m.key === 'assets.warranty_expired' ? { ...m, value: 10 } : m)),
    };
    const sc = computeScorecard(amberAssets);
    expect(sc.safeguards.find((s) => s.id === 'asset_inventory')!.rating).toBe('amber');
    const keepUp = protectionRows(sc).find((r) => r.id === 'keep_up')!;
    expect(['amber', 'red']).toContain(keepUp.rating);

    const mixed: MetricSnapshot = {
      ...amberAssets,
      metrics: [...amberAssets.metrics, { key: 'patch.compliance_pct', label: 'Patch', value: 30, source: 'ninja', category: 'security' }],
    };
    expect(protectionRows(computeScorecard(mixed)).find((r) => r.id === 'keep_up')!.rating).toBe('red');
  });

  it('yields five unknown rows when nothing is measured', () => {
    const empty: MetricSnapshot = { clientId: 'x', period: '2026-Q2', capturedAt: '2026-06-30T00:00:00Z', metrics: [] };
    const rows = protectionRows(computeScorecard(empty));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.rating === 'unknown')).toBe(true);
  });
});
