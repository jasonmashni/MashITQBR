import { lookup, type MetricLookup } from './metrics.js';
import type {
  FunctionScore,
  IntegrationId,
  MaturityScorecard,
  MetricSnapshot,
  NistFunction,
  Rating,
  SafeguardResult,
} from './types.js';

/** "1 device" / "4 devices": client-facing copy never prints "(s)". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

const NIST_FUNCTIONS: NistFunction[] = [
  'GOVERN',
  'IDENTIFY',
  'PROTECT',
  'DETECT',
  'RESPOND',
  'RECOVER',
];

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

export function ratingFor(score: number | null): Rating {
  if (score === null) return 'unknown';
  if (score >= 80) return 'green';
  if (score >= 50) return 'amber';
  return 'red';
}

interface SafeguardEval {
  score: number;
  evidence: string;
  source?: IntegrationId;
}

interface SafeguardDefinition {
  id: string;
  title: string;
  cisControl: string;
  nistFunction: NistFunction;
  weight: number;
  /**
   * Returns an evaluation, or null when the bundle lacks the data to measure it.
   * `ctx.otherMeasured` is true when at least one non-governance safeguard was
   * measured (governance is evaluated last).
   */
  evaluate: (m: MetricLookup, ctx: SafeguardContext) => SafeguardEval | null;
}

interface SafeguardContext {
  otherMeasured: boolean;
}

/**
 * Blended CIS Controls v8 → NIST CSF 2.0 safeguard set.
 *
 * Weights are intentionally simple integers and are meant to be tunable via
 * config without code changes (see overrideWeights below). Each safeguard
 * returns `null` when its underlying signal isn't present, so the overall score
 * reflects only what was actually measured, and unmeasured controls surface as
 * coverage gaps rather than silently scoring zero.
 */
export const SAFEGUARDS: readonly SafeguardDefinition[] = [
  {
    id: 'mfa',
    title: 'Multi-Factor Authentication Coverage',
    cisControl: 'CIS 6 — Access Control Management',
    nistFunction: 'PROTECT',
    weight: 3,
    evaluate: (m) => {
      const pct = m.num('identity.mfa_coverage_pct');
      if (pct === null) return null;
      return { score: clamp(pct), evidence: `MFA coverage at ${pct}% of users.`, source: 'cipp' };
    },
  },
  {
    id: 'edr',
    title: 'Endpoint Detection & Response',
    cisControl: 'CIS 10 — Malware Defenses',
    nistFunction: 'DETECT',
    weight: 3,
    evaluate: (m) => {
      const endpoints = m.num('huntress.endpoints');
      if (endpoints === null) return null;
      const av = m.num('endpoints.av_coverage_pct');
      const reportedIncidents = m.num('huntress.edr_incidents');
      // Without an incident count or AV coverage there is nothing to grade;
      // an agent count alone must not read as a near-perfect score.
      if (av === null && reportedIncidents === null) return null;
      const incidents = reportedIncidents ?? 0;
      // Coverage-led score, lightly penalized for open/unresolved incidents.
      const base = av ?? 90;
      const score = clamp(base - incidents * 5);
      return {
        score,
        evidence: `EDR active on ${endpoints} endpoints; ${
          reportedIncidents === null ? 'incident count not reported' : `${incidents} ${plural(incidents, 'incident')} this period`
        }${av !== null ? `; ${av}% AV coverage` : ''}.`,
        source: 'huntress',
      };
    },
  },
  {
    id: 'patching',
    title: 'Patch Management & Vulnerability Remediation',
    cisControl: 'CIS 7 — Continuous Vulnerability Management',
    nistFunction: 'PROTECT',
    weight: 3,
    evaluate: (m) => {
      const pct = m.num('patch.compliance_pct') ?? m.num('patch.os_enablement_pct');
      if (pct === null) return null;
      return { score: clamp(pct), evidence: `Patch compliance at ${pct}%.`, source: 'ninja' };
    },
  },
  {
    id: 'email_security',
    title: 'Email Security & Anti-Phishing',
    cisControl: 'CIS 9 — Email & Web Browser Protections',
    nistFunction: 'PROTECT',
    weight: 2,
    evaluate: (m) => {
      if (!m.has('email.events_total') && !m.has('email.threats_blocked')) return null;
      // The click count is the graded input; without it the score would assume zero.
      const clicks = m.num('email.malicious_clicks');
      if (clicks === null) return null;
      const blocked = m.num('email.threats_blocked') ?? 0;
      const score = clamp(100 - clicks * 15);
      return {
        score,
        evidence: `${blocked} email ${plural(blocked, 'threat')} blocked; ${clicks} malicious ${plural(clicks, 'click')}.`,
        source: 'checkpoint',
      };
    },
  },
  {
    id: 'data_protection',
    title: 'Data Protection & DLP',
    cisControl: 'CIS 3 — Data Protection',
    nistFunction: 'PROTECT',
    weight: 2,
    evaluate: (m) => {
      if (!m.has('email.dlp_events')) return null;
      const dlp = m.num('email.dlp_events') ?? 0;
      const encrypted = m.num('email.auto_encrypted');
      return {
        score: 90, // a DLP policy is active and generating events as designed
        evidence: `DLP policy active, ${dlp} ${plural(dlp, 'event')}${
          encrypted !== null ? `, ${encrypted} auto-encrypted` : ''
        }.`,
        source: 'checkpoint',
      };
    },
  },
  {
    id: 'identity_threat',
    title: 'Identity Threat Detection (ITDR)',
    cisControl: 'CIS 6 — Access Control Management',
    nistFunction: 'DETECT',
    weight: 2,
    evaluate: (m) => {
      if (!m.has('huntress.m365_events')) return null;
      // The compromise count is the graded input; without it the score would assume zero.
      const compromises = m.num('huntress.identity_compromises');
      if (compromises === null) return null;
      return {
        score: clamp(95 - compromises * 20),
        evidence: `ITDR monitoring M365 identities; ${compromises} ${plural(compromises, 'compromise')}.`,
        source: 'huntress',
      };
    },
  },
  {
    id: 'siem',
    title: 'Audit Log Management & SIEM',
    cisControl: 'CIS 8 — Audit Log Management',
    nistFunction: 'DETECT',
    weight: 1,
    evaluate: (m) => {
      const logs = m.num('huntress.siem_logs');
      if (logs === null || logs <= 0) return null;
      return { score: 90, evidence: `SIEM ingesting logs (${logs} this period).`, source: 'huntress' };
    },
  },
  {
    id: 'sat',
    title: 'Security Awareness Training',
    cisControl: 'CIS 14 — Security Awareness & Skills Training',
    nistFunction: 'PROTECT',
    weight: 2,
    evaluate: (m) => {
      const pct = m.num('sat.completion_pct');
      if (pct === null) return null;
      const compromises = m.num('sat.phishing_compromises') ?? 0;
      return {
        score: clamp(pct - compromises * 5),
        evidence: `Training completion ${pct}%; ${compromises} simulated phishing ${plural(compromises, 'compromise')}.`,
        source: 'huntress',
      };
    },
  },
  {
    id: 'backup',
    title: 'Data Recovery & Backup',
    cisControl: 'CIS 11 — Data Recovery',
    nistFunction: 'RECOVER',
    weight: 3,
    evaluate: (m) => {
      const success = m.num('backup.success_pct');
      const protectedDevices = m.num('backup.devices_protected');
      const m365 = m.num('backup.m365_accounts');
      if (success === null && protectedDevices === null && m365 === null) return null;
      const score = success ?? (protectedDevices || m365 ? 85 : 50);
      return {
        score: clamp(score),
        evidence:
          success !== null
            ? `Backup success rate ${success}%.`
            : `Backups protecting ${protectedDevices ?? 0} ${plural(protectedDevices ?? 0, 'device')}, ${m365 ?? 0} M365 ${plural(m365 ?? 0, 'account')}.`,
        source: 'ninja',
      };
    },
  },
  {
    id: 'asset_inventory',
    title: 'Hardware Lifecycle & Asset Inventory',
    cisControl: 'CIS 1 — Inventory & Control of Enterprise Assets',
    nistFunction: 'IDENTIFY',
    weight: 1,
    evaluate: (m) => {
      const expired = m.num('assets.warranty_expired');
      if (expired === null) return null;
      return {
        score: clamp(100 - expired * 5),
        evidence: `${expired} ${plural(expired, 'device')} out of warranty.`,
        source: 'ninja',
      };
    },
  },
  {
    id: 'incident_response',
    title: 'Incident Response',
    cisControl: 'CIS 17 — Incident Response Management',
    nistFunction: 'RESPOND',
    weight: 1,
    evaluate: (m) => {
      if (!m.has('huntress.endpoints')) return null;
      return {
        score: 85,
        evidence: 'Managed detection & response with 24/7 SOC escalation in place.',
        source: 'huntress',
      };
    },
  },
  {
    id: 'governance',
    title: 'Governance & Strategic Review Cadence',
    cisControl: 'CIS 17 — Incident Response Management (governance)',
    nistFunction: 'GOVERN',
    weight: 1,
    // Structural: a QBR is being produced, so governance cadence is satisfied,
    // but only counts once some real security signal was measured. On its own
    // it would turn an empty snapshot into an 80/green scorecard.
    evaluate: (_m, ctx) =>
      ctx.otherMeasured
        ? {
            score: 80,
            evidence: 'Quarterly business review cadence maintained with documented decisions.',
          }
        : null,
  },
];

function weightedAverage(items: Array<{ score: number; weight: number }>): number | null {
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  if (totalWeight === 0) return null;
  const sum = items.reduce((s, i) => s + i.score * i.weight, 0);
  return Math.round((sum / totalWeight) * 10) / 10;
}

/**
 * Compute the blended maturity scorecard for a client/period from a metric
 * snapshot. Weight overrides allow tuning without code changes.
 */
export function computeScorecard(
  snapshot: MetricSnapshot,
  overrideWeights: Record<string, number> = {},
): MaturityScorecard {
  const m = lookup(snapshot);

  // Evaluate every non-governance safeguard first so governance can tell
  // whether anything else was measured.
  const evaluations = new Map<string, SafeguardEval | null>();
  for (const def of SAFEGUARDS) {
    if (def.id !== 'governance') evaluations.set(def.id, def.evaluate(m, { otherMeasured: false }));
  }
  const otherMeasured = [...evaluations.values()].some((e) => e !== null);
  for (const def of SAFEGUARDS) {
    if (def.id === 'governance') evaluations.set(def.id, def.evaluate(m, { otherMeasured }));
  }

  const safeguards: SafeguardResult[] = SAFEGUARDS.map((def) => {
    const weight = overrideWeights[def.id] ?? def.weight;
    const evaluation = evaluations.get(def.id) ?? null;
    if (!evaluation) {
      return {
        id: def.id,
        title: def.title,
        cisControl: def.cisControl,
        nistFunction: def.nistFunction,
        weight,
        score: null,
        rating: 'unknown',
        evidence: 'Not measured — no data from connected sources this period.',
        measured: false,
      };
    }
    const score = Math.round(evaluation.score * 10) / 10;
    return {
      id: def.id,
      title: def.title,
      cisControl: def.cisControl,
      nistFunction: def.nistFunction,
      weight,
      score,
      rating: ratingFor(score),
      evidence: evaluation.evidence,
      source: evaluation.source,
      measured: true,
    };
  });

  const functions: FunctionScore[] = NIST_FUNCTIONS.map((fn) => {
    const fnSafeguards = safeguards.filter((s) => s.nistFunction === fn);
    const measured = fnSafeguards.filter((s) => s.measured && s.score !== null);
    const score = weightedAverage(
      measured.map((s) => ({ score: s.score as number, weight: s.weight })),
    );
    return { function: fn, score, rating: ratingFor(score), safeguards: fnSafeguards };
  });

  const measuredSafeguards = safeguards.filter((s) => s.measured && s.score !== null);
  let overallScore = weightedAverage(
    measuredSafeguards.map((s) => ({ score: s.score as number, weight: s.weight })),
  );

  const totalWeight = safeguards.reduce((sum, s) => sum + s.weight, 0);
  const measuredWeight = measuredSafeguards.reduce((sum, s) => sum + s.weight, 0);
  const coverage = totalWeight === 0 ? 0 : Math.round((measuredWeight / totalWeight) * 100) / 100;
  const confidence = scorecardConfidence(coverage);

  // Withhold the overall score when too little was measured to trust it, or
  // when governance (structural, not a measurement) is all there is.
  const governanceOnly =
    measuredSafeguards.length > 0 && measuredSafeguards.every((s) => s.id === 'governance');
  if (confidence === 'low' || governanceOnly) overallScore = null;

  const remediations = measuredSafeguards
    .filter((s) => s.rating === 'amber' || s.rating === 'red')
    .sort((a, b) => (a.score as number) - (b.score as number));

  return {
    clientId: snapshot.clientId,
    period: snapshot.period,
    overall: { score: overallScore, rating: ratingFor(overallScore), coverage, confidence },
    functions,
    safeguards,
    remediations,
  };
}

/**
 * How much to trust an overall score given the measured share of safeguard
 * weight: below 0.4 the score is withheld, below 0.7 it is provisional.
 */
export function scorecardConfidence(coverage: number): 'low' | 'medium' | 'high' {
  return coverage < 0.4 ? 'low' : coverage < 0.7 ? 'medium' : 'high';
}
