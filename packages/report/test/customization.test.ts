import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot, type DiscussionItem, type ReportConfig } from '@mashit/core';
import { buildReportModel, renderReportHtml, resolveBrand, MASH_IT_BRAND } from '@mashit/report';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;

const config: ReportConfig = {
  clientId: 'anp',
  hiddenSections: ['spend'],
  customSections: [
    { id: 's1', title: 'Strategic Roadmap', body: 'Phase one.\n\nPhase two.', placement: 'after-summary' },
  ],
  brand: { name: 'Acme MSP', logoDataUri: 'data:image/png;base64,AAAA', primary: '#123456' },
};

const discussion: DiscussionItem[] = [
  { id: 'd1', topic: 'Remove OpenVPN?', response: 'Anne to remove except AnneNB2', disposition: 'no_action', owner: 'Anne' },
];

const model = buildReportModel({
  client: anp,
  current: findSeedSnapshot('anp', '2026-Q1')!,
  previous: findSeedSnapshot('anp', '2025-Q4')!,
  config,
  discussion,
  notes: 'Productive session; follow up on warranties.',
});

describe('resolveBrand', () => {
  it('merges a partial brand over Mash IT defaults', () => {
    const b = resolveBrand({ name: 'Acme MSP', primary: '#123456' });
    expect(b.name).toBe('Acme MSP');
    expect(b.primary).toBe('#123456');
    expect(b.accent).toBe(MASH_IT_BRAND.accent); // unset falls back
  });
  it('returns defaults when no brand supplied', () => {
    expect(resolveBrand()).toEqual(MASH_IT_BRAND);
  });
});

describe('buildReportModel customization', () => {
  it('applies brand, hides sections, and carries custom sections + discussion', () => {
    expect(model.brand.name).toBe('Acme MSP');
    expect(model.brand.logoDataUri).toBe('data:image/png;base64,AAAA');
    expect(model.sections.some((s) => s.category === 'spend')).toBe(false); // hidden
    expect(model.customSections).toHaveLength(1);
    expect(model.discussion[0]!.topic).toBe('Remove OpenVPN?');
    expect(model.notes).toMatch(/Productive session/);
  });
});

describe('renderReportHtml customization', () => {
  const html = renderReportHtml(model);

  it('embeds the logo and applies brand color + name', () => {
    expect(html).toContain('<img class="logo" src="data:image/png;base64,AAAA"');
    expect(html).toContain('Acme MSP');
    expect(html).toContain('--primary:#123456');
  });

  it('renders the custom section and omits the hidden spend section', () => {
    expect(html).toContain('Strategic Roadmap');
    expect(html).toContain('Phase one.');
    expect(html).not.toContain('IT Spend Overview');
  });

  it('renders the discussion/responses capture with disposition and owner', () => {
    expect(html).toContain('Discussion &amp; Responses');
    expect(html).toContain('Remove OpenVPN?');
    expect(html).toContain('Anne to remove except AnneNB2');
    expect(html).toContain('No action');
    expect(html).toContain('follow up on warranties');
  });
});
