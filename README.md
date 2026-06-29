# Mash IT QBR Tool

Aggregate the MSP stack's data and generate impactful, AI-drafted Quarterly
Business Reviews — branded PDF, interactive web report, and a meeting deck —
from one data model. Built to run in Mash IT's Azure tenant.

## Why

QBR prep today means hand-collecting numbers from Halo, NinjaOne, Huntress,
Check Point, CIPP, and backups, then writing a report that shows *value and
drives decisions* rather than dumping data. This tool automates the collection,
grounds an AI narrative in real numbers, and produces a client-ready deliverable
— with a client-readable, framework-mapped security/risk maturity score as the
centerpiece (the gap across CloudRadial / ScalePad / Strategy Overview).

## Monorepo layout

| Package | Responsibility |
|---|---|
| `packages/core` | Domain model, quarter periods, QoQ trend engine, blended **CIS v8 / NIST CSF 2.0** maturity scorecard, seed data from real QBRs |
| `packages/integrations` | Read-only collectors: MCP (Halo/Ninja/Hudu via MASH MCP) + HTTP (Huntress/Check Point), snapshot assembly |
| `packages/narrative` | Claude-backed executive narrative with a **figure-verification guardrail** + deterministic offline drafter |
| `packages/report` | One view-model → branded HTML, Playwright PDF, pptxgenjs deck |
| `apps/api` | Azure Functions (v4) HTTP API + orchestration service (`buildQbrReport`) |
| `apps/web` | React (Vite) admin shell, gated by Static Web Apps Entra ID auth |
| `infra` | Bicep: SWA + Flex-Consumption Functions + Key Vault + Azure SQL + Blob, VNet-isolated |

## Develop

```bash
npm install
npm run typecheck   # tsc across the workspace
npm test            # vitest (66 tests)
```

Run the API + web locally (requires Azure Functions Core Tools v4):

```bash
# terminal 1 — API
cd apps/api && cp local.settings.json.example local.settings.json && func start
# terminal 2 — web (proxies /api to :7071)
cd apps/web && npm install && npm run dev
```

The pipeline runs end-to-end with **no credentials** using transcribed seed data
and the offline narrative drafter. Set `ANTHROPIC_API_KEY` and request `?ai=1`
to use Claude (`claude-opus-4-8`) for the narrative; install `playwright` +
`pptxgenjs` to enable PDF/deck export.

## Customize & capture

The web app has three tabs:
- **Report** — the AI summary, maturity score, and the live report/PDF/deck.
- **Branding & Sections** — upload a logo, set brand colors, show/hide standard
  sections, and add free-text custom sections — saved per client.
- **Discussion & Responses** — capture talking points, client responses, a
  disposition (→ ticket/opportunity), and an owner *during* the review, plus
  general notes. These render into the report (and PDF/deck).

Persistence is a local JSON store in dev (`.data/store.json`, override with
`QBR_DATA_DIR`); in Azure this moves to SQL (config/discussion) + Blob (logos).
API: `GET/PUT /api/clients/:id/config` and
`GET/PUT /api/clients/:id/qbr/:period/discussion`.

## Grounding & safety

- The AI never does arithmetic — all totals, percentages, and QoQ deltas are
  pre-computed in `packages/core` and passed to the model.
- Every cited figure must trace back to a computed value; the guardrail
  regenerates the narrative on any mismatch and never auto-publishes.
- Secrets live in Key Vault (referenced, never stored in the DB); SQL is
  Entra-only; data services are private-endpoint only. See `infra/main.bicep`.

## Status

v1 (Aggregate + one-click AI-drafted QBR for Halo + Ninja + Huntress + Check
Point) — see the build plan for the phased roadmap (CIPP/Domotz/Dropsuite,
scheduled snapshot sync, Teams scheduling + disposition → Zomentum/Halo push,
and the client-facing portal).
