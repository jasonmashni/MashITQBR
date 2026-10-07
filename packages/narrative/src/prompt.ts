import type { NarrativeInput } from './input.js';

/** Build the user message content: the metrics bundle wrapped in <metrics> tags. */
export function buildUserContent(input: NarrativeInput): string {
  // Compact JSON — pretty-printing spent ~30% more input tokens per draft.
  // Angle brackets are written as JSON unicode escapes (same parsed value) so
  // no string in the input can open or close a tag around the data block.
  const json = JSON.stringify(input).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return [
    `<metrics>`,
    json,
    `</metrics>`,
    ``,
    `Write the "Quarter at a glance" executive narrative for ${input.client.name}'s ${input.period.label} QBR.`,
    `Ground every quantitative claim in the figures above and list each in figures_referenced.`,
  ].join('\n');
}

/** Build a corrective instruction appended on a regeneration after a failed verification. */
export function buildCorrectionContent(failureSummary: string): string {
  return [
    `The previous draft cited figures that are NOT present in the provided metrics:`,
    failureSummary,
    ``,
    `Rewrite the narrative using ONLY figures from the <metrics> block. Remove or correct every flagged number.`,
  ].join('\n');
}
