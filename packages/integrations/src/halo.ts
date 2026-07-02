import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type McpTransport } from './types.js';
import { toArray, unwrapMcp } from './util.js';
import { headerCount } from './mcpText.js';

export interface HaloTicket {
  id?: number | string;
  tickettype_name?: string;
  tickettype?: { name?: string };
  type?: string;
}

/** Map a Halo ticket-type label to a canonical operations category. */
function categoryOf(t: HaloTicket): string {
  const name = (t.tickettype_name ?? t.tickettype?.name ?? t.type ?? '').toLowerCase();
  if (name.includes('incident')) return 'incident';
  if (name.includes('change')) return 'change';
  if (name.includes('service') || name.includes('request')) return 'service';
  if (name.includes('maintenance')) return 'maintenance';
  if (name.includes('problem')) return 'problem';
  return 'other';
}

/** Normalize a Halo ticket list into ticket-volume metrics for the period. */
export function normalizeHaloTickets(tickets: HaloTicket[]): MetricValue[] {
  const counts = new Map<string, number>();
  for (const t of tickets) counts.set(categoryOf(t), (counts.get(categoryOf(t)) ?? 0) + 1);

  const op = (k: string, l: string, v: number, higherIsBetter?: boolean) =>
    metric(k, l, v, { category: 'operations', source: 'halo', unit: 'count', higherIsBetter });

  return [
    op('tickets.total', 'Total tickets', tickets.length, false),
    op('tickets.incidents', 'Incidents', counts.get('incident') ?? 0, false),
    op('tickets.changes', 'Change requests', counts.get('change') ?? 0),
    op('tickets.service', 'Service requests', counts.get('service') ?? 0),
    op('tickets.maintenance', 'Maintenance', counts.get('maintenance') ?? 0),
  ];
}

/**
 * Collect Halo ticket metrics via the MASH MCP server.
 *
 * The live MASH MCP returns formatted text ("Found N ticket(s): #id — …") with
 * no date filter, `open_only` defaulting true, and a 200-row cap — so the
 * honest text-mode metric is the open-ticket snapshot. If the server ever
 * returns structured JSON (structuredContent or a JSON ticket array), the
 * richer by-type normalization is used automatically.
 */
export async function collectHalo(ctx: CollectorContext, mcp: McpTransport): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'halo', metrics: [], warnings: ['No Halo client mapped for this client.'] };
  }
  const clientId = Number(ctx.externalRef);
  const result = await mcp.callTool('halo_list_tickets', {
    client_id: Number.isFinite(clientId) ? clientId : ctx.externalRef,
    open_only: true,
    count: 200,
  });
  const payload = unwrapMcp(result);

  if (typeof payload === 'string') {
    const rows = payload.match(/^\s*#\w+\s/gm)?.length ?? 0;
    const count = headerCount(payload) ?? rows;
    const warnings = [
      'Halo ticket history is limited to an open-ticket snapshot: the MCP ticket tool has no date filter, and the Halo reports scope returned 403 — grant it (or add a date-filtered MCP tool) for quarterly volumes.',
    ];
    if (count >= 200) warnings.push('Open-ticket count capped at 200 by the MCP tool.');
    return {
      source: 'halo',
      metrics: [
        metric('tickets.open', 'Open tickets', count, { category: 'operations', source: 'halo', unit: 'count', higherIsBetter: false }),
      ],
      warnings,
    };
  }

  const tickets = toArray<HaloTicket>(payload, ['tickets']);
  return { source: 'halo', metrics: normalizeHaloTickets(tickets), warnings: [] };
}
