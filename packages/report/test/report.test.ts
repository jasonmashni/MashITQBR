import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';
import { buildReportModel, renderReportHtml } from '@mashit/report';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const narrative: NarrativeOutput = {
  headline: 'A high-activity, security-forward quarter',
  summary_paragraphs: ['Ticket volume rose to 141, up 200% from 47 last quarter.'],
  highlights: ['22 email threats blocked before reaching inboxes'],
  recommendations: ['Plan the May hardware refresh', 'Replace ANP-LAP-006'],
  figures_referenced: [],
};

const model = buildReportModel({
  client: anp,
  current: findSeedSnapshot('anp', '2026-Q1')!,
  previous: findSeedSnapshot('anp', '2025-Q4')!,
  narrative,
  heldBy: 'Jason Mashni',
  generatedLabel: 'Apr 6, 2026',
});

describe('buildReportModel', () => {
  it('groups metrics into ordered sections with trends attached', () => {
    const titles = model.sections.map((s) => s.category);
    expect(titles[0]).toBe('operations'); // operations first
    const ops = model.sections.find((s) => s.category === 'operations')!;
    const tickets = ops.rows.find((r) => r.metric.key === 'tickets.total')!;
    expect(tickets.trend?.deltaPct).toBe(200);
  });

  it('carries the narrative into the executive section', () => {
    expect(model.executive.headline).toMatch(/security-forward/);
    expect(model.recommendations).toContain('Plan the May hardware refresh');
  });

  it('includes a computed maturity scorecard', () => {
    expect(model.scorecard.functions).toHaveLength(6);
  });
});

describe('renderReportHtml', () => {
  const html = renderReportHtml(model);

  it('produces a self-contained branded HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Mash IT');
    expect(html).toContain('ANP Enertech');
    expect(html).toContain('Q1 2026');
  });

  it('renders the executive headline and a R/Y/G scorecard chip', () => {
    expect(html).toContain('A high-activity, security-forward quarter');
    expect(html).toMatch(/class="chip rating-(green|amber|red|unknown)"/);
  });

  it('escapes content and shows ticket trend', () => {
    expect(html).toContain('Total tickets');
    expect(html).toContain('+200%');
    expect(html).toContain('vs last');
  });

  it('omits the "vs last" column entirely when there is no prior quarter', () => {
    const first = buildReportModel({ client: anp, current: findSeedSnapshot('anp', '2026-Q1')!, narrative });
    const out = renderReportHtml(first);
    expect(out).not.toContain('vs last');
    expect(out).not.toMatch(/up from 0|▲ 0 →/);
  });

  it('never uses uppercase eyebrow labels or middle-dot meta strings', () => {
    expect(html).not.toMatch(/text-transform:\s*uppercase/);
    expect(html).not.toContain('&middot;');
    expect(html).not.toContain(' · ');
  });
});

describe('data confidence', () => {
  const warned = buildReportModel({
    client: anp,
    current: { ...findSeedSnapshot('anp', '2026-Q1')!, warnings: ['Halo: ticket tallies counted from the first 200 of 1,400 in-period tickets.'] },
    previous: findSeedSnapshot('anp', '2025-Q4')!,
    narrative,
  });

  it('carries sync warnings onto the model', () => {
    expect(warned.dataConfidence).toEqual(['Halo: ticket tallies counted from the first 200 of 1,400 in-period tickets.']);
    expect(model.dataConfidence).toEqual([]);
  });

  it('renders them under a Data confidence heading, and omits the heading when clean', () => {
    const out = renderReportHtml(warned);
    expect(out).toContain('Data confidence');
    expect(out).toContain('first 200 of 1,400');
    expect(renderReportHtml(model)).not.toContain('Data confidence');
  });

  it('withholds the headline score when confidence is low and says why', () => {
    const thin = buildReportModel({
      client: anp,
      current: { clientId: 'anp', period: '2026-Q2', capturedAt: '2026-06-30T00:00:00Z', metrics: [
        { key: 'tickets.total', label: 'Total tickets', value: 12, source: 'halo', category: 'operations' },
      ] },
      narrative,
    });
    expect(thin.scorecard.overall.confidence).toBe('low');
    const out = renderReportHtml(thin);
    expect(out).toContain('Not enough security data');
    expect(out).not.toMatch(/\b80 \/ 100\b/);
  });
});
