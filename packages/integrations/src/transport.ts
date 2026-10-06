import type { HttpRequest, HttpResponse, HttpTransport, McpTransport } from './types.js';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchHttpTransportOptions {
  /** Per-attempt timeout. A hung vendor call aborts instead of stalling the sync. Default 30000. */
  timeoutMs?: number;
  /** Extra attempts after the first on 429 (any method) or 5xx (idempotent methods only). Default 3. */
  retries?: number;
  /** Base for exponential backoff when no Retry-After header is present. Default 250. */
  backoffMs?: number;
  /** Injected fetch, for tests. Default globalThis.fetch. */
  fetchImpl?: FetchLike;
}

/** Longest we will honor a vendor's Retry-After, so one throttled call cannot eat the function's whole budget. */
const MAX_RETRY_AFTER_MS = 60_000;

/** 5xx on these is safe to repeat. A POST that 5xx'd may have been applied, so it is not retried. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After as delay-seconds or an HTTP date (RFC 9110 10.2.3). Undefined when absent or unparseable. */
function retryAfterMs(header: string | null): number | undefined {
  if (header == null || header.trim() === '') return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** HttpTransport backed by fetch, with a per-attempt timeout and 429/5xx retry. */
export class FetchHttpTransport implements HttpTransport {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: FetchHttpTransportOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = Math.max(0, opts.retries ?? 3);
    this.backoffMs = opts.backoffMs ?? 250;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const retryable = res.status === 429 || (res.status >= 500 && IDEMPOTENT.has(method));
      if (retryable && attempt < this.retries) {
        const wait = retryAfterMs(res.headers.get('Retry-After')) ?? this.backoffMs * 2 ** attempt;
        await res.body?.cancel().catch(() => undefined);
        await sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
        continue;
      }
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
