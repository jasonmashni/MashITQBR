import { previousPeriod, SINCE_OVERRIDE_STATUSES, type DiscussionItem, type SinceOverride, type SinceOverrideStatus } from '@mashit/core';
import { sinceLastRows } from '@mashit/report';
import type { ApiResult } from './handlers.js';
import { getDataStore, getSecretStore } from './store/index.js';

/** Longest close-out note, after trimming. */
export const SINCE_NOTE_MAX = 200;

/** Last quarter's items that can be read (older stored items may lack a topic). */
async function previousItems(clientId: string, period: string): Promise<DiscussionItem[]> {
  const prev = await getDataStore()
    .getDiscussion(clientId, previousPeriod(period).id)
    .catch(() => undefined);
  return (prev?.items ?? []).filter((i) => typeof i?.id === 'string' && typeof i?.topic === 'string' && i.topic.trim().length > 0);
}

/**
 * GET .../qbr/{period}/since: last quarter's reportable items (the report's
 * selection and order, at most five) with the computed status, this
 * quarter's close-out and the status the report prints. showSinceLastQuarter
 * only hides the block on the report, not this list. Pushed Halo tickets use
 * the live status when a direct Halo connection answers, else the stored one.
 */
export async function getSince(clientId: string, period: string): Promise<ApiResult> {
  const store = getDataStore();
  const previous = await previousItems(clientId, period);
  const current = await store.getDiscussion(clientId, period);
  let ticketStatuses: Record<string, string> | undefined;
  if (previous.some((i) => i.externalRef?.system === 'halo')) {
    const service = await import('./service.js');
    const lookup = await service.haloTicketStatusLookup(store, getSecretStore()).catch(() => undefined);
    ticketStatuses = await service.liveTicketStatuses(previous, lookup);
  }
  return { status: 200, json: { rows: sinceLastRows(previous, ticketStatuses, current?.sinceOverrides) } };
}

type Normalized = { ok: true; value: Record<string, SinceOverride> } | { ok: false; error: string };

/**
 * Validate a body's sinceOverrides against last quarter's item ids. The
 * status must be one of the four close-outs; a note is trimmed, at most
 * SINCE_NOTE_MAX characters, and dropped when empty. `at` and `by` are always
 * stamped here; an unchanged override keeps its stored stamp.
 */
export async function normalizeSinceOverrides(
  clientId: string,
  period: string,
  raw: unknown,
  stored: Record<string, SinceOverride> | undefined,
  actor: string,
  now: string,
): Promise<Normalized> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'sinceOverrides must be an object keyed by last quarter item id.' };
  const ids = new Set((await previousItems(clientId, period)).map((i) => i.id));
  const out: Record<string, SinceOverride> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id)) return { ok: false, error: `sinceOverrides names ${id}, which is not on last quarter's agenda.` };
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `sinceOverrides.${id} must be an object.` };
    const r = v as Record<string, unknown>;
    if (!(SINCE_OVERRIDE_STATUSES as readonly unknown[]).includes(r['status'])) {
      return { ok: false, error: `sinceOverrides.${id}.status must be one of ${SINCE_OVERRIDE_STATUSES.join(', ')}.` };
    }
    if (r['note'] !== undefined && typeof r['note'] !== 'string') return { ok: false, error: `sinceOverrides.${id}.note must be text.` };
    const note = typeof r['note'] === 'string' ? r['note'].trim() : '';
    if (note.length > SINCE_NOTE_MAX) return { ok: false, error: `sinceOverrides.${id}.note is longer than ${SINCE_NOTE_MAX} characters.` };
    const status = r['status'] as SinceOverrideStatus;
    const prior = stored?.[id];
    if (prior && prior.status === status && (prior.note ?? '') === note) {
      out[id] = prior;
      continue;
    }
    out[id] = { status, ...(note ? { note } : {}), at: now, by: actor };
  }
  return { ok: true, value: out };
}

/** True when two override maps say the same thing (stamps included). */
export function sameOverrides(a: Record<string, SinceOverride> | undefined, b: Record<string, SinceOverride> | undefined): boolean {
  return JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
}
