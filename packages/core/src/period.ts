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
