import type { McpTransport } from '@mashit/integrations';

/**
 * Auth for the MASH MCP server. Two mutually exclusive modes:
 * - OAuth client credentials (preferred): the server issues per-tool
 *   Client ID + Secret pairs and expects a JWT access token as the bearer.
 *   The SDK's ClientCredentialsProvider handles discovery (RFC 9728/8414,
 *   falling back to `<origin>/token`), the token exchange, and a one-shot
 *   retry on 401 when the token expires.
 * - Static bearer token (legacy): sent as-is on every request.
 */
export interface McpAuth {
  token?: string;
  clientId?: string;
  clientSecret?: string;
  /** Pin a nonstandard token endpoint (skips discovery). */
  tokenUrl?: string;
  /** 'basic' (RFC 8414 default) or 'post' (creds in the form body). */
  tokenAuthMethod?: 'basic' | 'post';
}

interface McpClientLike {
  callTool: (a: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * McpTransport backed by a live MASH MCP server over Streamable HTTP. The SDK
 * is imported dynamically (kept external in the bundle) and typed loosely
 * because only the `callTool` shape matters here; `unwrapMcp` in
 * @mashit/integrations normalizes the `{ content: [...] }` result.
 */
export class HttpMcpTransport implements McpTransport {
  private clientPromise: Promise<McpClientLike> | undefined;

  constructor(
    private readonly url: string,
    private readonly auth: McpAuth = {},
  ) {}

  private async buildAuthProvider(): Promise<unknown> {
    const { clientId, clientSecret, tokenUrl, tokenAuthMethod } = this.auth;
    const extMod: any = await import('@modelcontextprotocol/sdk/client/auth-extensions.js');
    const provider = new extMod.ClientCredentialsProvider({
      clientId,
      clientSecret,
      clientName: 'mashit-qbr',
    });

    // The SDK defaults to client_secret_basic; some custom token endpoints
    // only read credentials from the form body.
    if (tokenAuthMethod === 'post') {
      provider.addClientAuthentication = (_headers: Headers, params: URLSearchParams) => {
        params.set('client_id', clientId!);
        params.set('client_secret', clientSecret!);
      };
    }

    // A pinned token endpoint short-circuits discovery entirely: authInternal
    // trusts cached discovery state over network discovery.
    if (tokenUrl) {
      const origin = new URL(this.url).origin;
      provider.discoveryState = () => ({
        authorizationServerUrl: origin,
        authorizationServerMetadata: {
          issuer: origin,
          token_endpoint: tokenUrl,
          authorization_endpoint: new URL('/authorize', origin).href,
          response_types_supported: ['code'],
        },
      });
    }
    return provider;
  }

  private async client(): Promise<McpClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const clientMod: any = await import('@modelcontextprotocol/sdk/client/index.js');
        const httpMod: any = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

        let transport: unknown;
        if (this.auth.clientId && this.auth.clientSecret) {
          const provider = await this.buildAuthProvider();
          // Eager exchange: the transport only self-heals on a proper HTTP 401,
          // and custom servers don't always return one — get the token up front
          // so the first POST already carries it.
          const authMod: any = await import('@modelcontextprotocol/sdk/client/auth.js');
          try {
            await authMod.auth(provider, { serverUrl: this.url });
          } catch (e) {
            const at = this.auth.tokenUrl ?? `${new URL(this.url).origin}/token (discovered/default)`;
            throw new Error(`MCP OAuth token exchange failed (${at}): ${e instanceof Error ? e.message : String(e)}`);
          }
          // Never combine with static Authorization headers — requestInit
          // headers would silently override the provider's Bearer token.
          transport = new httpMod.StreamableHTTPClientTransport(new URL(this.url), { authProvider: provider });
        } else {
          const headers = this.auth.token ? { Authorization: `Bearer ${this.auth.token}` } : {};
          transport = new httpMod.StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } });
        }

        const client = new clientMod.Client({ name: 'mashit-qbr', version: '0.1.0' }, { capabilities: {} });
        await client.connect(transport);
        return client as McpClientLike;
      })();
      // A failed connect must not poison the memo forever.
      this.clientPromise.catch(() => {
        this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.client();
    return client.callTool({ name, arguments: args });
  }
}

// ── Transport memoization ─────────────────────────────────────────────────────
// resolveMcp() runs per API request; without a memo every request would redo
// the OAuth exchange. Key on connection id + updatedAt so edits/rotations
// invalidate naturally.
const transportCache = new Map<string, HttpMcpTransport>();

export function memoizedMcpTransport(key: string, make: () => HttpMcpTransport): HttpMcpTransport {
  let t = transportCache.get(key);
  if (!t) {
    // Drop stale entries for the same connection id (different updatedAt).
    const connId = key.split('@')[0]!;
    for (const k of transportCache.keys()) {
      if (k.startsWith(`${connId}@`)) transportCache.delete(k);
    }
    t = make();
    transportCache.set(key, t);
  }
  return t;
}
