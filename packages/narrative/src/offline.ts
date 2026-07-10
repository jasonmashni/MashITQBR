import type { MetricTrend } from '@mashit/core';
import type { NarrativeInput } from './input.js';
import type { NarrativeOutput } from './schema.js';

/**
 * Deterministic, no-AI narrative drafter. Produces a grounded "Quarter at a
 * glance" using only numbers from the metric bundle, so it passes figure
 * verification by construction. Used as the offline fallback when no Claude key
 * is configured, and as a deterministic baseline in tests.
 */
export function draftOfflineNarrative(input: NarrativeInput): NarrativeOutput {
  const figures: NarrativeOutput['figures_referenced'] = [];
  const cite = (label: string, value: string | number) => {
    figures.push({ label, value: String(value) });
    return String(value);
  };

  const trend = (key: string): MetricTrend | undefined => input.trends.find((t) => t.key === key);
  const metricNum = (key: string): number | null => {
    const m = input.metrics.find((x) => x.key === key);
    return typeof m?.value === 'number' ? m.value : null;
  };

  const paragraphs: string[] = [];

  // Operational volume
  const tickets = trend('tickets.total');
  if (tickets && tickets.current !== null) {
    if (tickets.previous !== null && tickets.deltaPct !== null) {
      const dir = tickets.direction === 'up' ? 'up' : tickets.direction === 'down' ? 'down' : 'flat from';
      paragraphs.push(
        `Support volume was ${cite('tickets this quarter', tickets.current)} tickets this quarter, ${dir} ${cite('ticket change %', Math.abs(tickets.deltaPct))}% from ${cite('tickets last quarter', tickets.previous)} the prior quarter.`,
      );
    } else {
      paragraphs.push(`Support volume was ${cite('tickets this quarter', tickets.current)} tickets this quarter.`);
    }
  }

  // Security posture
  const sc = input.scorecard;
  if (sc.overall.score !== null) {
    paragraphs.push(
      `Security and risk posture rates ${sc.overall.rating} at ${cite('maturity score', sc.overall.score)} out of 100 on the blended CIS Controls v8 / NIST CSF 2.0 model, with ${cite('control coverage %', Math.round(sc.overall.coverage * 100))}% of controls measured this quarter.`,
    );
  }

  // Email security
  const blocked = metricNum('email.threats_blocked');
  const clicks = metricNum('email.malicious_clicks');
  if (blocked !== null) {
    const clickClause = clicks !== null ? ` with ${cite('malicious clicks', clicks)} malicious link clicks` : '';
    paragraphs.push(`Email security blocked ${cite('email threats blocked', blocked)} threats before they reached inboxes${clickClause}.`);
  }

  const highlights: string[] = [];
  const av = metricNum('endpoints.av_coverage_pct');
  if (av !== null) highlights.push(`Endpoint AV coverage at ${cite('AV coverage %', av)}%.`);
  const patch = metricNum('patch.compliance_pct');
  if (patch !== null) highlights.push(`Patch compliance at ${cite('patch compliance %', patch)}%.`);
  const expired = metricNum('assets.warranty_expired');
  if (expired !== null) highlights.push(`${cite('devices out of warranty', expired)} devices are out of warranty.`);

  // Lead with the consultative ticket-history talking points (recurring issues,
  // SLA misses, change activity) — the specific beats the generic — then fill
  // out with security-hygiene remediations from the scorecard.
  const insightRecs = (input.ticketInsights ?? []).map((i) => `${i.title}. ${i.detail}`);
  const recommendations = [...insightRecs, ...sc.remediations.map((r) => `${r.title}: ${r.evidence}`)].slice(0, 6);

  const rating = sc.overall.rating;
  const headline =
    rating === 'green'
      ? `${input.period.label}: strong, actively managed security posture`
      : rating === 'amber'
        ? `${input.period.label}: stable quarter with targeted improvements ahead`
        : `${input.period.label}: focus areas identified for risk reduction`;

  return {
    headline,
    summary_paragraphs: paragraphs,
    highlights,
    recommendations,
    section_summaries: draftSectionSummaries(input, cite),
    figures_referenced: figures,
  };
}

/**
 * One deterministic executive sentence per metric category present in the
 * bundle — the offline stand-in for the AI's section_summaries.
 */
function draftSectionSummaries(
  input: NarrativeInput,
  cite: (label: string, value: string | number) => string,
): NarrativeOutput['section_summaries'] {
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
          : 'Layered monitoring kept the environment protected this quarter.',
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
      summary:
        failed !== null && failed > 0
          ? `Backups are running with ${cite('failing backups', failed)} device(s) needing attention.`
          : 'Backup coverage is in place and healthy.',
    });
  }
  if (has('infrastructure')) {
    const expired = num('assets.warranty_expired');
    out.push({
      category: 'infrastructure',
      summary:
        expired !== null && expired > 0
          ? `${cite('devices out of warranty', expired)} device(s) are past warranty and should be planned for refresh.`
          : 'The device fleet is current with no urgent refresh risk.',
    });
  }
  if (has('spend')) {
    out.push({ category: 'spend', summary: 'IT investment for the quarter is broken down below.' });
  }
  return out;
}
