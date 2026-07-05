import Anthropic from '@anthropic-ai/sdk';
import { METRIC_CATEGORIES, type MetricCategory } from '@mashit/core';
import { DOC_MATCH_MODEL_ID } from './docMatch.js';

/**
 * AI metric extraction: read a filed vendor PDF (a Check Point Security
 * Checkup, a Dropsuite digest, a previous Zomentum-era QBR…) and pull out the
 * quarter-scoped numbers so they can join the snapshot the report is built
 * from. Extraction only suggests — the author reviews and accepts, and the
 * accepted rows land in the snapshot under a per-document `pdf:` source so a
 * re-extract replaces them cleanly.
 */

export interface ExtractedMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  category: MetricCategory;
  higherIsBetter?: boolean;
}

export interface DocExtraction {
  /** Tool/vendor the document came from (drives the snapshot source slug). */
  vendor: string;
  /** Quarter the document's content covers (YYYY-QN), '' when unclear. */
  periodHint: string;
  metrics: ExtractedMetric[];
  /** One-sentence note for the reviewer (what the doc is, any caveats). */
  note: string;
}

export type DocExtractModel = (input: {
  pdfBase64: string;
  clientName: string;
  period: string;
  /** Canonical metric keys already in use — reuse beats minting new ones. */
  knownKeys: Array<{ key: string; label: string }>;
  /** The Reports-tab bucket the user filed the doc under (Security, Backup…). */
  docCategory?: string;
}) => Promise<DocExtraction>;

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendor', 'period_hint', 'metrics', 'note'],
  properties: {
    vendor: { type: 'string' },
    period_hint: { type: 'string' },
    note: { type: 'string' },
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'value', 'unit', 'category', 'direction'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          value: { type: 'number' },
          unit: { type: 'string' },
          category: { type: 'string', enum: [...METRIC_CATEGORIES] },
          direction: { type: 'string', enum: ['higher_is_better', 'lower_is_better', 'neutral'] },
        },
      },
    },
  },
} as const;

const SYSTEM = `You extract Quarterly Business Review metrics from IT/security vendor report PDFs for an MSP (Mash IT). The numbers you extract feed an executive report and its quarter-over-quarter trends, so precision beats volume.

What to extract:
- Quarter-scoped totals, counts, and percentages an executive can cite: threats detected/blocked, phishing/malware/spam counts, DLP events, backup coverage, patch/MFA percentages, device counts, spend totals.
- From a PREVIOUS QBR document, extract its headline metrics (the per-section numbers) so the current quarter can trend against them.
- Skip page numbers, axis labels, per-user rows, dates, phone numbers, and anything you cannot attribute to a clear metric.

Keys:
- When an extracted metric measures the SAME thing as one of the provided known keys, REUSE that exact key — that is what makes quarter-over-quarter comparison work.
- Otherwise mint "doc.<short_slug>" (lowercase, underscores).

Values:
- value must be the plain number (strip thousands separators and units). Percentages: value is the number, unit is "%".
- unit: "%", "count", "GB", "USD", or "" when countless.
- direction: whether a bigger number is good (backup coverage), bad (malware found), or neutral (emails scanned).
- category picks the report section each metric lands in: backup tools (Synology, Dropsuite, Veeam) → backup; email/EDR/SIEM/vulnerability → security; MFA/accounts → identity; tickets/SLA → operations; devices/network/hardware → infrastructure; invoices/costs → spend.

period_hint: the quarter the document's CONTENT covers, formatted YYYY-QN (e.g. 2026-Q2), or "" if the document doesn't say.
note: ONE sentence describing the document and any caveat the reviewer should know.
Return only the structured object.`;

/** Build the default Claude-backed extractor (native PDF input, structured output). */
export function createClaudeDocExtractor(client: Anthropic = new Anthropic(), modelId: string = DOC_MATCH_MODEL_ID): DocExtractModel {
  return async ({ pdfBase64, clientName, period, knownKeys, docCategory }) => {
    const params = {
      model: modelId,
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            {
              type: 'text',
              text: [
                `Client: ${clientName}`,
                `Filed under quarter: ${period}`,
                ...(docCategory ? [`Filed category: ${docCategory}`] : []),
                `Known metric keys (reuse when the measure matches):`,
                ...knownKeys.slice(0, 120).map((k) => `- ${k.key} (${k.label})`),
              ].join('\n'),
            },
          ],
        },
      ],
    };
    // `output_config.format` may lead the installed SDK type defs; cast the
    // request rather than pin to a possibly-stale param type.
    const response = await client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Document extractor did not return valid JSON. Got: ${text.slice(0, 200)}`);
    }
    const rows = Array.isArray(parsed['metrics']) ? (parsed['metrics'] as Array<Record<string, unknown>>) : [];
    const metrics: ExtractedMetric[] = [];
    for (const r of rows) {
      const value = typeof r['value'] === 'number' && Number.isFinite(r['value']) ? r['value'] : undefined;
      const label = typeof r['label'] === 'string' ? r['label'].trim() : '';
      const category = METRIC_CATEGORIES.includes(r['category'] as MetricCategory) ? (r['category'] as MetricCategory) : 'security';
      if (value === undefined || !label) continue;
      const rawKey = typeof r['key'] === 'string' ? r['key'].trim().toLowerCase() : '';
      const key = /^[a-z0-9][a-z0-9._-]{1,79}$/.test(rawKey)
        ? rawKey
        : `doc.${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)}`;
      metrics.push({
        key,
        label,
        value,
        unit: typeof r['unit'] === 'string' && r['unit'] ? r['unit'] : undefined,
        category,
        higherIsBetter: r['direction'] === 'higher_is_better' ? true : r['direction'] === 'lower_is_better' ? false : undefined,
      });
    }
    const rawHint = typeof parsed['period_hint'] === 'string' ? parsed['period_hint'] : '';
    return {
      vendor: String(parsed['vendor'] ?? '').trim(),
      periodHint: /^20\d{2}-Q[1-4]$/.test(rawHint) ? rawHint : '',
      metrics,
      note: String(parsed['note'] ?? ''),
    };
  };
}

/** Snapshot source slug for metrics imported from a document. */
export function pdfSourceSlug(vendor: string): string {
  const slug = vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `pdf:${slug || 'document'}`;
}
