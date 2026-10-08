import { PROTECTION_QUESTION_IDS, type NarrativeOutput } from './schema.js';

/**
 * Hard word and count limits of the v4 narrative contract. A breach is a
 * verification failure the editor shows with counters; nothing is ever
 * truncated to fit.
 */
export const NARRATIVE_LIMITS = {
  headlineWords: 12,
  ledeWords: 60,
  bulletWords: 18,
  didMin: 3,
  didMax: 4,
  decisionsMax: 3,
  planPerColumn: 3,
  protectionWords: 40,
} as const;

/** Words in a string, split on whitespace. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Every limit breach in a narrative, one entry per field, in page order:
 * `'headline: 13 words (limit 12)'`, `'did: 2 items (3 to 4)'`,
 * `'plan.now: 4 items (limit 3)'`, `'protection.know.inPlace: 41 words (limit 40)'`.
 * Missing arrays count as empty so a malformed draft still reports.
 */
export function limitIssues(output: NarrativeOutput): string[] {
  const L = NARRATIVE_LIMITS;
  const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
  const issues: string[] = [];
  const words = (field: string, text: string | undefined, limit: number) => {
    const n = wordCount(text ?? '');
    if (n > limit) issues.push(`${field}: ${n} words (limit ${limit})`);
  };

  words('headline', output.headline, L.headlineWords);
  words('lede', output.lede, L.ledeWords);
  for (const key of ['did', 'saw'] as const) {
    const list = output[key] ?? [];
    if (list.length < L.didMin || list.length > L.didMax) issues.push(`${key}: ${items(list.length)} (${L.didMin} to ${L.didMax})`);
    list.forEach((b, i) => words(`${key}[${i}]`, b, L.bulletWords));
  }
  const decisions = output.decisions ?? [];
  if (decisions.length > L.decisionsMax) issues.push(`decisions: ${items(decisions.length)} (limit ${L.decisionsMax})`);
  for (const column of ['now', 'next', 'later'] as const) {
    const planned = output.plan?.[column] ?? [];
    if (planned.length > L.planPerColumn) issues.push(`plan.${column}: ${items(planned.length)} (limit ${L.planPerColumn})`);
  }
  const protection = output.protection ?? [];
  if (protection.length !== PROTECTION_QUESTION_IDS.length) {
    issues.push(`protection: ${items(protection.length)} (exactly ${PROTECTION_QUESTION_IDS.length})`);
  }
  protection.forEach((p, i) => {
    const expected = PROTECTION_QUESTION_IDS[i];
    if (expected && p.question !== expected) issues.push(`protection[${i}]: ${p.question} where ${expected} belongs`);
  });
  for (const p of protection) {
    words(`protection.${p.question}.inPlace`, p.inPlace, L.protectionWords);
    words(`protection.${p.question}.thisQuarter`, p.thisQuarter, L.protectionWords);
  }
  return issues;
}
