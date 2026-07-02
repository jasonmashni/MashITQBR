import { describe, it, expect } from 'vitest';
import { seedDataSource } from '../src/dataSource.js';
import { buildQbrReport, renderQbrHtml } from '../src/service.js';

describe('buildQbrReport (offline narrative, seed data)', () => {
  it('builds a verified report for ANP Q1 2026 with QoQ trends', async () => {
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      heldBy: 'Jason Mashni',
      generatedLabel: 'Apr 6, 2026',
    });
    expect(report.narrative.verification.ok).toBe(true);
    expect(report.warnings).toHaveLength(0); // previous quarter exists -> no trend warning
    expect(report.model.client.name).toBe('ANP Enertech');
    expect(report.model.scorecard.functions).toHaveLength(6);

    const html = renderQbrHtml(report);
    expect(html).toContain('ANP Enertech');
    expect(html).toContain('Q1 2026');
    expect(html).toContain('Mash IT');
  });

  it('warns when no prior-quarter snapshot exists', async () => {
    const report = await buildQbrReport(seedDataSource, 'kpca', '2026-Q1');
    expect(report.warnings.some((w) => /quarter-over-quarter/.test(w))).toBe(true);
  });

  it('uses an injected narrative model when provided', async () => {
    let called = false;
    const report = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', {
      narrativeModel: async () => {
        called = true;
        return {
          headline: 'Custom headline',
          summary_paragraphs: ['Patch compliance held at 89%.'],
          highlights: [],
          recommendations: [],
          figures_referenced: [{ label: 'patch', value: '89%' }],
        };
      },
    });
    expect(called).toBe(true);
    expect(report.model.executive.headline).toBe('Custom headline');
    expect(report.narrative.verification.ok).toBe(true); // 89 is a real MP metric
  });

  it('throws for an unknown client', async () => {
    await expect(buildQbrReport(seedDataSource, 'nope', '2026-Q1')).rejects.toThrow(/Unknown client/);
  });

  it('caches verified AI narratives and skips the model on a repeat build', async () => {
    let calls = 0;
    const model = async () => {
      calls++;
      return {
        headline: 'Cached headline',
        summary_paragraphs: ['Patch compliance held at 89%.'],
        highlights: [],
        recommendations: [],
        figures_referenced: [{ label: 'patch', value: '89%' }],
      };
    };
    const backing = new Map<string, never>();
    const cache = {
      get: async (hash: string) => backing.get(hash),
      put: async (hash: string, result: never) => void backing.set(hash, result),
    };

    const first = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', { narrativeModel: model, narrativeCache: cache });
    expect(calls).toBe(1);
    expect(first.narrative.verification.ok).toBe(true);
    expect(backing.size).toBe(1);

    const second = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', { narrativeModel: model, narrativeCache: cache });
    expect(calls).toBe(1); // served from cache
    expect(second.model.executive.headline).toBe('Cached headline');
  });

  it('does not cache narratives that fail figure verification', async () => {
    const backing = new Map<string, never>();
    const cache = {
      get: async (hash: string) => backing.get(hash),
      put: async (hash: string, result: never) => void backing.set(hash, result),
    };
    await buildQbrReport(seedDataSource, 'mp', '2026-Q1', {
      narrativeModel: async () => ({
        headline: 'Made up',
        summary_paragraphs: [],
        highlights: [],
        recommendations: [],
        figures_referenced: [{ label: 'phantom', value: '123456' }],
      }),
      narrativeCache: cache,
    });
    expect(backing.size).toBe(0);
  });

  it('never consults the cache for the offline drafter', async () => {
    let gets = 0;
    await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      narrativeCache: {
        get: async () => {
          gets++;
          return undefined;
        },
        put: async () => undefined,
      },
    });
    expect(gets).toBe(0);
  });

  it('survives a broken cache (falls back to the model)', async () => {
    const report = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', {
      narrativeModel: async () => ({
        headline: 'Resilient',
        summary_paragraphs: [],
        highlights: [],
        recommendations: [],
        figures_referenced: [],
      }),
      narrativeCache: {
        get: async () => {
          throw new Error('table offline');
        },
        put: async () => {
          throw new Error('table offline');
        },
      },
    });
    expect(report.model.executive.headline).toBe('Resilient');
  });

  it('narrative edits win over generated text (and blank fields keep it)', async () => {
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      narrativeEdits: {
        headline: 'Hand-written headline',
        recommendations: ['Do the thing', 'Then the other thing'],
        // summary_paragraphs / highlights left undefined → generated text kept
      },
    });
    expect(report.model.executive.headline).toBe('Hand-written headline');
    expect(report.model.recommendations).toEqual(['Do the thing', 'Then the other thing']);
    expect(report.model.executive.paragraphs.length).toBeGreaterThan(0); // offline draft retained
  });

  it('excludedMetrics vanish from sections, trends, and the AI input', async () => {
    const base = await buildQbrReport(seedDataSource, 'anp', '2026-Q1');
    const someKey = base.model.sections[0]!.rows[0]!.metric.key;

    let modelSawExcluded = false;
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      config: { clientId: 'anp', excludedMetrics: [someKey] },
      narrativeModel: async (messages) => {
        modelSawExcluded = messages.some((m) => m.content.includes(someKey));
        return { headline: 'X', summary_paragraphs: [], highlights: [], recommendations: [], figures_referenced: [] };
      },
    });
    const keys = report.model.sections.flatMap((s) => s.rows.map((r) => r.metric.key));
    expect(keys).not.toContain(someKey);
    expect(report.model.trends.map((t) => t.key)).not.toContain(someKey);
    expect(modelSawExcluded).toBe(false);
  });

  it('threads per-client config + discussion into the report', async () => {
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      config: {
        clientId: 'anp',
        hiddenSections: ['spend'],
        brand: { name: 'Acme MSP', primary: '#123456' },
        customSections: [{ id: 's1', title: 'Roadmap', body: 'Next steps.' }],
      },
      discussion: [{ id: 'd1', topic: 'OpenVPN removal?', response: 'Approved', disposition: 'create_ticket', owner: 'Jason' }],
      notes: 'Good meeting.',
    });
    expect(report.model.brand.name).toBe('Acme MSP');
    expect(report.model.sections.some((s) => s.category === 'spend')).toBe(false);
    expect(report.model.customSections[0]!.title).toBe('Roadmap');
    expect(report.model.discussion[0]!.response).toBe('Approved');

    const html = renderQbrHtml(report);
    expect(html).toContain('Acme MSP');
    expect(html).toContain('OpenVPN removal?');
  });
});
