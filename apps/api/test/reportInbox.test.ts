import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonDataStore, LocalDocStore } from '../src/store/index.js';
import { clientInboxAddress, inboxConfigFromEnv, isTrustedSender, pollReportInbox, routeClientId, routePeriod } from '../src/reportInbox.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-inbox-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('inbox routing', () => {
  it('derives per-client plus-addresses and routes recipients back to clients', () => {
    expect(clientInboxAddress('qbr-reports@mashit.net', 'halo-62')).toBe('qbr-reports+halo-62@mashit.net');
    expect(routeClientId(['qbr-reports+halo-62@mashit.net'], 'qbr-reports@mashit.net')).toBe('halo-62');
    expect(routeClientId(['QBR-Reports+HALO-62@MASHIT.NET'], 'qbr-reports@mashit.net')).toBe('halo-62');
    expect(routeClientId(['someone@else.com', 'qbr-reports@mashit.net'], 'qbr-reports@mashit.net')).toBeUndefined();
    // A different mailbox's plus-tag never routes.
    expect(routeClientId(['other+halo-62@mashit.net'], 'qbr-reports@mashit.net')).toBeUndefined();
  });

  it('files into the subject-tagged quarter, else the current one', () => {
    const now = new Date('2026-07-03T12:00:00Z');
    expect(routePeriod('Check Point weekly — 2026-Q2', now)).toBe('2026-Q2');
    expect(routePeriod('Endpoint Management Report for QBRs', now)).toBe('2026-Q3');
  });
});

describe('pollReportInbox', () => {
  it('reads unread mail, files attachments as client documents, and marks messages read', async () => {
    const store = new JsonDataStore(dir);
    const docs = new LocalDocStore(join(dir, 'docs'));
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates' });

    const patched: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      if (url.includes('/oauth2/v2.0/token')) return body({ access_token: 't', expires_in: 3600 });
      if (init?.method === 'PATCH') {
        patched.push(String(JSON.parse(String(init.body)).categories));
        return body({});
      }
      if (url.includes('/attachments')) {
        return body({
          value: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'CheckPoint Q2 report.pdf',
              contentType: 'application/pdf',
              contentBytes: Buffer.from('%PDF-1.7 cp').toString('base64'),
            },
          ],
        });
      }
      if (url.includes('/mailFolders/inbox/messages?')) {
        return body({
          value: [
            {
              id: 'm1',
              subject: 'FW: Check Point weekly 2026-Q2',
              from: { emailAddress: { address: 'jason@mashit.net' } },
              hasAttachments: true,
              toRecipients: [{ emailAddress: { address: 'qbr-reports+halo-62@mashit.net' } }],
            },
            { id: 'm2', subject: 'spam', hasAttachments: true, from: { emailAddress: { address: 'Ops@MashIT.net' } }, toRecipients: [{ emailAddress: { address: 'qbr-reports@mashit.net' } }] },
          ],
        });
      }
      if (url.includes('/mailFolders/junkemail/messages?')) return body({ value: [] });
      if (url.endsWith('/mailFolders/inbox')) return body({ totalItemCount: 5, unreadItemCount: 2 });
      if (url.endsWith('/mailFolders/junkemail')) return body({ totalItemCount: 1, unreadItemCount: 0 });
      return body({});
    }) as never;

    const cfg = { mailbox: 'qbr-reports@mashit.net', tenantId: 't', clientId: 'c', clientSecret: 's' };
    const result = await pollReportInbox(cfg, store, docs, fetchFn, new Date('2026-07-03T12:00:00Z'));
    expect(result).toMatchObject({ processed: 2, filed: 1, unrouted: 1 });
    // Folder stats make "0 processed" diagnosable (read mail / mail in Junk).
    expect(result.folders).toEqual([
      { folder: 'inbox', total: 5, unread: 2 },
      { folder: 'junkemail', total: 1, unread: 0 },
    ]);

    // Filed into the subject's quarter for the plus-addressed client.
    const filed = await store.listDocuments('halo-62', '2026-Q2');
    expect(filed).toHaveLength(1);
    expect(filed[0]!.name).toBe('CheckPoint Q2 report.pdf');
    expect(filed[0]!.source).toBe('email');
    // Both messages were marked read (filed + unrouted categories).
    expect(patched.some((c) => c.includes('filed'))).toBe(true);
    expect(patched.some((c) => c.includes('unrouted'))).toBe(true);
  });

  it('surfaces the Graph error body when the mailbox read fails (diagnosable from the UI)', async () => {
    const store = new JsonDataStore(dir);
    const docs = new LocalDocStore(join(dir, 'docs'));
    const fetchFn = (async (url: string) => {
      if (url.includes('/oauth2/v2.0/token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
      return { ok: false, status: 403, json: async () => ({ error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } }) };
    }) as never;
    const cfg = { mailbox: 'qbr-reports@mashit.net', tenantId: 't', clientId: 'c', clientSecret: 's' };
    await expect(pollReportInbox(cfg, store, docs, fetchFn)).rejects.toThrow(/Access is denied.*Mail\.ReadWrite/);
  });
});

describe('sender trust', () => {
  it('trusts only the mailbox domain when no allowlist is set', () => {
    expect(isTrustedSender('evil@example.org', 'qbr-reports@mashit.net', [])).toBe(false);
    expect(isTrustedSender('Jason@MashIT.net', 'qbr-reports@mashit.net', [])).toBe(true);
    expect(isTrustedSender('', 'qbr-reports@mashit.net', [])).toBe(false);
    expect(isTrustedSender('x@notmashit.net', 'qbr-reports@mashit.net', [])).toBe(false);
  });

  it('admits allowlisted domains and exact addresses, case-insensitively', () => {
    const allow = inboxConfigFromEnv({
      REPORTS_MAILBOX: 'qbr-reports@mashit.net',
      REPORTS_TENANT_ID: 't',
      REPORTS_CLIENT_ID: 'c',
      REPORTS_CLIENT_SECRET: 's',
      REPORTS_ALLOWED_SENDERS: 'checkpoint.com, Reports@Huntress.io',
    })!.allowedSenders;
    expect(allow).toEqual(['checkpoint.com', 'reports@huntress.io']);
    expect(isTrustedSender('noreply@checkpoint.com', 'qbr-reports@mashit.net', allow)).toBe(true);
    expect(isTrustedSender('reports@huntress.io', 'qbr-reports@mashit.net', allow)).toBe(true);
    expect(isTrustedSender('other@huntress.io', 'qbr-reports@mashit.net', allow)).toBe(false);
    expect(isTrustedSender('noreply@evilcheckpoint.com', 'qbr-reports@mashit.net', allow)).toBe(false);
  });
});

describe('pollReportInbox trust + resilience', () => {
  type Msg = { id: string; from?: string; subject?: string; folder?: 'inbox' | 'junkemail' };
  function fakeGraph(msgs: Msg[], opts: { failAttachmentsFor?: string } = {}) {
    const patched: Array<{ id: string; categories: string; isRead: boolean }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      if (url.includes('/oauth2/v2.0/token')) return body({ access_token: 't', expires_in: 3600 });
      if (init?.method === 'PATCH') {
        const b = JSON.parse(String(init.body));
        patched.push({ id: url.split('/messages/')[1]!, categories: String(b.categories), isRead: b.isRead });
        return body({});
      }
      if (url.includes('/attachments')) {
        if (opts.failAttachmentsFor && url.includes(`/messages/${opts.failAttachmentsFor}/`)) throw new Error('socket hang up');
        return body({
          value: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'report.pdf', contentType: 'application/pdf', contentBytes: Buffer.from('%PDF x').toString('base64') }],
        });
      }
      const folderHit = url.match(/\/mailFolders\/(inbox|junkemail)\/messages\?/);
      if (folderHit) {
        return body({
          value: msgs.filter((m) => (m.folder ?? 'inbox') === folderHit[1]).map((m) => ({
            id: m.id,
            subject: m.subject ?? 'report 2026-Q2',
            hasAttachments: true,
            from: m.from ? { emailAddress: { address: m.from } } : undefined,
            toRecipients: [{ emailAddress: { address: 'qbr-reports+halo-62@mashit.net' } }],
          })),
        });
      }
      return body({ value: [] });
    }) as never;
    return { fetchFn, patched };
  }
  const cfg = { mailbox: 'qbr-reports@mashit.net', tenantId: 't', clientId: 'c', clientSecret: 's' };

  it('does not file mail from an untrusted sender and categorizes it', async () => {
    const store = new JsonDataStore(join(dir, 'trust-a'));
    const docs = new LocalDocStore(join(dir, 'trust-a', 'docs'));
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates' });
    const { fetchFn, patched } = fakeGraph([{ id: 'e1', from: 'evil@example.org' }]);
    const result = await pollReportInbox(cfg, store, docs, fetchFn, new Date('2026-07-03T12:00:00Z'));
    expect(result.filed).toBe(0);
    expect(result.untrusted).toBe(1);
    expect(await store.listDocuments('halo-62', '2026-Q2')).toHaveLength(0);
    expect(patched).toEqual([{ id: 'e1', categories: 'QBR: untrusted', isRead: true }]);
  });

  it('admits an allowlisted vendor domain', async () => {
    const store = new JsonDataStore(join(dir, 'trust-b'));
    const docs = new LocalDocStore(join(dir, 'trust-b', 'docs'));
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates' });
    const { fetchFn } = fakeGraph([{ id: 'v1', from: 'noreply@checkpoint.com' }]);
    const result = await pollReportInbox({ ...cfg, allowedSenders: ['checkpoint.com', 'reports@huntress.io'] }, store, docs, fetchFn, new Date('2026-07-03T12:00:00Z'));
    expect(result.filed).toBe(1);
    const filed = await store.listDocuments('halo-62', '2026-Q2');
    expect(filed[0]!.from).toBe('noreply@checkpoint.com');
  });

  it('a message that fails is categorized failed, marked read, and the next one is still processed', async () => {
    const store = new JsonDataStore(join(dir, 'trust-c'));
    const docs = new LocalDocStore(join(dir, 'trust-c', 'docs'));
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates' });
    const { fetchFn, patched } = fakeGraph(
      [
        { id: 'bad', from: 'jason@mashit.net', subject: 'a 2026-Q2' },
        { id: 'good', from: 'jason@mashit.net', subject: 'b 2026-Q2' },
      ],
      { failAttachmentsFor: 'bad' },
    );
    const logged: string[] = [];
    const result = await pollReportInbox(cfg, store, docs, fetchFn, new Date('2026-07-03T12:00:00Z'), { log: (m) => logged.push(m) });
    expect(result.failed).toEqual([{ id: 'bad', subject: 'a 2026-Q2', error: 'socket hang up' }]);
    expect(logged.some((l) => l.includes('bad') && l.includes('socket hang up'))).toBe(true);
    expect(result.filed).toBe(1);
    expect(patched).toContainEqual({ id: 'bad', categories: 'QBR: failed', isRead: true });
    expect(patched).toContainEqual({ id: 'good', categories: 'QBR: filed', isRead: true });
    const filed = await store.listDocuments('halo-62', '2026-Q2');
    expect(filed).toHaveLength(1);
    expect(filed[0]!.from).toBe('jason@mashit.net');
  });

  it('never trusts mail from the Junk folder, even from our own domain (DMARC-failing spoof)', async () => {
    const store = new JsonDataStore(join(dir, 'trust-d'));
    const docs = new LocalDocStore(join(dir, 'trust-d', 'docs'));
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates' });
    const { fetchFn, patched } = fakeGraph([
      { id: 'spoof', from: 'jason@mashit.net', folder: 'junkemail' },
      { id: 'vendor', from: 'noreply@checkpoint.com', folder: 'junkemail' },
      { id: 'real', from: 'jason@mashit.net', subject: 'c 2026-Q2' },
    ]);
    const result = await pollReportInbox({ ...cfg, allowedSenders: ['checkpoint.com'] }, store, docs, fetchFn, new Date('2026-07-03T12:00:00Z'));
    expect(result.untrusted).toBe(2);
    expect(result.filed).toBe(1);
    expect(patched).toContainEqual({ id: 'spoof', categories: 'QBR: untrusted', isRead: true });
    expect(patched).toContainEqual({ id: 'vendor', categories: 'QBR: untrusted', isRead: true });
    expect(patched).toContainEqual({ id: 'real', categories: 'QBR: filed', isRead: true });
    const filed = await store.listDocuments('halo-62', '2026-Q2');
    expect(filed).toHaveLength(1);
  });
});

describe('pollReportInbox forward to QBR (no attachments)', () => {
  const cfg = { mailbox: 'qbr-reports@mashit.net', tenantId: 't', clientId: 'c', clientSecret: 's' };
  const now = new Date('2026-10-07T12:00:00Z');
  type Msg = { id: string; subject: string; body?: { contentType: 'text' | 'html'; content: string }; name?: string };
  function fakeGraph(msgs: Msg[]) {
    const patched: Array<{ id: string; categories: string }> = [];
    const listUrls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
      if (url.includes('/oauth2/v2.0/token')) return body({ access_token: 't', expires_in: 3600 });
      if (init?.method === 'PATCH') {
        patched.push({ id: url.split('/messages/')[1]!, categories: String(JSON.parse(String(init.body)).categories) });
        return body({});
      }
      if (url.includes('/mailFolders/inbox/messages?')) {
        listUrls.push(url);
        return body({
          value: msgs.map((m) => ({
            id: m.id,
            subject: m.subject,
            hasAttachments: false,
            from: { emailAddress: { address: 'jason@mashit.net', name: m.name ?? 'Jason Mashni' } },
            toRecipients: [{ emailAddress: { address: 'qbr-reports+halo-62@mashit.net' } }],
            body: m.body,
            bodyPreview: m.body?.content.slice(0, 255),
          })),
        });
      }
      return body({ value: [] });
    }) as never;
    return { fetchFn, patched, listUrls };
  }
  const longText = 'Hi Jason, we have a new hire starting Nov 3 in the billing office. ' + 'She needs a laptop, a mailbox and EHR access. '.repeat(20);

  async function setup(sub: string, client: Record<string, unknown> = {}) {
    const store = new JsonDataStore(join(dir, sub));
    const docs = new LocalDocStore(join(dir, sub, 'docs'));
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates', ...client });
    return { store, docs };
  }

  it('turns a forwarded email into a planned, unpublished agenda item on the open quarter', async () => {
    const { store, docs } = await setup('fwd-a');
    // Q3 has a snapshot and no final lock, so it is the open quarter (not the calendar quarter Q4).
    await store.putSnapshot({ clientId: 'halo-62', period: '2026-Q3', capturedAt: now.toISOString(), metrics: [] });
    await store.putDiscussion({ clientId: 'halo-62', period: '2026-Q3', items: [{ id: 'x', topic: 'Existing', sortOrder: 4 }] });
    const { fetchFn, patched, listUrls } = fakeGraph([{ id: 'm1', subject: 'Fw: New hire starting Nov 3', body: { contentType: 'text', content: longText } }]);
    const result = await pollReportInbox(cfg, store, docs, fetchFn, now);
    expect(listUrls[0]).toContain('body');
    expect(result).toMatchObject({ processed: 1, filed: 0, unrouted: 0, agenda: 1 });
    const disc = await store.getDiscussion('halo-62', '2026-Q3');
    expect(disc!.items).toHaveLength(2);
    expect(disc!.items[0]!.id).toBe('x');
    const item = disc!.items[1]!;
    expect(item).toMatchObject({
      topic: 'New hire starting Nov 3',
      status: 'planned',
      includeInReport: false,
      source: 'email',
      sourceRef: 'm1',
      owner: 'Jason Mashni',
      sortOrder: 5,
    });
    expect(item.response).toBe(longText.replace(/\s+/g, ' ').trim().slice(0, 400));
    expect(item.response!.startsWith('Hi Jason, we have')).toBe(true);
    expect(patched).toEqual([{ id: 'm1', categories: 'QBR: agenda' }]);
  });

  it('strips HTML and stacked prefixes, and skips a quarter with a final lock', async () => {
    const { store, docs } = await setup('fwd-b');
    await store.putSnapshot({ clientId: 'halo-62', period: '2026-Q3', capturedAt: now.toISOString(), metrics: [] });
    await store.upsertQbr({ clientId: 'halo-62', period: '2026-Q3', status: 'completed', locks: { final: { at: now.toISOString(), by: 'x', version: 1 } }, updatedAt: now.toISOString() });
    const { fetchFn } = fakeGraph([
      { id: 'm2', subject: 'RE: fwd: FW:  Printer lease ends', body: { contentType: 'html', content: '<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Jason,</p><p>the lease &amp; contract</p></body></html>' } },
    ]);
    const result = await pollReportInbox(cfg, store, docs, fetchFn, now);
    expect(result.agenda).toBe(1);
    expect(await store.getDiscussion('halo-62', '2026-Q3')).toBeUndefined();
    const item = (await store.getDiscussion('halo-62', '2026-Q4'))!.items[0]!;
    expect(item.topic).toBe('Printer lease ends');
    expect(item.response).toBe('Hi Jason, the lease & contract');
    expect(item.sortOrder).toBe(0);
  });

  it('never stores the email body for a HIPAA client', async () => {
    const { store, docs } = await setup('fwd-c', { hipaa: true });
    const { fetchFn } = fakeGraph([{ id: 'm3', subject: 'Fw: New hire starting Nov 3', body: { contentType: 'text', content: 'Patient John Doe DOB 1/1/1970' } }]);
    const result = await pollReportInbox(cfg, store, docs, fetchFn, now);
    expect(result.agenda).toBe(1);
    const item = (await store.getDiscussion('halo-62', '2026-Q4'))!.items[0]!;
    expect(item.topic).toBe('New hire starting Nov 3');
    expect(item.response).toBeUndefined();
    expect(JSON.stringify(await store.getDiscussion('halo-62', '2026-Q4'))).not.toContain('John Doe');
  });

  it('an empty subject after stripping creates nothing and is counted unrouted', async () => {
    const { store, docs } = await setup('fwd-d');
    const { fetchFn, patched } = fakeGraph([{ id: 'm4', subject: 'Fw:', body: { contentType: 'text', content: 'hello' } }]);
    const result = await pollReportInbox(cfg, store, docs, fetchFn, now);
    expect(result).toMatchObject({ agenda: 0, unrouted: 1 });
    expect(await store.getDiscussion('halo-62', '2026-Q4')).toBeUndefined();
    expect(patched).toEqual([{ id: 'm4', categories: 'QBR: no subject' }]);
  });

  it('does not add the same message twice', async () => {
    const { store, docs } = await setup('fwd-e');
    const { fetchFn } = fakeGraph([{ id: 'm5', subject: 'Fw: Topic', body: { contentType: 'text', content: 'x' } }]);
    await pollReportInbox(cfg, store, docs, fetchFn, now);
    await pollReportInbox(cfg, store, docs, fetchFn, now);
    expect((await store.getDiscussion('halo-62', '2026-Q4'))!.items).toHaveLength(1);
  });
});
