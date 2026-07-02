/** Quarter-period helpers for the UI (ids like `2026-Q3`). */

export function parsePeriodId(id: string): { year: number; quarter: number } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(id.trim());
  return m ? { year: Number(m[1]), quarter: Number(m[2]) } : null;
}

/** The n most recent quarters ending at `currentId`, newest first. */
export function lastPeriods(currentId: string, n: number): string[] {
  const parsed = parsePeriodId(currentId);
  if (!parsed) return [currentId];
  const out: string[] = [];
  let { year, quarter } = parsed;
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
