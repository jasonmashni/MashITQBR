import { SEED_CLIENTS, findSeedSnapshot, type Client, type MetricSnapshot } from '@mashit/core';

/**
 * Abstraction over where QBR data comes from. v1 reads from the seeded
 * snapshots (transcribed from past QBRs); the live source — backed by the MASH
 * MCP server + vendor read clients writing to Azure SQL — implements the same
 * interface so the service layer is unchanged when it's swapped in.
 */
export interface QbrDataSource {
  listClients(): Client[];
  getClient(id: string): Client | undefined;
  getSnapshot(clientId: string, periodId: string): MetricSnapshot | undefined;
}

export const seedDataSource: QbrDataSource = {
  listClients: () => [...SEED_CLIENTS],
  getClient: (id) => SEED_CLIENTS.find((c) => c.id === id),
  getSnapshot: (clientId, periodId) => findSeedSnapshot(clientId, periodId),
};
