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
  for (const inv of input.invoices) {
    const dateStr = firstStr(inv, INVOICE_DATE_FIELDS);
    const at = dateStr ? Date.parse(dateStr) : NaN;
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const total = firstNum(inv, INVOICE_TOTAL_FIELDS);
    if (total !== undefined) {
      invoiced += total;
      counted++;
    }
  }
  if (counted > 0) metrics.push(spend('finance.quarter_invoiced', 'Invoiced this quarter', invoiced));

  return { metrics, warnings };
}

/**
 * Collect Halo metrics for a client/period straight from the Halo API:
 * ticket volumes with a real date window, the open-ticket snapshot, and the
 * finance figures (MRR + in-quarter invoiced) that power the admin dashboard.
 */
export async function collectHaloDirect(ctx: CollectorContext, http: HttpTransport, cfg: HaloCfg): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'halo', metrics: [], warnings: ['No Halo client mapped for this client.'] };
  }
  const clientId = ctx.externalRef;
  const metrics: MetricValue[] = [];
  const warnings: string[] = [];
  const op = (k: string, l: string, v: number, higherIsBetter?: boolean) =>
    metric(k, l, v, { category: 'operations', source: 'halo', unit: 'count', higherIsBetter });

  // Tickets opened in the period (+ by-type breakdown from the returned rows).
  try {
    const opened = await haloPageAll(http, cfg, 'Tickets', {
      client_id: clientId,
      datesearch: 'dateoccurred',
      startdate: ctx.period.start,
      enddate: ctx.period.end,
    }, 'tickets');
    metrics.push(op('tickets.total', 'Tickets opened', opened.total, false));
    const counts = new Map<string, number>();
    for (const row of opened.rows) counts.set(ticketCategory(row), (counts.get(ticketCategory(row)) ?? 0) + 1);
    if (opened.rows.length > 0) {
      metrics.push(
        op('tickets.incidents', 'Incidents', counts.get('incident') ?? 0, false),
        op('tickets.changes', 'Change requests', counts.get('change') ?? 0),
        op('tickets.service', 'Service requests', counts.get('service') ?? 0),
      );
      if (opened.rows.length < opened.total) {
        warnings.push(`Ticket by-type breakdown sampled from the first ${opened.rows.length} of ${opened.total} tickets.`);
      }
    }
  } catch (e) {
    warnings.push(`Halo ticket volume unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Tickets closed in the period.
  try {
    const closed = await haloGet(http, cfg, 'Tickets', {
      client_id: clientId,
      datesearch: 'dateclosed',
      startdate: ctx.period.start,
      enddate: ctx.period.end,
      pageinate: true,
      page_size: 1,
      page_no: 1,
    });
    metrics.push(op('tickets.closed', 'Tickets closed', recordCount(closed, toArray(closed, ['tickets'])), true));
  } catch (e) {
    warnings.push(`Halo closed-ticket count unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Open-ticket snapshot right now.
  try {
    const open = await haloGet(http, cfg, 'Tickets', { client_id: clientId, open_only: true, pageinate: true, page_size: 1, page_no: 1 });
    metrics.push(op('tickets.open', 'Open tickets', recordCount(open, toArray(open, ['tickets'])), false));
  } catch (e) {
    warnings.push(`Halo open-ticket snapshot unavailable: ${e instanceof Error ? e.message : 'error'}`);
  }

  // Finance: MRR from contracts, invoiced-in-quarter from invoices.
  let contracts: Json[] = [];
  let invoices: Json[] = [];
  try {
    contracts = (await haloPageAll(http, cfg, 'ClientContract', { client_id: clientId }, 'contracts')).rows;
  } catch (e) {
    warnings.push(`Halo contracts unavailable (MRR skipped): ${e instanceof Error ? e.message : 'error'}`);
  }
  try {
    invoices = (await haloPageAll(http, cfg, 'Invoice', { client_id: clientId }, 'invoices')).rows;
  } catch (e) {
    warnings.push(`Halo invoices unavailable (quarterly spend skipped): ${e instanceof Error ? e.message : 'error'}`);
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
