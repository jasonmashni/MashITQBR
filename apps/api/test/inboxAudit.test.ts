import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = { REPORTS_MAILBOX: 'qbr-reports@mashit.net', REPORTS_TENANT_ID: 't', REPORTS_CLIENT_ID: 'c', REPORTS_CLIENT_SECRET: 's' };
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-inbox-audit-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
  Object.assign(process.env, ENV);
});
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
  for (const k of Object.keys(ENV)) delete process.env[k];
});

/** Graph returning two forwarded emails (no attachments) for one client. */
function stubGraph(): void {
  const body = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/oauth2/v2.0/token')) return body({ access_token: 't', expires_in: 3600 });
    if (init?.method === 'PATCH') return body({});
    if (url.includes('/mailFolders/inbox/messages?')) {
      return body({
        value: ['m1', 'm2'].map((id) => ({
          id,
          subject: `Fw: Topic ${id}`,
          hasAttachments: false,
          from: { emailAddress: { address: 'jason@mashit.net', name: 'Jason Mashni' } },
          toRecipients: [{ emailAddress: { address: 'qbr-reports+halo-62@mashit.net' } }],
          body: { contentType: 'text', content: 'Short note.' },
        })),
      });
    }
    return body({ value: [] });
  });
}

describe('pollInbox audit', () => {
  it('writes one audit event per poll carrying the agenda count', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore } = await import('../src/store/index.js');
    const store = getDataStore();
    await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates' });
    await store.putSnapshot({ clientId: 'halo-62', period: '2026-Q3', capturedAt: new Date().toISOString(), metrics: [] });
    stubGraph();
    const res = await h.pollInbox();
    expect(res.status).toBe(200);
    expect((res.json as { agenda: number }).agenda).toBe(2);
    const events = ((await h.getAudit('50')).json as { events: Array<{ action: string; detail?: string }> }).events.filter((e) => e.action === 'inbox.poll');
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatch(/\b2 agenda\b/);
  });
});
