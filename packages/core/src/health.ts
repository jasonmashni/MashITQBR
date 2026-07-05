import { ratingFor } from './scorecard.js';
import type { Rating } from './types.js';

/**
 * Account health is a holistic "how is this relationship doing?" rollup for the
 * admin dashboard — distinct from the client-facing security maturity score.
 * It blends security posture (the backbone), open attention flags, review
 * engagement (was a QBR actually held recently), and a churn signal from spend.
 *
 * Pure and cheap so it runs per client on every dashboard load. Internal only —
 * it never flows into the client-facing report.
 */
export interface HealthSignals {
  /** Blended security maturity score (0–100), or null when nothing is scored yet. */
  securityScore: number | null;
  /** Attention flags from computeFlags — reds weigh more than ambers. */
  flags: ReadonlyArray<{ severity: 'red' | 'amber' }>;
  /** Days since the last QBR was actually held, or null if none has been. */
  daysSinceQbr: number | null;
  /** Security rating regressed quarter-over-quarter. */
  ratingDropped?: boolean;
  /** Spend change QoQ (percent). A steep drop reads as a churn risk. */
  spendDeltaPct?: number | null;
}

export interface AccountHealth {
  /** 0–100 composite. */
  score: number;
  /** green/amber/red via the shared ratingFor bands. */
  rating: Rating;
  /** Up to four short reasons behind the score, worst first. */
  drivers: string[];
}

// ~1.5 quarters since the last review starts to read stale; ~2.5 is overdue.
const REVIEW_STALE_DAYS = 135;
const REVIEW_OVERDUE_DAYS = 225;

/** Compose the account-health score from the signals an admin cares about. */
export function computeAccountHealth(s: HealthSignals): AccountHealth {
  const drivers: string[] = [];

  // Security maturity is the backbone; unknown posture is a mild unknown-risk.
  let score = s.securityScore ?? 60;
  if (s.securityScore === null) drivers.push('No security data synced yet');

  const reds = s.flags.filter((f) => f.severity === 'red').length;
  const ambers = s.flags.filter((f) => f.severity === 'amber').length;
  score -= reds * 8 + ambers * 3;
  if (reds) drivers.push(`${reds} critical flag${reds === 1 ? '' : 's'}`);

  if (s.ratingDropped) {
    score -= 6;
    drivers.push('Maturity slipped vs last quarter');
  }

  if (s.daysSinceQbr === null) {
    score -= 6;
    drivers.push('No QBR held yet');
  } else if (s.daysSinceQbr > REVIEW_OVERDUE_DAYS) {
    score -= 18;
    drivers.push('QBR overdue');
  } else if (s.daysSinceQbr > REVIEW_STALE_DAYS) {
    score -= 9;
    drivers.push('QBR due soon');
  }

  if (typeof s.spendDeltaPct === 'number' && s.spendDeltaPct <= -25) {
    score -= 6;
    drivers.push(`Spend down ${Math.abs(Math.round(s.spendDeltaPct))}% QoQ`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const rating = ratingFor(score);
  if (drivers.length === 0) drivers.push('Healthy across posture, activity and engagement');
  return { score, rating, drivers: drivers.slice(0, 4) };
}

/** Days between an ISO timestamp and now (floored), or null if unparseable/absent. */
export function daysSince(iso: string | undefined | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}
