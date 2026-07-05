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
   * One executive sentence per metric section present in the input
   * (category = operations | security | identity | backup | infrastructure |
   * spend). Rendered under each section heading so a non-technical reader
   * gets the takeaway without the table. Optional for cached pre-upgrade
   * narratives.
   */
  section_summaries?: Array<{ category: string; summary: string }>;
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
  required: ['headline', 'summary_paragraphs', 'highlights', 'recommendations', 'section_summaries', 'figures_referenced'],
  properties: {
    headline: { type: 'string' },
    summary_paragraphs: { type: 'array', items: { type: 'string' } },
    highlights: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
    section_summaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'summary'],
        properties: {
          // Enum-locked to the section keys buildReportModel matches on, so a
          // capitalized or re-worded category can't silently drop a summary.
          category: { type: 'string', enum: ['operations', 'security', 'identity', 'backup', 'infrastructure', 'spend'] },
          summary: { type: 'string' },
        },
      },
    },
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

Section summaries:
- For EACH metric category that appears in the input (operations, security, identity, backup, infrastructure, spend), add one entry to section_summaries: {category, summary}.
- Each summary is ONE plain-English sentence (two at most) giving an executive the takeaway of that section — what it means for the business, not a restatement of every number.
- Skip categories with no metrics in the input. Numbers used in summaries follow the grounding contract below.

Author direction:
- The input may carry a "direction" object from the report author: direction.focus is the theme this QBR should emphasize (weight the summary, highlights and recommendations toward it without ignoring other material findings); direction.guidance is standing instruction to follow; direction.sectionGuidance carries per-section comments — apply each to that section's summary.
- client.complianceStandard, when present, names the framework the client answers to (HIPAA, TISAX, SOC 2…). Reflect compliance INTENT with a light touch — connect relevant findings to it in a sentence or two; never turn the QBR into an audit report.

Measurement changes are not business trends:
- When a metric appears, disappears, or swings implausibly between quarters because monitoring or data collection changed (a tool newly connected, a counting fix), do NOT present it as a business trend or an incident. Prefer "now measured/tracked" framing, or omit it. When in doubt, attribute the change to visibility, not to the client's environment.

GROUNDING CONTRACT — this is critical and non-negotiable:
- Use ONLY the figures present in the provided <metrics> JSON. Never invent, estimate, extrapolate, or re-round a number that is not in the input.
- Do NOT perform arithmetic. All totals, percentages, and quarter-over-quarter deltas are pre-computed and given to you. Quote them; do not derive new ones.
- If a fact or figure is not in the input, omit the point entirely rather than guessing.
- Every quantitative claim in your narrative MUST appear in figures_referenced, with the exact value you used, traceable to a field in the input.
- When a metric has no prior-quarter value (trend is "na"), do not describe a trend for it.

Return ONLY the structured object requested.`;
