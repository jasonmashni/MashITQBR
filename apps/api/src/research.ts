import Anthropic from '@anthropic-ai/sdk';

/**
 * Client & industry intelligence for QBR prep. Uses Claude with the web-search
 * server tool to surface RECENT, relevant developments an account manager
 * should walk into the meeting knowing — regulatory changes, market/industry
 * shifts, regional news — each tied to what it means for the client's IT and
 * where Mash IT can help. On demand (one call per click); degrades to the
 * model's own knowledge if web search is unavailable.
 */

// Web-search-capable model. Opus 4.8 supports web_search_20260209.
const RESEARCH_MODEL_ID = process.env['RESEARCH_MODEL']?.trim() || process.env['NARRATIVE_MODEL']?.trim() || 'claude-opus-4-8';

export interface ResearchTrend {
  title: string;
  /** What's happening (one sentence). */
  insight: string;
  /** Why it matters for THIS client's IT/security/compliance, or an opportunity. */
  relevance: string;
  sourceName?: string;
  sourceUrl?: string;
}

export interface ClientResearch {
  summary: string;
  trends: ResearchTrend[];
  suggestedGoals: Array<{ title: string; alignment: string }>;
  recommendations: string[];
  /** True when the model actually ran web searches (vs. its own knowledge). */
  sourced: boolean;
}

export interface ResearchInput {
  clientName: string;
  industry?: string;
  complianceStandard?: string;
  existingGoals: string[];
}

export type ResearchModel = (input: ResearchInput) => Promise<ClientResearch>;

const SYSTEM = `You are a vCIO at Mash IT, a managed IT services provider (MSP), preparing for a client's Quarterly Business Review. Research the client and their industry/region and surface a few RECENT, relevant developments the account manager should know — things that could affect the client's IT, security, or compliance priorities, or that create an opportunity for us to help them.

Use web search to find current, specific information: recent news, regulatory or compliance changes, industry/market shifts, and technology trends. Prefer items from roughly the last 12 months. For each, explain in plain business terms what it means for THIS client's IT and how Mash IT could support them.

Return ONLY a JSON object — no prose before or after it — with exactly this shape:
{
  "summary": "1-2 sentences on who the client is and their context",
  "trends": [
    { "title": "short headline", "insight": "what is happening (one sentence)", "relevance": "why it matters for this client's IT/security/compliance, or an opportunity for us", "sourceName": "publication name", "sourceUrl": "https://..." }
  ],
  "suggestedGoals": [ { "title": "a strategic goal phrased in the client's voice", "alignment": "how Mash IT's services support it" } ],
  "recommendations": [ "a concrete, useful recommendation for the account manager to consider" ]
}

Rules:
- 3 to 5 trends, 1 to 3 suggestedGoals, 2 to 4 recommendations.
- Every trend must carry a real sourceUrl from your search. Never fabricate a source, a statistic, or an event.
- Do not duplicate the client's existing goals.
- If you cannot find solid recent information, return fewer items rather than inventing them. Accuracy over volume.`;

/** Pull the outermost JSON object out of a model response (tolerant of stray prose). */
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in response');
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice) as Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Claude-backed researcher using the web-search server tool. */
export function createClaudeResearcher(client: Anthropic = new Anthropic(), modelId: string = RESEARCH_MODEL_ID): ResearchModel {
  return async (input) => {
    const user = [
      `Client: ${input.clientName}${input.industry ? ` — industry: ${input.industry}` : ''}${input.complianceStandard ? ` — compliance framework: ${input.complianceStandard}` : ''}.`,
      `Existing goals (do not duplicate): ${input.existingGoals.length ? input.existingGoals.join('; ') : '(none yet)'}.`,
      `Research this client and their industry, then return the JSON object.`,
    ].join('\n');

    const params = {
      model: modelId,
      max_tokens: 3500,
      system: SYSTEM,
      // Server-side web search — runs within this single request; the final
      // message carries the answer plus the search-result blocks.
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: user }],
    };
    // Stream to avoid request timeouts on the multi-search round trip.
    const resp = await client.messages.stream(params as unknown as Anthropic.MessageCreateParamsStreaming).finalMessage();
    const blocks = resp.content as Array<{ type: string; text?: string }>;
    const sourced = blocks.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    const parsed = extractJson(text);
    const trends: ResearchTrend[] = arr(parsed['trends'])
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          title: str(o['title']),
          insight: str(o['insight']),
          relevance: str(o['relevance']),
          sourceName: str(o['sourceName']) || undefined,
          sourceUrl: str(o['sourceUrl']) || undefined,
        };
      })
      .filter((t) => t.title && (t.insight || t.relevance));
    const suggestedGoals = arr(parsed['suggestedGoals'])
      .map((g) => {
        const o = (g ?? {}) as Record<string, unknown>;
        return { title: str(o['title']), alignment: str(o['alignment']) };
      })
      .filter((g) => g.title);
    const recommendations = arr(parsed['recommendations']).map(str).filter(Boolean);

    return {
      summary: str(parsed['summary']),
      trends,
      suggestedGoals,
      recommendations,
      sourced,
    };
  };
}
