import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, SEED_SNAPSHOTS, findSeedSnapshot, previousPeriod, type MetricSnapshot } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildAllowedQuotes,
  buildNarrativeInput,
  draftOfflineNarrative,
  limitIssues,
  verifyFigures,
  verifyNarrative,
} from '@mashit/narrative';

describe('draftOfflineNarrative v4', () => {
  it('stays within every limit, answers the five questions in order, verifies and lints clean on every seed snapshot', () => {
    for (const current of SEED_SNAPSHOTS) {
      const client = SEED_CLIENTS.find((c) => c.id === current.clientId);
      if (!client) continue;
      const previous = findSeedSnapshot(client.id, previousPeriod(current.period).id);
      const input = buildNarrativeInput({ client, current, previous });
      const draft = draftOfflineNarrative(input);
      const r = verifyNarrative(draft, buildAllowedNumbers(input), { allowedQuotes: buildAllowedQuotes(input) });
      expect({ id: client.id, period: current.period, limits: limitIssues(draft), failures: r.failures, style: r.style }).toEqual({
        id: client.id,
        period: current.period,
        limits: [],
        failures: [],
        style: [],
      });
      expect(draft.protection.map((p) => p.question)).toEqual(['get_in', 'know', 'recover', 'keep_up', 'run_well']);
      expect(r.ok).toBe(true);
    }
  });

  it('never prints a dash in any prose field', () => {
    for (const current of SEED_SNAPSHOTS) {
      const client = SEED_CLIENTS.find((c) => c.id === current.clientId)!;
      const draft = draftOfflineNarrative(buildNarrativeInput({ client, current, previous: findSeedSnapshot(client.id, previousPeriod(current.period).id) }));
      const { figures_referenced: _f, ...prose } = draft;
      expect(JSON.stringify(prose)).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it('turns warranty and patch backlogs into decisions and plan items that need a yes', () => {
    const client = SEED_CLIENTS[0]!;
    const current: MetricSnapshot = {
      clientId: client.id,
      period: '2026-Q2',
      capturedAt: '2026-06-30T00:00:00Z',
      metrics: [
        { key: 'assets.warranty_expired', label: 'Out of warranty', value: 10, unit: 'count', source: 'ninja', category: 'infrastructure', higherIsBetter: false },
        { key: 'patch.compliance_pct', label: 'Patch compliance', value: 60, unit: '%', source: 'ninja', category: 'security', higherIsBetter: true },
        { key: 'patch.pending', label: 'Pending patches', value: 455, unit: 'count', source: 'ninja', category: 'security', higherIsBetter: false },
        { key: 'identity.mfa_coverage_pct', label: 'MFA coverage', value: 100, unit: '%', source: 'cipp', category: 'identity', higherIsBetter: true },
      ],
    };
    const input = buildNarrativeInput({ client, current });
    const draft = draftOfflineNarrative(input);
    expect(draft.decisions.map((d) => d.ask).join(' ')).toMatch(/10 devices past warranty/);
    expect(draft.decisions.map((d) => d.ask).join(' ')).toMatch(/maintenance window/);
    const planned = [...draft.plan.now, ...draft.plan.next, ...draft.plan.later];
    expect(planned.some((p) => p.decision === true)).toBe(true);
    expect(planned.every((p) => p.owner)).toBe(true);
    expect(draft.saw.join(' ')).toMatch(/455 updates/);
    expect(limitIssues(draft)).toEqual([]);
    expect(verifyNarrative(draft, buildAllowedNumbers(input)).ok).toBe(true);
  });

  it('uses attached report findings in what we saw', () => {
    const client = SEED_CLIENTS[0]!;
    const current = findSeedSnapshot('anp', '2026-Q1')!;
    const input = buildNarrativeInput({
      client,
      current,
      documents: [{ name: 'Synology Active Backup.pdf', source: 'upload', findings: [{ text: 'One lab PC (TGA2) has not backed up in 389 days', severity: 'act' }] }],
    });
    const draft = draftOfflineNarrative(input);
    expect(draft.saw.join(' ')).toContain('One lab PC (TGA2) has not backed up in 389 days');
    expect(limitIssues(draft)).toEqual([]);
  });
});

describe('draftOfflineNarrative style', () => {
  it('produces no style hits on any seed snapshot', () => {
    for (const current of SEED_SNAPSHOTS) {
      const client = SEED_CLIENTS.find((c) => c.id === current.clientId);
      if (!client) continue;
      const previous = findSeedSnapshot(client.id, previousPeriod(current.period).id);
      const input = buildNarrativeInput({ client, current, previous });
      const draft = draftOfflineNarrative(input);
      expect({ id: client.id, period: current.period, style: verifyNarrative(draft, buildAllowedNumbers(input)).style }).toEqual({
        id: client.id,
        period: current.period,
        style: [],
      });
    }
  });
});

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
      expect(verifyNarrative(draft, buildAllowedNumbers(input), { allowedQuotes: buildAllowedQuotes(input) }).ok).toBe(true);
      expect(draft.headline.length).toBeGreaterThan(0);
      expect(draft.lede.length).toBeGreaterThan(0);
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

  it('passes prose verification when ticket subjects contain digits (non-HIPAA)', () => {
    const client = { ...SEED_CLIENTS[0]!, hipaa: false };
    const subjects = ['Windows 11 upgrade on front desk PC', 'Windows 11 upgrade for exam room 3', 'Windows driver fault Ticket #48213'];
    const current: MetricSnapshot = {
      clientId: client.id,
      period: '2026-Q3',
      capturedAt: '2026-09-30T00:00:00Z',
      metrics: [
        {
          key: 'tickets.incidents',
          label: 'Incidents',
          value: subjects.length,
          source: 'halo',
          category: 'operations',
          details: subjects.map((summary, i) => ({ id: String(i + 1), summary })),
        },
      ],
    };
    const input = buildNarrativeInput({ client, current });
    const draft = draftOfflineNarrative(input);
    // The plan really does quote the subjects...
    expect(draft.plan.now.map((p) => p.action).join(' ')).toContain('Windows 11');
    // ...and the deterministic draft still verifies.
    const r = verifyNarrative(draft, buildAllowedNumbers(input), { allowedQuotes: buildAllowedQuotes(input) });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('draftOfflineNarrative protection fallback', () => {
  it('never exceeds 40 words per field, even from one over-long evidence sentence', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + '.';
    const twoPart = 'Short first part; ' + Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ') + '.';
    const input = {
      client: { name: 'X' },
      period: { id: '2026-Q3', label: 'Q3 2026' },
      metrics: [],
      trends: [],
      scorecard: {
        overall: { score: null, rating: 'unknown', coverage: 0, confidence: 'low' },
        functions: [],
        remediations: [],
        protection: [
          { question: 'get_in', rating: 'green', safeguards: [{ title: 'MFA', score: 90, rating: 'green', evidence: long }] },
          { question: 'know', rating: 'green', safeguards: [{ title: 'EDR', score: 90, rating: 'green', evidence: twoPart }] },
        ],
      },
    } as unknown as Parameters<typeof draftOfflineNarrative>[0];
    const draft = draftOfflineNarrative(input);
    for (const p of draft.protection) {
      expect(p.inPlace.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(40);
      expect(p.inPlace.length).toBeGreaterThan(0);
    }
    expect(draft.protection[0]!.inPlace.split(/\s+/).length).toBe(40);
    expect(draft.protection[1]!.inPlace).toBe('Short first part;');
    expect(limitIssues(draft).filter((i) => i.startsWith('protection.'))).toEqual([]);
  });
});
