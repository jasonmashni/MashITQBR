import Anthropic from '@anthropic-ai/sdk';

/**
 * AI document matcher: reads a filed PDF (vendor reports forwarded to the
 * QBR inbox arrive with generic names, default quarters, and no category)
 * and suggests where it belongs. The suggestion is applied by the existing
 * document-update route only when the author clicks Match — the AI never
 * moves a file on its own.
 */

/** Categories mirror the Reports tab buckets (keep in sync with the web UI). */
export const DOC_CATEGORIES = ['Security', 'Backup', 'Endpoint', 'Email', 'Network', 'Compliance', 'Billing', 'Other'] as const;

export interface DocMatchSuggestion {
  /** The tool/vendor that produced the document (Huntress, Dropsuite…). */
  vendor: string;
  /** Clean, human-readable file name (keeps the extension). */
  suggestedName: string;
  /** Quarter the document's CONTENT covers, e.g. 2026-Q2. */
  suggestedPeriod: string;
  suggestedCategory: string;
  /** Does the content actually belong to this client? */
  clientMatch: 'yes' | 'no' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  /** One sentence of evidence (what in the document decided it). */
  rationale: string;
}

/** A matcher takes the prompt inputs and returns the structured suggestion. */
export type DocMatchModel = (input: {
  pdfBase64: string;
  clientName: string;
  currentName: string;
  currentPeriod: string;
  periods: string[];
}) => Promise<DocMatchSuggestion>;

export const DOC_MATCH_MODEL_ID = 'claude-sonnet-5';

const DOC_MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendor', 'suggested_name', 'suggested_period', 'suggested_category', 'client_match', 'confidence', 'rationale'],
  properties: {
    vendor: { type: 'string' },
    suggested_name: { type: 'string' },
    suggested_period: { type: 'string' },
    suggested_category: { type: 'string', enum: [...DOC_CATEGORIES] },
    client_match: { type: 'string', enum: ['yes', 'no', 'unsure'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    rationale: { type: 'string' },
  },
} as const;

const SYSTEM = `You are the filing assistant for an MSP's Quarterly Business Review (QBR) document library. Vendor reports (Huntress, Dropsuite, Check Point, NinjaOne, Synology, carrier invoices…) get forwarded into the library with generic names, a guessed quarter, and no category. Read the attached document and work out where it belongs.

Rules:
- suggested_period is the quarter the document's CONTENT covers (report period, invoice period, date range in the document) — NOT when it was emailed. Format YYYY-QN. If the content names no period, keep the current one.
- suggested_name: a clean descriptive file name, "<Vendor> <report type> <period>.<ext>" style (e.g. "Huntress Quarterly Summary 2026-Q2.pdf"). Keep the original extension.
- suggested_category: pick the closest bucket.
- client_match: "yes" when the document names this client (or its domain/staff), "no" when it clearly belongs to a different organization, "unsure" otherwise.
- rationale: ONE sentence pointing at the evidence.
Return only the structured object.`;

/** Build the default Claude-backed matcher (native PDF input, structured output). */
export function createClaudeDocMatcher(client: Anthropic = new Anthropic(), modelId: string = DOC_MATCH_MODEL_ID): DocMatchModel {
  return async ({ pdfBase64, clientName, currentName, currentPeriod, periods }) => {
    const params = {
      model: modelId,
      max_tokens: 1000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: DOC_MATCH_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            {
              type: 'text',
              text: `Client: ${clientName}\nCurrent file name: ${currentName}\nCurrently filed under: ${currentPeriod}\nValid quarters: ${periods.join(', ')}`,
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
      throw new Error(`Document matcher did not return valid JSON. Got: ${text.slice(0, 200)}`);
    }
    return {
      vendor: String(parsed['vendor'] ?? ''),
      suggestedName: String(parsed['suggested_name'] ?? currentName),
      suggestedPeriod: String(parsed['suggested_period'] ?? currentPeriod),
      suggestedCategory: String(parsed['suggested_category'] ?? 'Other'),
      clientMatch: (['yes', 'no', 'unsure'].includes(String(parsed['client_match'])) ? String(parsed['client_match']) : 'unsure') as DocMatchSuggestion['clientMatch'],
      confidence: (['high', 'medium', 'low'].includes(String(parsed['confidence'])) ? String(parsed['confidence']) : 'low') as DocMatchSuggestion['confidence'],
      rationale: String(parsed['rationale'] ?? ''),
    };
  };
}
