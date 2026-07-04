import { TableClient, odata, type TableEntity } from '@azure/data-tables';
import type { Client, MetricSnapshot, QbrDiscussion, ReportConfig } from '@mashit/core';
import type { AuditEvent, ClientConnectionMap, Connection, DataStore, DocumentRecord, NarrativeRecord, OpportunityRecord, QbrRecord } from './types.js';

const TABLES = {
  clients: 'qbrClients',
  connections: 'qbrConnections',
  maps: 'qbrMaps',
  qbrs: 'qbrQbrs',
  configs: 'qbrConfigs',
  discussions: 'qbrDiscussions',
  snapshots: 'qbrSnapshots',
  narratives: 'qbrNarratives',
  documents: 'qbrDocuments',
  opportunities: 'qbrOpportunities',
  audit: 'qbrAudit',
} as const;

interface Row extends TableEntity {
  data: string; // JSON-serialized entity
}

/** DataStore backed by Azure Table Storage (one table per entity kind). */
export class TableDataStore implements DataStore {
  private readonly clients: Record<string, TableClient> = {};

  constructor(private readonly connectionString: string) {}

  private table(name: string): TableClient {
    let client = this.clients[name];
    if (!client) {
      client = TableClient.fromConnectionString(this.connectionString, name, { allowInsecureConnection: true });
      this.clients[name] = client;
    }
    return client;
  }

  private async put<T>(name: string, partitionKey: string, rowKey: string, value: T): Promise<T> {
    const table = this.table(name);
    await ensureTable(table);
    const entity: Row = { partitionKey, rowKey, data: JSON.stringify(value) };
    await table.upsertEntity(entity, 'Replace');
    return value;
  }

  private async get<T>(name: string, partitionKey: string, rowKey: string): Promise<T | undefined> {
    try {
      const row = await this.table(name).getEntity<Row>(partitionKey, rowKey);
      return JSON.parse(row.data) as T;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async list<T>(name: string, partitionKey?: string): Promise<T[]> {
    const table = this.table(name);
    await ensureTable(table);
    const filter = partitionKey ? odata`PartitionKey eq ${partitionKey}` : undefined;
    const out: T[] = [];
    for await (const row of table.listEntities<Row>({ queryOptions: filter ? { filter } : undefined })) {
      if (typeof row.data === 'string') out.push(JSON.parse(row.data) as T);
    }
    return out;
  }

  // clients
  listClients = () => this.list<Client>(TABLES.clients, 'client');
  getClient = (id: string) => this.get<Client>(TABLES.clients, 'client', id);
  upsertClient = (c: Client) => this.put(TABLES.clients, 'client', c.id, c);

  // connections
  listConnections = () => this.list<Connection>(TABLES.connections, 'conn');
  getConnection = (id: string) => this.get<Connection>(TABLES.connections, 'conn', id);
  upsertConnection = (c: Connection) => this.put(TABLES.connections, 'conn', c.id, c);
  async deleteConnection(id: string): Promise<void> {
    try {
      await this.table(TABLES.connections).deleteEntity('conn', id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // mappings
  listClientConnections = (clientId: string) => this.list<ClientConnectionMap>(TABLES.maps, clientId);
  async putClientConnections(clientId: string, maps: ClientConnectionMap[]): Promise<void> {
    const table = this.table(TABLES.maps);
    await ensureTable(table);
    // Replace the client's set: delete existing, then write the new maps.
    for await (const row of table.listEntities<Row>({ queryOptions: { filter: odata`PartitionKey eq ${clientId}` } })) {
      await table.deleteEntity(clientId, row.rowKey as string);
    }
    for (const m of maps) await this.put(TABLES.maps, clientId, m.connectionId, m);
  }

  // qbr lifecycle
  getQbr = (clientId: string, period: string) => this.get<QbrRecord>(TABLES.qbrs, clientId, period);
  upsertQbr = (q: QbrRecord) => this.put(TABLES.qbrs, q.clientId, q.period, q);

  // config + discussion
  getReportConfig = (clientId: string) => this.get<ReportConfig>(TABLES.configs, 'config', clientId);
  putReportConfig = (c: ReportConfig) => this.put(TABLES.configs, 'config', c.clientId, c);
  getDiscussion = (clientId: string, period: string) => this.get<QbrDiscussion>(TABLES.discussions, clientId, period);
  putDiscussion = (d: QbrDiscussion) => this.put(TABLES.discussions, d.clientId, d.period, d);

  // snapshots
  getSnapshot = (clientId: string, period: string) => this.get<MetricSnapshot>(TABLES.snapshots, clientId, period);
  putSnapshot = (s: MetricSnapshot) => this.put(TABLES.snapshots, s.clientId, s.period, s);

  // cached AI narratives
  getNarrative = (clientId: string, period: string) => this.get<NarrativeRecord>(TABLES.narratives, clientId, period);
  putNarrative = (n: NarrativeRecord) => this.put(TABLES.narratives, n.clientId, n.period, n);

  // attached documents — partition per client:period so a QBR's set is one range read
  listDocuments = (clientId: string, period: string) => this.list<DocumentRecord>(TABLES.documents, `${clientId}:${period}`);
  // All quarters for one client: partition keys are `${clientId}:${period}`,
  // so a [clientId: , clientId;) range scan covers exactly this client
  // (':' sorts immediately before ';').
  async listClientDocuments(clientId: string): Promise<DocumentRecord[]> {
    const table = this.table(TABLES.documents);
    await ensureTable(table);
    const lo = `${clientId}:`;
    const hi = `${clientId};`;
    const out: DocumentRecord[] = [];
    for await (const row of table.listEntities<Row>({ queryOptions: { filter: odata`PartitionKey ge ${lo} and PartitionKey lt ${hi}` } })) {
      if (typeof row.data === 'string') out.push(JSON.parse(row.data) as DocumentRecord);
    }
    return out;
  }
  getDocument = (clientId: string, period: string, id: string) => this.get<DocumentRecord>(TABLES.documents, `${clientId}:${period}`, id);
  putDocument = (d: DocumentRecord) => this.put(TABLES.documents, `${d.clientId}:${d.period}`, d.id, d);
  async deleteDocument(clientId: string, period: string, id: string): Promise<void> {
    try {
      await this.table(TABLES.documents).deleteEntity(`${clientId}:${period}`, id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // opportunity board — partition per client so its board is one range read
  listOpportunities = (clientId: string) => this.list<OpportunityRecord>(TABLES.opportunities, clientId);
  putOpportunity = (o: OpportunityRecord) => this.put(TABLES.opportunities, o.clientId, o.id, o);
  async deleteOpportunity(clientId: string, id: string): Promise<void> {
    try {
      await this.table(TABLES.opportunities).deleteEntity(clientId, id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // compliance audit trail — a fixed partition with descending-time rowKeys
  // makes "latest N" a single-partition, single-page range read.
  async appendAudit(event: AuditEvent): Promise<void> {
    const rowKey = `${String(9999999999999 - Date.parse(event.at)).padStart(13, '0')}-${event.id}`;
    await this.put(TABLES.audit, 'audit', rowKey, event);
  }
  async listAudit(limit: number): Promise<AuditEvent[]> {
    const table = this.table(TABLES.audit);
    await ensureTable(table);
    const out: AuditEvent[] = [];
    const pages = table
      .listEntities<Row>({ queryOptions: { filter: odata`PartitionKey eq ${'audit'}` } })
      .byPage({ maxPageSize: limit });
    for await (const page of pages) {
      for (const row of page) {
        if (typeof row.data === 'string') out.push(JSON.parse(row.data) as AuditEvent);
      }
      break; // newest-first keys mean the first page IS the latest N
    }
    return out;
  }
}

const ensured = new Set<string>();
async function ensureTable(table: TableClient): Promise<void> {
  const name = table.tableName;
  if (ensured.has(name)) return;
  try {
    await table.createTable();
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  ensured.add(name);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404;
}
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { statusCode?: number; code?: string })?.statusCode;
  return code === 409 || (err as { code?: string })?.code === 'TableAlreadyExists';
}
