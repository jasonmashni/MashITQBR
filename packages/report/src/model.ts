import {
  computeScorecard,
  computeTicketInsights,
  computeTrends,
  indexTrends,
  parsePeriod,
  protectionRows,
  ticketInsightRecommendations,
  type Brand,
  type BudgetOutlook,
  type Client,
  type ClientGoal,
  type CustomSection,
  type DiscussionItem,
  type MaturityScorecard,
  type MetricCategory,
  type MetricSnapshot,
  type MetricTrend,
  type MetricValue,
  type ProtectionRow,
  type ReportConfig,
} from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';
import { resolveBrand, type BrandTokens } from './brand.js';
import { formatCurrency } from './format.js';

export interface ReportSectionRow {
  metric: MetricValue;
  trend?: MetricTrend;
}

export interface ReportSection {
  category: MetricCategory;
  title: string;
  /** One-sentence executive takeaway rendered under the section heading. */
  summary?: string;
  rows: ReportSectionRow[];
}

/** Where a discussion item stands, for the page three chip. */
export type ConversationStatus = 'on_plan' | 'in_progress' | 'waiting' | 'done' | 'closed';

/** One "Since last quarter" row on page one. */
export interface SinceLastRow {
  topic: string;
  status: 'done' | 'in_progress' | 'waiting' | 'closed';
  detail?: string;
}

/** A protection question with its scorecard status and the narrative's prose. */
export type ReportProtectionRow = ProtectionRow & { inPlace?: string; thisQuarter?: string };

const CLOSED_STATUS = /closed|resolved|complete/i;

/**
 * Where a discussion item stands: a ticket pushed to Halo and still open is
 * in progress; no action is closed; a planned item nobody answered is
 * waiting; a discussed item (or pushed ticket) whose external status is
 * closed, resolved or complete is done; anything else is on plan.
 */
export function conversationStatus(item: DiscussionItem): ConversationStatus {
  const external = item.externalRef?.status?.trim();
  const externalClosed = !!external && CLOSED_STATUS.test(external);
  if (item.disposition === 'no_action') return 'closed';
  if (externalClosed && (item.status === 'discussed' || item.disposition === 'create_ticket')) return 'done';
  if (item.disposition === 'create_ticket' && external && !externalClosed) return 'in_progress';
  if (item.status === 'planned' && !item.response?.trim()) return 'waiting';
  return 'on_plan';
}

/** Apply live Halo ticket statuses (externalRef id -> status) to discussion items. */
function withLiveStatus(items: DiscussionItem[], statuses: Record<string, string> | undefined): DiscussionItem[] {
  if (!statuses) return items;
  return items.map((d) =>
    d.externalRef?.system === 'halo' && statuses[d.externalRef.id] ? { ...d, externalRef: { ...d.externalRef, status: statuses[d.externalRef.id] } } : d,
  );
}

/** Reportable items in agenda order. */
function reportable(items: DiscussionItem[]): DiscussionItem[] {
  return items.filter((d) => d.includeInReport !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

const SINCE_LAST_MAX = 5;

/** Page four: what the client invested this quarter and what is coming. */
export interface InvestmentModel {
  /** This quarter (finance.quarter_invoiced; 0 when no invoices were read). */
  invoiced: number;
  recurring: number;
  variable: number;
  previousInvoiced?: number;
  /** Invoice lines by category, largest first; recurring when the category is on the recurring agreement. */
  breakdown: Array<{ label: string; amount: number; recurring: boolean }>;
  planVsActual?: { fiscalYearLabel: string; planned: number; spent: number; pct: number; note: string };
  /** Deterministic sentences: warranty refresh, paid-seat use, renewals. */
  comingUp: string[];
  /** The twelve-month outlook, planning quarter only. */
  outlook?: BudgetOutlook;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * The investment page from the spend metrics plus an optional published
 * budget: recurring is the sum of invoice lines whose category also appears
 * in the recurring breakdown (finance.recurring.*); everything else is
 * variable. Undefined when there is nothing to show.
 */
function buildInvestment(
  current: MetricSnapshot,
  previous: MetricSnapshot | undefined,
  budget: { planVsActual?: InvestmentModel['planVsActual']; outlook?: BudgetOutlook; unitCost?: number } | undefined,
): InvestmentModel | undefined {
  const num = (s: MetricSnapshot | undefined, key: string): number | undefined => {
    const v = s?.metrics.find((m) => m.key === key)?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const invoiced = num(current, 'finance.quarter_invoiced');
  if (invoiced === undefined && !budget?.outlook && !budget?.planVsActual) return undefined;

  const norm = (label: string) => label.replace(/\s*\(monthly\)\s*$/i, '').trim().toLowerCase();
  const recurringLabels = new Set(
    current.metrics.filter((m) => m.key.startsWith('finance.recurring.')).map((m) => norm(m.label)),
  );
  const breakdown = current.metrics
    .filter((m) => m.key.startsWith('finance.invoiced.') && typeof m.value === 'number' && m.value > 0)
    .map((m) => ({ label: m.label, amount: m.value as number, recurring: recurringLabels.has(norm(m.label)) }))
    .sort((a, b) => b.amount - a.amount);
  const recurring = Math.round(breakdown.filter((b) => b.recurring).reduce((sum, b) => sum + b.amount, 0) * 100) / 100;
  const total = invoiced ?? 0;

  const comingUp: string[] = [];
  const expired = num(current, 'assets.warranty_expired');
  if (expired !== undefined && expired > 0) {
    const devices = `${expired} ${plural(expired, 'device')} past warranty`;
    comingUp.push(
      budget?.unitCost
        ? `Hardware: ${devices}. At your planning cost of ${formatCurrency(budget.unitCost)} per device that is about ${formatCurrency(expired * budget.unitCost)}.`
        : `Hardware: ${devices}. We will price the replacements with you.`,
    );
  }
  const seats = num(current, 'licenses.total');
  const assigned = num(current, 'licenses.assigned');
  if (seats !== undefined && assigned !== undefined && seats > 0) {
    comingUp.push(`Licensing: ${assigned} of ${seats} paid Microsoft 365 seats in use.`);
  }
  const renewing = num(current, 'finance.contracts_expiring');
  if (renewing !== undefined && renewing > 0) {
    comingUp.push(`Agreements: ${renewing} ${plural(renewing, 'agreement')} ${renewing === 1 ? 'renews' : 'renew'} within 90 days.`);
  }

  return {
    invoiced: total,
    recurring,
    variable: Math.round((total - recurring) * 100) / 100,
    ...(num(previous, 'finance.quarter_invoiced') !== undefined ? { previousInvoiced: num(previous, 'finance.quarter_invoiced') } : {}),
    breakdown,
    ...(budget?.planVsActual ? { planVsActual: budget.planVsActual } : {}),
    comingUp,
    ...(budget?.outlook ? { outlook: budget.outlook } : {}),
  };
}

export interface ReportModel {
  client: { name: string; primaryContact?: string; industry?: string; hipaa?: boolean; complianceStandard?: string };
  period: { id: string; label: string };
  previousPeriod?: { id: string; label: string };
  /** Caller-supplied display date (kept out of the builder to stay deterministic). */
  generatedLabel?: string;
  heldBy?: string;
  /** Resolved branding (Mash IT defaults merged with any per-client override). */
  brand: BrandTokens;
  executive: { headline?: string; paragraphs: string[]; highlights: string[] };
  scorecard: MaturityScorecard;
  trends: MetricTrend[];
  /** Strategic client goals + how IT aligns to them (qualitative; opens the report). */
  goals: ClientGoal[];
  sections: ReportSection[];
  /** Client-authored free-text sections. */
  customSections: CustomSection[];
  /** Captured discussion points / client responses from the review. */
  discussion: DiscussionItem[];
  /** What happened to last quarter's discussion items (page one); empty hides the block. */
  sinceLastQuarter: SinceLastRow[];
  /** The five protection questions (page two), in order. */
  protection: ReportProtectionRow[];
  /** Set when a reopened quarter was locked again: the footer says "Revised on". */
  revisedAt?: string;
  /** Page four (and 4b in the planning quarter); undefined hides it. */
  investment?: InvestmentModel;
  /** General meeting notes. */
  notes?: string;
  recommendations: string[];
  /** Vendor reports / uploads attached to this QBR (rendered as an appendix). */
  documents: Array<{ name: string; source: string }>;
  /**
   * Client-readable sync caveats (sampled or partial counts), filtered by
   * clientCaveats. Rendered as a "Data confidence" note so a sampled count is
   * never read as a complete one; setup and connection notes stay internal.
   */
  dataConfidence: string[];
}

const SECTION_ORDER: Array<{ category: MetricCategory; title: string }> = [
  { category: 'operations', title: 'Operational Stability & Support' },
  { category: 'security', title: 'Security & Risk Snapshot' },
  { category: 'identity', title: 'Identity & Access' },
  { category: 'backup', title: 'Backup & Recovery' },
  { category: 'infrastructure', title: 'Infrastructure & Refresh Risk' },
  { category: 'spend', title: 'IT Spend Overview' },
];

/** Build the renderer-agnostic report view-model. */
export function buildReportModel(args: {
  client: Client;
  current: MetricSnapshot;
  previous?: MetricSnapshot;
  narrative?: NarrativeOutput;
  heldBy?: string;
  generatedLabel?: string;
  /** Per-client customization: hidden sections, custom sections, branding. */
  config?: ReportConfig;
  /** Org-level branding from Settings (Mash IT logo + house colors). */
  orgBrand?: Brand;
  /** Captured review discussion + responses. */
  discussion?: DiscussionItem[];
  notes?: string;
  /** Attached vendor reports / uploads for the appendix. */
  documents?: Array<{ name: string; source: string }>;
  /** Labels of metrics reviewed out (their caveats stay off the report). */
  excludedLabels?: string[];
  /** The previous quarter's discussion, for "Since last quarter". */
  previousDiscussion?: DiscussionItem[];
  /** Live Halo ticket statuses by externalRef id; they refine the stored status. */
  ticketStatuses?: Record<string, string>;
  /** When a reopened quarter was locked again. */
  revisedAt?: string;
  /** Published budget plan data; absent until a plan exists (workstream D). */
  budget?: { planVsActual?: InvestmentModel['planVsActual']; outlook?: BudgetOutlook; unitCost?: number };
}): ReportModel {
  const { client, current, previous, narrative, config } = args;
  const period = parsePeriod(current.period);
  const hidden = new Set(config?.hiddenSections ?? []);
  // Hidden sections drop out of the trends too, so the movers chart, the deck's
  // QoQ slide and the fallback recommendations cannot leak a hidden category.
  const trends = computeTrends(current, previous).filter((t) => !hidden.has(t.category));
  const trendIndex = indexTrends(trends);
  const scorecard = computeScorecard(current);
  // Categories are lowercase tokens by contract, but tolerate case drift from
  // older cached narratives.
  const summaries = new Map((narrative?.section_summaries ?? []).map((s) => [s.category.trim().toLowerCase(), s.summary]));
  const sections: ReportSection[] = [];
  for (const { category, title } of SECTION_ORDER) {
    if (hidden.has(category)) continue;
    const rows = current.metrics
      .filter((m) => m.category === category)
      .map((metric) => ({ metric, trend: trendIndex.get(metric.key) }));
    if (rows.length) sections.push({ category, title, summary: summaries.get(category), rows });
  }

  // Recommendations: the AI/offline narrative leads (now grounded in ticket
  // insights). With no narrative recommendations at all, fall back to the
  // ticket-history talking points first, then generic scorecard remediations —
  // the specific beats the generic.
  // Example ticket subjects never reach a HIPAA client's report: a helpdesk
  // subject line can carry a patient name, and an executive summary is no
  // place for it even when the reader is the covered entity.
  const insightRecs = ticketInsightRecommendations(computeTicketInsights(current.metrics, trends, 6, { examples: client.hipaa !== true }));
  const recommendations = narrative?.recommendations?.length
    ? narrative.recommendations
    : [...insightRecs, ...scorecard.remediations.map((r) => `${r.title}: ${r.evidence}`)].slice(0, 6);

  return {
    client: {
      name: client.name,
      primaryContact: client.primaryContact?.name,
      industry: client.industry,
      hipaa: client.hipaa,
      complianceStandard: client.complianceStandard,
    },
    period: { id: period.id, label: period.label },
    previousPeriod: previous ? { id: parsePeriod(previous.period).id, label: parsePeriod(previous.period).label } : undefined,
    generatedLabel: args.generatedLabel,
    heldBy: args.heldBy,
    brand: resolveBrand(config?.brand, args.orgBrand),
    executive: {
      headline: narrative?.headline,
      paragraphs: narrative?.summary_paragraphs ?? [],
      highlights: narrative?.highlights ?? [],
    },
    scorecard,
    trends,
    // Only goals with a real title; ordered planned/on-track before at-risk/achieved
    // so the "what we're working toward" story leads.
    goals: (client.goals ?? []).filter((g) => g.title.trim()),
    sections,
    customSections: config?.customSections ?? [],
    // Only items marked for the report, in agenda order.
    discussion: reportable(withLiveStatus(args.discussion ?? [], args.ticketStatuses)),
    sinceLastQuarter:
      config?.showSinceLastQuarter === false
        ? []
        : reportable(withLiveStatus(args.previousDiscussion ?? [], args.ticketStatuses))
            .slice(0, SINCE_LAST_MAX)
            .map((d) => {
              const status = conversationStatus(d);
              const detail = d.response?.trim() || (d.externalRef?.system === 'halo' ? `Ticket ${d.externalRef.id}` : undefined);
              return { topic: d.topic, status: status === 'on_plan' ? 'in_progress' : status, ...(detail ? { detail } : {}) };
            }),
    protection: protectionRows(scorecard).map((row) => {
      const prose = narrative?.protection?.find((p) => p.question === row.id);
      return prose ? { ...row, inPlace: prose.inPlace, thisQuarter: prose.thisQuarter } : row;
    }),
    ...(args.revisedAt ? { revisedAt: args.revisedAt } : {}),
    ...(() => {
      const investment = hidden.has('spend') ? undefined : buildInvestment(current, previous, args.budget);
      return investment ? { investment } : {};
    })(),
    notes: args.notes,
    recommendations,
    documents: args.documents ?? [],
    // Only client-readable caveats print; the Data tab keeps the full list.
    dataConfidence: clientCaveats(current.warnings ?? [], {
      excludedKeys: new Set(config?.excludedMetrics ?? []),
      hiddenCategories: hidden,
      excludedLabels: new Set(args.excludedLabels ?? []),
    }),
  };
}

// ---------------------------------------------------------------------------
// Client caveats: which sync warnings may print on a client deliverable.
// ---------------------------------------------------------------------------

/** Caveats a client should read: how complete a count is, never how to fix a connection. */
const CLIENT_CAVEAT_ALLOW: RegExp[] = [
  /counted from the (?:first|most recent) \d/i,
  /read from the first/i,
  /\bsampled\b/i,
  /\btruncated\b/i,
  /lower bound/i,
  /latest month/i,
  /latest monthly/i,
  /not reported/i,
  /could not be measured/i,
  /not measured/i,
  /\bwithheld\b/i,
  /excluded\b.*ended contract/i,
  /billing period/i,
  /\bpartial\b/i,
  /\bunderstated\b/i,
];

/** Clauses that are operator setup or troubleshooting notes, never client copy. */
const OPERATOR_CLAUSE =
  /\b(?:check (?:the|whether|api)|confirm\b|configure|mapped\b|mapping\b|re-map|picker|allowlist|connection|api access|set (?:the|a)\b|fields seen|response fields|tuning|tuned\b|credentials?\b|token\b|unauthori[sz]ed|forbidden|mcp\b|share a sample|assign item groups|client id\(s\)|rename the|clear the filter)/i;

/** A metric key quoted in the text, e.g. "identity.mfa_coverage_pct". */
const QUOTED_METRIC_KEY = /["“'‘][a-z0-9_]+\.[a-z0-9_.]+["”'’]/i;

/** Words that tie a caveat to one report section (so a hidden section's caveat stays internal). */
const CATEGORY_WORDS: Record<MetricCategory, RegExp> = {
  operations: /\btickets?\b|\bSLA\b|service-desk|help ?desk|Operational Stability/i,
  security: /antivirus|\bAV\b|\bpatch|\bEDR\b|email security|email events|threat|phish|vulnerab|cyber resilience|browser extension|credential-block|blocked-hostname|Security & Risk/i,
  identity: /\bMFA\b|identit|sign-in|licensed users|global admin|\bguests?\b|Conditional Access|Identity & Access/i,
  backup: /backup|backed-up|Dropsuite|OneDrive|SharePoint|mailbox|Backup & Recovery/i,
  infrastructure: /\bdevices?\b|warrant|lifecycle|\bassets?\b|expiration|renewal|hardware|Refresh Risk/i,
  spend: /\bspend\b|\bMRR\b|invoice|contract|billing|IT Spend/i,
};

function stripSource(w: string): string {
  return w.replace(/^(?:\[[^\]]*\]\s*)+/, '').trim();
}

/** Cut error detail: anything after "unavailable:" or from an HTTP status onward. */
function cutErrorDetail(w: string): string {
  let out = w.replace(/\bunavailable:.*$/i, 'unavailable');
  out = out.replace(/\s*\b(?:responded|returned|HTTP|status(?: code)?)\s+[1-5]\d\d\b.*$/i, '');
  return out.trim();
}

function mentionsExcluded(text: string, keys: Set<string>, labels: Set<string>): boolean {
  const lower = text.toLowerCase();
  for (const key of keys) {
    if (lower.includes(key.toLowerCase())) return true;
    const tail = (key.split('.').pop() ?? '').replace(/_(?:pct|gb|quarter|count)$/i, '');
    if (tail.includes('_') && lower.includes(tail.replace(/_/g, ' ').toLowerCase())) return true;
  }
  for (const label of labels) {
    const l = label.trim().toLowerCase();
    if (l && lower.includes(l)) return true;
  }
  return false;
}

/**
 * Keep only the sync caveats a client should read on a deliverable: how
 * complete a count is (sampled, truncated, a lower bound, a latest-month
 * figure, a metric not reported). Connection errors, HTTP statuses, setup
 * instructions, source tags and notes naming metric keys stay internal (the
 * Data tab still shows the full list), as do caveats about a metric the AM
 * excluded or a section hidden for this client.
 */
export function clientCaveats(
  warnings: string[],
  opts: { excludedKeys: Set<string>; hiddenCategories: Set<string>; excludedLabels?: Set<string> },
): string[] {
  const labels = opts.excludedLabels ?? new Set<string>();
  const out: string[] = [];
  for (const raw of warnings) {
    const tagless = stripSource(raw.trim());
    if (!tagless || QUOTED_METRIC_KEY.test(tagless)) continue;
    const cut = cutErrorDetail(tagless);
    // Clause by clause: drop operator asides and instructions, keep the fact.
    const clauses = cut
      // Parentheticals that carry operator detail or an identifier (a tenant
      // scope, raw response field names) never reach a client.
      .replace(/\s*\(([^)]*)\)/g, (m: string, inner: string) =>
        OPERATOR_CLAUSE.test(inner) || /\bscope\b|response fields|\btenant\b|\bcustomer id\b|\bid\b/i.test(inner) ? '' : m,
      )
      .split(/\s*—\s*|;\s+/)
      .map((c) => c.trim().replace(/[.,]+$/, ''))
      .filter((c) => c && !OPERATOR_CLAUSE.test(c));
    if (!clauses.length) continue;
    let text = clauses.join(', ').replace(/\s*—\s*/g, ', ').trim();
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (!/[.!?]$/.test(text)) text += '.';
    if (!CLIENT_CAVEAT_ALLOW.some((re) => re.test(text))) continue;
    if (mentionsExcluded(text, opts.excludedKeys, labels)) continue;
    if ([...opts.hiddenCategories].some((c) => CATEGORY_WORDS[c as MetricCategory]?.test(text))) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}
