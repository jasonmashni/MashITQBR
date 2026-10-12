import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReportModel } from '@mashit/report';
import { JsonDataStore, LocalDocStore } from '../src/store/index.js';
import { loadPackageFile, loadPackageModel, packagePath, storePackage } from '../src/packages.js';

let dir: string;
let store: JsonDataStore;
let docs: LocalDocStore;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-packages-'));
  store = new JsonDataStore(join(dir, 'data'));
  docs = new LocalDocStore(join(dir, 'docs'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeModel = { executive: { headline: 'Stored headline' } } as unknown as ReportModel;

describe('package store', () => {
  it('stores a package as version n+1 and loads its files', async () => {
    const artifacts = { model: fakeModel, verification: true, warnings: ['w'], pdf: Buffer.from('%PDF-'), pptx: Buffer.from('PK'), html: '<!doctype html>' };
    const v1 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'preread', createdBy: 'jason', artifacts });
    const v2 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'final', createdBy: 'jason', artifacts });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await store.listPackages('c1', '2026-Q2')).map((p) => [p.version, p.stage])).toEqual([[1, 'preread'], [2, 'final']]);
    expect((await loadPackageModel(docs, v2))?.warnings).toEqual(['w']);
    expect((await loadPackageFile(docs, v2, 'pdf'))?.toString()).toBe('%PDF-');
    expect(packagePath('c1', '2026-Q2', 2, 'html')).toBe('packages/c1/2026-Q2/v2/report.html');
  });

  it('keeps the narrative and document list the build used', async () => {
    const narrative = { output: { headline: 'Stored headline' }, verification: { ok: true, failures: [] }, attempts: 1 } as never;
    const documents = [{ id: 'd1', name: 'backup.pdf', source: 'upload' }];
    const artifacts = { model: fakeModel, verification: true, warnings: [], narrative, documents, pdf: Buffer.from('%PDF-'), pptx: Buffer.from('PK'), html: '<!doctype html>' };
    const v3 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'preread', createdBy: 'jason', artifacts });
    expect(v3.version).toBe(3);
    const loaded = await loadPackageModel(docs, v3);
    expect(loaded?.model.executive.headline).toBe('Stored headline');
    expect(loaded?.narrative).toEqual(narrative);
    expect(loaded?.documents).toEqual(documents);
  });
});
