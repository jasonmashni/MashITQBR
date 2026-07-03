import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';
import { toArray } from './util.js';

/**
 * Direct HaloPSA API client (replaces the MASH MCP path for Halo data).
 *
 * Auth is OAuth2 client_credentials against `{baseUrl}/auth/token` (Halo's
 * "API application" with a Client ID + Secret, scope `all`); data lives under
 * `{baseUrl}/api`. Unlike the MCP ticket tool, the direct /api/Tickets
 * endpoint accepts a date window (`datesearch` + `startdate`/`enddate`), so
 * quarterly ticket volumes finally work. Field names on list rows vary by
 * Halo version/config, so normalizers read tolerantly from candidate fields.
 */

export interface HaloCfg {
  /** Tenant base URL, e.g. https://mashit.halopsa.com */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Hosted instances sometimes require the tenant name on the token call. */
  tenant?: string;
  /**
   * Ticket-type ids to report on (from the connection's "Ticket types"
   * picker). Empty/absent = report on everything. When set, ticket tallies
   * are computed from rows filtered to these types.
   */
  ticketTypeIds?: string[];
}

type Json = Record<string, unknown>;

// Token cache per (baseUrl, clientId) so every sync doesn't re-exchange.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Exchange (and cache) an OAuth2 client_credentials token for this Halo instance. */
export async function haloToken(http: HttpTransport, cfg: HaloCfg): Promise<string> {
  const key = `${cfg.baseUrl}|${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/auth/token${cfg.tenant ? `?tenant=${encodeURIComponent(cfg.tenant)}` : ''}`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'all',
  }).toString();
  const res = await http.request({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const json = (res.json ?? {}) as Json;
  const token = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  if (res.status < 200 || res.status >= 300 || !token) {
    const detail = typeof json['error_description'] === 'string' ? json['error_description'] : typeof json['error'] === 'string' ? json['error'] : '';
    throw new Error(`Halo token exchange failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

/** Authenticated GET against `{baseUrl}/api/{path}` with query params. */
export async function haloGet(http: HttpTransport, cfg: HaloCfg, path: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
  const token = await haloToken(http, cfg);
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/${path}${qs ? `?${qs}` : ''}`;
  const res = await http.request({ method: 'GET', url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`Halo responded ${res.status} for /api/${path}`);
  return res.json;
}

/** Authenticated POST against `{baseUrl}/api/{path}` (Halo POSTs take arrays). */
export async function haloPost(http: HttpTransport, cfg: HaloCfg, path: string, payload: unknown): Promise<unknown> {
  const token = await haloToken(http, cfg);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/${path}`;
  const res = await http.request({
    method: 'POST',
    url,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Halo responded ${res.status} for /api/${path}`);
  return res.json;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const firstNum = (row: Json, keys: string[]): number | undefined => {
  for (const k of keys) {
    const n = num(row[k]);
    if (n !== undefined) return n;
  }
  return undefined;
};
const firstStr = (row: Json, keys: string[]): string | undefined => {
  for (const k of keys) if (typeof row[k] === 'string' && row[k]) return row[k] as string;
  return undefined;
};

/** record_count from a paginated Halo list response (falls back to row count). */
function recordCount(json: unknown, rows: unknown[]): number {
  const n = num((json as Json | null)?.['record_count']);
  return n !== undefined ? n : rows.length;
}

export interface HaloClientRow {
  id?: number | string;
  name?: string;
  client_name?: string;
  sector_name?: string;
  inactive?: boolean;
}

/** All clients in this Halo instance (drives import + org mapping). */
export async function listHaloClients(http: HttpTransport, cfg: HaloCfg): Promise<HaloClientRow[]> {
  const json = await haloGet(http, cfg, 'Client', { pageinate: false, count: 5000 });
  return toArray<HaloClientRow>(json, ['clients']).filter((c) => c.id !== undefined && c.inactive !== true);
}

/** Categorize a ticket row by its type name (mirrors the report's operations buckets). */
function ticketCategory(row: Json): string {
  const name = (firstStr(row, ['tickettype_name', 'type']) ?? ((row['tickettype'] as Json | undefined)?.['name'] as string | undefined) ?? '').toLowerCase();
  if (name.includes('incident')) return 'incident';
  if (name.includes('change')) return 'change';
  if (name.includes('service') || name.includes('request')) return 'service';
  if (name.includes('maintenance')) return 'maintenance';
  if (name.includes('problem')) return 'problem';
  return 'other';
}

/** Page a Halo list endpoint, returning all rows (capped) plus the true record_count. */
async function haloPageAll(
  http: HttpTransport,
  cfg: HaloCfg,
  path: string,
  params: Record<string, string | number | boolean>,
  rowsKey: string,
  maxPages = 5,
): Promise<{ rows: Json[]; total: number }> {
  const pageSize = 200;
  const rows: Json[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const json = await haloGet(http, cfg, path, { ...params, pageinate: true, page_size: pageSize, page_no: page });
    const pageRows = toArray<Json>(json, [rowsKey]);
    rows.push(...pageRows);
    if (page === 1) total = recordCount(json, pageRows);
    if (pageRows.length < pageSize || rows.length >= total) break;
  }
  return { rows, total: Math.max(total, rows.length) };
}

/** Fields that plausibly carry a recurring monthly amount on contract rows. */
const MRR_FIELDS = ['monthlyvalue', 'monthly_value', 'periodicbillingamount', 'periodic_billing_amount', 'monthlycharge', 'recurringvalue'];
/** Fields that plausibly carry an invoice total (net preferred over gross). */
const INVOICE_TOTAL_FIELDS = ['nettotal', 'net_total', 'total', 'totalprice', 'totalinctax'];
const INVOICE_DATE_FIELDS = ['invoicedate', 'invoice_date', 'date', 'datesent'];
/** Fields that plausibly carry an invoice line's net amount / category. */
const LINE_AMOUNT_FIELDS = ['net_amount', 'netamount', 'nettotal', 'line_total', 'linetotal', 'baseprice', 'price'];
const LINE_CATEGORY_FIELDS = [
  'item_group_name',
  'itemgroup_name',
  'item_group',
  'nominal_code_name',
  'nominalcode_name',
  'group_name',
  'category_name',
  'category',
];

/** The ticket-type id on a ticket row (shape varies by instance). */
function ticketTypeIdOf(row: Json): string | undefined {
  const v = row['tickettype_id'] ?? (row['tickettype'] as Json | undefined)?.['id'];
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * SLA outcome tally from ticket rows. Field names differ across Halo
 * versions, so scan sla-keyed string fields for met/breach wording; rows
 * with no recognizable SLA state are simply not counted. A ticket can carry
 * several SLA fields (response + resolution) — any breach makes the ticket
 * breached. Fields that name the SLA rather than its state (slaname) are
 * skipped so wording like "Respond within 4 hours" can't read as met.
 */
const SLA_BREACH_RE = /\b(breach\w*|late|miss\w*|fail\w*|overdue|unmet)\b|\bnot\s+(met|ok|achieved|within)/;
const SLA_MET_RE = /\b(met|ok|achieved?|within|pass(?:ed)?|on.?target)\b/;

export function tallyHaloSla(rows: Json[]): { met: number; breached: number } {
  let met = 0;
  let breached = 0;
  for (const row of rows) {
    let sawBreach = false;
    let sawMet = false;
    for (const [k, v] of Object.entries(row)) {
      if (!/sla/i.test(k) || /name|id$/i.test(k) || typeof v !== 'string' || !v) continue;
      const s = v.toLowerCase();
      if (SLA_BREACH_RE.test(s)) sawBreach = true;
      else if (SLA_MET_RE.test(s)) sawMet = true;
    }
    if (sawBreach) breached++;
    else if (sawMet) met++;
  }
  return { met, breached };
}

export interface HaloFinanceInput {
  contracts: Json[];
  invoices: Json[];
  periodStart: string; // inclusive ISO date
  periodEnd: string; // inclusive ISO date
}

/** Compute MRR (active recurring contracts) + in-quarter invoiced total. */
export function normalizeHaloFinance(input: HaloFinanceInput): { metrics: MetricValue[]; warnings: string[] } {
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];
  const spend = (k: string, l: string, v: number, higherIsBetter?: boolean) =>
    metric(k, l, Math.round(v * 100) / 100, { category: 'spend', source: 'halo', unit: 'USD', higherIsBetter });

  if (input.contracts.length > 0) {
    let mrr = 0;
    let recognized = 0;
    for (const c of input.contracts) {
      const v = firstNum(c, MRR_FIELDS);
      if (v !== undefined) {
        mrr += v;
        recognized++;
      }
    }
    if (recognized > 0) {
      metrics.push(spend('finance.mrr', 'Monthly recurring revenue', mrr));
      if (recognized < input.contracts.length) {
        warnings.push(`${input.contracts.length - recognized} Halo contract(s) had no recognizable monthly value field — MRR may be understated.`);
      }
    } else {
      warnings.push('Halo contracts carry no recognizable recurring monthly value field — MRR not computed (check contract billing setup).');
    }
  }

  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd) + 24 * 3600 * 1000; // inclusive end date
  let invoiced = 0;
  let counted = 0;
  let withLines = 0;
  const byCategory = new Map<string, number>();
  for (const inv of input.invoices) {
    const dateStr = firstStr(inv, INVOICE_DATE_FIELDS);
    const at = dateStr ? Date.parse(dateStr) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const total = firstNum(inv, INVOICE_TOTAL_FIELDS);
    if (total !== undefined) {
      invoiced += total;
      counted++;
    }
    // High-level breakdown from invoice lines (Managed Services,
    // Subscriptions, Software, …) — categories come from Halo's own groups.
    const lines = Array.isArray(inv['lines']) ? (inv['lines'] as Json[]) : [];
    if (lines.length > 0) withLines++;
    for (const line of lines) {
      const amount = firstNum(line, LINE_AMOUNT_FIELDS);
      if (amount === undefined || amount === 0) continue;
      const category = firstStr(line, LINE_CATEGORY_FIELDS) ?? 'Other';
      byCategory.set(category, (byCategory.get(category) ?? 0) + amount);
    }
  }
  if (counted > 0) metrics.push(spend('finance.quarter_invoiced', 'Invoiced this quarter (total)', invoiced));

  if (byCategory.size > 0) {
    // Top categories keep the breakdown executive-sized; the tail — together
    // with Halo's own catch-all group, if it has one — folds into one Other
    // entry, so the emitted categories always sum to the lines' total.
    const isOther = (name: string) => name.trim().toLowerCase() === 'other';
    const named = [...byCategory.entries()].filter(([n]) => !isOther(n)).sort((a, b) => b[1] - a[1]);
    const top = named.slice(0, 6);
    const other =
      named.slice(6).reduce((sum, [, v]) => sum + v, 0) +
      [...byCategory.entries()].filter(([n]) => isOther(n)).reduce((sum, [, v]) => sum + v, 0);
    if (other !== 0) top.push(['Other', other]);
    // Distinct group names can slug identically — merge so metric keys stay unique.
    const bySlug = new Map<string, { name: string; amount: number }>();
    for (const [name, amount] of top) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other';
      const prev = bySlug.get(slug);
      if (prev) prev.amount += amount;
      else bySlug.set(slug, { name, amount });
    }
    for (const [slug, { name, amount }] of bySlug) {
      metrics.push(spend(`finance.invoiced.${slug}`, `Invoiced — ${name}`, amount));
    }
  } else if (counted > 0) {
    warnings.push('Halo invoices carried no line items — the invoice breakdown needs line-level data (categories come from Halo item groups).');
  }
  if (withLines > 0 && withLines < counted) {
    warnings.push(`${counted - withLines} of ${counted} in-quarter invoices had no line items — the category breakdown may be partial.`);
  }

  return { metrics, warnings };
}

const TICKET_OPENED_FIELDS = ['dateoccurred', 'dateoccured', 'datecreated', 'date_occurred'];
const TICKET_CLOSED_FIELDS = ['dateclosed', 'date_closed', 'closedate'];

function inPeriod(row: Json, fields: string[], startMs: number, endMs: number): boolean {
  const s = firstStr(row, fields);
  const at = s ? Date.parse(s) : NaN;
  return Number.isFinite(at) && at >= startMs && at < endMs;
}

/** True only when the row carries a parseable date that is clearly outside the window. */
function outsidePeriod(row: Json, fields: string[], startMs: number, endMs: number): boolean {
  const s = firstStr(row, fields);
  const at = s ? Date.parse(s) : NaN;
  return Number.isFinite(at) && (at < startMs || at >= endMs);
}

/** Per-Halo-client-id ticket + finance tallies for one period. */
async function collectHaloForId(
  ctx: CollectorContext,
  http: HttpTransport,
  cfg: HaloCfg,
  haloId: string,
  warnings: string[],
  tag: string,
): Promise<{ ok: boolean; openedRows: Json[]; openedTotal: number; closed: number; open: number; contracts: Json[]; invoices: Json[] }> {
  const startMs = Date.parse(ctx.period.start);
  const endMs = Date.parse(ctx.period.end) + 24 * 3600 * 1000;
  const allowedTypes = cfg.ticketTypeIds?.length ? new Set(cfg.ticketTypeIds.map(String)) : undefined;
  const typeMatch = (r: Json) => {
    if (!allowedTypes) return true;
    const t = ticketTypeIdOf(r);
    return t !== undefined && allowedTypes.has(t);
  };
  let ok = false;
  let openedRows: Json[] = [];
  let openedTotal = 0;
  let closed = 0;

  // With a ticket-type allowlist, server-side record counts can't be used —
  // pull the period's rows via the server date window and tally locally
  // (types, SLA all from rows). A "recent tickets" pull is only the fallback
  // for instances that ignore datesearch: busy clients have more history
  // than any sane page cap, so recency alone can miss the quarter entirely.
  if (allowedTypes) {
    let filterUsable = true;
    try {
      const openedPull = await haloPageAll(http, cfg, 'Tickets', {
        client_id: haloId,
        datesearch: 'dateoccurred',
        startdate: ctx.period.start,
        enddate: ctx.period.end,
      }, 'tickets', 10);
      // Trust the server window, but drop rows whose parseable date clearly
      // falls outside it (rows without a recognizable date field stay).
      let openedAll = openedPull.rows.filter((r) => !outsidePeriod(r, TICKET_OPENED_FIELDS, startMs, endMs));
      let closedAll: Json[] = [];
      let sampledNote: string | undefined;

      if (openedPull.rows.length === 0) {
        // Some Halo versions ignore datesearch (returning nothing) — verify
        // against the unfiltered count and fall back to recent tickets.
        const probe = await haloGet(http, cfg, 'Tickets', { client_id: haloId, open_only: false, pageinate: true, page_size: 1, page_no: 1 });
        const totalTickets = recordCount(probe, toArray(probe, ['tickets']));
        if (totalTickets > 0) {
          const all = await haloPageAll(http, cfg, 'Tickets', { client_id: haloId, open_only: false, order: 'dateoccurred', orderdesc: true }, 'tickets', 10);
          openedAll = all.rows.filter((r) => inPeriod(r, TICKET_OPENED_FIELDS, startMs, endMs));
          closedAll = all.rows.filter((r) => inPeriod(r, TICKET_CLOSED_FIELDS, startMs, endMs));
          if (all.rows.length < all.total) {
            sampledNote = `Halo${tag}: the server date filter returned nothing — type-filtered tallies counted from the most recent ${all.rows.length} of ${all.total} tickets.`;
          }
        }
      } else {
        if (openedPull.rows.length < openedPull.total) {
          sampledNote = `Halo${tag}: type-filtered tallies counted from the first ${openedPull.rows.length} of ${openedPull.total} in-period tickets.`;
        }
        const closedPull = await haloPageAll(http, cfg, 'Tickets', {
          client_id: haloId,
          datesearch: 'dateclosed',
          startdate: ctx.period.start,
          enddate: ctx.period.end,
        }, 'tickets', 10);
        closedAll = closedPull.rows.filter((r) => !outsidePeriod(r, TICKET_CLOSED_FIELDS, startMs, endMs));
      }

      const sample = [...openedAll, ...closedAll];
      if (sample.length > 0 && !sample.some((r) => ticketTypeIdOf(r) !== undefined)) {
        // This instance's list rows don't expose a type id — filtered tallies
        // would read as a quarter of zeros. Report unavailable instead.
        filterUsable = false;
        warnings.push(
          `Halo${tag}: ticket rows carry no ticket-type id, so the connection's ticket-type filter can't be applied — ticket metrics skipped (clear the filter to report on all tickets).`,
        );
      } else {
        ok = true;
        openedRows = openedAll.filter(typeMatch);
        openedTotal = openedRows.length;
        closed = closedAll.filter(typeMatch).length;
        if (sampledNote) warnings.push(sampledNote);
      }
    } catch (e) {
      filterUsable = false;
      warnings.push(`Halo${tag} ticket volume unavailable: ${e instanceof Error ? e.message : 'error'}`);
    }
    return withFinance(filterUsable);
  }

  // Tickets opened in the period via the server-side date window.
  try {
    const opened = await haloPageAll(http, cfg, 'Tickets', {
      client_id: haloId,
      datesearch: 'dateoccurred',
      startdate: ctx.period.start,
      enddate: ctx.period.end,
    }, 'tickets');
    ok = true;
    openedRows = opened.rows;
    openedTotal = opened.total;

    if (opened.total === 0) {
      // Some Halo versions ignore datesearch — verify against the unfiltered
      // count and fall back to filtering recent tickets locally.
      const probe = await haloGet(http, cfg, 'Tickets', { client_id: haloId, open_only: false, pageinate: true, page_size: 1, page_no: 1 });
      const totalTickets = recordCount(probe, toArray(probe, ['tickets']));
      if (totalTickets > 0) {
        const all = await haloPageAll(http, cfg, 'Tickets', { client_id: haloId, open_only: false, order: 'dateoccurred', orderdesc: true }, 'tickets', 10);
        openedRows = all.rows.filter((r) => inPeriod(r, TICKET_OPENED_FIELDS, startMs, endMs));
        openedTotal = openedRows.length;
        closed = all.rows.filter((r) => inPeriod(r, TICKET_CLOSED_FIELDS, startMs, endMs)).length;
        if (all.rows.length < all.total) {
          warnings.push(`Halo${tag}: the server date filter returned nothing — counted from the most recent ${all.rows.length} of ${all.total} tickets instead.`);
        }
        return await withFinance();
      }
    }
  } catch (e) {
    warnings.push(`Halo${tag} ticket volume unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Tickets closed in the period.
  try {
    const res = await haloGet(http, cfg, 'Tickets', {
      client_id: haloId,
      datesearch: 'dateclosed',
      startdate: ctx.period.start,
      enddate: ctx.period.end,
      pageinate: true,
      page_size: 1,
      page_no: 1,
    });
    closed = recordCount(res, toArray(res, ['tickets']));
  } catch (e) {
    warnings.push(`Halo${tag} closed-ticket count unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }
  return withFinance();

  async function withFinance(includeOpenSnapshot = true) {
    let open = 0;
    if (includeOpenSnapshot) {
      try {
        if (allowedTypes) {
          // Type filter needs rows, not the server count.
          const openAll = await haloPageAll(http, cfg, 'Tickets', { client_id: haloId, open_only: true }, 'tickets', 3);
          open = openAll.rows.filter(typeMatch).length;
          if (openAll.rows.length < openAll.total) {
            warnings.push(`Halo${tag}: open-ticket snapshot filtered from the first ${openAll.rows.length} of ${openAll.total} open tickets.`);
          }
        } else {
          const res = await haloGet(http, cfg, 'Tickets', { client_id: haloId, open_only: true, pageinate: true, page_size: 1, page_no: 1 });
          open = recordCount(res, toArray(res, ['tickets']));
        }
        ok = true;
      } catch (e) {
        warnings.push(`Halo${tag} open-ticket snapshot unavailable: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    let contracts: Json[] = [];
    let invoices: Json[] = [];
    try {
      contracts = (await haloPageAll(http, cfg, 'ClientContract', { client_id: haloId }, 'contracts')).rows;
    } catch (e) {
      warnings.push(`Halo${tag} contracts unavailable (MRR skipped): ${e instanceof Error ? e.message : 'error'}`);
    }
    try {
      // includelines feeds the invoice category breakdown.
      invoices = (await haloPageAll(http, cfg, 'Invoice', { client_id: haloId, includelines: true }, 'invoices')).rows;
    } catch (e) {
      warnings.push(`Halo${tag} invoices unavailable (quarterly spend skipped): ${e instanceof Error ? e.message : 'error'}`);
    }
    return { ok, openedRows, openedTotal, closed, open, contracts, invoices };
  }
}

/**
 * Collect Halo metrics for a client/period straight from the Halo API:
 * ticket volumes with a real date window (client-side fallback when the
 * server ignores it), the open-ticket snapshot, and the finance figures
 * (MRR + in-quarter invoiced) that power the admin dashboard.
 *
 * The mapping may be a comma-separated list of Halo client ids — some
 * clients split into a service entity and a billing entity (e.g. tickets
 * under one id, invoices under another) — and the tallies are summed.
 */
export async function collectHaloDirect(ctx: CollectorContext, http: HttpTransport, cfg: HaloCfg): Promise<CollectResult> {
  const ids = (ctx.externalRef ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { source: 'halo', metrics: [], warnings: ['No Halo client mapped for this client.'] };
  }
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];
  const op = (k: string, l: string, v: number, higherIsBetter?: boolean) =>
    metric(k, l, v, { category: 'operations', source: 'halo', unit: 'count', higherIsBetter });

  const openedRows: Json[] = [];
  let openedTotal = 0;
  let closed = 0;
  let open = 0;
  let anyTicketData = false;
  const contracts: Json[] = [];
  const invoices: Json[] = [];
  for (const haloId of ids) {
    const tag = ids.length > 1 ? ` [${haloId}]` : '';
    const t = await collectHaloForId(ctx, http, cfg, haloId, warnings, tag);
    anyTicketData ||= t.ok;
    openedRows.push(...t.openedRows);
    openedTotal += t.openedTotal;
    closed += t.closed;
    open += t.open;
    contracts.push(...t.contracts);
    invoices.push(...t.invoices);
  }

  // Emit ticket tallies only when the API actually answered — a hard failure
  // must read as "unavailable" in the warnings, not as a quarter of zeros.
  if (anyTicketData) {
    metrics.push(op('tickets.total', 'Tickets opened', openedTotal, false));
    const counts = new Map<string, number>();
    for (const row of openedRows) counts.set(ticketCategory(row), (counts.get(ticketCategory(row)) ?? 0) + 1);
    if (openedRows.length > 0) {
      metrics.push(
        op('tickets.incidents', 'Incidents', counts.get('incident') ?? 0, false),
        op('tickets.changes', 'Change requests', counts.get('change') ?? 0),
        op('tickets.service', 'Service requests', counts.get('service') ?? 0),
      );
      if (openedRows.length < openedTotal) {
        warnings.push(`Ticket by-type breakdown sampled from the first ${openedRows.length} of ${openedTotal} tickets.`);
      }
    }
    metrics.push(op('tickets.closed', 'Tickets closed', closed, true));
    metrics.push(op('tickets.open', 'Open tickets', open, false));

    // SLA outcomes from the period's ticket rows (field names vary — see tallyHaloSla).
    const sla = tallyHaloSla(openedRows);
    if (sla.met + sla.breached > 0) {
      metrics.push(
        metric('sla.met_pct', 'SLA met', Math.round((1000 * sla.met) / (sla.met + sla.breached)) / 10, {
          category: 'operations',
          source: 'halo',
          unit: '%',
          higherIsBetter: true,
        }),
      );
      if (sla.breached > 0) metrics.push(op('sla.breaches', 'SLA breaches', sla.breached, false));
    } else if (openedRows.length > 0) {
      warnings.push('Halo ticket rows carry no recognizable SLA state field — SLA reporting needs tuning against this instance.');
    }
  }

  const finance = normalizeHaloFinance({ contracts, invoices, periodStart: ctx.period.start, periodEnd: ctx.period.end });
  metrics.push(...finance.metrics);
  warnings.push(...finance.warnings);

  return { source: 'halo', metrics, warnings };
}

// ── Ticket push (full field control) ─────────────────────────────────────────

export interface HaloIdName {
  id: string;
  name: string;
}

export interface HaloMeta {
  ticketTypes: HaloIdName[];
  agents: HaloIdName[];
  teams: HaloIdName[];
  priorities: HaloIdName[];
}

function idNames(json: unknown, keys: string[]): HaloIdName[] {
  return toArray<Json>(json, keys)
    .filter((r) => r['id'] !== undefined)
    .map((r) => ({ id: String(r['id']), name: firstStr(r, ['name', 'summary', 'use']) ?? String(r['id']) }));
}

/** Lookup lists for the push-ticket modal (types, agents, teams, priorities). */
export async function fetchHaloMeta(http: HttpTransport, cfg: HaloCfg): Promise<HaloMeta> {
  const [types, agents, teams, priorities] = await Promise.all([
    haloGet(http, cfg, 'TicketType', {}).catch(() => []),
    haloGet(http, cfg, 'Agent', {}).catch(() => []),
    haloGet(http, cfg, 'Team', {}).catch(() => []),
    haloGet(http, cfg, 'Priority', {}).catch(() => []),
  ]);
  return {
    ticketTypes: idNames(types, ['tickettypes']),
    agents: idNames(agents, ['agents']),
    teams: idNames(teams, ['teams']),
    priorities: idNames(priorities, ['priorities']),
  };
}

export interface HaloTicketInput {
  summary: string;
  details: string;
  clientId?: string;
  ticketTypeId?: string;
  agentId?: string;
  team?: string;
  priorityId?: string;
}

/** Create a Halo ticket with full field control. POST /api/Tickets takes an array. */
export async function createHaloTicket(http: HttpTransport, cfg: HaloCfg, input: HaloTicketInput): Promise<{ id: string; status?: string }> {
  const ticket: Json = { summary: input.summary, details: input.details };
  if (input.clientId) ticket['client_id'] = Number.isFinite(Number(input.clientId)) ? Number(input.clientId) : input.clientId;
  if (input.ticketTypeId) ticket['tickettype_id'] = Number(input.ticketTypeId);
  if (input.agentId) ticket['agent_id'] = Number(input.agentId);
  if (input.team) ticket['team'] = input.team;
  if (input.priorityId) ticket['priority_id'] = Number(input.priorityId);

  const json = await haloPost(http, cfg, 'Tickets', [ticket]);
  const created = Array.isArray(json) ? (json[0] as Json | undefined) : (json as Json | null) ?? undefined;
  const id = created?.['id'];
  if (id === undefined || id === null) throw new Error('Halo ticket creation returned no id.');
  const status = firstStr(created!, ['status_name', 'status']) ?? (num(created!['status_id']) !== undefined ? `status ${String(created!['status_id'])}` : undefined);
  return { id: String(id), status };
}
