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

// The /api/Item catalog is instance-wide and changes rarely — cache it an
// hour so a multi-client sync fetches it once.
const itemCatalogCache = new Map<string, { at: number; items: Json[] }>();
async function listHaloItemsCached(http: HttpTransport, cfg: HaloCfg): Promise<Json[]> {
  const hit = itemCatalogCache.get(cfg.baseUrl);
  if (hit && Date.now() - hit.at < 3600_000) return hit.items;
  const { rows } = await haloPageAll(http, cfg, 'Item', {}, 'items', 10);
  itemCatalogCache.set(cfg.baseUrl, { at: Date.now(), items: rows });
  return rows;
}

/**
 * An ITIL-ish class for a Halo ticket type. Automated RMM/security alerts
 * (Ninja/Huntress/vulnerability/O365/CIPP…) are separated from human
 * service-desk work so the QBR headline reflects real support volume, not the
 * noise the MSP quietly absorbs.
 */
export type ItilClass = 'incident' | 'service_request' | 'change' | 'problem' | 'alert' | 'maintenance' | 'other';

/** The classes that count as human service-desk work (the QBR ticket headline). */
export const SERVICE_DESK_CLASSES: ReadonlySet<ItilClass> = new Set(['incident', 'service_request', 'change', 'problem']);

/**
 * Classify a Halo ticket type by its NAME. Order matters: automated-alert
 * wording is checked first because several alert types also contain other
 * keywords (e.g. "Vulnerability Alert"). Verified against the real Mash IT
 * Halo taxonomy (Ninja Alert, O365 MDR Alert, Security Detection, Incident,
 * Service Request, Change Request, Problem, Maintenance - Patching…).
 */
export function classifyTicketType(typeName: string | undefined): ItilClass {
  const n = (typeName ?? '').toLowerCase().trim();
  if (!n) return 'other';
  if (/\balert\b|detection|vulnerabilit/.test(n)) return 'alert';
  if (/\bproblem\b/.test(n)) return 'problem';
  if (/\bchange\b/.test(n)) return 'change';
  if (/\bincident\b/.test(n)) return 'incident';
  if (/request|inquir|question/.test(n)) return 'service_request';
  if (/maintenance|patch/.test(n)) return 'maintenance';
  return 'other';
}

// Ticket-type id→name map is instance-wide and rarely changes — cache it an
// hour so a multi-client sync fetches /api/TicketType once.
const ticketTypeCache = new Map<string, { at: number; map: Map<string, string> }>();
export async function fetchTicketTypeMap(http: HttpTransport, cfg: HaloCfg): Promise<Map<string, string>> {
  const hit = ticketTypeCache.get(cfg.baseUrl);
  if (hit && Date.now() - hit.at < 3600_000) return hit.map;
  const map = new Map<string, string>();
  try {
    const json = await haloGet(http, cfg, 'TicketType', {});
    for (const t of toArray<Json>(json, ['tickettypes'])) {
      const id = t['id'];
      const name = firstStr(t, ['name']);
      if (id !== undefined && id !== null && name) map.set(String(id), name);
    }
  } catch {
    // Tolerated — a ticket row's own tickettype_name (when present) still classifies it.
  }
  ticketTypeCache.set(cfg.baseUrl, { at: Date.now(), map });
  return map;
}

/** A ticket row's type name: its own field, else the instance type map by id. */
function ticketTypeName(row: Json, typeMap: Map<string, string>): string | undefined {
  const onRow = firstStr(row, ['tickettype_name', 'type']) ?? ((row['tickettype'] as Json | undefined)?.['name'] as string | undefined);
  if (onRow) return onRow;
  const id = ticketTypeIdOf(row);
  return id !== undefined ? typeMap.get(id) : undefined;
}

/** The ITIL class of a ticket row, resolving its type name first. */
function ticketClass(row: Json, typeMap: Map<string, string>): ItilClass {
  return classifyTicketType(ticketTypeName(row, typeMap));
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
  let lastFirstId: unknown;
  for (let page = 1; page <= maxPages; page++) {
    const json = await haloGet(http, cfg, path, { ...params, pageinate: true, page_size: pageSize, page_no: page });
    const pageRows = toArray<Json>(json, [rowsKey]);
    // Guard against servers that ignore page_no (same page forever) — that
    // would silently multiply every tally.
    const firstId = pageRows[0]?.['id'];
    if (page > 1 && firstId !== undefined && firstId === lastFirstId) break;
    lastFirstId = firstId;
    rows.push(...pageRows);
    if (page === 1) total = recordCount(json, pageRows);
    // Keep paging until record_count is reached — instances cap page_size
    // (some serve 100 even when 200 is requested), so a short page does NOT
    // mean the list is finished.
    if (pageRows.length === 0 || rows.length >= total) break;
  }
  return { rows, total: Math.max(total, rows.length) };
}

/** Fields that plausibly carry a recurring monthly amount on contract rows. */
const MRR_FIELDS = ['monthlyvalue', 'monthly_value', 'periodicbillingamount', 'periodic_billing_amount', 'monthlycharge', 'recurringvalue'];
/** Contract end/renewal date fields (varies by Halo instance). */
const END_DATE_FIELDS = ['enddate', 'end_date', 'expirydate', 'expiry_date', 'contractenddate', 'contract_end_date', 'renewaldate', 'renewal_date'];
/** Contracts ending within this many days of the quarter close are "up for renewal". */
const RENEWAL_WINDOW_DAYS = 90;

/** First parseable date field → 'YYYY-MM-DD', else undefined. */
const firstDate = (row: Json, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
    }
  }
  return undefined;
};
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
  'groupname',
  'category_name',
  'category',
];
/** Nested objects on item/line rows that may carry the group as {name}. */
const NESTED_GROUP_KEYS = ['group', 'itemgroup', 'item_group'];
/** Human labels on item catalog rows / contract items. */
const ITEM_NAME_FIELDS = ['name', 'description', 'shortdescription', 'item_shortdescription', 'summary'];
/** Line fields referencing the catalog item. */
const LINE_ITEM_ID_FIELDS = ['item_id', 'itemid', 'iid'];
/** Description-ish fallbacks when neither a group nor a catalog item resolves. */
const LINE_DESCRIPTION_FIELDS = ['description', 'item_shortdescription', 'shortdescription', 'longdescription', 'item_description', 'item_code', 'itemcode'];

/** A group/category label from a row's own fields (direct or nested). */
function groupNameOf(row: Json): string | undefined {
  const direct = firstStr(row, LINE_CATEGORY_FIELDS);
  if (direct) return direct;
  for (const k of NESTED_GROUP_KEYS) {
    const nested = row[k];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const name = firstStr(nested as Json, ['name', 'description']);
      if (name) return name;
    }
  }
  return undefined;
}

export interface HaloItemInfo {
  group?: string;
  name?: string;
}

/** Index the /api/Item catalog so invoice/contract lines can resolve their item's group. */
export function buildHaloItemIndex(items: Json[]): Map<string, HaloItemInfo> {
  const index = new Map<string, HaloItemInfo>();
  for (const it of items) {
    const id = it['id'];
    if (id === undefined || id === null) continue;
    index.set(String(id), { group: groupNameOf(it), name: firstStr(it, ITEM_NAME_FIELDS) });
  }
  return index;
}

/**
 * Reduce a billing-line description to its category: strip per-instance
 * suffixes — ticket references ("- ID: 0054251 - Summary: …"), billing-period
 * date ranges ("2/20/2026 - 3/19/2026"), trailing reference numbers — so
 * "Managed Workstation - Windows PC 2/20/2026 - 3/19/2026" and next month's
 * line land in the SAME "Managed Workstation - Windows PC" bucket.
 */
export function categoryFromDescription(desc: string): string {
  const cleaned = desc
    .replace(/\s*[-–—]\s*ID:\s*\S+.*$/i, '')
    .replace(/\s*[-–—]\s*Summary:.*$/i, '')
    .replace(/\s*[-–—]?\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*(?:[-–—]|to)\s*\d{1,2}\/\d{1,2}\/\d{2,4}.*$/, '')
    .replace(/\s*[-–—]\s*\d{4,}\s*$/, '')
    .trim();
  return cleaned || desc;
}

/**
 * The high-level category for one invoice/contract line: its own group
 * fields, else the referenced catalog item's group (falling back to the item
 * name), else the line's description (normalized — see
 * categoryFromDescription). Undefined = nothing recognizable.
 */
function lineCategory(line: Json, itemIndex: Map<string, HaloItemInfo>): string | undefined {
  const own = groupNameOf(line);
  if (own) return own;
  const itemRef = line['item'];
  if (itemRef && typeof itemRef === 'object' && !Array.isArray(itemRef)) {
    const fromRef = groupNameOf(itemRef as Json) ?? firstStr(itemRef as Json, ITEM_NAME_FIELDS);
    if (fromRef) return fromRef;
  }
  for (const k of LINE_ITEM_ID_FIELDS) {
    const v = line[k];
    if (v === undefined || v === null || v === '' || v === 0) continue;
    const info = itemIndex.get(String(v));
    if (info?.group) return info.group;
    if (info?.name) return info.name;
  }
  const desc = firstStr(line, LINE_DESCRIPTION_FIELDS);
  return desc ? categoryFromDescription(desc) : undefined;
}

/** Drill-down rows are capped so snapshots stay storage-friendly. */
const DETAIL_CAP = 100;
type DetailRow = Record<string, string | number>;
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Executive-size a category map: top N by value, the rest folded into one Other. */
function foldCategories(byCategory: Map<string, number>, topN: number): Array<[string, number]> {
  const isOther = (n: string) => n.trim().toLowerCase() === 'other';
  const named = [...byCategory.entries()].filter(([n]) => !isOther(n)).sort((a, b) => b[1] - a[1]);
  const top = named.slice(0, topN);
  const other =
    named.slice(topN).reduce((sum, [, v]) => sum + v, 0) +
    [...byCategory.entries()].filter(([n]) => isOther(n)).reduce((sum, [, v]) => sum + v, 0);
  if (other !== 0) top.push(['Other', other]);
  return top;
}

/** Where a Halo contract detail hides its recurring line items (varies by version). */
const CONTRACT_ITEMS_KEYS = [
  'items',
  'periodicitems',
  'periodic_items',
  'periodiccharges',
  'periodic_charges',
  'recurringitems',
  'recurringinvoiceitems',
  'billingitems',
  'charges',
  'lines',
  'details',
];

/** The first plausible recurring-items array on a contract detail. */
export function extractContractItems(detail: Json): Json[] {
  for (const k of CONTRACT_ITEMS_KEYS) {
    const v = detail[k];
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
      return v as Json[];
    }
  }
  return [];
}

/** Fields that already carry a monthly TOTAL for a contract item (no qty multiply). */
const RECURRING_TOTAL_FIELDS = ['monthlyprice', 'monthly_price', 'monthlyvalue', 'monthly_value', 'monthlycharge'];
/** Unit-price fields (multiplied by quantity when present). */
const RECURRING_UNIT_FIELDS = ['accountsprice', 'price', 'unitprice', 'unit_price', 'baseprice', 'net_amount', 'amount', 'value'];
const QTY_FIELDS = ['quantity', 'qty', 'count', 'units', 'qty_order'];

/** The ticket-type id on a ticket row (shape varies by instance). */
function ticketTypeIdOf(row: Json): string | undefined {
  const v = row['tickettype_id'] ?? (row['tickettype'] as Json | undefined)?.['id'];
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * SLA outcome tally from ticket rows. Two strategies, best first:
 *
 *  1. DATES — the reliable path: compare each SLA deadline (respond-by / fix-by)
 *     against the actual (first response / close). A ticket is breached if it
 *     answered/closed after a deadline; met if it beat every deadline it has.
 *     This is how Halo itself scores SLAs and doesn't depend on a text field.
 *  2. TEXT — fallback for instances that surface an explicit state string.
 *     Fields that NAME the SLA (slaname) are skipped so "Respond within 4
 *     hours" can't read as met.
 *
 * When neither works, `seenKeys` names the SLA/deadline-ish fields the rows DID
 * carry so the collector can say exactly what to tune for this instance.
 */
const SLA_RESPOND_DEADLINE = ['respondbydate', 'respond_by_date', 'slaresponsedate', 'targetdate', 'responsetargetdate'];
const SLA_RESPONDED = ['dateresponded', 'responddate', 'date_responded', 'firstresponsedate'];
const SLA_FIX_DEADLINE = ['fixbydate', 'fix_by_date', 'slaresolutiondate', 'targetresolutiondate', 'resolutiontargetdate'];
const SLA_CLOSED = ['dateclosed', 'date_closed', 'closedate'];

const SLA_BREACH_RE = /\b(breach\w*|late|miss\w*|fail\w*|overdue|unmet)\b|\bnot\s+(met|ok|achieved|within)/;
const SLA_MET_RE = /\b(met|ok|achieved?|within|pass(?:ed)?|on.?target)\b/;

/** Parse the first parseable date field to epoch ms, else undefined. */
function firstDateMs(row: Json, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

export interface SlaTally {
  met: number;
  breached: number;
  /** How the tally was derived — for the diagnostic warning. */
  source: 'dates' | 'text' | 'none';
  /** SLA/deadline-ish field keys the rows carried (only when source === 'none'). */
  seenKeys: string[];
  /** The rows that breached — backs the SLA-breaches drill-down. */
  breachedRows: Json[];
}

/** Per-row SLA state via the date pass (deadline vs actual). null = not scorable by dates. */
function slaStateByDates(row: Json): 'met' | 'breached' | null {
  const respondDeadline = firstDateMs(row, SLA_RESPOND_DEADLINE);
  const responded = firstDateMs(row, SLA_RESPONDED);
  const fixDeadline = firstDateMs(row, SLA_FIX_DEADLINE);
  const closed = firstDateMs(row, SLA_CLOSED);
  let considered = false;
  let breach = false;
  if (respondDeadline !== undefined && responded !== undefined) {
    considered = true;
    if (responded > respondDeadline) breach = true;
  }
  if (fixDeadline !== undefined && closed !== undefined) {
    considered = true;
    if (closed > fixDeadline) breach = true;
  }
  return considered ? (breach ? 'breached' : 'met') : null;
}

/** Per-row SLA state via the text pass (any breach wording wins). null = no state string. */
function slaStateByText(row: Json): 'met' | 'breached' | null {
  let sawBreach = false;
  let sawMet = false;
  for (const [k, v] of Object.entries(row)) {
    if (!/sla/i.test(k) || /name|id$/i.test(k) || typeof v !== 'string' || !v) continue;
    const s = v.toLowerCase();
    if (SLA_BREACH_RE.test(s)) sawBreach = true;
    else if (SLA_MET_RE.test(s)) sawMet = true;
  }
  return sawBreach ? 'breached' : sawMet ? 'met' : null;
}

export function tallyHaloSla(rows: Json[]): SlaTally {
  // 1) Date-based (deadline vs actual).
  let met = 0;
  let breached = 0;
  const breachedRows: Json[] = [];
  for (const row of rows) {
    const state = slaStateByDates(row);
    if (state === null) continue;
    if (state === 'breached') {
      breached++;
      breachedRows.push(row);
    } else met++;
  }
  if (met + breached > 0) return { met, breached, source: 'dates', seenKeys: [], breachedRows };

  // 2) Text-state fallback.
  met = 0;
  breached = 0;
  for (const row of rows) {
    const state = slaStateByText(row);
    if (state === null) continue;
    if (state === 'breached') {
      breached++;
      breachedRows.push(row);
    } else met++;
  }
  if (met + breached > 0) return { met, breached, source: 'text', seenKeys: [], breachedRows };

  // 3) Nothing recognizable — name the SLA-ish keys we DID see, so it's tunable.
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (/sla|respond|fixby|resolution|breach|target|dueby/i.test(k)) seen.add(k);
    }
  }
  return { met: 0, breached: 0, source: 'none', seenKeys: [...seen].slice(0, 15), breachedRows: [] };
}

export interface HaloFinanceInput {
  contracts: Json[];
  /** Full per-contract detail — the recurring line items live here, not on list rows. */
  contractDetails?: Json[];
  invoices: Json[];
  /** /api/Item catalog rows — lets lines resolve their item's group name. */
  items?: Json[];
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
    const contractRows: DetailRow[] = [];
    // Renewal readiness: contracts ending between the quarter start and 90 days
    // past its close are the ones to raise for renewal (drives the agenda + a
    // dashboard flag). End-date fields vary by instance; absent → simply skipped.
    const windowStart = Date.parse(`${input.periodStart}T00:00:00Z`);
    const windowEnd = Date.parse(`${input.periodEnd}T23:59:59Z`) + RENEWAL_WINDOW_DAYS * 86_400_000;
    let expiring = 0;
    const expiringRows: DetailRow[] = [];
    for (const c of input.contracts) {
      const name = firstStr(c, ['ref', 'reference', 'name']) ?? String(c['id'] ?? '');
      const v = firstNum(c, MRR_FIELDS);
      const ends = firstDate(c, END_DATE_FIELDS);
      if (v !== undefined) {
        mrr += v;
        recognized++;
        if (contractRows.length < DETAIL_CAP) contractRows.push({ contract: name, monthly: v, ...(ends ? { ends } : {}) });
      }
      if (ends) {
        const t = Date.parse(`${ends}T12:00:00Z`);
        if (t >= windowStart && t <= windowEnd) {
          expiring++;
          if (expiringRows.length < DETAIL_CAP) expiringRows.push({ contract: name, ends, ...(v !== undefined ? { monthly: v } : {}) });
        }
      }
    }
    if (recognized > 0) {
      metrics.push({ ...spend('finance.mrr', 'Monthly recurring revenue', mrr), details: contractRows });
      if (recognized < input.contracts.length) {
        warnings.push(`${input.contracts.length - recognized} Halo contract(s) had no recognizable monthly value field — MRR may be understated.`);
      }
    } else {
      warnings.push('Halo contracts carry no recognizable recurring monthly value field — MRR not computed (check contract billing setup).');
    }
    if (expiring > 0) {
      metrics.push(
        metric('finance.contracts_expiring', 'Agreements up for renewal (90 days)', expiring, {
          category: 'spend',
          source: 'halo',
          higherIsBetter: false,
          details: expiringRows.sort((a, b) => String(a['ends']).localeCompare(String(b['ends']))),
        }),
      );
    }
  }

  const itemIndex = buildHaloItemIndex(input.items ?? []);

  // Distinct labels can slug identically — merge so metric keys stay unique.
  // Long labels (raw line descriptions) are trimmed to stay table-friendly.
  // rowsByName carries each category's backing lines for drill-down; rows for
  // folded-away categories land on the Other entry.
  const emitBreakdown = (entries: Array<[string, number]>, keyPrefix: string, labelOf: (name: string) => string, rowsByName?: Map<string, DetailRow[]>) => {
    const topNames = new Set(entries.map(([n]) => n));
    const otherRows: DetailRow[] = [];
    if (rowsByName) {
      for (const [name, rows] of rowsByName) {
        if (!topNames.has(name)) otherRows.push(...rows);
      }
    }
    const bySlug = new Map<string, { name: string; amount: number; rows: DetailRow[] }>();
    for (const [name, amount] of entries) {
      const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other').slice(0, 40);
      const rows = name === 'Other' ? [...(rowsByName?.get(name) ?? []), ...otherRows] : (rowsByName?.get(name) ?? []);
      const prev = bySlug.get(slug);
      if (prev) {
        prev.amount += amount;
        prev.rows.push(...rows);
      } else {
        bySlug.set(slug, { name: name.length > 60 ? `${name.slice(0, 57)}…` : name, amount, rows });
      }
    }
    for (const [slug, { name, amount, rows }] of bySlug) {
      metrics.push({ ...spend(`${keyPrefix}.${slug}`, labelOf(name), amount), details: rows.slice(0, DETAIL_CAP) });
    }
  };

  // ── Recurring breakdown — the composition of the monthly bill, from the
  // contract details' line items (grouped like the invoice lines below).
  const details = input.contractDetails ?? [];
  if (details.length > 0) {
    const byRecurring = new Map<string, number>();
    const recurringRows = new Map<string, DetailRow[]>();
    let sampleDetailKeys: string | undefined;
    let sampleItemKeys: string | undefined;
    for (const detail of details) {
      const items = extractContractItems(detail);
      if (items.length === 0) {
        sampleDetailKeys ??= Object.keys(detail).join(', ');
        continue;
      }
      const contractRef = firstStr(detail, ['ref', 'reference', 'name']) ?? String(detail['id'] ?? '');
      for (const item of items) {
        // Monthly-total fields win; unit prices get multiplied by quantity.
        let amount = firstNum(item, RECURRING_TOTAL_FIELDS);
        if (amount === undefined) {
          const unit = firstNum(item, RECURRING_UNIT_FIELDS);
          if (unit !== undefined) amount = unit * (firstNum(item, QTY_FIELDS) ?? 1);
        }
        if (amount === undefined || amount === 0) {
          sampleItemKeys ??= Object.keys(item).join(', ');
          continue;
        }
        const label = lineCategory(item, itemIndex) ?? 'Other';
        byRecurring.set(label, (byRecurring.get(label) ?? 0) + amount);
        const rows = recurringRows.get(label) ?? [];
        if (rows.length < DETAIL_CAP) {
          rows.push({
            item: clip(firstStr(item, LINE_DESCRIPTION_FIELDS) ?? firstStr(item, ITEM_NAME_FIELDS) ?? label),
            monthly: Math.round(amount * 100) / 100,
            contract: contractRef,
          });
        }
        recurringRows.set(label, rows);
      }
    }
    if (byRecurring.size > 0) {
      const folded = foldCategories(byRecurring, 8);
      if (folded.length === 1 && folded[0]![0] === 'Other') {
        warnings.push(
          `Halo contract items carried no recognizable labels${sampleItemKeys ? ` (item fields seen: ${sampleItemKeys})` : ''} — recurring breakdown suppressed until parsing is tuned for this instance.`,
        );
      } else {
        emitBreakdown(folded, 'finance.recurring', (n) => `${n} (monthly)`, recurringRows);
      }
    } else {
      warnings.push(
        `Halo contract details carried no recognizable recurring line items${sampleDetailKeys ? ` (contract fields seen: ${sampleDetailKeys})` : ''} — the recurring breakdown needs tuning against this instance.`,
      );
    }
  }

  // ── In-quarter invoiced total + category breakdown from invoice lines.
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd) + 24 * 3600 * 1000; // inclusive end date
  let invoiced = 0;
  let counted = 0;
  let withLines = 0;
  const byCategory = new Map<string, number>();
  const categoryRows = new Map<string, DetailRow[]>();
  const invoiceRows: DetailRow[] = [];
  let sampleLineKeys: string | undefined;
  for (const inv of input.invoices) {
    const dateStr = firstStr(inv, INVOICE_DATE_FIELDS);
    const at = dateStr ? Date.parse(dateStr) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const invoiceRef = String(inv['id'] ?? inv['invoice_number'] ?? '');
    const invoiceDate = (dateStr ?? '').slice(0, 10);
    const total = firstNum(inv, INVOICE_TOTAL_FIELDS);
    if (total !== undefined) {
      invoiced += total;
      counted++;
      if (invoiceRows.length < DETAIL_CAP) invoiceRows.push({ invoice: invoiceRef, date: invoiceDate, total });
    }
    // High-level breakdown (Managed Services, Subscriptions, Software, …):
    // the line's own group, else its catalog item's group/name, else the
    // line description — see lineCategory.
    const lines = Array.isArray(inv['lines']) ? (inv['lines'] as Json[]) : [];
    if (lines.length > 0) withLines++;
    for (const line of lines) {
      const amount = firstNum(line, LINE_AMOUNT_FIELDS);
      if (amount === undefined || amount === 0) continue;
      const category = lineCategory(line, itemIndex);
      if (!category) sampleLineKeys ??= Object.keys(line).join(', ');
      const bucket = category ?? 'Other';
      byCategory.set(bucket, (byCategory.get(bucket) ?? 0) + amount);
      const rows = categoryRows.get(bucket) ?? [];
      if (rows.length < DETAIL_CAP) {
        rows.push({
          description: clip(firstStr(line, LINE_DESCRIPTION_FIELDS) ?? bucket),
          amount: Math.round(amount * 100) / 100,
          invoice: invoiceRef,
          date: invoiceDate,
        });
      }
      categoryRows.set(bucket, rows);
    }
  }
  if (counted > 0) {
    metrics.push({ ...spend('finance.quarter_invoiced', 'Invoiced this quarter (total)', invoiced), details: invoiceRows });
  }

  if (byCategory.size > 0) {
    const folded = foldCategories(byCategory, 6);
    if (folded.length === 1 && folded[0]![0] === 'Other') {
      // A lone "Other" next to the total is noise, not a breakdown — suppress
      // it and say exactly what the lines DID carry so parsing can be tuned.
      warnings.push(
        `Halo invoice line categories unrecognized${sampleLineKeys ? ` (line fields seen: ${sampleLineKeys})` : ''} — assign item groups in Halo (or share a sample line) to enable the spend breakdown.`,
      );
    } else {
      // No "Invoiced —" prefix: these render inside the IT Spend section where
      // the context is already clear, and the shorter label reads better.
      emitBreakdown(folded, 'finance.invoiced', (n) => n, categoryRows);
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

interface HaloIdTickets {
  ok: boolean;
  openedRows: Json[];
  openedTotal: number;
  closedRows: Json[];
  closedTotal: number;
  openRows: Json[];
  openTotal: number;
  contracts: Json[];
  contractDetails: Json[];
  invoices: Json[];
}

/**
 * Per-Halo-client-id ticket ROWS (opened/closed/open in the period) + finance.
 * Classification (ITIL / alert / allowlist) happens once in the caller across
 * all mapped ids, so this just gathers the rows via the server date windows —
 * with a recent-tickets fallback for instances that ignore `datesearch`.
 */
async function collectHaloForId(ctx: CollectorContext, http: HttpTransport, cfg: HaloCfg, haloId: string, warnings: string[], tag: string): Promise<HaloIdTickets> {
  const startMs = Date.parse(ctx.period.start);
  const endMs = Date.parse(ctx.period.end) + 24 * 3600 * 1000;
  let ok = false;
  let openedRows: Json[] = [];
  let openedTotal = 0;
  let closedRows: Json[] = [];
  let closedTotal = 0;

  // Tickets opened/closed in the period via the server date windows. 40 pages
  // covers a very busy quarter (up to 8,000 tickets even when an instance caps
  // pages at 200 rows); the sampling warning fires beyond that.
  try {
    const openedPull = await haloPageAll(http, cfg, 'Tickets', {
      client_id: haloId,
      datesearch: 'dateoccurred',
      startdate: ctx.period.start,
      enddate: ctx.period.end,
    }, 'tickets', 40);

    if (openedPull.rows.length === 0 && openedPull.total === 0) {
      // Some Halo versions ignore datesearch (returning nothing) — verify
      // against the unfiltered count and fall back to recent tickets.
      const probe = await haloGet(http, cfg, 'Tickets', { client_id: haloId, open_only: false, pageinate: true, page_size: 1, page_no: 1 });
      const totalTickets = recordCount(probe, toArray(probe, ['tickets']));
      ok = true; // the API answered — a truly ticket-free client is an honest zero, not a failure
      if (totalTickets > 0) {
        const all = await haloPageAll(http, cfg, 'Tickets', { client_id: haloId, open_only: false, order: 'dateoccurred', orderdesc: true }, 'tickets', 10);
        openedRows = all.rows.filter((r) => inPeriod(r, TICKET_OPENED_FIELDS, startMs, endMs));
        closedRows = all.rows.filter((r) => inPeriod(r, TICKET_CLOSED_FIELDS, startMs, endMs));
        openedTotal = openedRows.length;
        closedTotal = closedRows.length;
        if (all.rows.length < all.total) {
          warnings.push(`Halo${tag}: the server date filter returned nothing — ticket tallies counted from the most recent ${all.rows.length} of ${all.total} tickets instead.`);
        }
      }
    } else {
      ok = true;
      openedRows = openedPull.rows.filter((r) => !outsidePeriod(r, TICKET_OPENED_FIELDS, startMs, endMs));
      openedTotal = openedPull.total;
      const closedPull = await haloPageAll(http, cfg, 'Tickets', {
        client_id: haloId,
        datesearch: 'dateclosed',
        startdate: ctx.period.start,
        enddate: ctx.period.end,
      }, 'tickets', 40);
      closedRows = closedPull.rows.filter((r) => !outsidePeriod(r, TICKET_CLOSED_FIELDS, startMs, endMs));
      closedTotal = closedPull.total;
      if (openedPull.rows.length < openedPull.total || closedPull.rows.length < closedPull.total) {
        warnings.push(`Halo${tag}: ticket tallies counted from the first ${Math.max(openedPull.rows.length, closedPull.rows.length)} of ${Math.max(openedPull.total, closedPull.total)} in-period tickets.`);
      }
    }
  } catch (e) {
    warnings.push(`Halo${tag} ticket volume unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Open-ticket snapshot as ROWS so it classifies like opened/closed.
  let openRows: Json[] = [];
  let openTotal = 0;
  try {
    const openPull = await haloPageAll(http, cfg, 'Tickets', { client_id: haloId, open_only: true }, 'tickets', 10);
    openRows = openPull.rows;
    openTotal = openPull.total;
    ok = true;
    if (openPull.rows.length < openPull.total) {
      warnings.push(`Halo${tag}: open-ticket snapshot read from the first ${openPull.rows.length} of ${openPull.total} open tickets.`);
    }
  } catch (e) {
    warnings.push(`Halo${tag} open-ticket snapshot unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Finance — contracts (+ per-contract detail for the recurring breakdown) and invoices.
  let contracts: Json[] = [];
  const contractDetails: Json[] = [];
  let invoices: Json[] = [];
  try {
    contracts = (await haloPageAll(http, cfg, 'ClientContract', { client_id: haloId }, 'contracts')).rows;
    for (const c of contracts.slice(0, 10)) {
      const cid = c['id'];
      if (cid === undefined || cid === null) continue;
      try {
        const d = await haloGet(http, cfg, `ClientContract/${String(cid)}`);
        if (d && typeof d === 'object' && !Array.isArray(d)) contractDetails.push(d as Json);
      } catch {
        // Per-contract tolerance — list-level MRR still works without it.
      }
    }
  } catch (e) {
    warnings.push(`Halo${tag} contracts unavailable (MRR skipped): ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    invoices = (await haloPageAll(http, cfg, 'Invoice', { client_id: haloId, includelines: true }, 'invoices')).rows;
  } catch (e) {
    warnings.push(`Halo${tag} invoices unavailable (quarterly spend skipped): ${e instanceof Error ? e.message : 'error'}`);
  }

  return { ok, openedRows, openedTotal, closedRows, closedTotal, openRows, openTotal, contracts, contractDetails, invoices };
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
  const closedRows: Json[] = [];
  const openRows: Json[] = [];
  let openedTotal = 0;
  let openTotal = 0;
  let anyTicketData = false;
  const contracts: Json[] = [];
  const contractDetails: Json[] = [];
  const invoices: Json[] = [];
  for (const haloId of ids) {
    const tag = ids.length > 1 ? ` [${haloId}]` : '';
    const t = await collectHaloForId(ctx, http, cfg, haloId, warnings, tag);
    anyTicketData ||= t.ok;
    openedRows.push(...t.openedRows);
    closedRows.push(...t.closedRows);
    openRows.push(...t.openRows);
    openedTotal += t.openedTotal;
    openTotal += t.openTotal;
    contracts.push(...t.contracts);
    contractDetails.push(...t.contractDetails);
    invoices.push(...t.invoices);
  }

  // The item catalog resolves line → group for both breakdowns (cached ~1 h).
  let items: Json[] = [];
  if (invoices.length > 0 || contractDetails.length > 0) {
    try {
      items = await listHaloItemsCached(http, cfg);
    } catch {
      warnings.push('Halo item catalog unavailable — invoice/contract lines are grouped by their own fields only.');
    }
  }

  // Emit ticket tallies only when the API actually answered — a hard failure
  // must read as "unavailable" in the warnings, not as a quarter of zeros.
  if (anyTicketData) {
    // Resolve ticket-type names (rows carry only tickettype_id) so tickets can
    // be classified by ITIL type — the headline is human SERVICE-DESK work, not
    // the automated RMM/security alerts that dominate the raw count.
    const typeMap = await fetchTicketTypeMap(http, cfg);
    const allowed = cfg.ticketTypeIds?.length ? new Set(cfg.ticketTypeIds.map(String)) : undefined;
    const inAllowlist = (r: Json) => {
      const t = ticketTypeIdOf(r);
      return t !== undefined && allowed!.has(t);
    };

    // An allowlist restricts on type id — but if the instance's rows carry no
    // type id at all, it can't be applied (would read as a quarter of zeros).
    const everyRow = [...openedRows, ...closedRows, ...openRows];
    if (allowed && everyRow.length > 0 && !everyRow.some((r) => ticketTypeIdOf(r) !== undefined)) {
      warnings.push(
        `Halo: ticket rows carry no ticket-type id, so the connection's ticket-type filter can't be applied — ticket metrics skipped (clear the filter to report on all tickets).`,
      );
    } else {
      // Classification needs type names — from the type map or the rows. If
      // neither resolves (e.g. /api/TicketType was blocked and rows carry only
      // ids), don't silently report zero service-desk tickets: fall back to
      // counting every ticket and say why.
      const classifiable = typeMap.size > 0 || everyRow.some((r) => ticketTypeName(r, typeMap) !== undefined);
      if (!allowed && !classifiable && everyRow.length > 0) {
        warnings.push(
          `Halo ticket types couldn't be resolved (check API access to /api/TicketType) — reporting all tickets; automated alerts can't be separated until types resolve, or set a ticket-type allowlist on the connection.`,
        );
      }
      // Service-desk = the allowlisted types when the user picked them, else the
      // ITIL classes (incident / service request / change / problem). Automated
      // alerts are always separated out. When classification is impossible, all
      // tickets count (better a nonzero-with-warning than a misleading zero).
      const isServiceDesk = (r: Json) => (allowed ? inAllowlist(r) : classifiable ? SERVICE_DESK_CLASSES.has(ticketClass(r, typeMap)) : true);
      const classOf = (r: Json) => ticketClass(r, typeMap);
      const openedSvc = openedRows.filter(isServiceDesk);
      const closedSvc = closedRows.filter(isServiceDesk);
      // Open snapshot: classify when we have rows, else fall back to the server count.
      const openCount = openRows.length > 0 ? openRows.filter(isServiceDesk).length : openTotal;

      const haloBase = cfg.baseUrl.replace(/\/+$/, '');
      // Map ticket rows to a drill-down list (each row deep-links into Halo).
      const toDetail = (rows: Json[], dateFields = TICKET_OPENED_FIELDS, dateLabel = 'opened'): DetailRow[] =>
        rows.slice(0, DETAIL_CAP).map((r) => ({
          id: String(r['id'] ?? ''),
          summary: clip(firstStr(r, ['summary', 'subject']) ?? ''),
          type: ticketTypeName(r, typeMap) ?? (ticketTypeIdOf(r) !== undefined ? `type ${ticketTypeIdOf(r)!}` : ''),
          [dateLabel]: (firstStr(r, dateFields) ?? '').slice(0, 10),
          url: `${haloBase}/ticket?id=${String(r['id'] ?? '')}`,
        }));

      const incidentRows = openedSvc.filter((r) => classOf(r) === 'incident');
      const serviceRows = openedSvc.filter((r) => classOf(r) === 'service_request');
      const changeRows = openedSvc.filter((r) => classOf(r) === 'change');
      const alertRows = openedRows.filter((r) => classOf(r) === 'alert');
      const openSvcRows = openRows.filter(isServiceDesk);

      // Every ticket metric carries its backing list so the Data tab / report
      // drill-downs open the actual tickets behind the number.
      metrics.push({ ...op('tickets.total', 'Tickets opened', openedSvc.length, false), details: toDetail(openedSvc) });
      metrics.push({ ...op('tickets.incidents', 'Incidents', incidentRows.length, false), details: toDetail(incidentRows) });
      metrics.push({ ...op('tickets.service', 'Service requests', serviceRows.length), details: toDetail(serviceRows) });
      metrics.push({ ...op('tickets.changes', 'Change requests', changeRows.length), details: toDetail(changeRows) });

      // Automated alerts across ALL opened tickets — the RMM/security noise the
      // MSP absorbs, surfaced separately so it never inflates the ticket count.
      if (alertRows.length > 0) metrics.push({ ...op('tickets.alerts', 'Automated alerts', alertRows.length, false), details: toDetail(alertRows) });

      metrics.push({ ...op('tickets.closed', 'Tickets closed', closedSvc.length, true), details: toDetail(closedSvc, TICKET_CLOSED_FIELDS, 'closed') });
      metrics.push({
        ...op('tickets.open', 'Open tickets', openCount, false),
        // Open detail only when we classified from rows (not the count-only fallback).
        ...(openRows.length > 0 ? { details: toDetail(openSvcRows) } : {}),
      });

      if (openedRows.length < openedTotal) {
        warnings.push(`Ticket tallies sampled from the first ${openedRows.length} of ${openedTotal} opened tickets — the ITIL breakdown may be partial.`);
      }

      // SLA outcomes over the service-desk tickets opened in the period (alerts
      // auto-resolve and don't carry SLAs).
      const sla = tallyHaloSla(openedSvc);
      if (sla.met + sla.breached > 0) {
        metrics.push(
          metric('sla.met_pct', 'SLA met', Math.round((1000 * sla.met) / (sla.met + sla.breached)) / 10, {
            category: 'operations',
            source: 'halo',
            unit: '%',
            higherIsBetter: true,
          }),
        );
        if (sla.breached > 0) metrics.push({ ...op('sla.breaches', 'SLA breaches', sla.breached, false), details: toDetail(sla.breachedRows) });
      } else if (openedSvc.length > 0) {
        warnings.push(
          `Halo SLA state not recognized on ticket rows — SLA reporting needs tuning against this instance${
            sla.seenKeys.length ? ` (SLA-ish fields seen: ${sla.seenKeys.join(', ')})` : ' (no SLA/deadline fields present on the rows)'
          }.`,
        );
      }
    }
  }

  // Asset inventory (client-scoped snapshot) with a categorized drill-down —
  // computers, network devices, printers, … from Halo's asset types.
  const assetRows: Json[] = [];
  let assetsOk = false;
  for (const haloId of ids) {
    try {
      const res = await haloPageAll(http, cfg, 'Asset', { client_id: haloId }, 'assets', 10);
      assetRows.push(...res.rows);
      assetsOk = true;
    } catch (e) {
      warnings.push(`Halo${ids.length > 1 ? ` [${haloId}]` : ''} assets unavailable: ${e instanceof Error ? e.message : 'error'}`);
    }
  }
  if (assetsOk) {
    const assetBase = cfg.baseUrl.replace(/\/+$/, '');
    const typed = assetRows.map((r) => ({
      name: clip(firstStr(r, ['inventory_number', 'name', 'key_field', 'device_name', 'dnsname']) ?? `#${String(r['id'] ?? '')}`, 60),
      type: firstStr(r, ['assettype_name', 'asset_type_name', 'typename', 'assettype']) ?? 'Other',
      url: `${assetBase}/asset?id=${String(r['id'] ?? '')}`,
    }));
    typed.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    metrics.push({
      ...metric('assets.total', 'Assets under management', assetRows.length, { category: 'infrastructure', source: 'halo', unit: 'count' }),
      details: typed.slice(0, DETAIL_CAP * 2),
    });
  }

  const finance = normalizeHaloFinance({ contracts, contractDetails, invoices, items, periodStart: ctx.period.start, periodEnd: ctx.period.end });
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
