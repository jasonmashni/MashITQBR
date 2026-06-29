import type { Client, MetricCategory, MetricSnapshot, MetricValue } from './types.js';

/**
 * Seed data transcribed from Mash IT's three real Q1-2026 QBRs (ANP Enertech,
 * Kentucky Primary Care Association, Madison Pediatric Associates). This backfills
 * the metric store so the first generated QBRs already show quarter-over-quarter
 * trends, before the automated snapshot pipeline has accumulated history.
 *
 * Only numbers that actually appear in the source QBRs are encoded — nothing is
 * fabricated. Where a prior-quarter figure isn't stated in the source, the trend
 * simply reads "n/a" until the snapshot pipeline fills it in.
 */

type Opts = { unit?: string; category: MetricCategory; source: MetricValue['source']; higherIsBetter?: boolean };

function mv(key: string, label: string, value: MetricValue['value'], o: Opts): MetricValue {
  return { key, label, value, unit: o.unit, category: o.category, source: o.source, higherIsBetter: o.higherIsBetter };
}

const ops = (source: MetricValue['source']): Pick<Opts, 'category' | 'source'> => ({ category: 'operations', source });
const sec = (source: MetricValue['source']): Pick<Opts, 'category' | 'source'> => ({ category: 'security', source });
const back = (source: MetricValue['source']): Pick<Opts, 'category' | 'source'> => ({ category: 'backup', source });
const infra = (source: MetricValue['source']): Pick<Opts, 'category' | 'source'> => ({ category: 'infrastructure', source });
const spend = (source: MetricValue['source']): Pick<Opts, 'category' | 'source'> => ({ category: 'spend', source });

export const SEED_CLIENTS: readonly Client[] = [
  {
    id: 'anp',
    name: 'ANP Enertech',
    primaryContact: { name: 'James Baek', role: 'Primary Contact' },
    industry: 'Manufacturing',
    hipaa: false,
  },
  {
    id: 'kpca',
    name: 'Kentucky Primary Care Association',
    primaryContact: { name: 'Anne Howell', role: 'Primary Contact' },
    industry: 'Healthcare',
    hipaa: true,
  },
  {
    id: 'mp',
    name: 'Madison Pediatric Associates',
    primaryContact: { name: 'Lindsay Weakley', role: 'Primary Contact' },
    industry: 'Healthcare',
    hipaa: true,
  },
];

const Q1 = '2026-Q1';
const Q4 = '2025-Q4';
const Q1_AT = '2026-03-31T00:00:00.000Z';
const Q4_AT = '2025-12-31T00:00:00.000Z';

export const SEED_SNAPSHOTS: readonly MetricSnapshot[] = [
  // ── ANP Enertech ────────────────────────────────────────────────────────
  {
    clientId: 'anp',
    period: Q4,
    capturedAt: Q4_AT,
    metrics: [mv('tickets.total', 'Total tickets', 47, { ...ops('halo'), unit: 'count', higherIsBetter: false })],
  },
  {
    clientId: 'anp',
    period: Q1,
    capturedAt: Q1_AT,
    metrics: [
      mv('tickets.total', 'Total tickets', 141, { ...ops('halo'), unit: 'count', higherIsBetter: false }),
      mv('tickets.incidents', 'Incidents', 42, { ...ops('halo'), unit: 'count', higherIsBetter: false }),
      mv('tickets.changes', 'Change requests', 17, { ...ops('halo'), unit: 'count' }),
      mv('huntress.events_analyzed', 'Huntress events analyzed', 12_500_000, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.entities', 'Protected entities', 103, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.edr_incidents', 'EDR incidents', 1, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('huntress.ransomware_incidents', 'Ransomware incidents', 0, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('huntress.m365_events', 'M365 events analyzed', 917_000, { ...sec('huntress'), unit: 'events' }),
      mv('email.events_total', 'Email security events', 2_600, { ...sec('checkpoint'), unit: 'events' }),
      mv('email.phishing', 'Phishing', 35, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.malware', 'Malware', 2, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.spam', 'Spam', 300, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.graymail', 'Graymail', 2_100, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.threats_blocked', 'Threats blocked before inbox', 22, { ...sec('checkpoint'), unit: 'count', higherIsBetter: true }),
      mv('email.auto_encrypted', 'Emails auto-encrypted (DLP)', 100, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.malicious_clicks', 'Malicious link clicks', 0, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.dlp_events', 'DLP events', 20_300, { ...sec('checkpoint'), unit: 'count' }),
      mv('backup.devices_protected', 'Devices backed up', 13, { ...back('ninja'), unit: 'count' }),
      mv('backup.m365_accounts', 'M365 accounts backed up', 18, { ...back('dropsuite'), unit: 'count' }),
      mv('assets.warranty_expired', 'Devices out of warranty', 4, { ...infra('ninja'), unit: 'count', higherIsBetter: false }),
      mv('assets.warranty_expiring_6mo', 'Warranties expiring < 6mo', 4, { ...infra('ninja'), unit: 'count', higherIsBetter: false }),
      mv('spend.managed_support', 'Managed support', 4_165, { ...spend('halo'), unit: 'USD' }),
      mv('spend.microsoft_licensing', 'Microsoft licensing', 441.1, { ...spend('halo'), unit: 'USD' }),
      mv('spend.total_monthly', 'Total monthly spend', 4_801.43, { ...spend('halo'), unit: 'USD' }),
    ],
  },

  // ── Kentucky Primary Care Association ───────────────────────────────────
  {
    clientId: 'kpca',
    period: Q1,
    capturedAt: Q1_AT,
    metrics: [
      mv('tickets.total', 'Total tickets', 30, { ...ops('halo'), unit: 'count', higherIsBetter: false }),
      mv('tickets.incidents', 'Incidents', 7, { ...ops('halo'), unit: 'count', higherIsBetter: false }),
      mv('tickets.changes', 'Change requests', 9, { ...ops('halo'), unit: 'count' }),
      mv('tickets.sla_attainment_pct', 'SLA attainment', 100, { ...ops('halo'), unit: '%', higherIsBetter: true }),
      mv('huntress.events_analyzed', 'Huntress events analyzed', 27_200_000, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.endpoints', 'Protected endpoints', 80, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.identities', 'Protected identities', 580, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.edr_incidents', 'EDR incidents', 0, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('huntress.m365_events', 'M365 ITDR events', 3_590_000, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.siem_logs', 'SIEM logs ingested', 72_800_000, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.malware_blocked', 'Malware auto-blocked', 4, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.canaries_deployed', 'Ransomware canaries deployed', 1_059, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.identity_compromises', 'Identity compromises', 0, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('email.events_total', 'Email security events', 48_600, { ...sec('checkpoint'), unit: 'events' }),
      mv('email.phishing', 'Phishing', 422, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.malware', 'Malware', 12, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.spam', 'Spam', 12_100, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.graymail', 'Graymail', 35_300, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.threats_blocked', 'Threats blocked before inbox', 198, { ...sec('checkpoint'), unit: 'count', higherIsBetter: true }),
      mv('email.malicious_clicks', 'Malicious link clicks', 0, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.dlp_events', 'DLP events', 993, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.auto_encrypted', 'Emails auto-encrypted (DLP)', 793, { ...sec('checkpoint'), unit: 'count' }),
      mv('endpoints.managed', 'Managed workstations', 77, { category: 'infrastructure', source: 'ninja', unit: 'count' }),
      mv('endpoints.win11_pct', 'Windows 11 coverage', 100, { category: 'infrastructure', source: 'ninja', unit: '%', higherIsBetter: true }),
      mv('endpoints.av_coverage_pct', 'AV coverage', 100, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
      mv('patch.compliance_pct', 'Patch compliance', 87, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
      mv('spend.identity_guard', 'Identity Guard', 1_400, { ...spend('halo'), unit: 'USD' }),
      mv('spend.endpoint_shield', 'Endpoint Shield', 3_915, { ...spend('halo'), unit: 'USD' }),
      mv('spend.network_monitoring', 'Network monitoring', 200, { ...spend('halo'), unit: 'USD' }),
      mv('spend.total_monthly', 'Total monthly spend', 5_515, { ...spend('halo'), unit: 'USD' }),
    ],
  },

  // ── Madison Pediatric Associates ────────────────────────────────────────
  {
    clientId: 'mp',
    period: Q1,
    capturedAt: Q1_AT,
    metrics: [
      mv('tickets.total', 'Total tickets', 82, { ...ops('halo'), unit: 'count', higherIsBetter: false }),
      mv('tickets.incidents', 'Incidents', 43, { ...ops('halo'), unit: 'count', higherIsBetter: false }),
      mv('tickets.maintenance', 'Maintenance', 12, { ...ops('halo'), unit: 'count' }),
      mv('tickets.service', 'Service requests', 12, { ...ops('halo'), unit: 'count' }),
      mv('tickets.changes', 'Change requests', 3, { ...ops('halo'), unit: 'count' }),
      mv('huntress.events_analyzed', 'Huntress events analyzed', 13_900_000, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.endpoints', 'Protected endpoints', 26, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.identities', 'Protected identities', 45, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.edr_incidents', 'EDR incidents', 0, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('huntress.m365_events', 'M365 ITDR events', 139_469, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.siem_logs', 'SIEM logs ingested', 22_200_000, { ...sec('huntress'), unit: 'events' }),
      mv('huntress.malware_blocked', 'Malware auto-blocked', 3, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.canaries_deployed', 'Ransomware canaries deployed', 495, { ...sec('huntress'), unit: 'count' }),
      mv('huntress.identity_compromises', 'Identity compromises', 0, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('email.events_total', 'Email security events', 698, { ...sec('checkpoint'), unit: 'events' }),
      mv('email.phishing', 'Phishing', 17, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.malware', 'Malware', 0, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.spam', 'Spam', 122, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.graymail', 'Graymail', 488, { ...sec('checkpoint'), unit: 'count' }),
      mv('email.malicious_clicks', 'Malicious link clicks', 0, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
      mv('email.dlp_events', 'DLP events', 71, { ...sec('checkpoint'), unit: 'count' }),
      mv('patch.os_enablement_pct', 'OS patch enablement', 100, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
      mv('patch.compliance_pct', 'Workstation patch coverage', 89, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
      mv('endpoints.managed', 'Managed workstations', 26, { category: 'infrastructure', source: 'ninja', unit: 'count' }),
      mv('sat.learners', 'SAT learners', 21, { ...sec('huntress'), unit: 'count' }),
      mv('sat.completion_pct', 'HIPAA training completion', 86, { ...sec('huntress'), unit: '%', higherIsBetter: true }),
      mv('sat.phishing_compromises', 'Simulated phishing compromises', 1, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
      mv('assets.warranty_expired', 'Devices out of warranty', 16, { ...infra('ninja'), unit: 'count', higherIsBetter: false }),
      mv('backup.m365_accounts', 'M365 accounts backed up', 15, { ...back('dropsuite'), unit: 'count' }),
      mv('backup.devices_protected', 'Image-backup devices', 1, { ...back('ninja'), unit: 'count' }),
      mv('spend.managed_support', 'Managed support', 2_792, { ...spend('halo'), unit: 'USD' }),
      mv('spend.microsoft_licensing', 'Microsoft licensing', 211.08, { ...spend('halo'), unit: 'USD' }),
      mv('spend.website_hosting', 'Website hosting', 99, { ...spend('halo'), unit: 'USD' }),
      mv('spend.total_monthly', 'Total monthly spend', 2_551.93, { ...spend('halo'), unit: 'USD' }),
    ],
  },
];

/** Find a seeded snapshot for a client/period, if present. */
export function findSeedSnapshot(clientId: string, period: string): MetricSnapshot | undefined {
  return SEED_SNAPSHOTS.find((s) => s.clientId === clientId && s.period === period);
}
