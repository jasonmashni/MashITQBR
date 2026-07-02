import { parsePeriod, type Client, type MetricSnapshot } from '@mashit/core';
import {
  assembleSnapshot,
  basicAuthHeader,
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

export interface TestOutcome {
  ok: boolean;
  message?: string;
  /** Set when no live probe exists for the type. */
  note?: string;
}

/**
 * Probe a connection with a cheap authenticated read so the portal's "Test"
 * button reflects reality. Types without a safe probe report as saved-only.
 */
export async function testConnection(intg: Integrations, conn: Connection): Promise<TestOutcome> {
  const http = intg.http ?? new FetchHttpTransport();
  try {
    switch (conn.type) {
      case 'mcp': {
        if (!intg.mcp) return { ok: false, message: 'MCP connection missing URL' };
        await intg.mcp.callTool('halo_list_clients', {});
        return { ok: true, message: 'MASH MCP reachable' };
      }
      case 'huntress': {
        // Convention: baseUrl includes /v1 (matches collectHuntress).
        const base = conn.config['baseUrl'] ?? 'https://api.huntress.io/v1';
        const apiKey = (await resolveSecret(intg.secrets, conn, 'apiKey')) ?? '';
        const apiSecret = (await resolveSecret(intg.secrets, conn, 'apiSecret')) ?? '';
        const res = await http.request({
          method: 'GET',
          url: `${base}/account`,
          headers: { Authorization: basicAuthHeader(apiKey, apiSecret), Accept: 'application/json' },
        });
        return res.status >= 200 && res.status < 300
          ? { ok: true, message: 'Huntress reachable' }
          : { ok: false, message: `Huntress responded ${res.status}` };
      }
      case 'zomentum': {
        const base = conn.config['baseUrl'] ?? 'https://api.zomentum.com';
        const token = (await resolveSecret(intg.secrets, conn, 'token')) ?? '';
        const res = await http.request({
          method: 'GET',
          url: `${base}/v1/opportunities`,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        return res.status >= 200 && res.status < 300
          ? { ok: true, message: 'Zomentum reachable' }
          : { ok: false, message: `Zomentum responded ${res.status}` };
      }
      default:
        return { ok: true, note: 'Saved. Live test runs on next sync.' };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'connection failed' };
  }
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
