/**
 * Build an RFC 822 .eml file that opens in Outlook desktop as an UNSENT draft
 * (the `X-Unsent: 1` header) — recipient and a short message pre-filled and
 * the QBR PDF attached. Zero Graph permissions needed: the user just reviews
 * and hits Send in their own Outlook.
 */

const CRLF = '\r\n';

/** RFC 2047 UTF-8 encoded header word (subjects can carry em-dashes etc.). */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64 body wrapped at the RFC-mandated 76 columns. */
function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, `$1${CRLF}`);
}

export interface EmailAttachment {
  name: string;
  contentType: string;
  bytes: Buffer;
}

export interface EmailDraftInput {
  to?: string;
  subject: string;
  bodyText: string;
  attachments?: EmailAttachment[];
}

export function buildEmailDraft(input: EmailDraftInput): Buffer {
  const boundary = `qbr-${Math.random().toString(36).slice(2, 10)}`;
  const attachments = input.attachments ?? [];
  const lines: string[] = [
    'X-Unsent: 1',
    ...(input.to ? [`To: ${input.to}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
  ];

  if (attachments.length === 0) {
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(input.bodyText, 'utf8').toString('base64')));
    return Buffer.from(lines.join(CRLF), 'utf8');
  }

  lines.push(
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(input.bodyText, 'utf8').toString('base64')),
  );
  for (const att of attachments) {
    const name = att.name.replace(/["\\]/g, '');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType}; name="${encodeHeader(name)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(name)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(att.bytes.toString('base64')),
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join(CRLF), 'utf8');
}

/** The short, human email body — the report does the talking. */
export function qbrEmailBody(args: { contactName?: string; periodLabel: string; orgName: string; senderName?: string }): string {
  const first = args.contactName?.split(/\s+/)[0];
  return [
    `Hi${first ? ` ${first}` : ''},`,
    '',
    `Attached is your ${args.periodLabel} business review from ${args.orgName}. We'll walk through it together in our meeting — feel free to reach out with any questions in the meantime.`,
    '',
    'Best regards,',
    args.senderName ?? args.orgName,
  ].join('\n');
}
