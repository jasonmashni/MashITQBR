import { parsePeriod, type Client, type MetricSnapshot } from '@mashit/core';
import {
  assembleSnapshot,
  collectCheckpoint,
  collectHalo,
  collectHuntress,
  collectNinja,
  FetchHttpTransport,
  runCollectors,
  toArray,
  unwrapMcp,
  type CollectResult,
  type HttpTransport,
  type McpTransport,
} from '@mashit/integrations';
import { resolveSecret } from './connections.js';
import type { Connection, DataStore, SecretStore } from './store/index.js';

export interface Integrations {
  store: DataStore;
  secrets: SecretStore;
  /** Resolved MASH MCP transport (built from the 'mcp' connection). */
  mcp?: McpTransport;
  /** HTTP transport for direct-REST integrations; defaults to fetch. */
  http?: HttpTransport;
}

interface HaloClientRow {
  id?: number | string;
  name?: string;
  client_name?: string;
  sector_name?: string;
}

/** Import clients from Halo via MCP and upsert them into the store. */
export async function importHaloClients(intg: Integrations): Promise<Client[]> {
  if (!intg.mcp) throw new Error('No MASH MCP connection configured — add one under Integrations.');
  const result = await intg.mcp.callTool('halo_list_clients', {});
  const rows = toArray<HaloClientRow>(unwrapMcp(result), ['clients']);
  const clients: Client[] = [];
  for (const r of rows) {
    if (r.id === undefined) continue;
    const haloId = String(r.id);
    const client: Client = {
      id: `halo-${haloId}`,
      name: r.name ?? r.client_name ?? `Client ${haloId}`,
      industry: r.sector_name,
      integrationRefs: { halo: haloId },
    };
    await intg.store.upsertClient(client);
    clients.push(client);
  }
  return clients;
}

function byType(conns: Connection[]): Map<string, Connection> {
  const m = new Map<string, Connection>();
  for (const c of conns) if (!m.has(c.type)) m.set(c.type, c);
  return m;
}

/**
 * Pull live metrics for a client/period from every mapped tool, assemble a
 * snapshot, and persist it. Halo/Ninja read via the MASH MCP; Huntress and
 * Check Point read directly with credentials resolved from the secret store.
 * The client's per-tool external ids live on `client.integrationRefs`.
 */
export async function syncClientMetrics(
  intg: Integrations,
  clientId: string,
  period: string,
  capturedAt: string = new Date().toISOString(),
): Promise<{ snapshot: MetricSnapshot; warnings: string[] }> {
  const client = await intg.store.getClient(clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);
  const refs = client.integrationRefs ?? {};
  const p = parsePeriod(period);
  const conns = byType(await intg.store.listConnections());
  const http = intg.http ?? new FetchHttpTransport();

  const runs: Array<{ source: CollectResult['source']; run: () => Promise<CollectResult> }> = [];

  if (refs.halo && intg.mcp) {
    const mcp = intg.mcp;
    runs.push({ source: 'halo', run: () => collectHalo({ clientId, period: p, externalRef: refs.halo }, mcp) });
  }
  if (refs.ninja && intg.mcp) {
    const mcp = intg.mcp;
    runs.push({ source: 'ninja', run: () => collectNinja({ clientId, period: p, externalRef: refs.ninja }, mcp) });
  }

  const huntress = conns.get('huntress');
  if (refs.huntress && huntress) {
    runs.push({
      source: 'huntress',
      run: async () => {
        const apiKey = (await resolveSecret(intg.secrets, huntress, 'apiKey')) ?? '';
        const apiSecret = (await resolveSecret(intg.secrets, huntress, 'apiSecret')) ?? '';
        return collectHuntress({ clientId, period: p, externalRef: refs.huntress }, http, {
          baseUrl: huntress.config['baseUrl'],
          apiKey,
          apiSecret,
        });
      },
    });
  }

  const checkpoint = conns.get('checkpoint');
  if (refs.checkpoint && checkpoint) {
    runs.push({
      source: 'checkpoint',
      run: async () => {
        const token = (await resolveSecret(intg.secrets, checkpoint, 'token')) ?? '';
        return collectCheckpoint({ clientId, period: p, externalRef: refs.checkpoint }, http, {
          baseUrl: checkpoint.config['baseUrl'] ?? '',
          token,
        });
      },
    });
  }

  const results = await runCollectors(runs);
  const { snapshot, warnings } = assembleSnapshot(clientId, period, results, capturedAt);
  if (runs.length === 0) {
    warnings.push('No integrations mapped for this client — configure connections and set the client\'s external ids.');
  }
  await intg.store.putSnapshot(snapshot);
  return { snapshot, warnings };
}
