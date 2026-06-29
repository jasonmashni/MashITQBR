import { describe, it, expect } from 'vitest';
import { makePeriod } from '@mashit/core';
import { collectHalo, normalizeHaloTickets, functionMcpTransport } from '@mashit/integrations';

describe('normalizeHaloTickets', () => {
  it('counts tickets by canonical category', () => {
    const metrics = normalizeHaloTickets([
      { tickettype_name: 'Incident' },
      { tickettype_name: 'Incident' },
      { tickettype: { name: 'Change Request' } },
      { type: 'Service Request' },
      { tickettype_name: 'Business Review' },
    ]);
    const by = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(5);
    expect(by['tickets.incidents']).toBe(2);
    expect(by['tickets.changes']).toBe(1);
    expect(by['tickets.service']).toBe(1);
  });
});

describe('collectHalo', () => {
  it('unwraps an MCP text-content tool result', async () => {
    const mcp = functionMcpTransport(async (name) => {
      expect(name).toBe('halo_list_tickets');
      return {
        content: [
          { type: 'text', text: JSON.stringify([{ tickettype_name: 'Incident' }, { tickettype_name: 'Change Request' }]) },
        ],
      };
    });
    const result = await collectHalo({ clientId: 'anp', period: makePeriod(2026, 1), externalRef: '42' }, mcp);
    const by = Object.fromEntries(result.metrics.map((m) => [m.key, m.value]));
    expect(by['tickets.total']).toBe(2);
    expect(by['tickets.incidents']).toBe(1);
  });

  it('warns when the client is not mapped', async () => {
    const mcp = functionMcpTransport(async () => []);
    const result = await collectHalo({ clientId: 'anp', period: makePeriod(2026, 1) }, mcp);
    expect(result.metrics).toHaveLength(0);
    expect(result.warnings[0]).toMatch(/No Halo client mapped/);
  });
});
