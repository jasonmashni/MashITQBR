/**
 * Invoice line classification for clients whose Halo contracts carry no
 * monthly value (no finance.mrr, no finance.recurring.*). The label of each
 * finance.invoiced.* line is all we have, so this sorts it into recurring
 * managed services, Microsoft licensing, or variable work (labour and
 * one-off items). Pure and deterministic; anything unrecognised is variable,
 * so an unknown line never inflates the recurring figure.
 */
export type InvoiceLineKind = 'recurring' | 'licensing' | 'variable';

const LICENSING = /microsoft 365|office 365|\bm365\b|exchange online|copilot|business (premium|standard|basic)/i;

/** Labour and one-off items. Checked after the strong recurring words, before the rest. */
const VARIABLE: RegExp[] = [
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
  // Hardware-looking items. "PC" alone is not here: "Managed Workstation - Windows PC" is a service.
  /hardware/i,
  /laptop/i,
  /notebook/i,
  /desktop/i,
  /\bdock(ing)?\b/i,
  /\bcables?\b/i,
  /\bssd\b/i,
  /ryzen/i,
  /intel core/i,
  /mini pc/i,
  /^\s*other\s*$/i,
];

/** Words that make a line recurring even when it also names labour ("Managed Support Agreement"). */
const STRONG_RECURRING = /\bmanaged|agreement|subscription|\bper[\s-]+(user|device|seat)\b/i;

const RECURRING = /\bmanaged|monitoring|management|compliance|backup|security|subscription|maintenance|agreement|\bper[\s-]+(user|device|seat)\b/i;

/** Licensing first, then strong recurring words, then labour and one-offs, then the other recurring words. */
export function classifyInvoiceLine(label: string): InvoiceLineKind {
  if (LICENSING.test(label)) return 'licensing';
  if (STRONG_RECURRING.test(label)) return 'recurring';
  if (VARIABLE.some((re) => re.test(label))) return 'variable';
  if (RECURRING.test(label)) return 'recurring';
  return 'variable';
}
