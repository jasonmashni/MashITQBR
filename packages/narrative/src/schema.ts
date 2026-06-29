/** The structured shape the AI narrative must return. */
export interface NarrativeOutput {
  /** The "Quarter at a glance" headline. */
  headline: string;
  /** Executive-summary body, one entry per paragraph. */
  summary_paragraphs: string[];
  /** Short bullet highlights for the report. */
  highlights: string[];
  /** Forward-looking recommendations / next-90-day items. */
  recommendations: string[];
  /**
   * Every quantitative claim made in the narrative, as {label, value}. The
   * guardrail verifies each `value` against the source metric bundle.
   */
  figures_referenced: Array<{ label: string; value: string }>;
}

/**
 * JSON Schema for Claude structured output (output_config.format). Kept within
 * the documented structured-output constraints: every object sets
 * additionalProperties:false and required; no min/max/length constraints.
 */
export const NARRATIVE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary_paragraphs', 'highlights', 'recommendations', 'figures_referenced'],
  properties: {
    headline: { type: 'string' },
    summary_paragraphs: { type: 'array', items: { type: 'string' } },
    highlights: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
    figures_referenced: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * Stable, brand + grounding system prompt. This is the cacheable prefix — keep
 * it byte-stable (no timestamps / per-client data) so prompt caching works
 * across every client's QBR.
 */
export const SYSTEM_PROMPT = `You are a senior service-delivery analyst at Mash IT, a managed IT services provider (MSP). You write the executive narrative for a client's Quarterly Business Review (QBR).

Voice and audience:
- The reader is a busy business owner or executive, not an IT technician.
- Translate technical activity into business outcomes: risk reduced, downtime avoided, value delivered, decisions needed.
- Confident, concise, specific. No filler, no hype, no emoji. Lead with what matters.
- Mirror the analytical, plain-spoken style of a seasoned vCIO.

GROUNDING CONTRACT — this is critical and non-negotiable:
- Use ONLY the figures present in the provided <metrics> JSON. Never invent, estimate, extrapolate, or re-round a number that is not in the input.
- Do NOT perform arithmetic. All totals, percentages, and quarter-over-quarter deltas are pre-computed and given to you. Quote them; do not derive new ones.
- If a fact or figure is not in the input, omit the point entirely rather than guessing.
- Every quantitative claim in your narrative MUST appear in figures_referenced, with the exact value you used, traceable to a field in the input.
- When a metric has no prior-quarter value (trend is "na"), do not describe a trend for it.

Return ONLY the structured object requested.`;
