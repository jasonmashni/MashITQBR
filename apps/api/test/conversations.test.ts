import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpTransport } from '@mashit/integrations';
import { JsonDataStore } from '../src/store/index.js';
import type { SecretStore } from '../src/store/secretStore.js';
import { suggestedConversations } from '../src/conversations.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-conv-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secrets: SecretStore = {
  async set() {},
  async get(name) {
    return name === 'halo--clientSecret' ? 'shh' : undefined;
  },
  async delete() {},
};

function fakeHalo() {
  const requests: HttpRequest[] = [];
  const http: HttpTransport = {
    async request(req) {
      requests.push(req);
      if (req.url.includes('/auth/token')) return { status: 200, json: { access_token: 't', expires_in: 3600 } };
      if (req.url.includes('/api/Tickets')) {
        return {
          status: 200,
          json: {
            record_count: 2,
            tickets: [
              { id: 11, summary: 'New hire starting Nov 3', tickettype_name: 'Service Request', user_email: 'anne@client.com', dateoccurred: '2026-08-04T10:00:00' },
              { id: 12, summary: 'Email down', tickettype_name: 'Incident', user_email: 'anne@client.com', dateoccurred: '2026-08-05T10:00:00' },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    },
  };
  return { http, requests };
}

async function setup(sub: string, client: Record<string, unknown>) {
  const store = new JsonDataStore(join(dir, sub));
  await store.upsertClient({ id: 'halo-62', name: 'Madison Pediatric Associates', integrationRefs: { halo: '62' }, primaryContact: { name: 'Anne', email: 'anne@client.com' }, ...client });
  const now = new Date().toISOString();
  await store.upsertConnection({
    id: 'halo',
    type: 'halo',
    label: 'Halo',
    config: { baseUrl: 'https://conv-api.halopsa.com', clientId: 'conv-api' },
    secretRefs: { clientSecret: 'halo--clientSecret' },
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

describe('suggestedConversations', () => {
  it('returns Halo requests for the period and the degradation warning', async () => {
    const store = await setup('a', {});
    const { http, requests } = fakeHalo();
    const res = await suggestedConversations('halo-62', '2026-Q3', { store, secrets, http });
    expect(res.status).toBe(200);
    const body = res.json as { items: Array<Record<string, unknown>>; warnings: string[] };
    expect(body.items).toEqual([{ topic: 'New hire starting Nov 3', detail: 'Service Request', source: 'halo_ticket', ref: 'ticket:11', when: '2026-08-04' }]);
    expect(body.warnings).toEqual(['Halo opportunities/CRM notes not available on this instance']);
    const t = requests.find((r) => r.url.includes('/api/Tickets'))!;
    expect(t.url).toContain('startdate=2026-07-01');
    expect(t.url).toContain('enddate=2026-09-30');
  });

  it('still returns the items for a HIPAA client (internal view)', async () => {
    const store = await setup('b', { hipaa: true });
    const { http } = fakeHalo();
    const res = await suggestedConversations('halo-62', '2026-Q3', { store, secrets, http });
    expect(res.status).toBe(200);
    expect((res.json as { items: unknown[] }).items).toHaveLength(1);
  });

  it('answers an empty list with a reason when the client has no Halo link', async () => {
    const store = await setup('c', { integrationRefs: {} });
    const { http, requests } = fakeHalo();
    const res = await suggestedConversations('halo-62', '2026-Q3', { store, secrets, http });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [], warnings: ['This client is not linked to a Halo client.'] });
    expect(requests).toHaveLength(0);
  });

  it('rejects an unknown client and a malformed period', async () => {
    const store = await setup('d', {});
    const { http } = fakeHalo();
    expect((await suggestedConversations('nope', '2026-Q3', { store, secrets, http })).status).toBe(404);
    expect((await suggestedConversations('halo-62', 'Q3', { store, secrets, http })).status).toBe(400);
  });
});
