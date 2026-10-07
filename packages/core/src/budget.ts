import type { BudgetAnswers, BudgetCategory, BudgetLine, BudgetSource } from './types.js';

/**
 * Deterministic twelve-month IT budget outlook. Every number traces to a data
 * source (Halo, CIPP, Ninja, Hudu, the opportunity board) or to an answer the
 * account manager recorded. Industry benchmarks never enter this module.
 */

/** What the data sources already tell us. Every field is optional; a missing one is said out loud. */
export interface BudgetFacts {
  /** Monthly recurring value on Halo contracts (finance.mrr). */
  mrr?: number;
  /** Managed End User line over licensed users, monthly. */
  perUserMonthly?: number;
  /** CIPP paid seats. */
  paidSeats?: number;
  /** Microsoft 365 invoice line over seats, monthly. */
  seatMonthly?: number;
  devicesAgingOut?: number;
  devicesAgingNextYear?: number;
  /** Trailing four quarters of non-recurring invoiced. */
  quarterlyVariable?: number[];
  /** Opportunity board estimates. */
  projects?: Array<{ name: string; low?: number; high?: number }>;
}

export interface OutlookResult {
  lines: BudgetLine[];
  totals: { low: number; expected: number; high: number };
  caveats: string[];
}

type Basis = BudgetLine['basis'];

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const has = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function line(category: BudgetCategory, low: number, expected: number, high: number, basis: Basis): BudgetLine {
  return { category, low: Math.round(low), expected: Math.round(expected), high: Math.round(high), basis };
}
const note = (source: BudgetSource, text: string) => ({ source, note: text });

function managedServices(facts: BudgetFacts, answers: BudgetAnswers, caveats: string[]): BudgetLine {
  if (!has(facts.mrr)) {
    caveats.push('Managed services could not be computed from Halo; the total is understated.');
    return line('managed_services', 0, 0, 0, [note('halo', 'No recurring value on Halo contracts')]);
  }
  const base = facts.mrr * 12;
  const basis: Basis = [note('halo', `${money(facts.mrr)} a month on Halo contracts, times 12`)];
  const hires = Math.max(0, answers.headcountChange ?? 0);
  let high = base;
  if (hires > 0) {
    if (has(facts.perUserMonthly)) {
      high = base + hires * facts.perUserMonthly * 12;
      basis.push(note('answer', `High adds ${hires} new ${plural(hires, 'user', 'users')} at ${money(facts.perUserMonthly)} a month each`));
    } else {
      basis.push(note('halo', 'No per-user rate on Halo; new users are not priced'));
      caveats.push('New users could not be priced for managed services; the high figure is understated.');
    }
  }
  return line('managed_services', base, base, high, basis);
}

function licensing(facts: BudgetFacts, answers: BudgetAnswers, caveats: string[]): BudgetLine {
  if (!has(facts.paidSeats) || !has(facts.seatMonthly)) {
    caveats.push('Licensing could not be computed from CIPP and Halo; the total is understated.');
    return line('licensing', 0, 0, 0, [
      !has(facts.paidSeats)
        ? note('cipp', 'No paid seat count from CIPP')
        : note('halo', 'No Microsoft 365 seat price on Halo invoices'),
    ]);
  }
  const price = facts.seatMonthly;
  const low = facts.paidSeats * price * 12;
  const basis: Basis = [
    note('cipp', `${facts.paidSeats} paid Microsoft 365 seats`),
    note('halo', `${money(price)} a seat a month from Halo invoices, times 12`),
  ];
  const change = answers.headcountChange ?? 0;
  const expected = Math.max(0, facts.paidSeats + change) * price * 12;
  if (change !== 0) {
    const n = Math.abs(change);
    basis.push(note('answer', `Expected ${change > 0 ? 'adds' : 'removes'} ${n} ${plural(n, 'seat', 'seats')} for the headcount change`));
  }
  let high = expected;
  if (has(answers.copilotSeats) && has(answers.copilotSeatPrice)) {
    high = expected + answers.copilotSeats * answers.copilotSeatPrice * 12;
    basis.push(note('answer', `High adds ${answers.copilotSeats} Copilot ${plural(answers.copilotSeats, 'seat', 'seats')} at ${money(answers.copilotSeatPrice)} a month`));
  }
  return line('licensing', low, expected, high, basis);
}

type Policy = NonNullable<BudgetAnswers['refreshPolicy']>;

/** Policy factors as whole percentages so the arithmetic stays exact. */
const POLICY_FACTORS: Record<Policy, [number, number, number]> = {
  run_to_failure: [0, 30, 100],
  at_warranty_end: [85, 100, 115],
  early: [85, 100, 115],
};
const POLICY_LABEL: Record<Policy, string> = {
  run_to_failure: 'run to failure',
  at_warranty_end: 'replace at warranty end',
  early: 'replace early',
};

function hardware(facts: BudgetFacts, answers: BudgetAnswers, caveats: string[]): BudgetLine {
  if (facts.devicesAgingOut === undefined) {
    caveats.push('Hardware could not be computed without warranty dates from Ninja or Hudu; the total is understated.');
    return line('hardware', 0, 0, 0, [note('ninja', 'No warranty dates from Ninja or Hudu')]);
  }
  const aging = Math.max(0, facts.devicesAgingOut);
  const agingNote = note('ninja', `${aging} ${plural(aging, 'device ages', 'devices age')} out this fiscal year`);
  if (!has(answers.workstationUnitCost)) {
    caveats.push('Hardware has no planning cost per device yet; the total is understated.');
    return line('hardware', 0, 0, 0, [agingNote, note('answer', 'No planning cost per device answered')]);
  }
  const policy: Policy = answers.refreshPolicy ?? 'at_warranty_end';
  const nextYear = policy === 'early' ? Math.max(0, facts.devicesAgingNextYear ?? 0) : 0;
  const base = (aging + nextYear) * answers.workstationUnitCost;
  const [lo, ex, hi] = POLICY_FACTORS[policy];
  const basis: Basis = [
    nextYear > 0 ? note('ninja', `${agingNote.note}, plus ${nextYear} from the following year`) : agingNote,
    note('answer', `${money(answers.workstationUnitCost)} per device, ${POLICY_LABEL[policy]}${answers.refreshPolicy ? '' : ' (assumed)'}`),
  ];
  return line('hardware', (base * lo) / 100, (base * ex) / 100, (base * hi) / 100, basis);
}

function projects(facts: BudgetFacts, answers: BudgetAnswers): BudgetLine {
  // Board estimates first; answered projects add to them, and an answer with the
  // same name as a board item replaces it (the account manager refined the range).
  const byName = new Map<string, { name: string; low?: number; high?: number; source: BudgetSource }>();
  for (const p of facts.projects ?? []) byName.set(p.name.trim().toLowerCase(), { ...p, source: 'opportunities' });
  for (const p of answers.projects ?? []) byName.set(p.name.trim().toLowerCase(), { ...p, source: 'answer' });
  if (byName.size === 0) {
    return line('projects', 0, 0, 0, [note('opportunities', 'No projects on the opportunity board or in the answers')]);
  }
  let low = 0;
  let high = 0;
  const basis: Basis = [];
  for (const p of byName.values()) {
    const l = has(p.low) ? p.low : has(p.high) ? p.high : undefined;
    if (l === undefined) {
      basis.push(note(p.source, `${p.name} has no estimate yet`));
      continue;
    }
    const h = has(p.high) ? Math.max(l, p.high) : l;
    low += l;
    high += h;
    basis.push(note(p.source, l === h ? `${p.name}, ${money(l)}` : `${p.name}, ${money(l)} to ${money(h)}`));
  }
  return line('projects', low, (low + high) / 2, high, basis);
}

function supportHours(facts: BudgetFacts, caveats: string[]): BudgetLine {
  const q = (facts.quarterlyVariable ?? []).filter((n) => Number.isFinite(n));
  if (q.length === 0) {
    caveats.push('Support hours could not be computed without invoice history from Halo; the total is understated.');
    return line('support_hours', 0, 0, 0, [note('halo', 'No non-recurring invoice history on Halo')]);
  }
  const avg = q.reduce((s, n) => s + n, 0) / q.length;
  return line('support_hours', Math.min(...q) * 4, avg * 4, Math.max(...q) * 4, [
    note('halo', `Non-recurring invoiced over the last ${q.length} ${plural(q.length, 'quarter', 'quarters')}: lowest, average and highest, times 4`),
  ]);
}

function compliance(answers: BudgetAnswers): BudgetLine {
  const items = answers.complianceDeadlines ?? [];
  if (items.length === 0) return line('compliance', 0, 0, 0, [note('answer', 'No compliance deadlines answered')]);
  let total = 0;
  const basis: Basis = [];
  for (const d of items) {
    if (has(d.estimate)) {
      total += d.estimate;
      basis.push(note('answer', `${d.what} by ${d.when}, ${money(d.estimate)}`));
    } else {
      basis.push(note('answer', `${d.what} by ${d.when}, not yet estimated`));
    }
  }
  return line('compliance', total, total, total, basis);
}

const APPETITE_PCT: Record<NonNullable<BudgetAnswers['appetite']>, number> = { lean: 5, balanced: 10, cautious: 15 };

function contingency(expectedSum: number, answers: BudgetAnswers): BudgetLine {
  const appetite = answers.appetite ?? 'balanced';
  const pct = APPETITE_PCT[appetite];
  const amount = (expectedSum * pct) / 100;
  return line('contingency', 0, amount, amount, [
    note('answer', `${pct}% of the expected total for a ${appetite} appetite${answers.appetite ? '' : ' (assumed)'}`),
  ]);
}

export function computeOutlook(facts: BudgetFacts, answers: BudgetAnswers): OutlookResult {
  const caveats: string[] = [];
  const lines: BudgetLine[] = [
    managedServices(facts, answers, caveats),
    licensing(facts, answers, caveats),
    hardware(facts, answers, caveats),
    projects(facts, answers),
    supportHours(facts, caveats),
    compliance(answers),
  ];
  const expectedSum = lines.reduce((s, l) => s + l.expected, 0);
  lines.push(contingency(expectedSum, answers));
  const totals = {
    low: lines.reduce((s, l) => s + l.low, 0),
    expected: lines.reduce((s, l) => s + l.expected, 0),
    high: lines.reduce((s, l) => s + l.high, 0),
  };
  return { lines, totals, caveats };
}

/**
 * Plan versus actual for the fiscal year so far. The band is relative: spend
 * within 10% of the pro-rata share (share x 0.9 to share x 1.1) is on plan.
 */
export function planVsActual(
  plannedExpected: number,
  spentByPeriod: number[],
): { planned: number; spent: number; pct: number; note: string } {
  const quarters = Math.min(4, spentByPeriod.length);
  const planned = Math.round(plannedExpected);
  const spent = Math.round(spentByPeriod.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0));
  if (planned <= 0) return { planned, spent, pct: 0, note: 'No planned total to compare against.' };
  const pct = Math.round((spent / planned) * 100);
  const share = (100 * quarters) / 4;
  const status = pct < share * 0.9 ? 'Under plan' : pct > share * 1.1 ? 'Over plan' : 'On plan';
  return { planned, spent, pct, note: `${status}. ${pct}% of the plan spent with ${quarters} of 4 quarters invoiced.` };
}
