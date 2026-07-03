import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Content storage for attached QBR documents (vendor report PDFs, uploads).
 * Bytes live here; metadata lives on the DataStore's DocumentRecord. In Azure
 * this is Blob Storage on the Function App's existing AzureWebJobsStorage
 * account (container auto-created — no portal steps); locally it's files
 * under the data dir.
 */
export interface DocContentStore {
  put(path: string, bytes: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<Buffer | undefined>;
  delete(path: string): Promise<void>;
}

/** Stable blob/file path for a document (name segment sanitized, no traversal). */
export function docPath(clientId: string, period: string, id: string, name: string): string {
  const safe = name
    .replace(/[^a-zA-Z0-9._ ()-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 120);
  return `${clientId}/${period}/${id}-${safe}`;
}

/** Local file implementation for dev (mirrors the blob layout). */
export class LocalDocStore implements DocContentStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolve(process.env['QBR_DATA_DIR'] ?? resolve(process.cwd(), '.data'), 'documents');
  }

  private fileFor(path: string): string {
    const full = resolve(this.dir, path);
    // Sanity: the resolved file must stay inside the documents dir.
    if (!full.startsWith(resolve(this.dir))) throw new Error('Invalid document path');
    return full;
  }

  async put(path: string, bytes: Buffer, _contentType?: string): Promise<void> {
    const file = this.fileFor(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  async get(path: string): Promise<Buffer | undefined> {
    const file = this.fileFor(path);
    return existsSync(file) ? readFileSync(file) : undefined;
  }
  async delete(path: string): Promise<void> {
    rmSync(this.fileFor(path), { force: true });
  }
}

/**
 * Blob Storage implementation. The container is created on first use, so no
 * portal setup is needed beyond the storage account the Function App already
 * has. @azure/storage-blob is imported lazily (it's a server-only dependency).
 */
export class BlobDocStore implements DocContentStore {
  private containerClient: Promise<{
    getBlockBlobClient(name: string): {
      uploadData(data: Buffer, o?: unknown): Promise<unknown>;
      downloadToBuffer(): Promise<Buffer>;
      deleteIfExists(): Promise<unknown>;
      exists(): Promise<boolean>;
    };
  }>;

  constructor(connectionString: string, containerName = process.env['QBR_DOCS_CONTAINER'] || 'qbr-documents') {
    this.containerClient = (async () => {
      const { BlobServiceClient } = await import('@azure/storage-blob');
      const service = BlobServiceClient.fromConnectionString(connectionString);
      const container = service.getContainerClient(containerName);
      await container.createIfNotExists();
      return container;
    })();
  }

  async put(path: string, bytes: Buffer, contentType: string): Promise<void> {
    const container = await this.containerClient;
    await container.getBlockBlobClient(path).uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
  }
  async get(path: string): Promise<Buffer | undefined> {
    const container = await this.containerClient;
    const blob = container.getBlockBlobClient(path);
    if (!(await blob.exists())) return undefined;
    return blob.downloadToBuffer();
  }
  async delete(path: string): Promise<void> {
    const container = await this.containerClient;
    await container.getBlockBlobClient(path).deleteIfExists();
  }
}

let _docs: DocContentStore | undefined;
let _docsKind: 'blob' | 'local' = 'local';

/** Blob Storage when AzureWebJobsStorage is configured, else local files. */
export function getDocStore(): DocContentStore {
  if (!_docs) {
    const conn = process.env['AzureWebJobsStorage'];
    if (conn && conn.trim() !== '') {
      _docsKind = 'blob';
      _docs = new BlobDocStore(conn);
    } else {
      _docsKind = 'local';
      _docs = new LocalDocStore();
    }
  }
  return _docs;
}

export function docStoreKind(): 'blob' | 'local' {
  getDocStore();
  return _docsKind;
}
