import Anthropic from '@anthropic-ai/sdk';
import type { BudgetContextItem } from './store/index.js';

/**
 * Industry context for budget prep, for Mash IT staff only. Uses Claude with
 * the web-search server tool (the research.ts pattern) to surface recent,
 * cited spending context for the client's industry and compliance standard,
 * each item paired with the question to raise with the client.
 *
 * The result is stored on BudgetPlanRecord.context and shown in the planner.
 * It is never passed to buildNarrativeInput or placed on the report model, so
 * a benchmark figure that reaches client prose fails the figure guardrail.
 * No client name, ticket text or other PHI is sent: only industry, compliance
 * standard, a headcount band and the fiscal year.
 */

const RESEARCH_MODEL_ID = process.env['RESEARCH_MODEL']?.trim() || process.env['NARRATIVE_MODEL']?.trim() || 'claude-opus-4-8';

export interface BudgetResearchInput {
  industry?: string;
  complianceStandard?: string;
  /** e.g. "26 to 50"; undefined when the seat count is unknown. */
  headcountBand?: string;
  fiscalLabel: number;
}

export interface BudgetResearch {
  items: BudgetContextItem[];
  /** True when the model actually ran web searches. */
  sourced: boolean;
}

export type BudgetResearchModel = (input: BudgetResearchInput) => Promise<BudgetResearch>;

const SYSTEM = `You are a vCIO at Mash IT, a managed IT services provider, preparing to help a client plan next fiscal year's IT budget. Research recent, relevant context for this client's industry and compliance standard that should shape the budget conversation: typical IT spending patterns, compliance deadlines or assessment cycles, end-of-support dates, licensing price changes, and similar.

This is internal prep material for the account manager. It never appears on a client deliverable.

Use web search for current, specific information. Prefer items from roughly the last 12 months.

Return ONLY the JSON object, no prose before or after it, with exactly this shape:
{
  "items": [
    { "title": "short headline", "insight": "what is true and why it matters for the budget (one or two sentences)", "askClient": "the question to raise with the client", "sourceName": "publication name", "sourceUrl": "https://..." }
  ]
}

Rules:
- 3 to 6 items.
- Every item must carry a real sourceUrl from your search. Never fabricate a source, a statistic or an event.
- Every item must have an askClient question.
- Plain sentences. No em dashes.
- If you cannot find solid recent information, return fewer items rather than inventing them.

Return ONLY the JSON object.`;

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Keep well-formed items only: a title, an insight and a question for the client. */
export function cleanContextItems(raw: unknown): BudgetContextItem[] {
  return (Array.isArray(raw) ? raw : [])
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const url = str(o['sourceUrl']);
      return {
        title: str(o['title']),
        insight: str(o['insight']),
        askClient: str(o['askClient']),
        sourceName: str(o['sourceName']) || undefined,
        sourceUrl: /^https?:\/\//i.test(url) ? url : undefined,
      };
    })
    .filter((i) => i.title && i.insight && i.askClient)
    .slice(0, 8);
}

/** Claude-backed budget researcher using the web-search server tool. */
export function createClaudeBudgetResearcher(client: Anthropic = new Anthropic(), modelId: string = RESEARCH_MODEL_ID): BudgetResearchModel {
  return async (input) => {
    const user = [
      `Industry: ${input.industry || 'not recorded'}.`,
      `Compliance standard: ${input.complianceStandard || 'none recorded'}.`,
      `Headcount: ${input.headcountBand ? `${input.headcountBand} users` : 'unknown'}.`,
      `Fiscal year being planned: FY${input.fiscalLabel}.`,
      'Research the context for this budget conversation, then return the JSON object.',
    ].join('\n');
    const params = {
      model: modelId,
      max_tokens: 3000,
      system: SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: user }],
    };
    const resp = await client.messages.stream(params as unknown as Anthropic.MessageCreateParamsStreaming).finalMessage();
    const blocks = resp.content as Array<{ type: string; text?: string }>;
    const sourced = blocks.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { items: cleanContextItems(extractJson(text)['items']), sourced };
  };
}
