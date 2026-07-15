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
