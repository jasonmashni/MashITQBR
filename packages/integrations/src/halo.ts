import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type McpTransport } from './types.js';
import { toArray, unwrapMcp } from './util.js';

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

/** Collect Halo ticket metrics via the MASH MCP server. */
export async function collectHalo(ctx: CollectorContext, mcp: McpTransport): Promise<CollectResult> {
  if (!ctx.externalRef) {
    return { source: 'halo', metrics: [], warnings: ['No Halo client mapped for this client.'] };
  }
  const result = await mcp.callTool('halo_list_tickets', {
    client_id: ctx.externalRef,
    start_date: ctx.period.start,
    end_date: ctx.period.end,
    datesearch: 'dateoccurred',
    pageinate: false,
  });
  const tickets = toArray<HaloTicket>(unwrapMcp(result), ['tickets']);
  return { source: 'halo', metrics: normalizeHaloTickets(tickets), warnings: [] };
}
