import { describe, expect, it } from 'vitest';
import { computeTriage, type Triage, type TriageInput } from '../src/triage.js';

const NOW = Date.parse('2026-08-15T12:00:00.000Z');
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

const FINAL = { final: { at: at(-1), by: 'jason', version: 2 } };

// Spec order: needs_finalizing, done, package_not_sent, meeting_passed, meeting_soon,
// needs_scheduling, not_started, in_progress.
const cases: Array<[string, Omit<TriageInput, 'now'>, Triage]> = [
  ['completed QBR is done once finalized', { hasData: true, status: 'completed', meetingAt: at(-10), locks: FINAL }, 'done'],
  ['completed QBR eight days past its meeting needs finalizing', { hasData: true, status: 'completed', meetingAt: at(-8), locks: undefined }, 'needs_finalizing'],
  ['completed QBR with no meeting needs finalizing', { hasData: true, status: 'completed', meetingSkipped: true }, 'needs_finalizing'],
  ['completed QBR inside the seven-day window still needs finalizing', { hasData: true, status: 'completed', meetingAt: at(-2) }, 'needs_finalizing'],
  ['meeting more than seven days past, not completed, needs finalizing', { hasData: true, status: 'scheduled', meetingAt: at(-8), packageSentAt: at(-9) }, 'needs_finalizing'],
  ['archived QBR without a final lock is done', { hasData: true, status: 'archived', meetingAt: at(-30) }, 'done'],
  ['archived QBR is done even without data', { hasData: false, status: 'archived' }, 'done'],
  ['held meeting, nothing sent', { hasData: true, status: 'scheduled', meetingAt: at(-2) }, 'package_not_sent'],
  ['skipped meeting, nothing sent', { hasData: true, status: 'narrative_approved', meetingSkipped: true }, 'package_not_sent'],
  ['meeting passed before scheduling was recorded', { hasData: true, status: 'data_synced', meetingAt: at(-1) }, 'meeting_passed'],
  ['held meeting with the package sent, not yet closed', { hasData: true, status: 'scheduled', meetingAt: at(-1), packageSentAt: at(-1) }, 'meeting_passed'],
  ['meeting in 3 days', { hasData: true, status: 'scheduled', meetingAt: at(3) }, 'meeting_soon'],
  ['meeting in exactly 7 days', { hasData: true, status: 'scheduled', meetingAt: at(7) }, 'meeting_soon'],
  ['data but no meeting', { hasData: true, status: 'data_synced' }, 'needs_scheduling'],
  ['no data at all', { hasData: false, status: undefined }, 'not_started'],
  ['no data, draft', { hasData: false, status: 'draft' }, 'not_started'],
  ['meeting three weeks out', { hasData: true, status: 'scheduled', meetingAt: at(21) }, 'in_progress'],
];

describe('computeTriage', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    expect(computeTriage({ ...input, now: NOW })).toBe(expected);
  });

  it('covers all eight outcomes', () => {
    expect(new Set(cases.map((c) => c[2])).size).toBe(8);
  });
});
