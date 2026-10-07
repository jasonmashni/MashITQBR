/**
 * Numeric extraction + matching used by the figure-verification guardrail.
 *
 * The guardrail's job: every quantitative claim the AI narrative makes must be
 * traceable to a number we actually computed. To do that we extract the numbers
 * from a cited "value" string and check each one against the set of allowed
 * numbers (the pre-computed metric bundle). This file is pure and has no API or
 * Anthropic dependency, so it is fully unit-testable.
 */

const WORD_MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

// Matches: optional $, a number with optional thousands separators / decimal,
// then an optional scale word/suffix (K, M, million, …) and/or a percent sign.
// The scale group requires a trailing word boundary so a unit letter doesn't
// swallow the first letter of the next word (e.g. "141 tickets" is not "141T").
const NUMBER_RE =
  /(-?\$?\s?\d[\d,]*(?:\.\d+)?)\s*(?:(thousand|million|billion|trillion|mm|bn|[kmbt])\b)?\s*(%)?/gi;

/**
 * Remove tokens that contain digits but are not figures, so the guardrail does
 * not flag (or accept) them as quantitative claims. Applied in order: ISO
 * dates, period labels (years 19xx/20xx only, so "Q3 2600 events" keeps 2600),
 * framework/product version tokens, then the "/ 100"
 * score denominator. Finally a hyphen between digits becomes a space so "3-5 days"
 * reads as the range 3 and 5, not 3 and -5.
 */
export function stripNonFigures(text: string): string {
  // Curly-quoted text is NOT stripped here: a quote is skipped only when it is
  // a known ticket subject (verifyNarrative's allowedQuotes), so “$48,000”
  // cannot carry a figure past the guardrail.
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\bQ[1-4]\s*(?:19|20)\d{2}\b|\b(?:19|20)\d{2}-Q[1-4]\b/gi, ' ')
    .replace(/\bQ[1-4]\b/gi, ' ')
    .replace(/\bv\d+(\.\d+)?\b|\bCSF\s*\d+(\.\d+)?\b|\bM365\b|\bO365\b|\b24\/7\b/gi, ' ')
    .replace(/\s*\/\s*100\b/g, ' ')
    .replace(/(\d)\s*-\s*(?=\d)/g, '$1 ');
}

/** Extract every number-like token from a string, normalized to a JS number. */
export function extractNumbers(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const m of stripNonFigures(text).matchAll(NUMBER_RE)) {
    const rawBase = m[1];
    if (!rawBase) continue;
    const cleaned = rawBase.replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') continue;
    let value = Number(cleaned);
    if (!Number.isFinite(value)) continue;

    const scaleWord = m[2]?.toLowerCase();
    if (scaleWord && WORD_MULTIPLIERS[scaleWord] !== undefined) {
      value *= WORD_MULTIPLIERS[scaleWord] as number;
    }
    out.push(value);
  }
  return out;
}

/**
 * True if `n` matches any allowed value within tolerance. Tolerance accounts for
 * the model rounding a figure for readability (e.g. citing "12.5M" for
 * 12,543,000), via a small relative band plus an absolute floor.
 */
export function matchesAllowed(
  n: number,
  allowed: Iterable<number>,
  opts: { absolute?: number; relative?: number } = {},
): boolean {
  const abs = opts.absolute ?? 0.5;
  const rel = opts.relative ?? 0.005;
  for (const a of allowed) {
    const tol = Math.max(abs, rel * Math.abs(a));
    if (Math.abs(n - a) <= tol) return true;
  }
  return false;
}

/**
 * Drop curly-quoted spans whose trimmed, case-insensitive content is a known
 * ticket subject (or insight token); unknown quotes keep their text so any
 * number inside them is still checked.
 */
export function stripAllowedQuotes(text: string, allowedQuotes: Iterable<string> = []): string {
  const known = new Set([...allowedQuotes].map((q) => q.trim().toLowerCase()).filter(Boolean));
  if (!known.size) return text;
  return text.replace(/“([^”]*)”/g, (m, inner: string) => (known.has(inner.trim().toLowerCase()) ? ' ' : m));
}
