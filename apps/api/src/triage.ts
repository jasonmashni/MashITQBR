import { statusAtLeast, type QbrStatus } from '@mashit/core';

/** What the dashboard should nudge the account manager to do this quarter. */
export type Triage = 'not_started' | 'needs_scheduling' | 'meeting_soon' | 'meeting_passed' | 'package_not_sent' | 'in_progress' | 'done';

export interface TriageInput {
  hasData: boolean;
  status: QbrStatus | undefined;
  meetingAt?: string;
  packageSentAt?: string;
  meetingSkipped?: boolean;
  now: number;
}

const SOON_MS = 7 * 86_400_000;

/**
 * Current-quarter triage. Rules are evaluated in order; the first match wins.
 * A skipped meeting counts as "meeting time passed" when no time was booked.
 */
export function computeTriage(i: TriageInput): Triage {
  const at = i.meetingAt ? Date.parse(i.meetingAt) : NaN;
  const hasMeeting = Number.isFinite(at);
  const meetingPassed = hasMeeting ? at <= i.now : !!i.meetingSkipped;

  if (statusAtLeast(i.status, 'completed')) return 'done';
  if ((statusAtLeast(i.status, 'scheduled') || i.meetingSkipped) && meetingPassed && !i.packageSentAt) return 'package_not_sent';
  if (hasMeeting && at <= i.now) return 'meeting_passed';
  if (hasMeeting && at - i.now <= SOON_MS) return 'meeting_soon';
  if (i.hasData && !hasMeeting && !i.meetingSkipped) return 'needs_scheduling';
  if (!i.hasData) return 'not_started';
  return 'in_progress';
}
