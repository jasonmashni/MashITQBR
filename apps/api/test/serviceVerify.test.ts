import { afterEach, describe, expect, it } from 'vitest';
import type { Client, MetricSnapshot } from '@mashit/core';
import type { NarrativeResult } from '@mashit/narrative';
import { seedDataSource, type QbrDataSource } from '../src/dataSource.js';
import { buildQbrReport } from '../src/service.js';
import { v4Narrative } from './narrativeFixture.js';

const SUBJECTS = ['Windows 11 rollout', 'Firewall rule for site 2', 'Printer swap at front desk'];

function source(client: Client): QbrDataSource {
  const current: MetricSnapshot = {
    clientId: client.id,
    period: '2026-Q3',
    capturedAt: '2026-09-30T00:00:00Z',
    metrics: [
      {
        key: 'tickets.changes',
        label: 'Change requests',
        value: SUBJECTS.length,
        source: 'halo',
        category: 'operations',
        details: SUBJECTS.map((summary, i) => ({ id: String(i + 1), summary })),
      },
      {
        key: 'sla.breaches',
        label: 'SLA breaches',
        value: 1,
        source: 'halo',
        category: 'operations',
        details: [{ id: '9', summary: 'Server outage for Dr. Smith' }],
      },
      { key: 'patch.compliance_pct', label: 'Patch compliance', value: 91, unit: '%', source: 'ninja', category: 'security', higherIsBetter: true },
    ],
  };
  return {
    listClients: async () => [client],
    getClient: async (id) => (id === client.id ? client : undefined),
    getSnapshot: async (_c, p) => (p === '2026-Q3' ? current : undefined),
  };
}

const plain: Client = { id: 'acme', name: 'Acme Manufacturing', hipaa: false };
const hipaa: Client = { id: 'clinic', name: 'Bluegrass Clinic', hipaa: true };

afterEach(() => {
  delete process.env['NARRATIVE_ALLOW_PHI'];
});

describe('buildQbrReport narrative verification (verifyNarrative)', () => {
  it('an offline draft that quotes a subject like “Windows 11 rollout” still verifies', async () => {
    const report = await buildQbrReport(source(plain), 'acme', '2026-Q3');
    expect(report.narrative.output.plan.now.map((p) => p.action).join(' ')).toContain('“Windows 11 rollout”');
    expect(report.model.recommendations.join(' ')).toContain('“Windows 11 rollout”');
    expect(report.narrative.verification.ok).toBe(true);
  });

  it('re-verifies a cached narrative: a headline number not in the data is reported', async () => {
    const stale: NarrativeResult = {
      output: v4Narrative({
        headline: 'Tickets fell 987% this quarter',
        lede: 'Patch compliance held at 89%.',
        figures_referenced: [{ label: 'patch', value: '89%' }],
      }),
      // Cached before prose was checked: only figures_referenced was verified.
      verification: { ok: true, checks: [], failures: [], style: [] },
      attempts: 1,
    };
    let modelCalls = 0;
    const report = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', {
      narrativeModel: async () => {
        modelCalls++;
        throw new Error('should not be called');
      },
      narrativeCache: { get: async () => stale, put: async () => undefined },
    });
    expect(modelCalls).toBe(0);
    expect(report.narrative.verification.ok).toBe(false);
    expect(report.narrative.verification.failures.map((f) => f.label)).toContain('headline');
    const warning = report.warnings.find((w) => w.startsWith('The narrative cites a figure that does not match the data: '));
    expect(warning).toContain('headline');
    expect(warning).toContain('987');
    expect(report.warnings.join(' ')).not.toMatch(/AI narrative/);
  });

  it('verifies author edits too: an edited headline with an unknown number is reported', async () => {
    const report = await buildQbrReport(source(plain), 'acme', '2026-Q3', {
      narrativeEdits: { headline: 'We closed 4242 tickets' },
    });
    expect(report.narrative.verification.ok).toBe(false);
    expect(report.narrative.verification.failures.map((f) => f.label)).toContain('headline');
    // Neutral wording: a person wrote this text, not the AI.
    const warning = report.warnings.find((w) => w.startsWith('The narrative cites a figure that does not match the data: '));
    expect(warning).toContain('4242');
    expect(report.warnings.join(' ')).not.toMatch(/AI narrative/);
  });
});

describe('buildQbrReport PHI handling (NARRATIVE_ALLOW_PHI)', () => {
  const captureInput = async (client: Client): Promise<string> => {
    let seen = '';
    await buildQbrReport(source(client), client.id, '2026-Q3', {
      narrativeModel: async (messages) => {
        seen = messages.map((m) => m.content).join('\n');
        return v4Narrative({ headline: 'Quarter in review' });
      },
    });
    return seen;
  };

  it('a HIPAA client sends no ticket subject text to the model when the env is unset', async () => {
    const text = await captureInput(hipaa);
    expect(text.length).toBeGreaterThan(0);
    for (const s of [...SUBJECTS, 'Server outage for Dr. Smith']) expect(text).not.toContain(s);
    const offline = await buildQbrReport(source(hipaa), 'clinic', '2026-Q3');
    const prose = JSON.stringify(offline.narrative.output);
    for (const s of [...SUBJECTS, 'Server outage for Dr. Smith']) expect(prose).not.toContain(s);
  });

  it('with NARRATIVE_ALLOW_PHI=1 the HIPAA client input carries subjects', async () => {
    process.env['NARRATIVE_ALLOW_PHI'] = '1';
    const text = await captureInput(hipaa);
    expect(text).toContain('Windows 11 rollout');
  });
});
