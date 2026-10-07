// Pure helpers for the Budget tab (kept out of the component so they test in node).
import { fiscalYearOf, isPlanningPeriod, parsePeriod, planningPeriodFor } from '@mashit/core';
import type { BudgetAnswers, BudgetCategory, BudgetContextItem, BudgetSource } from '../../types.js';

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Select options for the client's fiscal year start month (stored as 1..12). */
export const FISCAL_MONTH_OPTIONS = MONTHS.map((label, i) => ({ value: String(i + 1), label }));

/** The month each quarter's review is held: the month after the quarter ends. */
const REVIEW_MONTH: Record<1 | 2 | 3 | 4, string> = { 1: 'April', 2: 'July', 3: 'October', 4: 'January' };

/** "Q3 2026" */
export function quarterLabel(periodId: string): string {
  const p = parsePeriod(periodId);
  return `Q${p.quarter} ${p.year}`;
}

/** "Q3 2026 review (October)" */
export function reviewLabel(periodId: string): string {
  const p = parsePeriod(periodId);
  return `Q${p.quarter} ${p.year} review (${REVIEW_MONTH[p.quarter]})`;
}

export interface PlannerYear {
  /** The fiscal year the planner opens on. */
  label: number;
  /** The fiscal year the period belongs to (plan versus actual). */
  currentLabel: number;
  /** True when this period's review is where next year's budget is planned. */
  planning: boolean;
  /** The planning period for `label`. */
  planningPeriod: string;
  planningReview: string;
  /** The review where next fiscal year will be planned. */
  nextPlanningReview: string;
}

/**
 * In the planning quarter the planner opens on next fiscal year; in any other
 * quarter it opens on the current one (plan versus actual).
 */
export function plannerYear(period: string, startMonth: number | undefined): PlannerYear {
  const month = startMonth ?? 1;
  const currentLabel = fiscalYearOf(period, month).label;
  const planning = isPlanningPeriod(period, month);
  const label = planning ? currentLabel + 1 : currentLabel;
  const planningPeriod = planningPeriodFor(label, month);
  return {
    label,
    currentLabel,
    planning,
    planningPeriod,
    planningReview: reviewLabel(planningPeriod),
    nextPlanningReview: reviewLabel(planningPeriodFor(currentLabel + 1, month)),
  };
}

export const BUDGET_STEPS = ['People', 'Places', 'Projects', 'Lifecycle', 'Compliance', 'Appetite'] as const;
export type BudgetStep = (typeof BUDGET_STEPS)[number];

/** A step counts as done once its defining answer is recorded. */
export function stepDone(step: BudgetStep, a: BudgetAnswers): boolean {
  switch (step) {
    case 'People':
      return a.headcountChange !== undefined;
    case 'Places':
      return a.newLocations !== undefined;
    case 'Projects':
      return (a.projects?.length ?? 0) > 0;
    case 'Lifecycle':
      return a.workstationUnitCost !== undefined && a.refreshPolicy !== undefined;
    case 'Compliance':
      return (a.complianceDeadlines?.length ?? 0) > 0;
    case 'Appetite':
      return a.appetite !== undefined;
  }
}

export const SOURCE_LABEL: Record<BudgetSource, string> = {
  halo: 'Halo',
  cipp: 'CIPP',
  ninja: 'Ninja',
  hudu: 'Hudu',
  opportunities: 'Opportunities',
  answer: 'You',
};

export const CATEGORY_LABEL: Record<BudgetCategory, string> = {
  managed_services: 'Managed services',
  licensing: 'Microsoft licensing',
  hardware: 'Hardware refresh',
  projects: 'Projects',
  support_hours: 'Support hours',
  compliance: 'Compliance',
  contingency: 'Contingency',
};

export const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** Under or on plan reads as good; over plan is worth a look. */
export function pvaTone(note: string): 'good' | 'watch' {
  return /^over plan/i.test(note.trim()) ? 'watch' : 'good';
}

/** One sentence per line in a textarea; blank lines dropped. */
export const linesToSentences = (text: string): string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
export const sentencesToLines = (list: string[]): string => list.join('\n');

/** Shapes the budget API answers with. */
export interface BudgetKnownFact {
  text: string;
  source: string;
}
export interface BudgetPlanVsActual {
  fiscalYearLabel: string;
  planned: number;
  spent: number;
  pct: number;
  note: string;
  elapsedPct?: number;
}
export type { BudgetContextItem };
