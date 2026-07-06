import { describe, expect, it } from 'vitest';
import { createClaudeDocExtractor, pdfSourceSlug } from '../src/docExtract.js';

/** Fake Anthropic client — the extractor streams, so expose messages.stream().finalMessage(). */
function fakeAnthropic(reply: unknown, opts: { rawText?: string; stopReason?: string } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const message = {
    content: [{ type: 'text', text: opts.rawText ?? JSON.stringify(reply) }],
    stop_reason: opts.stopReason ?? 'end_turn',
  };
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        calls.push(params);
        return { async finalMessage() { return message; } };
      },
    },
  };
  return { client: client as never, calls };
}

const input = {
  pdfBase64: Buffer.from('%PDF-1.4 fake').toString('base64'),
  clientName: 'Madison Pediatrics',
  period: '2026-Q2',
  knownKeys: [
    { key: 'email.phishing', label: 'Phishing' },
    { key: 'email.spam', label: 'Spam' },
  ],
};

describe('AI document metric extraction', () => {
  it('maps structured rows, sanitizing keys / categories / directions', async () => {
    const { client, calls } = fakeAnthropic({
      vendor: 'Check Point',
      period_hint: '2026-Q2',
      note: 'Security Checkup covering Apr–Jun 2026.',
      metrics: [
        { key: 'email.phishing', label: 'Phishing emails', value: 7, unit: 'count', category: 'security', direction: 'lower_is_better' },
        { key: 'BAD KEY!!', label: 'Graymail emails', value: 616, unit: 'count', category: 'security', direction: 'neutral' },
        { key: 'email.dlp_events', label: 'DLP events', value: 49, unit: 'count', category: 'wrong-cat', direction: 'lower_is_better' },
        { key: 'email.broken', label: 'Broken row', value: 'not-a-number', unit: '', category: 'security', direction: 'neutral' },
      ],
    });
    const out = await createClaudeDocExtractor(client)(input);

    // The known-keys catalog rode along in the prompt.
    const msg = (calls[0]!['messages'] as Array<{ content: Array<Record<string, unknown>> }>)[0]!;
    const text = msg.content.find((b) => b['type'] === 'text') as { text: string };
    expect(text.text).toContain('email.phishing');
    expect(text.text).toContain('2026-Q2');

    expect(out.vendor).toBe('Check Point');
    expect(out.periodHint).toBe('2026-Q2');
    expect(out.metrics).toHaveLength(3); // non-numeric row dropped
    expect(out.metrics[0]).toMatchObject({ key: 'email.phishing', value: 7, higherIsBetter: false });
    expect(out.metrics[1]!.key).toBe('doc.graymail_emails'); // invalid key re-minted from the label
    expect(out.metrics[2]!.category).toBe('security'); // invalid category falls back
  });

  it('blanks an unparseable period hint', async () => {
    const { client } = fakeAnthropic({ vendor: 'X', period_hint: 'last quarter', note: '', metrics: [] });
    expect((await createClaudeDocExtractor(client)(input)).periodHint).toBe('');
  });

  it('gives a clear "too large" error when the response is truncated (max_tokens)', async () => {
    // A truncated structured-output reply: valid JSON start, cut off mid-object.
    const { client } = fakeAnthropic(null, { rawText: '{"vendor":"Mash IT+","period_hint":"2026-Q1","metrics":[{"key":"doc.a","label":"A","valu', stopReason: 'max_tokens' });
    await expect(createClaudeDocExtractor(client)(input)).rejects.toThrow(/too large|cut off/i);
  });
});

describe('pdfSourceSlug', () => {
  it('slugs the vendor into a pdf: source', () => {
    expect(pdfSourceSlug('Check Point')).toBe('pdf:check-point');
    expect(pdfSourceSlug('')).toBe('pdf:document');
    expect(pdfSourceSlug('Prev QBR (Zomentum)')).toBe('pdf:prev-qbr-zomentum');
  });
});
