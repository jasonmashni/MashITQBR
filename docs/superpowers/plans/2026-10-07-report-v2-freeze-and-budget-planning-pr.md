## Summary

The QBR deliverable is rebuilt for executives. Finished quarters are frozen and served from storage, clients get fiscal-year budget planning, and client conversations can be captured without reading anyone's mailbox.

- **Report v2.** The report opens with a two-page brief:
  - Page one: a headline, a short paragraph, four tiles, and what we did, what we saw and what we need from you, followed by "Since last quarter".
  - Page two: "How we are protecting you", answered as five business questions.
  - Page three: decisions and the next 90 days, as Now / Next / Later with owners.
  - Page four: the IT investment page.
  - The metric tables move to the back.
  - Hard limits apply. Narrative word counts are verified, never silently trimmed. Body text is at least 10pt and nothing is under 8pt. Headings stay with their block and charts never split.
  - The PDF, HTML and deck share one page sequence.
- **Attached reports feed the narrative.** Findings from vendor PDFs (for example a stale Synology backup) reach the prose, and their figures pass the figure guardrail.
- **Frozen quarters.**
  - Lock 1 stores the pre-read package when it is sent.
  - Lock 2 stores the final package when decisions are captured, or when Finalize is pressed. It reuses the pre-read's narrative, documents and report inputs, so the final package matches what the client already has.
  - Reopen is audited and versioned.
  - On a locked quarter, writes answer 409, and reads serve the stored version with no rebuild and no AI call.
- **Budget planning.**
  - Each client has a fiscal year start month.
  - The QBR held before the fiscal year turns carries a twelve-month outlook (low, expected, high). Every number shows its source.
  - Other quarters show plan versus actual against a published snapshot.
  - Industry context is AI-researched and shown to Mash IT staff only. It never reaches a narrative input or a client file.
- **Conversations.**
  - Forwarding an email with no attachment to a client's plus-address creates a draft agenda item. HIPAA clients never have the body stored.
  - The Meeting tab suggests conversations from Halo requests, opportunities and CRM notes, with one-click Add.
- **Quick fixes.**
  - License counts include paid seats only, so free and developer SKUs no longer inflate them.
  - Downloads are named "Mash IT QBR - Client - Quarter".
  - The HIPAA confidentiality notice appears on every page.
  - The README and Bicep now describe the Flex Consumption app that actually runs.

The spec and plan are in `docs/superpowers/specs/2026-10-07-report-v2-freeze-and-budget-planning-design.md` and `docs/superpowers/plans/2026-10-07-report-v2-freeze-and-budget-planning.md`.

## Verification

- `npm run typecheck`: clean. `npx tsc -p apps/web/tsconfig.json --noEmit`: clean.
- `npx vitest run`: 778 passed (89 files), up from 543.
- `npm run deploy:build`: package assembles.
- The ANP Q2 2026 PDF was rendered and checked page by page against the approved mockups.
- Review:
  - Every workstream had a task review and scoped re-reviews of its fixes.
  - A whole-branch review was run on the most capable model, followed by one fix wave and one follow-up. The follow-up closed the last open item.

## Before and after deploy

- **Before deploy:** finalize ANP Q2 2026 by hand after deploy, so it stops rebuilding.
- **Before deploy:** quarters that were completed before this change now count as open until they are finalized. The dashboard's "Needs finalizing" band lists them.
- **After deploy:**
  - Confirm a signed-in `GET /api/me` still returns 200.
  - Send one test package on a non-client quarter to exercise lock 1.
- **Unverified Halo endpoints:** `Opportunities`, `CRMNote` and `Tickets/{id}` are unverified against the Halo API docs. Each one degrades safely: suggestions fall back to tickets only, and ticket status falls back to the stored status. Check them against the Mash IT tenant.
- **Microsoft licensing:** the free-SKU part numbers should be confirmed against Microsoft's licensing reference. Any SKU that is excluded is named in a sync warning.
- **Narrative AI:** `NARRATIVE_ALLOW_PHI` stays unset until the Anthropic BAA is confirmed.

## Known follow-ups (not blocking)

- New locations are recorded in the budget planner but not priced. The plan-versus-actual "main reason" clause is not built.
- CI builds on Node 22 while the app runs on Node 24.
- If the budget fails to load at lock 1, the warning about it is not carried into the final package.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
