import type { QbrStatus } from './types.js';

/** QBR lifecycle stages in forward order (also the source of truth for validation). */
export const QBR_STATUS_ORDER: readonly QbrStatus[] = [
  'draft',
  'data_synced',
  'narrative_approved',
  'scheduled',
  'completed',
  'dispositioned',
  'actions_pushed',
  'archived',
];

export function isQbrStatus(value: unknown): value is QbrStatus {
  return typeof value === 'string' && (QBR_STATUS_ORDER as readonly string[]).includes(value);
}

function rank(status: QbrStatus | undefined): number {
  return status ? QBR_STATUS_ORDER.indexOf(status) : 0;
}

/**
 * Move a QBR's status forward to `candidate` if that is actually a progression.
 * Never downgrades (a re-sync must not demote a scheduled/completed QBR), and
 * treats `archived` as terminal. An unset current status counts as `draft`.
 * Explicit user overrides should set the status directly instead.
 */
export function advanceStatus(current: QbrStatus | undefined, candidate: QbrStatus): QbrStatus {
  const effective: QbrStatus = current ?? 'draft';
  if (effective === 'archived') return effective;
  return rank(candidate) > rank(effective) ? candidate : effective;
}

/**
 * Human labels for every lifecycle stage. The only vocabulary that may reach
 * a screen or a deliverable; enum strings stay internal.
 */
export const QBR_STATUS_LABELS: Record<QbrStatus, string> = {
  draft: 'Not started',
  data_synced: 'Data pulled',
  narrative_approved: 'Narrative approved',
  scheduled: 'Meeting booked',
  completed: 'Review complete',
  dispositioned: 'Decisions captured',
  actions_pushed: 'Actions pushed',
  archived: 'Archived',
};

/** Label for a status; unknown or missing values read as "Not started". */
export function qbrStatusLabel(status: QbrStatus | string | undefined): string {
  return isQbrStatus(status) ? QBR_STATUS_LABELS[status] : QBR_STATUS_LABELS.draft;
}

/** True when `current` has reached `target` in the lifecycle (unset counts as draft). */
export function statusAtLeast(current: QbrStatus | undefined, target: QbrStatus): boolean {
  return rank(current ?? 'draft') >= rank(target);
}
