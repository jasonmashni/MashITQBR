import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';
import { buildReportModel, renderReportHtml } from '@mashit/report';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const narrative: NarrativeOutput = {
  headline: 'A high-activity, security-forward quarter',
  lede: 'Ticket volume rose to 141, up 200% from 47 last quarter.',
  did: ['22 email threats blocked before reaching inboxes', 'Handled every support request.', 'Kept monitoring running.'],
  saw: ['Ticket volume tripled.', 'Four devices are past warranty.', 'Backups ran.'],
  decisions: [],
  plan: { now: [{ action: 'Plan the May hardware refresh', owner: 'Mash IT' }], next: [{ action: 'Replace ANP-LAP-006', owner: 'Mash IT', decision: true }], later: [] },
  protection: [],
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

  it('carries the narrative into the executive section and the plan', () => {
    expect(model.executive.headline).toMatch(/security-forward/);
    expect(model.executive.lede).toMatch(/up 200% from 47/);
    expect(model.executive.did[0]).toMatch(/22 email threats/);
    expect(model.recommendations).toContain('Plan the May hardware refresh');
    expect(model.plan.next[0]).toEqual({ action: 'Replace ANP-LAP-006', owner: 'Mash IT', decision: true });
  });

  it('a narrative without a plan puts the recommendations in the Now column', () => {
    const noPlan = buildReportModel({
      client: anp,
      current: findSeedSnapshot('anp', '2026-Q1')!,
      narrative: { ...narrative, plan: { now: [], next: [], later: [] } },
    });
    expect(noPlan.plan.now.map((p) => p.action)).toEqual(['Plan the May hardware refresh', 'Replace ANP-LAP-006']);
  });

  it('escapes narrative and discussion text in the HTML', () => {
    const hostile = buildReportModel({
      client: anp,
      current: findSeedSnapshot('anp', '2026-Q1')!,
      narrative: { ...narrative, headline: '<script>alert(1)</script>', did: ['<b>bold</b>', 'b', 'c'] },
      discussion: [{ id: 'x', topic: '<img src=x onerror=alert(1)>', status: 'discussed' }],
      previousDiscussion: [{ id: 'y', topic: '<i>old</i>', status: 'discussed' }],
    });
    const out = renderReportHtml(hostile);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<b>bold</b>');
    expect(out).not.toContain('<i>old</i>');
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

describe('fallback recommendations and HIPAA', () => {
  const row = (id: string, subject: string) => ({ id, subject, status: 'Open' });
  const snapshot = (period: string) => ({
    clientId: 'x',
    period,
    capturedAt: '2026-06-30T00:00:00Z',
    metrics: [
      {
        key: 'tickets.incidents',
        label: 'Incidents',
        value: 4,
        source: 'halo' as const,
        category: 'operations' as const,
        details: [row('1', 'VPN drop for patient Smith'), row('2', 'VPN down again Smith'), row('3', 'VPN failing Smith office'), row('4', 'VPN slow Smith')],
      },
    ],
  });
  const base = { current: snapshot('2026-Q2'), previous: snapshot('2026-Q1') };

  it('quotes example subjects for a non-HIPAA client', () => {
    const m = buildReportModel({ ...base, client: { ...anp, hipaa: false } });
    expect(m.recommendations.join(' ')).toContain('Smith');
  });

  it('never quotes a ticket subject for a HIPAA client', () => {
    const m = buildReportModel({ ...base, client: { ...anp, hipaa: true } });
    expect(m.recommendations.length).toBeGreaterThan(0);
    expect(m.recommendations.join(' ')).not.toContain('Smith');
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
