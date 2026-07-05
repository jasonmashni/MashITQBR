import { describe, expect, it } from 'vitest';
import { createClaudeDocMatcher, DOC_CATEGORIES } from '../src/docMatch.js';

/** Fake Anthropic client that records the request and returns a canned block. */
function fakeAnthropic(reply: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push(params);
        return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
      },
    },
  };
  return { client: client as never, calls };
}

const input = {
  pdfBase64: Buffer.from('%PDF-1.4 fake').toString('base64'),
  clientName: 'Madison Pediatrics',
  currentName: 'Attachment (3).pdf',
  currentPeriod: '2026-Q3',
  periods: ['2026-Q3', '2026-Q2', '2026-Q1'],
};

describe('AI document matcher', () => {
  it('sends the PDF as a native document block with the filing context', async () => {
    const { client, calls } = fakeAnthropic({
      vendor: 'Huntress',
      suggested_name: 'Huntress Quarterly Summary 2026-Q2.pdf',
      suggested_period: '2026-Q2',
      suggested_category: 'Security',
      client_match: 'yes',
      confidence: 'high',
      rationale: 'The report names Madison Pediatrics and covers Apr–Jun 2026.',
    });
    const suggestion = await createClaudeDocMatcher(client)(input);

    const msg = (calls[0]!['messages'] as Array<{ content: Array<Record<string, unknown>> }>)[0]!;
    const doc = msg.content.find((b) => b['type'] === 'document') as { source: Record<string, unknown> };
    expect(doc.source['media_type']).toBe('application/pdf');
    expect(doc.source['data']).toBe(input.pdfBase64);
    const text = msg.content.find((b) => b['type'] === 'text') as { text: string };
    expect(text.text).toContain('Madison Pediatrics');
    expect(text.text).toContain('2026-Q3');

    expect(suggestion.suggestedName).toBe('Huntress Quarterly Summary 2026-Q2.pdf');
    expect(suggestion.suggestedPeriod).toBe('2026-Q2');
    expect(suggestion.suggestedCategory).toBe('Security');
    expect(DOC_CATEGORIES).toContain(suggestion.suggestedCategory);
    expect(suggestion.clientMatch).toBe('yes');
    expect(suggestion.confidence).toBe('high');
  });

  it('falls back to safe values on unexpected fields', async () => {
    const { client } = fakeAnthropic({ vendor: 'X', client_match: 'maybe?', confidence: 'sure' });
    const suggestion = await createClaudeDocMatcher(client)(input);
    expect(suggestion.suggestedName).toBe(input.currentName);
    expect(suggestion.suggestedPeriod).toBe(input.currentPeriod);
    expect(suggestion.clientMatch).toBe('unsure');
    expect(suggestion.confidence).toBe('low');
  });

  it('surfaces non-JSON model output as a clear error', async () => {
    const client = { messages: { async create() { return { content: [{ type: 'text', text: 'Sorry, I cannot' }] }; } } };
    await expect(createClaudeDocMatcher(client as never)(input)).rejects.toThrow(/did not return valid JSON/);
  });
});
