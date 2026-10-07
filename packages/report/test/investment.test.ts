import { describe, it, expect } from 'vitest';
import type { BudgetOutlook } from '@mashit/core';
import { buildReportModel } from '@mashit/report';
import { anpClient, anpQ1Shape, anpQ2 } from './fixtures/anpQ2.js';

const args = { client: anpClient, current: anpQ2, previous: anpQ1Shape };

const outlook: BudgetOutlook = {
  fiscalLabel: 2027,
  assumptions: ['Headcount grows by two.'],
  movers: ['A second production line adds devices and licensing.'],
  lines: [{ category: 'managed_services', low: 65500, expected: 65500, high: 69000, basis: [{ source: 'halo', note: 'Current agreements' }] }],
  totals: { low: 65500, expected: 65500, high: 69000 },
  caveats: [],
};

describe('investment model', () => {
  const inv = buildReportModel(args).investment!;

  it('splits the quarter into recurring and variable from the invoice lines', () => {
    expect(inv.invoiced).toBe(21019);
    // Lines whose label matches a finance.recurring.* label (without "(monthly)").
    expect(inv.recurring).toBe(8360 + 4960 + 1350 + 1109 + 600);
    expect(inv.variable).toBe(21019 - inv.recurring);
    expect(inv.previousInvoiced).toBe(30578);
    expect(inv.breakdown[0]).toEqual({ label: 'Managed workstations', amount: 8360, recurring: true });
    expect(inv.breakdown.find((b) => b.label === 'Remote support (hourly)')).toEqual({ label: 'Remote support (hourly)', amount: 2006, recurring: false });
    // Largest first.
    expect(inv.breakdown.map((b) => b.amount)).toEqual([...inv.breakdown.map((b) => b.amount)].sort((a, b) => b - a));
  });

  it('says what is coming up, pricing the warranty refresh only with a unit cost', () => {
    expect(inv.comingUp.join(' ')).toContain('10 devices past warranty');
    expect(inv.comingUp.join(' ')).not.toContain('$');
    expect(inv.comingUp.join(' ')).toContain('31 of 32 paid Microsoft 365 seats in use');
    expect(inv.comingUp.join(' ')).toContain('1 agreement renews within 90 days');
    const priced = buildReportModel({ ...args, budget: { unitCost: 1400 } }).investment!;
    expect(priced.comingUp.join(' ')).toContain('10 devices past warranty');
    expect(priced.comingUp.join(' ')).toContain('$14,000');
  });

  it('carries plan versus actual and the outlook only when a budget is passed', () => {
    expect(inv.outlook).toBeUndefined();
    expect(inv.planVsActual).toBeUndefined();
    const planVsActual = { fiscalYearLabel: 'FY2026', planned: 118000, spent: 51597, pct: 44, note: 'Slightly under plan.' };
    const planned = buildReportModel({ ...args, budget: { planVsActual, outlook } }).investment!;
    expect(planned.planVsActual).toEqual(planVsActual);
    expect(planned.outlook).toEqual(outlook);
  });

  it('is absent with no invoices and no budget, and hidden with the spend section', () => {
    const noSpend = { ...anpQ2, metrics: anpQ2.metrics.filter((m) => m.category !== 'spend') };
    expect(buildReportModel({ ...args, current: noSpend }).investment).toBeUndefined();
    expect(buildReportModel({ ...args, current: noSpend, budget: { outlook } }).investment?.outlook).toEqual(outlook);
    expect(buildReportModel({ ...args, config: { clientId: 'anp', hiddenSections: ['spend'] } }).investment).toBeUndefined();
  });
});
