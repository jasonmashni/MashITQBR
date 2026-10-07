import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeDocExtractor, pdfSourceSlug, type DocExtractModel } from '../src/docExtract.js';

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

describe('document findings', () => {
  it('the structured schema requires findings of {text, severity} before the note', async () => {
    const { client, calls } = fakeAnthropic({ vendor: 'X', period_hint: '', metrics: [], findings: [], note: '' });
    await createClaudeDocExtractor(client)(input);
    const schema = (calls[0]!['output_config'] as { format: { schema: Record<string, unknown> } }).format.schema as {
      required: string[];
      properties: Record<string, { items?: { required: string[]; additionalProperties: boolean; properties: Record<string, { enum?: string[] }> } }>;
    };
    expect(schema.required).toContain('findings');
    expect(schema.required.indexOf('findings')).toBeLessThan(schema.required.indexOf('note'));
    const item = schema.properties['findings']!.items!;
    expect(item.required).toEqual(['text', 'severity']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties['severity']!.enum).toEqual(['info', 'watch', 'act']);
    const system = JSON.stringify(calls[0]!['system']);
    expect(system).toContain('Never include a person');
  });

  it('keeps at most five findings, drops anything shaped like an email address and defaults a bad severity', async () => {
    const { client } = fakeAnthropic({
      vendor: 'Synology',
      period_hint: '2026-Q2',
      metrics: [],
      findings: [
        { text: 'One lab PC (TGA2) has not backed up in 389 days', severity: 'act' },
        { text: 'Backups for someone@example.com failed twice', severity: 'watch' },
        { text: 'One production task failed on June 11', severity: 'loud' },
        { text: 'A', severity: 'info' },
        { text: 'B', severity: 'info' },
        { text: 'C', severity: 'info' },
        { text: '   ', severity: 'info' },
      ],
      note: '',
    });
    const out = await createClaudeDocExtractor(client)(input);
    expect(out.findings).toEqual([
      { text: 'One lab PC (TGA2) has not backed up in 389 days', severity: 'act' },
      { text: 'One production task failed on June 11', severity: 'info' },
      { text: 'A', severity: 'info' },
      { text: 'B', severity: 'info' },
      { text: 'C', severity: 'info' },
    ]);
  });

  it('tells the model when the client is a covered entity', async () => {
    const { client, calls } = fakeAnthropic({ vendor: 'X', period_hint: '', metrics: [], findings: [], note: '' });
    await createClaudeDocExtractor(client)({ ...input, coveredEntity: true });
    const msg = (calls[0]!['messages'] as Array<{ content: Array<Record<string, unknown>> }>)[0]!;
    const text = msg.content.find((b) => b['type'] === 'text') as { text: string };
    expect(text.text).toContain('coveredEntity: true');
  });
});

describe('extractQbrDocument stores findings', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbr-findings-'));
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QBR_DATA_DIR'];
  });

  it('passes coveredEntity for a HIPAA client and keeps the findings on the document for the report', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore, docPath, loadReportInputs } = await import('../src/store/index.js');
    const store = getDataStore();
    await store.upsertClient({ id: 'clinic', name: 'Bluegrass Clinic', hipaa: true });
    const record = {
      id: 'doc1',
      clientId: 'clinic',
      period: '2026-Q2',
      name: 'Synology Active Backup.pdf',
      source: 'upload',
      contentType: 'application/pdf',
      size: 10,
      uploadedAt: '2026-07-01T00:00:00.000Z',
      uploadedBy: 'test',
    };
    await store.putDocument(record);
    await getDocStore().put(docPath('clinic', '2026-Q2', 'doc1', record.name), Buffer.from('%PDF-1.4 fake'), 'application/pdf');

    let seen: Parameters<DocExtractModel>[0] | undefined;
    const extractor: DocExtractModel = async (args) => {
      seen = args;
      return { vendor: 'Synology', periodHint: '2026-Q2', metrics: [], findings: [{ text: 'One lab PC has not backed up in 389 days', severity: 'act' }], note: '' };
    };
    const res = await h.extractQbrDocument('clinic', '2026-Q2', 'doc1', extractor);
    expect(res.status).toBe(200);
    expect(seen?.coveredEntity).toBe(true);
    expect((await store.getDocument('clinic', '2026-Q2', 'doc1'))?.findings).toEqual([{ text: 'One lab PC has not backed up in 389 days', severity: 'act' }]);
    const inputs = await loadReportInputs(store, 'clinic', '2026-Q2');
    expect(inputs.documents).toEqual([
      { name: 'Synology Active Backup.pdf', source: 'upload', findings: [{ text: 'One lab PC has not backed up in 389 days', severity: 'act' }] },
    ]);
  });

  it('loadReportInputs carries the previous quarter discussion for Since last quarter', async () => {
    const { getDataStore, loadReportInputs } = await import('../src/store/index.js');
    const store = getDataStore();
    expect((await loadReportInputs(store, 'clinic', '2026-Q2')).previousDiscussion).toBeUndefined();
    await store.putDiscussion({ clientId: 'clinic', period: '2026-Q1', items: [{ id: 'p1', topic: 'Firewall refresh', status: 'discussed' }] });
    const inputs = await loadReportInputs(store, 'clinic', '2026-Q2');
    expect(inputs.previousDiscussion?.map((d) => d.topic)).toEqual(['Firewall refresh']);
    // Nothing was pushed to Halo, so no lookup is built.
    expect(inputs.lookupTicketStatus).toBeUndefined();
  });
});

describe('pdfSourceSlug', () => {
  it('slugs the vendor into a pdf: source', () => {
    expect(pdfSourceSlug('Check Point')).toBe('pdf:check-point');
    expect(pdfSourceSlug('')).toBe('pdf:document');
    expect(pdfSourceSlug('Prev QBR (Zomentum)')).toBe('pdf:prev-qbr-zomentum');
  });
});
