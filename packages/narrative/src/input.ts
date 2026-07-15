import {
  asNumber,
  computeScorecard,
  computeTicketInsights,
  computeTrends,
  hasTicketDigest,
  parsePeriod,
  ticketDigest,
  type Client,
  type MaturityScorecard,
  type MetricSnapshot,
  type MetricTrend,
  type TicketDigest,
} from '@mashit/core';

/** Author steering for the narrative (focus, standing guidance, compliance). */
export interface NarrativeDirection {
  /** What this QBR should emphasize (e.g. "business security", "continuity"). */
  focus?: string;
  /** Standing free-form guidance from the author. */
  guidance?: string;
  /** Per-section comments, keyed by metric category. */
  sectionGuidance?: Record<string, string>;
}

/** The compact, pre-computed bundle handed to the model. No raw records. */
export interface NarrativeInput {
  client: { name: string; industry?: string; hipaa?: boolean; complianceStandard?: string };
  period: { id: string; label: string };
  previousPeriod?: { id: string; label: string };
  metrics: Array<{ key: string; label: string; value: number | string | boolean | null; unit?: string; category: string }>;
  trends: MetricTrend[];
  scorecard: {
    overall: MaturityScorecard['overall'];
    functions: Array<{ function: string; score: number | null; rating: string }>;
    remediations: Array<{ title: string; score: number | null; evidence: string }>;
  };
  /**
   * A sample of the ACTUAL ticket subjects this quarter, grouped by type. The
   * model reads these to find genuine recurring problems and opportunities —
   * far better than keyword counts, which can't tell a naming-convention prefix
   * from a real issue.
   */
  ticketSamples?: TicketDigest;
  /**
   * Deterministic keyword-derived talking points — recurring themes, change
   * activity, SLA misses. Kept as a rough hint for the model and the source for
   * the offline (no-AI) recommendations.
   */
  ticketInsights?: Array<{ title: string; detail: string; severity: string }>;
  /** The client's strategic goals (qualitative) so the narrative can align to them. */
  goals?: Array<{ title: string; alignment?: string; status: string; targetPeriod?: string }>;
  /** Present only when the author set direction — changes bust the AI cache. */
  direction?: NarrativeDirection;
}

/** Assemble the narrative input from a client + current/previous snapshots. */
export function buildNarrativeInput(args: {
  client: Client;
  current: MetricSnapshot;
  previous?: MetricSnapshot;
  direction?: NarrativeDirection;
}): NarrativeInput {
  const { client, current, previous } = args;
  const goals = (client.goals ?? [])
    .filter((g) => g.title.trim())
    .map((g) => ({ title: g.title, alignment: g.alignment, status: g.status, targetPeriod: g.targetPeriod }));
  const direction =
    args.direction && (args.direction.focus || args.direction.guidance || Object.keys(args.direction.sectionGuidance ?? {}).length > 0)
      ? args.direction
      : undefined;
  const period = parsePeriod(current.period);
  const trends = computeTrends(current, previous);
  const scorecard = computeScorecard(current);
  const ticketInsights = computeTicketInsights(current.metrics, trends);
  const samples = ticketDigest(current.metrics);

  return {
    client: { name: client.name, industry: client.industry, hipaa: client.hipaa, complianceStandard: client.complianceStandard },
    period: { id: period.id, label: period.label },
    previousPeriod: previous
      ? { id: parsePeriod(previous.period).id, label: parsePeriod(previous.period).label }
      : undefined,
    metrics: current.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      value: m.value,
      unit: m.unit,
      category: m.category,
    })),
    trends,
    scorecard: {
      overall: scorecard.overall,
      functions: scorecard.functions.map((f) => ({ function: f.function, score: f.score, rating: f.rating })),
      remediations: scorecard.remediations.map((r) => ({ title: r.title, score: r.score, evidence: r.evidence })),
    },
    ticketSamples: hasTicketDigest(samples) ? samples : undefined,
    ticketInsights: ticketInsights.length
      ? ticketInsights.map((i) => ({ title: i.title, detail: i.detail, severity: i.severity }))
      : undefined,
    goals: goals.length ? goals : undefined,
    direction,
  };
}

/**
 * The set of numbers the model is allowed to cite — every value we computed.
 * Used by the figure-verification guardrail to catch fabricated statistics.
 */
export function buildAllowedNumbers(input: NarrativeInput): number[] {
  const allowed = new Set<number>();
  const add = (n: number | null | undefined) => {
    if (typeof n === 'number' && Number.isFinite(n)) allowed.add(n);
  };

  for (const m of input.metrics) add(asNumber(m.value));

  for (const t of input.trends) {
    add(t.current);
    add(t.previous);
    add(t.deltaAbs);
    add(t.deltaPct);
    // The model may cite a delta's magnitude without its sign.
    if (t.deltaAbs !== null) add(Math.abs(t.deltaAbs));
    if (t.deltaPct !== null) add(Math.abs(t.deltaPct));
  }

  add(input.scorecard.overall.score);
  add(input.scorecard.overall.coverage);
  add(input.scorecard.overall.coverage * 100); // coverage often cited as a %
  for (const f of input.scorecard.functions) add(f.score);
  for (const r of input.scorecard.remediations) add(r.score);

  // Counts embedded in the ticket-insight talking points (recurring-theme
  // counts, SLA breaches…) are figures we computed — let the model quote them.
  for (const i of input.ticketInsights ?? []) {
    for (const match of `${i.title} ${i.detail}`.match(/\d+(?:\.\d+)?/g) ?? []) add(Number(match));
  }

  // Period years / quarter numbers appear in prose and shouldn't be flagged.
  for (const p of [input.period, input.previousPeriod]) {
    if (!p) continue;
    const parsed = parsePeriod(p.id);
    add(parsed.year);
    add(parsed.quarter);
  }

  return [...allowed];
}
