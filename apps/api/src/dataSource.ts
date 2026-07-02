import { SEED_CLIENTS, findSeedSnapshot, type Client, type MetricSnapshot } from '@mashit/core';

/**
 * Abstraction over where QBR data comes from. Async so a Table Storage-backed
 * implementation fits. The seed source (below) resolves immediately from the
 * transcribed sample data; `storeDataSource` (store/index.ts) reads the live
 * store with a seed fallback.
 */
export interface QbrDataSource {
  listClients(): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  getSnapshot(clientId: string, periodId: string): Promise<MetricSnapshot | undefined>;
}

export const seedDataSource: QbrDataSource = {
  listClients: async () => [...SEED_CLIENTS],
  getClient: async (id) => SEED_CLIENTS.find((c) => c.id === id),
  getSnapshot: async (clientId, periodId) => findSeedSnapshot(clientId, periodId),
};
