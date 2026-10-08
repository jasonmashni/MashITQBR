import { describe, it, expect } from 'vitest';
import { computeOutlook, planVsActual, type BudgetFacts, type BudgetAnswers, type BudgetLine } from '@mashit/core';

const facts: BudgetFacts = {
  mrr: 5460,
  perUserMonthly: 165,
  paidSeats: 32,
  seatMonthly: 34.65,
  devicesAgingOut: 15,
  devicesAgingNextYear: 6,
  quarterlyVariable: [2000, 3400, 2100, 4000],
  projects: [{ name: 'Server replacement', low: 9000, high: 18000 }],
};
const answers: BudgetAnswers = {
  headcountChange: 2,
  copilotSeats: 10,
  copilotSeatPrice: 30,
  workstationUnitCost: 1650,
  refreshPolicy: 'at_warranty_end',
  appetite: 'balanced',
};

const line = (lines: BudgetLine[], c: BudgetLine['category']) => lines.find((l) => l.category === c)!;
const triple = (l: BudgetLine) => [l.low, l.expected, l.high];

describe('computeOutlook', () => {
  it('computes the worked example', () => {
    const out = computeOutlook(facts, answers);
    expect(triple(line(out.lines, 'managed_services'))).toEqual([65520, 65520, 69480]);
    expect(triple(line(out.lines, 'hardware'))).toEqual([21038, 24750, 28463]);
    expect(triple(line(out.lines, 'support_hours'))).toEqual([8000, 11500, 16000]);
    expect(triple(line(out.lines, 'projects'))).toEqual([9000, 13500, 18000]);
    // 32 x 34.65 x 12; plus 2 hires; plus 10 Copilot at 30.
    expect(triple(line(out.lines, 'licensing'))).toEqual([13306, 14137, 17737]);
    const nonContingency = out.lines.filter((l) => l.category !== 'contingency');
    const expectedSum = nonContingency.reduce((s, l) => s + l.expected, 0);
    const contingency = line(out.lines, 'contingency');
    expect(contingency.low).toBe(0);
    expect(contingency.expected).toBe(Math.round(expectedSum * 0.1));
    expect(contingency.high).toBe(contingency.expected);
    expect(out.totals.low).toBe(out.lines.reduce((s, l) => s + l.low, 0));
    expect(out.totals.expected).toBe(out.lines.reduce((s, l) => s + l.expected, 0));
    expect(out.totals.high).toBe(out.lines.reduce((s, l) => s + l.high, 0));
    expect(out.caveats).toEqual([]);
  });

  it('records a basis for every line', () => {
    const out = computeOutlook(facts, answers);
    for (const l of out.lines) expect(l.basis.length).toBeGreaterThan(0);
    expect(line(out.lines, 'managed_services').basis.map((b) => b.source)).toContain('halo');
    expect(line(out.lines, 'licensing').basis.map((b) => b.source)).toContain('cipp');
    expect(line(out.lines, 'projects').basis.map((b) => b.source)).toContain('opportunities');
  });

  it('says so when Halo has no recurring value, never a silent zero', () => {
    const out = computeOutlook({ ...facts, mrr: undefined }, answers);
    const managed = line(out.lines, 'managed_services');
    expect(triple(managed)).toEqual([0, 0, 0]);
    expect(managed.basis.map((b) => b.note)).toContain('No recurring value on Halo contracts');
    expect(out.caveats).toContain('Managed services could not be computed from Halo; the total is understated.');
  });

  it('flags each missing data source with a caveat', () => {
    const out = computeOutlook({}, {});
    expect(out.caveats.length).toBeGreaterThanOrEqual(4);
    expect(out.totals).toEqual({ low: 0, expected: 0, high: 0 });
    expect(out.lines.map((l) => l.category)).toEqual([
      'managed_services', 'licensing', 'hardware', 'projects', 'support_hours', 'compliance', 'contingency',
    ]);
  });

  it('applies the refresh policy factors', () => {
    const rtf = computeOutlook(facts, { ...answers, refreshPolicy: 'run_to_failure' });
    expect(triple(line(rtf.lines, 'hardware'))).toEqual([0, 7425, 24750]);
    const early = computeOutlook(facts, { ...answers, refreshPolicy: 'early' });
    // 21 devices (15 aging out plus 6 next year) at 1,650.
    expect(triple(line(early.lines, 'hardware'))).toEqual([29453, 34650, 39848]);
  });

  it('falls back to answered projects and sums compliance estimates', () => {
    const out = computeOutlook({ ...facts, projects: [] }, {
      ...answers,
      projects: [{ name: 'Wi-Fi refresh', low: 4000, high: 6000 }],
      complianceDeadlines: [{ what: 'HIPAA risk assessment', when: 'March', estimate: 3500 }, { what: 'Policy review', when: 'June' }],
    });
    expect(triple(line(out.lines, 'projects'))).toEqual([4000, 5000, 6000]);
    expect(line(out.lines, 'projects').basis[0]!.source).toBe('answer');
    expect(triple(line(out.lines, 'compliance'))).toEqual([3500, 3500, 3500]);
  });

  it('scales contingency with appetite', () => {
    const lean = computeOutlook(facts, { ...answers, appetite: 'lean' });
    const cautious = computeOutlook(facts, { ...answers, appetite: 'cautious' });
    const base = (o: typeof lean) => o.lines.filter((l) => l.category !== 'contingency').reduce((s, l) => s + l.expected, 0);
    expect(line(lean.lines, 'contingency').expected).toBe(Math.round(base(lean) * 0.05));
    expect(line(cautious.lines, 'contingency').expected).toBe(Math.round(base(cautious) * 0.15));
  });
});

describe('fix round 1 rulings', () => {
  it('with Microsoft 365 on the agreement, licensing carries only the deltas', () => {
    const plain = computeOutlook(facts, answers);
    const flagged = computeOutlook({ ...facts, seatPriceFromRecurring: true }, answers);
    // Base seats sit in managed services: low 0, expected adds 2 hires x $34.65 x 12,
    // high adds 10 Copilot seats x $30 x 12 on top.
    expect(triple(line(flagged.lines, 'licensing'))).toEqual([0, 832, 4432]);
    const notes = line(flagged.lines, 'licensing').basis.map((b) => b.note);
    expect(notes).toContain('Base Microsoft 365 seats are billed on your Mash IT agreement and counted in managed services.');
    expect(notes.join(' ')).not.toMatch(/32 paid Microsoft 365 seats/);
    // No contradicting caveat: the figure no longer double counts.
    expect(flagged.caveats).toEqual([]);
    expect(plain.caveats).toEqual([]);
    expect(triple(line(plain.lines, 'licensing'))).toEqual([13306, 14137, 17737]);
  });

  it('with Microsoft 365 on the agreement and no changes, licensing is zero', () => {
    const out = computeOutlook({ ...facts, seatPriceFromRecurring: true }, { ...answers, headcountChange: 0, copilotSeats: undefined });
    expect(triple(line(out.lines, 'licensing'))).toEqual([0, 0, 0]);
  });

  it('notes an early refresh priced without next-year warranty data', () => {
    const early = computeOutlook({ ...facts, devicesAgingNextYear: undefined }, { ...answers, refreshPolicy: 'early' });
    expect(triple(line(early.lines, 'hardware'))).toEqual([21038, 24750, 28463]);
    expect(line(early.lines, 'hardware').basis.map((b) => b.note)).toContain('Priced as replace at warranty end; no next-year warranty data yet.');
    const known = computeOutlook(facts, { ...answers, refreshPolicy: 'early' });
    expect(line(known.lines, 'hardware').basis.map((b) => b.note).join(' ')).not.toContain('no next-year warranty data');
  });
});

describe('planVsActual', () => {
  it('compares spend with the pro-rata share', () => {
    const r = planVsActual(118000, [30578, 21019]);
    expect(r).toMatchObject({ planned: 118000, spent: 51597, pct: 44 });
    expect(r.note.startsWith('Under plan')).toBe(true);
    expect(r.note).toBe('Under plan, with 2 of 4 quarters invoiced.');
  });
  it('uses a relative 10% band around the share', () => {
    expect(planVsActual(100000, [24000]).note.startsWith('On plan')).toBe(true);
    expect(planVsActual(100000, [22000]).note.startsWith('Under plan')).toBe(true);
    expect(planVsActual(100000, [28000]).note.startsWith('Over plan')).toBe(true);
  });
});
