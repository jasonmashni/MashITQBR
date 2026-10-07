import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import { collectCheckpoint, normalizeCheckpointEvents, type CheckpointEvent, type HttpRequest, type HttpTransport } from '@mashit/integrations';

const events: CheckpointEvent[] = [
  { type: 'phishing', entity: { recipients: ['lisa@kypca.net'] } },
  { type: 'phishing', entity: { recipients: ['lisa@kypca.net'] } },
  { type: 'phishing', entity: { recipients: ['rick@kypca.net'] }, clicked: true },
  { type: 'malware', entity: { recipients: ['lisa@kypca.net'] } },
  { type: 'spam' },
  { type: 'graymail' },
  { type: 'dlp' },
  { type: 'clean' },
];

describe('normalizeCheckpointEvents', () => {
  const by = Object.fromEntries(normalizeCheckpointEvents(events).map((m) => [m.key, m.value]));

  it('counts events by category', () => {
    expect(by['email.events_total']).toBe(8);
    expect(by['email.phishing']).toBe(3);
    expect(by['email.malware']).toBe(1);
    expect(by['email.spam']).toBe(1);
    expect(by['email.graymail']).toBe(1);
    expect(by['email.dlp_events']).toBe(1);
  });

  it('computes threats blocked and malicious clicks', () => {
    expect(by['email.threats_blocked']).toBe(4); // 3 phishing + 1 malware
    expect(by['email.malicious_clicks']).toBe(1);
  });

  it('computes the top attacked user from threat recipients', () => {
    expect(by['email.top_attacked_user']).toBe('lisa@kypca.net (3)');
  });
});

describe('collectCheckpoint', () => {
  const period = makePeriod(2026, 2);
  const cfg = { baseUrl: 'https://cp.example', token: 'legacy-token' };
  const fake = (json: unknown) => {
    const requests: HttpRequest[] = [];
    const http: HttpTransport = {
      async request(req) {
        requests.push(req);
        return { status: 200, json };
      },
    };
    return { http, requests };
  };

  it('emits no metrics and a warning for an unrecognized payload', async () => {
    const { http } = fake({ unexpected: true });
    const out = await collectCheckpoint({ clientId: 'kypca', period }, http, cfg);
    expect(out.metrics).toHaveLength(0);
    expect(out.warnings.some((w) => /no email events/.test(w))).toBe(true);
  });

  it('emits no metrics and a warning for an empty event list', async () => {
    const { http } = fake({ responseData: [] });
    const out = await collectCheckpoint({ clientId: 'kypca', period }, http, cfg);
    expect(out.metrics).toHaveLength(0);
    expect(out.warnings.some((w) => /no email events/.test(w))).toBe(true);
  });

  it('still normalizes a recognized event list', async () => {
    const { http } = fake({ responseData: events });
    const out = await collectCheckpoint({ clientId: 'kypca', period }, http, cfg);
    expect(out.metrics.find((m) => m.key === 'email.events_total')?.value).toBe(8);
    expect(out.warnings).toEqual([]);
  });

  it('scopes the query to the mapped tenant', async () => {
    const { http, requests } = fake({ responseData: events });
    await collectCheckpoint({ clientId: 'kypca', period, externalRef: 'tenant-9' }, http, cfg);
    expect(requests[0]!.body).toContain('tenant-9');
  });

  it('does not scope by the internal client id when no tenant is mapped', async () => {
    const { http, requests } = fake({ responseData: events });
    await collectCheckpoint({ clientId: 'kypca', period, externalRef: 'kypca' }, http, cfg);
    expect(JSON.parse(requests[0]!.body!)).not.toHaveProperty('scopes');
  });
});
