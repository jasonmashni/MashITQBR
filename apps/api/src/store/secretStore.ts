import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Stores integration secrets. Values never appear in DataStore records. */
export interface SecretStore {
  set(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | undefined>;
  delete(name: string): Promise<void>;
}

/** Local dev secret store — a gitignored JSON file. NOT for production. */
export class LocalSecretStore implements SecretStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? process.env['QBR_DATA_DIR'] ?? resolve(process.cwd(), '.data');
    this.file = resolve(this.dir, 'secrets.json');
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  private write(s: Record<string, string>): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(s, null, 2), 'utf8');
  }

  async set(name: string, value: string): Promise<void> {
    const s = this.read();
    s[name] = value;
    this.write(s);
  }
  async get(name: string): Promise<string | undefined> {
    return this.read()[name];
  }
  async delete(name: string): Promise<void> {
    const s = this.read();
    delete s[name];
    this.write(s);
  }
}

/**
 * Azure Key Vault secret store. Uses the Function App's managed identity
 * (DefaultAzureCredential) — the identity needs **Key Vault Secrets Officer**
 * to write. Imported lazily so local dev needn't install the Azure SDKs at
 * build time (they stay external in the bundle).
 */
export class KeyVaultSecretStore implements SecretStore {
  private clientPromise: Promise<import('@azure/keyvault-secrets').SecretClient> | undefined;

  constructor(private readonly vaultUrl: string) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SecretClient } = await import('@azure/keyvault-secrets');
        const { DefaultAzureCredential } = await import('@azure/identity');
        return new SecretClient(this.vaultUrl, new DefaultAzureCredential());
      })();
    }
    return this.clientPromise;
  }

  async set(name: string, value: string): Promise<void> {
    const c = await this.client();
    await c.setSecret(name, value);
  }
  async get(name: string): Promise<string | undefined> {
    const c = await this.client();
    try {
      const s = await c.getSecret(name);
      return s.value;
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) return undefined;
      throw err;
    }
  }
  async delete(name: string): Promise<void> {
    const c = await this.client();
    try {
      const poller = await c.beginDeleteSecret(name);
      await poller.pollUntilDone();
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 404) throw err;
    }
  }
}
