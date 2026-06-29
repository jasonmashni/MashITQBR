import { previousPeriod } from '@mashit/core';
import {
  buildAllowedNumbers,
  buildNarrativeInput,
  draftOfflineNarrative,
  generateNarrative,
  verifyFigures,
  type NarrativeModel,
  type NarrativeResult,
} from '@mashit/narrative';
import { buildReportModel, renderReportHtml, type ReportModel } from '@mashit/report';
import type { QbrDataSource } from './dataSource.js';

export interface BuildQbrOptions {
  /** Provide to use Claude; omit to use the deterministic offline drafter. */
  narrativeModel?: NarrativeModel;
  heldBy?: string;
  generatedLabel?: string;
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
  const client = ds.getClient(clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);
  const current = ds.getSnapshot(clientId, periodId);
  if (!current) throw new Error(`No metric snapshot for ${clientId} ${periodId}`);
  const previous = ds.getSnapshot(clientId, previousPeriod(periodId).id);

  const input = buildNarrativeInput({ client, current, previous });

  let narrative: NarrativeResult;
  if (opts.narrativeModel) {
    narrative = await generateNarrative(input, opts.narrativeModel);
  } else {
    const output = draftOfflineNarrative(input);
    const verification = verifyFigures(output.figures_referenced, buildAllowedNumbers(input));
    narrative = { output, verification, attempts: 1 };
  }

  const model = buildReportModel({
    client,
    current,
    previous,
    narrative: narrative.output,
    heldBy: opts.heldBy,
    generatedLabel: opts.generatedLabel,
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
