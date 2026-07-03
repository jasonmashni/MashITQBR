import { describe, it, expect } from 'vitest';
import { buildEmailDraft, qbrEmailBody } from '../src/emailDraft.js';

describe('buildEmailDraft', () => {
  it('produces an unsent Outlook draft with recipient, subject and PDF attachment', () => {
    const eml = buildEmailDraft({
      to: 'anne@client.com',
      subject: 'Mash IT QBR — ANP Enertech Q1 2026',
      bodyText: 'Hi Anne,\n\nAttached is your review.',
      attachments: [{ name: 'QBR-ANP-2026-Q1.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.7 fake') }],
    }).toString('utf8');

    // The header Outlook uses to open the file in compose (not read) mode.
    expect(eml).toMatch(/^X-Unsent: 1\r\n/);
    expect(eml).toContain('To: anne@client.com\r\n');
    // Non-ASCII subject (em-dash) is RFC 2047 encoded.
    expect(eml).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    expect(eml).toContain('Content-Type: multipart/mixed; boundary=');
    expect(eml).toContain('Content-Type: application/pdf; name="QBR-ANP-2026-Q1.pdf"');
    expect(eml).toContain('Content-Disposition: attachment; filename="QBR-ANP-2026-Q1.pdf"');
    // Attachment payload is the base64 of the PDF bytes.
    expect(eml).toContain(Buffer.from('%PDF-1.7 fake').toString('base64'));
    // Body text round-trips through its base64 part.
    const bodyB64 = Buffer.from('Hi Anne,\n\nAttached is your review.', 'utf8').toString('base64');
    expect(eml.replace(/\r\n/g, '')).toContain(bodyB64);
  });

  it('plain ASCII subjects stay readable and drafts work without an attachment', () => {
    const eml = buildEmailDraft({ subject: 'Plain subject', bodyText: 'Hello' }).toString('utf8');
    expect(eml).toContain('Subject: Plain subject\r\n');
    expect(eml).toContain('Content-Type: text/plain; charset=utf-8');
    expect(eml).not.toContain('multipart/mixed');
  });

  it('carries every vendor report as its own attachment', () => {
    const eml = buildEmailDraft({
      subject: 'QBR',
      bodyText: 'Hi',
      attachments: [
        { name: 'QBR.pdf', contentType: 'application/pdf', bytes: Buffer.from('main') },
        { name: 'Huntress quarterly.pdf', contentType: 'application/pdf', bytes: Buffer.from('huntress') },
        { name: 'CheckPoint report.pdf', contentType: 'application/pdf', bytes: Buffer.from('checkpoint') },
      ],
    }).toString('utf8');
    expect(eml.match(/Content-Disposition: attachment/g)?.length).toBe(3);
    expect(eml).toContain('filename="Huntress quarterly.pdf"');
    expect(eml).toContain('filename="CheckPoint report.pdf"');
  });
});

describe('qbrEmailBody', () => {
  it('writes the short, human message', () => {
    const body = qbrEmailBody({ contactName: 'Anne Smith', periodLabel: 'Q1 2026', orgName: 'Mash IT', senderName: 'Jason Mashni' });
    expect(body).toContain('Hi Anne,');
    expect(body).toContain('Q1 2026 business review from Mash IT');
    expect(body.endsWith('Jason Mashni')).toBe(true);
    expect(body.split('\n').length).toBeLessThan(8); // deliberately short
  });
});
