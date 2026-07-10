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
}): ReportModel {
  const { client, current, previous, narrative, config } = args;
  const period = parsePeriod(current.period);
  const trends = computeTrends(current, previous);
  const trendIndex = indexTrends(trends);
  const scorecard = computeScorecard(current);

  const hidden = new Set(config?.hiddenSections ?? []);
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
  const insightRecs = ticketInsightRecommendations(computeTicketInsights(current.metrics, trends));
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
  };
}
