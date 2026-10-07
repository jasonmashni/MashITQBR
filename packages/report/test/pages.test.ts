import { describe, it, expect } from 'vitest';
import type { BudgetOutlook } from '@mashit/core';
import { buildPdfDefinition, buildReportModel, renderDeck, renderReportHtml } from '@mashit/report';
import { anpClient, anpQ1Discussion, anpQ1Shape, anpQ2, anpQ2Discussion, anpQ2Documents, anpQ2Narrative } from './fixtures/anpQ2.js';
import { h1Titles, slideTexts, textOf, walk } from './pageTools.js';

const args = {
  client: anpClient,
  current: anpQ2,
  previous: anpQ1Shape,
  narrative: anpQ2Narrative,
  discussion: anpQ2Discussion,
  previousDiscussion: anpQ1Discussion,
  documents: anpQ2Documents,
  heldBy: 'Jason Mashni',
  generatedLabel: 'Jul 14, 2026',
};
const model = buildReportModel(args);

const outlook: BudgetOutlook = {
  fiscalLabel: 2027,
  assumptions: ['Headcount grows by two.', 'No new location.'],
  movers: ['A second production line adds roughly $9,000 in devices and licensing.'],
  lines: [
    { category: 'managed_services', low: 65500, expected: 65500, high: 69000, basis: [{ source: 'halo', note: 'Current agreements, plus 2 planned hires' }] },
    { category: 'hardware', low: 21000, expected: 24800, high: 28500, basis: [{ source: 'ninja', note: '15 devices aging out, your unit cost' }] },
  ],
  totals: { low: 86500, expected: 90300, high: 97500 },
  caveats: [],
};

const pageOrder = (html: string) => [...html.matchAll(/<section class="page[^"]*" data-page="([a-z-]+)"/g)].map((m) => m[1]);

describe('page structure: PDF', () => {
  it('orders the PDF as cover, at a glance, protection, decisions, investment, numbers, appendix', () => {
    const titles = h1Titles(buildPdfDefinition(model));
    expect(titles).toEqual([model.executive.headline, 'How we are protecting you', 'Decisions and the next 90 days', 'Your IT investment', 'Quarter in numbers', 'Appendix: Attached reports']);
  });

  it('adds the planning page only in the planning quarter', () => {
    const planning = buildReportModel({ ...args, budget: { outlook } });
    expect(h1Titles(buildPdfDefinition(planning))).toContain('Planning your FY2027 IT budget');
    expect(h1Titles(buildPdfDefinition(model))).not.toContain('Planning your FY2027 IT budget');
    const titles = h1Titles(buildPdfDefinition(planning));
    expect(titles.indexOf('Planning your FY2027 IT budget')).toBe(titles.indexOf('Your IT investment') + 1);
    const text = JSON.stringify(buildPdfDefinition(planning));
    expect(text).toContain('What we assumed with you.');
    expect(text).toContain('What would move it.');
    expect(text).toContain('Current agreements, plus 2 planned hires');
    expect(text).toContain('$90,300');
  });

  it('omits Since last quarter when there is nothing to show', () => {
    expect(JSON.stringify(buildPdfDefinition({ ...model, sinceLastQuarter: [] }))).not.toContain('Since last quarter');
    expect(JSON.stringify(buildPdfDefinition(model))).toContain('Since last quarter');
  });

  it('page one carries the lede, the tiles and the three columns in one unbreakable block', () => {
    const def = buildPdfDefinition(model);
    const text = JSON.stringify(def.content);
    expect(text).toContain(anpQ2Narrative.lede);
    const cols = [...walk(def['content'])].find((n) => Array.isArray(n['columns']) && JSON.stringify(n['columns']).includes('What we need from you'));
    expect(cols?.['unbreakable']).toBe(true);
    expect(JSON.stringify(cols)).toContain('What we did');
    expect(JSON.stringify(cols)).toContain('What we saw');
    expect(JSON.stringify(cols)).toContain('Approve replacing 10 out-of-warranty devices');
    expect(JSON.stringify(cols)).toContain('"canvas"'); // the decision checkbox
  });

  it('page two is the five-question table with status chips and NIST scores', () => {
    const text = JSON.stringify(buildPdfDefinition(model));
    for (const q of ['Can someone get in?', 'Would we know, and how fast would we act?', 'Could we recover?', 'Are we keeping up?', 'Are we running it well?']) expect(text).toContain(q);
    expect(text).toContain('What to fix first');
    expect(text).toMatch(/Protect \d+/);
    expect(text).not.toContain('How to read this score');
  });

  it('page one shows the empty state when the author cleared every decision', () => {
    const cleared = buildReportModel({ ...args, narrative: { ...anpQ2Narrative, decisions: [] } });
    expect(cleared.decisions).toEqual([]);
    const cols = [...walk(buildPdfDefinition(cleared)['content'])].find((n) => Array.isArray(n['columns']) && JSON.stringify(n['columns']).includes('What we need from you'));
    expect(JSON.stringify(cols)).toContain('Nothing needs your decision this quarter.');
    expect(JSON.stringify(cols)).not.toContain('"canvas":[{"type":"rect"');
    expect(renderReportHtml(cleared)).toContain('Nothing needs your decision this quarter.');
  });

  it('a plan item flagged for a decision carries the matching decision date', () => {
    const text = JSON.stringify(buildPdfDefinition(model));
    // "Refresh plan and quotes for the 10 out-of-warranty devices" matches the decision dated Nov 15.
    expect(text).toContain('Your decision by Nov 15');
    expect(renderReportHtml(model)).toContain('Your decision by Nov 15');
    // Page one prints the date with its reason.
    expect(text).toContain('By Nov 15. Lands them before year end');
  });

  it('page three shows conversation statuses and Now / Next / Later with owners and decisions', () => {
    const text = JSON.stringify(buildPdfDefinition(model));
    for (const chip of ['On plan', 'In progress', 'Waiting', 'Done', 'Closed']) expect(text).toContain(chip);
    for (const col of ['Now', 'Next', 'Later']) expect(text).toContain(col);
    expect(text).toContain('Your decision');
    expect(text).toContain('Owner to be named');
  });

  it('page four splits recurring from project work and lists what is coming up', () => {
    const text = JSON.stringify(buildPdfDefinition(model));
    expect(text).toContain('$21,019');
    expect(text).toContain('Recurring services');
    expect(text).toContain('Where it went');
    expect(text).toContain('Coming up');
    expect(text).toContain('10 devices past warranty');
  });

  it('the appendix lists the attached reports and explains how we score', () => {
    const text = JSON.stringify(buildPdfDefinition(model));
    expect(text).toContain('How we score');
    expect(text).toContain('Huntress quarterly summary 2026-Q2.pdf');
    const noDocs = buildReportModel({ ...args, documents: [] });
    expect(h1Titles(buildPdfDefinition(noDocs)).at(-1)).toBe('Appendix: How we score');
  });

  it('prints Revised on in the footer only when the quarter was revised', () => {
    type Footer = (page: number, pages: number) => unknown;
    const footer = (m: typeof model) => JSON.stringify((buildPdfDefinition(m) as unknown as { footer: Footer }).footer(2, 6));
    expect(footer(model)).not.toContain('Revised on');
    expect(footer({ ...model, revisedAt: '2026-10-09T15:00:00.000Z' })).toContain('Revised on Oct 9, 2026');
  });

  it('starts the plan on a new page when the conversations table is long', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, topic: `Topic ${i + 1}`, status: 'discussed' as const, sortOrder: i }));
    const def = buildPdfDefinition(buildReportModel({ ...args, discussion: many }));
    const plan = [...walk(def['content'])].find((n) => n['style'] === 'h2' && textOf(n['text']) === 'The next 90 days');
    expect(plan?.['pageBreak']).toBe('before');
    const short = [...walk(buildPdfDefinition(model)['content'])].find((n) => n['style'] === 'h2' && textOf(n['text']) === 'The next 90 days');
    expect(short?.['pageBreak']).toBeUndefined();
  });

  it('hidden sections stay hidden: no investment page when spend is hidden', () => {
    const hidden = buildReportModel({ ...args, config: { clientId: 'anp', hiddenSections: ['spend'] } });
    expect(h1Titles(buildPdfDefinition(hidden))).not.toContain('Your IT investment');
  });
});

describe('page structure: HTML', () => {
  it('mirrors the PDF page order', () => {
    expect(pageOrder(renderReportHtml(model))).toEqual(['cover', 'one', 'protection', 'decisions', 'investment', 'numbers', 'appendix']);
    expect(pageOrder(renderReportHtml(buildReportModel({ ...args, budget: { outlook } })))).toEqual([
      'cover', 'one', 'protection', 'decisions', 'investment', 'planning', 'numbers', 'appendix',
    ]);
  });

  it('carries the page titles and omits Since last quarter when empty', () => {
    const html = renderReportHtml(model);
    for (const t of ['How we are protecting you', 'Decisions and the next 90 days', 'Your IT investment', 'Quarter in numbers', 'Since last quarter', 'What we need from you']) expect(html).toContain(t);
    expect(renderReportHtml({ ...model, sinceLastQuarter: [] })).not.toContain('Since last quarter');
  });

  it('says Revised on when the quarter was revised', () => {
    expect(renderReportHtml(model)).not.toContain('Revised on');
    expect(renderReportHtml({ ...model, revisedAt: '2026-10-09' })).toContain('Revised on Oct 9, 2026');
  });
});

describe('page structure: deck', () => {
  it('has one slide per page in the PDF order, with the numbers after the plan', async () => {
    const slides = await slideTexts(await renderDeck(model));
    const titleIndex = (t: string) => slides.findIndex((s) => s[0] === t);
    const order = [model.executive.headline!, 'How we are protecting you', 'Decisions and the next 90 days', 'Your IT investment', 'Quarter in numbers', 'Appendix: Attached reports'];
    const indices = order.map(titleIndex);
    expect(indices.every((i) => i > 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(slides.flat().join(' ')).toContain('Since last quarter');
  });

  it('Quarter in numbers opens with the movers, the plan carries decision dates, and page one never shrinks text', async () => {
    const deck = await renderDeck(model);
    const slides = await slideTexts(deck);
    const numbers = slides.find((s) => s[0] === 'Quarter in numbers')!;
    expect(numbers[1]).toBe('What changed this quarter');
    expect(slides.flat().join(' ')).toContain('Your decision by Nov 15');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(deck);
    for (const n of [2, 3]) {
      const xml = await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
      expect(xml, `slide ${n}`).not.toContain('normAutofit');
    }
  });

  it('page one flows to a continuation slide instead of shrinking when the columns are long', async () => {
    const long = (n: number) => Array.from({ length: 17 }, (_, i) => `word${i}${n}`).join(' ');
    const crowded = { ...model, executive: { ...model.executive, did: [long(1), long(2), long(3), long(4)], saw: [long(5), long(6), long(7), long(8)] } };
    const slides = await slideTexts(await renderDeck(crowded));
    const cont = slides.find((s) => s[0] === `${model.executive.headline} (cont.)`);
    expect(cont).toBeDefined();
    expect(cont!.join(' ')).toContain('What we did');
  });

  it('omits Since last quarter when there is nothing to show', async () => {
    const slides = await slideTexts(await renderDeck({ ...model, sinceLastQuarter: [] }));
    expect(slides.flat().join(' ')).not.toContain('Since last quarter');
  });

  it('adds the planning slide only in the planning quarter', async () => {
    const plain = await slideTexts(await renderDeck(model));
    expect(plain.some((s) => s[0] === 'Planning your FY2027 IT budget')).toBe(false);
    const planning = await slideTexts(await renderDeck(buildReportModel({ ...args, budget: { outlook } })));
    expect(planning.some((s) => s[0] === 'Planning your FY2027 IT budget')).toBe(true);
  });
});
