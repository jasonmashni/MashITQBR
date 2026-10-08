import type { Period, Quarter } from './types.js';

const QUARTER_MONTHS: Record<Quarter, { startMonth: number; endMonth: number }> = {
  1: { startMonth: 1, endMonth: 3 },
  2: { startMonth: 4, endMonth: 6 },
  3: { startMonth: 7, endMonth: 9 },
  4: { startMonth: 10, endMonth: 12 },
};

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Last day of a given month (1-based month). */
function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of next month === last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isQuarter(n: number): n is Quarter {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

/** Build a Period from a year + quarter. */
export function makePeriod(year: number, quarter: Quarter): Period {
  const { startMonth, endMonth } = QUARTER_MONTHS[quarter];
  const start = `${year}-${pad(startMonth)}-01`;
  const end = `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`;
  return {
    id: `${year}-Q${quarter}`,
    year,
    quarter,
    start,
    end,
    label: `Q${quarter} ${year}`,
  };
}

/** Parse a period id like `2026-Q1` into a Period. Throws on malformed input. */
export function parsePeriod(id: string): Period {
  const m = /^(\d{4})-Q([1-4])$/.exec(id.trim());
  if (!m) {
    throw new Error(`Invalid period id: "${id}" (expected e.g. "2026-Q1")`);
  }
  const year = Number(m[1]);
  const quarter = Number(m[2]);
  if (!isQuarter(quarter)) {
    throw new Error(`Invalid quarter in period id: "${id}"`);
  }
  return makePeriod(year, quarter);
}

/** The period immediately before the given one (wraps Q1 -> previous year Q4). */
export function previousPeriod(id: string): Period {
  const p = parsePeriod(id);
  if (p.quarter === 1) {
    return makePeriod(p.year - 1, 4);
  }
  return makePeriod(p.year, (p.quarter - 1) as Quarter);
}

/** The period that contains the given Date (defaults to caller-supplied date). */
export function periodFor(date: Date): Period {
  const year = date.getUTCFullYear();
  const quarter = (Math.floor(date.getUTCMonth() / 3) + 1) as Quarter;
  return makePeriod(year, quarter);
}

/**
 * The n most recent period ids ending at `currentId`, newest first.
 * Returns `[currentId]` untouched when the id is malformed (UI-friendly).
 */
export function lastPeriods(currentId: string, n: number): string[] {
  const m = /^(\d{4})-Q([1-4])$/.exec(currentId.trim());
  if (!m) return [currentId];
  let year = Number(m[1]);
  let quarter = Number(m[2]);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${year}-Q${quarter}`);
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fiscal years. A fiscal year is labelled by the calendar year in which it
// ends (a July 2026 start is FY2027; a January start is the same year). The
// planning review is the QBR held in the quarter before the fiscal year
// starts, which reviews the period two quarters before the start quarter.
// ---------------------------------------------------------------------------

export interface FiscalYear {
  label: number;
  startPeriod: string;
  endPeriod: string;
  startMonth: number;
}

/** Month 1..12; anything else (including undefined) falls back to January. */
function normalizeStartMonth(startMonth: number | undefined): number {
  return typeof startMonth === 'number' && Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12
    ? startMonth
    : 1;
}

const startQuarterOf = (startMonth: number): Quarter => Math.ceil(startMonth / 3) as Quarter;

export function fiscalYearOf(periodId: string, startMonth = 1): FiscalYear {
  const month = normalizeStartMonth(startMonth);
  const p = parsePeriod(periodId);
  const qS = startQuarterOf(month);
  // The fiscal year containing p starts at qS in p.year when p.quarter >= qS, else in p.year - 1.
  const startYear = p.quarter >= qS ? p.year : p.year - 1;
  const endsNextYear = qS !== 1;
  const label = endsNextYear ? startYear + 1 : startYear;
  const endQuarter = qS === 1 ? 4 : qS - 1;
  return {
    label,
    startPeriod: `${startYear}-Q${qS}`,
    endPeriod: `${label}-Q${endQuarter}`,
    startMonth: month,
  };
}

/** The four period ids in the fiscal year, oldest first. */
export function fiscalPeriods(fiscalLabel: number, startMonth = 1): string[] {
  const qS = startQuarterOf(normalizeStartMonth(startMonth));
  let year = qS === 1 ? fiscalLabel : fiscalLabel - 1;
  let q: number = qS;
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(`${year}-Q${q}`);
    q += 1;
    if (q === 5) {
      q = 1;
      year += 1;
    }
  }
  return out;
}

/** The period reviewed in the QBR held in the quarter before the fiscal year starts. */
export function planningPeriodFor(fiscalLabel: number, startMonth = 1): string {
  const qS = startQuarterOf(normalizeStartMonth(startMonth));
  let year = qS === 1 ? fiscalLabel : fiscalLabel - 1;
  let q = qS - 2;
  while (q < 1) {
    q += 4;
    year -= 1;
  }
  return `${year}-Q${q}`;
}

/** True when this period's review is where next fiscal year's budget gets planned. */
export function isPlanningPeriod(periodId: string, startMonth = 1): boolean {
  const p = parsePeriod(periodId);
  const thisFy = fiscalYearOf(p.id, startMonth);
  return planningPeriodFor(thisFy.label + 1, startMonth) === p.id;
}
