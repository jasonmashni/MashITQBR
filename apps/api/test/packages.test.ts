import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReportModel } from '@mashit/report';
import { JsonDataStore, LocalDocStore } from '../src/store/index.js';
import { latestPackage, loadPackageFile, loadPackageModel, packagePath, storePackage } from '../src/packages.js';

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
  it('stores a package as version n+1 and loads the newest highest-stage record', async () => {
    const artifacts = { model: fakeModel, verification: true, warnings: ['w'], pdf: Buffer.from('%PDF-'), pptx: Buffer.from('PK'), html: '<!doctype html>' };
    const v1 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'preread', createdBy: 'jason', artifacts });
    const v2 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'final', createdBy: 'jason', artifacts });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await latestPackage(store, 'c1', '2026-Q2'))?.version).toBe(2);
    expect((await loadPackageModel(docs, v2))?.warnings).toEqual(['w']);
    expect((await loadPackageFile(docs, v2, 'pdf'))?.toString()).toBe('%PDF-');
    expect(packagePath('c1', '2026-Q2', 2, 'html')).toBe('packages/c1/2026-Q2/v2/report.html');
  });

  it('prefers a final package over a newer preread one', async () => {
    const artifacts = { model: fakeModel, verification: true, warnings: [], pdf: Buffer.from('%PDF-'), pptx: Buffer.from('PK'), html: '<!doctype html>' };
    const v3 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'preread', createdBy: 'jason', artifacts });
    expect(v3.version).toBe(3);
    const latest = await latestPackage(store, 'c1', '2026-Q2');
    expect(latest?.stage).toBe('final');
    expect(latest?.version).toBe(2);
    expect((await loadPackageModel(docs, v3))?.model.executive.headline).toBe('Stored headline');
    expect(await latestPackage(store, 'c1', '2026-Q3')).toBeUndefined();
  });
});
