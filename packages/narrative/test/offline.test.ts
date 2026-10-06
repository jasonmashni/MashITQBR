import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot, previousPeriod, type MetricSnapshot } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildNarrativeInput,
  draftOfflineNarrative,
  verifyFigures,
  verifyNarrative,
} from '@mashit/narrative';

describe('draftOfflineNarrative', () => {
  for (const client of SEED_CLIENTS) {
    it(`produces a self-verifying narrative for ${client.id}`, () => {
      const current = findSeedSnapshot(client.id, '2026-Q1')!;
      const previous = findSeedSnapshot(client.id, previousPeriod('2026-Q1').id);
      const input = buildNarrativeInput({ client, current, previous });
      const draft = draftOfflineNarrative(input);

      // Every figure it cites must be traceable — verification must pass.
      const result = verifyFigures(draft.figures_referenced, buildAllowedNumbers(input));
      expect(result.ok).toBe(true);
      // ...and so must every number in its prose.
      expect(verifyNarrative(draft, buildAllowedNumbers(input)).ok).toBe(true);
      expect(draft.headline).toContain('2026');
      expect(draft.summary_paragraphs.length).toBeGreaterThan(0);
    });
  }

  it('says "not measured" for absent metrics instead of asserting health', () => {
    const client = SEED_CLIENTS[0]!;
    const current: MetricSnapshot = {
      clientId: client.id,
      period: '2026-Q3',
      capturedAt: '2026-09-30T00:00:00Z',
      metrics: [
        { key: 'backup.m365_accounts', label: 'M365 accounts backed up', value: 18, unit: 'count', source: 'dropsuite', category: 'backup' },
        { key: 'endpoints.managed', label: 'Managed endpoints', value: 40, unit: 'count', source: 'ninja', category: 'infrastructure' },
      ],
    };
    const draft = draftOfflineNarrative(buildNarrativeInput({ client, current }));
    const section = (c: string) => draft.section_summaries!.find((s) => s.category === c)!.summary;

    expect(section('backup')).toMatch(/not measured this quarter/);
    expect(section('infrastructure')).toMatch(/not measured this quarter/);
    const all = JSON.stringify(draft);
    expect(all).not.toMatch(/healthy/i);
    expect(all).not.toMatch(/no urgent refresh risk/i);
  });

  it('reports zero failures and zero expired warranties as measured zeros', () => {
    const client = SEED_CLIENTS[0]!;
    const current: MetricSnapshot = {
      clientId: client.id,
      period: '2026-Q3',
      capturedAt: '2026-09-30T00:00:00Z',
      metrics: [
        { key: 'backup.failed_jobs', label: 'Failed backups', value: 0, unit: 'count', source: 'ninja', category: 'backup' },
        { key: 'assets.warranty_expired', label: 'Out of warranty', value: 0, unit: 'count', source: 'ninja', category: 'infrastructure' },
      ],
    };
    const draft = draftOfflineNarrative(buildNarrativeInput({ client, current }));
    const section = (c: string) => draft.section_summaries!.find((s) => s.category === c)!.summary;
    expect(section('backup')).not.toMatch(/not measured/);
    expect(section('infrastructure')).not.toMatch(/not measured/);
  });

  it('does not claim a posture when the scorecard is unknown', () => {
    const client = SEED_CLIENTS[0]!;
    const current: MetricSnapshot = {
      clientId: client.id,
      period: '2026-Q3',
      capturedAt: '2026-09-30T00:00:00Z',
      metrics: [{ key: 'huntress.siem_logs', label: 'SIEM logs', value: 5, source: 'huntress', category: 'security' }],
    };
    const draft = draftOfflineNarrative(buildNarrativeInput({ client, current }));
    expect(draft.headline).toMatch(/not enough data/i);
    expect(draft.section_summaries!.find((s) => s.category === 'security')!.summary).toMatch(/not enough data/i);
  });
});
