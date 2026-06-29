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
});
