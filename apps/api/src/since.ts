import { previousPeriod, SINCE_OVERRIDE_STATUSES, type DiscussionItem, type SinceOverride, type SinceOverrideStatus } from '@mashit/core';
import { sinceLastRows } from '@mashit/report';
import type { ApiResult } from './handlers.js';
import { getDataStore, getSecretStore } from './store/index.js';

/** Longest close-out note, after trimming. */
export const SINCE_NOTE_MAX = 200;

/** The answer when last quarter's discussion cannot be read. */
export const PREVIOUS_UNREADABLE = 'Last quarter could not be read; try again.';
export const previousUnreadable = (): ApiResult => ({ status: 503, json: { error: PREVIOUS_UNREADABLE } });

/**
 * Last quarter's items that can be read (older stored items may lack a
 * topic). A store read failure throws: callers must not mistake it for an
 * empty agenda and prune or refuse on that basis.
 */
export async function previousItems(clientId: string, period: string): Promise<DiscussionItem[]> {
  const prev = await getDataStore().getDiscussion(clientId, previousPeriod(period).id);
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
  let previous: DiscussionItem[];
  try {
    previous = await previousItems(clientId, period);
  } catch {
    return previousUnreadable();
  }
  const current = await store.getDiscussion(clientId, period);
  let ticketStatuses: Record<string, string> | undefined;
  if (previous.some((i) => i.externalRef?.system === 'halo')) {
    const service = await import('./service.js');
    const lookup = await service.haloTicketStatusLookup(store, getSecretStore()).catch(() => undefined);
    ticketStatuses = await service.liveTicketStatuses(previous, lookup);
  }
  return { status: 200, json: { rows: sinceLastRows(previous, ticketStatuses, current?.sinceOverrides) } };
}

type Normalized = { ok: true; value: Record<string, SinceOverride> } | { ok: false; error: string; status?: 503 };

const own = (o: object | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Validate a body's sinceOverrides against last quarter's item ids. The
 * status must be one of the four close-outs; a note is trimmed, at most
 * SINCE_NOTE_MAX characters, and dropped when empty. `at` and `by` are always
 * stamped here; an unchanged override keeps its stored stamp. A key that is
 * no longer on last quarter's agenda but matches what is stored (the client
 * echoing a stale entry) is pruned silently; any other unknown key is refused.
 * The result has a null prototype. With `previous` null (last quarter could
 * not be read) nothing is pruned: keys already stored are accepted and a new
 * key is refused with a 503.
 */
export async function normalizeSinceOverrides(
  clientId: string,
  period: string,
  raw: unknown,
  stored: Record<string, SinceOverride> | undefined,
  actor: string,
  now: string,
  previous?: DiscussionItem[] | null,
): Promise<Normalized> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'sinceOverrides must be an object keyed by last quarter item id.' };
  const items = previous === undefined ? await previousItems(clientId, period) : previous;
  const ids = items ? new Set(items.map((i) => i.id)) : undefined;
  const out = Object.create(null) as Record<string, SinceOverride>;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `sinceOverrides.${id} must be an object.` };
    const r = v as Record<string, unknown>;
    if (!(SINCE_OVERRIDE_STATUSES as readonly unknown[]).includes(r['status'])) {
      return { ok: false, error: `sinceOverrides.${id}.status must be one of ${SINCE_OVERRIDE_STATUSES.join(', ')}.` };
    }
    if (r['note'] !== undefined && typeof r['note'] !== 'string') return { ok: false, error: `sinceOverrides.${id}.note must be text.` };
    const note = typeof r['note'] === 'string' ? r['note'].trim() : '';
    const status = r['status'] as SinceOverrideStatus;
    const prior = own(stored, id) ? stored![id] : undefined;
    const unchanged = !!prior && prior.status === status && (prior.note ?? '') === note;
    if (!ids) {
      if (!own(stored, id)) return { ok: false, error: PREVIOUS_UNREADABLE, status: 503 };
    } else if (!ids.has(id)) {
      if (unchanged) continue;
      return { ok: false, error: `sinceOverrides names ${id}, which is not on last quarter's agenda.` };
    }
    if (note.length > SINCE_NOTE_MAX) return { ok: false, error: `sinceOverrides.${id}.note is longer than ${SINCE_NOTE_MAX} characters.` };
    out[id] = unchanged ? prior! : { status, ...(note ? { note } : {}), at: now, by: actor };
  }
  return { ok: true, value: out };
}

/** The stored overrides whose keys are still on last quarter's agenda (null prototype). */
export function prunedOverrides(stored: Record<string, SinceOverride> | undefined, previous: DiscussionItem[]): Record<string, SinceOverride> | undefined {
  if (!stored) return undefined;
  const ids = new Set(previous.map((i) => i.id));
  const out = Object.create(null) as Record<string, SinceOverride>;
  for (const [id, v] of Object.entries(stored)) if (ids.has(id)) out[id] = v;
  return out;
}

/** True when two override maps say the same thing (stamps included). */
export function sameOverrides(a: Record<string, SinceOverride> | undefined, b: Record<string, SinceOverride> | undefined): boolean {
  return JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
}
