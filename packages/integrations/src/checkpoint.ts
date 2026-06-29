import type { MetricValue } from '@mashit/core';
import { metric, type CollectorContext, type CollectResult, type HttpTransport } from './types.js';

/** A Check Point Harmony Email & Collaboration security event (subset). */
export interface CheckpointEvent {
  type?: string; // phishing | malware | spam | graymail | dlp | anomaly | clean
  state?: string; // quarantined | prevented | detected | allowed
  clicked?: boolean;
  entity?: { recipients?: string[]; to?: string[]; subject?: string };
}

const THREAT_TYPES = new Set(['phishing', 'malware']);

function recipientsOf(e: CheckpointEvent): string[] {
  return e.entity?.recipients ?? e.entity?.to ?? [];
}

/**
 * Normalize HEC events into canonical email-security metrics. Category counts,
 * threats-blocked, malicious clicks, and top-attacked-user are all computed
 * here — the API does not pre-aggregate them.
 */
export function normalizeCheckpointEvents(events: CheckpointEvent[]): MetricValue[] {
  const counts = new Map<string, number>();
  let clicks = 0;
  let threatsBlocked = 0;
  const perRecipient = new Map<string, number>();

  for (const e of events) {
    const type = (e.type ?? 'clean').toLowerCase();
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (e.clicked) clicks++;
    if (THREAT_TYPES.has(type)) {
      threatsBlocked++;
      for (const r of recipientsOf(e)) perRecipient.set(r, (perRecipient.get(r) ?? 0) + 1);
    }
  }

  const sec = (k: string, l: string, v: MetricValue['value'], higherIsBetter?: boolean) =>
    metric(k, l, v, { category: 'security', source: 'checkpoint', unit: 'count', higherIsBetter });

  const out: MetricValue[] = [
    sec('email.events_total', 'Email security events', events.length),
    sec('email.phishing', 'Phishing', counts.get('phishing') ?? 0, false),
    sec('email.malware', 'Malware', counts.get('malware') ?? 0, false),
    sec('email.spam', 'Spam', counts.get('spam') ?? 0),
    sec('email.graymail', 'Graymail', counts.get('graymail') ?? 0),
    sec('email.dlp_events', 'DLP events', counts.get('dlp') ?? 0),
    sec('email.threats_blocked', 'Threats blocked before inbox', threatsBlocked, true),
    sec('email.malicious_clicks', 'Malicious link clicks', clicks, false),
  ];

  const top = [...perRecipient.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    out.push(metric('email.top_attacked_user', 'Top attacked user', `${top[0]} (${top[1]})`, { category: 'security', source: 'checkpoint' }));
  }
  return out;
}

/** Collect Check Point HEC email-security metrics for the period. */
export async function collectCheckpoint(
  ctx: CollectorContext,
  http: HttpTransport,
  cfg: { baseUrl: string; token: string },
): Promise<CollectResult> {
  const res = await http.request({
    method: 'POST',
    url: `${cfg.baseUrl}/event/query`,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: ctx.period.start, endDate: ctx.period.end, saas: 'office365_emails' }),
  });
  const events = extractEvents(res.json);
  return { source: 'checkpoint', metrics: normalizeCheckpointEvents(events), warnings: [] };
}

function extractEvents(json: unknown): CheckpointEvent[] {
  if (Array.isArray(json)) return json as CheckpointEvent[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const data = obj['responseData'] ?? obj['events'] ?? obj['data'];
    if (Array.isArray(data)) return data as CheckpointEvent[];
  }
  return [];
}
