/**
 * Dollarized roadmap pipeline: roll a client's open opportunities/initiatives
 * into a single pipeline figure for the admin dashboard (ScalePad-style). One-
 * time amounts count once; recurring amounts are treated as monthly and
 * annualized (×12) so a mixed pipeline reads as one comparable yearly number.
 *
 * Internal only — opportunity values never reach the client-facing report.
 */
export interface RoadmapItem {
  /** Opportunity status; anything other than 'closed' is open pipeline. */
  status: string;
  /** Estimated value in whole currency units, if set. */
  value?: number;
  /** Whether `value` is monthly recurring or a one-time amount. */
  valueKind?: 'recurring' | 'one_time';
}

export interface RoadmapSummary {
  /** Annualized open pipeline: one-time amounts + 12× monthly recurring. */
  annualValue: number;
  /** Sum of monthly recurring value across open items. */
  recurringMonthly: number;
  /** Sum of one-time value across open items. */
  oneTime: number;
  /** Count of open items that carry a value. */
  count: number;
}

const isOpen = (status: string): boolean => status !== 'closed';
const amount = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Summarize the open, valued items into an annualized pipeline figure. */
export function roadmapValue(items: ReadonlyArray<RoadmapItem>): RoadmapSummary {
  let recurringMonthly = 0;
  let oneTime = 0;
  let count = 0;
  for (const it of items) {
    if (!isOpen(it.status)) continue;
    const v = amount(it.value);
    if (v === 0) continue;
    count += 1;
    if (it.valueKind === 'recurring') recurringMonthly += v;
    else oneTime += v;
  }
  return { annualValue: oneTime + recurringMonthly * 12, recurringMonthly, oneTime, count };
}
