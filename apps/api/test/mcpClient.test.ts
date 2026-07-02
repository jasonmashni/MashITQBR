import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpMcpTransport, memoizedMcpTransport } from '../src/mcpClient.js';

/**
 * A minimal fake of the MASH MCP server: a /token endpoint issuing a made-up
 * JWT and an /mcp endpoint that records the Authorization header. It is not a
 * real MCP server — connect/callTool will fail after the auth phase — but the
 * captured requests prove the transport's auth behavior.
 */
interface Captured {
  tokenBodies: string[];
  tokenPaths: string[];
  tokenAuthHeaders: Array<string | undefined>;
  mcpAuthHeaders: Array<string | undefined>;
  wellKnownHits: string[];
}

let server: Server;
let base = '';
const cap: Captured = { tokenBodies: [], tokenPaths: [], tokenAuthHeaders: [], mcpAuthHeaders: [], wellKnownHits: [] };
let issueTokens = true;

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  if (url.startsWith('/.well-known/')) {
    cap.wellKnownHits.push(url);
    res.writeHead(404).end();
    return;
  }
  if ((url === '/token' || url === '/custom/token-endpoint') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      cap.tokenBodies.push(body);
      cap.tokenPaths.push(url);
      cap.tokenAuthHeaders.push(req.headers.authorization);
      if (!issueTokens) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'jwt.abc.def', token_type: 'Bearer', expires_in: 3600 }));
    });
    return;
  }
  if (url === '/mcp') {
    cap.mcpAuthHeaders.push(req.headers.authorization);
    // Not a real MCP response — the client will fail after this, by design.
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fake server' }));
    return;
  }
  res.writeHead(404).end();
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('HttpMcpTransport auth', () => {
  it('static token mode sends the token as-is (no token exchange)', async () => {
    cap.mcpAuthHeaders.length = cap.tokenBodies.length = 0;
    const t = new HttpMcpTransport(`${base}/mcp`, { token: 'static-legacy' });
    await expect(t.callTool('x', {})).rejects.toThrow();
    expect(cap.tokenBodies).toHaveLength(0);
    expect(cap.mcpAuthHeaders[0]).toBe('Bearer static-legacy');
  });

  it('client-credentials mode discovers, falls back to /token, and sends the JWT', async () => {
    cap.mcpAuthHeaders.length = cap.tokenBodies.length = cap.tokenAuthHeaders.length = cap.wellKnownHits.length = 0;
    issueTokens = true;
    const t = new HttpMcpTransport(`${base}/mcp`, { clientId: 'mcp-qbr', clientSecret: 's3cret' });
    await expect(t.callTool('x', {})).rejects.toThrow(); // fake /mcp is not a real MCP server
    expect(cap.wellKnownHits.length).toBeGreaterThan(0); // discovery attempted
    expect(cap.tokenBodies.length).toBeGreaterThan(0); // exchange happened (eager)
    expect(cap.tokenBodies[0]).toContain('grant_type=client_credentials');
    // SDK default client auth is client_secret_basic.
    expect(cap.tokenAuthHeaders[0]).toBe(`Basic ${Buffer.from('mcp-qbr:s3cret').toString('base64')}`);
    expect(cap.mcpAuthHeaders[0]).toBe('Bearer jwt.abc.def');
  });

  it("tokenAuthMethod 'post' puts credentials in the form body", async () => {
    cap.tokenBodies.length = cap.tokenAuthHeaders.length = 0;
    issueTokens = true;
    const t = new HttpMcpTransport(`${base}/mcp`, {
      clientId: 'mcp-qbr',
      clientSecret: 's3cret',
      tokenUrl: `${base}/token`,
      tokenAuthMethod: 'post',
    });
    await expect(t.callTool('x', {})).rejects.toThrow();
    const body = cap.tokenBodies[0] ?? '';
    expect(body).toContain('client_id=mcp-qbr');
    expect(body).toContain('client_secret=s3cret');
    expect(cap.tokenAuthHeaders[0]).toBeUndefined();
  });

  it('pinned tokenUrl is used verbatim and AS discovery is skipped', async () => {
    cap.wellKnownHits.length = cap.tokenPaths.length = 0;
    const t = new HttpMcpTransport(`${base}/mcp`, {
      clientId: 'mcp-qbr',
      clientSecret: 's3cret',
      tokenUrl: `${base}/custom/token-endpoint`,
    });
    await expect(t.callTool('x', {})).rejects.toThrow();
    expect(cap.tokenPaths).toContain('/custom/token-endpoint');
    // The SDK may still probe RFC 9728 resource metadata (harmless 404), but
    // must not need authorization-server metadata discovery.
    expect(cap.wellKnownHits.some((h) => h.includes('oauth-authorization-server') || h.includes('openid-configuration'))).toBe(false);
  });

  it('surfaces a descriptive error when the token exchange fails', async () => {
    issueTokens = false;
    const t = new HttpMcpTransport(`${base}/mcp`, {
      clientId: 'mcp-qbr',
      clientSecret: 'bad',
      tokenUrl: `${base}/token`,
    });
    await expect(t.callTool('x', {})).rejects.toThrow(/MCP OAuth token exchange failed/);
    issueTokens = true;
  });
});

describe('memoizedMcpTransport', () => {
  it('returns the same instance for the same key and evicts on version change', () => {
    const a = memoizedMcpTransport('conn1@v1', () => new HttpMcpTransport('http://x/mcp', {}));
    const b = memoizedMcpTransport('conn1@v1', () => new HttpMcpTransport('http://x/mcp', {}));
    expect(b).toBe(a);
    const c = memoizedMcpTransport('conn1@v2', () => new HttpMcpTransport('http://x/mcp', {}));
    expect(c).not.toBe(a);
  });
});
