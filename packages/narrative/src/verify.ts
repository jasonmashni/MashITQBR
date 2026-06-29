import { extractNumbers, matchesAllowed } from './numbers.js';
import type { NarrativeOutput } from './schema.js';

export interface FigureCheck {
  label: string;
  value: string;
  /** Numbers extracted from the value that did not match any allowed figure. */
  unmatched: number[];
  ok: boolean;
}

export interface VerificationResult {
  ok: boolean;
  checks: FigureCheck[];
  /** Convenience: the subset of checks that failed. */
  failures: FigureCheck[];
}

/**
 * Verify that every figure the narrative cites is traceable to the allowed set
 * of pre-computed numbers. A figure with no numeric content (e.g. "stable",
 * "down") passes — the guardrail only polices quantitative claims.
 */
export function verifyFigures(
  figures: NarrativeOutput['figures_referenced'],
  allowed: Iterable<number>,
  opts?: { absolute?: number; relative?: number },
): VerificationResult {
  const allowedArr = [...allowed];
  const checks: FigureCheck[] = figures.map(({ label, value }) => {
    const numbers = extractNumbers(value);
    const unmatched = numbers.filter((n) => !matchesAllowed(n, allowedArr, opts));
    return { label, value, unmatched, ok: unmatched.length === 0 };
  });
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

/** Human-readable summary of failures, for retry prompts and audit logs. */
export function describeFailures(result: VerificationResult): string {
  return result.failures
    .map((f) => `- "${f.label}": value "${f.value}" contains unverifiable number(s): ${f.unmatched.join(', ')}`)
    .join('\n');
}
