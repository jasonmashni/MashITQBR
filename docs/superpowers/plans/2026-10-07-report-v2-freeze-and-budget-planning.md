# Report v2, Frozen Quarters and Budget Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the executive-first report, freeze finished quarters into stored packages, add fiscal-year budget planning with internal-only benchmarks, and capture client conversations without reading anyone's mailbox.

**Architecture:** One shared-types commit (S0, parent) lands every new record shape and store method first. Workstream A (quick fixes) then ships alone. B (frozen quarters, API plus workspace UI) and C (narrative v4, protection questions, investment model, all three renderers) run in parallel. D (fiscal years, budget planner) supplies data to the investment model C defines and owns its own API module and Budget tab. E (conversations) owns the inbox and a new conversations module. New API modules register their routes in `functions.ts` under a labelled comment block per workstream so merges stay append-only.

**Tech Stack:** TypeScript 5.7, vitest 2, Azure Functions v4 on Node 24 (Flex Consumption), React 18 + Mantine 7 + Vite 5, pdfmake 0.2, pptxgenjs 3, Anthropic SDK (structured output).

**Spec:** `docs/superpowers/specs/2026-10-07-report-v2-freeze-and-budget-planning-design.md`

## Global Constraints

- Narrative limits (spec, binding): headline <= 12 words; `lede` <= 60 words; `did` and `saw` each 3..4 items of <= 18 words; `decisions` 0..3; each `plan` column 0..3 items; `protection` exactly 5 entries, each field <= 40 words. A breach is a verification failure shown in the editor, never a silent truncation.
- Readability (spec, binding): PDF body `fontSize >= 10`, captions and footers `>= 8`, nothing under 8 anywhere; `lineHeight >= 1.35` for body; page margins `>= 54` points (0.75in); headings keep with next; charts, tile bands and callouts `unbreakable`; tables `headerRows: 1`; page count grows rather than sizes shrinking.
- Protection questions, in this order and with these ids: `get_in` "Can someone get in?", `know` "Would we know, and how fast would we act?", `recover` "Could we recover?", `keep_up` "Are we keeping up?", `run_well` "Are we running it well?".
- Deliverable file names: `Mash IT QBR - {Client} - {Q2 2026}.pdf|.html|.pptx`. The emailed PDF uses the same name.
- Lock semantics: `dataLocked` when `locks.preread` or `locks.final` exists; `isFinal` when `locks.final` exists. Locked writes answer `409 { error: 'locked', stage }`.
- Fiscal label is the calendar year in which the fiscal year ends. Planning review quarter is `ceil(startMonth / 3) - 2`, wrapping into the prior year.
- Benchmark and industry context is stored on `BudgetPlanRecord.context` only and is never passed to `buildNarrativeInput` or placed on `ReportModel`.
- No em dashes in any new copy, client-facing or internal. Plain sentences, no middle dots, no uppercase eyebrows.
- Every task: write the failing test, run it, implement, run it, commit with a conventional message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never stage `.superpowers/`, `.claude/`, `.playwright-mcp/` or `.data/`.
- Run tests with `npx vitest run <path>` from the repo root. Typecheck with `npm run typecheck`. Web typecheck with `npx tsc -p apps/web/tsconfig.json --noEmit`.
- File ownership: S0 = the shared type and store files listed in its task (parent only). A = `packages/integrations/src/cipp.ts`, `apps/api/src/contentDisposition.ts`, the four download handlers in `apps/api/src/handlers.ts`, `apps/api/src/emailDraft.ts` attachment name, `packages/report/src/pdf.ts` (A3 only), `packages/report/src/html.ts` print CSS (A3 only), `packages/narrative/src/verify.ts` and `schema.ts` (A4 only), `.gitignore`, `apps/web/src/pages/Dashboard.tsx` (A6 only), `README.md` and `infra/main.bicep` (A7 only). B = `apps/api/src/locks.ts`, `apps/api/src/packages.ts`, `apps/api/src/handlers.ts` (except A's handlers), `apps/api/src/triage.ts`, `apps/api/src/functions.ts` (block "Workstream B"), `apps/web/src/pages/Workspace.tsx`, `apps/web/src/pages/workspace/*` except `NarrativeEditor.tsx`, `OverviewTab.tsx`, `MeetingTab.tsx`. C = `packages/narrative/**` (after A4), `packages/core/src/protection.ts`, `packages/report/**` (after A3), `apps/api/src/service.ts`, `apps/api/src/docExtract.ts`, `apps/api/src/store/index.ts` (`loadReportInputs` only), `apps/web/src/pages/workspace/NarrativeEditor.tsx`, `apps/web/src/pages/workspace/OverviewTab.tsx`. D = `packages/core/src/period.ts`, `packages/core/src/budget.ts`, `apps/api/src/budget.ts`, `apps/api/src/budgetResearch.ts`, `apps/api/src/functions.ts` (block "Workstream D"), `apps/web/src/pages/workspace/BudgetTab.tsx`, `apps/web/src/pages/Clients.tsx`. E = `apps/api/src/reportInbox.ts`, `apps/api/src/conversations.ts`, `packages/integrations/src/haloDirect.ts` (`listHaloConversations` only), `apps/api/src/functions.ts` (block "Workstream E"), `apps/web/src/pages/workspace/MeetingTab.tsx`.

## Review Focus

1. A client whose previous quarter has no discussion items (first QBR ever): page one must render without the "Since last quarter" block and without an empty heading, in all three renderers. Pinned in C6 and C8.
2. A locked quarter whose stored PDF blob is missing (storage cleaned, migration): `GET report.pdf` must answer 503 with "Stored package missing; reopen to rebuild" rather than silently rebuilding and billing. Pinned in B3.
3. A Halo tenant where every contract lacks a monthly value: the budget outlook's managed-services line must be `low = expected = high = 0` with a basis note "No recurring value on Halo contracts" and the totals must carry a caveat, never a silent zero. Pinned in D2.
4. A forwarded email whose subject is only "Fw:" or empty: the inbox must not create a discussion item with an empty topic; it marks the message "QBR: no subject" and counts it as unrouted. Pinned in E1.
5. A client with `fiscalYearStartMonth` undefined and a period id that is malformed in the URL: `isPlanningPeriod` must return false and the fiscal helpers must throw the existing `Invalid period id` error rather than NaN into a label. Pinned in D1.

---

## Workstream S0: shared types and store methods (parent session, first)

### Task S0: New record shapes, store methods, and web mirrors

**Files:**
- Modify: `packages/core/src/types.ts` (Client, DiscussionItem, ReportConfig)
- Modify: `apps/api/src/store/types.ts` (QbrRecord, DocumentRecord, new records, DataStore)
- Modify: `apps/api/src/store/jsonStore.ts`, `apps/api/src/store/tableStore.ts`
- Modify: `apps/web/src/types.ts`
- Test: `apps/api/test/store.test.ts`

**Interfaces:**
- Produces, in `packages/core/src/types.ts`:

```ts
export interface Client {
  // existing fields, plus:
  /** 1..12; the month the client's fiscal year starts. Undefined means January. */
  fiscalYearStartMonth?: number;
}
export interface DiscussionItem {
  // existing fields, plus:
  /** Where the item came from. Undefined means typed by hand. */
  source?: 'manual' | 'email' | 'halo' | 'suggested' | 'report';
  /** Message id, Halo id, or other external reference for the source. */
  sourceRef?: string;
}
export interface ReportConfig {
  // existing fields, plus:
  /** Show "Since last quarter" on page one. Undefined means true. */
  showSinceLastQuarter?: boolean;
}
```

- Produces, in `apps/api/src/store/types.ts`:

```ts
export interface LockInfo { at: string; by: string; version: number }
export interface QbrRecord {
  // existing fields, plus:
  locks?: { preread?: LockInfo; final?: LockInfo };
  reopened?: Array<{ at: string; by: string; stage: 'preread' | 'final'; reason: string }>;
}
export interface DocumentFinding { text: string; severity: 'info' | 'watch' | 'act' }
export interface DocumentRecord {
  // existing fields, plus:
  /** Notable findings extracted from the document (at most 5). */
  findings?: DocumentFinding[];
}
export type PackageStage = 'preread' | 'final';
export interface PackageRecord {
  clientId: string;
  period: string;
  version: number;
  stage: PackageStage;
  createdAt: string;
  createdBy: string;
  files: { model: string; pdf: string; pptx: string; html: string };
  warnings: string[];
}
// The next five types live in packages/core/src/types.ts (core owns the budget math in D2;
// the API store types import and re-export them so both packages compile).
export type BudgetCategory = 'managed_services' | 'licensing' | 'hardware' | 'projects' | 'support_hours' | 'compliance' | 'contingency';
export type BudgetSource = 'halo' | 'cipp' | 'ninja' | 'hudu' | 'opportunities' | 'answer';
export interface BudgetLine {
  category: BudgetCategory;
  low: number; expected: number; high: number;
  basis: Array<{ source: BudgetSource; note: string }>;
}
export interface BudgetAnswers {
  headcountChange?: number;
  newLocations?: 0 | 1 | 2;
  projects?: Array<{ name: string; low?: number; high?: number }>;
  workstationUnitCost?: number;
  refreshPolicy?: 'run_to_failure' | 'at_warranty_end' | 'early';
  complianceDeadlines?: Array<{ what: string; when: string; estimate?: number }>;
  copilotSeats?: number;
  copilotSeatPrice?: number;
  appetite?: 'lean' | 'balanced' | 'cautious';
  notes?: string;
}
export type BudgetOutlook = { fiscalLabel: number; assumptions: string[]; movers: string[]; lines: BudgetLine[]; totals: { low: number; expected: number; high: number }; caveats: string[] };
// Back in apps/api/src/store/types.ts:
export interface BudgetContextItem { title: string; insight: string; askClient: string; sourceName?: string; sourceUrl?: string }
export interface BudgetPlanRecord {
  clientId: string;
  fiscalLabel: number;
  answers: BudgetAnswers;
  assumptions: string[];
  movers: string[];
  lines: BudgetLine[];
  totals: { low: number; expected: number; high: number };
  caveats: string[];
  status: 'draft' | 'published';
  publishedPeriod?: string;
  publishedAt?: string;
  /** Internal only. Never copied onto a report model or a narrative input. */
  context?: { researchedAt: string; sourced: boolean; items: BudgetContextItem[] };
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}
export interface DataStore {
  // existing methods, plus:
  listPackages(clientId: string, period: string): Promise<PackageRecord[]>;
  putPackage(record: PackageRecord): Promise<PackageRecord>;
  listBudgetPlans(clientId: string): Promise<BudgetPlanRecord[]>;
  getBudgetPlan(clientId: string, fiscalLabel: number): Promise<BudgetPlanRecord | undefined>;
  putBudgetPlan(record: BudgetPlanRecord): Promise<BudgetPlanRecord>;
}
```

- `apps/web/src/types.ts` mirrors `LockInfo`, `PackageStage`, `BudgetLine`, `BudgetAnswers`, `BudgetPlanRecord` (without `context` items' internals being rendered anywhere client-facing), `DocumentFinding`; `QbrMeta` gains `locks?`, `reopened?`, and `QbrResponse` gains `package?: { version: number; stage: PackageStage; createdAt: string }`. `DiscussionItem` on the web gains `source?` and `sourceRef?`.

- [ ] **Step 1: Write the failing store test**

Append to `apps/api/test/store.test.ts`:

```ts
describe('packages and budget plans', () => {
  it('stores package versions per client and period, newest last', async () => {
    const store = new JsonDataStore(dir);
    const base = { clientId: 'c1', period: '2026-Q2', createdAt: '2026-10-07T00:00:00Z', createdBy: 'jason', warnings: [] as string[] };
    await store.putPackage({ ...base, version: 1, stage: 'preread', files: { model: 'm1', pdf: 'p1', pptx: 'x1', html: 'h1' } });
    await store.putPackage({ ...base, version: 2, stage: 'final', files: { model: 'm2', pdf: 'p2', pptx: 'x2', html: 'h2' } });
    const list = await store.listPackages('c1', '2026-Q2');
    expect(list.map((p) => p.version)).toEqual([1, 2]);
    expect(await store.listPackages('c1', '2026-Q1')).toEqual([]);
  });
  it('stores one budget plan per client and fiscal label', async () => {
    const store = new JsonDataStore(dir);
    const plan = {
      clientId: 'c1', fiscalLabel: 2027, answers: {}, assumptions: [], movers: [], lines: [], caveats: [],
      totals: { low: 0, expected: 0, high: 0 }, status: 'draft' as const,
      createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', updatedBy: 'jason',
    };
    await store.putBudgetPlan(plan);
    await store.putBudgetPlan({ ...plan, assumptions: ['Headcount grows by two'] });
    expect((await store.getBudgetPlan('c1', 2027))?.assumptions).toEqual(['Headcount grows by two']);
    expect((await store.listBudgetPlans('c1')).length).toBe(1);
    expect(await store.getBudgetPlan('c1', 2028)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/store.test.ts`
Expected: FAIL with "putPackage is not a function".

- [ ] **Step 3: Add the types and both store implementations**

In `jsonStore.ts`: add `packages: Record<string, PackageRecord[]>` keyed `${clientId}/${period}` and `budgets: Record<string, BudgetPlanRecord[]>` keyed `clientId` to `JsonShape` and `EMPTY`; implement:

```ts
async listPackages(clientId: string, period: string): Promise<PackageRecord[]> {
  return [...(this.read().packages[`${clientId}/${period}`] ?? [])].sort((a, b) => a.version - b.version);
}
async putPackage(record: PackageRecord): Promise<PackageRecord> {
  const s = this.read();
  const key = `${record.clientId}/${record.period}`;
  s.packages[key] = [...(s.packages[key] ?? []).filter((p) => p.version !== record.version), record];
  this.write(s);
  return record;
}
async listBudgetPlans(clientId: string): Promise<BudgetPlanRecord[]> {
  return [...(this.read().budgets[clientId] ?? [])].sort((a, b) => a.fiscalLabel - b.fiscalLabel);
}
async getBudgetPlan(clientId: string, fiscalLabel: number): Promise<BudgetPlanRecord | undefined> {
  return (this.read().budgets[clientId] ?? []).find((b) => b.fiscalLabel === fiscalLabel);
}
async putBudgetPlan(record: BudgetPlanRecord): Promise<BudgetPlanRecord> {
  const s = this.read();
  s.budgets[record.clientId] = [...(s.budgets[record.clientId] ?? []).filter((b) => b.fiscalLabel !== record.fiscalLabel), record];
  this.write(s);
  return record;
}
```

In `tableStore.ts`: add `packages: 'qbrPackages'` and `budgets: 'qbrBudgets'` to `TABLES`; implement with partition `${clientId}/${period}` and row key `String(version).padStart(4, '0')` for packages (sort by version after listing), partition `clientId` and row key `String(fiscalLabel)` for budgets. Follow the `list`/`get`/`put` helpers already in the class. Note the existing `read()`/`write()` names in `jsonStore.ts` are whatever the file already uses; keep them.

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run apps/api/test/store.test.ts && npm run typecheck`
Expected: PASS, typecheck clean (unused new types are fine).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts apps/api/src/store/types.ts apps/api/src/store/jsonStore.ts apps/api/src/store/tableStore.ts apps/web/src/types.ts apps/api/test/store.test.ts
git commit -m "feat(core,api,web): shared types for frozen packages, budget plans, document findings and discussion sources"
```

---

## Workstream A: quick fixes (subagent, ships alone)

### Task A1: Paid seats only

**Files:**
- Modify: `packages/integrations/src/cipp.ts` (`normalizeCippLicenses`, lines 227-276)
- Test: `packages/integrations/test/cippGoogle.test.ts`

**Interfaces:**
- Produces: `normalizeCippLicenses(rows, now?): { metrics: MetricValue[]; warnings: string[] }`. Callers (`collectCipp` at line 316) change from `(j) => normalizeCippLicenses(...)` to spreading `metrics` and pushing `warnings` into the collect result's warnings, the way `normalizeHaloFinance` is consumed in `haloDirect.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { normalizeCippLicenses } from '@mashit/integrations';

describe('normalizeCippLicenses counts paid seats only', () => {
  const rows = [
    { License: 'Microsoft 365 Business Premium', SkuPartNumber: 'SPB', CountUsed: 31, CountAvailable: 1, TotalLicenses: 32 },
    { License: 'Microsoft Power Apps for Developer', SkuPartNumber: 'POWERAPPS_DEV', CountUsed: 0, CountAvailable: 10000, TotalLicenses: 10000 },
    { License: 'Mystery Viral Plan', SkuPartNumber: 'UNKNOWN_VIRAL', CountUsed: 3, CountAvailable: 4997, TotalLicenses: 5000 },
  ];
  it('excludes denylisted and near-empty thousand-unit SKUs from totals', () => {
    const { metrics, warnings } = normalizeCippLicenses(rows);
    const by = Object.fromEntries(metrics.map((m) => [m.key, m]));
    expect(by['licenses.total']!.value).toBe(32);
    expect(by['licenses.total']!.label).toBe('Paid license seats');
    expect(by['licenses.assigned']!.value).toBe(31);
    expect(by['licenses.unassigned']!.label).toBe('Unused paid seats');
    expect(by['licenses.unassigned']!.value).toBe(1);
    const details = by['licenses.total']!.details as Array<Record<string, string | number>>;
    expect(details.find((d) => d['license'] === 'Microsoft Power Apps for Developer')!['counted']).toBe('no, free or developer plan');
    expect(details.find((d) => d['license'] === 'Microsoft 365 Business Premium')!['counted']).toBe('yes');
    expect(warnings).toEqual([
      '2 Microsoft plans are free or developer SKUs and were not counted: Microsoft Power Apps for Developer, Mystery Viral Plan.',
    ]);
  });
  it('returns no warning when every SKU is paid', () => {
    expect(normalizeCippLicenses([rows[0]!]).warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/integrations/test/cippGoogle.test.ts`
Expected: FAIL (return shape is an array today).

- [ ] **Step 3: Implement**

```ts
/**
 * Free, trial and developer plans Microsoft hands out in bulk. Verified
 * against "Product names and service plan identifiers for licensing"
 * (learn.microsoft.com) on the date in the commit message; keep the comment
 * next to each entry naming the product so the list is auditable.
 */
const FREE_SKU_PART_NUMBERS = new Set<string>([
  'POWERAPPS_DEV',            // Microsoft Power Apps for Developer
  'FLOW_FREE',                // Microsoft Power Automate Free
  'POWER_BI_STANDARD',        // Power BI (free)
  'TEAMS_EXPLORATORY',        // Microsoft Teams Exploratory
  'RIGHTSMANAGEMENT_ADHOC',   // Rights Management Adhoc
  'MICROSOFT_BUSINESS_CENTER',// Microsoft Business Center
  'WINDOWS_STORE',            // Windows Store for Business
  'CCIBOTS_PRIVPREV_VIRAL',   // Power Virtual Agents viral trial
  'POWERAPPS_VIRAL',          // Microsoft Power Apps Plan 2 Trial
  'DYN365_ENTERPRISE_P1_IW',  // Dynamics 365 P1 trial for information workers
]);
const BULK_FREE_UNITS = 1000;
const BULK_FREE_ASSIGNED_RATIO = 0.05;

const partNumberOf = (r: Json): string => String(r['SkuPartNumber'] ?? r['skuPartNumber'] ?? '').trim().toUpperCase();
const isFreePlan = (r: Json, purchased: number, assigned: number): boolean =>
  FREE_SKU_PART_NUMBERS.has(partNumberOf(r)) || (purchased >= BULK_FREE_UNITS && assigned / purchased < BULK_FREE_ASSIGNED_RATIO);
```

Inside the loop, compute `purchased`/`assigned` as today, then `const counted = !isFreePlan(r, purchased, assigned);` Only add to `used`/`total` when `counted`; always push the detail row with `counted: counted ? 'yes' : 'no, free or developer plan'`; collect uncounted names. Labels: `'Paid license seats'` and `'Unused paid seats'`. Return `{ metrics: out, warnings }` where `warnings` is `[]` or the single sentence `${n} Microsoft ${plural(n, 'plan is a free or developer SKU and was', 'plans are free or developer SKUs and were')} not counted: ${names.join(', ')}.` (use the `plural` helper from `@mashit/core`). Update `collectCipp` to spread `metrics` and push `warnings`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/integrations && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/src/cipp.ts packages/integrations/test/cippGoogle.test.ts
git commit -m "fix(integrations): count paid Microsoft seats only; free and developer SKUs listed but not counted"
```

### Task A2: Deliverable file names

**Files:**
- Modify: `apps/api/src/contentDisposition.ts`
- Modify: `apps/api/src/handlers.ts` (`getReportHtml`, `getReportPdf`, `getReportDeck`, email attachment at line 1446), `apps/api/src/functions.ts` (`toResponse` html and pdf branches)
- Test: `apps/api/test/contentDisposition.test.ts`

**Interfaces:**
- Produces: `contentDisposition(name: string, opts?: { inline?: boolean }): string` and `export function deliverableFilename(clientName: string, periodLabel: string, ext: 'pdf' | 'html' | 'pptx'): string` in `apps/api/src/contentDisposition.ts`. `ApiResult.html` and `ApiResult.pdf` results may carry `filename` (the field already exists for pptx).

- [ ] **Step 1: Write the failing test**

```ts
import { contentDisposition, deliverableFilename } from '../src/contentDisposition.js';

it('names deliverables consistently and offers inline disposition', () => {
  expect(deliverableFilename('ANP Enertech', 'Q2 2026', 'pdf')).toBe('Mash IT QBR - ANP Enertech - Q2 2026.pdf');
  expect(deliverableFilename('Acme / "Co"', 'Q1 2026', 'pptx')).toBe('Mash IT QBR - Acme Co - Q1 2026.pptx');
  expect(contentDisposition('a.pdf', { inline: true }).startsWith('inline; filename="a.pdf"')).toBe(true);
  expect(contentDisposition('a.pdf').startsWith('attachment;')).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**
- [ ] **Step 3: Implement**

```ts
export function deliverableFilename(clientName: string, periodLabel: string, ext: 'pdf' | 'html' | 'pptx'): string {
  const safe = clientName.replace(/[^\w .&()-]+/g, '').replace(/\s+/g, ' ').trim() || 'Client';
  return `Mash IT QBR - ${safe} - ${periodLabel}.${ext}`;
}
```

In `contentDisposition`, prefix with `opts?.inline ? 'inline' : 'attachment'`. In `handlers.ts`, the html and pdf handlers return `{ status: 200, html, filename: deliverableFilename(report.model.client.name, report.model.period.label, 'html') }` (likewise pdf); the deck uses the helper; the email attachment name becomes `deliverableFilename(client?.name ?? clientId, parsePeriod(period).label, 'pdf')`. In `functions.ts` `toResponse`, html and pdf branches add `'Content-Disposition': contentDisposition(r.filename, { inline: true })` when `r.filename` is set.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run apps/api/test/contentDisposition.test.ts apps/api/test/emailDraft.test.ts && npm run typecheck`

- [ ] **Step 5: Commit** `fix(api): every deliverable downloads as "Mash IT QBR - Client - Quarter"`.

### Task A3: Blocks never split, cover footer once

**Files:**
- Modify: `packages/report/src/pdf.ts` (`buildPdfDefinition` movers block at lines 391-396; `coverPage` line ~300; `styles`), `packages/report/src/html.ts` (print CSS in `styles`)
- Test: `packages/report/test/deliverables.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('keeps the movers heading, caption and chart in one unbreakable block and prints the cover footer once', () => {
  const def = buildPdfDefinition(model) as { content: unknown[] };
  const json = JSON.stringify(def.content);
  const movers = (def.content as Array<Record<string, unknown>>).find((n) => Array.isArray(n['stack']) && JSON.stringify(n['stack']).includes('What changed this quarter'));
  expect(movers?.['unbreakable']).toBe(true);
  expect(JSON.stringify(movers!['stack'])).toContain('"svg"');
  const cover = (def.content as Array<Record<string, unknown>>).slice(0, 12);
  expect(JSON.stringify(cover).match(/Prepared by Mash IT\. Confidential\./g) ?? []).toHaveLength(0);
  expect(json).not.toMatch(/"fontSize":[0-7](\.|,|})/);
});
```

- [ ] **Step 2: Run it to verify it fails**
- [ ] **Step 3: Implement**

Replace the three movers pushes with one node:

```ts
content.push({
  unbreakable: true,
  stack: [
    { text: 'What changed this quarter', style: 'h2', color: brand.primary, margin: [0, 12, 0, 2] },
    { text: moversCaption(m.trends), style: 'small', margin: [0, 0, 0, 6] },
    { svg: moversSvg, width: 508, margin: [0, 0, 0, 8] },
  ],
});
```

Add `headlineLevel: 1` to every `style: 'h1'` node and `headlineLevel: 2` to every `style: 'h2'` node (pdfmake keeps a headline with the following block). Wrap `kpiBand`, `confidenceBlock` and `calloutBlock` results in `unbreakable: true`. Remove the cover's `Prepared by ... Confidential.` text node (the footer prints it). In `html.ts` `styles`, add `@media print{h1,h2,h3{break-after:avoid}.tiles,.movers,.callout,.since,table{break-inside:avoid}}` and give those elements the matching classes.

- [ ] **Step 4: Run tests** `npx vitest run packages/report`
- [ ] **Step 5: Commit** `fix(report): headings keep with their blocks, charts never split, cover footer printed once`.

### Task A4: Human prose lint

**Files:**
- Modify: `packages/narrative/src/verify.ts`, `packages/narrative/src/schema.ts` (SYSTEM_PROMPT voice section), `packages/narrative/src/offline.ts` (sweep)
- Test: `packages/narrative/test/verify.test.ts`

**Interfaces:**
- Produces: `export const STYLE_BANNED: readonly string[]`; `export function styleIssues(output: NarrativeOutput): string[]` (one entry per hit, `"<field>: <phrase>"`); `VerificationResult.style: string[]` (non-blocking; `ok` is unaffected).

- [ ] **Step 1: Write the failing test**

```ts
it('flags em dashes and model phrases without failing verification', () => {
  const out = { ...base, headline: 'A quarter that reinforces trust — again', recommendations: ['Leverage the landscape'] };
  const r = verifyNarrative(out, allowed);
  expect(r.ok).toBe(true);
  expect(r.style).toEqual(['headline: em dash', 'headline: reinforces', 'recommendations: leverage', 'recommendations: landscape']);
});
```

- [ ] **Step 2: Run it to verify it fails**
- [ ] **Step 3: Implement**

```ts
export const STYLE_BANNED = ['reinforces', 'underscores', 'leaves room to climb', 'worth a brief review', 'robust', 'leverage', 'landscape', 'holistic', 'seamless', 'journey', 'navigate', 'foster', 'a testament to', 'it is worth noting', "it's worth noting", "in today's"] as const;

export function styleIssues(output: NarrativeOutput): string[] {
  const issues: string[] = [];
  const scan = (field: string, text: string) => {
    if (/[—–]/.test(text)) issues.push(`${field}: em dash`);
    const lower = text.toLowerCase();
    for (const phrase of STYLE_BANNED) if (lower.includes(phrase)) issues.push(`${field}: ${phrase}`);
  };
  for (const [field, value] of Object.entries(output)) {
    if (typeof value === 'string') scan(field, value);
    else if (Array.isArray(value)) for (const v of value) { if (typeof v === 'string') scan(field, v); else if (v && typeof v === 'object') for (const s of Object.values(v)) if (typeof s === 'string') scan(field, s); }
  }
  return issues;
}
```

`verifyNarrative` sets `style: styleIssues(output)`. Add to `SYSTEM_PROMPT` under Voice: "Never use an em dash or an en dash; use a comma, a colon or a new sentence. Never use these words or phrases: reinforces, underscores, leaves room to climb, worth a brief review, robust, leverage, landscape, holistic, seamless, journey, navigate, foster, a testament to, it is worth noting, in today's." Sweep `offline.ts` for dashes and the phrases.

- [ ] **Step 4: Run** `npx vitest run packages/narrative`
- [ ] **Step 5: Commit** `feat(narrative): style lint for em dashes and model phrases; prompt forbids them`.

### Task A5: Repo hygiene

- [ ] Append `.superpowers/` and `.claude/worktrees/` to `.gitignore`; run `git status --short` and confirm neither directory is listed; commit `chore: ignore brainstorm and worktree directories`.

### Task A6: Dashboard links carry the period

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx` lines 249-253

- [ ] Replace the plain `Text` showing `r.lastCompletedPeriod` with `<Anchor component={Link} to={`/clients/${r.clientId}?period=${r.lastCompletedPeriod}`} size="sm" fw={500} data-num onClick={(e) => e.stopPropagation()}>{r.lastCompletedPeriod}</Anchor>`; run `npx tsc -p apps/web/tsconfig.json --noEmit`; commit `fix(web): last-review cell opens that quarter`.

### Task A7: Infra and README say what runs

**Files:**
- Modify: `README.md` (infra section), `infra/main.bicep` (plan sku `FC1`, tier `FlexConsumption`, `functionAppConfig.runtime.name: 'node'`, `version: '24'`, deployment storage `blobContainer`)

- [ ] Change the plan and runtime to Flex Consumption FC1 and Node 24 per the Azure Bicep reference for `Microsoft.Web/sites` with `functionAppConfig`; run `az bicep build --file infra/main.bicep`; update the README paragraph; commit `docs(infra): describe the Flex Consumption app that actually runs`.

---

## Workstream B: frozen quarters (subagent)

### Task B1: Package store

**Files:**
- Create: `apps/api/src/packages.ts`
- Test: `apps/api/test/packages.test.ts`

**Interfaces:**
- Produces:

```ts
export function packagePath(clientId: string, period: string, version: number, file: 'model' | 'pdf' | 'pptx' | 'html'): string;
// -> `packages/${clientId}/${period}/v${version}/report.${json|pdf|pptx|html}`
export interface PackageArtifacts { model: ReportModel; verification: boolean; warnings: string[]; pdf: Buffer; pptx: Buffer; html: string }
export async function storePackage(store: DataStore, docs: DocContentStore, args: { clientId: string; period: string; stage: PackageStage; createdBy: string; artifacts: PackageArtifacts }): Promise<PackageRecord>;
export async function latestPackage(store: DataStore, clientId: string, period: string): Promise<PackageRecord | undefined>; // highest stage wins (final over preread), then highest version
export async function loadPackageModel(docs: DocContentStore, record: PackageRecord): Promise<{ model: ReportModel; verification: boolean; warnings: string[] } | undefined>;
export async function loadPackageFile(docs: DocContentStore, record: PackageRecord, file: 'pdf' | 'pptx' | 'html'): Promise<Buffer | undefined>;
```

- [ ] **Step 1: Write the failing test** (JsonDataStore in a temp dir, LocalDocStore in a temp dir):

```ts
it('stores a package as version n+1 and loads the newest highest-stage record', async () => {
  const artifacts = { model: fakeModel, verification: true, warnings: ['w'], pdf: Buffer.from('%PDF-'), pptx: Buffer.from('PK'), html: '<!doctype html>' };
  const v1 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'preread', createdBy: 'jason', artifacts });
  const v2 = await storePackage(store, docs, { clientId: 'c1', period: '2026-Q2', stage: 'final', createdBy: 'jason', artifacts });
  expect([v1.version, v2.version]).toEqual([1, 2]);
  expect((await latestPackage(store, 'c1', '2026-Q2'))?.version).toBe(2);
  expect((await loadPackageModel(docs, v2))?.warnings).toEqual(['w']);
  expect((await loadPackageFile(docs, v2, 'pdf'))?.toString()).toBe('%PDF-');
  expect(packagePath('c1', '2026-Q2', 2, 'html')).toBe('packages/c1/2026-Q2/v2/report.html');
});
```

- [ ] **Step 2: Run it to verify it fails**
- [ ] **Step 3: Implement** with `docs.put(path, bytes, contentType)` for the four files (`application/json`, `application/pdf`, the PPTX MIME string from `functions.ts`, `text/html; charset=utf-8`); version is `max(existing versions) + 1`; `latestPackage` sorts by `stage === 'final'` first then `version` desc.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/packages.test.ts`
- [ ] **Step 5: Commit** `feat(api): stored report packages (model, pdf, deck, html) per quarter version`.

### Task B2: Lock helpers and 409 on locked writes

**Files:**
- Create: `apps/api/src/locks.ts`
- Modify: `apps/api/src/handlers.ts` (`syncQbr`, `regenerateNarrative`, `putNarrativeEdits`, `putManualMetrics`, `importDocumentMetrics`, `removeImportedMetrics`, `uploadQbrDocument`, `updateQbrDocument`, `deleteQbrDocument`, `putDiscussion`, `putSchedule`)
- Test: `apps/api/test/locks.test.ts`, `apps/api/test/status.test.ts`

**Interfaces:**
- Produces:

```ts
export function dataLocked(record: QbrRecord | undefined): boolean;
export function isFinal(record: QbrRecord | undefined): boolean;
export const LOCKED: (stage: PackageStage) => ApiResult; // { status: 409, json: { error: 'locked', stage } }
export async function refuseIfLocked(clientId: string, period: string, level: 'data' | 'final'): Promise<ApiResult | undefined>;
```

- [ ] **Step 1: Write the failing tests**: `dataLocked({locks:{preread:{...}}})` true; `isFinal` false until `locks.final`; in `status.test.ts`, after setting a preread lock on a QbrRecord, `syncQbr` and `putNarrativeEdits` answer 409 with `{ error: 'locked', stage: 'preread' }` while `putDiscussion` still succeeds; after a final lock, `putDiscussion` answers 409 with stage `final`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**: each listed handler starts with `const locked = await refuseIfLocked(clientId, period, 'data'); if (locked) return locked;` (`'final'` for discussion and schedule). `refuseIfLocked` reads the record and returns `LOCKED(record.locks.final ? 'final' : 'preread')` when the level is locked.
- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): locked quarters refuse data and agenda writes with 409`.

### Task B3: Serve stored packages on reads

**Files:**
- Modify: `apps/api/src/handlers.ts` (`getQbr`, `getReportHtml`, `getReportPdf`, `getReportDeck`, `getEmailDraft`)
- Test: `apps/api/test/service.test.ts` (new describe)

- [ ] **Step 1: Write the failing test**: store a snapshot, set a preread lock and a stored package for `c1/2026-Q2` whose model headline is `'Stored headline'`; call `getQbr` with `ai = '1'` while a narrative model spy is installed via the existing AI model injection used in `service.test.ts`; assert the response model headline is `'Stored headline'`, `package.version` is 1, and the spy was never called. Second test: lock present but blob missing: `getReportPdf` answers `503` with `'Stored package missing; reopen to rebuild.'`. Third test: after the lock, `putClientGoals` adds a goal and `putConfig` changes the brand name; `getQbr` still returns the stored model unchanged.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**: add `async function servedPackage(clientId, period)` returning `{ record, model } | undefined` when `dataLocked`; each read handler checks it first. `getQbr` returns `ok({ model, warnings, verification, meta, package: { version, stage, createdAt } })`. File routes return the stored bytes with the A2 filename. Missing blob answers `err(503, 'Stored package missing; reopen to rebuild.')`. The email draft attaches the stored PDF.
- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): locked quarters are served from the stored package; nothing rebuilds or bills`.

### Task B4: Lock 1 on package sent

**Files:**
- Modify: `apps/api/src/handlers.ts` (`markPackageSent`, lines 1327-1340)
- Test: `apps/api/test/status.test.ts`

- [ ] **Step 1: Write the failing test**: with a snapshot and approved narrative, `markPackageSent` returns a record with `locks.preread.version === 1` and `packageSentAt` set; `listPackages` has one `preread` record whose html blob starts with `<!doctype html>`; calling it again returns the same record and stores nothing new; decisions from the narrative (`output.decisions`) appear as discussion items with `source: 'report'` and `status: 'planned'`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**:

```ts
if (existing?.locks?.preread) return ok(existing);
const report = await buildReportFor(clientId, period, null);
const artifacts = {
  model: report.model, verification: report.narrative.verification.ok, warnings: report.warnings,
  pdf: await buildFullPdf(clientId, period, null), pptx: await renderDeck(report.model), html: renderQbrHtml(report),
};
const pkg = await storePackage(store, getDocStore(), { clientId, period, stage: 'preread', createdBy: currentActor(), artifacts });
const now = new Date().toISOString();
const saved = await patchQbr(clientId, period, {
  packageSentAt: existing?.packageSentAt ?? now,
  locks: { ...existing?.locks, preread: { at: now, by: currentActor(), version: pkg.version } },
});
await seedReportDecisions(clientId, period, report.narrative.output.decisions ?? []);
audit('qbr.lock', `qbr:${clientId}/${period}`, `preread v${pkg.version}`);
```

`seedReportDecisions` appends `{ id, topic: d.ask, response: d.why, status: 'planned', includeInReport: true, source: 'report', sourceRef: 'page-one' }` for each decision not already present by topic. Until workstream C lands, `decisions` is undefined and the helper is a no-op; type it as `Array<{ ask: string; why?: string }> | undefined`.

- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): package sent performs lock 1 and stores the pre-read package`.

### Task B5: Lock 2 on decisions captured, and Finalize

**Files:**
- Modify: `apps/api/src/handlers.ts` (`putStatus` when the new status is `dispositioned` or later; `dispositionQbrSkipped`), add `export async function finalizeQbr(clientId, period)`
- Modify: `apps/api/src/functions.ts` (block "Workstream B"): `route('finalizeQbr', 'POST', 'api/clients/{clientId}/qbr/{period}/finalize', ...)`
- Test: `apps/api/test/status.test.ts`

- [ ] **Step 1: Write the failing tests**: (a) `putStatus` to `dispositioned` on a quarter with a preread lock stores a `final` package v2 and sets `locks.final`; (b) `finalizeQbr` on a `completed` quarter with no locks stores v1 `final`, sets both `locks.final` and status `dispositioned`; (c) `finalizeQbr` with no snapshot answers 404; (d) a second `finalizeQbr` is a no-op returning the record.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** `async function lockFinal(clientId, period)` shared by both paths: build with discussion (`buildReportFor` already loads it), render three artifacts, `storePackage(stage: 'final')`, patch `locks.final` and `status: advanceStatus(status, 'dispositioned')`, audit `qbr.lock final v{n}`. `putStatus` calls it after saving when `statusAtLeast(status, 'dispositioned') && !existing?.locks?.final`.
- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): decisions captured or Finalize stores the final package (lock 2)`.

### Task B6: Reopen

**Files:**
- Modify: `apps/api/src/handlers.ts` add `export async function reopenQbr(clientId, period, body: { stage?: unknown; reason?: unknown })`
- Modify: `apps/api/src/functions.ts` (block "Workstream B"): `POST api/clients/{clientId}/qbr/{period}/reopen`
- Modify: `packages/report/src/model.ts` (`ReportModel.revisedAt?: string`, optional, set from `buildReportModel` args), `apps/api/src/service.ts` (`buildQbrReport` accepts `opts.revisedAt` and passes it through). C8 prints it in the footer.
- Test: `apps/api/test/status.test.ts`

- [ ] **Step 1: Write the failing tests**: reopen `final` with a reason clears `locks.final` only and appends to `reopened`; reopen `preread` clears both; missing reason answers 400; the next lock stores version 3 and its model carries `revisedAt`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**

```ts
export async function reopenQbr(clientId: string, period: string, body: { stage?: unknown; reason?: unknown }): Promise<ApiResult> {
  const stage = body.stage === 'preread' || body.stage === 'final' ? body.stage : undefined;
  if (!stage) return err(400, 'stage must be preread or final');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return err(400, 'A reason is required to reopen a quarter.');
  const existing = await getDataStore().getQbr(clientId, period);
  if (!existing?.locks?.[stage]) return err(409, `This quarter has no ${stage} lock to reopen.`);
  const locks = stage === 'preread' ? {} : { preread: existing.locks.preread };
  const at = new Date().toISOString();
  const saved = await patchQbr(clientId, period, { locks, reopened: [...(existing.reopened ?? []), { at, by: currentActor(), stage, reason }] });
  await audit('qbr.reopen', `qbr:${clientId}/${period}`, `${stage}: ${reason}`);
  return ok(saved);
}
```

The next lock (B4 or B5) passes `revisedAt: existing.reopened?.at(-1)?.at` into the build when `reopened` is non-empty, so the stored model and its footer say "Revised on".
- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): audited Reopen clears a lock and versions the next package`.

### Task B7: Triage, periods and landing data

**Files:**
- Modify: `apps/api/src/triage.ts` (add `needs_finalizing`), `apps/api/src/handlers.ts` (`getPeriods` returns `locks`; overview rows include `locks`)
- Test: `apps/api/test/triage.test.ts`, `apps/api/test/overview.test.ts`

- [ ] **Step 1: Write the failing test**: `computeTriage({ hasData: true, status: 'completed', meetingAt: eightDaysAgo, locks: undefined, now })` is `needs_finalizing`; with `locks.final` present it is `done`; `getPeriods` rows carry `locks`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**: `TriageInput.locks?: QbrRecord['locks']`; rule inserted before `done`: `if (statusAtLeast(i.status, 'completed') && !i.locks?.final && (!hasMeeting || at <= i.now - 7 * 86_400_000)) return 'needs_finalizing';`. Export the union with the new value. Web `Triage` type and dashboard band copy: "Needs finalizing" with action "Finalize".
- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): needs_finalizing triage; periods carry locks`.

### Task B8: Workspace lock UI, Finalize, Reopen, landing

**Files:**
- Modify: `apps/web/src/api.ts` (`finalize`, `reopen`), `apps/web/src/pages/Workspace.tsx` (landing rule lines 140-160; banner; disabled controls), `apps/web/src/pages/workspace/nextStep.ts` (new step `finalize` replacing `complete` semantics), `apps/web/src/pages/workspace/WorkspaceHeader.tsx` (Reopen in overflow with reason dialog), `apps/web/src/pages/workspace/DataTab.tsx` (read-only when locked)
- Test: `apps/web/test/nextStep.test.ts`, `apps/web/test/periods.test.ts`

- [ ] **Step 1: Write the failing tests**: `deriveSteps` with `meta.locks.preread` marks `send` done; with `locks.final` the last step reads "Finalized" and `nextStep` is undefined; `chooseLandingPeriod(periodList, wanted)` (extract the landing rule from `Workspace.tsx` into `apps/web/src/pages/workspace/landing.ts` so it is testable) returns the open quarter, else the newest final one; `?period=` wins when valid.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**: banner copy exactly: "Pre-read sent on {date}. Data and narrative are locked; the agenda is open until decisions are captured." and "Final package stored on {date}. Read-only." Disabled controls carry that sentence as their tooltip. Finalize is the primary action once `statusAtLeast(status, 'completed') && !locks.final`. Reopen dialog requires a reason and a stage radio (Agenda and decisions / Everything). "Start next quarter" appears on a final quarter and navigates to the next period.
- [ ] **Step 4: Run** `npx vitest run apps/web && npx tsc -p apps/web/tsconfig.json --noEmit`
- [ ] **Step 5: Commit** `feat(web): locked quarters read-only with Finalize, Reopen and stable landing`.

### Task B9: Dashboard nag

- [ ] Add the `needs_finalizing` row to the triage band in `apps/web/src/pages/Dashboard.tsx` ("{n} quarters past their meeting are not finalized") with a link to the oldest one; typecheck; commit `feat(web): dashboard nags about unfinalized quarters`.

---

## Workstream C: report v2 (subagent)

### Task C1: Narrative contract v4 and limits

**Files:**
- Modify: `packages/narrative/src/schema.ts` (`NarrativeOutput`, `NARRATIVE_JSON_SCHEMA`, SYSTEM_PROMPT output section)
- Create: `packages/narrative/src/limits.ts`
- Modify: `packages/narrative/src/client.ts` (`assertNarrativeShape`), `packages/narrative/src/verify.ts` (limits are verification failures)
- Test: `packages/narrative/test/limits.test.ts`, `packages/narrative/test/verify.test.ts`

**Interfaces:**
- Produces the v4 `NarrativeOutput` exactly as in the spec (headline, lede, did, saw, decisions, plan, protection, section_summaries?, figures_referenced) plus `export type ProtectionQuestion`, `export interface PlanItem`, and:

```ts
export const NARRATIVE_LIMITS = { headlineWords: 12, ledeWords: 60, bulletWords: 18, didMin: 3, didMax: 4, decisionsMax: 3, planPerColumn: 3, protectionWords: 40 } as const;
export function wordCount(text: string): number;
export function limitIssues(output: NarrativeOutput): string[]; // e.g. 'headline: 14 words (limit 12)', 'did: 5 items (3 to 4)'
```

- `VerificationResult.failures` gains entries with `label: 'limits'` and `unmatched: string[]` from `limitIssues`, so `ok` is false when a limit is breached.

- [ ] **Step 1: Write the failing test**

```ts
it('reports every limit breach by field', () => {
  const out = { ...v4base, headline: 'one two three four five six seven eight nine ten eleven twelve thirteen', did: ['a', 'b'] };
  expect(limitIssues(out)).toEqual(['headline: 13 words (limit 12)', 'did: 2 items (3 to 4)']);
  expect(verifyNarrative(out, allowed).ok).toBe(false);
});
it('passes a compliant v4 output', () => { expect(limitIssues(v4base)).toEqual([]); });
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** schema, JSON schema (all new arrays and objects with `additionalProperties: false` and `required`; `protection[].question` enum of the five ids; `plan` object with `now`, `next`, `later`), `assertNarrativeShape` for every field, `limits.ts`, and the SYSTEM_PROMPT output section:

"Output shape: headline (under 12 words, plain statement of the quarter); lede (one paragraph under 60 words); did (3 or 4 bullets under 18 words: what Mash IT did); saw (3 or 4 bullets under 18 words: what the data showed, including anything from attached report findings); decisions (up to 3 items the client must decide: ask, why, by when); plan.now, plan.next, plan.later (up to 3 each: action, owner, decision true when it needs the client's yes); protection (exactly 5 entries, one per question id in order get_in, know, recover, keep_up, run_well: inPlace states the controls in place with figures, thisQuarter states what happened with figures, each under 40 words); section_summaries as before; figures_referenced as before."

- [ ] **Step 4: Run** `npx vitest run packages/narrative && npm run typecheck` (expect compile errors in offline.ts and report model; fix offline in C3, report in C6-C8; for this commit keep the old fields present in the type as optional deprecated aliases so the build stays green: `summary_paragraphs?: string[]; highlights?: string[]; recommendations?: string[]`).
- [ ] **Step 5: Commit** `feat(narrative): v4 output contract with word and count limits`.

### Task C2: Protection questions in core

**Files:**
- Create: `packages/core/src/protection.ts`; export from `packages/core/src/index.ts`
- Test: `packages/core/test/protection.test.ts`

**Interfaces:**

```ts
export type ProtectionQuestionId = 'get_in' | 'know' | 'recover' | 'keep_up' | 'run_well';
export interface ProtectionQuestionDef { id: ProtectionQuestionId; question: string; safeguards: readonly string[] }
export const PROTECTION_QUESTIONS: readonly ProtectionQuestionDef[]; // order and membership from the spec table
export interface ProtectionRow { id: ProtectionQuestionId; question: string; rating: Rating; functions: Array<{ function: NistFunction; score: number | null }>; safeguards: SafeguardResult[] }
export function protectionRows(scorecard: MaturityScorecard): ProtectionRow[];
```

Rating is the worst `rating` among measured safeguards in the group (`red` < `amber` < `green`), `unknown` when none measured. `functions` lists the distinct NIST functions of the group's safeguards with that function's score from `scorecard.functions`.

- [ ] **Step 1: Write the failing test** with the ANP seed scorecard: five rows in order; `keep_up` rating is `amber` or `red` when `asset_inventory` is amber; a scorecard with nothing measured yields five `unknown` rows.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npx vitest run packages/core`
- [ ] **Step 5: Commit** `feat(core): five protection questions grouped from the scorecard`.

### Task C3: Offline drafter v4

**Files:**
- Modify: `packages/narrative/src/offline.ts`
- Test: `packages/narrative/test/offline.test.ts`

- [ ] **Step 1: Write the failing test**: for every seed client and period (`SEED_SNAPSHOTS`), `draftOfflineNarrative(buildNarrativeInput({ client, current, previous }))` passes `limitIssues` with `[]`, has exactly 5 `protection` entries in order, and `verifyNarrative` is ok and `style` is empty.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** deterministic templates: `headline` from the two largest movers ("Fewer tickets, faster response, backups steady"), `lede` two sentences from movers and the overall rating, `did` from closed tickets, patches installed, threats blocked, backups run; `saw` from negative movers, SLA misses, document findings (`input.documents[].findings` from C5; when absent, skip), `decisions` from remediations (`asset_inventory` out-of-warranty, `patching` backlog), `plan` from insights and remediations with owner `'Mash IT'` and `decision: true` where a client approval is implied, `protection` from the safeguard evidence strings grouped by the five questions (import `PROTECTION_QUESTIONS` and `protectionRows` from `@mashit/core`, delivered in C2). Every sentence built by `plural()` and whole-number formatting, no dashes.
- [ ] **Step 4: Run** `npx vitest run packages/narrative`
- [ ] **Step 5: Commit** `feat(narrative): offline drafter produces the v4 shape within limits`.

### Task C4: Service derives legacy fields, bumps the cache, extends edits

**Files:**
- Modify: `apps/api/src/service.ts` (cache `v: 4`; edits overlay for every prose field; `legacyFields(output)` derivation), `apps/api/src/store/types.ts` (`NarrativeEdits` gains `lede?, did?, saw?, decisions?, plan?, protection?`)
- Test: `apps/api/test/service.test.ts`

- [ ] **Step 1: Write the failing test**: a v4 narrative result yields `report.model.executive.paragraphs` equal to `[lede]`, `highlights` equal to `[...did, ...saw]`, and `recommendations` equal to the flattened plan as `"{action} ({owner})"`; author edits to `did` win over the model's.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**; the hash object becomes `{ v: 4, model, input }`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/service.test.ts apps/api/test/serviceVerify.test.ts`
- [ ] **Step 5: Commit** `feat(api): narrative v4 wiring, cache v4, edits cover every prose field`.

### Task C5: Document findings

**Files:**
- Modify: `apps/api/src/docExtract.ts` (`DocExtraction.findings`, schema, prompt), `apps/api/src/handlers.ts` (`extractQbrDocument` stores `findings` on the `DocumentRecord`), `apps/api/src/store/index.ts` (`loadReportInputs` documents carry `findings`), `packages/narrative/src/input.ts` (`documents[].findings?`), `packages/narrative/src/numbers.ts` or wherever `buildAllowedNumbers` lives (figures in findings are allowed)
- Test: `apps/api/test/docExtract.test.ts`, `packages/narrative/test/verify.test.ts`

- [ ] **Step 1: Write the failing tests**: the extractor's structured schema requires `findings` (array of `{ text, severity }`, severity enum `info|watch|act`); a fake extractor returning a finding "One lab PC (TGA2) has not backed up in 389 days" makes `389` an allowed figure for the narrative; a finding containing `someone@example.com` is dropped by the post-check; for a HIPAA client the extractor input carries `coveredEntity: true`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the schema addition (`findings` before `note`, max 5 items), the prompt paragraph: "findings: up to 5 short sentences (under 25 words, figures included) an account manager must not miss: failed or stale backups, devices not seen, unresolved incidents, expiring agreements. Never include a person's name or email address. When coveredEntity is true, findings describe systems, never people.", the post-check `findings.filter((f) => !/\S+@\S+\.\S+/.test(f.text))`, and the plumbing.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/docExtract.test.ts packages/narrative`
- [ ] **Step 5: Commit** `feat(api,narrative): attached report findings feed the narrative and its allowed figures`.

### Task C6: Since last quarter and conversation status

**Files:**
- Modify: `packages/report/src/model.ts` (`ReportModel.sinceLastQuarter`, `ReportModel.protection`, `conversationStatus()`), `apps/api/src/service.ts` (passes `previousDiscussion` and an optional `lookupTicketStatus` into `buildReportModel`), `apps/api/src/store/index.ts` (`loadReportInputs` also loads the previous period's discussion)
- Test: `packages/report/test/sinceLast.test.ts`

**Interfaces:**

```ts
export type ConversationStatus = 'on_plan' | 'in_progress' | 'waiting' | 'done' | 'closed';
export function conversationStatus(item: DiscussionItem): ConversationStatus;
export interface SinceLastRow { topic: string; status: 'done' | 'in_progress' | 'waiting' | 'closed'; detail?: string }
// buildReportModel args gain: previousDiscussion?: DiscussionItem[]; ticketStatuses?: Record<string, string>  (externalRef id -> live Halo status)
// ReportModel gains: sinceLastQuarter: SinceLastRow[]; protection: Array<ProtectionRow & { inPlace?: string; thisQuarter?: string }> (rows from protectionRows(scorecard), prose merged by question id from narrative.protection); revisedAt?: string
```

Mapping (spec): `create_ticket` with a non-closed external status is `in_progress`; `no_action` is `closed`; planned with no response is `waiting`; discussed with a closed external status is `done`; otherwise `on_plan`. Closed statuses match `/closed|resolved|complete/i`. `sinceLastQuarter` takes at most 5 previous items with `includeInReport !== false`, mapping `on_plan` to `in_progress` for the row, and is `[]` when `config.showSinceLastQuarter === false`.

- [ ] **Step 1: Write the failing test** covering each mapping and the empty previous quarter (Review Focus 1: `sinceLastQuarter` is `[]`).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**; in `service.ts`, when a Halo direct connection exists, look up each `externalRef.id` with `haloGet(http, cfg, \`Tickets/${id}\`)` reading `status_name ?? status`, swallowing failures (fall back to stored status). Keep the lookup behind an injected `lookupTicketStatus?: (id: string) => Promise<string | undefined>` so tests pass a stub.
- [ ] **Step 4: Run** `npx vitest run packages/report apps/api/test/service.test.ts`
- [ ] **Step 5: Commit** `feat(report,api): since-last-quarter rows and conversation statuses on the model`.

### Task C7: Investment model

**Files:**
- Modify: `packages/report/src/model.ts` (`InvestmentModel` as in the spec; `buildReportModel` args gain `budget?: { planVsActual?: InvestmentModel['planVsActual']; outlook?: BudgetOutlook; unitCost?: number }`)
- Test: `packages/report/test/investment.test.ts`

- [ ] **Step 1: Write the failing test** from the ANP Q2 seed shape: `invoiced` equals `finance.quarter_invoiced`; `recurring` sums lines whose label matches a `finance.recurring.*` label; `variable = invoiced - recurring`; `comingUp` includes "10 devices past warranty" priced only when `unitCost` is given; `outlook` is undefined when no budget is passed.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**; `BudgetOutlook` is imported from `@mashit/core` (S0).
- [ ] **Step 4: Run** `npx vitest run packages/report`
- [ ] **Step 5: Commit** `feat(report): investment model with recurring and variable split and plan versus actual slot`.

### Task C8: Renderers for the v2 page structure

**Files:**
- Modify: `packages/report/src/html.ts`, `packages/report/src/pdf.ts`, `packages/report/src/deck.ts`, `packages/report/src/charts.ts` (tile selection unchanged; add `investmentBarsSvg(breakdown, width)` and `planMeterSvg(pct, width)`)
- Test: `packages/report/test/pages.test.ts`, `packages/report/test/readability.test.ts`, `packages/report/test/deliverables.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('orders the PDF as cover, at a glance, protection, decisions, investment, numbers, appendix', () => {
  const titles = h1Titles(buildPdfDefinition(model)); // helper: collect text of nodes with style h1
  expect(titles).toEqual([model.executive.headline, 'How we are protecting you', 'Decisions and the next 90 days', 'Your IT investment', 'Quarter in numbers', 'Appendix: Attached reports']);
});
it('adds the planning page only in the planning quarter', () => {
  const planning = buildReportModel({ ...args, budget: { outlook } });
  expect(h1Titles(buildPdfDefinition(planning))).toContain('Planning your FY2027 IT budget');
  expect(h1Titles(buildPdfDefinition(model))).not.toContain('Planning your FY2027 IT budget');
});
it('readability: no font under 8, body 10 or more, charts unbreakable, margins at least 54', () => {
  const def = buildPdfDefinition(model) as Record<string, unknown>;
  const json = JSON.stringify(def.content);
  for (const m of json.matchAll(/"fontSize":(\d+(?:\.\d+)?)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(8);
  expect((def.styles as Record<string, { fontSize: number }>).body.fontSize).toBeGreaterThanOrEqual(10);
  expect((def.pageMargins as number[]).every((n) => n >= 54)).toBe(true);
  for (const node of walk(def.content)) if (node.svg) expect(parentIsUnbreakable(node)).toBe(true);
});
it('omits Since last quarter when there is nothing to show', () => {
  expect(JSON.stringify(buildPdfDefinition({ ...model, sinceLastQuarter: [] }))).not.toContain('Since last quarter');
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the page sequence in all three renderers per the spec table. PDF: `styles.body.fontSize` 10.5 stays; `small` becomes 8.5 (already); set `th` to 8.5 and ensure no literal fontSize below 8. Page one columns use a three-column `columns` node with `unbreakable: true`; the decisions column gets `fillColor` of the watch wash and a checkbox glyph drawn as a 7pt square via `canvas`. Page two is the five-row table (`headerRows: 1`, columns question / in place / this quarter / status chip with the function scores beneath in `small`). Page three: conversations table then a three-column Now / Next / Later `columns` node, each item `[bold action, small owner, small watch-colored "Your decision" when flagged]`. Page four: three tiles, `investmentBarsSvg`, `planMeterSvg` with the note, "Coming up" list; page 4b when `outlook` is present. Numbers section opens with the movers block from A3. Appendix adds a "How we score" paragraph (the old explainer text). Footer appends `Revised on {date}` when `model.revisedAt` is set. HTML mirrors with semantic classes and the A3 print rules. Deck: one slide per page; the protection table and plan reuse `addTableSlides`; numbers tables stay as appendix slides.
- [ ] **Step 4: Run** `npx vitest run packages/report && npm run typecheck`, then render the ANP Q2 PDF with the existing CLI (`apps/api/src/cli.ts`) and check every page at 100% zoom against the approved mockups.
- [ ] **Step 5: Commit** `feat(report): executive-first page structure in HTML, PDF and deck with readability guarantees`.

### Task C9: Narrative editor and overview for v4

**Files:**
- Modify: `apps/web/src/pages/workspace/NarrativeEditor.tsx` (fields: headline, lede, did, saw, decisions, plan, protection; live counters "x of 12 words" turning `act` when over; style issues listed), `apps/web/src/pages/workspace/OverviewTab.tsx` (shows headline, lede, did/saw, decisions, since last quarter, protection rows), `apps/web/src/types.ts` (ReportModel mirror), `apps/web/src/api.ts` (narrative edits type)
- Test: `apps/web/test/narrativeLimits.test.ts` (a pure helper `counterState(text, limit)` returning `{ count, over }`)

- [ ] **Step 1: Write the failing test** for `counterState('one two three', 2)` giving `{ count: 3, over: true }`.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npx vitest run apps/web && npx tsc -p apps/web/tsconfig.json --noEmit`
- [ ] **Step 5: Commit** `feat(web): narrative editor for the v4 shape with limit counters; overview mirrors page one`.

---

## Workstream D: fiscal years and the budget planner (subagent, after C7)

### Task D1: Fiscal helpers

**Files:**
- Modify: `packages/core/src/period.ts`
- Test: `packages/core/test/period.test.ts`

**Interfaces:**

```ts
export interface FiscalYear { label: number; startPeriod: string; endPeriod: string; startMonth: number }
export function fiscalYearOf(periodId: string, startMonth = 1): FiscalYear;
export function planningPeriodFor(fiscalLabel: number, startMonth = 1): string;
export function isPlanningPeriod(periodId: string, startMonth = 1): boolean;
export function fiscalPeriods(fiscalLabel: number, startMonth = 1): string[]; // the four period ids in the fiscal year, oldest first
```

- [ ] **Step 1: Write the failing test**

```ts
it('labels fiscal years by the year they end', () => {
  expect(fiscalYearOf('2026-Q3', 1)).toEqual({ label: 2026, startPeriod: '2026-Q1', endPeriod: '2026-Q4', startMonth: 1 });
  expect(fiscalYearOf('2026-Q3', 7)).toEqual({ label: 2027, startPeriod: '2026-Q3', endPeriod: '2027-Q2', startMonth: 7 });
  expect(fiscalYearOf('2026-Q2', 7).label).toBe(2026);
});
it('finds the review quarter before the fiscal year turns', () => {
  expect(planningPeriodFor(2027, 1)).toBe('2026-Q3');
  expect(planningPeriodFor(2027, 4)).toBe('2025-Q4');
  expect(planningPeriodFor(2027, 7)).toBe('2026-Q1');
  expect(planningPeriodFor(2027, 10)).toBe('2026-Q2');
  expect(isPlanningPeriod('2026-Q3', 1)).toBe(true);
  expect(isPlanningPeriod('2026-Q2', 1)).toBe(false);
  expect(isPlanningPeriod('2026-Q1', 7)).toBe(true);
});
it('rejects malformed ids and treats undefined start month as January', () => {
  expect(() => fiscalYearOf('nope')).toThrow(/Invalid period id/);
  expect(isPlanningPeriod('2026-Q3', undefined)).toBe(true);
  expect(fiscalPeriods(2027, 7)).toEqual(['2026-Q3', '2026-Q4', '2027-Q1', '2027-Q2']);
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**

```ts
const startQuarterOf = (startMonth: number): Quarter => Math.ceil(startMonth / 3) as Quarter;

export function fiscalYearOf(periodId: string, startMonth = 1): FiscalYear {
  const p = parsePeriod(periodId);
  const qS = startQuarterOf(startMonth);
  // The fiscal year that contains p starts at qS in p.year when p.quarter >= qS, else in p.year - 1.
  const startYear = p.quarter >= qS ? p.year : p.year - 1;
  const endsNextYear = qS !== 1;
  const label = endsNextYear ? startYear + 1 : startYear;
  const endQuarter = qS === 1 ? 4 : ((qS - 1) as Quarter);
  return { label, startPeriod: `${startYear}-Q${qS}`, endPeriod: `${endsNextYear ? startYear + 1 : startYear}-Q${endQuarter}`, startMonth };
}
export function fiscalPeriods(fiscalLabel: number, startMonth = 1): string[] {
  const qS = startQuarterOf(startMonth);
  const startYear = qS === 1 ? fiscalLabel : fiscalLabel - 1;
  const out: string[] = [];
  let year = startYear; let q: number = qS;
  for (let i = 0; i < 4; i++) { out.push(`${year}-Q${q}`); q += 1; if (q === 5) { q = 1; year += 1; } }
  return out;
}
export function planningPeriodFor(fiscalLabel: number, startMonth = 1): string {
  const qS = startQuarterOf(startMonth);
  const startYear = qS === 1 ? fiscalLabel : fiscalLabel - 1;
  let q = qS - 2; let year = startYear;
  while (q < 1) { q += 4; year -= 1; }
  return `${year}-Q${q}`;
}
export function isPlanningPeriod(periodId: string, startMonth = 1): boolean {
  const p = parsePeriod(periodId);
  const thisFy = fiscalYearOf(periodId, startMonth);
  return planningPeriodFor(thisFy.label + 1, startMonth) === p.id;
}
```

- [ ] **Step 4: Run** `npx vitest run packages/core/test/period.test.ts`
- [ ] **Step 5: Commit** `feat(core): fiscal year helpers and the planning quarter rule`.

### Task D2: Outlook computation

**Files:**
- Create: `packages/core/src/budget.ts`; export from index
- Test: `packages/core/test/budget.test.ts`

**Interfaces:**

```ts
export interface BudgetFacts {
  mrr?: number;                                   // finance.mrr
  perUserMonthly?: number;                        // Managed End User line / licensed users
  paidSeats?: number; seatMonthly?: number;       // CIPP paid seats; M365 invoice line / seats
  devicesAgingOut?: number; devicesAgingNextYear?: number;
  quarterlyVariable?: number[];                   // trailing four quarters of non-recurring invoiced
  projects?: Array<{ name: string; low?: number; high?: number }>;
}
export function computeOutlook(facts: BudgetFacts, answers: BudgetAnswers): { lines: BudgetLine[]; totals: { low: number; expected: number; high: number }; caveats: string[] };
export function planVsActual(plannedExpected: number, spentByPeriod: number[]): { planned: number; spent: number; pct: number; note: string };
```

Formulas per the spec table. `BudgetAnswers`, `BudgetLine`, `BudgetSource` and `BudgetOutlook` already live in `packages/core/src/types.ts` (S0).

- [ ] **Step 1: Write the failing tests**: the worked example (MRR 5,460; 2 hires at 165; 32 seats at 34.65; Copilot 10 at 30; 15 devices at 1,650 with `at_warranty_end`; projects 9,000 to 18,000; variable quarters 2,000, 3,400, 2,100, 4,000; `balanced`) yields managed 65,520 / 65,520 / 69,480, hardware 21,038 / 24,750 / 28,463 (rounded to whole dollars), support 8,000 / 11,500 / 16,000, contingency 0 / 10% of expected / same; Review Focus 3: no MRR yields a zero managed line with basis note "No recurring value on Halo contracts" and `caveats` containing "Managed services could not be computed from Halo; the total is understated."; `planVsActual(118000, [30578, 21019])` gives `pct 44` and a note starting "Under plan".
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**; round every line to whole dollars at the end; totals sum lines; the note bands compare `pct` with the pro-rata share (`100 * quartersInvoiced / 4`): within 10% of that share, relative (share * 0.9 to share * 1.1), is "On plan", below is "Under plan", above is "Over plan", each followed by the pro-rata sentence "{pct}% of the plan spent with {n} of 4 quarters invoiced."
- [ ] **Step 4: Run** `npx vitest run packages/core`
- [ ] **Step 5: Commit** `feat(core): deterministic budget outlook and plan versus actual`.

### Task D3: Budget API

**Files:**
- Create: `apps/api/src/budget.ts` (handlers: `listBudgets`, `getBudget`, `putBudget`, `recomputeBudget`, `publishBudget`)
- Modify: `apps/api/src/functions.ts` (block "Workstream D", the five routes from the spec)
- Test: `apps/api/test/budget.test.ts`

- [ ] **Step 1: Write the failing tests**: `putBudget` saves answers and audits; `recomputeBudget` builds `BudgetFacts` from the client's latest snapshot (`finance.mrr`, `finance.quarter_invoiced` across the trailing four periods, `licenses.total`, `assets.out_of_warranty`, `assets.expiring_90d`) and the opportunity board (`value` with `valueKind === 'one_time'` as both low and high), then stores lines and totals; `publishBudget` sets `status: 'published'`, `publishedPeriod = planningPeriodFor(fiscalLabel, client.fiscalYearStartMonth ?? 1)`, and answers 409 when that period's data is locked.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** using `getDataStore()`, `storeDataSource()`, `audit` (export `audit` and `patchQbr`-style helpers from `handlers.ts` or move `audit` to `apps/api/src/audit.ts` and import it in both).
- [ ] **Step 4: Run** `npx vitest run apps/api/test/budget.test.ts && npm run typecheck`
- [ ] **Step 5: Commit** `feat(api): budget plan routes with recompute and publish`.

### Task D4: Industry context, internal only

**Files:**
- Create: `apps/api/src/budgetResearch.ts` (`createClaudeBudgetResearcher(client?, modelId?)`, prompt returns `{ items: BudgetContextItem[], sourced: boolean }` with web search as in `research.ts`)
- Modify: `apps/api/src/budget.ts` (`contextBudget` handler), `apps/api/src/functions.ts` (block "Workstream D")
- Test: `apps/api/test/budget.test.ts`

- [ ] **Step 1: Write the failing test**: a stub researcher's items land on `plan.context.items` with `researchedAt`; `getBudget` returns them; a subsequent `buildQbrReport` for the planning period produces a narrative input whose JSON does not contain any `context.items[].title` text (assert with a spy on the narrative model's input).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**; prompt instructs: recent, cited, for this industry and compliance standard, each item with `askClient` (the question to raise with the client); "Return ONLY the JSON object."
- [ ] **Step 4: Run** `npx vitest run apps/api/test/budget.test.ts`
- [ ] **Step 5: Commit** `feat(api): AI industry context for budget prep, stored internal only`.

### Task D5: Investment data into the report

**Files:**
- Modify: `apps/api/src/store/index.ts` (`loadReportInputs` returns `budget` for the period: `planVsActual` from the published plan covering the period's fiscal year and spent from the fiscal periods' `finance.quarter_invoiced`; `outlook` only when `isPlanningPeriod(period, client.fiscalYearStartMonth)` and a published plan for `fiscalYearOf(period).label + 1` exists; `unitCost` from that plan's answers), `apps/api/src/service.ts` (passes `budget` to `buildReportModel`)
- Test: `apps/api/test/service.test.ts`

- [ ] **Step 1: Write the failing test**: with a published FY2027 plan and client start month 1, `buildQbrReport` for `2026-Q3` has `model.investment.outlook` and for `2026-Q2` does not; `planVsActual.spent` sums the fiscal periods seen so far.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npx vitest run apps/api`
- [ ] **Step 5: Commit** `feat(api): investment page data from the published budget plan`.

### Task D6: Budget tab and fiscal year field

**Files:**
- Create: `apps/web/src/pages/workspace/BudgetTab.tsx`
- Modify: `apps/web/src/pages/Workspace.tsx` (tab registration only; one line in the tabs list and one panel), `apps/web/src/pages/Clients.tsx` (Select "Fiscal year starts" with the twelve months, default January), `apps/web/src/api.ts` (budget calls)
- Test: `npx tsc -p apps/web/tsconfig.json --noEmit`; manual pass with Playwright at 1440 and 390

- [ ] Build the three-column layout from the approved mockup: known facts card with source tags, six-step questionnaire (People, Places, Projects, Lifecycle, Compliance, Appetite) with the hints from the mockup, context card labelled "Internal only" with the guardrail sentence, outlook table with a source tag per number, plan-versus-actual strip, actions "Re-run outlook" and "Put on the report". A "Planning quarter" banner shows when `isPlanningPeriod`. Commit `feat(web): budget planner tab and client fiscal year`.

---

## Workstream E: conversations (subagent, after B)

### Task E1: Forward to QBR

**Files:**
- Modify: `apps/api/src/reportInbox.ts` (`processMessage` no-attachment branch; `InboxPollResult.agenda: number`), `apps/api/src/handlers.ts` (`pollInbox` detail includes `agenda`)
- Test: `apps/api/test/reportInbox.test.ts`

- [ ] **Step 1: Write the failing tests**: a routed message with `hasAttachments: false`, subject `"Fw: New hire starting Nov 3"`, body text `"Hi Jason, we have..."` creates a discussion item on the open quarter with `topic: 'New hire starting Nov 3'`, `status: 'planned'`, `includeInReport: false`, `source: 'email'`, `sourceRef: msg.id`, `owner` the sender display name, `response` the first 400 characters; for a HIPAA client `response` is undefined; the message is categorized `'QBR: agenda'`; Review Focus 4: subject `"Fw:"` creates nothing and is categorized `'QBR: no subject'` and counted unrouted.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**: fetch the body with `$select=body` using `bodyPreview` or `body.content` stripped of tags; the open quarter is the newest period with a snapshot and no `locks.final`, else `periodFor(now).id`; strip `^((fw|fwd|re|aw):\s*)+` case-insensitively; append via `store.putDiscussion` preserving existing items and `sortOrder = max + 1`.
- [ ] **Step 4: Run** `npx vitest run apps/api/test/reportInbox.test.ts`
- [ ] **Step 5: Commit** `feat(api): forwarded emails without attachments become draft agenda items`.

### Task E2: Suggested conversations from Halo

**Files:**
- Modify: `packages/integrations/src/haloDirect.ts` (`listHaloConversations`)
- Create: `apps/api/src/conversations.ts` (`suggestedConversations(clientId, period)` handler)
- Modify: `apps/api/src/functions.ts` (block "Workstream E"): `GET api/clients/{clientId}/qbr/{period}/conversations/suggested`
- Test: `packages/integrations/test/haloDirect.test.ts`, `apps/api/test/conversations.test.ts`

**Interfaces:**

```ts
export interface HaloConversation { topic: string; detail?: string; source: 'halo_ticket' | 'halo_opportunity' | 'halo_note'; ref: string; when: string }
export async function listHaloConversations(http: HttpTransport, cfg: HaloCfg, args: { clientId: string; start: string; end: string; primaryContactEmail?: string }): Promise<{ items: HaloConversation[]; warnings: string[] }>;
```

Tickets: `haloGet('Tickets', { client_id, startdate: start, enddate: end, ... })` filtered to `classifyTicketType(tickettype_name)` in `service_request | change | problem` and (when `primaryContactEmail` is set) `user_email` equal to it, else any ticket flagged `isvip`/`vip` truthy. Opportunities and CRM notes: attempt `haloGet('Opportunities', { client_id })` and `haloGet('CRMNote', { client_id })`; both are UNVERIFIED against the Halo API docs; a 404 or thrown error adds a warning "Halo opportunities/CRM notes not available on this instance" and the collector returns tickets only.

- [ ] **Step 1: Write the failing tests**: a transport stub answering tickets and 404 for the other two endpoints yields ticket items only and one warning; a ticket of type Incident is excluded; the handler maps items to the response and, for a HIPAA client, still returns them (internal view).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npx vitest run packages/integrations apps/api/test/conversations.test.ts`
- [ ] **Step 5: Commit** `feat(integrations,api): suggested conversations from Halo requests, opportunities and notes`.

### Task E3: Meeting tab suggestions

**Files:**
- Modify: `apps/web/src/pages/workspace/MeetingTab.tsx` (second list "Conversations from Halo and email" beside the existing AI talking points, each row with Add; added items get `source: 'suggested'` and, for HIPAA clients, `includeInReport: false`), `apps/web/src/api.ts`

- [ ] Implement, typecheck, commit `feat(web): add suggested conversations to the agenda in one click`.

---

## Whole-branch verification (parent)

- [ ] `npm run typecheck && npx vitest run && npx tsc -p apps/web/tsconfig.json --noEmit && npm run deploy:build`
- [ ] Render the ANP Q2 2026 PDF and deck; compare every page with the approved mockups at 100% zoom; confirm no font under 8pt, no split chart, six pages before the appendix.
- [ ] Lock flow end to end on the dev server: package sent stores v1; edits refused; decisions captured stores v2; reopen; re-lock stores v3 with "Revised on".
- [ ] Budget flow: set KPCA to July, confirm the Planning banner on the 2026-Q1 review and not on 2026-Q2; publish; the Q1 report carries the outlook page.
- [ ] Open the PR against `claude/stoic-faraday-5lihr9` with a body ending in `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
