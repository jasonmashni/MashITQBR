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

  const recommendations = sc.remediations.map((r) => `${r.title}: ${r.evidence}`);

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
    figures_referenced: figures,
  };
}
