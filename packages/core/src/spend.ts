/**
 * Invoice line classification for clients whose Halo data carries no
 * recurring breakdown (no recurring invoice, no contract value: no
 * finance.mrr, no finance.recurring.*). The label of each finance.invoiced.*
 * line is all we have. The owner's rule: what is billed is managed unless it
 * is labour, a one-off, hardware, or the catch-all "Other". Microsoft
 * licensing keeps its own kind so it can be priced per seat. Pure and
 * deterministic.
 */
import type { MetricSnapshot, MetricValue } from './types.js';

export type InvoiceLineKind = 'recurring' | 'licensing' | 'variable';

/**
 * Tag on the detail rows of finance.mrr and finance.recurring.* when the
 * collector read them from Halo recurring invoices, so the budget can name
 * the source and use the matching support-hours rule.
 */
export const RECURRING_INVOICE_SOURCE = 'recurring_invoice';

/** True when a metric's drill-down rows say it was read from Halo recurring invoices. */
export function fromRecurringInvoices(m: MetricValue | undefined): boolean {
  return !!m?.details?.some((d) => d['source'] === RECURRING_INVOICE_SOURCE);
}

/**
 * Variable (non-recurring) spend for one quarter when the recurring breakdown
 * came from Halo recurring invoices: the quarter's invoiced total less three
 * months of MRR, never less than the quarter's labour lines. Posted lines
 * rarely match a recurring invoice one to one (small subscriptions fold into
 * Other), so the total is the safer split. Undefined on any other path. The
 * budget's support hours and the report's investment page both use this.
 */
export function recurringInvoiceVariable(s: MetricSnapshot): number | undefined {
  const num = (key: string) => {
    const v = s.metrics.find((m) => m.key === key)?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const invoiced = num('finance.quarter_invoiced');
  const mrr = num('finance.mrr');
  if (invoiced === undefined || mrr === undefined) return undefined;
  if (!s.metrics.some((m) => m.key.startsWith('finance.recurring.') && fromRecurringInvoices(m))) return undefined;
  const labour = s.metrics
    .filter((m) => m.key.startsWith('finance.invoiced.') && typeof m.value === 'number' && isLabourLine(m.label))
    .reduce((sum, m) => sum + (m.value as number), 0);
  return Math.round(Math.max(invoiced - Math.min(invoiced, mrr * 3), labour) * 100) / 100;
}

const LICENSING = /microsoft 365|office 365|\bm365\b|exchange online|copilot|business (premium|standard|basic)/i;

/** Words that make a line recurring even when it also names labour ("Managed Support Agreement"). */
const STRONG_RECURRING = /\bmanaged|agreement|subscription|\bper[\s-]+(user|device|seat)\b/i;

/** Labour and one-off service work. */
const LABOUR: RegExp[] = [
  /\bsupport\b/i,
  /consult/i,
  /\bper\s*(hr|hour)\b/i,
  /hourly/i,
  /\bpro\.?\s*svcs?\b/i,
  /professional services/i,
  /\bon-?\s?site\b/i,
  /project/i,
  /\blabou?r\b/i,
  /install/i,
  /travel/i,
];

/** Hardware-looking items. "PC" alone is not here: "Managed Workstation - Windows PC" is a service. */
const HARDWARE: RegExp[] = [
  /hardware/i,
  /ryzen/i,
  /intel core/i,
  /mini pc/i,
  /laptop/i,
  /notebook/i,
  /desktop/i,
  /\bmonitors?\b/i,
  /\bswitch(es)?\b/i,
  /firewall appliance/i,
  /\bups\b/i,
  /\bdock(s|ing)?\b/i,
  /keyboard/i,
  /\bmouse\b|\bmice\b/i,
];

const OTHER = /^\s*other\s*$/i;

/** True for a labour or one-off service line (not hardware, not "Other"); strong recurring words win. */
export function isLabourLine(label: string): boolean {
  return !STRONG_RECURRING.test(label) && LABOUR.some((re) => re.test(label));
}

/**
 * Licensing first, then strong recurring words, then labour, hardware and
 * "Other" (variable). Everything else is recurring. An empty label is
 * variable: there is nothing to call managed.
 */
export function classifyInvoiceLine(label: string): InvoiceLineKind {
  if (!label.trim()) return 'variable';
  if (LICENSING.test(label)) return 'licensing';
  if (STRONG_RECURRING.test(label)) return 'recurring';
  if (LABOUR.some((re) => re.test(label))) return 'variable';
  if (HARDWARE.some((re) => re.test(label))) return 'variable';
  if (OTHER.test(label)) return 'variable';
  return 'recurring';
}

/**
 * Remove Halo recurring-invoice period placeholders ("$periodStartDate -
 * $PeriodEndDate", any case, with or without brackets) and the joiner left
 * behind, so "Managed End User $periodStartDate - $PeriodEndDate" reads
 * "Managed End User".
 */
export function stripBillingPlaceholders(label: string): string {
  return label
    .replace(/\(?\s*\$period(start|end)date\s*(?:[-–—]\s*\$period(start|end)date\s*)?\)?/gi, ' ')
    .replace(/\s*[-–—:]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The key two spend labels match on: placeholders stripped, a trailing
 * "(monthly)" dropped, whitespace collapsed, lower case. Used for recurring
 * breakdown labels and posted invoice labels alike.
 */
export function spendLabelKey(label: string): string {
  return stripBillingPlaceholders(label)
    .replace(/\s*\(monthly\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
