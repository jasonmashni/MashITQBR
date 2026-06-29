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

/** Extract every number-like token from a string, normalized to a JS number. */
export function extractNumbers(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
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
