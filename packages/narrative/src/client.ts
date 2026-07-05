import Anthropic from '@anthropic-ai/sdk';
import { buildCorrectionContent, buildUserContent } from './prompt.js';
import { buildAllowedNumbers, type NarrativeInput } from './input.js';
import { NARRATIVE_JSON_SCHEMA, SYSTEM_PROMPT, type NarrativeOutput } from './schema.js';
import { describeFailures, verifyFigures, type VerificationResult } from './verify.js';

export interface NarrativeMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A model is anything that turns a message thread into a NarrativeOutput. The
 * default implementation calls Claude; tests inject a fake for determinism.
 */
export type NarrativeModel = (messages: NarrativeMessage[]) => Promise<NarrativeOutput>;

export interface NarrativeResult {
  output: NarrativeOutput;
  verification: VerificationResult;
  attempts: number;
}

/**
 * Narrative model id — Opus 4.8 by default (the prose is the product), but
 * overridable via the NARRATIVE_MODEL app setting (e.g. claude-sonnet-5 at
 * roughly 60% of the cost). The id is part of the cache key, so switching
 * regenerates rather than serving prose from another model.
 */
export const NARRATIVE_MODEL_ID = process.env['NARRATIVE_MODEL']?.trim() || 'claude-opus-4-8';

/** Reasoning effort for narrative drafts (NARRATIVE_EFFORT: low|medium|high). */
const NARRATIVE_EFFORT = process.env['NARRATIVE_EFFORT']?.trim() || 'high';

/**
 * Generate a grounded QBR narrative. Calls the model, verifies every cited
 * figure against the pre-computed metric bundle, and regenerates with a
 * correction if any figure can't be traced — up to `maxRetries` times. The
 * returned result always carries the verification outcome so the caller can
 * gate publishing on `verification.ok`.
 */
export async function generateNarrative(
  input: NarrativeInput,
  model: NarrativeModel,
  opts: { maxRetries?: number; tolerance?: { absolute?: number; relative?: number } } = {},
): Promise<NarrativeResult> {
  const maxRetries = opts.maxRetries ?? 2;
  const allowed = buildAllowedNumbers(input);
  const messages: NarrativeMessage[] = [{ role: 'user', content: buildUserContent(input) }];

  let last: NarrativeResult | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const output = await model(messages);
    const verification = verifyFigures(output.figures_referenced, allowed, opts.tolerance);
    last = { output, verification, attempts: attempt };
    if (verification.ok) return last;

    // Append the rejected draft + correction and try again.
    messages.push({ role: 'assistant', content: JSON.stringify(output) });
    messages.push({ role: 'user', content: buildCorrectionContent(describeFailures(verification)) });
  }
  return last as NarrativeResult;
}

/**
 * Build a NarrativeModel backed by the Claude API with the grounded prompt,
 * adaptive thinking, high effort, structured JSON output, and a cached system
 * prefix. Pass an existing Anthropic client or let it construct one from env.
 */
export function createClaudeNarrativeModel(
  client: Anthropic = new Anthropic(),
  modelId: string = NARRATIVE_MODEL_ID,
): NarrativeModel {
  return async (messages) => {
    const params = {
      model: modelId,
      max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: NARRATIVE_EFFORT,
        format: { type: 'json_schema', schema: NARRATIVE_JSON_SCHEMA },
      },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    // `output_config.format` may lead the installed SDK type defs; cast the
    // request rather than pin to a possibly-stale param type.
    const response = await client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Narrative model did not return valid JSON. Got: ${text.slice(0, 200)}`);
    }
    return parsed as NarrativeOutput;
  };
}
