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
  'googleworkspace',
  'defensx',
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
  /** When the QBR package (email draft with the PDF) was last generated. */
  packageSentAt?: string;
  /** When the "time to schedule" reminder fired — so it fires at most once. */
  dueRemindedAt?: string;
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

/**
 * Metadata for a vendor report / uploaded document attached to a QBR.
 * The file bytes live in the document content store (Blob Storage in Azure,
 * local files in dev); this record is the register the UI and report read.
 */
export interface DocumentRecord {
  id: string;
  clientId: string;
  period: string;
  /** Display file name (also the download name). */
  name: string;
  /** Where it came from: 'upload', 'email', or the vendor integration id. */
  source: string;
  /**
   * Stable identity for sync-attached vendor reports (e.g. `summary:2026-Q2`).
   * Re-syncs match on source+sourceKey so the same report is updated in place
   * even after the user renames it — renames used to cause duplicates.
   */
  sourceKey?: string;
  /** User-assigned bucket on the Reports tab (Security, Backup, Endpoint…). */
  category?: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  uploadedBy: string;
}

/** Kanban columns for client opportunities/initiatives surfaced in QBRs. */
export const OPPORTUNITY_STATUSES = ['idea', 'discussing', 'approved', 'pushed', 'closed'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * A per-client opportunity / future initiative — "client mentioned a new
 * location", "server refresh next year" — flagged during a QBR (or added
 * directly) and tracked on the client's board across quarters until it's
 * pushed to Halo as an opportunity/ticket or closed.
 */
export interface OpportunityRecord {
  id: string;
  clientId: string;
  title: string;
  detail?: string;
  status: OpportunityStatus;
  /** Who's driving it (free text — usually a Mash IT agent). */
  owner?: string;
  /** Estimated deal value in whole currency units (e.g. 12000 for $12k). Internal only — never rendered in the client-facing report. */
  value?: number;
  /** Whether `value` is monthly recurring revenue or a one-time amount. Drives how the roadmap total is summarised. */
  valueKind?: 'recurring' | 'one_time';
  /** The QBR quarter it came out of (e.g. "2026-Q2"), when flagged from one. */
  sourcePeriod?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  /** Set once pushed to Halo: the created opportunity/ticket id. */
  externalRef?: string;
  externalKind?: 'halo_ticket' | 'halo_opportunity' | 'zomentum_opportunity';
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
 * One client-facing scheduling link for a QBR. The token is the whole
 * authorization for the public booking page — unguessable, single-purpose.
 */
export interface BookingRecord {
  /** URL token (also the record id). */
  token: string;
  clientId: string;
  period: string;
  status: 'open' | 'booked' | 'cancelled';
  createdAt: string;
  createdBy: string;
  /** Set when booked: local wall-clock start/end + the timezone they're in. */
  start?: string;
  end?: string;
  timezone?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  extraAttendees?: string[];
  notes?: string;
  /** Graph event id + Teams link when the invite was created automatically. */
  eventId?: string;
  joinUrl?: string;
  bookedAt?: string;
}

/** An in-portal notification (bell menu): new report, booking, QBR due… */
export interface NotificationRecord {
  id: string;
  at: string;
  /** e.g. `report`, `booking`, `qbr_due` — drives the icon. */
  kind: string;
  title: string;
  body?: string;
  clientId?: string;
  period?: string;
  read: boolean;
  /** Optional stable key so recurring checks don't re-notify (kind:client:period). */
  dedupeKey?: string;
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

  // attached documents (metadata; bytes live in the document content store)
  listDocuments(clientId: string, period: string): Promise<DocumentRecord[]>;
  /** All of a client's documents across every quarter (the Reports tab). */
  listClientDocuments(clientId: string): Promise<DocumentRecord[]>;
  getDocument(clientId: string, period: string, id: string): Promise<DocumentRecord | undefined>;
  putDocument(record: DocumentRecord): Promise<DocumentRecord>;
  deleteDocument(clientId: string, period: string, id: string): Promise<void>;

  // opportunity board (per client, cross-quarter)
  listOpportunities(clientId: string): Promise<OpportunityRecord[]>;
  putOpportunity(record: OpportunityRecord): Promise<OpportunityRecord>;
  deleteOpportunity(clientId: string, id: string): Promise<void>;

  // compliance audit trail
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(limit: number): Promise<AuditEvent[]>;

  // client-facing booking links
  getBooking(token: string): Promise<BookingRecord | undefined>;
  putBooking(record: BookingRecord): Promise<BookingRecord>;
  /** The newest booking for a client/period (any status), if one exists. */
  findBooking(clientId: string, period: string): Promise<BookingRecord | undefined>;

  // in-portal notifications (newest first)
  appendNotification(record: NotificationRecord): Promise<void>;
  listNotifications(limit: number): Promise<NotificationRecord[]>;
  markNotificationsRead(ids: string[] | 'all'): Promise<void>;
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
