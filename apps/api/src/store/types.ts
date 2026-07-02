import type {
  Client,
  IntegrationId,
  MetricSnapshot,
  QbrDiscussion,
  QbrStatus,
  ReportConfig,
} from '@mashit/core';

/** Kind of integration a connection represents. */
export type ConnectionType = IntegrationId | 'mcp' | 'zomentum';

/**
 * A configured integration connection. Non-secret settings live in `config`;
 * secret fields are stored in the secret store and only *referenced* here by
 * name — a Connection record never contains a secret value.
 */
export interface Connection {
  id: string;
  type: ConnectionType;
  label: string;
  /** Non-secret config: baseUrl, region, orgId, tenant, etc. */
  config: Record<string, string>;
  /** field name -> secret store key (e.g. `apiSecret` -> `conn-abc--apiSecret`). */
  secretRefs: Record<string, string>;
  status?: 'unknown' | 'ok' | 'error';
  statusMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/** Maps a client to a connection, with that client's id inside the tool. */
export interface ClientConnectionMap {
  clientId: string;
  connectionId: string;
  externalRef?: string;
}

/** QBR lifecycle record (status + meeting scheduling). */
export interface QbrRecord {
  clientId: string;
  period: string;
  status: QbrStatus;
  meeting?: { scheduledAt?: string; joinUrl?: string; heldAt?: string; attendees?: string[] };
  updatedAt: string;
}

/**
 * Persistence for all app data. Async so a Table Storage implementation fits;
 * the local JSON implementation just resolves immediately.
 */
export interface DataStore {
  // clients
  listClients(): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  upsertClient(client: Client): Promise<Client>;

  // connections
  listConnections(): Promise<Connection[]>;
  getConnection(id: string): Promise<Connection | undefined>;
  upsertConnection(conn: Connection): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;

  // client <-> connection mappings
  listClientConnections(clientId: string): Promise<ClientConnectionMap[]>;
  putClientConnections(clientId: string, maps: ClientConnectionMap[]): Promise<void>;

  // qbr lifecycle
  getQbr(clientId: string, period: string): Promise<QbrRecord | undefined>;
  upsertQbr(qbr: QbrRecord): Promise<QbrRecord>;

  // report config + discussion
  getReportConfig(clientId: string): Promise<ReportConfig | undefined>;
  putReportConfig(config: ReportConfig): Promise<ReportConfig>;
  getDiscussion(clientId: string, period: string): Promise<QbrDiscussion | undefined>;
  putDiscussion(discussion: QbrDiscussion): Promise<QbrDiscussion>;

  // metric snapshots (from live syncs)
  getSnapshot(clientId: string, period: string): Promise<MetricSnapshot | undefined>;
  putSnapshot(snapshot: MetricSnapshot): Promise<MetricSnapshot>;
}

/** Non-secret view of a connection for API responses. */
export interface ConnectionView extends Omit<Connection, 'secretRefs'> {
  /** field names that have a stored secret (values never leave the server). */
  secretFields: string[];
}

export function toConnectionView(conn: Connection): ConnectionView {
  const { secretRefs, ...rest } = conn;
  return { ...rest, secretFields: Object.keys(secretRefs) };
}
