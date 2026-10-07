import { extractNumbers, matchesAllowed, stripAllowedQuotes } from './numbers.js';
import { limitIssues } from './limits.js';
import type { NarrativeOutput } from './schema.js';

export interface FigureCheck {
  label: string;
  value: string;
  /**
   * Numbers extracted from the value that did not match any allowed figure.
   * For the `limits` entry, the limit breaches (`'headline: 13 words (limit 12)'`).
   */
  unmatched: Array<number | string>;
  ok: boolean;
}

export interface VerifyOptions {
  absolute?: number;
  relative?: number;
  /**
   * Ticket subjects (and insight tokens) from the input. A curly-quoted span is
   * ignored only when its trimmed, case-insensitive text is one of these, so
   * digits in a real subject ("Windows 11") pass while an invented quoted
   * figure is still checked.
   */
  allowedQuotes?: string[];
}

export interface VerificationResult {
  ok: boolean;
  checks: FigureCheck[];
  /** Convenience: the subset of checks that failed. */
  failures: FigureCheck[];
  /** Style hits ("<field>: <phrase>"). Advisory only: never affects `ok`. */
  style: string[];
}

/**
 * Verify that every figure the narrative cites is traceable to the allowed set
 * of pre-computed numbers. A figure with no numeric content (e.g. "stable",
 * "down") passes — the guardrail only polices quantitative claims.
 */
export function verifyFigures(
  figures: NarrativeOutput['figures_referenced'],
  allowed: Iterable<number>,
  opts?: VerifyOptions,
): VerificationResult {
  const allowedArr = [...allowed];
  const quotes = opts?.allowedQuotes ?? [];
  const checks: FigureCheck[] = figures.map(({ label, value }) => {
    const numbers = extractNumbers(stripAllowedQuotes(value, quotes));
    const unmatched = numbers.filter((n) => !matchesAllowed(n, allowedArr, opts));
    return { label, value, unmatched, ok: unmatched.length === 0 };
  });
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures, style: [] };
}

/** Phrases that read as machine-written. Lowercase; matched as substrings of lowercased text. */
export const STYLE_BANNED: readonly string[] = [
  'reinforces',
  'underscores',
  'leaves room to climb',
  'worth a brief review',
  'robust',
  'leverage',
  'landscape',
  'holistic',
  'seamless',
  'journey',
  'navigate',
  'foster',
  'a testament to',
  'it is worth noting',
  "it's worth noting",
  "in today's",
];

/**
 * Em dashes, en dashes and banned phrases in every string of the narrative,
 * however deeply nested (the v4 plan is an object of arrays of objects). One
 * entry per hit, `"<top-level field>: <phrase>"`.
 */
export function styleIssues(output: NarrativeOutput): string[] {
  const issues: string[] = [];
  const scan = (field: string, text: string) => {
    if (/[—–]/.test(text)) issues.push(`${field}: em dash`);
    const lower = text.toLowerCase();
    for (const phrase of STYLE_BANNED) if (lower.includes(phrase)) issues.push(`${field}: ${phrase}`);
  };
  const walk = (field: string, value: unknown) => {
    if (typeof value === 'string') scan(field, value);
    else if (Array.isArray(value)) for (const v of value) walk(field, v);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(field, v);
  };
  for (const [field, value] of Object.entries(output)) walk(field, value);
  return issues;
}

/**
 * The prose fields of a narrative as {label, value} pairs, labeled by where
 * they sit in the output: `headline`, `lede`, `did[0]`, `saw[2]`,
 * `decisions[0].ask` (not `by`, a date), `plan.next[1].action`, `protection.recover.thisQuarter`,
 * `section_summaries.security`, plus the deprecated v3 lists when present.
 */
function proseFields(output: NarrativeOutput): NarrativeOutput['figures_referenced'] {
  const fields: NarrativeOutput['figures_referenced'] = [];
  const add = (label: string, value: string | undefined) => {
    if (typeof value === 'string') fields.push({ label, value });
  };
  add('headline', output.headline);
  add('lede', output.lede);
  for (const key of ['did', 'saw'] as const) (output[key] ?? []).forEach((v, i) => add(`${key}[${i}]`, v));
  (output.decisions ?? []).forEach((d, i) => {
    add(`decisions[${i}].ask`, d.ask);
    add(`decisions[${i}].why`, d.why);
    // `by` is a deadline ("Nov 15"), not a figure, so it is not number-checked.
  });
  for (const column of ['now', 'next', 'later'] as const) {
    (output.plan?.[column] ?? []).forEach((p, i) => {
      add(`plan.${column}[${i}].action`, p.action);
      add(`plan.${column}[${i}].owner`, p.owner);
    });
  }
  for (const p of output.protection ?? []) {
    add(`protection.${p.question}.inPlace`, p.inPlace);
    add(`protection.${p.question}.thisQuarter`, p.thisQuarter);
  }
  for (const key of ['summary_paragraphs', 'highlights', 'recommendations'] as const) {
    (output[key] ?? []).forEach((value, i) => add(`${key}[${i}]`, value));
  }
  for (const s of output.section_summaries ?? []) add(`section_summaries.${s.category}`, s.summary);
  return fields;
}

/**
 * Verify the whole narrative: the model's own `figures_referenced` list plus
 * every prose field. A number the model writes into the headline or a bullet
 * but leaves out of figures_referenced is still caught. Dates, period labels
 * and version tokens are ignored (see stripNonFigures), as are quoted spans
 * matching `opts.allowedQuotes` (see buildAllowedQuotes).
 */
export function verifyNarrative(
  output: NarrativeOutput,
  allowed: Iterable<number>,
  opts?: VerifyOptions,
): VerificationResult {
  const figures = verifyFigures([...output.figures_referenced, ...proseFields(output)], allowed, opts);
  const limits = limitIssues(output);
  const checks: FigureCheck[] = limits.length
    ? [...figures.checks, { label: 'limits', value: limits.join('; '), unmatched: limits, ok: false }]
    : figures.checks;
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures, style: styleIssues(output) };
}

/** Human-readable summary of failures, for retry prompts and audit logs. */
export function describeFailures(result: VerificationResult): string {
  return result.failures
    .map((f) =>
      f.label === 'limits'
        ? `- Over a length or count limit, shorten or trim: ${f.unmatched.join('; ')}`
        : `- "${f.label}": value "${f.value}" contains unverifiable number(s): ${f.unmatched.join(', ')}`,
    )
    .join('\n');
}
