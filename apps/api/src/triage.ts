import { statusAtLeast, type QbrStatus } from '@mashit/core';
import type { QbrRecord } from './store/types.js';

/** What the dashboard should nudge the account manager to do this quarter. */
export type Triage =
  | 'not_started'
  | 'needs_scheduling'
  | 'meeting_soon'
  | 'meeting_passed'
  | 'package_not_sent'
  | 'needs_finalizing'
  | 'in_progress'
  | 'done';

export interface TriageInput {
  hasData: boolean;
  status: QbrStatus | undefined;
  meetingAt?: string;
  packageSentAt?: string;
  meetingSkipped?: boolean;
  locks?: QbrRecord['locks'];
  now: number;
}

const SOON_MS = 7 * 86_400_000;

/**
 * Current-quarter triage. Rules are evaluated in order; the first match wins.
 * A skipped meeting counts as "meeting time passed" when no time was booked.
 * A quarter whose meeting is more than seven days past, or that is completed,
 * is nagged until its final package is stored (archived quarters excepted).
 * An open quarter whose meeting passed with no package sent is nagged to
 * send first: that outranks finalizing.
 */
export function computeTriage(i: TriageInput): Triage {
  const at = i.meetingAt ? Date.parse(i.meetingAt) : NaN;
  const hasMeeting = Number.isFinite(at);
  const meetingPassed = hasMeeting ? at <= i.now : !!i.meetingSkipped;
  const open = !i.locks?.final && i.status !== 'archived';

  if (open && (statusAtLeast(i.status, 'scheduled') || i.meetingSkipped) && meetingPassed && !i.packageSentAt) return 'package_not_sent';
  const meetingLongPast = hasMeeting && at <= i.now - SOON_MS;
  if ((meetingLongPast || statusAtLeast(i.status, 'completed')) && !i.locks?.final && i.status !== 'archived') {
    return 'needs_finalizing';
  }
  if (statusAtLeast(i.status, 'completed')) return 'done';
  if (hasMeeting && at <= i.now) return 'meeting_passed';
  if (hasMeeting && at - i.now <= SOON_MS) return 'meeting_soon';
  if (i.hasData && !hasMeeting && !i.meetingSkipped) return 'needs_scheduling';
  if (!i.hasData) return 'not_started';
  return 'in_progress';
}
