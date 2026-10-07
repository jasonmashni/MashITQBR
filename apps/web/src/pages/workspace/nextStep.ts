import { isQbrStatus, statusAtLeast, type QbrStatus } from '@mashit/core';
import type { Confidence, Discussion, QbrMeta } from '../../types.js';

/**
 * The QBR pipeline as pure data: which step is done, which comes next, and
 * whether the deliverables may go out. The header, the stepper and the
 * Deliver menu all read from here so they can never disagree.
 */

export type StepKey = 'sync' | 'reports' | 'narrative' | 'schedule' | 'meet' | 'send' | 'complete';

export interface Step {
  key: StepKey;
  /** The step as a noun phrase for the stepper. */
  label: string;
  /** The same step as the verb on the primary button. */
  action: string;
  /** One line of state under the label. */
  desc: string;
  done: boolean;
  /** Where clicking the step takes you. */
  tab: 'overview' | 'data' | 'reports' | 'meeting';
}

export interface StepInput {
  hasData: boolean;
  meta?: QbrMeta;
  unfiled: number;
  disc: Discussion | null;
  now?: number;
}

const asStatus = (s: string | undefined): QbrStatus | undefined => (isQbrStatus(s) ? s : undefined);

export function deriveSteps(i: StepInput): Step[] {
  const status = asStatus(i.meta?.status);
  const scheduledAt = i.meta?.meeting?.scheduledAt;
  const scheduled = Boolean(scheduledAt);
  const skipped = Boolean(i.meta?.meetingSkipped);
  const discussed = Boolean(i.disc?.items.some((x) => x.status === 'discussed'));
  const closed = statusAtLeast(status, 'completed');
  // A meeting counts as held when someone captured something, the client
  // skipped it, or the quarter is already closed. The booked time passing on
  // its own proves nothing: a no-show must not read as a review.
  const held = skipped || discussed || (closed && !skipped);
  const meetingPassed = scheduled && Date.parse(scheduledAt as string) < (i.now ?? Date.now());
  const sent = Boolean(i.meta?.packageSentAt);

  return [
    {
      key: 'sync',
      label: 'Sync data',
      action: 'Sync data',
      desc: i.hasData ? 'Data is in' : 'Pull from the connected tools',
      done: i.hasData,
      tab: 'data',
    },
    {
      key: 'reports',
      label: 'File reports',
      action: 'File reports',
      desc: i.unfiled > 0 ? `${i.unfiled} need filing` : 'Repository tidy',
      done: i.hasData && i.unfiled === 0,
      tab: 'reports',
    },
    {
      key: 'narrative',
      label: 'Approve narrative',
      action: 'Approve narrative',
      desc: statusAtLeast(status, 'narrative_approved') ? 'Approved' : 'Read the story and approve it',
      done: statusAtLeast(status, 'narrative_approved'),
      tab: 'overview',
    },
    {
      key: 'schedule',
      label: 'Book the meeting',
      action: 'Book the meeting',
      desc: skipped && !scheduled ? 'Client skipped this quarter' : scheduled ? 'On the calendar' : 'Send the booking link or pick a time',
      done: scheduled || skipped,
      tab: 'meeting',
    },
    {
      key: 'meet',
      label: 'Hold the meeting',
      action: 'Capture the meeting',
      desc: skipped
        ? 'Client skipped this quarter'
        : held
          ? 'Answers captured'
          : meetingPassed
            ? 'Meeting time passed. Capture answers or rebook.'
            : 'Capture answers live',
      done: held,
      tab: 'meeting',
    },
    {
      key: 'send',
      label: 'Send package',
      action: 'Send package',
      desc: sent ? 'Package sent' : 'Email draft carries the PDF',
      done: sent,
      tab: 'overview',
    },
    {
      key: 'complete',
      label: 'Close the quarter',
      action: 'Close the quarter',
      desc: closed ? 'Closed. Next quarter is up.' : 'Close out this quarter',
      done: closed,
      tab: 'overview',
    },
  ];
}

/** The first step that is not done; undefined when the quarter is finished. */
export function nextStep(steps: Step[]): Step | undefined {
  return steps.find((s) => !s.done);
}

/** Every step before "Close the quarter" is done and the quarter is still open. */
export function readyToComplete(steps: Step[]): boolean {
  const close = steps[steps.length - 1];
  return Boolean(close && !close.done && steps.slice(0, -1).every((s) => s.done));
}

export interface GuardInput {
  hasQbr: boolean;
  verificationOk: boolean;
  status?: string;
  confidence?: Confidence;
}

export interface Guard {
  ok: boolean;
  /** Why the deliverables are locked. */
  reason?: string;
  /** Something the sender should know but that does not lock the deliverables. */
  warning?: string;
}

/**
 * May the client-facing deliverables go out? Locked until there is data and
 * an approved, verified narrative. Low security-data coverage is a warning,
 * not a lock: the report itself says "Not scored" in that case.
 */
export function deliverableGuard(i: GuardInput): Guard {
  if (!i.hasQbr) return { ok: false, reason: 'Sync data first' };
  if (!i.verificationOk) return { ok: false, reason: 'Figures failed verification. Edit or regenerate the narrative.' };
  if (!statusAtLeast(asStatus(i.status), 'narrative_approved')) return { ok: false, reason: 'Approve the narrative first' };
  if (i.confidence === 'low') return { ok: true, warning: 'Not enough security data for a score; the report says so.' };
  return { ok: true };
}
