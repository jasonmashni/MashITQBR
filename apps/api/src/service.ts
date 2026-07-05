import { createHash } from 'node:crypto';
import { previousPeriod, type Brand, type DiscussionItem, type ReportConfig } from '@mashit/core';
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
  const filter = <T extends { metrics: { key: string }[] }>(s: T): T =>
    excluded.size ? { ...s, metrics: s.metrics.filter((m) => !excluded.has(m.key)) } : s;
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

  let narrative: NarrativeResult;
  if (opts.narrativeModel) {
    // Cache Claude runs on a fingerprint of exactly what the narrative depends
    // on. Cache failures must never fail a build; concurrent misses may both
    // call the model (last write wins) — acceptable for this traffic.
    // Bump `v` whenever the narrative output contract changes shape (v2:
    // section summaries) so pre-upgrade cached prose regenerates instead of
    // missing the new fields forever.
    const hash = createHash('sha256')
      .update(JSON.stringify({ v: 2, model: NARRATIVE_MODEL_ID, input }))
      .digest('hex');
    const cached = await opts.narrativeCache?.get(hash).catch(() => undefined);
    if (cached) {
      narrative = cached;
    } else {
      narrative = await generateNarrative(input, opts.narrativeModel);
      // Only pin verified narratives — a failed one should retry next build.
      if (narrative.verification.ok) {
        await opts.narrativeCache?.put(hash, narrative).catch(() => undefined);
      }
    }
  } else {
    const output = draftOfflineNarrative(input);
    const verification = verifyFigures(output.figures_referenced, buildAllowedNumbers(input));
    narrative = { output, verification, attempts: 1 };
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
