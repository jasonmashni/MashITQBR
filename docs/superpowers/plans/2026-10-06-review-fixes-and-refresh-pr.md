## Summary

Fixes every verified defect from the 2026-10-05 code review and refreshes the admin app and the three client deliverables. Spec: `docs/superpowers/specs/2026-10-06-review-fixes-and-refresh-design.md`. Plan: `docs/superpowers/plans/2026-10-06-review-fixes-and-refresh.md`.

## What an account manager will notice

- **Status words are human.** Not started, Data pulled, Narrative approved, Meeting booked, Review complete, Decisions captured, Actions pushed, Archived. No enum strings anywhere on screen.
- **The dashboard leads with this quarter.** A triage band groups clients by what they need (meeting passed, package not sent, needs scheduling, not started, meeting this week, in progress, done) and the table sorts by that urgency. A client reviewed in Q1 and never since now shows as not started for Q4.
- **The workspace header has one primary button: the next step.** Deliverables sit behind a Deliver menu that stays locked until the narrative is approved and its figures verify. "Send package" is an explicit action that stamps the quarter; downloading the email draft no longer does.
- **Approve only moves forward.** Changing status by hand is an Override modal that needs a reason for backwards moves and writes to the audit log. Regenerate and Close the quarter confirm first.
- **The maturity score is honest.** Below 40% control coverage the score is withheld and every surface says "Not scored" with the coverage figure; 40 to 70% is marked provisional. The ANP seed now reads Not scored (38%).
- **Sync caveats survive.** Warnings such as "counted from the first 200 of 1,400 tickets" are stored with the data, shown on the Data tab, and printed on the report as Data confidence.
- **Re-sync keeps manual and PDF-extracted metrics.** A sync where every tool failed refuses to overwrite the previous data and says why.
- **Failed loads never become empty saves** (settings, report config, agenda, goals).
- **Reports, PDF and deck open with the headline, the narrative, at-a-glance tiles with their movement, and a confidence note;** unmeasured functions read "Not measured"; the "vs last" column exists only when there is a prior quarter; sentence case throughout.

## Trust and security

- The narrative guardrail scans every prose field, not just the model's own figure list. Ticket subjects quoted inside curly quotes are exempt so ordinary subjects like "Windows 11" do not fail verification.
- HIPAA clients: ticket subjects are withheld from the AI by default (`NARRATIVE_ALLOW_PHI=1` to allow) and never quoted in the client-facing report. Confirm the Anthropic BAA before enabling PHI.
- Every API route requires an Easy Auth principal when running in Azure; the app fails closed if `WEBSITE_AUTH_ENABLED` is not `true`/`1`, and thin or forged principal envelopes are rejected. `QBR_AUTH_REQUIRED=1` turns the gate on locally.
- The report inbox trusts only the mailbox's own domain or `REPORTS_ALLOWED_SENDERS`; mail from Junk is never filed; failures are recorded per message.
- Brand colors are validated before they reach any stylesheet; malformed or empty write bodies are rejected.
- Vendor collectors never emit a plausible number for a failed or partial pull (Halo ticket tallies, Check Point, CIPP conditional access, Ninja patch rate on truncated pulls, Hudu expirations); HTTP has a 30 s timeout and 429/5xx retries on reads.

## Infrastructure and CI

- `infra/main.bicep` now provisions what the app runs on: a Linux Consumption Function App on Node 22, Table/Blob via `AzureWebJobsStorage`, Key Vault with the Secrets Officer role scoped to the vault, `authsettingsV2` with the booking paths excluded, diagnostic settings. SQL, the Static Web App, the VNet and private endpoints are gone. The Deploy workflow needs an `AAD_CLIENT_ID` repository variable. The Key Vault name gained a unique suffix; migrate secrets if an environment already exists.
- CI runs on every branch push, typechecks the web app, builds the deploy package, and uses Node 22 end to end. vitest timeout raised to 20 s.

## New settings

`QBR_AUTH_REQUIRED`, `REPORTS_ALLOWED_SENDERS`, `NARRATIVE_ALLOW_PHI` (documented in the README).

## Verification

- `npm run typecheck`: clean. `npx tsc -p apps/web/tsconfig.json --noEmit`: clean.
- `npm test`: 532 passed (65 files).
- `npm run deploy:build`: package assembles.
- Visual check (Playwright, 1440 and 390 px): Dashboard, Workspace Overview and Data, HTML report.

## After the whole-branch review

- Only client-readable count caveats print as "Data confidence"; setup and connection notes stay on the Data tab.
- The curly-quote exemption in the figure guardrail now applies only to real ticket subjects from the input.
- A client switch clears loaded report settings before the new ones arrive; narrative direction fields follow the loaded settings until you type; Approve waits for saved, verified text.
- HIPAA clients' recurring-theme insights never name the shared word.
- The Deploy workflow provisions infrastructure only when `provision_infra` is ticked and refuses to run if `FUNCTION_APP_NAME` differs from the template's app name; Bicep accepts the Easy Auth client secret setting and login scopes.
- Inbox polls report untrusted and failed messages in the Settings toast, the poll detail and the audit log.

Note: this branch was cut from `claude/qbr-disposition-skipped-meeting-rwmsr3`, so it also carries that branch's one commit (89746d1, skipped-meeting disposition).

## Known follow-ups (not in this PR)

- Seed data still carries real client and contact names; it doubles as stored history for three live clients, so moving it out of source control is a separate decision.
- Optimistic concurrency (ETags) on the Table store.
- Inbox poll detail does not yet surface the `untrusted` and `failed` counts in the Settings card.
- Verify `WEBSITE_AUTH_ENABLED` on the first deploy: a signed-in `GET /api/me` must return 200.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
