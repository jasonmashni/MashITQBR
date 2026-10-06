import { describe, it, expect } from 'vitest';
import type { MetricSnapshot, MetricValue } from '../src/index.js';
import { computeTicketInsights, computeTrends } from '../src/index.js';

/** A ticket metric carrying drill-down rows (the shape the collectors emit). */
function ticketMetric(key: string, label: string, subjects: string[], value = subjects.length): MetricValue {
  return {
    key,
    label,
    value,
    source: 'halo',
    category: 'operations',
    higherIsBetter: false,
    details: subjects.map((summary, i) => ({ id: String(i + 1), summary, type: 'Incident', opened: '2026-04-01' })),
  };
}

const snap = (period: string, metrics: MetricValue[]): MetricSnapshot => ({
  clientId: 'anp',
  period,
  capturedAt: `${period}-01T00:00:00.000Z`,
  metrics,
});

describe('computeTicketInsights — recurring themes', () => {
  it('flags a keyword shared by ≥3 incident tickets as a recurring theme, citing the count', () => {
    const metrics = [
      ticketMetric('tickets.incidents', 'Incidents', [
        'VPN connection dropping for remote staff',
        'Cannot connect to VPN from home office',
        'VPN client keeps disconnecting midday',
        'Printer offline in the front office',
      ]),
    ];
    const insights = computeTicketInsights(metrics);
    const recurring = insights.find((i) => i.kind === 'recurring_incident');
    expect(recurring).toBeDefined();
    expect(recurring!.title.toLowerCase()).toContain('vpn');
    expect(recurring!.figures).toContain(3); // three tickets reference VPN
    expect(recurring!.detail).toContain('root cause');
    expect(recurring!.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('never surfaces a ticket-naming-convention prefix ("Troubleshoot") as a theme', () => {
    const metrics = [
      ticketMetric('tickets.incidents', 'Incidents', [
        'Troubleshoot TGA2 Internet Offline for Gilbert',
        'Troubleshoot Lenovo P73 laptop needs Windows reinstall',
        'Troubleshoot Outlook on mobile for Youjong Kwon',
        'Troubleshoot printer in accounting',
      ]),
    ];
    const insights = computeTicketInsights(metrics);
    // "troubleshoot" is a naming prefix, not an issue — it must not be a theme.
    expect(insights.some((i) => i.kind === 'recurring_incident' && /troubleshoot/i.test(i.title))).toBe(false);
  });

  it('does not invent a theme when every incident subject is distinct', () => {
    const metrics = [
      ticketMetric('tickets.incidents', 'Incidents', [
        'Printer jam in accounting',
        'Monitor flickering at reception',
        'Keyboard replacement for warehouse',
        'Projector bulb burned out',
      ]),
    ];
    expect(computeTicketInsights(metrics).some((i) => i.kind === 'recurring_incident')).toBe(false);
  });
});

describe('computeTicketInsights — SLA, changes, trends', () => {
  it('surfaces SLA breaches with example tickets, most-severe first', () => {
    const metrics = [
      { key: 'sla.breaches', label: 'SLA breaches', value: 4, source: 'halo', category: 'operations', higherIsBetter: false,
        details: [
          { id: '1', summary: 'Server outage — delayed response' },
          { id: '2', summary: 'Email down for a day' },
        ] },
    ] as MetricValue[];
    const insights = computeTicketInsights(metrics);
    const sla = insights.find((i) => i.kind === 'sla_breaches');
    expect(sla).toBeDefined();
    expect(sla!.severity).toBe('high'); // 4 >= 3
    expect(sla!.figures).toContain(4);
    expect(insights[0]!.kind).toBe('sla_breaches'); // high severity sorts first
  });

  it('flags meaningful change-request activity with examples', () => {
    const metrics = [
      ticketMetric('tickets.changes', 'Change requests', [
        'Migrate file server to SharePoint',
        'Firewall rule change for new vendor',
        'Decommission old VPN appliance',
        'Add SSO for the CRM',
      ], 4),
    ];
    const change = computeTicketInsights(metrics).find((i) => i.kind === 'change_activity');
    expect(change).toBeDefined();
    expect(change!.detail).toMatch(/planned|roadmap/i);
    expect(change!.figures).toContain(4);
  });

  it('detects a material incident-volume increase from trends', () => {
    const cur = snap('2026-Q2', [ticketMetric('tickets.incidents', 'Incidents', [], 18)]);
    const prev = snap('2026-Q1', [ticketMetric('tickets.incidents', 'Incidents', [], 8)]);
    const insights = computeTicketInsights(cur.metrics, computeTrends(cur, prev));
    const trend = insights.find((i) => i.kind === 'incident_trend');
    expect(trend).toBeDefined();
    expect(trend!.figures).toEqual(expect.arrayContaining([8, 18]));
  });

  it('returns nothing when there is no ticket data', () => {
    const metrics = [
      { key: 'identity.mfa_coverage_pct', label: 'MFA', value: 90, unit: '%', source: 'cipp', category: 'identity' },
    ] as MetricValue[];
    expect(computeTicketInsights(metrics)).toEqual([]);
  });
});

/** Build a snapshot from `{ key: { value, details? } }` (ticket metrics). */
function snapshotWith(
  entries: Record<string, { value: number; details?: Array<Record<string, string | number>> }>,
  period = '2026-Q3',
): MetricSnapshot {
  return snap(
    period,
    Object.entries(entries).map(([key, e]) => ({
      key,
      label: key,
      value: e.value,
      source: 'halo',
      category: 'operations',
      higherIsBetter: false,
      ...(e.details ? { details: e.details } : {}),
    })),
  );
}

/** Insights for a current snapshot, with trends against an optional prior one. */
function insightsFor(current: MetricSnapshot, previous?: MetricSnapshot) {
  return computeTicketInsights(current.metrics, previous ? computeTrends(current, previous) : []);
}

describe('computeTicketInsights — subject handling', () => {
  const metrics = [
    ticketMetric('tickets.incidents', 'Incidents', ['VPN drops for Jane', 'VPN down <b>', 'VPN slow again']),
    { key: 'sla.breaches', label: 'SLA breaches', value: 1, source: 'halo', category: 'operations',
      details: [{ id: '9', summary: 'Outage for Dr. Smith' }] } as MetricValue,
  ];

  it('omits example subjects from detail and evidence when examples: false', () => {
    const insights = computeTicketInsights(metrics, [], 6, { examples: false });
    expect(insights.length).toBeGreaterThan(0);
    for (const i of insights) expect(i.evidence).toEqual([]);
    expect(JSON.stringify(insights)).not.toMatch(/Jane|Smith/);
  });

  it('strips angle brackets from subjects', () => {
    expect(JSON.stringify(computeTicketInsights(metrics))).not.toMatch(/[<>]/);
  });
});

describe('computeTicketInsights — counting honesty', () => {
  it('dedupes a ticket that appears in both incidents and open lists', () => {
    const row = (id: string, subject: string) => ({ id, subject, status: 'Open' });
    const snapshot = snapshotWith({
      'tickets.incidents': { value: 3, details: [row('1', 'VPN drops'), row('2', 'VPN drops again'), row('3', 'VPN down')] },
      'tickets.open': { value: 3, details: [row('1', 'VPN drops'), row('2', 'VPN drops again'), row('3', 'VPN down')] },
    });
    const theme = insightsFor(snapshot).find((i) => i.kind === 'recurring_incident')!;
    expect(theme.detail).toMatch(/3 tickets/);
    expect(theme.figures).toEqual([3]);
  });

  it('fires the incident trend when the prior quarter had zero', () => {
    const insights = insightsFor(
      snapshotWith({ 'tickets.incidents': { value: 40 } }),
      snapshotWith({ 'tickets.incidents': { value: 0 } }, '2026-Q2'),
    );
    const trend = insights.find((i) => i.kind === 'incident_trend');
    expect(trend).toBeDefined();
    expect(trend!.figures).toEqual(expect.arrayContaining([0, 40]));
  });

  it('fires the backlog trend when the prior quarter had zero open tickets', () => {
    const insights = insightsFor(
      snapshotWith({ 'tickets.open': { value: 12 } }),
      snapshotWith({ 'tickets.open': { value: 0 } }, '2026-Q2'),
    );
    expect(insights.some((i) => i.kind === 'open_backlog')).toBe(true);
  });

  it('a zero-base trend still needs a material absolute increase', () => {
    const insights = insightsFor(
      snapshotWith({ 'tickets.incidents': { value: 2 } }),
      snapshotWith({ 'tickets.incidents': { value: 0 } }, '2026-Q2'),
    );
    expect(insights.some((i) => i.kind === 'incident_trend')).toBe(false);
  });
});
