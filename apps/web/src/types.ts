// Frontend mirrors of the API response shapes (kept small and local so the web
// app has no build dependency on the server packages).

export type Rating = 'green' | 'amber' | 'red' | 'unknown';

export interface Client {
  id: string;
  name: string;
  primaryContact?: { name: string; email?: string; role?: string };
  industry?: string;
  hipaa?: boolean;
  /** Compliance framework this client answers to (HIPAA, TISAX, SOC 2…). */
  complianceStandard?: string;
  /** Whether this client gets QBRs (undefined = true). */
  qbrEnabled?: boolean;
  integrationRefs?: Record<string, string>;
}

/** A collected metric (mirrors the server's MetricValue). */
/** Backing rows for a metric's drill-down viewer (shape varies per metric). */
export type MetricDetailRow = Record<string, string | number>;

/** A card on the per-client opportunity board (QBR initiatives, cross-quarter). */
export interface Opportunity {
  id: string;
  clientId: string;
  title: string;
  detail?: string;
  status: 'idea' | 'discussing' | 'approved' | 'pushed' | 'closed';
  owner?: string;
  sourcePeriod?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  externalRef?: string;
  externalKind?: string;
}

export interface MetricRow {
  key: string;
  label: string;
  value: number | string | boolean | null;
  unit?: string;
  source: string;
  category: string;
  higherIsBetter?: boolean;
  /** Present when the collector stored the rows behind this number. */
  details?: MetricDetailRow[];
}

export interface SnapshotView {
  clientId: string;
  period: string;
  capturedAt: string;
  metrics: MetricRow[];
}

/** An attention flag on a dashboard row. */
export interface ClientFlag {
  severity: 'red' | 'amber';
  label: string;
}

/** One row of GET /api/overview. */
export interface OverviewRow {
  clientId: string;
  name: string;
  industry?: string;
  hipaa?: boolean;
  period: string | null;
  score: number | null;
  rating: Rating;
  status: string;
  meetingAt: string | null;
  mrr: number | null;
  spend: number | null;
  spendDeltaPct: number | null;
  flags: ClientFlag[];
}

/** One row of GET /api/clients/{id}/periods. */
export interface PeriodInfo {
  period: string;
  hasSnapshot: boolean;
}

export interface FunctionScore {
  function: string;
  score: number | null;
  rating: Rating;
}

export interface MetricTrend {
  key: string;
  label: string;
  category: string;
  current: number | null;
  previous: number | null;
  deltaPct: number | null;
  direction: string;
  sentiment: string;
}

export interface ReportModel {
  client: { name: string; industry?: string; hipaa?: boolean };
  period: { id: string; label: string };
  brand?: { name?: string; logoDataUri?: string };
  executive: { headline?: string; paragraphs: string[]; highlights: string[] };
  scorecard: {
    overall: { score: number | null; rating: Rating; coverage: number };
    functions: FunctionScore[];
  };
  trends: MetricTrend[];
  /** Metric sections with their one-line executive summaries. */
  sections?: Array<{ category: string; title: string; summary?: string }>;
  recommendations: string[];
}

export interface QbrMeta {
  clientId: string;
  period: string;
  status: string;
  meeting?: { scheduledAt?: string; joinUrl?: string; heldAt?: string };
}

export interface QbrResponse {
  model: ReportModel;
  warnings: string[];
  verification: boolean;
  meta: QbrMeta;
}

export interface Brand {
  name?: string;
  logoDataUri?: string;
  primary?: string;
  accent?: string;
}
export interface CustomSection {
  id: string;
  title: string;
  body: string;
  placement?: string;
}
export interface ReportConfig {
  clientId: string;
  hiddenSections?: string[];
  customSections?: CustomSection[];
  brand?: Brand;
  /** Theme the AI narrative should emphasize (business security, continuity…). */
  narrativeFocus?: string;
  /** Standing author instruction applied to every narrative draft. */
  narrativeGuidance?: string;
  /** Per-section comments applied to that section's summary on regenerate. */
  sectionGuidance?: Record<string, string>;
}

export interface DiscussionItem {
  id: string;
  topic: string;
  response?: string;
  disposition?: string;
  owner?: string;
  /** Pre-wired before the meeting vs answered during it. */
  status?: 'planned' | 'discussed';
  /** Whether this item lands on the final report (default true). */
  includeInReport?: boolean;
  /** Agenda order (lower first). */
  sortOrder?: number;
  externalRef?: { system: string; id: string; status?: string };
}
export interface Discussion {
  clientId: string;
  period: string;
  items: DiscussionItem[];
  notes?: string;
}

/** A vendor report / uploaded file attached to a QBR. */
export interface DocumentInfo {
  id: string;
  clientId: string;
  period: string;
  name: string;
  source: string;
  /** User-assigned bucket on the Reports tab. */
  category?: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  uploadedBy: string;
}

/** AI suggestion for where a filed document belongs (Reports tab matcher). */
export interface DocMatchSuggestion {
  vendor: string;
  suggestedName: string;
  suggestedPeriod: string;
  suggestedCategory: string;
  clientMatch: 'yes' | 'no' | 'unsure';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

/** AI-extracted metrics from a filed PDF (review before import). */
export interface DocExtraction {
  vendor: string;
  periodHint: string;
  metrics: Array<{ key: string; label: string; value: number; unit?: string; category: string; higherIsBetter?: boolean }>;
  note: string;
}

/** Halo lookup lists for the push-ticket modal. */
export interface HaloMeta {
  ticketTypes: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  priorities: Array<{ id: string; name: string }>;
}

/** The signed-in user reported by GET /api/me. */
export interface Me {
  name: string;
  email?: string;
  roles?: string[];
  dev?: boolean;
}

/** One compliance audit entry. */
export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: string;
}

/** Runtime capabilities reported by GET /api/system. */
export interface SystemInfo {
  dataStore: 'table' | 'json';
  secretStore: 'keyvault' | 'local';
  ai: boolean;
  pdfAvailable: boolean;
  /** Shared report mailbox (null = inbox ingestion not configured). */
  reportsMailbox: string | null;
  /** How the last inbox poll went (null = no poll yet since this worker started). */
  inboxLastPoll?: { at: string; ok: boolean; detail: string } | null;
  /** Which REPORTS_* app settings the API process can see (presence only). */
  inboxEnvSeen?: Record<string, boolean>;
  /** Deploy-time build stamp (null when running from source). */
  build?: { sha?: string; builtAt?: string } | null;
}

export interface ConnectionView {
  id: string;
  type: string;
  label: string;
  config: Record<string, string>;
  secretFields: string[];
  status?: 'unknown' | 'ok' | 'error';
  statusMessage?: string;
  createdAt: string;
  updatedAt: string;
}
