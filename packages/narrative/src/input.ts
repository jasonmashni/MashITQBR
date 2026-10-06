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
   * the offline (no-AI) recommendations. `figures` are the numbers the insight
   * computed; they are the only insight numbers the guardrail allows (digits in
   * ticket subjects such as "Windows 11" or "P73" are not figures).
   */
  ticketInsights?: Array<{ title: string; detail: string; severity: string; figures?: number[] }>;
  /** The client's strategic goals (qualitative) so the narrative can align to them. */
  goals?: Array<{ title: string; alignment?: string; status: string; targetPeriod?: string }>;
  /**
   * Vendor reports attached to this QBR (name + source). The model must not
   * claim we lack visibility/coverage in a domain an attached report covers —
   * e.g. a Synology "Active Backup" report proves device backup exists even when
   * our API-based backup figure is 0 (Synology has no API).
   */
  documents?: Array<{ name: string; source: string }>;
  /** Present only when the author set direction — changes bust the AI cache. */
  direction?: NarrativeDirection;
  /**
   * System notes about what the input deliberately leaves out (for example,
   * ticket samples withheld for a HIPAA client). Present only when non-empty.
   */
  notes?: string[];
}

/** Note sent to the model when ticket subjects are withheld for a HIPAA client. */
export const PHI_WITHHELD_NOTE =
  'HIPAA client: ticket samples withheld and insight examples omitted, because ticket subjects can contain PHI. Do not guess at or describe individual tickets.';

/**
 * Assemble the narrative input from a client + current/previous snapshots.
 *
 * For a HIPAA client (`client.hipaa === true`) ticket subjects never leave the
 * app unless `opts.allowPhi` is true (NARRATIVE_ALLOW_PHI, only with a BAA in
 * place): ticketSamples and insight examples are omitted and a note says so.
 */
export function buildNarrativeInput(
  args: {
    client: Client;
    current: MetricSnapshot;
    previous?: MetricSnapshot;
    direction?: NarrativeDirection;
    /** Vendor reports attached to this QBR — so the model won't contradict them. */
    documents?: Array<{ name: string; source: string }>;
  },
  opts: { allowPhi?: boolean } = {},
): NarrativeInput {
  const { client, current, previous } = args;
  const withholdSubjects = client.hipaa === true && opts.allowPhi !== true;
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
  const ticketInsights = computeTicketInsights(current.metrics, trends, undefined, { examples: !withholdSubjects });
  const samples = ticketDigest(current.metrics);
  const notes = withholdSubjects && hasTicketDigest(samples) ? [PHI_WITHHELD_NOTE] : [];

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
    ticketSamples: !withholdSubjects && hasTicketDigest(samples) ? samples : undefined,
    ticketInsights: ticketInsights.length
      ? ticketInsights.map((i) => ({ title: i.title, detail: i.detail, severity: i.severity, figures: i.figures }))
      : undefined,
    goals: goals.length ? goals : undefined,
    documents: args.documents?.length ? args.documents : undefined,
    direction,
    notes: notes.length ? notes : undefined,
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

  // The ticket-insight talking points carry the figures they computed
  // (recurring-theme counts, SLA breaches…). Never regex the title/detail text:
  // it embeds ticket subjects whose digits ("Windows 11", "P73") aren't figures.
  for (const i of input.ticketInsights ?? []) {
    for (const n of i.figures ?? []) add(n);
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

/**
 * Every ticket subject string the input carries: the ticket samples plus the
 * curly-quoted tokens and examples inside insight titles and details. The
 * guardrail ignores a quoted span only when it matches one of these.
 */
export function buildAllowedQuotes(input: NarrativeInput): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    const t = s?.trim();
    if (t) out.add(t);
  };
  const samples = input.ticketSamples;
  if (samples) for (const list of [samples.incidents, samples.changes, samples.slaBreaches]) for (const s of list ?? []) add(s);
  for (const i of input.ticketInsights ?? []) {
    const extra = i as { evidence?: string[]; examples?: string[] };
    for (const s of extra.evidence ?? []) add(s);
    for (const s of extra.examples ?? []) add(s);
    for (const text of [i.title, i.detail]) for (const m of text.matchAll(/“([^”]*)”/g)) add(m[1]);
  }
  return [...out];
}
