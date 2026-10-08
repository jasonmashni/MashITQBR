import { describe, it, expect } from 'vitest';
import type { BudgetOutlook } from '@mashit/core';
import { limitIssues } from '@mashit/narrative';
import { buildPdfDefinition, buildReportModel, renderReportHtml } from '@mashit/report';
import { anpClient, anpQ1Discussion, anpQ1Shape, anpQ2, anpQ2Discussion, anpQ2Documents, anpQ2Narrative } from './fixtures/anpQ2.js';
import { parentIsUnbreakable, walk } from './pageTools.js';

const outlook: BudgetOutlook = {
  fiscalLabel: 2027,
  assumptions: ['Headcount grows by two.'],
  movers: ['Skipping the refresh saves money now and raises outage risk.'],
  lines: [{ category: 'hardware', low: 21000, expected: 24800, high: 28500, basis: [{ source: 'ninja', note: '15 devices aging out' }] }],
  totals: { low: 21000, expected: 24800, high: 28500 },
  caveats: ['Licensing seat price could not be read from Halo.'],
};
const args = {
  client: anpClient,
  current: anpQ2,
  previous: anpQ1Shape,
  narrative: anpQ2Narrative,
  discussion: anpQ2Discussion,
  previousDiscussion: anpQ1Discussion,
  documents: anpQ2Documents,
  budget: { outlook, unitCost: 1400, planVsActual: { fiscalYearLabel: 'FY2026', planned: 118000, spent: 51597, pct: 44, note: 'Under plan, with 2 of 4 quarters invoiced.' } },
};
const model = buildReportModel(args);

describe('readability rules (PDF)', () => {
  it('readability: no font under 8, body 10 or more, charts unbreakable, margins at least 54', () => {
    const def = buildPdfDefinition(model) as Record<string, unknown>;
    const json = JSON.stringify(def.content);
    for (const m of json.matchAll(/"fontSize":(\d+(?:\.\d+)?)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(8);
    expect((def.styles as Record<string, { fontSize: number }>).body!.fontSize).toBeGreaterThanOrEqual(10);
    expect((def.pageMargins as number[]).every((n) => n >= 54)).toBe(true);
    let charts = 0;
    for (const node of walk(def.content)) {
      if (node['svg']) {
        charts++;
        expect(parentIsUnbreakable(node)).toBe(true);
      }
    }
    expect(charts).toBeGreaterThanOrEqual(4); // logo, movers, ring, investment bars, plan meter
  });

  it('body text has a line height of at least 1.35 and every style is 8pt or more', () => {
    const def = buildPdfDefinition(model) as Record<string, unknown>;
    const styles = def['styles'] as Record<string, { fontSize?: number; lineHeight?: number }>;
    expect(styles['body']!.lineHeight).toBeGreaterThanOrEqual(1.35);
    expect((def['defaultStyle'] as { lineHeight: number }).lineHeight).toBeGreaterThanOrEqual(1.35);
    for (const [name, style] of Object.entries(styles)) if (style.fontSize !== undefined) expect(style.fontSize, name).toBeGreaterThanOrEqual(8);
    expect(styles['th']!.fontSize).toBe(8.5);
    expect(styles['small']!.fontSize).toBe(8.5);
  });

  it('headers and footers are 8pt or larger', () => {
    const def = buildPdfDefinition({ ...model, revisedAt: '2026-10-09' }) as unknown as {
      header: (page: number) => unknown;
      footer: (page: number, pages: number) => unknown;
    };
    for (const part of [def.header(2), def.footer(2, 7)]) {
      for (const m of JSON.stringify(part).matchAll(/"fontSize":(\d+(?:\.\d+)?)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(8);
    }
  });

  it('every data table repeats its header row', () => {
    const def = buildPdfDefinition(model) as Record<string, unknown>;
    let tables = 0;
    for (const node of walk(def['content'])) {
      const table = node['table'] as { body?: unknown[][]; headerRows?: number } | undefined;
      if (table?.body && table.body.length > 1) {
        tables++;
        expect(table.headerRows).toBe(1);
      }
    }
    expect(tables).toBeGreaterThanOrEqual(4); // protection, conversations, planning, metric sections
  });

  it('tile bands and callouts never split', () => {
    const def = buildPdfDefinition(model) as Record<string, unknown>;
    for (const node of walk(def['content'])) {
      const text = JSON.stringify(node);
      if (node['table'] && (text.includes('What to fix first') || text.includes('Since last quarter')) && !text.includes('How we are protecting you')) {
        expect(parentIsUnbreakable(node)).toBe(true);
      }
    }
  });

  it("page one's text fits its limits", () => {
    expect(limitIssues(anpQ2Narrative)).toEqual([]);
    expect(model.executive.did.length).toBeLessThanOrEqual(4);
    expect(model.executive.saw.length).toBeLessThanOrEqual(4);
    expect(model.decisions.length).toBeLessThanOrEqual(3);
  });
});

describe('readability rules (HTML print)', () => {
  it('prints body text at 10pt (13.3px) or more and keeps blocks together', () => {
    const html = renderReportHtml(model);
    const body = html.match(/body\{[^}]*font-size:(\d+(?:\.\d+)?)px/);
    expect(Number(body![1])).toBeGreaterThanOrEqual(13.3);
    const print = html.match(/@media print\{([^@]*)\}/)![1]!;
    for (const cls of ['.tiles', '.cols', '.since', '.figure', '.callout', '.plan']) expect(print).toContain(cls);
    for (const m of html.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(10.7);
  });
});
