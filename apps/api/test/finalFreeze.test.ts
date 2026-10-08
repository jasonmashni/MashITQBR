import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QbrRecord } from '../src/store/index.js';
import { v4Narrative } from './narrativeFixture.js';

// Every model call is counted and drafts a different headline, so a lock 2
// that called the model would show it in the stored package.
const stub = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@mashit/narrative', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mashit/narrative')>();
  const { v4Narrative: fixture } = await import('./narrativeFixture.js');
  return {
    ...actual,
    createClaudeNarrativeModel: () => async () => {
      stub.calls++;
      return fixture({
        headline: stub.calls === 1 ? 'A steady quarter' : 'A different quarter',
        decisions: [{ ask: stub.calls === 1 ? 'Approve the firewall refresh' : 'Approve something else', why: 'The units reach end of support.' }],
      });
    },
  };
});
void v4Narrative;

// Attachment loading can be made to fail, the way a storage outage would.
const pdfStub = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/pdfMerge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pdfMerge.js')>();
  return {
    ...actual,
    loadPdfAttachments: (...args: Parameters<typeof actual.loadPdfAttachments>) =>
      pdfStub.fail ? Promise.reject(new Error('Blob storage unavailable')) : actual.loadPdfAttachments(...args),
  };
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-final-freeze-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
  delete process.env['ANTHROPIC_API_KEY'];
});

const seedSnapshot = async (period: string) => {
  const { SEED_SNAPSHOTS } = await import('@mashit/core');
  const store = (await import('../src/store/index.js')).getDataStore();
  const seed = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
  await store.putSnapshot({ ...seed, period });
};

describe('lock 2 reuses the lock 1 narrative and documents', () => {
  it('Finalize after live edits keeps executive, decisions and documents from v1 with no model call', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { loadPackageModel } = await import('../src/packages.js');
    const store = getDataStore();
    await seedSnapshot('2021-Q1');
    await h.storeDocument({ clientId: 'anp', period: '2021-Q1', name: 'backup-report.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-a'), source: 'upload' });
    process.env['ANTHROPIC_API_KEY'] = 'test-key';

    const sent = await h.markPackageSent('anp', '2021-Q1');
    expect(sent.status).toBe(200);
    expect(stub.calls).toBe(1);

    // Live inputs change after the pre-read went out.
    expect((await h.putClientGoals('anp', { goals: [{ title: 'Open a second clinic' }] })).status).toBe(200);
    await h.storeDocument({ clientId: 'anp', period: '2021-Q1', name: 'late-report.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-b'), source: 'email' });
    expect((await h.putConfig('anp', { narrativeFocus: 'Talk only about the budget' })).status).toBe(200);

    const fin = await h.finalizeQbr('anp', '2021-Q1');
    expect(fin.status).toBe(200);
    expect((fin.json as QbrRecord).locks?.final?.version).toBe(2);
    expect(stub.calls).toBe(1);

    const [v1, v2] = await store.listPackages('anp', '2021-Q1');
    const m1 = (await loadPackageModel(getDocStore(), v1!))!.model;
    const m2 = (await loadPackageModel(getDocStore(), v2!))!.model;
    expect(m1.executive.headline).toBe('A steady quarter');
    expect(m2.executive).toEqual(m1.executive);
    expect(m2.decisions).toEqual(m1.decisions);
    expect(m2.documents).toEqual(m1.documents);
    expect(m2.documents.map((d) => d.name)).toEqual(['backup-report.pdf']);
  });
});

describe('lock 2 reuses the lock 1 report inputs', () => {
  const plan = (expected: number) => ({
    clientId: 'anp',
    fiscalLabel: 2023,
    status: 'published' as const,
    answers: {},
    assumptions: [],
    movers: [],
    caveats: [],
    lines: [],
    totals: { low: expected, expected, high: expected },
    createdAt: 'x',
    updatedAt: 'x',
    updatedBy: 'jason',
    publishedPeriod: '2022-Q3',
    published: {
      at: 'x',
      period: '2022-Q3',
      lines: [{ category: 'managed_services' as const, low: expected, expected, high: expected, basis: [{ source: 'halo' as const, note: 'MRR' }] }],
      totals: { low: expected, expected, high: expected },
      assumptions: ['Two hires.'],
      movers: [],
      caveats: [],
    },
  });

  it('Finalize after config, brand, goals and budget changes keeps the v1 pages', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { loadPackageModel } = await import('../src/packages.js');
    const store = getDataStore();
    delete process.env['ANTHROPIC_API_KEY'];
    await seedSnapshot('2022-Q3');
    await store.putBudgetPlan(plan(50000));
    expect((await h.putClientGoals('anp', { goals: [{ title: 'Grow the plant' }] })).status).toBe(200);
    expect((await h.putConfig('anp', { brand: { name: 'Before Brand' }, hiddenSections: [] })).status).toBe(200);

    expect((await h.markPackageSent('anp', '2022-Q3')).status).toBe(200);
    const [v1] = await store.listPackages('anp', '2022-Q3');
    const j1 = (await loadPackageModel(getDocStore(), v1!))!;
    const m1 = j1.model;
    const cited = m1.sections[0]!.rows[0]!.metric.key;
    expect(m1.goals.map((g) => g.title)).toEqual(['Grow the plant']);
    expect(m1.investment?.outlook?.totals.expected).toBe(50000);

    // Live inputs change after the pre-read went out.
    expect((await h.putClientGoals('anp', { goals: [{ title: 'Sell the plant' }] })).status).toBe(200);
    const hide = m1.sections.at(-1)!.category;
    expect(
      (await h.putConfig('anp', { brand: { name: 'After Brand' }, hiddenSections: [hide], excludedMetrics: [cited] })).status,
    ).toBe(200);
    await store.putBudgetPlan(plan(99000));

    const fin = await h.finalizeQbr('anp', '2022-Q3');
    expect(fin.status).toBe(200);
    const [, v2] = await store.listPackages('anp', '2022-Q3');
    const j2 = (await loadPackageModel(getDocStore(), v2!))!;
    const m2 = j2.model;
    expect(m2.goals).toEqual(m1.goals);
    expect(m2.sections).toEqual(m1.sections);
    expect(m2.sections.flatMap((s) => s.rows.map((r) => r.metric.key))).toContain(cited);
    expect(m2.brand).toEqual(m1.brand);
    expect(m2.customSections).toEqual(m1.customSections);
    expect(m2.investment).toEqual(m1.investment);
    expect(m2.investment?.outlook?.totals.expected).toBe(50000);
    expect(j2.verification).toBe(j1.verification);
    expect(j2.narrative?.verification).toEqual(j1.narrative?.verification);
    expect(j2.warnings).not.toContain('Pre-read inputs were not stored; final package used current settings.');
  });

  it('a pre-read package without stored inputs falls back to live inputs with a warning', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { loadPackageModel } = await import('../src/packages.js');
    const store = getDataStore();
    delete process.env['ANTHROPIC_API_KEY'];
    await seedSnapshot('2022-Q2');
    expect((await h.markPackageSent('anp', '2022-Q2')).status).toBe(200);
    // Rewrite the stored JSON the way a package from before this change looked.
    const [v1] = await store.listPackages('anp', '2022-Q2');
    const j1 = (await loadPackageModel(getDocStore(), v1!))!;
    const { inputs: _inputs, ...legacy } = j1 as typeof j1 & { inputs?: unknown };
    expect(_inputs).toBeDefined();
    await getDocStore().put(v1!.files.model, Buffer.from(JSON.stringify(legacy), 'utf8'), 'application/json');
    expect((await h.putConfig('anp', { brand: { name: 'Live Brand' } })).status).toBe(200);

    expect((await h.finalizeQbr('anp', '2022-Q2')).status).toBe(200);
    const [, v2] = await store.listPackages('anp', '2022-Q2');
    const j2 = (await loadPackageModel(getDocStore(), v2!))!;
    expect(j2.model.brand.name).toBe('Live Brand');
    expect(j2.warnings).toContain('Pre-read inputs were not stored; final package used current settings.');
  });
});

describe('an attachment failure at lock time is reported', () => {
  it('Send stores the package, and the package and the response carry the warning', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { loadPackageModel } = await import('../src/packages.js');
    delete process.env['ANTHROPIC_API_KEY'];
    await seedSnapshot('2021-Q4');
    pdfStub.fail = true;
    try {
      const res = await h.markPackageSent('anp', '2021-Q4');
      expect(res.status).toBe(200);
      const warning = 'Attached reports could not be appended: Blob storage unavailable.';
      expect((res.json as { warning?: string }).warning).toBe(warning);
      const [pkg] = await getDataStore().listPackages('anp', '2021-Q4');
      expect(pkg?.warnings).toContain(warning);
      expect((await loadPackageModel(getDocStore(), pkg!))?.warnings).toContain(warning);
    } finally {
      pdfStub.fail = false;
    }
  });
});

describe('document writes refuse under a data lock', () => {
  const lock = { at: '2026-06-01T00:00:00Z', by: 'jason', version: 1 };
  const setLocks = async (period: string, locks: QbrRecord['locks']) => {
    const store = (await import('../src/store/index.js')).getDataStore();
    const existing = await store.getQbr('anp', period);
    await store.upsertQbr({ status: 'scheduled', ...existing, clientId: 'anp', period, locks, updatedAt: new Date().toISOString() });
  };

  it('extract refuses on a locked quarter', async () => {
    const h = await import('../src/handlers.js');
    await setLocks('2021-Q2', { preread: lock });
    const res = await h.extractQbrDocument('anp', '2021-Q2', 'x', async () => ({ vendor: 'x', metrics: [], findings: [] }) as never);
    expect(res).toEqual({ status: 409, json: { error: 'locked', stage: 'preread' } });
  });

  it('moving a document into a locked quarter is refused', async () => {
    const h = await import('../src/handlers.js');
    await setLocks('2021-Q3', { preread: lock });
    const doc = await h.storeDocument({ clientId: 'anp', period: '2021-Q4', name: 'a.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-'), source: 'upload' });
    const res = await h.updateQbrDocument('anp', '2021-Q4', doc.id, { period: '2021-Q3' });
    expect(res).toEqual({ status: 409, json: { error: 'locked', stage: 'preread' } });
    const store = (await import('../src/store/index.js')).getDataStore();
    expect((await store.listDocuments('anp', '2021-Q3')).map((d) => d.id)).not.toContain(doc.id);
  });
});
