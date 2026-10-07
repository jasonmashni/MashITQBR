import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDataSource } from '../src/dataSource.js';
import { _resetAiFailureCooldown, buildQbrReport, renderQbrHtml } from '../src/service.js';

// Locked-quarter reads must never reach the narrative model: the handlers'
// Claude factory is swapped for a spy so any call is visible.
const narrativeSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@mashit/narrative', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mashit/narrative')>();
  return {
    ...actual,
    createClaudeNarrativeModel: () => async () => {
      narrativeSpy.calls++;
      throw new Error('narrative model must not be called for a locked quarter');
    },
  };
});

describe('buildQbrReport (offline narrative, seed data)', () => {
  it('builds a verified report for ANP Q1 2026 with QoQ trends', async () => {
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      heldBy: 'Jason Mashni',
      generatedLabel: 'Apr 6, 2026',
    });
    expect(report.narrative.verification.ok).toBe(true);
    expect(report.warnings).toHaveLength(0); // previous quarter exists -> no trend warning
    expect(report.model.client.name).toBe('ANP Enertech');
    expect(report.model.scorecard.functions).toHaveLength(6);

    const html = renderQbrHtml(report);
    expect(html).toContain('ANP Enertech');
    expect(html).toContain('Q1 2026');
    expect(html).toContain('Mash IT');
  });

  it('warns when no prior-quarter snapshot exists', async () => {
    const report = await buildQbrReport(seedDataSource, 'kpca', '2026-Q1');
    expect(report.warnings.some((w) => /quarter-over-quarter/.test(w))).toBe(true);
  });

  it('uses an injected narrative model when provided', async () => {
    let called = false;
    const report = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', {
      narrativeModel: async () => {
        called = true;
        return {
          headline: 'Custom headline',
          summary_paragraphs: ['Patch compliance held at 89%.'],
          highlights: [],
          recommendations: [],
          figures_referenced: [{ label: 'patch', value: '89%' }],
        };
      },
    });
    expect(called).toBe(true);
    expect(report.model.executive.headline).toBe('Custom headline');
    expect(report.narrative.verification.ok).toBe(true); // 89 is a real MP metric
  });

  it('throws for an unknown client', async () => {
    await expect(buildQbrReport(seedDataSource, 'nope', '2026-Q1')).rejects.toThrow(/Unknown client/);
  });

  it('falls back to the offline draft when the AI model fails, then cools down', async () => {
    _resetAiFailureCooldown();
    let calls = 0;
    const throwing = async () => {
      calls++;
      throw new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit"}}');
    };
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', { narrativeModel: throwing });
    // The build still succeeds, prose exists, and the author is told why.
    expect(report.model.executive.paragraphs.length).toBeGreaterThan(0);
    expect(report.warnings.some((w) => /rate-limited/.test(w))).toBe(true);
    expect(calls).toBe(1);

    // A repeat view within the cooldown must NOT re-bill the API.
    const again = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', { narrativeModel: throwing });
    expect(calls).toBe(1);
    expect(again.warnings.some((w) => /cooling down/.test(w))).toBe(true);
    _resetAiFailureCooldown();
  });

  it('explains an empty credit balance in plain words', async () => {
    _resetAiFailureCooldown();
    const report = await buildQbrReport(seedDataSource, 'kpca', '2026-Q1', {
      narrativeModel: async () => {
        throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
      },
    });
    expect(report.warnings.some((w) => /out of API credits/.test(w))).toBe(true);
    _resetAiFailureCooldown();
  });

  it('caches verified AI narratives and skips the model on a repeat build', async () => {
    let calls = 0;
    const model = async () => {
      calls++;
      return {
        headline: 'Cached headline',
        summary_paragraphs: ['Patch compliance held at 89%.'],
        highlights: [],
        recommendations: [],
        figures_referenced: [{ label: 'patch', value: '89%' }],
      };
    };
    const backing = new Map<string, never>();
    const cache = {
      get: async (hash: string) => backing.get(hash),
      put: async (hash: string, result: never) => void backing.set(hash, result),
    };

    const first = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', { narrativeModel: model, narrativeCache: cache });
    expect(calls).toBe(1);
    expect(first.narrative.verification.ok).toBe(true);
    expect(backing.size).toBe(1);

    const second = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', { narrativeModel: model, narrativeCache: cache });
    expect(calls).toBe(1); // served from cache
    expect(second.model.executive.headline).toBe('Cached headline');
  });

  it('caches unverified narratives too — repeat views must not re-bill', async () => {
    let calls = 0;
    const backing = new Map<string, never>();
    const cache = {
      get: async (hash: string) => backing.get(hash),
      put: async (hash: string, result: never) => void backing.set(hash, result),
    };
    const model = async () => {
      calls++;
      return {
        headline: 'Made up',
        summary_paragraphs: [],
        highlights: [],
        recommendations: [],
        figures_referenced: [{ label: 'phantom', value: '123456' }],
      };
    };
    const first = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', { narrativeModel: model, narrativeCache: cache });
    expect(first.narrative.verification.ok).toBe(false);
    expect(backing.size).toBe(1); // pinned despite failing verification
    // generateNarrative retries the correction once → 2 calls for the draft…
    const draftCalls = calls;
    const second = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', { narrativeModel: model, narrativeCache: cache });
    expect(calls).toBe(draftCalls); // …and the repeat view costs nothing
    expect(second.warnings.some((w) => /^The narrative cites a figure that does not match the data: /.test(w))).toBe(true);
  });

  it('never consults the cache for the offline drafter', async () => {
    let gets = 0;
    await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      narrativeCache: {
        get: async () => {
          gets++;
          return undefined;
        },
        put: async () => undefined,
      },
    });
    expect(gets).toBe(0);
  });

  it('survives a broken cache (falls back to the model)', async () => {
    const report = await buildQbrReport(seedDataSource, 'mp', '2026-Q1', {
      narrativeModel: async () => ({
        headline: 'Resilient',
        summary_paragraphs: [],
        highlights: [],
        recommendations: [],
        figures_referenced: [],
      }),
      narrativeCache: {
        get: async () => {
          throw new Error('table offline');
        },
        put: async () => {
          throw new Error('table offline');
        },
      },
    });
    expect(report.model.executive.headline).toBe('Resilient');
  });

  it('narrative edits win over generated text (and blank fields keep it)', async () => {
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      narrativeEdits: {
        headline: 'Hand-written headline',
        recommendations: ['Do the thing', 'Then the other thing'],
        // summary_paragraphs / highlights left undefined → generated text kept
      },
    });
    expect(report.model.executive.headline).toBe('Hand-written headline');
    expect(report.model.recommendations).toEqual(['Do the thing', 'Then the other thing']);
    expect(report.model.executive.paragraphs.length).toBeGreaterThan(0); // offline draft retained
  });

  it('excludedMetrics vanish from sections, trends, and the AI input', async () => {
    const base = await buildQbrReport(seedDataSource, 'anp', '2026-Q1');
    const someKey = base.model.sections[0]!.rows[0]!.metric.key;

    let modelSawExcluded = false;
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      config: { clientId: 'anp', excludedMetrics: [someKey] },
      narrativeModel: async (messages) => {
        modelSawExcluded = messages.some((m) => m.content.includes(someKey));
        return { headline: 'X', summary_paragraphs: [], highlights: [], recommendations: [], figures_referenced: [] };
      },
    });
    const keys = report.model.sections.flatMap((s) => s.rows.map((r) => r.metric.key));
    expect(keys).not.toContain(someKey);
    expect(report.model.trends.map((t) => t.key)).not.toContain(someKey);
    expect(modelSawExcluded).toBe(false);
  });

  it('threads per-client config + discussion into the report', async () => {
    const report = await buildQbrReport(seedDataSource, 'anp', '2026-Q1', {
      config: {
        clientId: 'anp',
        hiddenSections: ['spend'],
        brand: { name: 'Acme MSP', primary: '#123456' },
        customSections: [{ id: 's1', title: 'Roadmap', body: 'Next steps.' }],
      },
      discussion: [{ id: 'd1', topic: 'OpenVPN removal?', response: 'Approved', disposition: 'create_ticket', owner: 'Jason' }],
      notes: 'Good meeting.',
    });
    expect(report.model.brand.name).toBe('Acme MSP');
    expect(report.model.sections.some((s) => s.category === 'spend')).toBe(false);
    expect(report.model.customSections[0]!.title).toBe('Roadmap');
    expect(report.model.discussion[0]!.response).toBe('Approved');

    const html = renderQbrHtml(report);
    expect(html).toContain('Acme MSP');
    expect(html).toContain('OpenVPN removal?');
  });
});

describe('dedupeByKey (PDF imports must not double-count synced metrics)', () => {
  it('keeps the integration row when a pdf:* import collides on key', async () => {
    const { dedupeByKey } = await import('../src/service.js');
    const metrics = [
      { key: 'tickets.opened', label: 'Tickets opened', value: 3, source: 'pdf:mash-it', category: 'operations' },
      { key: 'tickets.opened', label: 'Tickets opened', value: 62, source: 'halo', category: 'operations' },
      { key: 'doc.graymail', label: 'Graymail', value: 616, source: 'pdf:check-point', category: 'security' },
    ] as never[];
    const out = dedupeByKey(metrics);
    expect(out).toHaveLength(2);
    const tickets = out.find((m: { key: string }) => m.key === 'tickets.opened') as { value: number; source: string };
    expect(tickets.source).toBe('halo'); // synced beats imported, regardless of order
    expect(tickets.value).toBe(62);
    expect(out.some((m: { key: string }) => m.key === 'doc.graymail')).toBe(true); // unique pdf rows survive
  });

  it('returns the same array untouched when keys are unique', async () => {
    const { dedupeByKey } = await import('../src/service.js');
    const metrics = [
      { key: 'a', label: 'A', value: 1, source: 'halo', category: 'operations' },
      { key: 'b', label: 'B', value: 2, source: 'ninja', category: 'security' },
    ] as never[];
    expect(dedupeByKey(metrics)).toBe(metrics);
  });
});

describe('locked quarters serve the stored package', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qbr-served-'));
    process.env['QBR_DATA_DIR'] = dir;
    delete process.env['AzureWebJobsStorage'];
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QBR_DATA_DIR'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  const storedModel = {
    client: { name: 'Client One' },
    period: { id: '2026-Q2', label: 'Q2 2026' },
    brand: { orgName: 'Mash IT' },
    executive: { headline: 'Stored headline', paragraphs: ['Stored paragraph.'], highlights: [] },
    goals: [],
  };

  async function lockWithPackage(period: string) {
    const { getDataStore, getDocStore } = await import('../src/store/index.js');
    const { storePackage } = await import('../src/packages.js');
    const store = getDataStore();
    const seed = (await import('@mashit/core')).SEED_SNAPSHOTS.find((s) => s.clientId === 'anp')!;
    await store.upsertClient({ id: 'c1', name: 'Client One' });
    await store.putSnapshot({ ...seed, clientId: 'c1', period });
    const pkg = await storePackage(store, getDocStore(), {
      clientId: 'c1',
      period,
      stage: 'preread',
      createdBy: 'jason',
      artifacts: {
        model: storedModel as never,
        verification: true,
        warnings: ['stored warning'],
        pdf: Buffer.from('%PDF-stored'),
        pptx: Buffer.from('PK-stored'),
        html: '<!doctype html><p>stored</p>',
      },
    });
    await store.upsertQbr({
      clientId: 'c1',
      period,
      status: 'narrative_approved',
      packageSentAt: '2026-06-20T00:00:00Z',
      locks: { preread: { at: '2026-06-20T00:00:00Z', by: 'jason', version: pkg.version } },
      updatedAt: new Date().toISOString(),
    });
    return pkg;
  }

  it('getQbr returns the stored model and never calls the narrative model', async () => {
    await lockWithPackage('2026-Q2');
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    narrativeSpy.calls = 0;
    const h = await import('../src/handlers.js');
    const res = await h.getQbr('c1', '2026-Q2', '1');
    expect(res.status).toBe(200);
    const json = res.json as { model: { executive: { headline: string } }; warnings: string[]; package: { version: number; stage: string } };
    expect(json.model.executive.headline).toBe('Stored headline');
    expect(json.warnings).toEqual(['stored warning']);
    expect(json.package.version).toBe(1);
    expect(json.package.stage).toBe('preread');

    const pdf = await h.getReportPdf('c1', '2026-Q2', '1');
    expect(pdf.pdf?.toString()).toBe('%PDF-stored');
    expect(pdf.filename).toBe('Mash IT QBR - Client One - Q2 2026.pdf');
    expect((await h.getReportDeck('c1', '2026-Q2', '1')).pptx?.toString()).toBe('PK-stored');
    expect((await h.getReportHtml('c1', '2026-Q2', '1')).html).toBe('<!doctype html><p>stored</p>');
    const eml = await h.getEmailDraft('c1', '2026-Q2', '1');
    expect(eml.status).toBe(200);
    expect(eml.file?.bytes.toString()).toContain(Buffer.from('%PDF-stored').toString('base64'));
    expect(narrativeSpy.calls).toBe(0);
  });

  it('answers 503 when the lock exists but the stored blob is missing', async () => {
    const pkg = await lockWithPackage('2026-Q3');
    const { getDocStore } = await import('../src/store/index.js');
    await getDocStore().delete(pkg.files.pdf);
    const h = await import('../src/handlers.js');
    expect(await h.getReportPdf('c1', '2026-Q3', null)).toEqual({ status: 503, json: { error: 'Stored package missing; reopen to rebuild.' } });
  });

  it('later edits to goals and branding never change a locked quarter', async () => {
    await lockWithPackage('2026-Q4');
    const h = await import('../src/handlers.js');
    const before = (await h.getQbr('c1', '2026-Q4', null)).json as { model: unknown };
    expect((await h.putClientGoals('c1', { goals: [{ title: 'Open a second clinic' }] })).status).toBe(200);
    expect((await h.putConfig('c1', { brand: { name: 'Renamed Brand' } })).status).toBe(200);
    const after = (await h.getQbr('c1', '2026-Q4', null)).json as { model: unknown };
    expect(after.model).toEqual(before.model);
    expect(after.model).toEqual(storedModel);
  });
});
