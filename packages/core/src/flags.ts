import type { MetricSnapshot, Rating } from './types.js';

/** An attention flag surfaced on the admin dashboard. */
export interface ClientFlag {
  severity: 'red' | 'amber';
  label: string;
}

const RATING_ORDER: Rating[] = ['red', 'amber', 'green'];

function metricNum(s: MetricSnapshot | undefined, key: string): number | undefined {
  const v = s?.metrics.find((m) => m.key === key)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Derive the potential-issue flags an admin wants at a glance: posture gaps,
 * failing backups, expired hardware, open criticals, maturity drops, and
 * spend spikes. Pure over the snapshots (plus the computed ratings) so it's
 * cheap enough to run per client on every dashboard load.
 */
export function computeFlags(
  current: MetricSnapshot | undefined,
  previous?: MetricSnapshot,
  ratings?: { current: Rating; previous?: Rating },
): ClientFlag[] {
  const flags: ClientFlag[] = [];
  if (!current) return flags;
  const n = (key: string) => metricNum(current, key);

  const patch = n('patch.compliance_pct');
  if (patch !== undefined && patch < 80) flags.push({ severity: patch < 60 ? 'red' : 'amber', label: `Patch compliance ${Math.round(patch)}%` });

  const mfa = n('identity.mfa_coverage_pct');
  if (mfa !== undefined && mfa < 90) flags.push({ severity: mfa < 70 ? 'red' : 'amber', label: `MFA coverage ${Math.round(mfa)}%` });

  const av = n('endpoints.av_coverage_pct');
  if (av !== undefined && av < 90) flags.push({ severity: av < 70 ? 'red' : 'amber', label: `AV coverage ${Math.round(av)}%` });

  const failedBackups = n('backup.failed_jobs');
  if (failedBackups !== undefined && failedBackups > 0) flags.push({ severity: 'red', label: `${failedBackups} failing backup${failedBackups === 1 ? '' : 's'}` });

  const warranty = n('assets.warranty_expired');
  if (warranty !== undefined && warranty > 0) flags.push({ severity: 'amber', label: `${warranty} device${warranty === 1 ? '' : 's'} out of warranty` });

  const criticals = n('vuln.critical');
  if (criticals !== undefined && criticals > 0) flags.push({ severity: 'red', label: `${criticals} critical vulnerabilit${criticals === 1 ? 'y' : 'ies'}` });

  const incidents = n('huntress.edr_incidents');
  if (incidents !== undefined && incidents > 0) flags.push({ severity: 'amber', label: `${incidents} security incident${incidents === 1 ? '' : 's'}` });

  // Maturity rating regression quarter-over-quarter.
  if (ratings?.previous && ratings.previous !== 'unknown' && ratings.current !== 'unknown') {
    if (RATING_ORDER.indexOf(ratings.current) < RATING_ORDER.indexOf(ratings.previous)) {
      flags.push({ severity: 'red', label: `Maturity dropped (${ratings.previous} → ${ratings.current})` });
    }
  }

  // Spend spike vs the prior quarter (>20% up flags for a conversation).
  const spendNow = n('finance.quarter_invoiced');
  const spendPrev = metricNum(previous, 'finance.quarter_invoiced');
  if (spendNow !== undefined && spendPrev !== undefined && spendPrev > 0) {
    const deltaPct = ((spendNow - spendPrev) / spendPrev) * 100;
    if (deltaPct >= 20) flags.push({ severity: 'amber', label: `Spend up ${Math.round(deltaPct)}% QoQ` });
  }

  // Red flags first, then ambers, capped so the dashboard row stays readable.
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1)).slice(0, 5);
}
