import type { BookingSettings } from '@mashit/core';

/**
 * Booking-page scheduling logic (pure — no Graph, no store). Wall-clock math
 * happens in the org's IANA timezone; Graph is asked for busy times in that
 * same timezone, so the only UTC conversions are the two Intl-based helpers
 * below (which handle DST exactly).
 */

export interface ResolvedBookingSettings {
  organizerEmail: string;
  title: string;
  description: string;
  durationMinutes: number;
  incrementMinutes: number;
  daysOfWeek: number[];
  dayStart: string;
  dayEnd: string;
  timezone: string;
  leadHours: number;
  maxDaysOut: number;
}

export function resolveBookingSettings(cfg?: BookingSettings): ResolvedBookingSettings {
  const clampInt = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
  const time = (v: unknown, dflt: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : dflt);
  const days = Array.isArray(cfg?.daysOfWeek) ? cfg.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return {
    organizerEmail: typeof cfg?.organizerEmail === 'string' ? cfg.organizerEmail.trim() : '',
    title: (typeof cfg?.title === 'string' && cfg.title.trim()) || 'Quarterly Business Review',
    description: typeof cfg?.description === 'string' ? cfg.description.trim() : '',
    durationMinutes: clampInt(cfg?.durationMinutes, 15, 240, 60),
    incrementMinutes: clampInt(cfg?.incrementMinutes, 15, 120, 30),
    daysOfWeek: days.length ? [...new Set(days)].sort() : [1, 2, 3, 4, 5],
    dayStart: time(cfg?.dayStart, '09:00'),
    dayEnd: time(cfg?.dayEnd, '17:00'),
    timezone: isValidTimezone(cfg?.timezone) ? cfg!.timezone! : 'America/Detroit',
    leadHours: clampInt(cfg?.leadHours, 0, 24 * 30, 24),
    maxDaysOut: clampInt(cfg?.maxDaysOut, 1, 365, 45),
  };
}

export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock "YYYY-MM-DDTHH:mm" for a UTC instant in an IANA timezone. */
export function wallClock(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** UTC instant for a wall-clock "YYYY-MM-DDTHH:mm" in a timezone (DST-exact). */
export function localToUtc(local: string, tz: string): Date {
  let guess = new Date(`${local}:00Z`);
  for (let i = 0; i < 3; i++) {
    const diff = Date.parse(`${wallClock(guess, tz)}:00Z`) - Date.parse(`${local}:00Z`);
    if (diff === 0) return guess;
    guess = new Date(guess.getTime() - diff);
  }
  return guess;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar day-of-week (0=Sun) for a "YYYY-MM-DD" — timezone-independent. */
function dayOfWeek(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function hhmm(totalMinutes: number): string {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

export interface BookableWindow {
  /** First bookable calendar day, "YYYY-MM-DD" in the org timezone. */
  firstDay: string;
  /** Last bookable calendar day. */
  lastDay: string;
}

/** The bookable date window given lead time + max days out. */
export function bookableWindow(s: ResolvedBookingSettings, now: Date): BookableWindow {
  const nowLocal = wallClock(now, s.timezone);
  const minStart = wallClock(new Date(now.getTime() + s.leadHours * 3_600_000), s.timezone);
  return { firstDay: minStart.slice(0, 10), lastDay: addDays(nowLocal.slice(0, 10), s.maxDaysOut) };
}

/**
 * Candidate slot starts ("YYYY-MM-DDTHH:mm" local) for [fromDay..toDay],
 * respecting weekdays, day window, lead time and max-days-out.
 */
export function candidateSlots(s: ResolvedBookingSettings, fromDay: string, toDay: string, now: Date): string[] {
  const window = bookableWindow(s, now);
  const minStartLocal = wallClock(new Date(now.getTime() + s.leadHours * 3_600_000), s.timezone);
  const from = fromDay > window.firstDay ? fromDay : window.firstDay;
  const to = toDay < window.lastDay ? toDay : window.lastDay;
  const out: string[] = [];
  const startMin = minutes(s.dayStart);
  const lastStartMin = minutes(s.dayEnd) - s.durationMinutes;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!s.daysOfWeek.includes(dayOfWeek(day))) continue;
    for (let m = startMin; m <= lastStartMin; m += s.incrementMinutes) {
      const slot = `${day}T${hhmm(m)}`;
      if (slot >= minStartLocal) out.push(slot);
    }
  }
  return out;
}

/**
 * Keep only slots whose whole duration is free in a Graph availabilityView
 * ('0' = free) that starts at `viewStartLocal` with `intervalMinutes` cells.
 * Index math uses real UTC elapsed time so DST transitions don't misalign.
 */
export function filterFreeSlots(
  slots: string[],
  view: string,
  viewStartLocal: string,
  s: ResolvedBookingSettings,
): string[] {
  const viewStartMs = localToUtc(viewStartLocal, s.timezone).getTime();
  const cells = Math.ceil(s.durationMinutes / s.incrementMinutes);
  return slots.filter((slot) => {
    const idx = Math.round((localToUtc(slot, s.timezone).getTime() - viewStartMs) / 60000 / s.incrementMinutes);
    if (idx < 0 || idx + cells > view.length) return false;
    for (let i = idx; i < idx + cells; i++) if (view[i] !== '0') return false;
    return true;
  });
}

/** Human label for a local slot, e.g. "Tue, Jul 14 · 10:30 AM". */
export function slotLabel(slot: string, tz: string): string {
  const d = localToUtc(slot, tz);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** Add the meeting duration to a local slot start → local end. */
export function slotEnd(slot: string, s: ResolvedBookingSettings): string {
  const day = slot.slice(0, 10);
  const endMin = minutes(slot.slice(11)) + s.durationMinutes;
  // Slots never cross midnight (dayEnd caps them), so the day part is stable.
  return `${day}T${hhmm(endMin)}`;
}

/** Unguessable URL token for a booking link. */
export function newBookingToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
