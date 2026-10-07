import type { NarrativeResult } from '@mashit/narrative';
import type { ReportModel } from '@mashit/report';
import type { DataStore, DocContentStore, PackageRecord, PackageStage } from './store/index.js';

/**
 * Frozen report packages. When a quarter locks, the report is built once and
 * the model, PDF, deck and HTML are stored here; locked reads serve these
 * bytes and never rebuild or call a model.
 */

/** A stored model may carry the date of the reopen that produced it (workstream C renders it). */
export type StoredModel = ReportModel & { revisedAt?: string };

/** A document as the frozen build saw it (lock 2 reuses this list). */
export interface FrozenDocument {
  id: string;
  name: string;
  source: string;
  findings?: Array<{ text: string; severity: 'info' | 'watch' | 'act' }>;
}

/** What the package JSON holds besides the files. */
export interface StoredPackageJson {
  model: StoredModel;
  verification: boolean;
  warnings: string[];
  /** The narrative the build used; lock 2 reuses it with no model call. */
  narrative?: NarrativeResult;
  /** The documents the build used, for the model and the appended PDFs. */
  documents?: FrozenDocument[];
}

export interface PackageArtifacts {
  model: StoredModel;
  verification: boolean;
  warnings: string[];
  narrative?: NarrativeResult;
  documents?: FrozenDocument[];
  pdf: Buffer;
  pptx: Buffer;
  html: string;
}

type PackageFile = 'model' | 'pdf' | 'pptx' | 'html';

const EXT: Record<PackageFile, string> = { model: 'json', pdf: 'pdf', pptx: 'pptx', html: 'html' };
const CONTENT_TYPE: Record<PackageFile, string> = {
  model: 'application/json',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html; charset=utf-8',
};

export function packagePath(clientId: string, period: string, version: number, file: PackageFile): string {
  return `packages/${clientId}/${period}/v${version}/report.${EXT[file]}`;
}

/** Store the four artifacts as the next version for this client and period. */
export async function storePackage(
  store: DataStore,
  docs: DocContentStore,
  args: { clientId: string; period: string; stage: PackageStage; createdBy: string; artifacts: PackageArtifacts },
): Promise<PackageRecord> {
  const { clientId, period, stage, createdBy, artifacts } = args;
  const existing = await store.listPackages(clientId, period);
  const version = existing.reduce((max, p) => Math.max(max, p.version), 0) + 1;
  const files = {
    model: packagePath(clientId, period, version, 'model'),
    pdf: packagePath(clientId, period, version, 'pdf'),
    pptx: packagePath(clientId, period, version, 'pptx'),
    html: packagePath(clientId, period, version, 'html'),
  };
  const stored: StoredPackageJson = {
    model: artifacts.model,
    verification: artifacts.verification,
    warnings: artifacts.warnings,
    ...(artifacts.narrative ? { narrative: artifacts.narrative } : {}),
    ...(artifacts.documents ? { documents: artifacts.documents } : {}),
  };
  const json = JSON.stringify(stored);
  await docs.put(files.model, Buffer.from(json, 'utf8'), CONTENT_TYPE.model);
  await docs.put(files.pdf, artifacts.pdf, CONTENT_TYPE.pdf);
  await docs.put(files.pptx, artifacts.pptx, CONTENT_TYPE.pptx);
  await docs.put(files.html, Buffer.from(artifacts.html, 'utf8'), CONTENT_TYPE.html);
  // The record goes in last so a half-written package is never listed.
  return store.putPackage({
    clientId,
    period,
    version,
    stage,
    createdAt: new Date().toISOString(),
    createdBy,
    files,
    warnings: artifacts.warnings,
  });
}

/** The package a locked quarter serves: final beats preread, then the highest version. */
export async function latestPackage(store: DataStore, clientId: string, period: string): Promise<PackageRecord | undefined> {
  const all = await store.listPackages(clientId, period);
  return [...all].sort((a, b) => Number(b.stage === 'final') - Number(a.stage === 'final') || b.version - a.version)[0];
}

export async function loadPackageModel(docs: DocContentStore, record: PackageRecord): Promise<StoredPackageJson | undefined> {
  const bytes = await docs.get(record.files.model);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as StoredPackageJson;
  } catch {
    return undefined;
  }
}

export async function loadPackageFile(docs: DocContentStore, record: PackageRecord, file: 'pdf' | 'pptx' | 'html'): Promise<Buffer | undefined> {
  return docs.get(record.files[file]);
}
