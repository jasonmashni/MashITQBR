import type { HttpRequest, HttpResponse, HttpTransport, McpTransport } from './types.js';

/** HttpTransport backed by the global fetch (Node 20+/browser). */
export class FetchHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    let json: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }
}

/**
 * Wrap a plain async function as an McpTransport. The API app supplies a
 * function that proxies to the connected MASH MCP client; tests supply a fake.
 */
export function functionMcpTransport(
  fn: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): McpTransport {
  return { callTool: fn };
}

/** Basic-auth header value for Huntress (base64 of `key:secret`). */
export function basicAuthHeader(key: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}
