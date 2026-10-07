import { extractNumbers, matchesAllowed, stripAllowedQuotes } from './numbers.js';
import type { NarrativeOutput } from './schema.js';

export interface FigureCheck {
  label: string;
  value: string;
  /** Numbers extracted from the value that did not match any allowed figure. */
  unmatched: number[];
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
 * Em dashes, en dashes and banned phrases in every string field of the
 * narrative (strings, arrays of strings, arrays of objects with string values).
 * One entry per hit, `"<field>: <phrase>"`.
 */
export function styleIssues(output: NarrativeOutput): string[] {
  const issues: string[] = [];
  const scan = (field: string, text: string) => {
    if (/[—–]/.test(text)) issues.push(`${field}: em dash`);
    const lower = text.toLowerCase();
    for (const phrase of STYLE_BANNED) if (lower.includes(phrase)) issues.push(`${field}: ${phrase}`);
  };
  for (const [field, value] of Object.entries(output)) {
    if (typeof value === 'string') scan(field, value);
    else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string') scan(field, v);
        else if (v && typeof v === 'object') for (const s of Object.values(v)) if (typeof s === 'string') scan(field, s);
      }
    }
  }
  return issues;
}

/**
 * The prose fields of a narrative as {label, value} pairs, labeled by where
 * they sit in the output: `headline`, `summary_paragraphs[0]`,
 * `highlights[2]`, `recommendations[1]`, `section_summaries.security`.
 */
function proseFields(output: NarrativeOutput): NarrativeOutput['figures_referenced'] {
  const fields: NarrativeOutput['figures_referenced'] = [{ label: 'headline', value: output.headline }];
  const lists = ['summary_paragraphs', 'highlights', 'recommendations'] as const;
  for (const key of lists) {
    output[key].forEach((value, i) => fields.push({ label: `${key}[${i}]`, value }));
  }
  for (const s of output.section_summaries ?? []) {
    fields.push({ label: `section_summaries.${s.category}`, value: s.summary });
  }
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
  return { ...verifyFigures([...output.figures_referenced, ...proseFields(output)], allowed, opts), style: styleIssues(output) };
}

/** Human-readable summary of failures, for retry prompts and audit logs. */
export function describeFailures(result: VerificationResult): string {
  return result.failures
    .map((f) => `- "${f.label}": value "${f.value}" contains unverifiable number(s): ${f.unmatched.join(', ')}`)
    .join('\n');
}
