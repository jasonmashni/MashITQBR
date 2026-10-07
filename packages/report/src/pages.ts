import type { BudgetLine, BudgetOutlook } from '@mashit/core';
import { formatCurrency, formatPercent, ratingWord, SEMANTIC } from './format.js';
import type { ConversationStatus, InvestmentModel, ReportModel, ReportProtectionRow, SinceLastRow } from './model.js';

/**
 * Shared page copy for the v2 structure, so the HTML, PDF and deck tell the
 * same story in the same words. No dashes, sentence case, nothing shouted.
 */

export const PAGE_TITLES = {
  fallbackHeadline: 'Quarter at a glance',
  goals: 'Strategic goals and IT alignment',
  protection: 'How we are protecting you',
  decisions: 'Decisions and the next 90 days',
  investment: 'Your IT investment',
  numbers: 'Quarter in numbers',
  appendixWithReports: 'Appendix: Attached reports',
  appendixScoring: 'Appendix: How we score',
} as const;

export function planningTitle(outlook: BudgetOutlook): string {
  return `Planning your FY${outlook.fiscalLabel} IT budget`;
}

/** Human names for the NIST CSF 2.0 functions. */
export const FUNCTION_NAME: Record<string, string> = {
  GOVERN: 'Govern',
  IDENTIFY: 'Identify',
  PROTECT: 'Protect',
  DETECT: 'Detect',
  RESPOND: 'Respond',
  RECOVER: 'Recover',
};

export const CONVERSATION_LABEL: Record<ConversationStatus, string> = {
  on_plan: 'On plan',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
  closed: 'Closed',
};

/** Chip fill for a conversation status. */
export function conversationColor(status: ConversationStatus, primary: string): string {
  return status === 'done' ? SEMANTIC.good : status === 'waiting' ? SEMANTIC.watch : status === 'closed' ? SEMANTIC.unknown : primary;
}

export function sinceLabel(row: SinceLastRow): string {
  return CONVERSATION_LABEL[row.status];
}

export function sinceColor(row: SinceLastRow): string {
  return row.status === 'done' ? SEMANTIC.good : row.status === 'waiting' ? SEMANTIC.watch : row.status === 'closed' ? SEMANTIC.unknown : SEMANTIC.ink;
}

/** Plain words under each protection question. */
export const PROTECTION_SUBTITLE: Record<string, string> = {
  get_in: 'Identity, email, devices',
  know: 'Monitoring and response',
  recover: 'Backup',
  keep_up: 'Patching, hardware',
  run_well: 'Governance, training',
};

/** What is in place: the narrative's words, else the measured evidence. */
export function protectionInPlace(row: ReportProtectionRow): string {
  if (row.inPlace?.trim()) return row.inPlace.trim();
  const evidence = row.safeguards.filter((s) => s.measured).map((s) => s.evidence);
  return evidence.length ? evidence.join(' ') : 'Not measured by our connected tools this quarter.';
}

export function protectionThisQuarter(row: ReportProtectionRow): string {
  return row.thisQuarter?.trim() || (row.rating === 'unknown' ? 'No data from connected tools this quarter.' : '');
}

/** The NIST margin note for the auditor: "Detect 94, Respond 85". */
export function functionScoresText(row: ReportProtectionRow): string {
  return row.functions
    .map((f) => `${FUNCTION_NAME[f.function] ?? f.function} ${f.score === null ? 'not measured' : Math.round(f.score)}`)
    .join(', ');
}

export function protectionStatusWord(row: ReportProtectionRow): string {
  return row.rating === 'unknown' ? 'Not measured' : ratingWord(row.rating);
}

/** The sentence beside the score ring. */
export function ringNote(m: ReportModel): string {
  const { score, rating, coverage, confidence } = m.scorecard.overall;
  const covered = `${formatPercent(Math.round(coverage * 100))} of the controls we check could be measured this quarter`;
  const compliance = m.client.complianceStandard ? ` We weigh these findings with ${m.client.complianceStandard} expectations in mind.` : '';
  if (score === null || confidence === 'low') {
    return `Not enough security data to score this quarter. Only ${covered}. Connecting the remaining tools lets the score appear next quarter; nothing here should be read as a failing grade.${compliance}`;
  }
  const word = rating === 'green' ? 'strong' : rating === 'amber' ? 'fair, with work to do' : 'weak, and needs attention';
  return `Overall posture is ${word}. ${covered}${confidence === 'medium' ? ', so treat the number as provisional' : ''}. Measured against CIS Controls v8.${compliance}`;
}

/** "What to fix first": the two worst measured safeguards, in plain words. */
export function whatToFixFirst(m: ReportModel): string | undefined {
  const top = m.scorecard.remediations.slice(0, 2);
  if (!top.length) return undefined;
  return top.map((r) => `${r.title}: ${r.evidence}`).join(' ');
}

export function hasPlan(m: ReportModel): boolean {
  return m.plan.now.length + m.plan.next.length + m.plan.later.length > 0;
}

export function showDecisionsPage(m: ReportModel): boolean {
  return m.discussion.length > 0 || !!m.notes || hasPlan(m);
}

export function showInvestmentPage(inv: InvestmentModel | undefined): inv is InvestmentModel {
  return !!inv && (inv.invoiced > 0 || !!inv.planVsActual);
}

/** One dense block per page: a long conversations table pushes the plan to the next page. */
export const DENSE_TABLE_ROWS = 6;

export const PLAN_COLUMNS = [
  { key: 'now', title: 'Now', span: 'next 30 days' },
  { key: 'next', title: 'Next', span: '31 to 60 days' },
  { key: 'later', title: 'Later', span: '61 to 90 days' },
] as const;

export const DECISIONS_LEDE = 'What we talked about last time and where it stands, then the plan for the quarter ahead. Items marked "Your decision" are the ones from page one.';

export const money = (n: number): string => formatCurrency(Math.round(n));

/** The investment page lede, from the figures only. */
export function investmentLede(inv: InvestmentModel): string {
  const parts: string[] = [];
  if (inv.invoiced > 0) {
    const prev = inv.previousInvoiced;
    const change = prev !== undefined && prev > 0 && prev !== inv.invoiced ? `, ${inv.invoiced < prev ? 'down' : 'up'} from ${money(prev)} last quarter` : '';
    parts.push(`You invested ${money(inv.invoiced)} this quarter${change}.`);
    if (inv.recurring > 0) parts.push(`Recurring services were ${money(inv.recurring)}, ${Math.round((inv.recurring / inv.invoiced) * 100)}% of the quarter.`);
  }
  return parts.join(' ');
}

export interface InvestmentTile {
  value: string;
  label: string;
  note?: string;
}

export function investmentTiles(inv: InvestmentModel): InvestmentTile[] {
  const prev = inv.previousInvoiced;
  const pctChange = prev && prev > 0 ? Math.round(((inv.invoiced - prev) / prev) * 100) : undefined;
  return [
    {
      value: money(inv.invoiced),
      label: 'Invoiced this quarter',
      note: pctChange === undefined || pctChange === 0 ? undefined : `${pctChange < 0 ? 'down' : 'up'} ${Math.abs(pctChange)}% from last quarter`,
    },
    { value: money(inv.recurring), label: 'Recurring services', note: inv.invoiced > 0 ? `${Math.round((inv.recurring / inv.invoiced) * 100)}% of the quarter` : undefined },
    { value: money(inv.variable), label: 'Project and support work' },
  ];
}

export function planVsActualText(p: NonNullable<InvestmentModel['planVsActual']>): string {
  return `${money(p.spent)} spent of the ${money(p.planned)} we planned together, ${p.pct}% of the plan. ${p.note}`.trim();
}

export const BUDGET_CATEGORY_LABEL: Record<BudgetLine['category'], string> = {
  managed_services: 'Managed services',
  licensing: 'Microsoft licensing',
  hardware: 'Hardware refresh',
  projects: 'Projects',
  support_hours: 'Support hours',
  compliance: 'Compliance',
  contingency: 'Contingency',
};

export function basisText(line: BudgetLine): string {
  return line.basis.map((b) => b.note).join('; ');
}

export const PLANNING_LEDE =
  'Built from your contracts, your device fleet, your license counts and the answers you gave us. Every line says where it came from. The low end assumes nothing changes; the high end assumes every planned project happens.';

export function planningDecisions(outlook: BudgetOutlook): string[] {
  return [`Approve the expected case as the FY${outlook.fiscalLabel} IT budget, or tell us the number to plan to.`];
}

/** The "How we score" note that used to sit on the maturity page. */
export function howWeScore(m: ReportModel): string {
  return (
    'We check the safeguards protecting your business (multi-factor authentication, endpoint protection, patching, backups and more) against CIS Controls v8, a widely used industry checklist of security best practices. The results are grouped under the six functions of the NIST Cybersecurity Framework (Govern, Identify, Protect, Detect, Respond, Recover) and, on the protection page, under five plain questions. The score reflects what our connected tools can measure this quarter. It is a posture guide, not a compliance certification.' +
    (m.client.complianceStandard
      ? ` Because ${m.client.name} answers to ${m.client.complianceStandard}, we weigh these findings with ${m.client.complianceStandard} expectations in mind throughout this review.`
      : '')
  );
}

/** "Oct 9, 2026" from an ISO date or timestamp; the raw value when unparsable. */
export function revisedLabel(revisedAt: string): string {
  const t = Date.parse(revisedAt);
  if (!Number.isFinite(t)) return revisedAt;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** The footer sentence on every page after the cover. */
export function footerText(m: ReportModel): string {
  const base = `Prepared by ${m.brand.orgName}. ${m.client.hipaa ? 'Contains confidential client information (HIPAA).' : 'Confidential.'}`;
  return m.revisedAt ? `${base} Revised on ${revisedLabel(m.revisedAt)}.` : base;
}

/** "By Nov 15" from a decision's `by`, without doubling an author's own "By". */
export function byText(by: string | undefined): string | undefined {
  const t = by?.trim();
  if (!t) return undefined;
  return /^by\b/i.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : `By ${t}`;
}

/** The small line under a page one decision: "By Nov 15. Clears the patch backlog". */
export function decisionSubline(d: { why?: string; by?: string }): string {
  return [byText(d.by), d.why?.trim()].filter(Boolean).join('. ');
}

const significant = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );

/**
 * The plan's decision mark: "Your decision by Nov 15" when a page one decision
 * with a date matches the item (two or more shared words of four letters or
 * more, best match wins), else "Your decision".
 */
export function planDecisionLabel(m: ReportModel, item: { action: string; decision?: boolean }): string | undefined {
  if (!item.decision) return undefined;
  const words = significant(item.action);
  let best: { by: string; score: number } | undefined;
  for (const d of m.decisions) {
    const by = d.by?.trim();
    if (!by) continue;
    let score = 0;
    for (const w of significant(d.ask)) if (words.has(w)) score++;
    if (score >= 2 && (!best || score > best.score)) best = { by, score };
  }
  if (!best) return 'Your decision';
  return `Your decision ${byText(best.by)!.replace(/^By\b/, 'by')}`;
}
