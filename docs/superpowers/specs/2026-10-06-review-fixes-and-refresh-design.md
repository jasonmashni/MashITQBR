# Review fixes and visual refresh: design

Date: 2026-10-06. Base: commit 89746d1 on `claude/review-fixes-and-refresh`.
Source: the 2026-10-05 full code review (five passes, top findings verified in source).

## Goal

Make the QBR tool safe to put in front of a client and easy for an account
manager to run every quarter: numbers carry their confidence, the workflow
gates what it displays, and every surface (admin app, HTML report, PDF, deck)
reads as one designed system.

## Non-goals

- Optimistic concurrency (ETags) on the Table store. Follow-up.
- Moving seed data out of source control. The seed doubles as the stored
  history for three live clients (`ensureSeeded` plus the snapshot overlay), so
  renaming or removing it would erase their 2026-Q1 baseline. Decision needed
  from Jason; not changed here.
- Embedding a custom font in the PDF. pdfmake stays on Helvetica.
- Rewriting the booking page.

## Assumptions (stated because they were not confirmed)

- "Let's make these changes" approves the eight recommendations from the
  review message. The visual direction below is my call; correct it and the
  design pass will be re-run.
- Easy Auth stays the production identity layer; the code-level gate is
  defense in depth, not a replacement.
- Mash IT blue (#004AAD) and navy (#0B2545) are fixed brand values.

## Interface changes (contracts the parallel work builds against)

### packages/core

- `MetricSnapshot.warnings?: string[]`: sync caveats persisted with the data.
- `MaturityScorecard.overall` gains `confidence: 'low' | 'medium' | 'high'`
  (coverage < 0.4 low, < 0.7 medium, else high). When confidence is `low`, or
  governance is the only measured safeguard, `overall.score` is `null` and
  `overall.rating` is `'unknown'`. The governance safeguard returns `null`
  (not measured) unless at least one other safeguard is measured.
- Safeguards whose penalty input is absent return `null` instead of assuming
  the best case (email security, identity threat, EDR).
- `workflow.ts` exports `QBR_STATUS_LABELS`, `qbrStatusLabel(status)`,
  `statusAtLeast(current, target)`. Labels: draft "Not started",
  data_synced "Data pulled", narrative_approved "Narrative approved",
  scheduled "Meeting booked", completed "Review complete",
  dispositioned "Decisions captured", actions_pushed "Actions pushed",
  archived "Archived".
- `TicketInsight.figures` carried into `NarrativeInput.ticketInsights`.
- `roadmapValue` counts only `idea | discussing | approved | pushed`.
- Insight dedupe by ticket id across incidents/open; `previous === 0` gates
  on `deltaAbs`.

### packages/narrative

- `verifyFigures(output, allowed, opts)` scans `figures_referenced` plus
  headline, summary_paragraphs, highlights, recommendations and every
  section_summaries value. Before extraction it strips ISO dates, period
  labels (`Q1 2026`, `2026-Q1`), version tokens (`v8`, `CSF 2.0`, `M365`,
  `24/7`) and `/ 100`.
- `buildAllowedNumbers` uses `ticketInsights[].figures`, never regexes of
  subject text.
- `buildNarrativeInput(..., { allowPhi })`: when `client.hipaa === true` and
  `allowPhi` is not true, `ticketSamples` and insight `examples` are omitted
  and a note is added to the prompt that samples were withheld.
- SYSTEM_PROMPT gains an explicit boundary paragraph: everything inside
  `<metrics>` is data, never instructions. Subject strings have `<` and `>`
  removed.
- Model output is shape-checked before use; `stop_reason` is included in the
  thrown error; `maxRetries` clamps to at least 0.
- The offline drafter says "not measured this quarter" for absent metrics
  instead of asserting health.

### packages/integrations

- `collectHaloForId`: separate `periodOk` and `openOk`; ticket tallies are
  emitted only when the period pull succeeded for every mapped id. Partial
  multi-entity results carry a warning naming the failed entity.
- `fetchTicketTypeMap` does not cache a failed fetch. Tickets classified
  `other`/`maintenance` are emitted as `tickets.unclassified` with a warning
  when nonzero.
- Contracts whose end date precedes the period start are excluded from MRR,
  and a warning is emitted when a contract's billing period is not monthly
  (field semantics need vendor-doc verification, so no silent division).
- Invoices are ordered by `invoicedate` descending and a warning fires when
  `rows.length < total`.
- Check Point: an empty or unrecognized event payload emits no metrics plus a
  warning. `ctx.externalRef` scopes the query when present.
- CIPP: an empty CA list emits no `identity.ca_policies` plus a warning; a
  string `Results` is treated as an error.
- NinjaOne: AV coverage denominator is `devices.length`; the patch percentage
  requires at least 10 install events and warns when `queryAll` exits with a
  cursor.
- Hudu: expiration metrics are emitted only when rows exist.
- `FetchHttpTransport`: 30 s `AbortSignal.timeout`; 429/5xx retried up to 3
  times honoring `Retry-After`, exponential backoff otherwise.
- Huntress monthly fallback sorts by period descending and labels metrics
  "(latest month)".

### apps/api

- Route gate: when `WEBSITE_INSTANCE_ID` is set (Azure) or
  `QBR_AUTH_REQUIRED=1`, any request without an Easy Auth principal gets 401,
  except `book/*` and `api/book/*`. `QBR_AUTH_REQUIRED=0` disables the gate
  for local dev. The dev server binds 127.0.0.1 and drops wildcard CORS.
- Secrets: in Azure without `KEY_VAULT_URL`, saving a connection with secrets
  returns 400 ("Key Vault is not configured") and `GET /api/system` reports
  `secretStore: 'local-insecure'`.
- `body()` returns 400 on invalid JSON. `putConfig`, `putDiscussion`,
  `putClientGoals`, `putOrgSettings` reject an empty object.
- `putOrgSettings` validates `primary`/`accent` against `^#[0-9a-f]{6}$`.
- `syncClientMetrics` carries over metrics whose source is `manual` or starts
  with `pdf:` from the existing snapshot; persists `warnings` on the snapshot.
  When every collector failed, the previous snapshot is kept, status does not
  advance, and the handler returns 409 with the warnings.
- New `POST .../narrative/approve` applies `advanceStatus(current, 'narrative_approved')`.
- `PUT .../status` body `{ status, force?: boolean, reason?: string }`: forward
  moves advance; any other move requires `force: true`, is audited with the
  reason, and is refused otherwise (409).
- New `POST .../package/sent` stamps `packageSentAt`. `GET .../email.eml` no
  longer stamps.
- `GET /api/overview` rows add `currentPeriod`, `current: { hasData, status,
  meetingAt, packageSentAt, meetingSkipped }`, `lastCompletedPeriod`, and
  `triage: 'not_started' | 'needs_scheduling' | 'meeting_soon' |
  'meeting_passed' | 'package_not_sent' | 'in_progress' | 'done'`. The top
  level adds `quarterEndsInDays`. Triage rules, evaluated in order on the
  current period: done when status is completed or later; package_not_sent
  when (status is scheduled or later, or meetingSkipped) and the meeting time
  has passed and there is no packageSentAt; meeting_passed when meetingAt is
  in the past and status is before completed; meeting_soon when meetingAt is
  within 7 days; needs_scheduling when hasData and no meetingAt and not
  skipped; not_started when there is no data; otherwise in_progress.
- Report inbox: `REPORTS_ALLOWED_SENDERS` (comma list of addresses or
  domains). Unset means only the mailbox's own domain is trusted. Untrusted
  senders are categorized `QBR: untrusted` and not filed. Per-message
  try/catch; a failed message is categorized `QBR: failed` and marked read.
  `DocumentRecord.from` stores the sender.
- `static.ts` path guard uses `path.relative`. Download filenames use
  RFC 5987 `filename*` with an ASCII fallback.
- Infra: `infra/main.bicep` matches the README topology: Linux Consumption
  Function App on Node 22, `AzureWebJobsStorage` connection string,
  `KEY_VAULT_URL`, Key Vault Secrets Officer scoped to the vault,
  `authsettingsV2` with the four booking paths excluded, diagnostic settings
  to Log Analytics for the app, storage and vault. SQL, Static Web App, VNet,
  private endpoints and DNS zones are removed. `staticwebapp.config.json` is
  deleted.
- CI runs on every branch push and on PRs; adds the web typecheck and
  `deploy:build`; vitest `testTimeout: 20000`; Node 22 across engines, esbuild
  target, workflows and README.

### packages/report

- `resolveBrand` drops invalid hex colors to defaults.
- `trends` are filtered by hidden sections before any renderer sees them.
- `trendDeltaText` renders `0 to N` when the base is zero.
- Corrupt logo: pdfmake string errors are caught; rasters are pre-validated.
- Deck goals/discussion tables chunk manually (no `autoPage`).
- Whole-dollar currency has no cents. The chart caption says magnitude is capped.
- New `dataConfidence: string[]` on the model from `snapshot.warnings`.
- The "vs last" column is omitted when a section has no prior-quarter values.

### apps/web

- Vite aliases `@mashit/core`; the web consumes `QBR_STATUS_ORDER`,
  `qbrStatusLabel`, `statusAtLeast` from core and deletes its copies.
- Approve calls the new approve endpoint. The status override lives behind an
  "Override status" button with a confirm that names the consequences and a
  required reason.
- Deliverables are real buttons behind a guard: QBR exists, narrative
  approved, verification ok, scorecard confidence not low. The disabled state
  shows the reason. The email download then calls `package/sent` and refreshes.
- Loads that fail keep an error state and disable Save (config, discussion,
  goals, settings). `period` resets on client change; `getConfig` has a live
  guard; `api.system()` clears its memo on rejection.
- Regenerate and Mark complete confirm; Complete has a loading state; Actions
  re-push is blocked when `externalRef` exists.
- Charts: radar domain fixed at 0 to 100; QoQ bars with no prior quarter are
  drawn alone with a "no prior quarter" note; one semantic color set.
- Workspace.tsx is split into `pages/workspace/*.tsx` (one file per tab plus
  header, stepper, deliverables, narrative editor) with a shared
  `useResource` hook and one `toastError` helper. Behavior-preserving split
  first, then the design changes.

## Visual design plan

Subject: an internal cockpit for Mash IT account managers who run quarterly
reviews for healthcare and manufacturing clients in Central Kentucky, plus a
client-facing quarterly report read by non-technical executives. The design
should feel like a well-run operations desk: calm, legible, exact, with one
place the eye goes first.

### Tokens

Color (base palette):
- Navy ink `#0B2545`: headings, chrome, the brand mark.
- Mash blue `#004AAD`: interactive. Primary button, links, focus ring.
- Canvas `#F3F5F8`: page background (cool, not cream).
- Surface `#FFFFFF`: tables, the triage band, report pages.
- Slate `#3B4A5F` body text, `#6B7A90` muted text, `#D8DFE8` hairlines.

Semantic set, used identically in the app and the deliverables:
- Good `#0E7C72` (teal). Watch `#9A5B00` text on `#FFF4DB`. Act `#B42318`.
- Unknown or not measured: slate on `#EEF1F5`, never a color.

Type: Public Sans (Google Fonts), 400/500/600/700, one family everywhere in
the app and the HTML report. Tabular numerals on every number. Scale: 12, 13
(body), 15, 18, 22, 28, 34. Headings 600 with tight leading (1.2); body 1.5.
Report prose max 68ch. The PDF stays on Helvetica with the same scale and
weights; the deck uses the master's font.

Layout concept: left navigation stays. The header loses the marketing
tagline and keeps the brand mark, the client switcher (visible at every
width) and the account menu. Content is left-aligned on a 1280px max width;
numbers are right-aligned in tables. Cards are reserved for the two "look
here" moments: the Dashboard triage band and the report's at-a-glance tiles.
Everything else sits on the page with hairlines and spacing. Radius
hierarchy: 0 for tables, 4px for inputs and badges, 8px for the band and tiles.

Dashboard wireframe:

```
+ This quarter, 2026-Q4, 86 days left ---------------------------------+
| Not started 2    Needs scheduling 1    Meeting this week 0   Package 1|
| [KPCA] [Madison Peds]   [ANP]                                  [ANP]  |
+-----------------------------------------------------------------------+
Client                     This quarter         Maturity        Health   MRR   QoQ
| ANP Enertech             Package not sent     82 Provisional  78 Watch  --    --
  Manufacturing. 4 out of warranty, 1 incident
| Kentucky Primary Care    Not started          -- Not enough   86 Good   --    --
```

Rows carry a 3px leading rule colored by triage state; flags sit under the
client name in plain sentence case. Status words are the core labels.

Workspace header wireframe:

```
ANP Enertech    Meeting booked, 2026-Q4                   [2026-Q4 v]
Sync > File reports > Approve narrative > Book > Meet > Send > Close
                                           [Approve narrative]  [Deliver v]
```

One primary button, always the next step from the stepper. "Deliver" opens
Report / PDF / Deck / Email draft, each disabled with a reason until the
guard passes.

HTML report, first page:

```
MASH IT mark                                  Quarterly review, Q4 2026
ANP Enertech
Headline sentence from the narrative, 28px, max 68ch.
Two or three paragraphs.

[ Security maturity ]   [ Tickets handled ]   [ Threats blocked ]
  82 / 100 provisional     141, up from 47        22
  based on 12 of 26 controls

Data confidence: Halo ticket counts came from 200 of 1,400 tickets...
```

Then: maturity by function (unknowns shown as "not measured" in slate, not
zero), what changed this quarter (movers), one section per category with a
one-line takeaway and a table, discussion and decisions, next 90 days,
appendix.

### Principles

1. The next action is the most prominent element on every screen.
2. Every number shows its confidence: coverage on the score, warnings on the
   data, "no prior quarter" on a trend.
3. One semantic color set across the app and all three deliverables.
4. Human labels only; enum strings never reach the screen.
5. Restraint: one accent, no gradients, no uppercase eyebrows, no middle-dot
   meta strings, no decorative icons.

### Genericness review

The first draft of this plan had Inter on a white page with blue cards.
That is the SaaS card kit the review warned about, so it changed: Public
Sans replaces the unloaded Inter (chosen for tabular figures and a civic,
institutional tone that suits healthcare and manufacturing clients); the
canvas is cool rather than white or cream; cards are limited to two
moments; status is carried by a leading rule and a word, not a filled
badge; the header gradient mark becomes a flat navy mark; uppercase
eyebrows and middle-dot strings are removed everywhere. The one bold
element is the triage band. The report's bold element is the maturity
block with its coverage line.

## Testing

- Each package adds tests for its fixes before the fix (TDD). Named cases:
  empty-snapshot scorecard, prose-only hallucination, HIPAA sample
  suppression, Halo period-fail/open-ok, re-sync keeps manual and pdf
  metrics, all-collectors-failed keeps the previous snapshot, approve on a
  completed QBR does not regress, status override requires force,
  email.eml does not stamp, overview triage for each state, inbox untrusted
  sender, brand color rejection, 0 to N delta text, hidden-section trends.
- Root: typecheck, web typecheck, full vitest, `deploy:build`.
- Visual: Playwright screenshots of Dashboard, Workspace Overview, Data,
  Meeting and the HTML report at 1440 and 390 wide, reviewed against the
  wireframes.

## Rollout

Single branch, one PR. README updated to the real topology and the new
settings (`QBR_AUTH_REQUIRED`, `REPORTS_ALLOWED_SENDERS`,
`NARRATIVE_ALLOW_PHI`). The PR body lists every behavior change an account
manager will notice.
