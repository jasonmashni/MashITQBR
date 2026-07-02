import type { McpTransport } from '@mashit/integrations';

/**
 * McpTransport backed by a live MASH MCP server over Streamable HTTP. The SDK is
 * imported dynamically (kept external in the bundle) and typed loosely because
 * only the `callTool` shape matters here; `unwrapMcp` in @mashit/integrations
 * normalizes the `{ content: [...] }` result.
 */
export class HttpMcpTransport implements McpTransport {
  private clientPromise: Promise<{ callTool: (a: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> }> | undefined;

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const clientMod: any = await import('@modelcontextprotocol/sdk/client/index.js');
        const httpMod: any = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
        const transport = new httpMod.StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } });
        const client = new clientMod.Client({ name: 'mashit-qbr', version: '0.1.0' }, { capabilities: {} });
        await client.connect(transport);
        return client;
      })();
    }
    return this.clientPromise;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.client();
    return client.callTool({ name, arguments: args });
  }
}
