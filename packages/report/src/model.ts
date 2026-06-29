import {
  computeScorecard,
  computeTrends,
  indexTrends,
  parsePeriod,
  type Client,
  type MaturityScorecard,
  type MetricCategory,
  type MetricSnapshot,
  type MetricTrend,
  type MetricValue,
} from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';

export interface ReportSectionRow {
  metric: MetricValue;
  trend?: MetricTrend;
}

export interface ReportSection {
  category: MetricCategory;
  title: string;
  rows: ReportSectionRow[];
}

export interface ReportModel {
  client: { name: string; primaryContact?: string; industry?: string; hipaa?: boolean };
  period: { id: string; label: string };
  previousPeriod?: { id: string; label: string };
  /** Caller-supplied display date (kept out of the builder to stay deterministic). */
  generatedLabel?: string;
  heldBy?: string;
  executive: { headline?: string; paragraphs: string[]; highlights: string[] };
  scorecard: MaturityScorecard;
  trends: MetricTrend[];
  sections: ReportSection[];
  recommendations: string[];
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
}): ReportModel {
  const { client, current, previous, narrative } = args;
  const period = parsePeriod(current.period);
  const trends = computeTrends(current, previous);
  const trendIndex = indexTrends(trends);
  const scorecard = computeScorecard(current);

  const sections: ReportSection[] = [];
  for (const { category, title } of SECTION_ORDER) {
    const rows = current.metrics
      .filter((m) => m.category === category)
      .map((metric) => ({ metric, trend: trendIndex.get(metric.key) }));
    if (rows.length) sections.push({ category, title, rows });
  }

  const recommendations =
    narrative?.recommendations?.length
      ? narrative.recommendations
      : scorecard.remediations.map((r) => `${r.title}: ${r.evidence}`);

  return {
    client: {
      name: client.name,
      primaryContact: client.primaryContact?.name,
      industry: client.industry,
      hipaa: client.hipaa,
    },
    period: { id: period.id, label: period.label },
    previousPeriod: previous ? { id: parsePeriod(previous.period).id, label: parsePeriod(previous.period).label } : undefined,
    generatedLabel: args.generatedLabel,
    heldBy: args.heldBy,
    executive: {
      headline: narrative?.headline,
      paragraphs: narrative?.summary_paragraphs ?? [],
      highlights: narrative?.highlights ?? [],
    },
    scorecard,
    trends,
    sections,
    recommendations,
  };
}
