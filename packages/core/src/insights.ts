import type { MetricTrend, MetricValue } from './types.js';

/**
 * Ticket-history insights — the consultative "what actually happened, and what
 * should we raise with the client" layer. Everything here is computed
 * deterministically from the ticket drill-down rows the collectors already
 * attach to each metric (id/summary/type/date), so the talking points and
 * recommendations cite REAL tickets, not generic advice. No AI, no fabrication:
 * every number is a literal count over the rows.
 */

export type TicketInsightKind =
  | 'recurring_incident'
  | 'incident_trend'
  | 'change_activity'
  | 'sla_breaches'
  | 'open_backlog';

export interface TicketInsight {
  kind: TicketInsightKind;
  severity: 'high' | 'medium' | 'low';
  /** Short talking-point headline (used as an agenda topic). */
  title: string;
  /** One-line rationale citing the specific figures behind it. */
  detail: string;
  /** A few backing ticket subjects (or themes), for context. */
  evidence: string[];
  /** Every number cited in `detail`, so the AI guardrail allows the model to quote them. */
  figures: number[];
}

type Row = Record<string, string | number>;

const num = (v: MetricValue['value']): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Words that don't identify a recurring theme — filtered before keyword
 * clustering. Length ≥3 is allowed so meaningful IT acronyms (vpn, dns, rdp,
 * wifi, 365) cluster, so the stopword list carries the common short English
 * words that would otherwise create spurious themes.
 */
const STOPWORDS = new Set([
  // ticket/process noise
  'ticket', 'tickets', 'issue', 'issues', 'request', 'requests', 'problem', 'problems', 'error', 'errors',
  'help', 'please', 'unable', 'cannot', 'does', 'doesnt', 'working', 'work', 'need', 'needs', 'about', 'again',
  'still', 'some', 'user', 'users', 'client', 'support', 'urgent', 'follow', 'general', 'other', 'question',
  'change', 'incident', 'service', 'requestor', 'alert', 'alerts', 'auto', 'automated', 'monitor', 'monitoring',
  'update', 'updates', 'check', 'review', 'status', 'ticketing', 'email', 'emails', 'setup', 'access', 'login',
  // ticket-naming-convention verbs/prefixes — these describe the ACTION, not the
  // underlying issue, so they must never surface as a "recurring theme".
  'troubleshoot', 'troubleshooting', 'config', 'configure', 'configuration', 'install', 'installation',
  'reinstall', 'uninstall', 'setup', 'provision', 'provisioning', 'deploy', 'deployment', 'onboard',
  'onboarding', 'offboard', 'offboarding', 'decommission', 'migrate', 'migration', 'restrict', 'enable',
  'disable', 'reset', 'reboot', 'restart', 'create', 'remove', 'delete', 'replace', 'upgrade', 'renew',
  'renewal', 'schedule', 'assist', 'assistance', 'investigate', 'resolve', 'fix', 'repair', 'add', 'added',
  'new', 'move', 'moving', 'change', 'changes',
  // short English function words
  'the', 'and', 'for', 'are', 'was', 'not', 'you', 'can', 'has', 'had', 'her', 'his', 'our', 'out', 'who',
  'why', 'how', 'all', 'any', 'its', 'one', 'two', 'but', 'now', 'use', 'see', 'way', 'day', 'new', 'old',
  'get', 'got', 'let', 'may', 'off', 'per', 'via', 'this', 'that', 'have', 'from', 'your', 'when', 'would',
  'like', 'been', 'they', 'them', 'here', 'there', 'into', 'with', 'will', 'cant', 'wont', 'for',
]);

function tokens(summary: string): string[] {
  const seen = new Set<string>();
  for (const raw of summary.toLowerCase().split(/[^a-z0-9]+/)) {
    // Significant words only: ≥3 chars, not a stopword, not a bare number.
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

// Short tokens are almost always acronyms (VPN, DNS, RDP, SSO, MFA); longer
// tokens read better title-cased (Outlook, Printer).
const cap = (s: string) => (!s ? s : s.length <= 3 ? s.toUpperCase() : s[0]!.toUpperCase() + s.slice(1));

function rowsOf(metrics: MetricValue[], key: string): Row[] {
  const m = metrics.find((x) => x.key === key);
  return Array.isArray(m?.details) ? (m!.details as Row[]) : [];
}

function summaries(rows: Row[]): string[] {
  return rows.map((r) => String(r['summary'] ?? r['subject'] ?? '').trim()).filter(Boolean);
}

const RECUR_MIN = 3; // a theme needs at least this many tickets to count as recurring
const MAX_THEMES = 2;

/**
 * Recurring incident themes: keyword clustering over incident (and open-ticket)
 * subjects. A theme is a significant word shared by ≥RECUR_MIN tickets. Honest
 * framing — we report the literal count of tickets whose subject references the
 * word, and suggest checking for a common root cause.
 */
function recurringIncidents(metrics: MetricValue[]): TicketInsight[] {
  const subs = [...summaries(rowsOf(metrics, 'tickets.incidents')), ...summaries(rowsOf(metrics, 'tickets.open'))];
  if (subs.length < RECUR_MIN) return [];

  // Deduplicate identical subjects first so one noisy alert repeated verbatim
  // doesn't masquerade as many distinct tickets.
  const uniqueSubs = [...new Set(subs.map((s) => s.toLowerCase()))].length >= RECUR_MIN ? subs : [];
  if (uniqueSubs.length < RECUR_MIN) return [];

  const byToken = new Map<string, number[]>();
  uniqueSubs.forEach((s, i) => {
    for (const t of tokens(s)) {
      const list = byToken.get(t) ?? [];
      list.push(i);
      byToken.set(t, list);
    }
  });

  const candidates = [...byToken.entries()]
    .filter(([, idx]) => idx.length >= RECUR_MIN)
    .sort((a, b) => b[1].length - a[1].length);

  const out: TicketInsight[] = [];
  const claimed = new Set<number>();
  for (const [token, idx] of candidates) {
    if (out.length >= MAX_THEMES) break;
    // Skip a theme whose tickets are mostly already explained by a stronger one.
    const fresh = idx.filter((i) => !claimed.has(i));
    if (fresh.length < RECUR_MIN) continue;
    idx.forEach((i) => claimed.add(i));
    const examples = idx.slice(0, 3).map((i) => uniqueSubs[i]!);
    out.push({
      kind: 'recurring_incident',
      severity: idx.length >= 5 ? 'high' : 'medium',
      title: `Recurring theme: “${cap(token)}” appears in ${idx.length} tickets`,
      detail: `${idx.length} tickets this quarter reference “${token}” (e.g. ${examples
        .map((e) => `“${e}”`)
        .join(', ')}). Worth checking for a common root cause so it stops recurring.`,
      evidence: examples,
      figures: [idx.length],
    });
  }
  return out;
}

/** Index trends by metric key for quick current/previous lookups. */
function trendIndex(trends: MetricTrend[]): Map<string, MetricTrend> {
  return new Map(trends.map((t) => [t.key, t]));
}

/** Incident volume rose materially quarter over quarter. */
function incidentTrend(ti: Map<string, MetricTrend>): TicketInsight[] {
  const t = ti.get('tickets.incidents');
  if (!t || t.current === null || t.previous === null || t.deltaPct === null) return [];
  if (t.current - t.previous < 3 || t.deltaPct < 25) return [];
  return [
    {
      kind: 'incident_trend',
      severity: t.deltaPct >= 60 ? 'high' : 'medium',
      title: 'Incident volume is up this quarter',
      detail: `Incidents rose from ${t.previous} to ${t.current} (+${Math.round(t.deltaPct)}%) — worth understanding what's driving the increase and whether it points to an underlying issue.`,
      evidence: [],
      figures: [t.previous, t.current, Math.round(t.deltaPct)],
    },
  ];
}

/** Meaningful change-request activity — confirm it was planned and roadmap-aligned. */
function changeActivity(metrics: MetricValue[], ti: Map<string, MetricTrend>): TicketInsight[] {
  const changes = num(metrics.find((m) => m.key === 'tickets.changes')?.value ?? null);
  if (changes === null || changes < 3) return [];
  const t = ti.get('tickets.changes');
  const rose = t && t.previous !== null && t.deltaPct !== null && t.current !== null && t.current > t.previous && t.deltaPct >= 25;
  const examples = summaries(rowsOf(metrics, 'tickets.changes')).slice(0, 3);
  const trendClause = rose ? ` (up from ${t!.previous} last quarter)` : '';
  return [
    {
      kind: 'change_activity',
      severity: rose ? 'medium' : 'low',
      title: `${changes} change requests this quarter${rose ? ' — trending up' : ''}`,
      detail: `${changes} change request(s) were handled this quarter${trendClause}${
        examples.length ? ` (e.g. ${examples.map((e) => `“${e}”`).join(', ')})` : ''
      }. Confirm these were planned, approved, and aligned to the roadmap.`,
      evidence: examples,
      figures: rose && t?.previous !== null && t?.previous !== undefined ? [changes, t.previous] : [changes],
    },
  ];
}

/** SLA targets missed this quarter. */
function slaBreaches(metrics: MetricValue[]): TicketInsight[] {
  const breaches = num(metrics.find((m) => m.key === 'sla.breaches')?.value ?? null);
  if (breaches === null || breaches < 1) return [];
  const examples = summaries(rowsOf(metrics, 'sla.breaches')).slice(0, 3);
  return [
    {
      kind: 'sla_breaches',
      severity: breaches >= 3 ? 'high' : 'medium',
      title: `${breaches} SLA target${breaches === 1 ? '' : 's'} missed`,
      detail: `${breaches} ticket(s) breached their SLA this quarter${
        examples.length ? ` (e.g. ${examples.map((e) => `“${e}”`).join(', ')})` : ''
      }. Review whether response/resolution expectations and staffing still fit the account.`,
      evidence: examples,
      figures: [breaches],
    },
  ];
}

/** Open backlog grew — a staffing / prioritization conversation. */
function openBacklog(ti: Map<string, MetricTrend>): TicketInsight[] {
  const t = ti.get('tickets.open');
  if (!t || t.current === null || t.previous === null || t.deltaPct === null) return [];
  if (t.current - t.previous < 5 || t.deltaPct < 30) return [];
  return [
    {
      kind: 'open_backlog',
      severity: 'low',
      title: 'Open ticket backlog is growing',
      detail: `Open tickets grew from ${t.previous} to ${t.current} (+${Math.round(t.deltaPct)}%) — worth confirming prioritization and staffing keep pace with demand.`,
      evidence: [],
      figures: [t.previous, t.current, Math.round(t.deltaPct)],
    },
  ];
}

const SEVERITY_RANK: Record<TicketInsight['severity'], number> = { high: 0, medium: 1, low: 2 };

/**
 * Mine the quarter's ticket history for consultative talking points, ordered
 * most-material first. Pure and deterministic — safe to run at report-build and
 * agenda-suggest time.
 */
export function computeTicketInsights(metrics: MetricValue[], trends: MetricTrend[] = [], limit = 6): TicketInsight[] {
  const ti = trendIndex(trends);
  const insights = [
    ...recurringIncidents(metrics),
    ...slaBreaches(metrics),
    ...incidentTrend(ti),
    ...changeActivity(metrics, ti),
    ...openBacklog(ti),
  ];
  return insights.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, limit);
}

/** Flatten insights into recommendation lines (report fallback + evidence for the AI). */
export function ticketInsightRecommendations(insights: TicketInsight[]): string[] {
  return insights.map((i) => `${i.title}. ${i.detail}`);
}

/**
 * A capped, de-duplicated sample of the ACTUAL ticket subjects, grouped by
 * type — handed to the AI so it can read inside the tickets and identify
 * genuine problems/opportunities, rather than relying on keyword counting.
 * Keyword clustering can't tell a naming-convention prefix ("Troubleshoot…")
 * from a real theme; a language model reading the text can.
 */
export interface TicketDigest {
  incidents: string[];
  changes: string[];
  slaBreaches: string[];
}

function sampleSubjects(rows: Row[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of summaries(rows)) {
    const t = s.replace(/\s+/g, ' ').trim().slice(0, 100);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export function ticketDigest(
  metrics: MetricValue[],
  caps: { incidents?: number; changes?: number; sla?: number } = {},
): TicketDigest {
  return {
    incidents: sampleSubjects(rowsOf(metrics, 'tickets.incidents'), caps.incidents ?? 24),
    changes: sampleSubjects(rowsOf(metrics, 'tickets.changes'), caps.changes ?? 12),
    slaBreaches: sampleSubjects(rowsOf(metrics, 'sla.breaches'), caps.sla ?? 12),
  };
}

/** True when a digest carries any ticket subjects worth handing to the model. */
export function hasTicketDigest(d: TicketDigest): boolean {
  return d.incidents.length + d.changes.length + d.slaBreaches.length > 0;
}
