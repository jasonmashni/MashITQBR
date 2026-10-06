import {
  computeScorecard,
  computeTicketInsights,
  computeTrends,
  indexTrends,
  parsePeriod,
  ticketInsightRecommendations,
  type Brand,
  type Client,
  type ClientGoal,
  type CustomSection,
  type DiscussionItem,
  type MaturityScorecard,
  type MetricCategory,
  type MetricSnapshot,
  type MetricTrend,
  type MetricValue,
  type ReportConfig,
} from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';
import { resolveBrand, type BrandTokens } from './brand.js';

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
    discussion: (args.discussion ?? [])
      .filter((d) => d.includeInReport !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
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
      .replace(/\s*\(([^)]*)\)/g, (m: string, inner: string) => (OPERATOR_CLAUSE.test(inner) ? '' : m))
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
