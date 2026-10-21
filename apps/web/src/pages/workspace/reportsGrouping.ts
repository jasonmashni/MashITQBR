/** One collapsible quarter on the Reports tab. */
export interface DocumentGroup<T extends { period: string }> {
  period: string;
  docs: T[];
  /** Open by default: only the workspace's active quarter. */
  open: boolean;
}

/**
 * Documents grouped by quarter, newest quarter first ("2026-Q3" ids sort as
 * strings), rows inside a quarter in their original order. Quarters without
 * documents get no group.
 */
export function groupDocumentsByPeriod<T extends { period: string }>(docs: T[], activePeriod: string): Array<DocumentGroup<T>> {
  const byPeriod = new Map<string, T[]>();
  for (const d of docs) {
    const list = byPeriod.get(d.period);
    if (list) list.push(d);
    else byPeriod.set(d.period, [d]);
  }
  return [...byPeriod.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((period) => ({ period, docs: byPeriod.get(period)!, open: period === activePeriod }));
}

/** "2026-Q3 (4 reports)". */
export function sectionTitle(period: string, count: number): string {
  return `${period} (${count} ${count === 1 ? 'report' : 'reports'})`;
}
