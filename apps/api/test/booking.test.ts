import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bookableWindow,
  candidateSlots,
  filterFreeSlots,
  localToUtc,
  newBookingToken,
  resolveBookingSettings,
  slotEnd,
  wallClock,
} from '../src/booking.js';

const TZ = 'America/Detroit';
const SETTINGS = resolveBookingSettings({ timezone: TZ, organizerEmail: 'jason@mashit.net' });

describe('booking timezone math (DST-exact)', () => {
  it('round-trips wall clock <-> UTC across the July offset', () => {
    // 10:30 EDT = 14:30 UTC
    const utc = localToUtc('2026-07-14T10:30', TZ);
    expect(utc.toISOString()).toBe('2026-07-14T14:30:00.000Z');
    expect(wallClock(utc, TZ)).toBe('2026-07-14T10:30');
  });

  it('handles the winter offset too (EST = UTC-5)', () => {
    expect(localToUtc('2026-01-14T10:30', TZ).toISOString()).toBe('2026-01-14T15:30:00.000Z');
  });
});

describe('candidateSlots', () => {
  // "Now": Mon Jul 6 2026, 12:00 EDT (16:00 UTC). Lead time 24h.
  const now = new Date('2026-07-06T16:00:00Z');

  it('offers weekday slots inside the day window, respecting lead time', () => {
    const slots = candidateSlots(SETTINGS, '2026-07-06', '2026-07-08', now);
    expect(slots.some((s) => s.startsWith('2026-07-06'))).toBe(false); // inside 24h notice
    expect(slots).not.toContain('2026-07-07T11:30'); // still inside the 24h lead
    expect(slots).toContain('2026-07-07T12:00'); // exactly at the lead edge is bookable
    expect(slots).toContain('2026-07-07T13:00');
    expect(slots).toContain('2026-07-08T09:00');
    expect(slots).toContain('2026-07-08T16:00'); // last start for a 60-min meeting ending 17:00
    expect(slots).not.toContain('2026-07-08T16:30');
  });

  it('skips weekends and caps at maxDaysOut', () => {
    const slots = candidateSlots(SETTINGS, '2026-07-11', '2026-07-12', now); // Sat + Sun
    expect(slots).toHaveLength(0);
    const window = bookableWindow(SETTINGS, now);
    expect(window.lastDay).toBe('2026-08-20'); // 45 days out
    expect(candidateSlots(SETTINGS, '2026-09-01', '2026-09-02', now)).toHaveLength(0); // beyond window
  });

  it('slotEnd adds the meeting duration', () => {
    expect(slotEnd('2026-07-08T16:00', SETTINGS)).toBe('2026-07-08T17:00');
  });
});

describe('filterFreeSlots (Graph availabilityView)', () => {
  it('keeps only slots whose whole duration is free', () => {
    // View starts at 09:00 on the slot day, 30-min cells: 0=free 2=busy.
    // Cells: 09:00 F F 10:00 B B 11:00 F F ...
    const s = resolveBookingSettings({ timezone: TZ, dayStart: '09:00', dayEnd: '12:00' });
    const view = '002200';
    const slots = ['2026-07-08T09:00', '2026-07-08T10:00', '2026-07-08T11:00'];
    expect(filterFreeSlots(slots, view, '2026-07-08T09:00', s)).toEqual(['2026-07-08T09:00', '2026-07-08T11:00']);
  });

  it('drops slots that would overflow the view', () => {
    const s = resolveBookingSettings({ timezone: TZ });
    expect(filterFreeSlots(['2026-07-08T09:30'], '00', '2026-07-08T09:00', s)).toEqual([]);
  });
});

describe('resolveBookingSettings defaults + clamps', () => {
  it('fills executive-sane defaults', () => {
    const s = resolveBookingSettings(undefined);
    expect(s.durationMinutes).toBe(60);
    expect(s.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(s.timezone).toBe('America/Detroit');
    expect(s.title).toBe('Quarterly Business Review');
  });
  it('clamps out-of-range values and rejects junk times', () => {
    const s = resolveBookingSettings({ durationMinutes: 9999, dayStart: '25:99', timezone: 'Not/AZone' });
    expect(s.durationMinutes).toBe(240);
    expect(s.dayStart).toBe('09:00');
    expect(s.timezone).toBe('America/Detroit');
  });
});

describe('booking flow end-to-end (JSON store + fake Graph)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbr-booking-'));
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
    delete process.env['GRAPH_TENANT_ID'];
    delete process.env['REPORTS_TENANT_ID'];
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QBR_DATA_DIR'];
  });

  it('creates a link, serves public info + slots, books, and schedules the QBR', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');

    const created = await h.ensureBookingLink('anp', '2026-Q3');
    expect(created.status).toBe(200);
    const { booking, path } = created.json as { booking: { token: string }; path: string };
    expect(path).toBe(`/book/${booking.token}`);

    // Idempotent: asking again reuses the open link.
    const again = await h.ensureBookingLink('anp', '2026-Q3');
    expect((again.json as { booking: { token: string } }).booking.token).toBe(booking.token);

    // Public page + info (no auth context needed).
    expect(h.getBookingPage(booking.token).html).toContain('Schedule your business review');
    const info = await h.publicBookingInfo(booking.token);
    expect(info.status).toBe(200);
    expect((info.json as { clientName: string }).clientName).toBe('ANP Enertech');
    expect((info.json as { status: string }).status).toBe('open');

    // Slots (no Graph creds -> configured windows, calendarChecked false).
    const slots = await h.publicBookingSlots(booking.token, '2026-08-03', '2026-08-07');
    expect(slots.status).toBe(200);
    const slotBody = slots.json as { slots: string[]; calendarChecked: boolean };
    expect(slotBody.calendarChecked).toBe(false);
    expect(slotBody.slots.length).toBeGreaterThan(0);
    const pick = slotBody.slots[0]!;

    // Book it.
    const booked = await h.publicBook(booking.token, {
      start: pick,
      name: 'James Baek',
      email: 'james@anp.example',
      attendees: ['cfo@anp.example', 'not-an-email'],
      notes: 'Focus on the refresh plan',
    });
    expect(booked.status).toBe(200);
    expect((booked.json as { inviteSent: boolean }).inviteSent).toBe(false); // no Graph creds

    // The QBR record reflects the meeting and advanced to scheduled.
    const qbr = await getDataStore().getQbr('anp', '2026-Q3');
    expect(qbr?.status).toBe('scheduled');
    expect(qbr?.meeting?.scheduledAt).toBeTruthy();
    expect(qbr?.meeting?.attendees).toEqual(['james@anp.example', 'cfo@anp.example']);

    // Second booking attempt on the same link is refused.
    const dup = await h.publicBook(booking.token, { start: pick, name: 'X', email: 'x@y.zz' });
    expect(dup.status).toBe(409);

    // A booking notification landed on the bell.
    const notifs = await getDataStore().listNotifications(10);
    expect(notifs.some((n) => n.kind === 'booking')).toBe(true);

    // Cancel the meeting: booking goes cancelled, QBR meeting cleared, and a
    // fresh link can be issued (the previously-booked link no longer blocks it).
    const cancelled = await h.cancelQbrMeeting('anp', '2026-Q3');
    expect(cancelled.status).toBe(200);
    expect((cancelled.json as { cancelled: boolean }).cancelled).toBe(true);
    const afterCancel = await getDataStore().getQbr('anp', '2026-Q3');
    expect(afterCancel?.meeting?.scheduledAt).toBeUndefined();
    expect(afterCancel?.status).toBe('data_synced'); // stepped back from scheduled
    expect((await getDataStore().getBooking(booking.token))?.status).toBe('cancelled');

    // getBookingState no longer advertises the dead (cancelled) link as active.
    const stateAfter = await h.getBookingState('anp', '2026-Q3');
    expect((stateAfter.json as { path: string | null }).path).toBeNull();

    const relink = await h.ensureBookingLink('anp', '2026-Q3');
    const newToken = (relink.json as { booking: { token: string } }).booking.token;
    expect(newToken).not.toBe(booking.token); // a NEW open link
    const stateRelinked = await h.getBookingState('anp', '2026-Q3');
    expect((stateRelinked.json as { path: string | null }).path).toBe(`/book/${newToken}`); // active again
  });

  it('rejects junk tokens and out-of-window slots', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.publicBookingInfo('short')).status).toBe(404);
    expect((await h.publicBookingInfo(newBookingToken())).status).toBe(404); // valid shape, unknown
    const link = await h.ensureBookingLink('kpca', '2026-Q3');
    const token = (link.json as { booking: { token: string } }).booking.token;
    // Sunday / past-lead-time starts are refused even if POSTed directly.
    const bad = await h.publicBook(token, { start: '2026-08-02T10:00', name: 'A', email: 'a@b.co' });
    expect(bad.status).toBe(409);
  });

  it('CSPRNG tokens are unique and well-formed', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newBookingToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[a-z0-9]{24}$/);
  });
});

describe('QbrRecord field durability (pipeline stepper regression)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbr-durability-'));
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QBR_DATA_DIR'];
  });

  it('packageSentAt survives a later booking + status change (patchQbr merge)', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await store.upsertClient({ id: 'anp', name: 'ANP Enertech' });
    await store.putSnapshot({
      clientId: 'anp',
      period: '2026-Q4',
      capturedAt: '2026-12-31T00:00:00.000Z',
      metrics: [{ key: 'tickets.opened', label: 'Tickets opened', value: 40, source: 'halo', category: 'operations' }],
    });

    // Generating the email draft stamps packageSentAt.
    await h.getEmailDraft('anp', '2026-Q4', null); // no origin header → no link, still stamps
    expect((await store.getQbr('anp', '2026-Q4'))?.packageSentAt).toBeTruthy();

    // A later status change (any other QBR writer) must NOT wipe the stamp.
    await h.putStatus('anp', '2026-Q4', 'narrative_approved');
    const after = await store.getQbr('anp', '2026-Q4');
    expect(after?.packageSentAt).toBeTruthy();
    expect(after?.status).toBe('narrative_approved');
  });

  it('qbr_due reminder fires once even after 300 later notifications', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await store.upsertClient({ id: 'dueco', name: 'Due Co', qbrEnabled: true });
    // Data present in the current quarter, nothing scheduled.
    const now = new Date();
    const { periodFor } = await import('@mashit/core');
    const period = periodFor(now).id;
    await store.putSnapshot({ clientId: 'dueco', period, capturedAt: now.toISOString(), metrics: [] });
    // Force the check into the final-month window by pinning "now" to quarter end.
    const qEnd = new Date(Date.parse(`${periodFor(now).end}T12:00:00Z`));

    h._resetDueCheck();
    await h.checkQbrDue(qEnd);
    let due = (await store.listNotifications(400)).filter((n) => n.dedupeKey === `qbr_due:dueco:${period}`);
    expect(due).toHaveLength(1);

    // Flood the bell with 300 unrelated notifications, then re-check.
    for (let i = 0; i < 300; i++) h.notify('report', `noise ${i}`);
    await new Promise((r) => setTimeout(r, 50));
    h._resetDueCheck();
    await h.checkQbrDue(qEnd);
    due = (await store.listNotifications(400)).filter((n) => n.dedupeKey === `qbr_due:dueco:${period}`);
    expect(due).toHaveLength(1); // still one — deduped on the QBR record, not a notification scan
  });
});
