import { SEED_CLIENTS, SEED_SNAPSHOTS, findSeedSnapshot, type DiscussionItem, type ReportConfig } from '@mashit/core';
import type { QbrDataSource } from '../dataSource.js';
import type { NarrativeCache } from '../service.js';
import { JsonDataStore } from './jsonStore.js';
import { TableDataStore } from './tableStore.js';
import { KeyVaultSecretStore, LocalSecretStore, type SecretStore } from './secretStore.js';
import type { DataStore } from './types.js';

export * from './types.js';
export * from './secretStore.js';
export * from './docStore.js';
export { JsonDataStore } from './jsonStore.js';
export { TableDataStore } from './tableStore.js';

let _data: DataStore | undefined;
let _dataKind: 'table' | 'json' = 'json';
let _secrets: SecretStore | undefined;
let _secretKind: 'keyvault' | 'local' = 'local';

/** Table Storage when a real storage connection is configured, else local JSON. */
export function getDataStore(): DataStore {
  if (!_data) {
    const conn = process.env['AzureWebJobsStorage'];
    if (conn && conn.trim() !== '') {
      _dataKind = 'table';
      _data = new TableDataStore(conn);
    } else {
      _dataKind = 'json';
      _data = new JsonDataStore();
    }
  }
  return _data;
}

/** Key Vault when KEY_VAULT_URL is set, else a local (dev-only) secret file. */
export function getSecretStore(): SecretStore {
  if (!_secrets) {
    const url = process.env['KEY_VAULT_URL'];
    _secretKind = url ? 'keyvault' : 'local';
    _secrets = url ? new KeyVaultSecretStore(url) : new LocalSecretStore();
  }
  return _secrets;
}

/** Which data backend the factory picked (forces creation). */
export function dataStoreKind(): 'table' | 'json' {
  getDataStore();
  return _dataKind;
}

/** Which secret backend the factory picked (forces creation). */
export function secretStoreKind(): 'keyvault' | 'local' {
  getSecretStore();
  return _secretKind;
}

let seeded = false;
/** On first run, seed the 3 sample clients + their snapshots so the app isn't empty. */
export async function ensureSeeded(store: DataStore = getDataStore()): Promise<void> {
  if (seeded) return;
  if ((await store.listClients()).length === 0) {
    for (const c of SEED_CLIENTS) await store.upsertClient(c);
    for (const s of SEED_SNAPSHOTS) await store.putSnapshot(s);
  }
  seeded = true;
}

/** QbrDataSource backed by the live store, falling back to seed snapshots. */
export function storeDataSource(store: DataStore = getDataStore()): QbrDataSource {
  return {
    async listClients() {
      await ensureSeeded(store);
      return store.listClients();
    },
    async getClient(id) {
      await ensureSeeded(store);
      return store.getClient(id);
    },
    async getSnapshot(clientId, period) {
      return (await store.getSnapshot(clientId, period)) ?? findSeedSnapshot(clientId, period);
    },
  };
}

/** Pseudo-clientId under which the org-level settings (Mash IT brand) live. */
export const ORG_SETTINGS_ID = '__org';

export interface ReportInputs {
  config?: ReportConfig;
  orgBrand?: import('@mashit/core').Brand;
  discussion?: DiscussionItem[];
  notes?: string;
  narrativeEdits?: import('./types.js').NarrativeEdits;
  documents?: Array<{ name: string; source: string }>;
}

/** Load persisted branding/config + discussion + narrative edits for a report build. */
export async function loadReportInputs(store: DataStore, clientId: string, period: string): Promise<ReportInputs> {
  const config = await store.getReportConfig(clientId);
  const org = await store.getReportConfig(ORG_SETTINGS_ID);
  const d = await store.getDiscussion(clientId, period);
  const narrative = await store.getNarrative(clientId, period);
  const documents = (await store.listDocuments(clientId, period)).map((doc) => ({ name: doc.name, source: doc.source }));
  return { config, orgBrand: org?.brand, discussion: d?.items, notes: d?.notes, narrativeEdits: narrative?.edits, documents };
}

/**
 * NarrativeCache backed by the DataStore — one record per client/period; a
 * hash mismatch (data re-synced, model changed) reads as a miss and the fresh
 * result overwrites the old record. Manual edits on the record survive.
 */
export function narrativeCacheFor(store: DataStore, clientId: string, period: string): NarrativeCache {
  return {
    async get(hash) {
      const rec = await store.getNarrative(clientId, period);
      return rec?.inputHash === hash ? rec.result : undefined;
    },
    async put(hash, result) {
      const existing = await store.getNarrative(clientId, period);
      await store.putNarrative({ clientId, period, inputHash: hash, result, edits: existing?.edits, updatedAt: new Date().toISOString() });
    },
  };
}
