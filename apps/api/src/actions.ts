import { createHaloTicket, FetchHttpTransport, unwrapMcp, type HttpTransport } from '@mashit/integrations';
import { resolveSecret } from './connections.js';
import { directHaloConn, type Integrations } from './integrationsService.js';

export type PushTarget = 'halo_ticket' | 'halo_opportunity' | 'zomentum_opportunity';

export interface PushInput {
  target: PushTarget;
  title: string;
  detail: string;
  /** The client's id in the target system (Halo client id / Zomentum client id). */
  externalClientRef?: string;
  /** Halo ticket fields (from the push modal — all optional). */
  ticketTypeId?: string;
  agentId?: string;
  team?: string;
  priorityId?: string;
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
 * id (to persist on the action). Halo tickets go through the direct HaloPSA
 * API with full field control (type/agent/team/priority); the MASH MCP write
 * tools remain as a legacy fallback. Zomentum via its REST API.
 */
export async function pushAction(intg: Integrations, input: PushInput): Promise<PushResult> {
  const http: HttpTransport = intg.http ?? new FetchHttpTransport();

  if (input.target === 'halo_ticket' || input.target === 'halo_opportunity') {
    const halo = await directHaloConn(intg.store);
    if (halo && input.target === 'halo_ticket') {
      const cfg = {
        baseUrl: halo.config['baseUrl'] ?? '',
        clientId: halo.config['clientId'] ?? '',
        clientSecret: (await resolveSecret(intg.secrets, halo, 'clientSecret')) ?? '',
        tenant: halo.config['tenant'] || undefined,
      };
      const created = await createHaloTicket(http, cfg, {
        summary: input.title,
        details: input.detail,
        clientId: input.externalClientRef,
        ticketTypeId: input.ticketTypeId,
        agentId: input.agentId,
        team: input.team,
        priorityId: input.priorityId,
      });
      return { system: 'halo', id: created.id, status: created.status };
    }
    if (!intg.mcp) throw new Error('No Halo connection configured for Halo actions.');
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
