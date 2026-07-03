import { parsePeriod, type Client, type MetricSnapshot } from '@mashit/core';
import {
  assembleSnapshot,
  basicAuthHeader,
  checkpointToken,
  cippToken,
  collectCheckpoint,
  collectCipp,
  collectConnectSecure,
  collectDropsuite,
  collectGoogleWorkspace,
  collectHalo,
  collectHaloDirect,
  collectHudu,
  collectHuntress,
  collectNinja,
  collectNinjaDirect,
  collectPrintix,
  connectSecureToken,
  FetchHttpTransport,
  googleWorkspaceToken,
  haloGet,
  listCippTenants,
  listConnectSecureCompanies,
  listDropsuiteOrgs,
  listHaloClients,
  listHuduCompanies,
  listNinjaOrgs,
  ninjaToken,
  parseIdNameList,
  printixToken,
  runCollectors,
  toArray,
  unwrapMcp,
  type CippCfg,
  type CollectResult,
  type ConnectSecureCfg,
  type DropsuiteCfg,
  type GoogleWorkspaceCfg,
  type HaloCfg,
  type HttpTransport,
  type HuduCfg,
  type McpTransport,
  type NinjaCfg,
  type PrintixCfg,
} from '@mashit/integrations';
import { resolveSecret } from './connections.js';
import type { Connection, DataStore, SecretStore } from './store/index.js';

export interface Integrations {
  store: DataStore;
  secrets: SecretStore;
  /** Legacy MASH MCP transport (only used when no direct connection exists). */
  mcp?: McpTransport;
  /** HTTP transport for direct-REST integrations; defaults to fetch. */
  http?: HttpTransport;
}

// ── Per-vendor config resolution (connection record + secret store) ─────────

async function haloCfg(secrets: SecretStore, conn: Connection): Promise<HaloCfg> {
  const ticketTypeIds = (conn.config['ticketTypeIds'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    baseUrl: conn.config['baseUrl'] ?? '',
    clientId: conn.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(secrets, conn, 'clientSecret')) ?? '',
    tenant: conn.config['tenant'] || undefined,
    ticketTypeIds: ticketTypeIds.length ? ticketTypeIds : undefined,
  };
}

async function ninjaCfg(secrets: SecretStore, conn: Connection): Promise<NinjaCfg> {
  return {
    baseUrl: conn.config['baseUrl'] || undefined,
    clientId: conn.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(secrets, conn, 'clientSecret')) ?? '',
  };
}

async function huduCfg(secrets: SecretStore, conn: Connection): Promise<HuduCfg> {
  return { baseUrl: conn.config['baseUrl'] ?? '', apiKey: (await resolveSecret(secrets, conn, 'apiKey')) ?? '' };
}

async function dropsuiteCfg(secrets: SecretStore, conn: Connection): Promise<DropsuiteCfg> {
  return { baseUrl: conn.config['baseUrl'] || undefined, token: (await resolveSecret(secrets, conn, 'token')) ?? '' };
}

async function printixCfg(secrets: SecretStore, conn: Connection, tenantId?: string): Promise<PrintixCfg> {
  return {
    tenantId: tenantId ?? conn.config['tenantId'] ?? '',
    clientId: conn.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(secrets, conn, 'clientSecret')) ?? '',
  };
}

async function connectSecureCfg(secrets: SecretStore, conn: Connection): Promise<ConnectSecureCfg> {
  return {
    baseUrl: conn.config['baseUrl'] ?? '',
    clientId: conn.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(secrets, conn, 'clientSecret')) ?? '',
    tenant: conn.config['tenant'] || undefined,
  };
}

async function cippCfg(secrets: SecretStore, conn: Connection): Promise<CippCfg> {
  return {
    baseUrl: conn.config['baseUrl'] ?? '',
    tenantId: conn.config['tenantId'] ?? '',
    clientId: conn.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(secrets, conn, 'clientSecret')) ?? '',
    scope: conn.config['scope'] || undefined,
  };
}

async function googleWorkspaceCfg(secrets: SecretStore, conn: Connection): Promise<GoogleWorkspaceCfg> {
  return {
    adminEmail: conn.config['adminEmail'] ?? '',
    customer: conn.config['customer'] || undefined,
    serviceAccountJson: (await resolveSecret(secrets, conn, 'serviceAccountJson')) ?? '',
  };
}

/** True when a connection is configured for the direct API (not the MCP ride-along). */
const hasDirectCreds = (conn: Connection | undefined): conn is Connection => !!conn && !!conn.config['clientId'];

interface HaloClientRow {
  id?: number | string;
  name?: string;
  client_name?: string;
  sector_name?: string;
}

/** Legacy path: rows from the MASH MCP's halo_list_clients formatted text. */
async function fetchHaloClientsMcp(mcp: McpTransport): Promise<HaloClientRow[]> {
  const payload = unwrapMcp(await mcp.callTool('halo_list_clients', { count: 500 }));
  if (typeof payload === 'string') {
    return parseIdNameList(payload).map((r) => ({ id: r.id, name: r.name }));
  }
  return toArray<HaloClientRow>(payload, ['clients']);
}

function byType(conns: Connection[]): Map<string, Connection> {
  const m = new Map<string, Connection>();
  for (const c of conns) if (!m.has(c.type)) m.set(c.type, c);
  return m;
}

/**
 * Resolve the connection to use for a type + client. A connection can be
 * dedicated to one QBR client via config.qbrClientId (per-tenant API keys:
 * Check Point child tenants, Google Workspace domains); a dedicated match
 * wins over the shared (unbound) connection.
 */
function connFor(conns: Connection[], type: string, clientId: string): Connection | undefined {
  const ofType = conns.filter((c) => c.type === type);
  return ofType.find((c) => c.config['qbrClientId'] === clientId) ?? ofType.find((c) => !c.config['qbrClientId']);
}

/** The first connection usable for direct Halo API calls, if any. */
export async function directHaloConn(store: DataStore): Promise<Connection | undefined> {
  const conn = byType(await store.listConnections()).get('halo');
  return hasDirectCreds(conn) ? conn : undefined;
}

/** Import clients from Halo (direct API preferred; legacy MCP fallback) and upsert them. */
export async function importHaloClients(intg: Integrations): Promise<Client[]> {
  const http = intg.http ?? new FetchHttpTransport();
  const halo = await directHaloConn(intg.store);

  let rows: HaloClientRow[];
  if (halo) {
    rows = await listHaloClients(http, await haloCfg(intg.secrets, halo));
  } else if (intg.mcp) {
    rows = await fetchHaloClientsMcp(intg.mcp);
  } else {
    throw new Error('No Halo connection configured — add one under Integrations.');
  }

  const clients: Client[] = [];
  for (const r of rows) {
    if (r.id === undefined) continue;
    const haloId = String(r.id);
    const existing = await intg.store.getClient(`halo-${haloId}`);
    const client: Client = {
      id: `halo-${haloId}`,
      name: r.name ?? r.client_name ?? `Client ${haloId}`,
      industry: r.sector_name,
      // Imports default to NOT getting QBRs — the user enables just the
      // clients they actually review. Re-imports keep the existing choice.
      qbrEnabled: existing?.qbrEnabled ?? false,
      integrationRefs: { ...(existing?.integrationRefs ?? {}), halo: haloId },
    };
    await intg.store.upsertClient(client);
    clients.push(client);
  }
  return clients;
}

export interface ExternalOrg {
  id: string;
  name: string;
}

/**
 * List the selectable client-orgs inside a tool so mappings can be picked from
 * a dropdown instead of typed by hand. Returns null for types with no listable
 * orgs (the UI falls back to free text).
 */
export async function listOrgs(intg: Integrations, conn: Connection): Promise<ExternalOrg[] | null> {
  const http = intg.http ?? new FetchHttpTransport();
  switch (conn.type) {
    case 'halo': {
      if (!hasDirectCreds(conn)) throw new Error('Add the Halo Client ID + Secret to list clients.');
      const rows = await listHaloClients(http, await haloCfg(intg.secrets, conn));
      return rows.filter((r) => r.id !== undefined).map((r) => ({ id: String(r.id), name: r.name ?? r.client_name ?? `Client ${String(r.id)}` }));
    }
    case 'mcp': {
      if (!intg.mcp) throw new Error('No MASH MCP transport available.');
      const rows = await fetchHaloClientsMcp(intg.mcp);
      return rows.filter((r) => r.id !== undefined).map((r) => ({ id: String(r.id), name: r.name ?? r.client_name ?? `Client ${String(r.id)}` }));
    }
    case 'ninja': {
      if (hasDirectCreds(conn)) return listNinjaOrgs(http, await ninjaCfg(intg.secrets, conn));
      // Legacy: NinjaOne riding the MASH MCP transport.
      if (!intg.mcp) throw new Error('Add NinjaOne API credentials (or configure the MASH MCP) to list organizations.');
      const payload = unwrapMcp(await intg.mcp.callTool('ninja_list_organizations', {}));
      if (typeof payload === 'string') return parseIdNameList(payload);
      return toArray<{ id?: number | string; name?: string }>(payload, ['organizations'])
        .filter((r) => r.id !== undefined)
        .map((r) => ({ id: String(r.id), name: r.name ?? `Org ${String(r.id)}` }));
    }
    case 'hudu':
      return listHuduCompanies(http, await huduCfg(intg.secrets, conn));
    case 'dropsuite':
      return listDropsuiteOrgs(http, await dropsuiteCfg(intg.secrets, conn));
    case 'connectsecure':
      return listConnectSecureCompanies(http, await connectSecureCfg(intg.secrets, conn));
    case 'cipp':
      return listCippTenants(http, await cippCfg(intg.secrets, conn));
    case 'huntress': {
      const base = conn.config['baseUrl'] ?? 'https://api.huntress.io/v1';
      const headers = {
        Authorization: basicAuthHeader(
          (await resolveSecret(intg.secrets, conn, 'apiKey')) ?? '',
          (await resolveSecret(intg.secrets, conn, 'apiSecret')) ?? '',
        ),
        Accept: 'application/json',
      };
      const out: ExternalOrg[] = [];
      // Huntress paginates via page_token/next_page_token; cap defensively
      // (account rate limit is 60 req/min).
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const url = `${base}/organizations?limit=500${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
        const res = await http.request({ method: 'GET', url, headers });
        if (res.status < 200 || res.status >= 300) throw new Error(`Huntress responded ${res.status}`);
        const rows = toArray<{ id?: number | string; name?: string }>(res.json, ['organizations']);
        for (const r of rows) if (r.id !== undefined) out.push({ id: String(r.id), name: r.name ?? `Org ${String(r.id)}` });
        const next = (res.json as { pagination?: { next_page_token?: string | null } } | null)?.pagination?.next_page_token;
        if (!next || rows.length === 0) break;
        token = String(next);
      }
      return out;
    }
    default:
      return null; // no listable orgs — free-text mapping
  }
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
      case 'halo': {
        if (!hasDirectCreds(conn)) return { ok: false, message: 'Halo needs the instance URL, Client ID and Client Secret.' };
        await haloGet(http, await haloCfg(intg.secrets, conn), 'Client', { pageinate: true, page_size: 1, page_no: 1 });
        return { ok: true, message: 'HaloPSA reachable' };
      }
      case 'ninja': {
        if (hasDirectCreds(conn)) {
          await ninjaToken(http, await ninjaCfg(intg.secrets, conn));
          return { ok: true, message: 'NinjaOne reachable' };
        }
        if (!intg.mcp) return { ok: false, message: 'Add NinjaOne API credentials (Client ID + Secret with the monitoring scope).' };
        await intg.mcp.callTool('ninja_list_organizations', {});
        return { ok: true, message: 'NinjaOne reachable via MASH MCP (legacy — add direct API credentials)' };
      }
      case 'hudu': {
        const cfg = await huduCfg(intg.secrets, conn);
        if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, message: 'Hudu needs the instance URL and an API key.' };
        await listHuduCompanies(http, { ...cfg });
        return { ok: true, message: 'Hudu reachable' };
      }
      case 'checkpoint': {
        const clientId = conn.config['clientId'];
        const accessKey = await resolveSecret(intg.secrets, conn, 'accessKey');
        const token = await resolveSecret(intg.secrets, conn, 'token');
        if (clientId && accessKey) {
          await checkpointToken(http, { baseUrl: conn.config['baseUrl'] ?? '', clientId, accessKey, authUrl: conn.config['authUrl'] || undefined });
          return { ok: true, message: 'Check Point Infinity Portal reachable' };
        }
        if (token) return { ok: true, note: 'Saved with a legacy token. Live test runs on next sync.' };
        return { ok: false, message: 'Check Point needs an Infinity Portal Client ID + Access Key.' };
      }
      case 'dropsuite': {
        await listDropsuiteOrgs(http, await dropsuiteCfg(intg.secrets, conn));
        return { ok: true, message: 'Dropsuite reachable' };
      }
      case 'printix': {
        await printixToken(http, await printixCfg(intg.secrets, conn));
        return { ok: true, message: 'Printix reachable' };
      }
      case 'connectsecure': {
        await connectSecureToken(http, await connectSecureCfg(intg.secrets, conn));
        return { ok: true, message: 'ConnectSecure reachable' };
      }
      case 'cipp': {
        const cfg = await cippCfg(intg.secrets, conn);
        if (!cfg.baseUrl || !cfg.tenantId || !cfg.clientId) {
          return { ok: false, message: 'CIPP needs the instance URL, Entra tenant id, Client ID and Client Secret.' };
        }
        await listCippTenants(http, cfg);
        return { ok: true, message: 'CIPP reachable' };
      }
      case 'googleworkspace': {
        const cfg = await googleWorkspaceCfg(intg.secrets, conn);
        if (!cfg.adminEmail || !cfg.serviceAccountJson) {
          return { ok: false, message: 'Google Workspace needs the admin email and the service-account JSON key.' };
        }
        await googleWorkspaceToken(http, cfg);
        return { ok: true, message: 'Google Workspace reachable' };
      }
      case 'mcp': {
        if (!intg.mcp) return { ok: false, message: 'MCP connection missing URL' };
        await intg.mcp.callTool('halo_list_clients', { count: 1 });
        return { ok: true, message: 'MASH MCP reachable (legacy — direct API connections are preferred)' };
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
 * snapshot, and persist it. Every vendor is called directly with credentials
 * from the secret store; the MASH MCP is only a legacy fallback for Halo and
 * Ninja when no direct connection exists. The client's per-tool external ids
 * live on `client.integrationRefs`.
 */
/** A vendor-generated report file surfaced by a collector during sync. */
export interface SyncDocument {
  source: string;
  name: string;
  url: string;
}

export async function syncClientMetrics(
  intg: Integrations,
  clientId: string,
  period: string,
  capturedAt: string = new Date().toISOString(),
): Promise<{ snapshot: MetricSnapshot; warnings: string[]; documents: SyncDocument[] }> {
  const client = await intg.store.getClient(clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);
  const refs = client.integrationRefs ?? {};
  const p = parsePeriod(period);
  const allConns = await intg.store.listConnections();
  const conns = { get: (type: string) => connFor(allConns, type, clientId) };
  const http = intg.http ?? new FetchHttpTransport();
  const secrets = intg.secrets;

  const runs: Array<{ source: CollectResult['source']; run: () => Promise<CollectResult> }> = [];
  const ctx = (externalRef: string | undefined) => ({ clientId, period: p, externalRef });

  const halo = conns.get('halo');
  if (refs.halo && hasDirectCreds(halo)) {
    runs.push({ source: 'halo', run: async () => collectHaloDirect(ctx(refs.halo), http, await haloCfg(secrets, halo)) });
  } else if (refs.halo && intg.mcp) {
    const mcp = intg.mcp;
    runs.push({
      source: 'halo',
      run: async () => {
        const out = await collectHalo(ctx(refs.halo), mcp);
        out.warnings.push('Halo is syncing via the legacy MASH MCP — add a direct HaloPSA connection for full ticket history and finance data.');
        return out;
      },
    });
  }

  const ninja = conns.get('ninja');
  if (refs.ninja && hasDirectCreds(ninja)) {
    runs.push({ source: 'ninja', run: async () => collectNinjaDirect(ctx(refs.ninja), http, await ninjaCfg(secrets, ninja)) });
  } else if (refs.ninja && intg.mcp) {
    const mcp = intg.mcp;
    runs.push({
      source: 'ninja',
      run: async () => {
        const out = await collectNinja(ctx(refs.ninja), mcp);
        out.warnings.push('NinjaOne is syncing via the legacy MASH MCP — add a direct NinjaOne connection for richer data.');
        return out;
      },
    });
  }

  const hudu = conns.get('hudu');
  if (refs.hudu && hudu) {
    runs.push({ source: 'hudu', run: async () => collectHudu(ctx(refs.hudu), http, await huduCfg(secrets, hudu)) });
  }

  // CIPP runs before Huntress so its M365 MFA coverage wins the dedupe for
  // Microsoft tenants (Huntress ITDR identity data stays as the fallback).
  const cipp = conns.get('cipp');
  if (refs.cipp && cipp) {
    runs.push({ source: 'cipp', run: async () => collectCipp(ctx(refs.cipp), http, await cippCfg(secrets, cipp)) });
  }

  // Google Workspace connections are bound to a single client (per-domain
  // service accounts) — run every connection dedicated to this client.
  for (const gw of allConns.filter((c) => c.type === 'googleworkspace' && c.config['qbrClientId'] === clientId)) {
    runs.push({
      source: 'googleworkspace',
      run: async () => collectGoogleWorkspace(ctx(gw.config['customer'] || 'my_customer'), http, await googleWorkspaceCfg(secrets, gw)),
    });
  }

  const huntress = conns.get('huntress');
  if (refs.huntress && huntress) {
    runs.push({
      source: 'huntress',
      run: async () => {
        const apiKey = (await resolveSecret(secrets, huntress, 'apiKey')) ?? '';
        const apiSecret = (await resolveSecret(secrets, huntress, 'apiSecret')) ?? '';
        return collectHuntress(ctx(refs.huntress), http, { baseUrl: huntress.config['baseUrl'], apiKey, apiSecret });
      },
    });
  }

  // Check Point Infinity Portal keys are per-tenant — a connection bound to
  // this client via qbrClientId runs without needing an org mapping.
  const checkpoint = conns.get('checkpoint');
  if (checkpoint && (refs.checkpoint || checkpoint.config['qbrClientId'] === clientId)) {
    runs.push({
      source: 'checkpoint',
      run: async () =>
        collectCheckpoint(ctx(refs.checkpoint ?? clientId), http, {
          baseUrl: checkpoint.config['baseUrl'] ?? '',
          token: await resolveSecret(secrets, checkpoint, 'token'),
          clientId: checkpoint.config['clientId'] || undefined,
          accessKey: await resolveSecret(secrets, checkpoint, 'accessKey'),
          authUrl: checkpoint.config['authUrl'] || undefined,
        }),
    });
  }

  const dropsuite = conns.get('dropsuite');
  if (refs.dropsuite && dropsuite) {
    runs.push({ source: 'dropsuite', run: async () => collectDropsuite(ctx(refs.dropsuite), http, await dropsuiteCfg(secrets, dropsuite)) });
  }

  const printix = conns.get('printix');
  if (printix && (refs.printix || printix.config['tenantId'])) {
    runs.push({ source: 'printix', run: async () => collectPrintix(ctx(refs.printix), http, await printixCfg(secrets, printix, refs.printix)) });
  }

  const connectsecure = conns.get('connectsecure');
  if (refs.connectsecure && connectsecure) {
    runs.push({ source: 'connectsecure', run: async () => collectConnectSecure(ctx(refs.connectsecure), http, await connectSecureCfg(secrets, connectsecure)) });
  }

  const results = await runCollectors(runs);
  const { snapshot, warnings } = assembleSnapshot(clientId, period, results, capturedAt);
  if (runs.length === 0) {
    warnings.push('No integrations mapped for this client — configure connections and set the client\'s external ids.');
  }
  await intg.store.putSnapshot(snapshot);
  const documents = results.flatMap((r) => (r.documents ?? []).map((d) => ({ source: r.source, name: d.name, url: d.url })));
  return { snapshot, warnings, documents };
}
