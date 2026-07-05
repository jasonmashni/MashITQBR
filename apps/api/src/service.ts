import { createHash } from 'node:crypto';
import { previousPeriod, type Brand, type DiscussionItem, type MetricValue, type ReportConfig } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildNarrativeInput,
  draftOfflineNarrative,
  generateNarrative,
  NARRATIVE_MODEL_ID,
  verifyFigures,
  type NarrativeModel,
  type NarrativeResult,
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

/** Human narrative overrides (undefined field = keep the generated text). */
export interface NarrativeEditFields {
  headline?: string;
  summary_paragraphs?: string[];
  highlights?: string[];
  recommendations?: string[];
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
  /** Attached vendor reports / uploads (rendered as the appendix). */
  documents?: Array<{ name: string; source: string }>;
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

  const input = buildNarrativeInput({
    client,
    current,
    previous,
    // Author steering (focus / guidance / per-section comments). Because the
    // input feeds the cache key, changing direction regenerates the prose.
    direction: {
      focus: opts.config?.narrativeFocus,
      guidance: opts.config?.narrativeGuidance,
      sectionGuidance: opts.config?.sectionGuidance as Record<string, string> | undefined,
    },
  });

  // After an AI failure (rate limit, empty credits, outage), don't retry on
  // every page view — the Workspace rebuilds the report each visit, and each
  // retry costs real money. One attempt per cooldown window per input.
  const AI_RETRY_COOLDOWN_MS = 5 * 60_000;

  const offlineDraft = (): NarrativeResult => {
    const output = draftOfflineNarrative(input);
    const verification = verifyFigures(output.figures_referenced, buildAllowedNumbers(input));
    return { output, verification, attempts: 1 };
  };

  let narrative: NarrativeResult;
  let aiFailure: string | undefined;
  if (opts.narrativeModel) {
    // Cache Claude runs on a fingerprint of exactly what the narrative depends
    // on. Cache failures must never fail a build; concurrent misses may both
    // call the model (last write wins) — acceptable for this traffic.
    // Bump `v` whenever the narrative output contract changes shape (v2:
    // section summaries; v3: strategic-goals alignment in the input) so
    // pre-upgrade cached prose regenerates instead of missing the new fields
    // forever.
    const hash = createHash('sha256')
      .update(JSON.stringify({ v: 3, model: NARRATIVE_MODEL_ID, input }))
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
        ...(edits.summary_paragraphs?.length ? { summary_paragraphs: edits.summary_paragraphs } : {}),
        ...(edits.highlights?.length ? { highlights: edits.highlights } : {}),
        ...(edits.recommendations?.length ? { recommendations: edits.recommendations } : {}),
      },
    };
  }

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
  });

  const warnings: string[] = [];
  if (aiFailure) warnings.push(aiFailure);
  if (!narrative.verification.ok) {
    warnings.push('AI narrative cited figures that could not be verified — review before sending.');
  }
  if (!previous) {
    warnings.push('No prior-quarter snapshot found — quarter-over-quarter trends are unavailable.');
  }

  return { clientId, period: periodId, model, narrative, warnings };
}

export function renderQbrHtml(report: QbrReport): string {
  return renderReportHtml(report.model);
}
