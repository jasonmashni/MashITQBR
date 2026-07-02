import type { Connection, ConnectionType, DataStore, SecretStore } from './store/index.js';

const nowIso = () => new Date().toISOString();
const genId = () => Math.random().toString(36).slice(2, 10);

export interface ConnectionInput {
  id?: string;
  type: ConnectionType;
  label: string;
  /** Non-secret settings (baseUrl, region, orgId, …). */
  config?: Record<string, string>;
  /** Secret field values from the portal (field -> value). Blank = leave unchanged. */
  secrets?: Record<string, string>;
}

/**
 * Create or update a connection. Secret field values are written to the secret
 * store (Key Vault in Azure) and only their references are kept on the record —
 * a Connection never carries a secret value.
 */
export async function saveConnection(store: DataStore, secrets: SecretStore, input: ConnectionInput): Promise<Connection> {
  const id = input.id ?? genId();
  const existing = input.id ? await store.getConnection(id) : undefined;
  const secretRefs: Record<string, string> = { ...(existing?.secretRefs ?? {}) };

  for (const [field, value] of Object.entries(input.secrets ?? {})) {
    if (value === undefined || value === '') continue; // blank keeps the existing secret
    const name = `conn-${id}--${field}`;
    await secrets.set(name, value);
    secretRefs[field] = name;
  }

  const conn: Connection = {
    id,
    type: input.type,
    label: input.label,
    config: input.config ?? existing?.config ?? {},
    secretRefs,
    status: existing?.status ?? 'unknown',
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  return store.upsertConnection(conn);
}

/** Resolve a connection's secret field value from the secret store. */
export async function resolveSecret(secrets: SecretStore, conn: Connection, field: string): Promise<string | undefined> {
  const ref = conn.secretRefs[field];
  return ref ? secrets.get(ref) : undefined;
}

/** Delete a connection and purge its secrets. */
export async function removeConnection(store: DataStore, secrets: SecretStore, id: string): Promise<void> {
  const conn = await store.getConnection(id);
  if (conn) {
    for (const ref of Object.values(conn.secretRefs)) await secrets.delete(ref);
  }
  await store.deleteConnection(id);
}
