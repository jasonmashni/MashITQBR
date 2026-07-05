import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot, type Client, type ClientGoal } from '@mashit/core';
import { buildReportModel, renderReportHtml, buildPdfDefinition, renderDeck } from '@mashit/report';

const baseClient = SEED_CLIENTS.find((c) => c.id === 'anp')!;

const goals: ClientGoal[] = [
  { id: 'g1', title: 'Open two new clinics by year-end', alignment: 'We are sizing network + endpoint rollout for each site.', status: 'on_track', targetPeriod: '2026-Q4' },
  { id: 'g2', title: 'Achieve HIPAA readiness', alignment: 'Closing MFA and backup gaps identified this quarter.', status: 'at_risk' },
  { id: 'g3', title: '   ', status: 'planned' }, // blank title — must be dropped
];

const client: Client = { ...baseClient, goals };

const model = buildReportModel({
  client,
  current: findSeedSnapshot('anp', '2026-Q1')!,
  previous: findSeedSnapshot('anp', '2025-Q4')!,
});

describe('client goals in the report', () => {
  it('carries only non-blank goals into the model', () => {
    expect(model.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('renders a Strategic Goals & IT Alignment section with titles, alignment and status', () => {
    const html = renderReportHtml(model);
    expect(html).toContain('Strategic Goals &amp; IT Alignment');
    expect(html).toContain('Open two new clinics by year-end');
    expect(html).toContain('We are sizing network + endpoint rollout for each site.');
    expect(html).toContain('On track');
    expect(html).toContain('At risk');
    expect(html).toContain('Target: 2026-Q4');
    // The blank-title goal never reaches the page.
    expect(html).not.toContain('id="g3"');
  });

  it('omits the section entirely when a client has no goals', () => {
    const noGoals = buildReportModel({ client: baseClient, current: findSeedSnapshot('anp', '2026-Q1')! });
    expect(noGoals.goals).toEqual([]);
    expect(renderReportHtml(noGoals)).not.toContain('Strategic Goals');
  });

  it('the PDF definition and deck render without throwing when goals are present', async () => {
    const def = buildPdfDefinition(model);
    expect(Array.isArray(def['content'])).toBe(true);
    const deck = await renderDeck(model);
    expect(deck.length).toBeGreaterThan(1000); // a non-trivial pptx buffer
  });
});
