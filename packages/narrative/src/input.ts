import {
  asNumber,
  computeScorecard,
  computeTrends,
  parsePeriod,
  type Client,
  type MaturityScorecard,
  type MetricSnapshot,
  type MetricTrend,
} from '@mashit/core';

/** The compact, pre-computed bundle handed to the model. No raw records. */
export interface NarrativeInput {
  client: { name: string; industry?: string; hipaa?: boolean };
  period: { id: string; label: string };
  previousPeriod?: { id: string; label: string };
  metrics: Array<{ key: string; label: string; value: number | string | boolean | null; unit?: string; category: string }>;
  trends: MetricTrend[];
  scorecard: {
    overall: MaturityScorecard['overall'];
    functions: Array<{ function: string; score: number | null; rating: string }>;
    remediations: Array<{ title: string; score: number | null; evidence: string }>;
  };
}

/** Assemble the narrative input from a client + current/previous snapshots. */
export function buildNarrativeInput(args: {
  client: Client;
  current: MetricSnapshot;
  previous?: MetricSnapshot;
}): NarrativeInput {
  const { client, current, previous } = args;
  const period = parsePeriod(current.period);
  const trends = computeTrends(current, previous);
  const scorecard = computeScorecard(current);

  return {
    client: { name: client.name, industry: client.industry, hipaa: client.hipaa },
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

  // Period years / quarter numbers appear in prose and shouldn't be flagged.
  for (const p of [input.period, input.previousPeriod]) {
    if (!p) continue;
    const parsed = parsePeriod(p.id);
    add(parsed.year);
    add(parsed.quarter);
  }

  return [...allowed];
}
