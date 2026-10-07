import { plural, PROTECTION_QUESTIONS, type MetricTrend, type ProtectionQuestionId } from '@mashit/core';
import type { NarrativeInput } from './input.js';
import { NARRATIVE_LIMITS, wordCount } from './limits.js';
import type { NarrativeDecision, NarrativeOutput, NarrativeProtection, PlanItem } from './schema.js';

type Cite = (label: string, value: string | number) => string;

/** Telemetry volumes are not executive movers (same exclusion as the charts). */
const MOVER_EXCLUDE = /siem|logs|events|signals/i;

/** Plain phrases for the movers an owner cares about most. */
const MOVER_PHRASE: Record<string, { up: string; down: string }> = {
  'tickets.total': { up: 'More tickets', down: 'Fewer tickets' },
  'tickets.incidents': { up: 'More incidents', down: 'Fewer incidents' },
  'tickets.open': { up: 'More open tickets', down: 'Fewer open tickets' },
  'sla.met_pct': { up: 'Faster response', down: 'Slower response' },
  'sla.breaches': { up: 'More missed deadlines', down: 'Fewer missed deadlines' },
  'email.threats_blocked': { up: 'More threats blocked', down: 'Fewer threats blocked' },
  'patch.compliance_pct': { up: 'Patching improved', down: 'Patching slipped' },
  'identity.mfa_coverage_pct': { up: 'MFA coverage up', down: 'MFA coverage down' },
  'backup.success_pct': { up: 'Backups more reliable', down: 'Backups less reliable' },
};

const RATING_TAIL: Record<string, string> = {
  green: 'security posture strong',
  amber: 'security posture fair',
  red: 'security needs attention',
};

/** Remove dashes so every template stays inside the house style. */
function clean(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
}

/** Keep adding sentences while the total stays within `limit` words. */
function fit(sentences: string[], limit: number): string {
  const out: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const n = wordCount(s);
    if (words + n > limit) continue;
    out.push(s);
    words += n;
  }
  return out.join(' ');
}

/**
 * Like fit, but never empty when there is text: a first sentence longer than
 * the limit is split at its own sentence boundaries, and failing that cut to
 * its first `limit` words.
 */
function fitOrCut(sentences: string[], limit: number): string {
  const fitted = fit(sentences, limit);
  if (fitted || !sentences.length) return fitted;
  const parts = sentences[0]!.split(/(?<=[.!?;])\s+/).filter(Boolean);
  return fit(parts, limit) || sentences[0]!.split(/\s+/).filter(Boolean).slice(0, limit).join(' ');
}

/** Take up to `max` bullets within the word limit, topping up from fallbacks to reach `min`. */
function bullets(candidates: string[], fallbacks: string[], min: number, max: number): string[] {
  const ok = (b: string) => b && wordCount(b) <= NARRATIVE_LIMITS.bulletWords;
  const out: string[] = [];
  for (const b of candidates.map(clean)) if (ok(b) && !out.includes(b) && out.length < max) out.push(b);
  for (const b of fallbacks) if (out.length < min && !out.includes(b)) out.push(b);
  return out;
}

/**
 * Deterministic, no-AI narrative drafter for the v4 contract. Every field is
 * built from metrics, trends, scorecard evidence, ticket insights and
 * attached-report findings, inside the word and count limits by
 * construction, and every figure comes from the bundle so it passes
 * verification. Used as the offline fallback when no Claude key is
 * configured, and as a deterministic baseline in tests.
 */
export function draftOfflineNarrative(input: NarrativeInput): NarrativeOutput {
  const figures: NarrativeOutput['figures_referenced'] = [];
  const cite: Cite = (label, value) => {
    figures.push({ label, value: String(value) });
    return String(value);
  };
  const trend = (key: string): MetricTrend | undefined => input.trends.find((t) => t.key === key);
  const num = (key: string): number | null => {
    const m = input.metrics.find((x) => x.key === key);
    return typeof m?.value === 'number' ? m.value : null;
  };
  const sc = input.scorecard;
  const rating = sc.overall.rating;

  // ── Movers: the biggest good/bad changes with a prior quarter to compare.
  const movers = input.trends
    .filter(
      (t) =>
        t.current !== null &&
        t.previous !== null &&
        t.previous !== 0 &&
        t.deltaPct !== null &&
        (t.sentiment === 'positive' || t.sentiment === 'negative') &&
        !MOVER_EXCLUDE.test(t.key),
    )
    .sort((a, b) => Math.abs(b.deltaPct as number) - Math.abs(a.deltaPct as number));

  const headline = draftHeadline(input, movers);
  const lede = draftLede(input, cite, trend);
  const did = draftDid(input, cite, num);
  const saw = draftSaw(input, cite, num, movers);
  const decisions = draftDecisions(input, cite, num);
  const plan = draftPlan(input);
  const protection = draftProtection(input, cite, num);

  return {
    headline,
    lede,
    did,
    saw,
    decisions,
    plan,
    protection,
    section_summaries: draftSectionSummaries(input, cite),
    figures_referenced: figures,
  };

  function draftHeadline(inp: NarrativeInput, ranked: MetricTrend[]): string {
    const phrase = (t: MetricTrend) => {
      const dir = t.direction === 'up' ? 'up' : 'down';
      const known = MOVER_PHRASE[t.key];
      return known ? known[dir] : `${t.label} ${dir}`;
    };
    const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
    if (ranked.length >= 2) {
      const base = `${phrase(ranked[0]!)}, ${lower(phrase(ranked[1]!))}`;
      const tail = RATING_TAIL[rating];
      const withTail = tail ? `${base}, ${tail}` : base;
      if (wordCount(withTail) <= NARRATIVE_LIMITS.headlineWords) return clean(withTail);
      if (wordCount(base) <= NARRATIVE_LIMITS.headlineWords) return clean(base);
    }
    const label = inp.period.label;
    return rating === 'unknown'
      ? `${label}: not enough data to rate security posture this quarter`
      : rating === 'green'
        ? `${label}: strong, actively managed security posture`
        : rating === 'amber'
          ? `${label}: stable quarter with targeted improvements ahead`
          : `${label}: focus areas identified for risk reduction`;
  }

  function draftLede(inp: NarrativeInput, c: Cite, tr: (key: string) => MetricTrend | undefined): string {
    const sentences: string[] = [];
    const tickets = tr('tickets.total');
    if (tickets && tickets.current !== null) {
      if (tickets.previous !== null && tickets.deltaPct !== null && tickets.direction !== 'flat' && tickets.direction !== 'na') {
        sentences.push(
          `Support volume was ${c('tickets this quarter', tickets.current)} tickets this quarter, ${tickets.direction} ${c('ticket change %', Math.abs(tickets.deltaPct))}% from ${c('tickets last quarter', tickets.previous)} the quarter before.`,
        );
      } else {
        sentences.push(`Support volume was ${c('tickets this quarter', tickets.current)} tickets this quarter.`);
      }
    }
    if (sc.overall.score !== null) {
      sentences.push(
        `Security posture rates ${rating} at ${c('maturity score', sc.overall.score)} out of 100, with ${c('control coverage %', Math.round(sc.overall.coverage * 100))}% of the controls we check measured.`,
      );
    } else {
      sentences.push('There was not enough security data to score posture this quarter.');
    }
    if (inp.goals?.length) sentences.push('The work this quarter supports the goals you set with us.');
    return fit(sentences.map(clean), NARRATIVE_LIMITS.ledeWords);
  }

  function draftDid(inp: NarrativeInput, c: Cite, n: (key: string) => number | null): string[] {
    const items: string[] = [];
    const closed = n('tickets.closed');
    const total = n('tickets.total');
    if (closed !== null && closed > 0) items.push(`Closed ${c('tickets closed', closed)} support ${plural(closed, 'ticket')} this quarter.`);
    else if (total !== null && total > 0) items.push(`Handled ${c('tickets handled', total)} support ${plural(total, 'ticket')} this quarter.`);
    const installed = n('patch.installed_quarter');
    if (installed !== null && installed > 0) items.push(`Installed ${c('updates installed', installed)} ${plural(installed, 'update')} across managed devices.`);
    const blocked = n('email.threats_blocked');
    if (blocked !== null && blocked > 0) items.push(`Blocked ${c('email threats blocked', blocked)} email ${plural(blocked, 'threat')} before they reached inboxes.`);
    const malware = n('huntress.blocked_malware') ?? n('huntress.malware_blocked');
    if (malware !== null && malware > 0) items.push(`Stopped ${c('malware blocked', malware)} malware ${plural(malware, 'file')} before ${malware === 1 ? 'it' : 'they'} ran.`);
    const m365 = n('backup.m365_accounts') ?? n('backup.protected_accounts');
    if (m365 !== null && m365 > 0) items.push(`Kept ${c('M365 accounts backed up', m365)} M365 ${plural(m365, 'account')} under backup.`);
    const endpoints = n('huntress.endpoints');
    if (endpoints !== null && endpoints > 0) items.push(`Watched ${c('protected endpoints', endpoints)} ${plural(endpoints, 'endpoint')} with managed detection and response.`);
    void inp;
    return bullets(items, [
      'Monitored your environment and responded to alerts.',
      'Kept security tools current and reviewed their findings.',
      'Prepared this quarterly review of your IT.',
    ], NARRATIVE_LIMITS.didMin, NARRATIVE_LIMITS.didMax);
  }

  function draftSaw(inp: NarrativeInput, c: Cite, n: (key: string) => number | null, ranked: MetricTrend[]): string[] {
    const items: string[] = [];
    for (const t of ranked.filter((m) => m.sentiment === 'negative').slice(0, 2)) {
      items.push(`${t.label} ${t.direction === 'up' ? 'rose' : 'fell'} ${c(`${t.label} change %`, Math.abs(t.deltaPct as number))}% from last quarter.`);
    }
    const breaches = n('sla.breaches');
    if (breaches !== null && breaches > 0) items.push(`${c('SLA breaches', breaches)} ${plural(breaches, 'ticket')} missed ${breaches === 1 ? 'its' : 'their'} response target.`);
    for (const doc of inp.documents ?? []) for (const f of doc.findings ?? []) if (f.severity !== 'info') items.push(f.text);
    const pending = n('patch.pending');
    if (pending !== null && pending > 0) items.push(`${c('updates pending', pending)} ${plural(pending, 'update')} ${pending === 1 ? 'is' : 'are'} waiting to install.`);
    const expired = n('assets.warranty_expired');
    if (expired !== null && expired > 0) items.push(`${c('devices out of warranty', expired)} ${plural(expired, 'device')} ${expired === 1 ? 'is' : 'are'} past warranty.`);
    const failed = n('backup.failed_jobs');
    if (failed !== null && failed > 0) items.push(`${c('failed backup jobs', failed)} backup ${plural(failed, 'job')} failed this quarter.`);
    const noMfa = n('identity.users_without_mfa');
    if (noMfa !== null && noMfa > 0) items.push(`${c('accounts without MFA', noMfa)} ${plural(noMfa, 'account')} ${noMfa === 1 ? 'has' : 'have'} no MFA.`);
    for (const doc of inp.documents ?? []) for (const f of doc.findings ?? []) if (f.severity === 'info') items.push(f.text);
    return bullets(items, [
      'No other trend in the data needs attention this quarter.',
      'The detailed figures are in Quarter in numbers.',
      'The protection page shows where each safeguard stands.',
    ], NARRATIVE_LIMITS.didMin, NARRATIVE_LIMITS.didMax);
  }

  function draftDecisions(inp: NarrativeInput, c: Cite, n: (key: string) => number | null): NarrativeDecision[] {
    const out: NarrativeDecision[] = [];
    const expired = n('assets.warranty_expired');
    if (expired !== null && expired > 0) {
      out.push({
        ask: `Approve replacing the ${c('devices out of warranty', expired)} ${plural(expired, 'device')} past warranty`,
        why: 'Devices past warranty are out of vendor support.',
      });
    }
    const pending = n('patch.pending');
    const patching = inp.scorecard.remediations.find((r) => /patch/i.test(r.title));
    if ((pending !== null && pending > 0) || patching) {
      out.push({
        ask: 'Agree a monthly maintenance window for pending updates',
        why: pending !== null && pending > 0 ? `${c('updates pending', pending)} ${plural(pending, 'update')} ${pending === 1 ? 'is' : 'are'} waiting to install.` : 'Patch compliance is below target.',
      });
    }
    const noMfa = n('identity.users_without_mfa');
    const mfa = inp.scorecard.remediations.find((r) => /multi-factor/i.test(r.title));
    if ((noMfa !== null && noMfa > 0) || mfa) out.push({ ask: 'Approve enforcing MFA on every account', why: 'Accounts without MFA are the easiest way in.' });
    return out.slice(0, NARRATIVE_LIMITS.decisionsMax);
  }

  function draftPlan(inp: NarrativeInput): NarrativeOutput['plan'] {
    const now: PlanItem[] = (inp.ticketInsights ?? []).slice(0, NARRATIVE_LIMITS.planPerColumn).map((i) => ({
      action: clean(`${i.title}. ${i.detail}`),
      owner: 'Mash IT',
      decision: false,
    }));
    const REMEDIATION_ACTION: Array<{ match: RegExp; action: string; decision: boolean }> = [
      { match: /lifecycle|asset/i, action: 'Quote replacements for devices past warranty', decision: true },
      { match: /patch/i, action: 'Hold the first maintenance window for pending updates', decision: true },
      { match: /multi-factor/i, action: 'Enforce MFA on the remaining accounts', decision: true },
      { match: /backup|recovery/i, action: 'Fix failing backups and confirm coverage', decision: false },
      { match: /email/i, action: 'Tighten email filtering after malicious clicks', decision: false },
      { match: /training/i, action: 'Raise training completion with reminders', decision: false },
      { match: /detection|identity threat|incident/i, action: 'Review open security findings with you', decision: false },
    ];
    const next: PlanItem[] = [];
    for (const r of inp.scorecard.remediations) {
      if (next.length >= NARRATIVE_LIMITS.planPerColumn) break;
      const mapped = REMEDIATION_ACTION.find((m) => m.match.test(r.title));
      const item = mapped
        ? { action: mapped.action, owner: 'Mash IT', decision: mapped.decision }
        : { action: clean(`Improve ${r.title.toLowerCase()}`), owner: 'Mash IT', decision: false };
      if (!next.some((p) => p.action === item.action)) next.push(item);
    }
    const later: PlanItem[] = [{ action: 'Review progress together at the next quarterly review', owner: 'Mash IT', decision: false }];
    return { now, next, later };
  }

  function draftProtection(inp: NarrativeInput, c: Cite, n: (key: string) => number | null): NarrativeProtection[] {
    const groups = new Map((inp.scorecard.protection ?? []).map((g) => [g.question, g]));
    const RATED: Record<string, string> = { green: 'Strong this quarter.', amber: 'Worth watching this quarter.', red: 'Needs action this quarter.' };
    const thisQuarter = (id: ProtectionQuestionId): string[] => {
      const out: string[] = [];
      if (id === 'get_in') {
        const blocked = n('email.threats_blocked');
        const clicks = n('email.malicious_clicks');
        if (blocked !== null) out.push(`${c('email threats blocked', blocked)} email ${plural(blocked, 'threat')} blocked before delivery.`);
        if (clicks !== null) out.push(`${c('malicious clicks', clicks)} malicious link ${plural(clicks, 'click')}.`);
        const mfa = n('identity.mfa_coverage_pct');
        if (mfa !== null) out.push(`MFA covers ${c('MFA coverage %', mfa)}% of users.`);
      } else if (id === 'know') {
        const incidents = n('huntress.edr_incidents');
        const compromises = n('huntress.identity_compromises');
        if (incidents !== null) out.push(`${c('EDR incidents', incidents)} endpoint ${plural(incidents, 'incident')} this quarter.`);
        if (compromises !== null) out.push(`${c('identity compromises', compromises)} account ${plural(compromises, 'compromise')}.`);
      } else if (id === 'recover') {
        const success = n('backup.success_pct');
        const failed = n('backup.failed_jobs');
        if (success !== null) out.push(`Backup success rate was ${c('backup success %', success)}%.`);
        if (failed !== null) out.push(`${c('failed backup jobs', failed)} failed backup ${plural(failed, 'job')}.`);
      } else if (id === 'keep_up') {
        const installed = n('patch.installed_quarter');
        const patch = n('patch.compliance_pct');
        const expired = n('assets.warranty_expired');
        if (installed !== null) out.push(`${c('updates installed', installed)} ${plural(installed, 'update')} installed.`);
        if (patch !== null) out.push(`Patch compliance at ${c('patch compliance %', patch)}%.`);
        if (expired !== null) out.push(`${c('devices out of warranty', expired)} ${plural(expired, 'device')} past warranty.`);
      } else {
        const sat = n('sat.completion_pct');
        if (sat !== null) out.push(`Training completion at ${c('training completion %', sat)}%.`);
        out.push('This quarterly review was held with documented decisions.');
      }
      return out;
    };
    return PROTECTION_QUESTIONS.map((q) => {
      const group = groups.get(q.id);
      const evidence = (group?.safeguards ?? []).map((sg) => clean(sg.evidence));
      const rated = group ? RATED[group.rating] : undefined;
      const happened = thisQuarter(q.id);
      return {
        question: q.id,
        inPlace: evidence.length ? fitOrCut(evidence, NARRATIVE_LIMITS.protectionWords) : 'Not measured by our connected tools this quarter.',
        thisQuarter: fitOrCut(
          (happened.length ? [...(rated ? [rated] : []), ...happened] : [rated ?? 'No data from connected tools this quarter.']).map(clean),
          NARRATIVE_LIMITS.protectionWords,
        ),
      };
    });
  }
}

/**
 * One deterministic executive sentence per metric category present in the
 * bundle: the offline stand-in for the AI's section_summaries.
 */
function draftSectionSummaries(input: NarrativeInput, cite: Cite): NarrativeOutput['section_summaries'] {
  const out: Array<{ category: string; summary: string }> = [];
  const has = (category: string) => input.metrics.some((m) => m.category === category);
  const num = (key: string): number | null => {
    const m = input.metrics.find((x) => x.key === key);
    return typeof m?.value === 'number' ? m.value : null;
  };

  if (has('operations')) {
    const total = num('tickets.total');
    const open = num('tickets.open');
    if (total !== null) {
      const backlog = open !== null ? ` with ${cite('open tickets', open)} open at quarter end` : '';
      out.push({ category: 'operations', summary: `The team handled ${cite('tickets handled', total)} support requests this quarter${backlog}.` });
    } else {
      out.push({ category: 'operations', summary: 'Support operations ran under active management this quarter.' });
    }
  }
  if (has('security')) {
    const sc = input.scorecard.overall;
    out.push({
      category: 'security',
      summary:
        sc.score !== null
          ? `Layered monitoring kept the environment protected; overall security maturity rates ${sc.rating} at ${cite('security maturity', sc.score)}/100.`
          : 'There is not enough data this quarter to rate overall security maturity.',
    });
  }
  if (has('identity')) {
    const mfa = num('identity.mfa_coverage_pct');
    out.push({
      category: 'identity',
      summary:
        mfa !== null
          ? `${cite('MFA coverage', mfa)}% of user accounts are protected by multi-factor authentication.`
          : 'User accounts and access are actively managed.',
    });
  }
  if (has('backup')) {
    const failed = num('backup.failed_jobs');
    out.push({
      category: 'backup',
      // Absent is not zero: without a failure count, don't vouch for backup health.
      summary:
        failed === null
          ? 'Backup job failures were not measured this quarter, so backup success cannot be confirmed from this data.'
          : failed > 0
            ? `Backups are running with ${cite('failing backups', failed)} ${plural(failed, 'device')} needing attention.`
            : 'Backups ran with no failed jobs recorded this quarter.',
    });
  }
  if (has('infrastructure')) {
    const expired = num('assets.warranty_expired');
    out.push({
      category: 'infrastructure',
      // Absent is not zero: without warranty data, don't claim the fleet is current.
      summary:
        expired === null
          ? 'Warranty status was not measured this quarter, so refresh risk cannot be assessed from this data.'
          : expired > 0
            ? `${cite('devices out of warranty', expired)} ${plural(expired, 'device')} ${expired === 1 ? 'is' : 'are'} past warranty and should be planned for refresh.`
            : 'No devices are past warranty this quarter.',
    });
  }
  if (has('spend')) {
    out.push({ category: 'spend', summary: 'IT investment for the quarter is broken down below.' });
  }
  return out;
}
