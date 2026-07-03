import type {
  Client,
  IntegrationId,
  MetricSnapshot,
  QbrDiscussion,
  QbrStatus,
  ReportConfig,
} from '@mashit/core';
import type { NarrativeResult } from '@mashit/narrative';

/** Kind of integration a connection represents. */
export type ConnectionType = IntegrationId | 'mcp' | 'zomentum';

/** Runtime list of valid connection types (drives API validation). */
export const CONNECTION_TYPES = [
  'halo',
  'ninja',
  'hudu',
  'huntress',
  'checkpoint',
  'cipp',
  'domotz',
  'dropsuite',
  'printix',
  'connectsecure',
  'synology',
  'manual',
  'mcp',
  'zomentum',
] as const satisfies readonly ConnectionType[];

export function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === 'string' && (CONNECTION_TYPES as readonly string[]).includes(value);
}

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
  meeting?: { scheduledAt?: string; joinUrl?: string; heldAt?: string; attendees?: string[]; eventId?: string };
  updatedAt: string;
}

/** Human edits overlaid on the generated narrative (undefined field = keep AI text). */
export interface NarrativeEdits {
  headline?: string;
  summary_paragraphs?: string[];
  highlights?: string[];
  recommendations?: string[];
  editedBy: string;
  editedAt: string;
}

/**
 * The narrative state for a client/period: a cached AI result (fingerprinted
 * by `inputHash` — any data re-sync or model change invalidates it) and/or
 * the author's manual edits, which take precedence in the report.
 */
export interface NarrativeRecord {
  clientId: string;
  period: string;
  inputHash?: string;
  result?: NarrativeResult;
  edits?: NarrativeEdits;
  updatedAt: string;
}

/** One compliance audit entry (who did what to what, when). */
export interface AuditEvent {
  id: string;
  /** ISO-8601 timestamp. */
  at: string;
  /** Signed-in user (email/name) or 'system'. */
  actor: string;
  /** Dotted verb, e.g. `integration.save`, `qbr.sync`, `action.push`. */
  action: string;
  /** What it acted on, e.g. `client:anp`, `integration:huntress/abc`. */
  target: string;
  detail?: string;
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

  // cached AI narratives
  getNarrative(clientId: string, period: string): Promise<NarrativeRecord | undefined>;
  putNarrative(record: NarrativeRecord): Promise<NarrativeRecord>;

  // compliance audit trail
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(limit: number): Promise<AuditEvent[]>;
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
