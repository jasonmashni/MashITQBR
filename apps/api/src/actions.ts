import {
  createHaloOpportunity,
  createHaloTicket,
  FetchHttpTransport,
  haloTicketUsable,
  unwrapMcp,
  type HaloCfg,
  type HttpTransport,
} from '@mashit/integrations';
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
  /** Halo ticket to file a pushed ticket under (the quarter's QBR ticket). */
  parentTicketId?: string;
  /** Opportunity value, carried to Halo opportunities. */
  value?: number;
  valueKind?: 'recurring' | 'one_time';
}

export interface PushResult {
  system: 'halo' | 'zomentum';
  id: string;
  status?: string;
  /** The QBR ticket a pushed Halo ticket was filed under. */
  parentId?: string;
}

/** Direct HaloPSA credentials, or undefined when only the legacy MCP path exists. */
async function directHaloCfg(intg: Integrations): Promise<HaloCfg | undefined> {
  const halo = await directHaloConn(intg.store);
  if (!halo) return undefined;
  return {
    baseUrl: halo.config['baseUrl'] ?? '',
    clientId: halo.config['clientId'] ?? '',
    clientSecret: (await resolveSecret(intg.secrets, halo, 'clientSecret')) ?? '',
    tenant: halo.config['tenant'] || undefined,
  };
}

export interface QbrParentInput {
  /** The id stored for this quarter, if one was created before. */
  existingId?: string;
  clientName: string;
  periodLabel: string;
  externalClientRef?: string;
  /** Routing for a new parent, taken from the first ticket pushed under it. */
  ticketTypeId?: string;
  agentId?: string;
  team?: string;
}

// One parent per client and quarter even when two pushes race in this worker:
// pushes queue per key, and a queued push sees the id the one before it made.
const parentQueue = new Map<string, Promise<unknown>>();
const parentMade = new Map<string, string>();

/**
 * The quarter's QBR ticket in Halo, which every ticket pushed from that QBR is
 * filed under. Reuses the stored id while Halo still has it, otherwise creates
 * "QBR - {client} - {quarter}". Undefined when only the legacy MCP path is
 * configured, since it cannot set a parent.
 */
export async function ensureQbrParentTicket(intg: Integrations, input: QbrParentInput): Promise<{ id: string; created: boolean } | undefined> {
  const cfg = await directHaloCfg(intg);
  if (!cfg) return undefined;
  const http: HttpTransport = intg.http ?? new FetchHttpTransport();
  const key = `${input.externalClientRef ?? input.clientName}|${input.periodLabel}`;
  const prior = parentQueue.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(async () => {
    const existingId = input.existingId ?? parentMade.get(key);
    if (existingId && (await haloTicketUsable(http, cfg, existingId))) return { id: existingId, created: false };
    const created = await createHaloTicket(http, cfg, {
      summary: `QBR - ${input.clientName} - ${input.periodLabel}`,
      details: `Quarterly business review for ${input.periodLabel}. Work agreed in this review is filed as child tickets under this one.`,
      clientId: input.externalClientRef,
      ticketTypeId: input.ticketTypeId,
      agentId: input.agentId,
      team: input.team,
    });
    parentMade.set(key, created.id);
    return { id: created.id, created: true };
  });
  parentQueue.set(key, run);
  return run;
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
    const cfg = await directHaloCfg(intg);
    if (cfg && input.target === 'halo_ticket') {
      const created = await createHaloTicket(http, cfg, {
        summary: input.title,
        details: input.detail,
        clientId: input.externalClientRef,
        ticketTypeId: input.ticketTypeId,
        agentId: input.agentId,
        team: input.team,
        priorityId: input.priorityId,
        parentId: input.parentTicketId,
      });
      return { system: 'halo', id: created.id, status: created.status, ...(input.parentTicketId ? { parentId: input.parentTicketId } : {}) };
    }
    if (cfg) {
      const created = await createHaloOpportunity(http, cfg, {
        summary: input.title,
        details: input.detail,
        clientId: input.externalClientRef,
        value: input.value,
        valueKind: input.valueKind,
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
