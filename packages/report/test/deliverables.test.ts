import { describe, it, expect } from 'vitest';
import { SEED_CLIENTS, findSeedSnapshot } from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';
import {
  buildPdfDefinition,
  buildReportModel,
  donutSvg,
  functionBarsSvg,
  MASH_IT_WORDMARK_DATA_URI,
  renderDeck,
  renderPdf,
  resolveBrand,
} from '@mashit/report';

const anp = SEED_CLIENTS.find((c) => c.id === 'anp')!;
const narrative: NarrativeOutput = {
  headline: 'A high-activity, security-forward quarter',
  summary_paragraphs: ['Ticket volume rose to 141, up 200% from 47 last quarter.'],
  highlights: ['22 email threats blocked before reaching inboxes'],
  recommendations: ['Plan the May hardware refresh'],
  section_summaries: [
    { category: 'operations', summary: 'The team resolved a heavy quarter of support work without backlog growth.' },
    // Capitalized on purpose — the model matches categories case-insensitively.
    { category: 'Security', summary: 'Layered defenses held: no incidents reached the business.' },
  ],
  figures_referenced: [],
};

const model = buildReportModel({
  client: anp,
  current: findSeedSnapshot('anp', '2026-Q1')!,
  previous: findSeedSnapshot('anp', '2025-Q4')!,
  narrative,
  heldBy: 'Jason Mashni',
  generatedLabel: 'Apr 6, 2026',
  discussion: [
    { id: 'd1', topic: 'OpenVPN removal?', response: 'Approved', disposition: 'create_ticket', status: 'discussed', sortOrder: 2 },
    { id: 'd2', topic: 'Budget for refresh', response: 'Q3', status: 'discussed', sortOrder: 1 },
    { id: 'd3', topic: 'Internal only', includeInReport: false },
  ],
  documents: [{ name: 'Huntress quarterly_summary 2026-Q1.pdf', source: 'huntress' }],
});

describe('brand resolution (org defaults + client overrides)', () => {
  it('always carries the Mash IT wordmark as the default org logo', () => {
    const b = resolveBrand();
    expect(b.orgName).toBe('Mash IT');
    expect(b.orgLogoDataUri).toBe(MASH_IT_WORDMARK_DATA_URI);
    expect(b.orgLogoDataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('org settings override the defaults; client overrides layer on top', () => {
    const b = resolveBrand({ name: 'Client Co', logoDataUri: 'data:image/png;base64,AAA' }, { logoDataUri: 'data:image/png;base64,ORG', primary: '#111111' });
    expect(b.orgLogoDataUri).toBe('data:image/png;base64,ORG');
    expect(b.logoDataUri).toBe('data:image/png;base64,AAA');
    expect(b.name).toBe('Client Co');
    expect(b.primary).toBe('#111111');
    expect(b.orgName).toBe('Mash IT');
  });
});

describe('report model — discussion + documents + section summaries', () => {
  it('filters out includeInReport=false and sorts by agenda order', () => {
    expect(model.discussion.map((d) => d.id)).toEqual(['d2', 'd1']);
  });
  it('carries attached documents for the appendix', () => {
    expect(model.documents[0]!.source).toBe('huntress');
  });
  it('attaches the narrative section summaries to their sections', () => {
    const ops = model.sections.find((s) => s.category === 'operations')!;
    expect(ops.summary).toMatch(/heavy quarter/);
    const sec = model.sections.find((s) => s.category === 'security')!;
    expect(sec.summary).toMatch(/Layered defenses/);
  });
});

describe('designed PDF (pdfmake)', () => {
  it('builds a definition with cover, scorecard visuals, discussions and appendix', () => {
    const def = buildPdfDefinition(model);
    const text = JSON.stringify(def);
    expect(text).toContain('ANP Enertech');
    expect(text).toContain('Quarterly business review');
    expect(text).toContain('Security & Risk Maturity');
    expect(text).toContain('Active & Pending Conversations');
    expect(text).toContain('Appendix: Attached Reports');
    expect(text).toContain('"svg"'); // score visuals are inline SVG
    // Design round: section summaries, the KPI band, and page backgrounds.
    expect(text).toContain('heavy quarter');
    expect(text).toContain('Tickets handled');
    expect(text).toContain('up from 47');
    expect(typeof (def as { background?: unknown }).background).toBe('function');
    expect((def as { pageSize?: string }).pageSize).toBe('LETTER');
  });

  it('never shouts: no uppercased labels, no middle-dot strings, no em dashes in chrome', () => {
    const text = JSON.stringify(buildPdfDefinition(model));
    expect(text).not.toMatch(/[A-Z]{6,} [A-Z]{6,}/); // "QUARTERLY BUSINESS", "TICKETS HANDLED"
    expect(text).not.toContain(' · ');
    expect(text).not.toContain('characterSpacing');
  });

  it('carries data confidence and withholds a low-confidence score', () => {
    const warned = buildReportModel({
      client: anp,
      current: { ...findSeedSnapshot('anp', '2026-Q1')!, warnings: ['Halo: counted from the first 200 of 1,400 tickets.'] },
      previous: findSeedSnapshot('anp', '2025-Q4')!,
      narrative,
    });
    const text = JSON.stringify(buildPdfDefinition(warned));
    expect(text).toContain('Data confidence');
    expect(text).toContain('first 200 of 1,400');

    const thin = buildReportModel({
      client: anp,
      current: { clientId: 'anp', period: '2026-Q2', capturedAt: '2026-06-30T00:00:00Z', metrics: [
        { key: 'tickets.total', label: 'Total tickets', value: 12, source: 'halo', category: 'operations' },
      ] },
      narrative,
    });
    const thinText = JSON.stringify(buildPdfDefinition(thin));
    expect(thinText).toContain('Not scored');
    expect(thinText).not.toContain('"vs last"'); // nothing to compare against
  });

  it('renders an actual PDF buffer', async () => {
    const pdf = await renderPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('survives a truncated client logo instead of failing the export', async () => {
    const corrupt = { ...model, brand: { ...model.brand, logoDataUri: 'data:image/png;base64,' + 'A'.repeat(400) } };
    const pdf = await renderPdf(corrupt);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('score visuals handle unmeasured scores', () => {
    expect(donutSvg(null, 'unknown')).toContain('Not scored');
    expect(functionBarsSvg([{ function: 'PROTECT', score: null, rating: 'unknown', safeguards: [] }])).toContain('Not measured');
  });
});

describe('rebuilt deck (pptxgenjs)', () => {
  it('renders a valid PPTX (zip) with the brand master', async () => {
    const pptx = await renderDeck(model);
    // .pptx is a zip container — PK header
    expect(pptx.subarray(0, 2).toString()).toBe('PK');
    expect(pptx.length).toBeGreaterThan(10000);
  });

  it('every slide carries a title, including continuation slides for long tables', async () => {
    const long = buildReportModel({
      client: anp,
      current: findSeedSnapshot('anp', '2026-Q1')!,
      previous: findSeedSnapshot('anp', '2025-Q4')!,
      narrative,
      discussion: Array.from({ length: 14 }, (_, i) => ({ id: `d${i}`, topic: `Topic ${i + 1}`, response: 'Agreed', status: 'discussed' as const, sortOrder: i })),
    });
    const pptx = await renderDeck(long);
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(pptx);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThan(5);
    let conversationSlides = 0;
    for (const f of slides) {
      const xml = await zip.file(f)!.async('string');
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!.trim()).filter(Boolean);
      expect(texts.length, `${f} has no text`).toBeGreaterThan(0);
      if (texts.some((t) => t.startsWith('Active & Pending Conversations') || t.startsWith('Active &amp; Pending Conversations'))) conversationSlides += 1;
    }
    expect(conversationSlides).toBeGreaterThanOrEqual(2);
  });
});
