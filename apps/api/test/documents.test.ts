import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRequest, HttpResponse } from '@mashit/integrations';
import { JsonDataStore, LocalDocStore, LocalSecretStore, docPath } from '../src/store/index.js';
import { saveConnection } from '../src/connections.js';
import { syncClientMetrics } from '../src/integrationsService.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-docs-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('document metadata store', () => {
  it('round-trips records per client/period and replaces by id', async () => {
    const store = new JsonDataStore(dir);
    const rec = {
      id: 'd1',
      clientId: 'anp',
      period: '2026-Q1',
      name: 'Huntress quarterly.pdf',
      source: 'huntress',
      contentType: 'application/pdf',
      size: 1234,
      uploadedAt: '2026-07-01T00:00:00.000Z',
      uploadedBy: 'system',
    };
    await store.putDocument(rec);
    await store.putDocument({ ...rec, size: 999 }); // same id replaces
    const docs = await store.listDocuments('anp', '2026-Q1');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.size).toBe(999);
    expect(await store.getDocument('anp', '2026-Q1', 'd1')).toBeDefined();
    expect(await store.listDocuments('anp', '2026-Q2')).toHaveLength(0);

    await store.deleteDocument('anp', '2026-Q1', 'd1');
    expect(await store.listDocuments('anp', '2026-Q1')).toHaveLength(0);
  });
});

describe('document content store (local)', () => {
  it('stores, reads and deletes bytes; sanitizes the path', async () => {
    const docs = new LocalDocStore(join(dir, 'documents'));
    const path = docPath('anp', '2026-Q1', 'd1', 'Q1 report (final).pdf');
    expect(path).toBe('anp/2026-Q1/d1-Q1 report (final).pdf');
    // Traversal characters are stripped from the name segment.
    expect(docPath('anp', '2026-Q1', 'd2', '../../etc/passwd')).not.toContain('..');

    await docs.put(path, Buffer.from('pdf-bytes'), 'application/pdf');
    expect((await docs.get(path))?.toString()).toBe('pdf-bytes');
    await docs.delete(path);
    expect(await docs.get(path)).toBeUndefined();
  });
});

describe('sync surfaces vendor documents', () => {
  it('returns the Huntress summary PDF url from the sync', async () => {
    const store = new JsonDataStore(dir);
    const secrets = new LocalSecretStore(dir);
    await store.upsertClient({ id: 'c9', name: 'Acme', integrationRefs: { huntress: 'org1' } });
    await saveConnection(store, secrets, {
      type: 'huntress',
      label: 'Huntress',
      config: { baseUrl: 'https://api.huntress.io/v1' },
      secrets: { apiKey: 'k', apiSecret: 's' },
    });
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('/reports?')) {
          return {
            status: 200,
            json: { reports: [{ type: 'quarterly_summary', agents_count: 26, url: 'https://huntress.example/report.pdf' }], pagination: {} },
          };
        }
        if (req.url.includes('/organizations/')) return { status: 200, json: { organization: { actual_usages: {} } } };
        return { status: 200, json: { identities: [], pagination: {} } };
      },
    };
    const { documents } = await syncClientMetrics({ store, secrets, http }, 'c9', '2026-Q1', '2026-03-31T00:00:00.000Z');
    expect(documents).toEqual([
      {
        source: 'huntress',
        name: 'Huntress quarterly_summary 2026-Q1.pdf',
        url: 'https://huntress.example/report.pdf',
        key: 'summary:2026-Q1',
      },
    ]);
  });
});

describe('sync re-attach after a portal rename (the duplicate-report bug)', () => {
  it('updates the renamed document in place instead of adding a copy', async () => {
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
    const h = await import('../src/handlers.js');

    const first = await h.storeDocument({
      clientId: 'anp',
      period: '2026-Q2',
      name: 'Huntress quarterly_summary 2026-Q2.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('v1'),
      source: 'huntress',
      sourceKey: 'summary:2026-Q2',
    });

    // The user renames + categorizes it (AI match does exactly this).
    await h.updateQbrDocument('anp', '2026-Q2', first.id, {
      name: 'Huntress Threat Report 2026-Q2.pdf',
      category: 'Security',
    });

    // Next sync re-attaches under the original generated name.
    const again = await h.storeDocument({
      clientId: 'anp',
      period: '2026-Q2',
      name: 'Huntress quarterly_summary 2026-Q2.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('v2-bigger'),
      source: 'huntress',
      sourceKey: 'summary:2026-Q2',
    });

    expect(again.id).toBe(first.id); // matched by sourceKey, not name
    expect(again.name).toBe('Huntress Threat Report 2026-Q2.pdf'); // rename survives
    expect(again.category).toBe('Security'); // curation survives
    expect(again.size).toBe(Buffer.from('v2-bigger').length); // bytes refreshed

    const listed = (await import('../src/store/index.js')).getDataStore();
    expect((await listed.listDocuments('anp', '2026-Q2')).filter((d) => d.source === 'huntress')).toHaveLength(1);
  });
});

describe('imported-metric cleanup (undo a bad PDF import)', () => {
  it('removes exactly the pdf:* source rows and refuses other sources', async () => {
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();

    await store.putSnapshot({
      clientId: 'anp',
      period: '2025-Q3',
      capturedAt: '2025-09-30T00:00:00.000Z',
      metrics: [
        { key: 'tickets.opened', label: 'Tickets opened', value: 40, source: 'halo', category: 'operations' },
        { key: 'tickets.opened', label: 'Tickets opened', value: 3, source: 'pdf:mash-it', category: 'operations' },
        { key: 'doc.backup_jobs', label: 'Backup jobs', value: 12, source: 'pdf:mash-it', category: 'backup' },
      ],
    });

    expect((await h.removeImportedMetrics('anp', '2025-Q3', 'halo')).status).toBe(400); // synced rows are protected
    const res = await h.removeImportedMetrics('anp', '2025-Q3', 'pdf:mash-it');
    expect(res.status).toBe(200);
    expect((res.json as { removed: number }).removed).toBe(2);
    const snap = await store.getSnapshot('anp', '2025-Q3');
    expect(snap!.metrics).toHaveLength(1);
    expect(snap!.metrics[0]!.source).toBe('halo');
  });
});
