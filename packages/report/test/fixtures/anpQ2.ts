import { SEED_CLIENTS, type DiscussionItem, type MetricSnapshot, type MetricValue } from '@mashit/core';
import type { NarrativeOutput } from '@mashit/narrative';

/**
 * ANP Enertech, Q2 2026, shaped like a real synced quarter. Core seeds only
 * carry Q4 2025 and Q1 2026, so the figures here come from the approved
 * report-v2 mockups (page one, protection, investment). Shared by the
 * investment, page-structure, readability and deliverable tests and by the
 * rendered-PDF check.
 */
export const anpClient = SEED_CLIENTS.find((c) => c.id === 'anp')!;

type Opts = Partial<Pick<MetricValue, 'unit' | 'higherIsBetter'>> & Pick<MetricValue, 'category' | 'source'>;
const mv = (key: string, label: string, value: number, o: Opts): MetricValue => ({ key, label, value, ...o });
const ops = { category: 'operations', source: 'halo' } as const;
const sec = (source: MetricValue['source']) => ({ category: 'security', source }) as const;
const idn = { category: 'identity', source: 'cipp' } as const;
const bak = { category: 'backup', source: 'dropsuite' } as const;
const inf = { category: 'infrastructure', source: 'ninja' } as const;
const spd = (source: MetricValue['source'] = 'halo') => ({ category: 'spend', source, unit: 'USD' }) as const;

export const anpQ1Shape: MetricSnapshot = {
  clientId: 'anp',
  period: '2026-Q1',
  capturedAt: '2026-03-31T00:00:00.000Z',
  metrics: [
    mv('tickets.total', 'Total tickets', 116, { ...ops, unit: 'count', higherIsBetter: false }),
    mv('tickets.incidents', 'Incidents', 39, { ...ops, unit: 'count', higherIsBetter: false }),
    mv('sla.met_pct', 'Response deadlines met', 85.3, { ...ops, unit: '%', higherIsBetter: true }),
    mv('sla.breaches', 'Missed deadlines', 17, { ...ops, unit: 'count', higherIsBetter: false }),
    mv('email.threats_blocked', 'Threats blocked before inbox', 22, { ...sec('checkpoint'), unit: 'count', higherIsBetter: true }),
    mv('patch.compliance_pct', 'Patch compliance', 92, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
    mv('finance.quarter_invoiced', 'Invoiced this quarter (total)', 30578, spd()),
  ],
};

export const anpQ2: MetricSnapshot = {
  clientId: 'anp',
  period: '2026-Q2',
  capturedAt: '2026-06-30T00:00:00.000Z',
  metrics: [
    mv('tickets.total', 'Total tickets', 62, { ...ops, unit: 'count', higherIsBetter: false }),
    mv('tickets.closed', 'Tickets closed', 65, { ...ops, unit: 'count' }),
    mv('tickets.incidents', 'Incidents', 13, { ...ops, unit: 'count', higherIsBetter: false }),
    mv('sla.met_pct', 'Response deadlines met', 91.7, { ...ops, unit: '%', higherIsBetter: true }),
    mv('sla.breaches', 'Missed deadlines', 5, { ...ops, unit: 'count', higherIsBetter: false }),
    mv('email.events_total', 'Email security events', 2400, { ...sec('checkpoint'), unit: 'events' }),
    mv('email.phishing', 'Phishing', 18, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
    mv('email.threats_blocked', 'Threats blocked before inbox', 18, { ...sec('checkpoint'), unit: 'count', higherIsBetter: true }),
    mv('email.malicious_clicks', 'Malicious link clicks', 0, { ...sec('checkpoint'), unit: 'count', higherIsBetter: false }),
    mv('huntress.endpoints', 'Protected endpoints', 30, { ...sec('huntress'), unit: 'count' }),
    mv('huntress.edr_incidents', 'EDR incidents', 0, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
    mv('huntress.blocked_malware', 'Malware blocked', 4, { ...sec('huntress'), unit: 'count' }),
    mv('huntress.m365_events', 'M365 events analyzed', 917000, { ...sec('huntress'), unit: 'events' }),
    mv('huntress.identity_compromises', 'Identity compromises', 1, { ...sec('huntress'), unit: 'count', higherIsBetter: false }),
    mv('huntress.siem_logs', 'SIEM logs ingested', 45800000, { ...sec('huntress'), unit: 'events' }),
    mv('huntress.canaries', 'Ransomware canaries', 663, { ...sec('huntress'), unit: 'count' }),
    mv('patch.installed_quarter', 'Updates installed', 3990, { ...sec('ninja'), unit: 'count' }),
    mv('patch.pending', 'Updates waiting', 455, { ...sec('ninja'), unit: 'count', higherIsBetter: false }),
    mv('patch.compliance_pct', 'Patch compliance', 88, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
    mv('endpoints.av_coverage_pct', 'AV coverage', 100, { ...sec('ninja'), unit: '%', higherIsBetter: true }),
    mv('identity.mfa_coverage_pct', 'MFA coverage', 100, { ...idn, unit: '%', higherIsBetter: true }),
    mv('identity.licensed_users', 'Licensed users', 25, { ...idn, unit: 'count' }),
    mv('identity.ca_policies', 'Sign-in policies', 7, { ...idn, unit: 'count' }),
    mv('identity.global_admins', 'Global admins', 2, { ...idn, unit: 'count' }),
    mv('backup.success_pct', 'Backup success rate', 100, { ...bak, unit: '%', higherIsBetter: true }),
    mv('backup.m365_accounts', 'M365 accounts backed up', 21, { ...bak, unit: 'count' }),
    mv('backup.sharepoint_sites', 'SharePoint sites backed up', 24, { ...bak, unit: 'count' }),
    mv('assets.total', 'Tracked devices', 57, { ...inf, unit: 'count' }),
    mv('assets.warranty_expired', 'Devices out of warranty', 10, { ...inf, unit: 'count', higherIsBetter: false }),
    mv('endpoints.managed', 'Managed workstations', 30, { ...inf, unit: 'count' }),
    mv('sat.learners', 'Security training learners', 25, { ...sec('huntress'), unit: 'count' }),
    mv('licenses.total', 'Paid license seats', 32, { ...spd('cipp'), unit: 'count' }),
    mv('licenses.assigned', 'Licenses assigned', 31, { ...spd('cipp'), unit: 'count' }),
    mv('finance.contracts_expiring', 'Agreements up for renewal (90 days)', 1, { ...spd(), unit: 'count', higherIsBetter: false }),
    mv('finance.mrr', 'Monthly recurring revenue', 5460, spd()),
    mv('finance.quarter_invoiced', 'Invoiced this quarter (total)', 21019, spd()),
    mv('finance.invoiced.managed_workstation', 'Managed workstations', 8360, spd()),
    mv('finance.invoiced.managed_end_user', 'Managed end users', 4960, spd()),
    mv('finance.invoiced.remote_support', 'Remote support (hourly)', 2006, spd()),
    mv('finance.invoiced.compliance_management', 'Compliance management', 1350, spd()),
    mv('finance.invoiced.other', 'Other project work', 1444, spd()),
    mv('finance.invoiced.microsoft_365_business_premium', 'Microsoft 365 Business Premium', 1109, spd()),
    mv('finance.invoiced.network_monitoring', 'Network monitoring', 600, spd()),
    mv('finance.recurring.managed_workstation', 'Managed workstations (monthly)', 2787, spd()),
    mv('finance.recurring.managed_end_user', 'Managed end users (monthly)', 1653, spd()),
    mv('finance.recurring.compliance_management', 'Compliance management (monthly)', 450, spd()),
    mv('finance.recurring.microsoft_365_business_premium', 'Microsoft 365 Business Premium (monthly)', 370, spd()),
    mv('finance.recurring.network_monitoring', 'Network monitoring (monthly)', 200, spd()),
  ],
};

/** Page one, as approved in the mockup (all figures exist in anpQ2). */
export const anpQ2Narrative: NarrativeOutput = {
  headline: 'Quieter quarter, faster response, controls holding',
  lede: 'Support demand fell by nearly half and we met more response deadlines than last quarter. Your security controls held through one real attack. Two items need your decision: devices past warranty and a growing patch backlog.',
  did: [
    'Closed 65 tickets; incidents fell to 13 from 39.',
    'Installed 3,990 updates with no failed patch runs.',
    'Locked and investigated one compromised account within the hour.',
    'Blocked 18 phishing emails before they reached inboxes.',
  ],
  saw: [
    '5 missed deadlines, all new-access requests.',
    '455 updates waiting on PCs that cannot reboot during production.',
    'Repeated lab workstation failures on the same instruments.',
    'One lab PC has not backed up in over a year.',
  ],
  decisions: [
    { ask: 'Approve replacing 10 out-of-warranty devices', why: 'Lands them before year end', by: 'Nov 15' },
    { ask: 'A monthly maintenance window for production PCs', why: 'Clears the patch backlog' },
    { ask: 'An owner for Copilot usage rules', why: 'Shadow AI report attached' },
  ],
  plan: {
    now: [
      { action: 'Fix the lab PC that is not backing up and recheck production imaging', owner: 'Mash IT' },
      { action: 'Review the risky sign-ins with James', owner: 'Mash IT' },
      { action: 'Start a fast intake path for new-access requests', owner: 'Mash IT' },
    ],
    next: [
      { action: 'Refresh plan and quotes for the 10 out-of-warranty devices', owner: 'Mash IT', decision: true },
      { action: 'First monthly maintenance window for production PCs', owner: 'ANP and Mash IT', decision: true },
      { action: 'Draft AI usage rules from the Shadow AI report', owner: 'Owner to be named', decision: true },
    ],
    later: [
      { action: 'SSO live for QuickBooks and Amazon', owner: 'Mash IT' },
      { action: 'ERP cutover readiness check', owner: 'ANP, Mash IT supporting' },
      { action: 'Plan the 2027 IT budget together at the Q3 review', owner: 'Mash IT' },
    ],
  },
  protection: [
    { question: 'get_in', inPlace: 'MFA on all 25 licensed users and 7 sign-in policies. Every email is scanned before delivery. 30 endpoints run managed detection.', thisQuarter: '18 phishing emails stopped. 4 malware files blocked before they ran.' },
    { question: 'know', inPlace: 'The Huntress SOC reviews security events around the clock. 663 ransomware tripwires across your PCs.', thisQuarter: 'One account was compromised. It was locked and investigated within the hour; nothing spread.' },
    { question: 'recover', inPlace: 'Daily cloud backup of 21 mailboxes and 24 SharePoint sites. Production and lab PCs image to the Synology.', thisQuarter: '100% cloud success. One lab PC has not backed up in over a year.' },
    { question: 'keep_up', inPlace: '3,990 updates installed this quarter. 57 devices tracked with warranty dates.', thisQuarter: '455 updates waiting on machines that cannot reboot in production. 10 devices past warranty.' },
    { question: 'run_well', inPlace: 'Quarterly review cadence, 25 staff in security awareness training, 2 global admins, documented environment.', thisQuarter: 'Copilot usage request handled. Shadow AI report attached for a usage policy decision.' },
  ],
  section_summaries: [
    { category: 'operations', summary: 'Support demand fell by nearly half while more deadlines were met.' },
    { category: 'security', summary: 'Layered defenses held through one real attack.' },
  ],
  figures_referenced: [],
};

export const anpQ2Discussion: DiscussionItem[] = [
  { id: 'c1', topic: 'ERP move from Fishbowl to BatchMaster', response: 'Deployment expected Q4. SSO and clock-in tablet work are sequenced around it.', owner: 'James', status: 'discussed', sortOrder: 1 },
  { id: 'c2', topic: 'Single sign-on for Amazon, QuickBooks, ERP', response: 'Ticket open. QuickBooks first, Amazon with Amber, ERP after cutover.', owner: 'Mash IT', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41901', status: 'In Progress' }, sortOrder: 2 },
  { id: 'c3', topic: 'Studio 5000 software access', owner: 'Brad', status: 'planned', sortOrder: 3 },
  { id: 'c4', topic: 'Clock-in tablet (QuickBooks Time)', response: 'Joined to management and on the network. Phase 2 visitor log is next.', owner: 'Mash IT', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41882', status: 'Closed' }, sortOrder: 4 },
  { id: 'c5', topic: "Shane taking over Gilbert's PC", response: 'Handled. No further action.', owner: 'James', disposition: 'no_action', status: 'discussed', sortOrder: 5 },
];

export const anpQ1Discussion: DiscussionItem[] = [
  { id: 'p1', topic: 'SharePoint sharing restriction for external users', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41790', status: 'Closed' }, sortOrder: 1 },
  { id: 'p2', topic: 'Clock-in tablet joined to management', disposition: 'create_ticket', status: 'discussed', externalRef: { system: 'halo', id: '41882', status: 'Closed' }, sortOrder: 2 },
  { id: 'p3', topic: 'Studio 5000 software access', status: 'planned', sortOrder: 3 },
];

export const anpQ2Documents = [
  { name: 'Huntress quarterly summary 2026-Q2.pdf', source: 'huntress' },
  { name: 'Synology Active Backup 2026-Q2.pdf', source: 'upload' },
];
