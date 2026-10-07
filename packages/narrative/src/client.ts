import Anthropic from '@anthropic-ai/sdk';
import { buildCorrectionContent, buildUserContent } from './prompt.js';
import { buildAllowedNumbers, buildAllowedQuotes, type NarrativeInput } from './input.js';
import { NARRATIVE_JSON_SCHEMA, PROTECTION_QUESTION_IDS, SYSTEM_PROMPT, type NarrativeOutput } from './schema.js';
import { describeFailures, verifyNarrative, type VerificationResult } from './verify.js';

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
  // Clamp so a negative or fractional setting still makes one first attempt;
  // a non-numeric setting (NaN, Infinity) falls back to the default of 2.
  const requested = opts.maxRetries ?? 2;
  const maxRetries = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 2;
  const allowed = buildAllowedNumbers(input);
  const allowedQuotes = buildAllowedQuotes(input);
  const messages: NarrativeMessage[] = [{ role: 'user', content: buildUserContent(input) }];

  let last: NarrativeResult | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const output: unknown = await model(messages);
    assertNarrativeShape(output);
    const verification = verifyNarrative(output, allowed, { ...opts.tolerance, allowedQuotes });
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

    return parseModelText(text, response.stop_reason);
  };
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optString = (v: unknown) => v === undefined || typeof v === 'string';

/**
 * Throw unless `x` has the v4 NarrativeOutput shape: string headline and
 * lede, string arrays for did and saw, decisions as {ask, why?, by?}, plan as
 * {now, next, later} arrays of {action, owner, decision?}, protection as
 * {question, inPlace, thisQuarter} with a known question id, a
 * figures_referenced array of {label, value} strings, and (when present)
 * section_summaries and the deprecated v3 string arrays. Counts and word
 * limits are not shape: limitIssues reports those as verification failures.
 * Structured output should guarantee the shape, but a truncated or off-schema
 * reply must fail loudly rather than crash later in verification or rendering.
 */
export function assertNarrativeShape(x: unknown): asserts x is NarrativeOutput {
  const problems: string[] = [];
  const o = isObj(x) ? x : {};
  if (!isObj(x)) problems.push('not an object');
  for (const key of ['headline', 'lede'] as const) if (typeof o[key] !== 'string') problems.push(`${key} is not a string`);
  for (const key of ['did', 'saw'] as const) if (!isStringArray(o[key])) problems.push(`${key} is not a string array`);
  const decisions = o['decisions'];
  if (!Array.isArray(decisions) || !decisions.every((d) => isObj(d) && typeof d['ask'] === 'string' && optString(d['why']) && optString(d['by']))) {
    problems.push('decisions is not an {ask, why, by} array');
  }
  const plan = o['plan'];
  const planItem = (p: unknown) =>
    isObj(p) && typeof p['action'] === 'string' && typeof p['owner'] === 'string' && (p['decision'] === undefined || typeof p['decision'] === 'boolean');
  if (!isObj(plan) || !(['now', 'next', 'later'] as const).every((c) => Array.isArray(plan[c]) && (plan[c] as unknown[]).every(planItem))) {
    problems.push('plan is not {now, next, later} arrays of {action, owner, decision}');
  }
  const protection = o['protection'];
  const protectionItem = (p: unknown) =>
    isObj(p) &&
    (PROTECTION_QUESTION_IDS as readonly unknown[]).includes(p['question']) &&
    typeof p['inPlace'] === 'string' &&
    typeof p['thisQuarter'] === 'string';
  if (!Array.isArray(protection) || !protection.every(protectionItem)) {
    problems.push('protection is not a {question, inPlace, thisQuarter} array');
  }
  for (const key of ['summary_paragraphs', 'highlights', 'recommendations'] as const) {
    if (o[key] !== undefined && !isStringArray(o[key])) problems.push(`${key} is not a string array`);
  }
  const figures = o['figures_referenced'];
  if (!Array.isArray(figures) || !figures.every((f) => isObj(f) && typeof f['label'] === 'string' && typeof f['value'] === 'string')) {
    problems.push('figures_referenced is not a {label, value} array');
  }
  const sections = o['section_summaries'];
  if (
    sections !== undefined &&
    (!Array.isArray(sections) || !sections.every((s) => isObj(s) && typeof s['category'] === 'string' && typeof s['summary'] === 'string'))
  ) {
    problems.push('section_summaries is not a {category, summary} array');
  }
  if (problems.length) throw new Error(`Narrative model output has the wrong shape: ${problems.join('; ')}.`);
}

/**
 * Parse the model's text reply into a NarrativeOutput. A non-JSON body (often
 * a reply cut off at max_tokens) throws with the stop_reason so the cause is
 * visible; a parsed body is shape-checked.
 */
export function parseModelText(text: string, stopReason?: string | null): NarrativeOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const reason = stopReason ? ` (stop_reason: ${stopReason})` : '';
    throw new Error(`Narrative model did not return valid JSON${reason}. Got: ${text.slice(0, 200)}`);
  }
  assertNarrativeShape(parsed);
  return parsed;
}
