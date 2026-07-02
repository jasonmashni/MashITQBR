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
| `apps/api` | Azure Functions (v4) HTTP API + orchestration, data/secret stores (Table Storage / Key Vault), live sync + workflow pipeline |
| `apps/web` | React (Vite) + **Mantine v7** admin app (Dashboard, Clients, Integrations, QBR workspace), gated by Entra ID auth |
| `infra` | Bicep: SWA + Flex-Consumption Functions + Key Vault + Azure SQL + Blob, VNet-isolated |

## Develop

```bash
npm install
npm run typecheck   # tsc across the workspace
npm test            # vitest (88 tests)
```

Run the API + web locally (no Azure tooling required):

```bash
# terminal 1 — API (node http server, mirrors the Functions routes + serves the SPA)
npm run build:api && npm run dev:api        # http://localhost:7071
# terminal 2 — web (proxies /api to :7071)
cd apps/web && npm install && npm run dev    # http://localhost:5173
```

The pipeline runs end-to-end with **no credentials** using transcribed seed data,
the offline narrative drafter, and a local JSON store + secret file. Set
`ANTHROPIC_API_KEY` to use Claude (`claude-opus-4-8`) for the narrative; install
`playwright` + `pptxgenjs` to enable PDF/deck export. (`func start` from
`apps/api` still works for production parity if you have Core Tools v4.)

## Using the app

The Mantine UI has four areas:
- **Dashboard** — client count, integrations, current quarter, and a
  security-maturity bar across clients.
- **Clients** — table of clients with **Import from Halo** (via the MASH MCP);
  edit each client's tool mappings (per-tool external ids the sync reads).
- **Integrations** — add/edit/rotate/test connections (MASH MCP, Huntress,
  Check Point, Zomentum). Secret fields (tokens, API keys) are written to **Key
  Vault**; only references are stored — API responses expose `secretFields`, never
  values.
- **QBR workspace** (`/clients/:id`) — pick a quarter, **Sync** live metrics, and
  work four tabs:
  - *Report* — executive summary, maturity ring + radar, QoQ chart, and the live
    HTML report / PDF / deck.
  - *Branding & Sections* — logo, brand colors, section show/hide, custom sections.
  - *Discussion & Responses* — capture talking points, responses, dispositions,
    and owners live during the review.
  - *Schedule & Actions* — set the meeting date/time + Teams link + status, and
    push dispositioned items to **Halo tickets/opportunities** or **Zomentum
    opportunities** (status chips reflect the created external id).

Persistence is a local JSON store + secret file in dev (`.data/`, gitignored;
override the dir with `QBR_DATA_DIR`); in Azure it uses **Azure Table Storage**
(app data, references only) + **Key Vault** (secrets). The store/secret backends
switch automatically when `AzureWebJobsStorage` / `KEY_VAULT_URL` are set.

## Deploy to Azure (one Function App)

Deployed as a **single Linux Node-20 Azure Function App** that serves both the
API and the React UI at one URL (mirrors the Mash IT MCP gateway). Build the
self-contained package and deploy the folder:

```bash
npm install
npm run deploy:build          # builds web + API, assembles apps/api/deploy/
# VS Code: Open Folder -> apps/api/deploy -> Azure -> Deploy to Function App
```

Portal one-time: create the Function App (Node 20 / Linux / Consumption),
enable system-assigned **managed identity**, put `ANTHROPIC_API_KEY` in **Key
Vault**, and add the app setting `ANTHROPIC_API_KEY=@Microsoft.KeyVault(SecretUri=…)`.
For the portal-managed integrations, grant the identity **Key Vault Secrets
Officer** (write, so the app can store connection secrets) and add the app
setting `KEY_VAULT_URL=https://<vault>.vault.azure.net/`. App data uses the
Function App's existing `AzureWebJobsStorage` (Table Storage) — no new resource.
Optionally turn on **Entra Easy Auth** to lock the app to Mash IT logins. Full
click-by-click steps are in the plan file (Addenda 2–3). PDF export is deferred
on Consumption (print the HTML report from the browser); the report + PPTX deck work.

> Locally, once the web is built, `npm run dev:api` also serves the SPA at
> http://localhost:7071 — the same single-app behavior as production.

## Grounding & safety

- The AI never does arithmetic — all totals, percentages, and QoQ deltas are
  pre-computed in `packages/core` and passed to the model.
- Every cited figure must trace back to a computed value; the guardrail
  regenerates the narrative on any mismatch and never auto-publishes.
- Secrets live in Key Vault (referenced, never stored in the DB); SQL is
  Entra-only; data services are private-endpoint only. See `infra/main.bicep`.

## Status

Phase 2 — modern Mantine UI, portal-managed integrations (secrets → Key Vault),
live client import + metric sync via the MASH MCP, Azure Table Storage app data,
and the QBR workflow (schedule → disposition → push to Zomentum/Halo). Next:
Microsoft Graph auto-scheduling (Teams meeting + attendance), CIPP/Domotz/Dropsuite
collectors, scheduled snapshot sync, and the client-facing portal — see the build
plan for the phased roadmap.
