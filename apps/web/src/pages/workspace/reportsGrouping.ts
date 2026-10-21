/** One collapsible quarter on the Reports tab. */
export interface DocumentGroup<T extends { period: string }> {
  period: string;
  docs: T[];
  /** Open by default: only the workspace's active quarter. */
  open: boolean;
}

const PERIOD_ID = /^\d{4}-Q[1-4]$/;

/**
 * Documents grouped by quarter, newest quarter first ("2026-Q3" ids sort as
 * strings), rows inside a quarter in their original order. Periods that are
 * not a quarter id ("legacy", "") come after the valid ones in first-seen
 * order. Quarters without documents get no group.
 */
export function groupDocumentsByPeriod<T extends { period: string }>(docs: T[], activePeriod: string): Array<DocumentGroup<T>> {
  const byPeriod = new Map<string, T[]>();
  for (const d of docs) {
    const list = byPeriod.get(d.period);
    if (list) list.push(d);
    else byPeriod.set(d.period, [d]);
  }
  const periods = [...byPeriod.keys()];
  const valid = periods.filter((p) => PERIOD_ID.test(p)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const other = periods.filter((p) => !PERIOD_ID.test(p));
  return [...valid, ...other].map((period) => ({ period, docs: byPeriod.get(period)!, open: period === activePeriod }));
}

/** Bulk bar text: "3 selected", or "3 selected across 2 sections" when the selection spans quarters. */
export function selectionLabel(count: number, sections: number): string {
  return sections > 1 ? `${count} selected across ${sections} sections` : `${count} selected`;
}

/** "2026-Q3 (4 reports)". */
export function sectionTitle(period: string, count: number): string {
  return `${period} (${count} ${count === 1 ? 'report' : 'reports'})`;
}
