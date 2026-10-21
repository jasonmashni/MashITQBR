import type { DiscussionItem, SinceOverride, SinceOverrideStatus, SinceRow, SinceStatus } from '../../types.js';

/** The four close-outs, in the order the control shows them. */
export const SINCE_CHOICES: Array<{ value: SinceOverrideStatus; label: string }> = [
  { value: 'done', label: 'Done' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting', label: 'Waiting on client' },
  { value: 'dropped', label: 'Dropped' },
];

/** Longest close-out note (the server refuses longer). */
export const SINCE_NOTE_MAX = 200;

const TO_STATUS: Record<SinceOverrideStatus, SinceStatus> = { done: 'done', in_progress: 'in_progress', waiting: 'waiting', dropped: 'closed' };
const TO_CHOICE: Record<SinceStatus, SinceOverrideStatus> = { done: 'done', in_progress: 'in_progress', waiting: 'waiting', closed: 'dropped' };

/** One row of the Meeting tab's "Since last quarter" panel. */
export interface SincePanelRow {
  id: string;
  topic: string;
  /** What the control shows: this quarter's close-out, else the computed status. */
  choice: SinceOverrideStatus;
  /** What the report will print. */
  effective: SinceStatus;
  note: string;
  ticket?: { id: string; status?: string };
  /** Already on this quarter's agenda as a carried item. */
  carried: boolean;
  /** Still open (in progress or waiting) and not carried yet. */
  canCarry: boolean;
}

/**
 * The panel rows from GET .../since and the agenda being edited. The local
 * overrides (unsaved edits included) win over the server's view.
 */
export function sinceRowsForPanel(rows: SinceRow[], overrides: Record<string, SinceOverride> | undefined, agenda: DiscussionItem[]): SincePanelRow[] {
  const carried = new Set(agenda.filter((i) => i.source === 'carried' && i.sourceRef).map((i) => i.sourceRef!));
  return rows.map((r) => {
    const o = overrides?.[r.id];
    const choice = o?.status ?? TO_CHOICE[r.computed];
    const effective = TO_STATUS[choice];
    const isCarried = carried.has(r.id);
    return {
      id: r.id,
      topic: r.topic,
      choice,
      effective,
      note: o?.note ?? '',
      ...(r.ticket ? { ticket: r.ticket } : {}),
      carried: isCarried,
      canCarry: !isCarried && (effective === 'in_progress' || effective === 'waiting'),
    };
  });
}

/**
 * The override map after one edit. A note-only edit starts from the status
 * the control shows. at and by are placeholders; the server stamps them.
 */
export function setSinceOverride(
  overrides: Record<string, SinceOverride> | undefined,
  row: Pick<SincePanelRow, 'id' | 'choice' | 'note'>,
  patch: { status?: SinceOverrideStatus; note?: string },
): Record<string, SinceOverride> {
  const prior = overrides?.[row.id];
  const status = patch.status ?? prior?.status ?? row.choice;
  const note = patch.note ?? prior?.note ?? row.note;
  return { ...overrides, [row.id]: { status, ...(note ? { note } : {}), at: prior?.at ?? '', by: prior?.by ?? '' } };
}

/**
 * The agenda item a still-open row becomes: planned, pending, the topic
 * copied. For a HIPAA client it stays off the report until the topic is
 * rewritten (sourceTopic records the copied wording; the server enforces it).
 */
export function carriedItem(row: Pick<SinceRow, 'id' | 'topic'>, hipaa: boolean, id: string): DiscussionItem {
  return {
    id,
    topic: row.topic,
    status: 'planned',
    disposition: 'pending',
    includeInReport: !hipaa,
    source: 'carried',
    sourceRef: row.id,
    sourceTopic: row.topic,
  };
}
