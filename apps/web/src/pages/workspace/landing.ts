import type { LockInfo } from '../../types.js';

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
