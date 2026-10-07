import { createHash } from 'node:crypto';
import { previousPeriod, type Brand, type DiscussionItem, type MetricValue, type ReportConfig } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildAllowedQuotes,
  buildNarrativeInput,
  draftOfflineNarrative,
  generateNarrative,
  NARRATIVE_MODEL_ID,
  PROTECTION_QUESTION_IDS,
  verifyNarrative,
  type NarrativeModel,
  type NarrativeOutput,
  type NarrativeResult,
  type PlanItem,
} from '@mashit/narrative';
import { buildReportModel, renderReportHtml, type ReportModel } from '@mashit/report';
import type { QbrDataSource } from './dataSource.js';

/**
 * Persistent cache for AI narratives, keyed by an input hash. The hash covers
 * the full narrative input plus the model id, so a data re-sync or a model
 * upgrade regenerates rather than serving stale prose.
 */
export interface NarrativeCache {
  get(hash: string): Promise<NarrativeResult | undefined>;
  put(hash: string, result: NarrativeResult): Promise<void>;
}

/**
 * Human narrative overrides (undefined field = keep the generated text). The
 * v4 fields cover every prose field; the v3 lists survive for edits saved
 * before v4 and win over what is derived from the v4 fields.
 */
export interface NarrativeEditFields {
  headline?: string;
  lede?: string;
  did?: string[];
  saw?: string[];
  decisions?: NarrativeOutput['decisions'];
  plan?: NarrativeOutput['plan'];
  protection?: NarrativeOutput['protection'];
  summary_paragraphs?: string[];
  highlights?: string[];
  recommendations?: string[];
}

const PLAN_COLUMNS = ['now', 'next', 'later'] as const;

/**
 * Parse a narrative-edit request body into edit fields: strings trimmed,
 * blanks and malformed entries dropped, undefined when nothing was edited.
 * The PUT narrative handler stores what this returns (plus editedBy/At).
 */
export function narrativeEditsFromBody(body: Record<string, unknown>): NarrativeEditFields | undefined {
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const lines = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    return out.length ? out : undefined;
  };
  const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

  const decisions = Array.isArray(body['decisions'])
    ? body['decisions']
        .map(rec)
        .filter((d): d is Record<string, unknown> => !!d && !!text(d['ask']))
        .map((d) => ({ ask: text(d['ask'])!, ...(text(d['why']) ? { why: text(d['why']) } : {}), ...(text(d['by']) ? { by: text(d['by']) } : {}) }))
    : [];
  const planBody = rec(body['plan']);
  const planItems = (v: unknown): PlanItem[] =>
    Array.isArray(v)
      ? v
          .map(rec)
          .filter((p): p is Record<string, unknown> => !!p && !!text(p['action']))
          .map((p) => ({ action: text(p['action'])!, owner: text(p['owner']) ?? 'Mash IT', ...(p['decision'] === true ? { decision: true } : {}) }))
      : [];
  const plan = planBody ? { now: planItems(planBody['now']), next: planItems(planBody['next']), later: planItems(planBody['later']) } : undefined;
  const protection = Array.isArray(body['protection'])
    ? body['protection']
        .map(rec)
        .filter((p): p is Record<string, unknown> => !!p && (PROTECTION_QUESTION_IDS as readonly unknown[]).includes(p['question']))
        .map((p) => ({ question: p['question'] as NarrativeOutput['protection'][number]['question'], inPlace: text(p['inPlace']) ?? '', thisQuarter: text(p['thisQuarter']) ?? '' }))
    : [];

  const edits: NarrativeEditFields = {
    headline: text(body['headline']),
    lede: text(body['lede']),
    did: lines(body['did']),
    saw: lines(body['saw']),
    decisions: decisions.length ? decisions : undefined,
    plan: plan && PLAN_COLUMNS.some((c) => plan[c].length) ? plan : undefined,
    protection: protection.length ? protection : undefined,
    summary_paragraphs: lines(body['summary_paragraphs']),
    highlights: lines(body['highlights']),
    recommendations: lines(body['recommendations']),
  };
  const kept = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)) as NarrativeEditFields;
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * The v3 fields, derived from the v4 ones: `summary_paragraphs = [lede]`,
 * `highlights = [...did, ...saw]`, `recommendations` = the plan flattened as
 * "{action} ({owner})". Fields already present (a v3 edit) are kept.
 */
export function legacyFields(output: NarrativeOutput): NarrativeOutput {
  const plan = PLAN_COLUMNS.flatMap((c) => output.plan?.[c] ?? []).map((p) => `${p.action} (${p.owner})`);
  return {
    ...output,
    summary_paragraphs: output.summary_paragraphs ?? (output.lede ? [output.lede] : []),
    highlights: output.highlights ?? [...(output.did ?? []), ...(output.saw ?? [])],
    recommendations: output.recommendations ?? plan,
  };
}

export interface BuildQbrOptions {
  /** Provide to use Claude; omit to use the deterministic offline drafter. */
  narrativeModel?: NarrativeModel;
  /** Optional persistent cache — consulted only when `narrativeModel` is set. */
  narrativeCache?: NarrativeCache;
  /** Author edits overlaid on the narrative — they always win. */
  narrativeEdits?: NarrativeEditFields;
  heldBy?: string;
  generatedLabel?: string;
  /** Per-client report customization (branding + sections). */
  config?: ReportConfig;
  /** Org-level branding from Settings (Mash IT logo + house colors). */
  orgBrand?: Brand;
  /** Captured review discussion + notes. */
  discussion?: DiscussionItem[];
  notes?: string;
  /** Attached vendor reports / uploads (rendered as the appendix); findings feed the narrative. */
  documents?: Array<{ name: string; source: string; findings?: Array<{ text: string; severity: 'info' | 'watch' | 'act' }> }>;
}

/**
 * One row per metric key. A PDF import (e.g. a previous QBR re-ingested into
 * the wrong quarter) can land `tickets.opened` alongside Halo's own row —
 * duplicate keys double-count tables and confuse trends. Integration-synced
 * rows win; `pdf:*` rows only fill keys nothing else provides.
 */
export function dedupeByKey(metrics: MetricValue[]): MetricValue[] {
  const byKey = new Map<string, MetricValue>();
  let dropped = false;
  for (const m of metrics) {
    const seen = byKey.get(m.key);
    if (!seen) {
      byKey.set(m.key, m);
      continue;
    }
    dropped = true;
    const seenIsPdf = String(seen.source).startsWith('pdf:');
    const thisIsPdf = String(m.source).startsWith('pdf:');
    if (seenIsPdf && !thisIsPdf) byKey.set(m.key, m); // synced row replaces the import
  }
  return dropped ? [...byKey.values()] : metrics;
}

/** Per-input AI failure cooldown (module scope — survives across builds). */
const aiFailureCooldown = new Map<string, number>();

/** Test hook: clear the AI failure cooldown between cases. */
export function _resetAiFailureCooldown(): void {
  aiFailureCooldown.clear();
}

export interface QbrReport {
  clientId: string;
  period: string;
  model: ReportModel;
  narrative: NarrativeResult;
  /** Non-fatal issues for the author to review before sending. */
  warnings: string[];
}

/**
 * Build a complete QBR report for a client/period: pull current + prior
 * snapshots, draft and verify the narrative, and assemble the report model.
 * Narrative generation falls back to the deterministic offline drafter when no
 * Claude model is supplied, so the pipeline runs end-to-end without credentials.
 */
export async function buildQbrReport(
  ds: QbrDataSource,
  clientId: string,
  periodId: string,
  opts: BuildQbrOptions = {},
): Promise<QbrReport> {
  const client = await ds.getClient(clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);
  const currentRaw = await ds.getSnapshot(clientId, periodId);
  if (!currentRaw) throw new Error(`No metric snapshot for ${clientId} ${periodId}`);
  const previousRaw = await ds.getSnapshot(clientId, previousPeriod(periodId).id);

  // Reviewed-out metrics vanish everywhere (sections, scorecard, trends, AI
  // input) — and since the narrative input changes, the AI cache invalidates.
  const excluded = new Set(opts.config?.excludedMetrics ?? []);
  const filter = <T extends { metrics: MetricValue[] }>(s: T): T => {
    let metrics = excluded.size ? s.metrics.filter((m) => !excluded.has(m.key)) : s.metrics;
    metrics = dedupeByKey(metrics);
    return metrics === s.metrics ? s : { ...s, metrics };
  };
  const current = filter(currentRaw);
  const previous = previousRaw ? filter(previousRaw) : undefined;

  // HIPAA clients' ticket subjects stay out of the model input unless the
  // operator has a BAA in place and sets NARRATIVE_ALLOW_PHI=1.
  const allowPhi = process.env['NARRATIVE_ALLOW_PHI'] === '1';
  const input = buildNarrativeInput(
    {
      client,
      current,
      previous,
      // Attached vendor reports (e.g. a Synology Active Backup report) so the
      // narrative won't claim a coverage gap the reports contradict.
      documents: opts.documents,
      // Author steering (focus / guidance / per-section comments). Because the
      // input feeds the cache key, changing direction regenerates the prose.
      direction: {
        focus: opts.config?.narrativeFocus,
        guidance: opts.config?.narrativeGuidance,
        sectionGuidance: opts.config?.sectionGuidance as Record<string, string> | undefined,
      },
    },
    { allowPhi },
  );
  const allowed = buildAllowedNumbers(input);
  // Quoted spans are skipped only when they are real ticket subjects from the input.
  const allowedQuotes = buildAllowedQuotes(input);

  // After an AI failure (rate limit, empty credits, outage), don't retry on
  // every page view — the Workspace rebuilds the report each visit, and each
  // retry costs real money. One attempt per cooldown window per input.
  const AI_RETRY_COOLDOWN_MS = 5 * 60_000;

  const offlineDraft = (): NarrativeResult => {
    const output = draftOfflineNarrative(input);
    return { output, verification: verifyNarrative(output, allowed, { allowedQuotes }), attempts: 1 };
  };

  let narrative: NarrativeResult;
  let aiFailure: string | undefined;
  if (opts.narrativeModel) {
    // Cache Claude runs on a fingerprint of exactly what the narrative depends
    // on. Cache failures must never fail a build; concurrent misses may both
    // call the model (last write wins) — acceptable for this traffic.
    // Bump `v` whenever the narrative output contract changes shape (v2:
    // section summaries; v3: strategic-goals alignment in the input; v4:
    // headline, lede, did, saw, decisions, plan and protection) so
    // pre-upgrade cached prose regenerates instead of missing the new fields
    // forever.
    const hash = createHash('sha256')
      .update(JSON.stringify({ v: 4, model: NARRATIVE_MODEL_ID, input }))
      .digest('hex');
    const cached = await opts.narrativeCache?.get(hash).catch(() => undefined);
    if (cached) {
      narrative = cached;
    } else if ((aiFailureCooldown.get(hash) ?? 0) > Date.now()) {
      // A recent attempt failed — serve the offline draft without re-billing.
      aiFailure = 'The AI narrative failed a few minutes ago and is cooling down — this build used the offline draft. Regenerate to try again now.';
      narrative = offlineDraft();
    } else {
      try {
        // One correction retry (2 calls max) — a second rarely fixes what the
        // first correction couldn't, and each retry is a full model call.
        narrative = await generateNarrative(input, opts.narrativeModel, { maxRetries: 1 });
        // Cache EVERY generated draft, verified or not. An unverified draft
        // carries its warning and Regenerate clears it — but re-drafting on
        // every page view multiplied API spend for no benefit.
        await opts.narrativeCache?.put(hash, narrative).catch(() => undefined);
      } catch (e) {
        // An AI outage, rate limit, or empty credit balance must never fail
        // the report — fall back to the offline draft and say why.
        const msg = e instanceof Error ? e.message : 'error';
        aiFailure = /credit balance/i.test(msg)
          ? 'Your Anthropic account is out of API credits, so this build used the offline draft. Add credits (or turn on auto-reload) at console.anthropic.com/settings/billing, then Regenerate.'
          : /rate_limit|429/i.test(msg)
            ? 'The Claude API is rate-limited right now, so this build used the offline draft. Try Regenerate in a minute or two — or raise the limit at console.anthropic.com/settings/limits.'
            : `The AI narrative failed (${msg.slice(0, 160)}) — this build used the offline draft. Try Regenerate.`;
        aiFailureCooldown.set(hash, Date.now() + AI_RETRY_COOLDOWN_MS);
        if (aiFailureCooldown.size > 500) aiFailureCooldown.clear();
        narrative = offlineDraft();
      }
    }
  } else {
    narrative = offlineDraft();
  }

  // Human edits win over whatever was generated — that's the approval loop.
  const edits = opts.narrativeEdits;
  if (edits) {
    narrative = {
      ...narrative,
      output: {
        ...narrative.output,
        ...(edits.headline !== undefined && edits.headline !== '' ? { headline: edits.headline } : {}),
        ...(edits.lede ? { lede: edits.lede } : {}),
        ...(edits.did?.length ? { did: edits.did } : {}),
        ...(edits.saw?.length ? { saw: edits.saw } : {}),
        ...(edits.decisions?.length ? { decisions: edits.decisions } : {}),
        ...(edits.plan && PLAN_COLUMNS.some((c) => edits.plan![c]?.length) ? { plan: edits.plan } : {}),
        ...(edits.protection?.length ? { protection: edits.protection } : {}),
        ...(edits.summary_paragraphs?.length ? { summary_paragraphs: edits.summary_paragraphs } : {}),
        ...(edits.highlights?.length ? { highlights: edits.highlights } : {}),
        ...(edits.recommendations?.length ? { recommendations: edits.recommendations } : {}),
      },
    };
  }

  // Verify what will actually ship: the prose as well as figures_referenced.
  // A cached narrative may predate prose checking, and author edits can add
  // numbers, so the stored verification is never trusted as-is.
  // The v3 fields are derived after verification so the same prose is not
  // checked twice under two labels.
  narrative = {
    ...narrative,
    verification: verifyNarrative(narrative.output, allowed, { allowedQuotes }),
  };
  narrative = { ...narrative, output: legacyFields(narrative.output) };

  const model = buildReportModel({
    client,
    current,
    previous,
    narrative: narrative.output,
    heldBy: opts.heldBy,
    generatedLabel: opts.generatedLabel,
    config: opts.config,
    orgBrand: opts.orgBrand,
    discussion: opts.discussion,
    notes: opts.notes,
    documents: opts.documents,
    excludedLabels: currentRaw.metrics.filter((m) => excluded.has(m.key)).map((m) => m.label),
  });

  const warnings: string[] = [];
  if (aiFailure) warnings.push(aiFailure);
  if (!narrative.verification.ok) {
    // Neutral wording: the text may be the AI's or an author's edit.
    const figureFailures = narrative.verification.failures.filter((f) => f.label !== 'limits');
    const limitFailure = narrative.verification.failures.find((f) => f.label === 'limits');
    if (figureFailures.length) {
      const detail = figureFailures.map((f) => `${f.label} (${f.unmatched.join(', ')})`).join('; ');
      warnings.push(`The narrative cites a figure that does not match the data: ${detail}. Review before sending.`);
    }
    if (limitFailure) {
      warnings.push(`The narrative is over a length or count limit: ${limitFailure.unmatched.join('; ')}. Shorten before sending.`);
    }
  }
  if (!previous) {
    warnings.push('No prior-quarter snapshot found — quarter-over-quarter trends are unavailable.');
  }

  return { clientId, period: periodId, model, narrative, warnings };
}

export function renderQbrHtml(report: QbrReport): string {
  return renderReportHtml(report.model);
}
