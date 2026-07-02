import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphTokenFrom, validEmails } from '../src/graph.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-graph-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

const withToken = (extra: Record<string, string> = {}) => (name: string) =>
  ({ 'x-ms-token-aad-access-token': 'tok-123', ...extra })[name];

describe('graphTokenFrom', () => {
  it('reads the Easy Auth token header and detects expiry', () => {
    expect(graphTokenFrom(() => undefined)).toEqual({});
    expect(graphTokenFrom(withToken())).toEqual({ token: 'tok-123' });
    const stale = withToken({ 'x-ms-token-aad-expires-on': new Date(Date.now() - 1000).toISOString() });
    expect(graphTokenFrom(stale)).toEqual({ token: 'tok-123', expired: true });
    const fresh = withToken({ 'x-ms-token-aad-expires-on': new Date(Date.now() + 3600_000).toISOString() });
    expect(graphTokenFrom(fresh)).toEqual({ token: 'tok-123' });
  });
});

describe('validEmails', () => {
  it('keeps only well-formed addresses', () => {
    expect(validEmails(['a@b.com', 'junk', '', 'x@y.io '])).toEqual(['a@b.com', 'x@y.io']);
    expect(validEmails('a@b.com')).toEqual([]);
  });
});

describe('emailQbr / createMeeting handlers', () => {
  it('401s without a Graph token and on expiry', async () => {
    const h = await import('../src/handlers.js');
    const none = await h.emailQbr('anp', '2026-Q1', { to: ['a@b.com'] }, () => undefined);
    expect(none.status).toBe(401);
    expect((none.json as { error: string }).error).toBe('graph_token_missing');

    const stale = withToken({ 'x-ms-token-aad-expires-on': new Date(Date.now() - 1000).toISOString() });
    const expired = await h.createMeeting('anp', '2026-Q1', { start: new Date().toISOString() }, stale);
    expect(expired.status).toBe(401);
    expect((expired.json as { error: string }).error).toBe('token_expired');
  });

  it('sends mail with the deck attached via Graph', async () => {
    const h = await import('../src/handlers.js');
    let captured: { url?: string; body?: any } = {};
    const fetchFn = async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response('{}', { status: 202 });
    };
    const res = await h.emailQbr(
      'anp',
      '2026-Q1',
      { to: ['anne@client.com'], subject: 'QBR', bodyHtml: '<p>Hi</p>', attachDeck: true },
      withToken(),
      fetchFn,
    );
    expect(res.status).toBe(200);
    expect(captured.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(captured.body.message.toRecipients[0].emailAddress.address).toBe('anne@client.com');
    const att = captured.body.message.attachments[0];
    expect(att['@odata.type']).toBe('#microsoft.graph.fileAttachment');
    expect(att.name).toContain('.pptx');
    expect(att.contentBytes.length).toBeGreaterThan(1000); // real rendered deck
  });

  it('creates a Teams meeting and schedules the QBR with the join link', async () => {
    const h = await import('../src/handlers.js');
    const start = '2026-07-15T18:00:00.000Z';
    const fetchFn = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.isOnlineMeeting).toBe(true);
      expect(body.onlineMeetingProvider).toBe('teamsForBusiness');
      expect(body.start.dateTime).toBe(start);
      return new Response(JSON.stringify({ id: 'evt-1', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/j/abc' } }), { status: 201 });
    };
    const res = await h.createMeeting('anp', '2026-Q1', { start, attendees: ['anne@client.com'] }, withToken(), fetchFn);
    expect(res.status).toBe(200);
    expect((res.json as { joinUrl: string }).joinUrl).toBe('https://teams.microsoft.com/l/j/abc');

    // The QBR record advanced and carries the meeting details.
    const meta = await h.getQbr('anp', '2026-Q1', '0');
    const m = (meta.json as { meta: { status: string; meeting: { joinUrl: string; eventId: string } } }).meta;
    expect(m.status).toBe('scheduled');
    expect(m.meeting.joinUrl).toBe('https://teams.microsoft.com/l/j/abc');
    expect(m.meeting.eventId).toBe('evt-1');
  });

  it('surfaces Graph errors with the status code', async () => {
    const h = await import('../src/handlers.js');
    const fetchFn = async () => new Response(JSON.stringify({ error: { message: 'MailboxNotEnabledForRESTAPI' } }), { status: 403 });
    const res = await h.emailQbr('anp', '2026-Q1', { to: ['a@b.com'] }, withToken(), fetchFn);
    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toContain('403');
    expect((res.json as { error: string }).error).toContain('MailboxNotEnabled');
  });
});
