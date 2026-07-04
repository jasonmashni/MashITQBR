import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonDataStore, LocalDocStore } from '../src/store/index.js';
import { clientInboxAddress, pollReportInbox, routeClientId, routePeriod } from '../src/reportInbox.js';

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
              hasAttachments: true,
              toRecipients: [{ emailAddress: { address: 'qbr-reports+halo-62@mashit.net' } }],
            },
            { id: 'm2', subject: 'spam', hasAttachments: true, toRecipients: [{ emailAddress: { address: 'qbr-reports@mashit.net' } }] },
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
