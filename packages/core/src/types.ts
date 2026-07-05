/**
 * Core domain types for the Mash IT QBR tool.
 *
 * These are deliberately framework-agnostic (no Azure / DB / HTTP types) so the
 * same model is shared by the API, the report renderer, and the React frontend.
 */

/** Identifier for an upstream data source / integration. */
export type IntegrationId =
  | 'halo'
  | 'ninja'
  | 'hudu'
  | 'huntress'
  | 'checkpoint'
  | 'cipp'
  | 'domotz'
  | 'dropsuite'
  | 'printix'
  | 'connectsecure'
  | 'googleworkspace'
  | 'synology'
  | 'manual'
  // Metrics imported from a filed document (AI extraction), e.g. pdf:check-point.
  | `pdf:${string}`;

/** High-level grouping a metric belongs to (drives report section placement). */
export type MetricCategory =
  | 'operations'
  | 'security'
  | 'identity'
  | 'backup'
  | 'infrastructure'
  | 'spend';

/** Runtime list of the categories (validation + AI schema enums). */
export const METRIC_CATEGORIES: readonly MetricCategory[] = ['operations', 'security', 'identity', 'backup', 'infrastructure', 'spend'];

/** A normalized, point-in-time metric value collected from an integration. */
export interface MetricValue {
  /** Canonical, dotted key (e.g. `tickets.total`, `email.phishing`). */
  key: string;
  /** Human-readable label for reports. */
  label: string;
  /** Numeric metrics drive trends; string/bool/null are for descriptive values. */
  value: number | string | boolean | null;
  /** e.g. `%`, `count`, `USD`, `TB`, `events`. */
  unit?: string;
  source: IntegrationId;
  category: MetricCategory;
  /**
   * For numeric metrics, whether a higher value is "good". Used to color trends.
   * Omit for metrics where direction has no inherent sentiment.
   */
  higherIsBetter?: boolean;
  /**
   * Backing rows for drill-down — the tickets behind a count, the invoice
   * lines behind a spend figure. Capped small at collection time; shown by
   * the Data tab's viewer and deliberately excluded from the AI narrative
   * input and the rendered report tables.
   */
  details?: Array<Record<string, string | number>>;
}

/** A captured set of metrics for one client for one reporting period. */
export interface MetricSnapshot {
  clientId: string;
  /** Period identifier, e.g. `2026-Q1`. See period.ts. */
  period: string;
  /** ISO-8601 timestamp the snapshot was captured/seeded. */
  capturedAt: string;
  metrics: MetricValue[];
}

export type Quarter = 1 | 2 | 3 | 4;

/** A reporting period (a calendar quarter). */
export interface Period {
  id: string; // `2026-Q1`
  year: number;
  quarter: Quarter;
  /** Inclusive ISO date (YYYY-MM-DD) of the first day of the quarter. */
  start: string;
  /** Inclusive ISO date (YYYY-MM-DD) of the last day of the quarter. */
  end: string;
  label: string; // `Q1 2026`
}

export type TrendDirection = 'up' | 'down' | 'flat' | 'na';
/** Whether a change is good/bad for the business, after applying higherIsBetter. */
export type TrendSentiment = 'positive' | 'negative' | 'neutral' | 'na';

/** A computed quarter-over-quarter trend for a single metric. */
export interface MetricTrend {
  key: string;
  label: string;
  unit?: string;
  category: MetricCategory;
  current: number | null;
  previous: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  direction: TrendDirection;
  sentiment: TrendSentiment;
}

/** Red/Amber/Green (+unknown when a control could not be measured). */
export type Rating = 'green' | 'amber' | 'red' | 'unknown';

/** NIST CSF 2.0 functions. */
export type NistFunction =
  | 'GOVERN'
  | 'IDENTIFY'
  | 'PROTECT'
  | 'DETECT'
  | 'RESPOND'
  | 'RECOVER';

/** The outcome of evaluating one safeguard against a metric bundle. */
export interface SafeguardResult {
  id: string;
  title: string;
  /** CIS Controls v8 reference, e.g. `CIS 6 — Access Control Management`. */
  cisControl: string;
  nistFunction: NistFunction;
  weight: number;
  /** 0..100 when measured, otherwise null. */
  score: number | null;
  rating: Rating;
  /** Human-readable evidence (used in reports / remediation lists). */
  evidence: string;
  /** Which integration the evidence came from, if any. */
  source?: IntegrationId;
  measured: boolean;
}

export interface FunctionScore {
  function: NistFunction;
  /** Weighted average of measured safeguards, 0..100, or null if none measured. */
  score: number | null;
  rating: Rating;
  safeguards: SafeguardResult[];
}

/** The full blended CIS v8 / NIST CSF 2.0 maturity scorecard for a client/period. */
export interface MaturityScorecard {
  clientId: string;
  period: string;
  overall: {
    score: number | null;
    rating: Rating;
    /** Fraction of total safeguard weight that could actually be measured (0..1). */
    coverage: number;
  };
  functions: FunctionScore[];
  safeguards: SafeguardResult[];
  /** Amber/red measured safeguards, worst-first, to seed the roadmap. */
  remediations: SafeguardResult[];
}

export type QbrStatus =
  | 'draft'
  | 'data_synced'
  | 'narrative_approved'
  | 'scheduled'
  | 'completed'
  | 'dispositioned'
  | 'actions_pushed'
  | 'archived';

export type ActionDisposition =
  | 'pending'
  | 'create_opportunity'
  | 'create_ticket'
  | 'accept_risk'
  | 'no_action';

export interface QbrAction {
  id: string;
  title: string;
  detail: string;
  disposition: ActionDisposition;
  /** Free-text client response captured during the meeting (the "- Anne to…" notes). */
  clientResponse?: string;
  /** External system id once pushed (Zomentum opp id / Halo ticket id). */
  externalRef?: { system: 'zomentum' | 'halo'; id: string; status?: string };
  owner?: string;
}

export interface ClientContact {
  name: string;
  email?: string;
  role?: string;
}

/** Report branding. All fields optional; unset fields fall back to Mash IT defaults. */
export interface Brand {
  name?: string;
  /** Logo as a data: URI so it embeds in the self-contained HTML/PDF. */
  logoDataUri?: string;
  primary?: string;
  accent?: string;
  ink?: string;
  font?: string;
}

/** A client-authored free-text section added to the report. */
export interface CustomSection {
  id: string;
  title: string;
  /** Plain text; blank lines separate paragraphs. */
  body: string;
  placement?: 'after-summary' | 'in-body' | 'end';
}

/**
 * Org-level self-scheduling rules for the client-facing booking page
 * (Microsoft Bookings-style). Every field optional — defaults applied at use.
 */
export interface BookingSettings {
  /** Whose M365 calendar hosts the meetings (availability + invites). */
  organizerEmail?: string;
  /** Meeting title on the invite (default "Quarterly Business Review"). */
  title?: string;
  /** Short blurb shown on the booking page and invite body. */
  description?: string;
  durationMinutes?: number;
  /** Slot start granularity in minutes (default 30). */
  incrementMinutes?: number;
  /** Bookable weekdays, 0=Sunday … 6=Saturday (default Mon–Fri). */
  daysOfWeek?: number[];
  /** Bookable window each day, 24h "HH:mm" local (default 09:00–17:00). */
  dayStart?: string;
  dayEnd?: string;
  /** IANA timezone the windows are defined in (default America/Detroit). */
  timezone?: string;
  /** Minimum notice before a slot can be booked (default 24h). */
  leadHours?: number;
  /** How far ahead clients may book (default 45 days). */
  maxDaysOut?: number;
}

/** Per-client report customization (sections + branding). */
export interface ReportConfig {
  clientId: string;
  /** Standard metric sections to omit for this client. */
  hiddenSections?: MetricCategory[];
  /** Individual metric keys reviewed out of the report (Data tab). */
  excludedMetrics?: string[];
  customSections?: CustomSection[];
  brand?: Brand;
  /** Narrative direction: what this QBR should emphasize (drives the AI). */
  narrativeFocus?: string;
  /** Free-form standing guidance for the AI narrative. */
  narrativeGuidance?: string;
  /** Per-section guidance/comments, keyed by MetricCategory. */
  sectionGuidance?: Partial<Record<MetricCategory, string>>;
  /** Org-level (stored on the org settings record): booking-page rules. */
  booking?: BookingSettings;
}

/** One captured discussion point from the QBR review (question/decision + response). */
export interface DiscussionItem {
  id: string;
  /** The talking point, question, or decision raised. */
  topic: string;
  /** The client's response / notes captured live (the "- Anne to…" capture). */
  response?: string;
  disposition?: ActionDisposition;
  owner?: string;
  /** Pre-wired before the meeting ('planned') vs answered during it ('discussed'). */
  status?: 'planned' | 'discussed';
  /** Whether this item lands on the final report (default true). */
  includeInReport?: boolean;
  /** Manual ordering for the meeting agenda (lower first). */
  sortOrder?: number;
  /** Set once pushed to an external system (Halo ticket / Zomentum opportunity). */
  externalRef?: { system: 'halo' | 'zomentum'; id: string; status?: string };
}

/** The review-time discussion + notes for a client's QBR. */
export interface QbrDiscussion {
  clientId: string;
  period: string;
  items: DiscussionItem[];
  /** General meeting notes not tied to a specific item. */
  notes?: string;
}

export interface Client {
  id: string;
  name: string;
  primaryContact?: ClientContact;
  /** Sector hint, used for benchmarking and HIPAA handling. */
  industry?: string;
  hipaa?: boolean;
  /** Compliance framework this client answers to (HIPAA, TISAX, SOC 2…). */
  complianceStandard?: string;
  /** Whether this client gets QBRs (undefined = true; Halo imports default false). */
  qbrEnabled?: boolean;
  /** Map of integration -> per-client external identifier (e.g. Halo client id). */
  integrationRefs?: Partial<Record<IntegrationId, string>>;
}

export interface Qbr {
  id: string;
  clientId: string;
  period: string;
  status: QbrStatus;
  heldBy?: string;
  meeting?: { eventId?: string; joinUrl?: string; heldAt?: string; attendees?: string[] };
  actions: QbrAction[];
  createdAt: string;
  updatedAt: string;
}
