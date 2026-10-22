import { describe, expect, it } from 'vitest';
import { cellEditLabel, overrideCell, removeOverride, setCellOverride, hasUnpublishedChanges, linesToSentences, quarterLabel, plannerYear, sentencesToLines, stepDone, pvaTone, FISCAL_MONTH_OPTIONS, money } from '../src/pages/workspace/budget.js';
import type { BudgetAnswers, BudgetLine } from '../src/types.js';

describe('budget planner helpers', () => {
  it('plans next fiscal year in the planning quarter and the current one otherwise', () => {
    expect(plannerYear('2026-Q3', 1)).toMatchObject({ label: 2027, currentLabel: 2026, planning: true, planningPeriod: '2026-Q3', planningReview: 'Q3 2026 review (October)' });
    expect(plannerYear('2026-Q2', 1)).toMatchObject({ label: 2026, currentLabel: 2026, planning: false, nextPlanningReview: 'Q3 2026 review (October)' });
    expect(plannerYear('2026-Q1', 7)).toMatchObject({ label: 2027, planning: true, planningReview: 'Q1 2026 review (April)' });
    expect(plannerYear('2025-Q4', 4)).toMatchObject({ label: 2027, planning: true, planningReview: 'Q4 2025 review (January)' });
    expect(plannerYear('2026-Q3', undefined).label).toBe(2027);
  });

  it('marks questionnaire steps done from the answers', () => {
    expect(stepDone('People', {})).toBe(false);
    expect(stepDone('People', { headcountChange: 0 })).toBe(true);
    expect(stepDone('Places', { newLocations: 0 })).toBe(true);
    expect(stepDone('Lifecycle', { workstationUnitCost: 1650 })).toBe(false);
    expect(stepDone('Lifecycle', { workstationUnitCost: 1650, refreshPolicy: 'early' })).toBe(true);
    expect(stepDone('Appetite', { appetite: 'lean' })).toBe(true);
  });

  it('maps plan versus actual notes to a tone', () => {
    expect(pvaTone('Under plan, with 2 of 4 quarters invoiced.')).toBe('good');
    expect(pvaTone('On plan, with 2 of 4 quarters invoiced.')).toBe('good');
    expect(pvaTone('Over plan, with 2 of 4 quarters invoiced.')).toBe('watch');
  });

  it('round-trips client sentences through one-per-line text', () => {
    expect(linesToSentences('Two hires.\n\n  A new site. \n')).toEqual(['Two hires.', 'A new site.']);
    expect(sentencesToLines(['A', 'B'])).toBe('A\nB');
  });

  it('offers twelve months, January first, and formats whole dollars', () => {
    expect(FISCAL_MONTH_OPTIONS).toHaveLength(12);
    expect(FISCAL_MONTH_OPTIONS[0]).toEqual({ value: '1', label: 'January' });
    expect(money(65520)).toBe('$65,520');
    expect(quarterLabel('2026-Q3')).toBe('Q3 2026');
  });
});

describe('unpublished changes', () => {
  const lines = [{ category: 'hardware' as const, low: 1, expected: 2, high: 3, basis: [{ source: 'ninja' as const, note: 'n' }] }];
  const base = {
    clientId: 'c',
    fiscalLabel: 2027,
    answers: { workstationUnitCost: 1650 },
    assumptions: ['A.'],
    movers: [],
    lines,
    totals: { low: 1, expected: 2, high: 3 },
    caveats: [],
    status: 'published' as const,
    published: { at: 'x', period: '2026-Q3', lines, totals: { low: 1, expected: 2, high: 3 }, assumptions: ['A.'], movers: [], caveats: [], unitCost: 1650 },
    createdAt: 'x',
    updatedAt: 'x',
    updatedBy: 'j',
  };
  it('is false when the working copy matches what is on the report', () => {
    expect(hasUnpublishedChanges(base)).toBe(false);
    expect(hasUnpublishedChanges({ ...base, status: 'draft', published: undefined })).toBe(false);
  });
  it('is true when the outlook, sentences or unit cost moved since publishing', () => {
    expect(hasUnpublishedChanges({ ...base, totals: { low: 1, expected: 5, high: 9 } })).toBe(true);
    expect(hasUnpublishedChanges({ ...base, movers: ['B.'] })).toBe(true);
    expect(hasUnpublishedChanges({ ...base, answers: { workstationUnitCost: 2000 } })).toBe(true);
  });
});

describe('outlook cell overrides', () => {
  const base: BudgetAnswers = { appetite: 'lean', overrides: { hardware: { high: 30000, reason: 'Quote in hand' } } };

  it('sets one field on a category and keeps the other answers and overrides', () => {
    const next = setCellOverride(base, 'support_hours', 'expected', 12000, 'Fewer hourly projects');
    expect(next).toEqual({
      appetite: 'lean',
      overrides: { hardware: { high: 30000, reason: 'Quote in hand' }, support_hours: { expected: 12000, reason: 'Fewer hourly projects' } },
    });
    expect(base.overrides?.support_hours).toBeUndefined();
  });

  it('adds a field to an existing override, trims the reason and drops an empty one', () => {
    expect(setCellOverride(base, 'hardware', 'low', 20000, '  New quote  ').overrides?.hardware).toEqual({ high: 30000, low: 20000, reason: 'New quote' });
    expect(setCellOverride(base, 'hardware', 'low', 20000, '   ').overrides?.hardware).toEqual({ high: 30000, low: 20000 });
    expect(setCellOverride({}, 'contingency', 'expected', 0).overrides).toEqual({ contingency: { expected: 0 } });
  });

  it('rounds to whole dollars and refuses negative or non-finite values', () => {
    expect(setCellOverride({}, 'projects', 'high', 1234.56).overrides?.projects).toEqual({ high: 1235 });
    expect(setCellOverride(base, 'projects', 'high', -1)).toBe(base);
    expect(setCellOverride(base, 'projects', 'high', Number.NaN)).toBe(base);
  });

  it('removes a category override and drops the map when it empties', () => {
    const two = setCellOverride(base, 'support_hours', 'expected', 12000);
    expect(removeOverride(two, 'hardware').overrides).toEqual({ support_hours: { expected: 12000 } });
    expect(removeOverride(base, 'hardware')).toEqual({ appetite: 'lean' });
    expect('overrides' in removeOverride(base, 'hardware')).toBe(false);
    expect(removeOverride({ appetite: 'lean' }, 'hardware')).toEqual({ appetite: 'lean' });
  });

  it('reads what a cell shows: the final value and the computed one it replaced', () => {
    const line: BudgetLine = { category: 'support_hours', low: 8000, expected: 12000, high: 16000, basis: [], overridden: { expected: 34808 } };
    expect(overrideCell(line, 'expected')).toEqual({ value: 12000, was: 34808, caption: 'was $34,808' });
    expect(overrideCell(line, 'low')).toEqual({ value: 8000 });
    expect(overrideCell({ ...line, overridden: undefined }, 'expected')).toEqual({ value: 12000 });
  });

  it('names the cell for assistive tech', () => {
    expect(cellEditLabel('expected', 'support_hours')).toBe('Edit expected for Support hours');
    expect(cellEditLabel('low', 'managed_services')).toBe('Edit low for Managed services');
  });
});
