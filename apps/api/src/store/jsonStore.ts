import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client, MetricSnapshot, QbrDiscussion, ReportConfig } from '@mashit/core';
import type { AuditEvent, ClientConnectionMap, Connection, DataStore, DocumentRecord, NarrativeRecord, QbrRecord } from './types.js';

interface JsonShape {
  clients: Record<string, Client>;
  connections: Record<string, Connection>;
  maps: Record<string, ClientConnectionMap[]>;
  qbrs: Record<string, QbrRecord>;
  configs: Record<string, ReportConfig>;
  discussions: Record<string, QbrDiscussion>;
  snapshots: Record<string, MetricSnapshot>;
  narratives: Record<string, NarrativeRecord>;
  /** Attached document metadata, keyed clientId:period. */
  documents: Record<string, DocumentRecord[]>;
  /** Newest first, capped locally. */
  audit: AuditEvent[];
}

const EMPTY: JsonShape = { clients: {}, connections: {}, maps: {}, qbrs: {}, configs: {}, discussions: {}, snapshots: {}, narratives: {}, documents: {}, audit: [] };
const pk = (a: string, b: string) => `${a}:${b}`;

/** File-backed DataStore for local development. */
export class JsonDataStore implements DataStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? process.env['QBR_DATA_DIR'] ?? resolve(process.cwd(), '.data');
    this.file = resolve(this.dir, 'store.json');
  }

  private read(): JsonShape {
    if (!existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<JsonShape>;
      return { ...structuredClone(EMPTY), ...parsed };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private write(s: JsonShape): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(s, null, 2), 'utf8');
  }

  async listClients(): Promise<Client[]> {
    return Object.values(this.read().clients);
  }
  async getClient(id: string): Promise<Client | undefined> {
    return this.read().clients[id];
  }
  async upsertClient(client: Client): Promise<Client> {
    const s = this.read();
    s.clients[client.id] = client;
    this.write(s);
    return client;
  }

  async listConnections(): Promise<Connection[]> {
    return Object.values(this.read().connections);
  }
  async getConnection(id: string): Promise<Connection | undefined> {
    return this.read().connections[id];
  }
  async upsertConnection(conn: Connection): Promise<Connection> {
    const s = this.read();
    s.connections[conn.id] = conn;
    this.write(s);
    return conn;
  }
  async deleteConnection(id: string): Promise<void> {
    const s = this.read();
    delete s.connections[id];
    this.write(s);
  }

  async listClientConnections(clientId: string): Promise<ClientConnectionMap[]> {
    return this.read().maps[clientId] ?? [];
  }
  async putClientConnections(clientId: string, maps: ClientConnectionMap[]): Promise<void> {
    const s = this.read();
    s.maps[clientId] = maps;
    this.write(s);
  }

  async getQbr(clientId: string, period: string): Promise<QbrRecord | undefined> {
    return this.read().qbrs[pk(clientId, period)];
  }
  async upsertQbr(qbr: QbrRecord): Promise<QbrRecord> {
    const s = this.read();
    s.qbrs[pk(qbr.clientId, qbr.period)] = qbr;
    this.write(s);
    return qbr;
  }

  async getReportConfig(clientId: string): Promise<ReportConfig | undefined> {
    return this.read().configs[clientId];
  }
  async putReportConfig(config: ReportConfig): Promise<ReportConfig> {
    const s = this.read();
    s.configs[config.clientId] = config;
    this.write(s);
    return config;
  }

  async getDiscussion(clientId: string, period: string): Promise<QbrDiscussion | undefined> {
    return this.read().discussions[pk(clientId, period)];
  }
  async putDiscussion(discussion: QbrDiscussion): Promise<QbrDiscussion> {
    const s = this.read();
    s.discussions[pk(discussion.clientId, discussion.period)] = discussion;
    this.write(s);
    return discussion;
  }

  async getSnapshot(clientId: string, period: string): Promise<MetricSnapshot | undefined> {
    return this.read().snapshots[pk(clientId, period)];
  }
  async putSnapshot(snapshot: MetricSnapshot): Promise<MetricSnapshot> {
    const s = this.read();
    s.snapshots[pk(snapshot.clientId, snapshot.period)] = snapshot;
    this.write(s);
    return snapshot;
  }

  async getNarrative(clientId: string, period: string): Promise<NarrativeRecord | undefined> {
    return this.read().narratives[pk(clientId, period)];
  }
  async putNarrative(record: NarrativeRecord): Promise<NarrativeRecord> {
    const s = this.read();
    s.narratives[pk(record.clientId, record.period)] = record;
    this.write(s);
    return record;
  }

  async listDocuments(clientId: string, period: string): Promise<DocumentRecord[]> {
    return this.read().documents[pk(clientId, period)] ?? [];
  }
  async getDocument(clientId: string, period: string, id: string): Promise<DocumentRecord | undefined> {
    return (await this.listDocuments(clientId, period)).find((d) => d.id === id);
  }
  async putDocument(record: DocumentRecord): Promise<DocumentRecord> {
    const s = this.read();
    const key = pk(record.clientId, record.period);
    const rest = (s.documents[key] ?? []).filter((d) => d.id !== record.id);
    s.documents[key] = [...rest, record];
    this.write(s);
    return record;
  }
  async deleteDocument(clientId: string, period: string, id: string): Promise<void> {
    const s = this.read();
    const key = pk(clientId, period);
    s.documents[key] = (s.documents[key] ?? []).filter((d) => d.id !== id);
    this.write(s);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    const s = this.read();
    s.audit.unshift(event);
    if (s.audit.length > 1000) s.audit.length = 1000;
    this.write(s);
  }
  async listAudit(limit: number): Promise<AuditEvent[]> {
    return this.read().audit.slice(0, limit);
  }
}
