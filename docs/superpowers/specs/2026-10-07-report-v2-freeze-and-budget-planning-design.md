# Report v2, frozen quarters, and budget planning: design

Date: 2026-10-07. Base: commit 2ed1a4d on `claude/stoic-faraday-5lihr9` (PR #1 merged and deployed).
Source: Jason's review of the ANP Enertech Q2 2026 package and the brainstorm that
followed (mockups kept under `.superpowers/brainstorm/442-1791400203/content/`).

## Goal

An executive opens the QBR and, in two pages, knows what we did, what changed,
what we need from them, and what next year will cost. Finished quarters are
stable, free to reopen, and never rebuilt. The prose reads like a person wrote
it. The platform proves we know the client's business, not only their tickets.

## Non-goals

- Reading anyone's mailbox. Conversation capture is deliberate forwarding plus
  Halo data, nothing passive.
- Printing industry benchmark figures on a client deliverable. Benchmarks are
  internal prep material only (Jason's decision, 2026-10-07).
- Regional cost adjustments for IT spend. No credible source exists.
- Replacing pdfmake or embedding fonts. The PDF stays on Helvetica.
- ETag concurrency on the Table store. Still a follow-up.

## Decisions made with Jason (binding)

1. Benchmarks are AI-sourced context shown only to Mash IT staff. The client
   page carries our own bottom-up numbers and nothing else.
2. Quarters freeze in two stages. Lock 1 at "package sent" freezes data and
   narrative and stores the pre-read package. Lock 2 at "decisions captured"
   stores the final package. A Finalize button performs lock 2 by hand for
   skipped meetings. Reopen is an audited override with a reason.
3. Page one combines the "brief, then evidence" opening (headline, one short
   paragraph, four tiles) with the three-column body (what we did, what we
   saw, what we need from you) and closes with "Since last quarter".
4. Page two tells the protection story as five business questions, with the
   NIST function and score in the margin for the auditor.
5. Page three merges conversations and recommendations into "Decisions and
   the next 90 days" (status table plus Now / Next / Later with owners).
6. Page four is "Your IT investment". In the planning quarter the twelve-month
   outlook gets its own page.
7. Readability is a hard requirement, not a taste call. Rules are in the
   report section below. Page count is a target, never a reason to squeeze.

## Assumptions (stated because they were not confirmed)

- Jason fills the budget questionnaire during prep and may revise answers in
  the meeting. The client page shows low, expected and high, never one number.
- The full planning section appears in the QBR held in the quarter before the
  fiscal year starts (Q3 review for calendar-year clients, Q1 review for a
  July fiscal year). Other quarters show plan versus actual only.
- Narrative limits: headline under 12 words, one paragraph under 60, three or
  four bullets per column under 18 words each, at most three decisions, at
  most three items per 90-day column.
- "Since last quarter" is on by default and can be hidden per client.
- Forwarding an email with no attachment to the client's plus-address creates
  a draft agenda item. For HIPAA clients only the subject is stored.
- The deck mirrors the PDF page structure, one slide per page, numbers as
  appendix slides.
- The work ships as five workstreams on one integration branch, parallel
  implementers as before, quick fixes first.

## Workstream A: quick fixes

Bounded changes that stand on their own and ship first.

A1. Paid seats only. `normalizeCippLicenses` gains a `FREE_SKU_PART_NUMBERS`
set of Microsoft part numbers for free, trial and developer plans. The
implementer verifies every entry against Microsoft's "Product names and
service plan identifiers for licensing" reference; the starting list is Power
Apps for Developer, Power Automate Free, Power BI (free), Teams Exploratory,
Rights Management Adhoc, Microsoft Business Center, Windows Store for Business,
Power Virtual Agents viral trial, Dynamics 365 trials. A second net catches
unknown free plans: a SKU with at least 1,000 units and under 5% assigned is
not counted and raises a warning naming it. Metric labels change to "Paid
license seats" (`licenses.total`) and "Unused paid seats" (`licenses.unassigned`,
key kept for trend continuity). Detail rows carry `counted: 'yes' | 'no, free
or developer plan'`. Warning text: "N Microsoft plans are free or developer
SKUs and were not counted: names."

A2. Download names. Every deliverable is named `Mash IT QBR - {Client} -
{Q2 2026}.{pdf|html|pptx}`; the emailed PDF uses the same name. The PDF and
HTML routes send `Content-Disposition: inline; filename=...` so the browser
still opens them and saves them with the right name. The deck stays
`attachment`. One helper in `handlers.ts` builds the name; the client name is
sanitized as the deck already does.

A3. Blocks never split. In the PDF, a heading plus its caption and chart is
one `unbreakable` stack; headings use `headlineLevel` so they keep with the
next block; the tile band and every callout are unbreakable; tables keep
`headerRows: 1`. In the HTML print CSS, `h2 { break-after: avoid }` and
`.block { break-inside: avoid }` on the same elements. The cover page drops
the duplicated "Prepared by Mash IT. Confidential." line (the footer has it).

A4. Human prose lint. The narrative prompt forbids em dashes and a short list
of model phrases (reinforces, underscores, leaves room to climb, worth a
brief review, robust, leverage, landscape, holistic, seamless, journey,
navigate, foster, a testament to, it is worth noting, in today's). The
offline drafter is swept for the same. `verifyNarrative` gains a non-blocking
`style` array listing hits; the editor shows them as counters next to the
word-count counters from workstream C.

A5. Repo hygiene. `.gitignore` gains `.superpowers/` and `.claude/worktrees/`.

A6. Dashboard links. The "Review complete" cell links to
`/clients/{id}?period={p}`. Every link into a workspace carries the period.

A7. Infra truth. README and Bicep say Flex Consumption FC1, Node 24,
blob-container deployment storage, which is what `mashqbr` actually runs.
The Bicep change is documentation only until someone provisions from it.

## Workstream B: frozen quarters

### Types

```ts
// apps/api/src/store/types.ts
export interface LockInfo { at: string; by: string; version: number }
export interface QbrRecord {
  // existing fields, plus:
  locks?: { preread?: LockInfo; final?: LockInfo };
  reopened?: Array<{ at: string; by: string; stage: 'preread' | 'final'; reason: string }>;
}
export interface PackageRecord {
  clientId: string; period: string;
  version: number;                       // 1, 2, 3... per client+period
  stage: 'preread' | 'final';
  createdAt: string; createdBy: string;
  files: { model: string; pdf: string; pptx: string; html: string }; // DocContentStore keys
  warnings: string[];                    // build warnings at lock time
}
// DataStore additions
listPackages(clientId, period): Promise<PackageRecord[]>;
putPackage(record: PackageRecord): Promise<PackageRecord>;
```

Blobs live in `DocContentStore` under `packages/{clientId}/{period}/v{n}/report.{json|pdf|pptx|html}`.
The JSON is the serialized `ReportModel` plus `narrative.verification` and the
build warnings.

### Lock semantics

- `dataLocked(record)` is true when `locks.preread` or `locks.final` exists.
  `isFinal(record)` is true when `locks.final` exists.
- When data is locked these routes answer `409 { error: 'locked', stage }`:
  `POST sync`, `POST narrative/regenerate`, `PUT narrative`, `PUT metrics`,
  `POST metrics/import`, `DELETE metrics/import`, `PATCH documents`,
  `POST documents` (new attachments), `DELETE documents`.
- When final, `PUT discussion` and `PUT schedule` also answer 409.
- `GET qbr`, `report.html`, `report.pdf`, `deck.pptx`, `email.eml`: when any
  lock exists, serve the newest stored package of the highest stage present.
  `?ai=` is ignored. Nothing is rebuilt, no model is called. `GET qbr` adds
  `package: { version, stage, createdAt }` to its response.
- Lock 1 happens inside `POST package/sent` when no lock exists: build the
  report once, render PDF (with attachments appended), deck and HTML, store
  package v1 stage `preread`, set `locks.preread`, then build the email from
  the stored PDF. If a lock already exists the route reuses the stored files.
- Lock 2 happens when status becomes `dispositioned` (the disposition flow)
  or on `POST .../finalize`. It builds the report with the discussion and
  notes, renders and stores the next version at stage `final`, sets
  `locks.final`, and advances status to at least `dispositioned`.
  `finalize` on a quarter with no snapshot answers 404.
- `POST .../reopen { stage, reason }` is audited. Reopening `final` clears
  `locks.final` only; reopening `preread` clears both. Stored packages are
  kept. The next lock stores a new version and the model carries
  `revisedAt`, which the renderers print in the footer as "Revised on date".
- Edits to shared records (client goals, brand, org settings, attachments
  filed later) never touch a locked quarter, because locked quarters serve
  stored models. No special casing needed; the tests assert it.

### Workspace behaviour

- Landing on `/clients/{id}` with no period: pick the open quarter (has a
  snapshot and no final lock), else the newest final quarter read-only with a
  "Start next quarter" action. The URL is rewritten to carry `?period=`.
- A locked quarter shows a banner: "Pre-read sent on date. Data and narrative
  are locked; the agenda is open until decisions are captured." or "Final
  package stored on date. Read-only." The Sync, Regenerate, Edit narrative and
  Data-tab review controls are disabled with that reason. Reopen sits in the
  header overflow menu behind a reason dialog.
- Primary action after `completed` with no final lock is Finalize.
- Dashboard triage gains `needs_finalizing`: meeting date more than seven days
  past, or status `completed`, with no final lock.
- `QbrMeta` on the web carries `locks`, `package` and `reopened`; `nextStep`
  and `PipelineStepper` read them.

## Workstream C: report v2

### Narrative contract (v4)

```ts
// packages/narrative/src/schema.ts
export type ProtectionQuestion = 'get_in' | 'know' | 'recover' | 'keep_up' | 'run_well';
export interface PlanItem { action: string; owner: string; decision?: boolean }
export interface NarrativeOutput {
  headline: string;                               // <= 12 words
  lede: string;                                   // <= 60 words, one paragraph
  did: string[];                                  // 3..4 items, <= 18 words each
  saw: string[];                                  // 3..4 items, <= 18 words each
  decisions: Array<{ ask: string; why?: string; by?: string }>;   // 0..3
  plan: { now: PlanItem[]; next: PlanItem[]; later: PlanItem[] };  // 0..3 each
  protection: Array<{ question: ProtectionQuestion; inPlace: string; thisQuarter: string }>; // exactly 5, <= 40 words per field
  section_summaries?: Array<{ category: string; summary: string }>;
  figures_referenced: string[];
}
```

The legacy fields are derived, not generated: `summary_paragraphs = [lede]`,
`highlights = [...did, ...saw]`, `recommendations = plan flattened with owner`.
The cache fingerprint bumps to `v: 4`. The offline drafter produces every
field from metrics, insights, flags and document findings, within the limits
by construction. The shape check enforces counts and word limits; a limit
breach is a verification failure that the editor shows with counters, never a
silent truncation. `NarrativeEdits` covers every prose field.
`verifyNarrative` scans every string in the output, as it does today.

### Document findings

`DocExtraction` gains `findings: Array<{ text: string; severity: 'info' |
'watch' | 'act' }>` (at most 5, each at most 25 words, figures included).
`DocumentRecord` stores them as `findings` when extraction runs.
`buildNarrativeInput` passes `documents[].findings` to the model, and the
figures in findings join the allowed set so the prose may quote them. The
extractor prompt forbids personal names and email addresses in findings; a
post-check strips anything shaped like an address. For HIPAA clients the
findings are still extracted but the prompt is told the client is a covered
entity and findings must be about systems, never people.

This is what turns "the zero for device backup is a reporting artifact" into
"one lab PC has not backed up in 389 days", which the Synology report said.

### Protection questions

Defined in `packages/core/src/protection.ts`:

| id | Question | Safeguards |
|----|----------|------------|
| get_in | Can someone get in? | mfa, email_security |
| know | Would we know, and how fast would we act? | edr, identity_threat, siem, incident_response |
| recover | Could we recover? | backup, data_protection |
| keep_up | Are we keeping up? | patching, asset_inventory |
| run_well | Are we running it well? | governance, sat |

Status per question is the lowest rating among its measured safeguards, or
`unknown` when none is measured. The margin lists the contributing
safeguards' NIST functions and scores. The overall score stays as a small
ring with the one-sentence confidence note. The "How to read this score"
paragraph leaves page two and becomes a short "How we score" note in the
appendix. `inPlace` and `thisQuarter` come from the narrative (verified
figures); the offline drafter templates them from the safeguard evidence.

### Since last quarter

`ReportModel.sinceLastQuarter: Array<{ topic: string; status: 'done' |
'in_progress' | 'waiting' | 'closed'; detail?: string }>`, at most five rows,
built from the previous period's discussion items: `disposition` and
`status` give the base state; `externalRef.status` refines it when the item
was pushed to Halo (`service.ts` looks the ticket up through the existing Halo
transport at build time and falls back to the stored status). Hidden when
empty. `ReportConfig.showSinceLastQuarter?: boolean` defaults to true.

### Conversations table

Page three maps each `DiscussionItem` to a chip: `create_ticket` with an open
external status is "In progress", `no_action` is "Closed", a planned item with
no response is "Waiting", a discussed item with a resolved external status is
"Done", anything else is "On plan". The owner column shows `owner`.

### Investment model

```ts
export interface InvestmentModel {
  invoiced: number; recurring: number; variable: number;      // this quarter
  previousInvoiced?: number;
  breakdown: Array<{ label: string; amount: number; recurring: boolean }>;
  planVsActual?: { fiscalYearLabel: string; planned: number; spent: number; pct: number; note: string };
  comingUp: string[];                                          // deterministic sentences
  outlook?: BudgetOutlook;                                     // planning quarter only
}
```

`recurring` is the sum of invoice lines whose Halo item group matches the
recurring breakdown (`finance.recurring.*`); everything else is `variable`.
`comingUp` is deterministic: out-of-warranty devices priced at the client's
planning unit cost when a budget plan exists, paid-seat utilisation, and
agreements renewing within 90 days. The planning-quarter sentence ("At the Q3
review in October we will plan the 2027 budget together") comes from the
fiscal year helpers in workstream D.

### Page structure and renderers

All three renderers (HTML, PDF, deck) implement the same sequence:

| Page | Title | Content |
|------|-------|---------|
| cover | | Logos, "Quarterly business review", client, quarter, prepared for |
| 1 | headline | lede, four tiles (`selectKpiTiles`), three columns (did / saw / decisions), Since last quarter |
| 2 | How we are protecting you | ring and confidence note, five-question table, "What to fix first" from remediations |
| 3 | Decisions and the next 90 days | conversations status table, Now / Next / Later with owners and "your decision" marks |
| 4 | Your IT investment | three tiles, where it went bars, plan versus actual meter, coming up |
| 4b | Planning your FY{label} IT budget | planning quarter only: outlook table with "based on", assumptions, what would move it, decisions for the plan |
| 5+ | Quarter in numbers | movers chart (unbreakable with its caption), then the metric tables |
| appendix | Attached reports | list as today, plus "How we score" |

Custom sections keep their placements. Hidden sections stay hidden. The deck
has one slide per page, with the numbers tables as appendix slides and the
same titles.

### Readability rules (hard requirements, tested where measurable)

- Body text 10pt or larger in the PDF and the print-CSS equivalent (13.3px) in
  the HTML; captions and footers 8pt or larger; nothing smaller anywhere.
- Line height 1.35 or more for body text. Page margins 0.75in or more.
- One dense block per page: a page holds either one table over six rows or
  one three-column block, not both. Overflow starts a new page.
- Headings keep with the next block. Charts, tile bands and callouts never
  split. Tables repeat their header row.
- Six pages before the appendix is the target. When content does not fit at
  these sizes, the page count grows; sizes never shrink.
- A test renders the ANP seed and asserts: minimum font sizes present in the
  pdfmake definition, no `fontSize` under 8, every chart node inside an
  `unbreakable` stack, and page one's text fits its limits.

## Workstream D: fiscal years and the budget planner

### Fiscal year

`Client.fiscalYearStartMonth?: number` (1 to 12, default 1), editable on the
client record. Helpers in `packages/core/src/period.ts`:

- `fiscalYearOf(periodId, startMonth)` returns `{ label, startPeriod, endPeriod }`
  where `label` is the calendar year in which the fiscal year ends (a July
  2026 start is FY2027; a January start is the same year).
- `planningPeriodFor(fiscalLabel, startMonth)` returns the period reviewed in
  the QBR held in the quarter before the fiscal year starts. With start month
  M and `qS = ceil(M / 3)`: the planning review quarter is `qS - 2`, wrapping
  into the prior year. January gives Q3 of the prior year, April gives Q4 of
  the prior year, July gives Q1, October gives Q2.
- `isPlanningPeriod(periodId, client)`.

### Budget plan record

```ts
export interface BudgetPlanRecord {
  clientId: string;
  fiscalLabel: number;                      // e.g. 2027
  answers: {
    headcountChange?: number; newLocations?: 0 | 1 | 2;
    projects?: Array<{ name: string; low?: number; high?: number }>;
    workstationUnitCost?: number;
    refreshPolicy?: 'run_to_failure' | 'at_warranty_end' | 'early';
    complianceDeadlines?: Array<{ what: string; when: string; estimate?: number }>;
    copilotSeats?: number; copilotSeatPrice?: number;
    appetite?: 'lean' | 'balanced' | 'cautious';
    notes?: string;
  };
  assumptions: string[];                    // sentences shown to the client
  movers: string[];                         // "what would move it" sentences
  lines: BudgetLine[]; totals: { low: number; expected: number; high: number };
  status: 'draft' | 'published'; publishedPeriod?: string; publishedAt?: string;
  context?: {                               // INTERNAL ONLY, never in the report model
    researchedAt: string; sourced: boolean;
    items: Array<{ title: string; insight: string; askClient: string; sourceName?: string; sourceUrl?: string }>;
  };
  createdAt: string; updatedAt: string; updatedBy: string;
}
export interface BudgetLine {
  category: 'managed_services' | 'licensing' | 'hardware' | 'projects' | 'support_hours' | 'compliance' | 'contingency';
  low: number; expected: number; high: number;
  basis: Array<{ source: 'halo' | 'cipp' | 'ninja' | 'hudu' | 'opportunities' | 'answer'; note: string }>;
}
export type BudgetOutlook = Pick<BudgetPlanRecord, 'fiscalLabel' | 'assumptions' | 'movers' | 'lines' | 'totals'>;
```

### Outlook computation (deterministic, `packages/core/src/budget.ts`)

| Category | Low | Expected | High | Basis |
|----------|-----|----------|------|-------|
| managed_services | MRR x 12 | MRR x 12 | plus hires x per-user rate | Halo contracts; per-user rate from the "Managed End User" line over licensed users, else the answer |
| licensing | paid seats x seat price x 12 | plus headcount change | plus Copilot seats x price | CIPP seats; seat price from Halo M365 invoice lines; Copilot price is an answer |
| hardware | devices aging out in the FY x unit cost x policy factor | | | Ninja and Hudu warranty dates; run_to_failure 0 / 0.3 / 1.0, at_warranty_end 0.85 / 1.0 / 1.15, early adds next year's cohort |
| projects | sum of project lows | midpoint | sum of highs | opportunity board estimates, else answers |
| support_hours | min quarter x 4 | average x 4 | max quarter x 4 | trailing four quarters of non-recurring invoiced |
| compliance | | answered estimates | | answers |
| contingency | 0 | 5 / 10 / 15% of expected by appetite | same on high | answer |

Every line records its basis sentences; the client page prints them in the
"Based on" column. When a data source is missing the line says so in its
basis and the total carries a caveat, never a silent zero.

Plan versus actual: `planned` is the published expected total; `spent` is the
sum of `finance.quarter_invoiced` for the fiscal year's periods so far;
`note` is deterministic ("under plan", "on plan", "over plan" with a 10%
band and the main reason when a category explains it).

### Industry context (internal)

`POST .../budget/{fy}/context` reuses the `research.ts` pattern with a
budget-specific prompt: industry, compliance standard, headcount band, and
the questions to ask the client. Items carry a source name and URL when the
model searched. The result is stored on the plan record and shown in the
planner only. It is never passed to `buildNarrativeInput`, so any benchmark
figure that reaches client prose fails the figure guardrail like any other
unsourced number. The planner card says so.

### API

```
GET    /api/clients/{id}/budget                      list plans
GET    /api/clients/{id}/budget/{fy}                 plan (404 when none)
PUT    /api/clients/{id}/budget/{fy}                 save answers, assumptions, movers
POST   /api/clients/{id}/budget/{fy}/outlook         recompute lines from data plus answers
POST   /api/clients/{id}/budget/{fy}/context         AI research, internal
POST   /api/clients/{id}/budget/{fy}/publish         status published; outlook attaches to the planning period's report
```

All writes are audited with the actor. Publishing a plan for a quarter whose
data is locked is refused with 409 (reopen first).

### Web

A Budget tab in the workspace, visible always, with a "Planning quarter"
banner when `isPlanningPeriod`. Left: what we already know (read-only, with
sources). Middle: the six-step questionnaire. Right: the context card, marked
internal. Below: the outlook table with a source tag per number and the
plan-versus-actual strip. Primary actions: Re-run outlook, Put on the report
(publish). The Investment page preview updates from the same model.

## Workstream E: conversations

### Forward to QBR

In `reportInbox.ts`, a routed message with no attachments no longer counts
as unrouted. It creates a `DiscussionItem` on the client's open quarter
(newest period with a snapshot and no final lock; else the current quarter):
`status: 'planned'`, `includeInReport: false`, `source: 'email'`,
`sourceRef: messageId`, `topic` = subject with Fw/Re prefixes stripped,
`owner` = sender display name, `response` = the first 400 characters of the
plain-text body. For HIPAA clients `response` is omitted. The message is
marked read and categorized "QBR: agenda". The poll result reports `agenda`
counts alongside `filed`.

`DiscussionItem.source?: 'manual' | 'email' | 'halo' | 'suggested' | 'report'`
and `sourceRef?: string` are added. Items with `source: 'report'` are the
decisions from page one, auto-added as planned items when lock 1 happens.

### Suggested conversations

`GET /api/clients/{id}/qbr/{period}/conversations/suggested` returns
`Array<{ topic: string; detail?: string; source: 'halo_ticket' | 'halo_opportunity' | 'halo_note'; ref: string; when: string }>`
from Halo for the period: tickets whose type is a request, project or question
(never alerts) raised by the primary contact or carrying a VIP flag;
opportunities; CRM notes. The opportunity and CRM note endpoints are
UNVERIFIED against the Halo API documentation; the implementer verifies them
and the collector degrades to tickets only when they are absent. The Meeting
tab shows the list with one-click Add (`source: 'suggested'`). For HIPAA
clients the list is shown in the app but added items default to
`includeInReport: false` and the report prints only the topic the author
typed.

## Testing

- Core: fiscal helpers for the four start months; outlook formulas with and
  without each data source; protection grouping and status; since-last-quarter
  state mapping.
- Integrations: free SKU exclusion and the thousand-unit net with the ANP
  Power Apps shape; warnings text.
- Narrative: v4 shape and limits; legacy derivation; style lint hits; offline
  drafter stays within limits on every seed client; guardrail still fails a
  benchmark figure that is not in the allowed set.
- Report: page order in HTML, PDF and deck; readability assertions; unbreakable
  charts; filenames; planning page present only in the planning period; the
  cover footer appears once.
- API: lock 1 on package sent stores v1 and later GETs serve it without
  calling the model (spy on the narrative model); 409s on every locked write;
  lock 2 on disposition and on finalize; reopen clears the right locks and the
  next lock stores v2 with `revisedAt`; editing client goals after a lock does
  not change the served model; inbox turns a no-attachment message into a
  planned item and omits the body for HIPAA; suggested conversations degrade
  to tickets.
- Web: landing picks the open quarter and rewrites the URL; locked banners
  disable the right controls; Finalize appears after completed; counters in
  the narrative editor; Budget tab publish flow.
- Visual: the ANP Q2 PDF rendered and checked page by page against the
  approved mockups at 100% zoom.

## Rollout

Integration branch `claude/report-v2-and-planning` from 2ed1a4d. Workstream
A merges first and can deploy alone. B and C are independent of each other
and both depend on A. D depends on C's investment model. E depends on B's
open-quarter rule and feeds C's since-last-quarter data, so it lands last.
Each workstream is one implementer in its own worktree, reviewed per
workstream, with a whole-branch review before the PR.

Deploying B changes nothing for existing quarters until a lock happens; the
ANP Q2 2026 quarter is finalized by hand with the Finalize button after
deploy so it stops rebuilding. The v4 narrative fingerprint regenerates prose
for open quarters only.

## Open items to verify during implementation

- The Microsoft free and developer SKU part numbers, against the licensing
  reference, before the denylist ships.
- Halo API endpoints for opportunities and CRM notes, and the ticket lookup by
  id for pushed-action status.
- pdfmake behaviour for `headlineLevel` together with `unbreakable` stacks on
  Letter at these margins.
- Whether Flex Consumption's instance memory (2048 MB) comfortably renders
  three artifacts in one request at lock time; if not, lock 1 renders the PDF
  synchronously and queues the deck and HTML.
