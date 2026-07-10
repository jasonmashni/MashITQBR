import Anthropic from '@anthropic-ai/sdk';
import { computeTicketInsights, type TicketInsight } from '@mashit/core';
import type { ReportModel } from '@mashit/report';
import { DOC_MATCH_MODEL_ID } from './docMatch.js';

/**
 * Consultative QBR agenda suggestions: 2–3 high-value talking points drawn from
 * the quarter's own data (ticket trends, security/compliance gaps, refresh
 * risk, backup, spend). The account manager accepts the ones worth raising and
 * expands on them, or ignores them — they are prompts, not the final agenda.
 *
 * Runs on demand (one cheap Sonnet call per click) with a deterministic offline
 * fallback so it's useful even with AI turned off or unavailable.
 */

export interface AgendaSuggestion {
  /** The talking point / question to raise. */
  topic: string;
  /** One line citing the figure behind it (context for the author). */
  rationale: string;
}

interface Mover {
  label: string;
  current: number;
  previous: number | null;
  deltaPct: number | null;
  sentiment: string;
}

export interface AgendaContext {
  clientName: string;
  periodLabel: string;
  industry?: string;
  complianceStandard?: string;
  /** Biggest quarter-over-quarter movers (worsening first). */
  movers: Mover[];
  /** Lowest-scoring NIST functions (weakest maturity areas). */
  weakFunctions: Array<{ function: string; score: number | null; rating: string }>;
  /** Decision-relevant headline metrics that are present this quarter. */
  metrics: Array<{ key: string; label: string; value: number | string | boolean | null; unit?: string }>;
  /** Consultative talking points mined from the actual ticket history (recurring issues, SLA misses, change activity). */
  ticketInsights: TicketInsight[];
}

/** Metric keys worth surfacing for a consultative discussion, when present. */
const HEADLINE_KEYS = [
  'tickets.total',
  'tickets.opened',
  'tickets.open',
  'tickets.closed',
  'identity.mfa_coverage_pct',
  'patch.compliance_pct',
  'endpoints.av_coverage_pct',
  'backup.protected_accounts',
  'backup.failed_jobs',
  'backup.coverage_pct',
  'assets.warranty_expired',
  'assets.warranty_expiring',
  'vuln.critical',
  'vuln.high',
  'huntress.edr_incidents',
  'email.threats_blocked',
  'infra.risky_services',
  'finance.mrr',
  'finance.quarter_invoiced',
  'finance.contracts_expiring',
];

const SENTIMENT_RANK: Record<string, number> = { negative: 0, neutral: 1, positive: 2, na: 3 };

/** Distil the report model into the compact signal set the suggester reasons over. */
export function buildAgendaContext(model: ReportModel): AgendaContext {
  const byKey = new Map(model.sections.flatMap((s) => s.rows.map((r) => [r.metric.key, r.metric] as const)));

  const movers: Mover[] = model.trends
    .filter((t) => t.previous !== null && t.current !== null && t.deltaPct !== null && t.direction !== 'flat')
    .map((t) => ({ label: t.label, current: t.current as number, previous: t.previous, deltaPct: t.deltaPct, sentiment: t.sentiment }))
    // Worsening + biggest magnitude first.
    .sort((a, b) => (SENTIMENT_RANK[a.sentiment]! - SENTIMENT_RANK[b.sentiment]!) || Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, 6);

  const weakFunctions = model.scorecard.functions
    .filter((f) => f.score !== null)
    .sort((a, b) => (a.score as number) - (b.score as number))
    .slice(0, 3)
    .map((f) => ({ function: f.function, score: f.score, rating: f.rating }));

  const metrics = HEADLINE_KEYS.flatMap((key) => {
    const m = byKey.get(key);
    return m ? [{ key, label: m.label, value: m.value, unit: m.unit }] : [];
  });

  const ticketInsights = computeTicketInsights(
    model.sections.flatMap((s) => s.rows.map((r) => r.metric)),
    model.trends,
  );

  return {
    clientName: model.client.name,
    periodLabel: model.period.label,
    industry: model.client.industry,
    complianceStandard: model.client.complianceStandard,
    movers,
    weakFunctions,
    metrics,
    ticketInsights,
  };
}

const num = (ctx: AgendaContext, key: string): number | null => {
  const m = ctx.metrics.find((x) => x.key === key);
  return typeof m?.value === 'number' ? m.value : null;
};

/**
 * Deterministic, data-driven agenda when AI is off or unavailable. Ranks the
 * most material risks/changes and returns up to three.
 */
export function offlineAgenda(ctx: AgendaContext): AgendaSuggestion[] {
  const out: AgendaSuggestion[] = [];
  const compliance = ctx.complianceStandard ? ` (relevant to ${ctx.complianceStandard})` : '';

  // Ticket-history talking points lead — recurring issues, SLA misses, change
  // activity are the most consultative, specific things to raise with the POC.
  for (const i of ctx.ticketInsights) {
    out.push({ topic: i.title, rationale: i.detail });
    if (out.length >= 3) return out.slice(0, 3);
  }

  const renewing = num(ctx, 'finance.contracts_expiring');
  if (renewing && renewing > 0) {
    out.push({
      topic: 'Confirm renewals for agreements coming due',
      rationale: `${renewing} agreement(s) are up for renewal within 90 days — a proactive renewal conversation protects recurring revenue and continuity.`,
    });
  }

  const warrantyExpired = num(ctx, 'assets.warranty_expired');
  if (warrantyExpired && warrantyExpired > 0) {
    const soon = num(ctx, 'assets.warranty_expiring');
    out.push({
      topic: 'Approve a hardware refresh plan for aging equipment',
      rationale: `${warrantyExpired} device(s) are out of warranty${soon ? ` and ${soon} more expire soon` : ''} — a refresh reduces failure and downtime risk.`,
    });
  }

  const backupFailed = num(ctx, 'backup.failed_jobs');
  if (backupFailed && backupFailed > 0) {
    out.push({
      topic: 'Resolve recent backup failures and confirm recovery readiness',
      rationale: `${backupFailed} backup job(s) failed this quarter — worth confirming coverage and a restore test${compliance}.`,
    });
  }

  const critical = num(ctx, 'vuln.critical');
  if (critical && critical > 0) {
    out.push({
      topic: 'Prioritize remediation of critical vulnerabilities',
      rationale: `${critical} critical vulnerability(ies) are open — agree an owner and timeline to close them.`,
    });
  }

  const mfa = num(ctx, 'identity.mfa_coverage_pct');
  if (mfa !== null && mfa < 90) {
    out.push({
      topic: 'Close the MFA coverage gap',
      rationale: `MFA sits at ${Math.round(mfa)}% — bringing the remaining accounts in tightens identity security${compliance}.`,
    });
  }

  const patch = num(ctx, 'patch.compliance_pct');
  if (patch !== null && patch < 85) {
    out.push({
      topic: 'Improve patch compliance across the fleet',
      rationale: `Patch compliance is ${Math.round(patch)}% — review the lagging devices and any blockers.`,
    });
  }

  // Biggest worsening trend that isn't already covered above.
  const worseningMover = ctx.movers.find((m) => m.sentiment === 'negative');
  if (worseningMover && worseningMover.deltaPct !== null) {
    const dir = worseningMover.deltaPct > 0 ? 'rose' : 'fell';
    out.push({
      topic: `Discuss the change in ${worseningMover.label.toLowerCase()}`,
      rationale: `${worseningMover.label} ${dir} ${Math.abs(Math.round(worseningMover.deltaPct))}% vs last quarter (${worseningMover.previous} → ${worseningMover.current}) — worth understanding the driver.`,
    });
  }

  // Weakest maturity function, as an improvement theme.
  const weakest = ctx.weakFunctions[0];
  if (out.length < 3 && weakest && weakest.score !== null) {
    out.push({
      topic: `Set a plan to strengthen ${weakest.function}`,
      rationale: `${weakest.function} is the lowest maturity area (score ${Math.round(weakest.score)}/100) — a good target for next quarter.`,
    });
  }

  return out.slice(0, 3);
}

export type AgendaModel = (ctx: AgendaContext) => Promise<AgendaSuggestion[]>;

const AGENDA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'rationale'],
        properties: {
          topic: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

const SYSTEM = `You help an MSP account manager prep a CONSULTATIVE quarterly business review. Given this quarter's metrics, quarter-over-quarter trends, and ticket-history insights for one client, propose the 2-3 highest-value talking points to raise with the point of contact — decisions, risks, and improvement opportunities.

The input includes "ticketInsights": talking points already mined from the client's ACTUAL ticket history this quarter — recurring incident themes (the same issue coming up repeatedly), change-request activity, SLA misses, and incident-volume shifts. These are the most valuable, specific material you have.

Rules:
- PRIORITIZE the ticketInsights when present — a recurring issue worth root-causing, an SLA miss worth reviewing, or change activity worth confirming is far more useful to raise with the client than generic advice. Turn each into a concrete discussion point.
- Then consider the metrics/trends for anything material not already covered (hardware refresh, security/compliance gaps, backup & continuity, renewals, spend).
- Each item has a short "topic" phrased as a discussion point or decision, plus a one-sentence "rationale" that cites a SPECIFIC number from the provided data.
- Use ONLY numbers present in the data. Never invent or estimate figures.
- Prefer the most material items. Skip anything already healthy — do not pad to three.
- Keep it executive and concise. 2-3 items maximum.
Return only the structured object.`;

/** Claude-backed suggester (structured output). Defaults to the cheaper Sonnet doc model. */
export function createClaudeAgendaSuggester(client: Anthropic = new Anthropic(), modelId: string = DOC_MATCH_MODEL_ID): AgendaModel {
  return async (ctx) => {
    const params = {
      model: modelId,
      max_tokens: 900,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: AGENDA_SCHEMA } },
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(ctx) }] }],
    };
    const response = await client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let parsed: { suggestions?: unknown };
    try {
      parsed = JSON.parse(text) as { suggestions?: unknown };
    } catch {
      throw new Error(`Agenda suggester did not return valid JSON. Got: ${text.slice(0, 160)}`);
    }
    const rows = Array.isArray(parsed.suggestions) ? (parsed.suggestions as Array<Record<string, unknown>>) : [];
    const out: AgendaSuggestion[] = [];
    for (const r of rows) {
      const topic = typeof r['topic'] === 'string' ? r['topic'].trim() : '';
      const rationale = typeof r['rationale'] === 'string' ? r['rationale'].trim() : '';
      if (topic) out.push({ topic, rationale });
    }
    return out.slice(0, 3);
  };
}
