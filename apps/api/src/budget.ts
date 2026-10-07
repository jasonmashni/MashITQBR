import {
  computeOutlook,
  fiscalPeriods,
  fiscalYearOf,
  isPlanningPeriod,
  lastPeriods,
  periodFor,
  planningPeriodFor,
  planVsActual,
  type BudgetAnswers,
  type BudgetFacts,
  type BudgetOutlook,
  type Client,
  type MetricSnapshot,
} from '@mashit/core';
import type { ApiResult } from './handlers.js';
import { audit } from './audit.js';
import { createClaudeBudgetResearcher, type BudgetResearchModel } from './budgetResearch.js';
import { currentActor } from './requestContext.js';
import { dataLocked, LOCKED } from './locks.js';
import { getDataStore, storeDataSource, type BudgetPlanRecord, type DataStore } from './store/index.js';

/**
 * Budget planning API (workstream D). A plan per client and fiscal year holds
 * the account manager's answers and the deterministic outlook computed from
 * the client's own data. Industry context (budgetResearch.ts) is stored on the
 * plan for staff only and never reaches a report or a narrative input.
 *
 * HIPAA: nothing here reads ticket subjects or any other PHI. Inputs are
 * aggregate spend, seat and device counts plus the opportunity board.
 */

const ok = (json: unknown): ApiResult => ({ status: 200, json });
const err = (status: number, message: string): ApiResult => ({ status, json: { error: message } });

/** A fiscal label is a four-digit year. */
function parseFiscalLabel(fy: string): number | undefined {
  return /^\d{4}$/.test(fy) ? Number(fy) : undefined;
}

const startMonthOf = (client: Client | undefined): number => client?.fiscalYearStartMonth ?? 1;

// ── Answers ─────────────────────────────────────────────────────────────────

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const nonNeg = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};
const text = (v: unknown, max = 300): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Keep only well-formed answers; anything else is dropped, never guessed. */
export function sanitizeAnswers(raw: unknown): BudgetAnswers {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: BudgetAnswers = {};
  const hc = num(o['headcountChange']);
  if (hc !== undefined && Number.isInteger(hc)) out.headcountChange = hc;
  if (o['newLocations'] === 0 || o['newLocations'] === 1 || o['newLocations'] === 2) out.newLocations = o['newLocations'];
  const projects = list(o['projects'])
    .map((p) => {
      const r = (p ?? {}) as Record<string, unknown>;
      const name = text(r['name'], 120);
      if (!name) return undefined;
      const low = nonNeg(r['low']);
      const high = nonNeg(r['high']);
      return { name, ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}) };
    })
    .filter((p): p is NonNullable<typeof p> => !!p)
    .slice(0, 20);
  if (projects.length) out.projects = projects;
  const unit = nonNeg(o['workstationUnitCost']);
  if (unit !== undefined && unit > 0) out.workstationUnitCost = unit;
  const policy = oneOf(o['refreshPolicy'], ['run_to_failure', 'at_warranty_end', 'early'] as const);
  if (policy) out.refreshPolicy = policy;
  const deadlines = list(o['complianceDeadlines'])
    .map((d) => {
      const r = (d ?? {}) as Record<string, unknown>;
      const what = text(r['what'], 160);
      const when = text(r['when'], 60);
      if (!what || !when) return undefined;
      const estimate = nonNeg(r['estimate']);
      return { what, when, ...(estimate !== undefined ? { estimate } : {}) };
    })
    .filter((d): d is NonNullable<typeof d> => !!d)
    .slice(0, 20);
  if (deadlines.length) out.complianceDeadlines = deadlines;
  const seats = nonNeg(o['copilotSeats']);
  if (seats !== undefined && Number.isInteger(seats)) out.copilotSeats = seats;
  const price = nonNeg(o['copilotSeatPrice']);
  if (price !== undefined) out.copilotSeatPrice = price;
  const appetite = oneOf(o['appetite'], ['lean', 'balanced', 'cautious'] as const);
  if (appetite) out.appetite = appetite;
  const notes = text(o['notes'], 2000);
  if (notes) out.notes = notes;
  return out;
}

const sentences = (v: unknown): string[] =>
  list(v)
    .map((s) => text(s))
    .filter((s): s is string => !!s)
    .slice(0, 10);

// ── Facts from the client's data ────────────────────────────────────────────

function metricNum(s: MetricSnapshot | undefined, key: string): number | undefined {
  const v = s?.metrics.find((m) => m.key === key)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const normLabel = (label: string) => label.replace(/\s*\(monthly\)\s*$/i, '').trim().toLowerCase();

/** Monthly recurring value of the finance.recurring.* lines whose label matches. */
function recurringMatching(s: MetricSnapshot, re: RegExp): number | undefined {
  const rows = s.metrics.filter((m) => m.key.startsWith('finance.recurring.') && typeof m.value === 'number' && re.test(m.label));
  return rows.length ? rows.reduce((sum, m) => sum + (m.value as number), 0) : undefined;
}

/**
 * Non-recurring invoiced for one quarter: invoice lines whose category is not
 * in the recurring breakdown (the same split the investment page uses), else
 * the quarter's invoiced total less three months of MRR.
 */
export function quarterVariable(s: MetricSnapshot | undefined): number | undefined {
  const invoiced = metricNum(s, 'finance.quarter_invoiced');
  if (!s || invoiced === undefined) return undefined;
  const recurringLabels = new Set(s.metrics.filter((m) => m.key.startsWith('finance.recurring.')).map((m) => normLabel(m.label)));
  const lines = s.metrics.filter((m) => m.key.startsWith('finance.invoiced.') && typeof m.value === 'number');
  let recurring: number;
  if (recurringLabels.size > 0 && lines.length > 0) {
    recurring = lines.filter((m) => recurringLabels.has(normLabel(m.label))).reduce((sum, m) => sum + (m.value as number), 0);
  } else {
    recurring = (metricNum(s, 'finance.mrr') ?? 0) * 3;
  }
  return Math.max(0, Math.round((invoiced - recurring) * 100) / 100);
}

const M365 = /microsoft 365|m365|office 365/i;
const MANAGED_END_USER = /managed end user/i;

export interface KnownFact {
  text: string;
  source: string;
}

export interface GatheredFacts {
  facts: BudgetFacts;
  known: KnownFact[];
  /** The snapshot the facts were read from, when one exists. */
  asOf?: string;
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Facts for a fiscal year's outlook: the latest snapshot at or before the
 * planning period (or now, whichever is earlier), the trailing four quarters
 * of non-recurring invoiced, and one-time estimates on the opportunity board.
 */
export async function gatherBudgetFacts(store: DataStore, clientId: string, fiscalLabel: number, startMonth: number, now = new Date()): Promise<GatheredFacts> {
  const source = storeDataSource(store);
  const planning = planningPeriodFor(fiscalLabel, startMonth);
  const current = periodFor(now).id;
  const anchor = planning < current ? planning : current;
  let latest: MetricSnapshot | undefined;
  for (const p of lastPeriods(anchor, 8)) {
    latest = await source.getSnapshot(clientId, p);
    if (latest) break;
  }

  const facts: BudgetFacts = {};
  const known: KnownFact[] = [];
  if (latest) {
    const mrr = metricNum(latest, 'finance.mrr');
    if (mrr !== undefined && mrr > 0) {
      facts.mrr = mrr;
      known.push({ text: `Recurring agreements: ${money(mrr)} a month.`, source: 'Halo contracts' });
    }

    const variable: number[] = [];
    for (const p of lastPeriods(latest.period, 4).reverse()) {
      const v = quarterVariable(p === latest.period ? latest : await source.getSnapshot(clientId, p));
      if (v !== undefined) variable.push(v);
    }
    if (variable.length) {
      facts.quarterlyVariable = variable;
      const total = variable.reduce((s, n) => s + n, 0);
      known.push({
        text: `Hourly and project work: ${money(total)} over the last ${variable.length} ${variable.length === 1 ? 'quarter' : 'quarters'}.`,
        source: 'Halo invoices',
      });
    }

    const seats = metricNum(latest, 'licenses.total');
    const assigned = metricNum(latest, 'licenses.assigned');
    if (seats !== undefined && seats > 0) {
      facts.paidSeats = seats;
      const m365Monthly = recurringMatching(latest, M365);
      const m365Invoiced = latest.metrics
        .filter((m) => m.key.startsWith('finance.invoiced.') && typeof m.value === 'number' && M365.test(m.label))
        .reduce((s, m) => s + (m.value as number), 0);
      if (m365Monthly !== undefined && m365Monthly > 0) facts.seatMonthly = Math.round((m365Monthly / seats) * 100) / 100;
      else if (m365Invoiced > 0) facts.seatMonthly = Math.round((m365Invoiced / 3 / seats) * 100) / 100;
      known.push({
        text: `Microsoft 365: ${seats} paid seats${assigned !== undefined ? `, ${assigned} assigned` : ''}${facts.seatMonthly ? `, about ${money(facts.seatMonthly)} a seat a month` : ''}.`,
        source: facts.seatMonthly ? 'CIPP, Halo' : 'CIPP',
      });
    }
    const users = assigned ?? seats;
    const endUserMonthly = recurringMatching(latest, MANAGED_END_USER);
    if (endUserMonthly !== undefined && endUserMonthly > 0 && users !== undefined && users > 0) {
      facts.perUserMonthly = Math.round((endUserMonthly / users) * 100) / 100;
    }

    const expired = metricNum(latest, 'assets.warranty_expired') ?? metricNum(latest, 'assets.out_of_warranty');
    const soon = metricNum(latest, 'assets.warranty_expiring_6mo') ?? metricNum(latest, 'assets.warranty_expiring') ?? metricNum(latest, 'assets.expiring_90d');
    if (expired !== undefined || soon !== undefined) {
      facts.devicesAgingOut = (expired ?? 0) + (soon ?? 0);
      const parts = [expired !== undefined ? `${expired} past warranty` : '', soon !== undefined ? `${soon} more expiring soon` : ''].filter(Boolean);
      known.push({ text: `Devices: ${parts.join(', ')}.`, source: 'Ninja, Hudu' });
    }
  }

  const opportunities = (await store.listOpportunities(clientId)).filter((o) => o.status !== 'closed');
  const projects = opportunities
    .filter((o) => o.valueKind === 'one_time' && typeof o.value === 'number' && o.value > 0)
    .map((o) => ({ name: o.title, low: o.value, high: o.value }));
  if (projects.length) facts.projects = projects;
  if (opportunities.length) {
    known.push({ text: `Open opportunities: ${opportunities.map((o) => o.title).slice(0, 6).join(', ')}.`, source: 'Opportunity board' });
  }

  return { facts, known, ...(latest ? { asOf: latest.period } : {}) };
}

/**
 * Plan versus actual for a published plan, spent through `uptoPeriod`
 * (inclusive) from each fiscal period's finance.quarter_invoiced.
 */
export async function planVsActualFor(
  getSnapshot: (clientId: string, period: string) => Promise<MetricSnapshot | undefined>,
  plan: BudgetPlanRecord,
  startMonth: number,
  uptoPeriod: string,
): Promise<ReportBudget['planVsActual']> {
  if (plan.status !== 'published') return undefined;
  const spent: number[] = [];
  for (const p of fiscalPeriods(plan.fiscalLabel, startMonth)) {
    if (p > uptoPeriod) break;
    const v = metricNum(await getSnapshot(plan.clientId, p), 'finance.quarter_invoiced');
    if (v !== undefined) spent.push(v);
  }
  if (spent.length === 0) return undefined;
  return { fiscalYearLabel: `FY${plan.fiscalLabel}`, ...planVsActual(plan.totals.expected, spent), elapsedPct: (Math.min(4, spent.length) / 4) * 100 };
}

// ── Handlers ────────────────────────────────────────────────────────────────

function emptyPlan(clientId: string, fiscalLabel: number): BudgetPlanRecord {
  const now = new Date().toISOString();
  return {
    clientId,
    fiscalLabel,
    answers: {},
    assumptions: [],
    movers: [],
    lines: [],
    totals: { low: 0, expected: 0, high: 0 },
    caveats: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    updatedBy: currentActor(),
  };
}

async function resolve(clientId: string, fy: string): Promise<{ client: Client; label: number } | ApiResult> {
  const label = parseFiscalLabel(fy);
  if (label === undefined) return err(400, 'Fiscal year must be a four-digit year');
  const client = await storeDataSource().getClient(clientId);
  if (!client) return err(404, 'Unknown client');
  return { client, label };
}
const isResult = (v: unknown): v is ApiResult => !!v && typeof v === 'object' && 'status' in v;

export async function listBudgets(clientId: string): Promise<ApiResult> {
  const store = getDataStore();
  const client = await storeDataSource(store).getClient(clientId);
  if (!client) return err(404, 'Unknown client');
  const startMonth = startMonthOf(client);
  const plans = await store.listBudgetPlans(clientId);
  // Known facts for the coming fiscal year (the one being planned).
  const nextLabel = fiscalYearOf(periodFor(new Date()).id, startMonth).label + 1;
  const { known, asOf } = await gatherBudgetFacts(store, clientId, nextLabel, startMonth);
  return ok({ plans, fiscalYearStartMonth: startMonth, known, ...(asOf ? { knownAsOf: asOf } : {}) });
}

export async function getBudget(clientId: string, fy: string): Promise<ApiResult> {
  const r = await resolve(clientId, fy);
  if (isResult(r)) return r;
  const store = getDataStore();
  const plan = await store.getBudgetPlan(clientId, r.label);
  if (!plan) return err(404, 'No budget plan for this fiscal year');
  const source = storeDataSource(store);
  const actual = await planVsActualFor(source.getSnapshot, plan, startMonthOf(r.client), periodFor(new Date()).id);
  return ok({ plan, ...(actual ? { planVsActual: actual } : {}) });
}

export async function putBudget(clientId: string, fy: string, body: Record<string, unknown>): Promise<ApiResult> {
  if (!body || Object.keys(body).length === 0) return err(400, 'Request body is empty');
  const r = await resolve(clientId, fy);
  if (isResult(r)) return r;
  const store = getDataStore();
  const existing = (await store.getBudgetPlan(clientId, r.label)) ?? emptyPlan(clientId, r.label);
  const saved = await store.putBudgetPlan({
    ...existing,
    ...('answers' in body ? { answers: sanitizeAnswers(body['answers']) } : {}),
    ...('assumptions' in body ? { assumptions: sentences(body['assumptions']) } : {}),
    ...('movers' in body ? { movers: sentences(body['movers']) } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: currentActor(),
  });
  await audit('budget.save', `client:${clientId}`, `FY${r.label} answers saved`);
  return ok({ plan: saved });
}

export async function recomputeBudget(clientId: string, fy: string): Promise<ApiResult> {
  const r = await resolve(clientId, fy);
  if (isResult(r)) return r;
  const store = getDataStore();
  const existing = (await store.getBudgetPlan(clientId, r.label)) ?? emptyPlan(clientId, r.label);
  const { facts } = await gatherBudgetFacts(store, clientId, r.label, startMonthOf(r.client));
  const outlook = computeOutlook(facts, existing.answers);
  const saved = await store.putBudgetPlan({
    ...existing,
    lines: outlook.lines,
    totals: outlook.totals,
    caveats: outlook.caveats,
    updatedAt: new Date().toISOString(),
    updatedBy: currentActor(),
  });
  await audit('budget.outlook', `client:${clientId}`, `FY${r.label} expected ${money(outlook.totals.expected)}`);
  return ok({ plan: saved });
}

export async function publishBudget(clientId: string, fy: string): Promise<ApiResult> {
  const r = await resolve(clientId, fy);
  if (isResult(r)) return r;
  const store = getDataStore();
  const existing = await store.getBudgetPlan(clientId, r.label);
  if (!existing) return err(404, 'No budget plan for this fiscal year');
  if (existing.lines.length === 0) return err(400, 'Run the outlook before putting it on the report');
  const period = planningPeriodFor(r.label, startMonthOf(r.client));
  const qbr = await store.getQbr(clientId, period);
  if (dataLocked(qbr)) return LOCKED(qbr?.locks?.final ? 'final' : 'preread');
  const now = new Date().toISOString();
  const saved = await store.putBudgetPlan({
    ...existing,
    status: 'published',
    publishedPeriod: period,
    publishedAt: now,
    updatedAt: now,
    updatedBy: currentActor(),
  });
  await audit('budget.publish', `client:${clientId}`, `FY${r.label} on the ${period} report`);
  return ok({ plan: saved });
}

/** Seat-count band sent to the researcher instead of an exact headcount. */
export function headcountBand(seats: number | undefined): string | undefined {
  if (seats === undefined || seats <= 0) return undefined;
  const bands: Array<[number, string]> = [
    [10, '1 to 10'],
    [25, '11 to 25'],
    [50, '26 to 50'],
    [100, '51 to 100'],
    [250, '101 to 250'],
  ];
  return bands.find(([max]) => seats <= max)?.[1] ?? 'more than 250';
}

/**
 * AI industry context for budget prep. Stored on the plan for staff only;
 * never passed to the narrative or the report model.
 */
export async function contextBudget(clientId: string, fy: string, researcher?: BudgetResearchModel): Promise<ApiResult> {
  const r = await resolve(clientId, fy);
  if (isResult(r)) return r;
  if (!researcher && !process.env['ANTHROPIC_API_KEY']) {
    return ok({ available: false, note: 'Industry context needs AI. Add the Anthropic key in Settings to enable it.' });
  }
  const store = getDataStore();
  const { facts } = await gatherBudgetFacts(store, clientId, r.label, startMonthOf(r.client));
  let research;
  try {
    research = await (researcher ?? createClaudeBudgetResearcher())({
      industry: r.client.industry,
      complianceStandard: r.client.complianceStandard,
      headcountBand: headcountBand(facts.paidSeats),
      fiscalLabel: r.label,
    });
  } catch (e) {
    return err(502, `Research failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  const existing = (await store.getBudgetPlan(clientId, r.label)) ?? emptyPlan(clientId, r.label);
  const now = new Date().toISOString();
  const saved = await store.putBudgetPlan({
    ...existing,
    context: { researchedAt: now, sourced: research.sourced, items: research.items },
    updatedAt: now,
    updatedBy: currentActor(),
  });
  await audit('budget.context', `client:${clientId}`, `FY${r.label} ${research.items.length} item(s)`);
  return ok({ available: true, plan: saved });
}

export interface ReportBudget {
  planVsActual?: { fiscalYearLabel: string; planned: number; spent: number; pct: number; note: string; elapsedPct?: number };
  outlook?: BudgetOutlook;
  unitCost?: number;
}

/**
 * What the report for `period` shows from published budget plans: plan versus
 * actual for the fiscal year the period belongs to, the next year's outlook in
 * the planning quarter only, and the planning unit cost for the warranty
 * sentence. Only client-facing fields are copied; `context` never leaves here.
 */
export async function budgetForPeriod(store: DataStore, clientId: string, period: string): Promise<ReportBudget | undefined> {
  const source = storeDataSource(store);
  const startMonth = startMonthOf(await source.getClient(clientId));
  const fy = fiscalYearOf(period, startMonth);
  const published = async (label: number) => {
    const plan = await store.getBudgetPlan(clientId, label);
    return plan?.status === 'published' ? plan : undefined;
  };
  const current = await published(fy.label);
  const next = isPlanningPeriod(period, startMonth) ? await published(fy.label + 1) : undefined;
  const actual = current ? await planVsActualFor(source.getSnapshot, current, startMonth, period) : undefined;
  const outlook: BudgetOutlook | undefined = next
    ? {
        fiscalLabel: next.fiscalLabel,
        assumptions: [...next.assumptions],
        movers: [...next.movers],
        lines: next.lines.map((l) => ({ ...l, basis: l.basis.map((b) => ({ ...b })) })),
        totals: { ...next.totals },
        caveats: [...(next.caveats ?? [])],
      }
    : undefined;
  const unitCost = next?.answers.workstationUnitCost ?? current?.answers.workstationUnitCost;
  if (!actual && !outlook && unitCost === undefined) return undefined;
  return {
    ...(actual ? { planVsActual: actual } : {}),
    ...(outlook ? { outlook } : {}),
    ...(unitCost !== undefined ? { unitCost } : {}),
  };
}
