import type { LockInfo, QbrMeta, QbrStatus } from '../../types.js';
import { lockNotice } from './nextStep.js';

/** One row of the client's quarter list (GET /api/clients/{id}/periods), newest first. */
export interface LandingPeriod {
  period: string;
  hasSnapshot: boolean;
  status?: string;
  locks?: { preread?: LockInfo; final?: LockInfo };
}

/**
 * Which quarter the workspace opens on. A valid `?period=` wins. Otherwise
 * the open quarter (data in, no final lock) newer than any finalized one,
 * else the newest final quarter (read-only, with "Start next quarter"),
 * else the newest quarter in the list.
 */
export function chooseLandingPeriod(list: LandingPeriod[], wanted: string | null | undefined): string | undefined {
  if (wanted && list.some((p) => p.period === wanted)) return wanted;
  const newestFinal = list.find((p) => p.locks?.final);
  const open = list.find((p) => p.hasSnapshot && !p.locks?.final);
  if (open && (!newestFinal || open.period > newestFinal.period)) return open.period;
  if (newestFinal) return newestFinal.period;
  return list[0]?.period;
}

/** The quarter after `period`, when the list (newest first) carries it. */
export function nextPeriodIn(list: LandingPeriod[], period: string): string | undefined {
  const idx = list.findIndex((p) => p.period === period);
  return idx > 0 ? list[idx - 1]!.period : undefined;
}

/**
 * The quarter's lock state from the period list, for when the QBR itself
 * could not load (a locked quarter whose stored package is missing answers
 * 503). Undefined when the quarter is not locked or not listed.
 */
export function metaFromPeriodList(list: LandingPeriod[], clientId: string, period: string): QbrMeta | undefined {
  const row = list.find((p) => p.period === period);
  if (!row?.locks?.preread && !row?.locks?.final) return undefined;
  return { clientId, period, status: (row.status ?? 'draft') as QbrStatus, locks: row.locks };
}

/** What the workspace shows when the QBR fails to load; null for the empty state (no data). */
export function qbrLoadError(status: number | undefined, message: string): { title: string; text: string } | null {
  if (status === 404) return null;
  if (status === 503) {
    return { title: 'Stored package missing', text: 'The stored package for this quarter is missing. Reopen the quarter to rebuild it.' };
  }
  return { title: 'Could not build the report', text: `${message}. Try a Sync, or check the client's tool mappings on the Integrations page.` };
}

/**
 * The lock sentence for every locked quarter in the list, keyed by period.
 * The Reports tab spans all quarters, so each row checks its own quarter.
 */
export function lockedPeriodNotices(list: LandingPeriod[], clientId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of list) {
    const notice = lockNotice(metaFromPeriodList(list, clientId, row.period));
    if (notice) out[row.period] = notice;
  }
  return out;
}
