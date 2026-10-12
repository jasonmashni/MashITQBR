import type { MaturityScorecard, NistFunction, Rating, SafeguardResult } from './types.js';

/**
 * The five business questions the protection page answers. Each groups the
 * scorecard safeguards an owner would think of together; the NIST function
 * and score sit in the margin for the auditor.
 */
export type ProtectionQuestionId = 'get_in' | 'know' | 'recover' | 'keep_up' | 'run_well';

export interface ProtectionQuestionDef {
  id: ProtectionQuestionId;
  question: string;
  /** Safeguard ids from SAFEGUARDS (scorecard.ts). */
  safeguards: readonly string[];
}

export const PROTECTION_QUESTIONS: readonly ProtectionQuestionDef[] = [
  { id: 'get_in', question: 'Can someone get in?', safeguards: ['mfa', 'email_security'] },
  { id: 'know', question: 'Would we know, and how fast would we act?', safeguards: ['edr', 'identity_threat', 'siem', 'incident_response'] },
  { id: 'recover', question: 'Could we recover?', safeguards: ['backup', 'data_protection'] },
  { id: 'keep_up', question: 'Are we keeping up?', safeguards: ['patching', 'asset_inventory'] },
  { id: 'run_well', question: 'Are we running it well?', safeguards: ['governance', 'sat'] },
];

export interface ProtectionRow {
  id: ProtectionQuestionId;
  question: string;
  /** Worst rating among the measured safeguards; `unknown` when none is measured. */
  rating: Rating;
  /** Distinct NIST functions of the group's safeguards, with each function's scorecard score. */
  functions: Array<{ function: NistFunction; score: number | null }>;
  safeguards: SafeguardResult[];
}

const SEVERITY: Record<Rating, number> = { red: 0, amber: 1, green: 2, unknown: 3 };

/** Group a scorecard into the five protection rows, in question order. */
export function protectionRows(scorecard: MaturityScorecard): ProtectionRow[] {
  const byId = new Map(scorecard.safeguards.map((s) => [s.id, s]));
  const fnScore = new Map(scorecard.functions.map((f) => [f.function, f.score]));
  return PROTECTION_QUESTIONS.map((q) => {
    const safeguards = q.safeguards.map((id) => byId.get(id)).filter((s): s is SafeguardResult => s !== undefined);
    const measured = safeguards.filter((s) => s.measured && s.rating !== 'unknown');
    const rating = measured.reduce<Rating>((worst, s) => (SEVERITY[s.rating] < SEVERITY[worst] ? s.rating : worst), 'unknown');
    const functions: ProtectionRow['functions'] = [];
    for (const s of safeguards) {
      if (!functions.some((f) => f.function === s.nistFunction)) functions.push({ function: s.nistFunction, score: fnScore.get(s.nistFunction) ?? null });
    }
    return { id: q.id, question: q.question, rating, functions, safeguards };
  });
}
