import { SEED_CLIENTS, SEED_SNAPSHOTS, findSeedSnapshot, type DiscussionItem, type ReportConfig } from '@mashit/core';
import type { QbrDataSource } from '../dataSource.js';
import type { NarrativeCache } from '../service.js';
import { JsonDataStore } from './jsonStore.js';
import { TableDataStore } from './tableStore.js';
import { KeyVaultSecretStore, LocalSecretStore, type SecretStore } from './secretStore.js';
import type { DataStore } from './types.js';

export * from './types.js';
export * from './secretStore.js';
export { JsonDataStore } from './jsonStore.js';
export { TableDataStore } from './tableStore.js';

let _data: DataStore | undefined;
let _secrets: SecretStore | undefined;

/** Table Storage when a real storage connection is configured, else local JSON. */
export function getDataStore(): DataStore {
  if (!_data) {
    const conn = process.env['AzureWebJobsStorage'];
    _data = conn && conn.trim() !== '' ? new TableDataStore(conn) : new JsonDataStore();
  }
  return _data;
}

/** Key Vault when KEY_VAULT_URL is set, else a local (dev-only) secret file. */
export function getSecretStore(): SecretStore {
  if (!_secrets) {
    const url = process.env['KEY_VAULT_URL'];
    _secrets = url ? new KeyVaultSecretStore(url) : new LocalSecretStore();
  }
  return _secrets;
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

export interface ReportInputs {
  config?: ReportConfig;
  discussion?: DiscussionItem[];
  notes?: string;
}

/** Load persisted branding/config + discussion to feed a report build. */
export async function loadReportInputs(store: DataStore, clientId: string, period: string): Promise<ReportInputs> {
  const config = await store.getReportConfig(clientId);
  const d = await store.getDiscussion(clientId, period);
  return { config, discussion: d?.items, notes: d?.notes };
}

/**
 * NarrativeCache backed by the DataStore — one record per client/period; a
 * hash mismatch (data re-synced, model changed) reads as a miss and the fresh
 * result overwrites the old record.
 */
export function narrativeCacheFor(store: DataStore, clientId: string, period: string): NarrativeCache {
  return {
    async get(hash) {
      const rec = await store.getNarrative(clientId, period);
      return rec?.inputHash === hash ? rec.result : undefined;
    },
    async put(hash, result) {
      await store.putNarrative({ clientId, period, inputHash: hash, result, updatedAt: new Date().toISOString() });
    },
  };
}
