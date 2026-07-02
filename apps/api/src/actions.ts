import { FetchHttpTransport, unwrapMcp, type HttpTransport } from '@mashit/integrations';
import { resolveSecret } from './connections.js';
import type { Integrations } from './integrationsService.js';

export type PushTarget = 'halo_ticket' | 'halo_opportunity' | 'zomentum_opportunity';

export interface PushInput {
  target: PushTarget;
  title: string;
  detail: string;
  /** The client's id in the target system (Halo client id / Zomentum client id). */
  externalClientRef?: string;
}

export interface PushResult {
  system: 'halo' | 'zomentum';
  id: string;
  status?: string;
}

function idFrom(obj: unknown, keys: string[]): string {
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    for (const k of keys) {
      if (rec[k] !== undefined && rec[k] !== null) return String(rec[k]);
    }
  }
  return '';
}

/**
 * Push a dispositioned QBR action to the target system and return its external
 * id (to persist on the action). Halo goes through the MASH MCP write tools;
 * Zomentum via its REST API with a bearer token from the secret store.
 */
export async function pushAction(intg: Integrations, input: PushInput): Promise<PushResult> {
  const http: HttpTransport = intg.http ?? new FetchHttpTransport();

  if (input.target === 'halo_ticket' || input.target === 'halo_opportunity') {
    if (!intg.mcp) throw new Error('No MASH MCP connection configured for Halo actions.');
    const tool = input.target === 'halo_ticket' ? 'halo_create_ticket' : 'halo_create_opportunity';
    const raw = await intg.mcp.callTool(tool, {
      summary: input.title,
      details: input.detail,
      client_id: input.externalClientRef,
    });
    const obj = unwrapMcp(raw);
    return { system: 'halo', id: idFrom(obj, ['id', 'ticket_id', 'opportunity_id']), status: idFrom(obj, ['status', 'status_id']) || undefined };
  }

  // Zomentum opportunity (exact payload to be confirmed against the token-gated docs).
  const conn = (await intg.store.listConnections()).find((c) => c.type === 'zomentum');
  if (!conn) throw new Error('No Zomentum connection configured.');
  const token = (await resolveSecret(intg.secrets, conn, 'token')) ?? '';
  const base = conn.config['baseUrl'] ?? 'https://api.zomentum.com';
  const res = await http.request({
    method: 'POST',
    url: `${base}/v1/opportunities`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: input.title, description: input.detail, client_id: input.externalClientRef }),
  });
  const obj = res.json;
  return { system: 'zomentum', id: idFrom(obj, ['id', 'opportunity_id']), status: idFrom(obj, ['stage', 'stage_id']) || undefined };
}
