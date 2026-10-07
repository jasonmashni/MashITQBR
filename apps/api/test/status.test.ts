import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { QbrRecord } from '../src/store/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// With ANTHROPIC_API_KEY set, the handlers' Claude factory returns this
// grounded stub, which also carries page-one decisions (workstream C adds the
// field to the narrative contract; lock 1 seeds them onto the agenda).
// `mode` lets a test make the model fail outright or cite a figure the data
// does not hold, the two builds Send must refuse to lock.
const narrativeStub = vi.hoisted(() => ({ calls: 0, mode: 'ok' as 'ok' | 'throw' | 'badFigure' }));
vi.mock('@mashit/narrative', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mashit/narrative')>();
  const { v4Narrative } = await import('./narrativeFixture.js');
  return {
    ...actual,
    createClaudeNarrativeModel: () => async () => {
      narrativeStub.calls++;
      if (narrativeStub.mode === 'throw') throw new Error('overloaded_error');
      return v4Narrative({
        ...(narrativeStub.mode === 'badFigure' ? { lede: 'We closed 98765 tickets this quarter.' } : {}),
        decisions: [{ ask: 'Approve the firewall refresh', why: 'The current units reach end of support.' }],
      });
    },
  };
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-status-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

const statusOf = async (period: string) => {
  const store = (await import('../src/store/index.js')).getDataStore();
  return (await store.getQbr('anp', period))?.status;
};

describe('approveNarrative', () => {
  it('advances a synced QBR to narrative_approved', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q1', { status: 'data_synced' });
    const res = await h.approveNarrative('anp', '2025-Q1');
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q1')).toBe('narrative_approved');
  });

  it('never regresses a QBR that is already completed', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putStatus('anp', '2025-Q2', { status: 'completed', force: true, reason: 'test setup' })).status).toBe(200);
    const res = await h.approveNarrative('anp', '2025-Q2');
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q2')).toBe('completed');
  });

  it('refuses to approve before the data is synced', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.approveNarrative('anp', '2023-Q2');
    expect(res.status).toBe(409);
    expect(await statusOf('2023-Q2')).toBeUndefined();
  });
});

describe('markPackageSent', () => {
  it('404s an unknown client', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.markPackageSent('nope', '2026-Q1')).status).toBe(404);
  });

  it('409s a period with no snapshot', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.markPackageSent('anp', '2019-Q1')).status).toBe(409);
  });

  it('409s an archived QBR', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('kpca', '2026-Q1', { status: 'archived' });
    const res = await h.markPackageSent('kpca', '2026-Q1');
    expect(res.status).toBe(409);
    const store = (await import('../src/store/index.js')).getDataStore();
    expect((await store.getQbr('kpca', '2026-Q1'))?.packageSentAt).toBeUndefined();
  });

  describe('refuses to lock a build Send should not mail', () => {
    afterEach(() => {
      narrativeStub.mode = 'ok';
      delete process.env['ANTHROPIC_API_KEY'];
    });
    const seedSnapshot = async (period: string) => {
      const { SEED_SNAPSHOTS } = await import('@mashit/core');
      const store = (await import('../src/store/index.js')).getDataStore();
      const seed = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
      await store.putSnapshot({ ...seed, period });
    };
    const nothingLocked = async (period: string) => {
      const store = (await import('../src/store/index.js')).getDataStore();
      expect((await store.getQbr('anp', period))?.locks?.preread).toBeUndefined();
      expect((await store.getQbr('anp', period))?.packageSentAt).toBeUndefined();
      expect(await store.listPackages('anp', period)).toHaveLength(0);
    };

    it('409s when an AI failure forced the offline draft, with the build warnings', async () => {
      const h = await import('../src/handlers.js');
      await seedSnapshot('2020-Q1');
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      narrativeStub.mode = 'throw';
      const res = await h.markPackageSent('anp', '2020-Q1');
      expect(res.status).toBe(409);
      const json = res.json as { error: string; warnings: string[] };
      expect(json.error).toMatch(/AI narrative failed.*Nothing was sent or locked/);
      expect(json.warnings.some((w) => /AI narrative failed/.test(w))).toBe(true);
      await nothingLocked('2020-Q1');
    });

    it('409s when the narrative fails figure verification', async () => {
      const h = await import('../src/handlers.js');
      await seedSnapshot('2020-Q2');
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      narrativeStub.mode = 'badFigure';
      const res = await h.markPackageSent('anp', '2020-Q2');
      expect(res.status).toBe(409);
      const json = res.json as { error: string; warnings: string[] };
      expect(json.error).toMatch(/figure that does not match the data/);
      expect(json.warnings.some((w) => /does not match the data/.test(w))).toBe(true);
      await nothingLocked('2020-Q2');
    });

    it('still locks an offline draft when AI is simply not configured', async () => {
      const h = await import('../src/handlers.js');
      await seedSnapshot('2020-Q3');
      const res = await h.markPackageSent('anp', '2020-Q3');
      expect(res.status).toBe(200);
      expect((res.json as QbrRecord).locks?.preread?.version).toBe(1);
    });
  });

  it('keeps the first packageSentAt on a repeat call', async () => {
    const h = await import('../src/handlers.js');
    const first = await h.markPackageSent('anp', '2026-Q1');
    expect(first.status).toBe(200);
    const stamped = (first.json as { packageSentAt?: string }).packageSentAt;
    expect(stamped).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    const again = await h.markPackageSent('anp', '2026-Q1');
    expect(again.status).toBe(200);
    expect((again.json as { packageSentAt?: string }).packageSentAt).toBe(stamped);
  });
});

describe('putStatus', () => {
  it('refuses a backwards move without force', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q3', { status: 'scheduled' });
    const res = await h.putStatus('anp', '2025-Q3', { status: 'draft' });
    expect(res.status).toBe(409);
    expect(await statusOf('2025-Q3')).toBe('scheduled');
  });

  it('requires a reason for a forced override', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putStatus('anp', '2025-Q3', { status: 'draft', force: true });
    expect(res.status).toBe(400);
    expect(await statusOf('2025-Q3')).toBe('scheduled');
  });

  it('applies a forced backwards move and audits the reason', async () => {
    const h = await import('../src/handlers.js');
    const { runWithActor } = await import('../src/requestContext.js');
    const res = await runWithActor('tech@mashit.net', () => h.putStatus('anp', '2025-Q3', { status: 'draft', force: true, reason: 'cleanup' }));
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q3')).toBe('draft');
    const events = ((await h.getAudit('50')).json as { events: Array<{ action: string; target: string; actor: string; detail?: string }> }).events;
    const entry = events.find((e) => e.target === 'qbr:anp/2025-Q3' && e.detail?.includes('override'));
    expect(entry?.detail).toContain('cleanup');
    expect(entry?.detail).toContain('override');
    expect(entry?.actor).toBe('tech@mashit.net');
  });

  it('a forced move below completed clears meeting.heldAt', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await h.putStatus('anp', '2023-Q1', { status: 'completed' });
    expect((await store.getQbr('anp', '2023-Q1'))?.meeting?.heldAt).toBeTruthy();
    expect((await h.putStatus('anp', '2023-Q1', { status: 'scheduled', force: true, reason: 'meeting did not happen' })).status).toBe(200);
    const rec = await store.getQbr('anp', '2023-Q1');
    expect(rec?.status).toBe('scheduled');
    expect(rec?.meeting?.heldAt).toBeUndefined();
  });

  it('advances on a forward move without force', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2025-Q4', { status: 'data_synced' });
    const res = await h.putStatus('anp', '2025-Q4', { status: 'scheduled' });
    expect(res.status).toBe(200);
    expect(await statusOf('2025-Q4')).toBe('scheduled');
  });

  it('treats the same status as a no-op success and rejects unknown statuses', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putStatus('anp', '2025-Q4', { status: 'scheduled' })).status).toBe(200);
    expect((await h.putStatus('anp', '2025-Q4', { status: 'bogus' })).status).toBe(400);
  });

  it('un-archiving is a backwards move and needs an override', async () => {
    const h = await import('../src/handlers.js');
    await h.putStatus('anp', '2024-Q4', { status: 'archived' });
    expect((await h.putStatus('anp', '2024-Q4', { status: 'completed' })).status).toBe(409);
    expect((await h.putStatus('anp', '2024-Q4', { status: 'completed', force: true, reason: 'reopened' })).status).toBe(200);
  });
});

describe('locked quarters refuse writes', () => {
  const setLocks = async (period: string, locks: QbrRecord['locks']) => {
    const store = (await import('../src/store/index.js')).getDataStore();
    const existing = await store.getQbr('anp', period);
    await store.upsertQbr({ status: 'scheduled', ...existing, clientId: 'anp', period, locks, updatedAt: new Date().toISOString() });
  };
  const lock = { at: '2026-06-01T00:00:00Z', by: 'jason', version: 1 };

  it('a preread lock refuses data writes with 409 but keeps the agenda open', async () => {
    const h = await import('../src/handlers.js');
    await setLocks('2024-Q1', { preread: lock });
    const sync = await h.syncQbr('anp', '2024-Q1');
    expect(sync.status).toBe(409);
    expect(sync.json).toEqual({ error: 'locked', stage: 'preread' });
    const edits = await h.putNarrativeEdits('anp', '2024-Q1', { headline: 'New' });
    expect(edits).toEqual({ status: 409, json: { error: 'locked', stage: 'preread' } });
    for (const res of [
      await h.regenerateNarrative('anp', '2024-Q1'),
      await h.putManualMetrics('anp', '2024-Q1', { metrics: [] }),
      await h.importDocumentMetrics('anp', '2024-Q1', { source: 'pdf:x', metrics: [] }),
      await h.removeImportedMetrics('anp', '2024-Q1', 'pdf:x'),
      await h.uploadQbrDocument('anp', '2024-Q1', { name: 'a.pdf', dataBase64: 'AAAA' }),
      await h.updateQbrDocument('anp', '2024-Q1', 'x', { name: 'b' }),
      await h.deleteQbrDocument('anp', '2024-Q1', 'x'),
    ]) {
      expect(res.status).toBe(409);
    }
    const disc = await h.putDiscussion('anp', '2024-Q1', { items: [], notes: 'Agenda still open' });
    expect(disc.status).toBe(200);
    const sched = await h.putSchedule('anp', '2024-Q1', { scheduledAt: '2024-03-10T15:00:00Z' });
    expect(sched.status).toBe(200);
  });

  it('a final lock also refuses discussion and schedule writes', async () => {
    const h = await import('../src/handlers.js');
    await setLocks('2024-Q1', { preread: lock, final: { ...lock, version: 2 } });
    expect(await h.putDiscussion('anp', '2024-Q1', { items: [], notes: 'Too late' })).toEqual({ status: 409, json: { error: 'locked', stage: 'final' } });
    expect((await h.putSchedule('anp', '2024-Q1', { scheduledAt: '2024-03-11T15:00:00Z' })).status).toBe(409);
    expect((await h.syncQbr('anp', '2024-Q1')).json).toEqual({ error: 'locked', stage: 'final' });
  });
});

describe('lock 1: package sent', () => {
  it('stores the pre-read package once, sets locks.preread and seeds decisions', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const store = getDataStore();
    await h.putStatus('mp', '2026-Q1', { status: 'narrative_approved' });
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      const res = await h.markPackageSent('mp', '2026-Q1');
      expect(res.status).toBe(200);
      const rec = res.json as QbrRecord;
      expect(rec.locks?.preread?.version).toBe(1);
      expect(rec.packageSentAt).toBeTruthy();

      const pkgs = await store.listPackages('mp', '2026-Q1');
      expect(pkgs.map((p) => [p.version, p.stage])).toEqual([[1, 'preread']]);
      expect((await getDocStore().get(pkgs[0]!.files.html))?.toString('utf8').startsWith('<!doctype html>')).toBe(true);

      const again = await h.markPackageSent('mp', '2026-Q1');
      expect(again.json).toEqual(rec);
      expect(await store.listPackages('mp', '2026-Q1')).toHaveLength(1);

      const items = (await store.getDiscussion('mp', '2026-Q1'))?.items ?? [];
      const seeded = items.filter((i) => i.source === 'report');
      // Seeded items mirror the page-one decisions frozen in the stored model
      // (the v4 narrative or, when the model output is rejected, the offline draft).
      const { loadPackageModel } = await import('../src/packages.js');
      const frozen = await loadPackageModel(getDocStore(), pkgs[0]!);
      const decisions = (frozen?.model as { decisions?: Array<{ ask: string; why?: string }> } | undefined)?.decisions ?? [];
      expect(decisions.length).toBeGreaterThan(0);
      expect(seeded.map((i) => i.topic)).toEqual(decisions.map((d) => d.ask));
      for (const [i, d] of decisions.entries()) {
        expect(seeded[i]).toMatchObject({ topic: d.ask, status: 'planned', includeInReport: true, sourceRef: 'page-one', ...(d.why ? { response: d.why } : {}) });
      }

      const events = ((await h.getAudit('50')).json as { events: Array<{ action: string; detail?: string }> }).events;
      expect(events.some((e) => e.action === 'qbr.lock' && e.detail === 'preread v1')).toBe(true);
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });
});

describe('lock 2: decisions captured or Finalize', () => {
  const seedSnapshot = async (period: string) => {
    const { SEED_SNAPSHOTS } = await import('@mashit/core');
    const store = (await import('../src/store/index.js')).getDataStore();
    const seed = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
    await store.putSnapshot({ ...seed, period });
  };

  it('putStatus to dispositioned on a pre-read quarter stores final v2 and sets locks.final', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await seedSnapshot('2023-Q3');
    expect((await h.markPackageSent('anp', '2023-Q3')).status).toBe(200);
    const res = await h.putStatus('anp', '2023-Q3', { status: 'dispositioned' });
    expect(res.status).toBe(200);
    const rec = await store.getQbr('anp', '2023-Q3');
    expect(rec?.locks?.preread?.version).toBe(1);
    expect(rec?.locks?.final?.version).toBe(2);
    expect((res.json as QbrRecord).locks?.final?.version).toBe(2);
    expect((await store.listPackages('anp', '2023-Q3')).map((p) => [p.version, p.stage])).toEqual([[1, 'preread'], [2, 'final']]);
  });

  it('finalizeQbr on a completed quarter with no locks stores final v1 and moves to dispositioned', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await seedSnapshot('2023-Q4');
    await h.putStatus('anp', '2023-Q4', { status: 'completed' });
    const res = await h.finalizeQbr('anp', '2023-Q4');
    expect(res.status).toBe(200);
    const rec = res.json as QbrRecord;
    expect(rec.locks?.final?.version).toBe(1);
    expect(rec.locks?.preread).toBeUndefined();
    expect(rec.status).toBe('dispositioned');
    expect((await store.listPackages('anp', '2023-Q4')).map((p) => [p.version, p.stage])).toEqual([[1, 'final']]);

    // A second Finalize is a no-op that returns the record.
    const again = await h.finalizeQbr('anp', '2023-Q4');
    expect(again.status).toBe(200);
    expect(again.json).toEqual(rec);
    expect(await store.listPackages('anp', '2023-Q4')).toHaveLength(1);
  });

  it('finalizeQbr with no snapshot answers 404', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.finalizeQbr('anp', '2019-Q2')).status).toBe(404);
  });
});

describe('reopen', () => {
  it('reopens final, versions the next package with revisedAt, then reopens everything', async () => {
    const h = await import('../src/handlers.js');
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { loadPackageModel } = await import('../src/packages.js');
    const store = getDataStore();
    // 2023-Q3 carries preread v1 and final v2 from the lock 2 tests.
    expect((await store.getQbr('anp', '2023-Q3'))?.locks?.final?.version).toBe(2);

    expect((await h.reopenQbr('anp', '2023-Q3', { stage: 'final' })).status).toBe(400);
    expect((await h.reopenQbr('anp', '2023-Q3', { stage: 'final', reason: '   ' })).status).toBe(400);
    expect((await h.reopenQbr('anp', '2023-Q3', { stage: 'nope', reason: 'x' })).status).toBe(400);

    const res = await h.reopenQbr('anp', '2023-Q3', { stage: 'final', reason: 'Client sent revised decisions' });
    expect(res.status).toBe(200);
    const rec = res.json as QbrRecord;
    expect(rec.locks?.final).toBeUndefined();
    expect(rec.locks?.preread?.version).toBe(1);
    expect(rec.reopened).toHaveLength(1);
    expect(rec.reopened?.[0]).toMatchObject({ stage: 'final', reason: 'Client sent revised decisions' });
    expect((await h.reopenQbr('anp', '2023-Q3', { stage: 'final', reason: 'again' })).status).toBe(409);

    const events = ((await h.getAudit('50')).json as { events: Array<{ action: string; detail?: string }> }).events;
    expect(events.some((e) => e.action === 'qbr.reopen' && e.detail === 'final: Client sent revised decisions')).toBe(true);

    const fin = await h.finalizeQbr('anp', '2023-Q3');
    expect((fin.json as QbrRecord).locks?.final?.version).toBe(3);
    const pkgs = await store.listPackages('anp', '2023-Q3');
    expect(pkgs.map((p) => p.version)).toEqual([1, 2, 3]);
    const stored = await loadPackageModel(getDocStore(), pkgs[2]!);
    expect(stored?.model.revisedAt).toBe(rec.reopened?.[0]?.at);
    expect((await loadPackageModel(getDocStore(), pkgs[1]!))?.model.revisedAt).toBeUndefined();

    const all = await h.reopenQbr('anp', '2023-Q3', { stage: 'preread', reason: 'Data was wrong' });
    expect(all.status).toBe(200);
    expect((all.json as QbrRecord).locks).toEqual({});
    expect((all.json as QbrRecord).reopened).toHaveLength(2);
    expect(await store.listPackages('anp', '2023-Q3')).toHaveLength(3);
  });
});

describe('locked reads serve the version the lock names', () => {
  const seedSnapshot = async (period: string) => {
    const { SEED_SNAPSHOTS } = await import('@mashit/core');
    const store = (await import('../src/store/index.js')).getDataStore();
    const seed = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
    await store.putSnapshot({ ...seed, period });
  };
  /** Mark each stored PDF with its version so the served bytes are unambiguous. */
  const markPdfs = async (period: string) => {
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    for (const p of await getDataStore().listPackages('anp', period)) {
      await getDocStore().put(p.files.pdf, Buffer.from(`%PDF-v${p.version}`), 'application/pdf');
    }
  };
  const emlText = (r: { file?: { bytes: Buffer } }) => r.file!.bytes.toString('utf8').replace(/\r\n/g, '');

  it('after reopening everything and sending again, reads and the email serve the new pre-read package', async () => {
    const h = await import('../src/handlers.js');
    await seedSnapshot('2022-Q1');
    expect((await h.markPackageSent('anp', '2022-Q1')).status).toBe(200);
    expect((await h.finalizeQbr('anp', '2022-Q1')).status).toBe(200);
    expect((await h.reopenQbr('anp', '2022-Q1', { stage: 'preread', reason: 'Wrong data' })).status).toBe(200);
    const resent = await h.markPackageSent('anp', '2022-Q1');
    expect((resent.json as QbrRecord).locks?.preread?.version).toBe(3);
    await markPdfs('2022-Q1');

    const qbr = (await h.getQbr('anp', '2022-Q1', null)).json as { package: { version: number; stage: string } };
    expect(qbr.package).toMatchObject({ version: 3, stage: 'preread' });
    expect((await h.getReportPdf('anp', '2022-Q1', null)).pdf?.toString()).toBe('%PDF-v3');

    // A report filed after the lock does not ride along: only the stored PDF goes out.
    await h.storeDocument({ clientId: 'anp', period: '2022-Q1', name: 'late-vendor-report.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-late'), source: 'email' });
    const eml = emlText(await h.getEmailDraft('anp', '2022-Q1', null));
    expect(eml).toContain(Buffer.from('%PDF-v3').toString('base64'));
    expect(eml).not.toContain(Buffer.from('%PDF-v2').toString('base64'));
    expect(eml).not.toContain('late-vendor-report.pdf');
  });

  it('after reopening final only, reads serve the pre-read version named on locks.preread', async () => {
    const h = await import('../src/handlers.js');
    await seedSnapshot('2022-Q2');
    await h.markPackageSent('anp', '2022-Q2');
    await h.finalizeQbr('anp', '2022-Q2');
    expect((await h.reopenQbr('anp', '2022-Q2', { stage: 'final', reason: 'More decisions' })).status).toBe(200);
    await markPdfs('2022-Q2');
    const qbr = (await h.getQbr('anp', '2022-Q2', null)).json as { package: { version: number; stage: string } };
    expect(qbr.package).toMatchObject({ version: 1, stage: 'preread' });
    expect((await h.getReportPdf('anp', '2022-Q2', null)).pdf?.toString()).toBe('%PDF-v1');
  });
});

describe('status moves around lock 2', () => {
  const seedSnapshot = async (period: string) => {
    const { SEED_SNAPSHOTS } = await import('@mashit/core');
    const store = (await import('../src/store/index.js')).getDataStore();
    const seed = SEED_SNAPSHOTS.find((s) => s.clientId === 'anp' && s.metrics.length > 1)!;
    await store.putSnapshot({ ...seed, period });
  };

  it('refuses a forced move below dispositioned on a final quarter', async () => {
    const h = await import('../src/handlers.js');
    await seedSnapshot('2022-Q3');
    expect((await h.finalizeQbr('anp', '2022-Q3')).status).toBe(200);
    const res = await h.putStatus('anp', '2022-Q3', { status: 'scheduled', force: true, reason: 'oops' });
    expect(res).toEqual({ status: 409, json: { error: 'This quarter is finalized. Reopen it first.' } });
    expect(await statusOf('2022-Q3')).toBe('dispositioned');
    // Forward moves on a final quarter still work.
    expect((await h.putStatus('anp', '2022-Q3', { status: 'actions_pushed' })).status).toBe(200);
  });

  it('archiving does not perform lock 2', async () => {
    const h = await import('../src/handlers.js');
    const store = (await import('../src/store/index.js')).getDataStore();
    await seedSnapshot('2022-Q4');
    const res = await h.putStatus('anp', '2022-Q4', { status: 'archived' });
    expect(res.status).toBe(200);
    expect((res.json as QbrRecord).locks?.final).toBeUndefined();
    expect(await store.listPackages('anp', '2022-Q4')).toHaveLength(0);
  });
});

describe('a failed lock 2 says so', () => {
  it('putStatus to dispositioned with nothing to freeze returns the record with a retry warning', async () => {
    const h = await import('../src/handlers.js');
    const res = await h.putStatus('anp', '2019-Q3', { status: 'dispositioned' });
    expect(res.status).toBe(200);
    const json = res.json as QbrRecord & { warning?: string };
    expect(json.status).toBe('dispositioned');
    expect(json.locks?.final).toBeUndefined();
    expect(json.warning).toMatch(/^The final package could not be stored: .+\. Press Finalize to retry\.$/);
  });
});
