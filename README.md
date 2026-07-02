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

The header shows **who's signed in** (Easy Auth / Entra) with sign-out; every
mutation is written to the **Audit log** page (who / what / when) for compliance.

- **Dashboard** — one-call rollup of your **QBR-enabled** clients: maturity bar,
  per-client score + workflow status, current quarter.
- **Clients** — all clients with a **QBR toggle** (you don't review everyone —
  imports from Halo arrive with QBR off; enable just the ones you do).
- **Integrations** — add/edit/rotate/test connections. The **MASH MCP** connects
  with a Client ID + Secret from your MCP server's setup page (OAuth token
  exchange is automatic; a Token URL override exists for nonstandard setups).
  Each connection has **Map clients**: it lists the orgs found inside the tool
  (Halo clients, NinjaOne organizations, Huntress organizations) so you pick
  who's who from a dropdown. Add the zero-credential **NinjaOne (via MASH MCP)**
  connection to get the Ninja mapping dropdown. Secrets go to **Key Vault**;
  only references are stored.

  > **How the MCP data flows:** the MASH MCP tools return formatted text
  > (built for LLM chat), and the QBR tool parses it — client/org lists,
  > device rows, and the JSON-per-line query batches. If the MCP server ever
  > adds `structuredContent` (or JSON text) to its tool results, the QBR tool
  > prefers it automatically — a worthwhile 3-line change per tool in the MCP
  > server repo. Two current data limits surface as sync warnings: Halo
  > quarterly ticket volumes need the Halo API key's **reports scope**
  > (403 today) or a date-filtered MCP ticket tool, and NinjaOne warranty
  > fields aren't exposed by the text output (track as manual metrics).
  > Huntress pulls its rich **quarterly summary report** per organization
  > (incidents, signals, canaries, recon, firewall, ITDR, SIEM) plus live MFA
  > coverage from identities.
- **QBR workspace** (`/clients/:id`) — quarter picker (marks quarters with data),
  **Sync**, and five tabs:
  - *Report* — executive summary with an **Edit narrative** editor (save wording
    changes instantly with no AI call; **Regenerate** re-drafts; **Approve**
    advances the workflow), maturity ring + radar, QoQ chart, report/PDF/deck,
    **Email report** (sends from your own M365 mailbox, deck attached).
  - *Data* — everything Sync pulled, grouped by source, **reviewed before it
    enters the QBR**: untick metrics to exclude them everywhere (report,
    scorecard, AI input), and add **manual metrics** for the API gaps
    (Synology, SAT, canaries).
  - *Branding & Sections* — logo, brand colors, section show/hide, custom sections.
  - *Discussion & Responses* — talking points, client responses, dispositions.
  - *Schedule & Actions* — **Create Teams meeting** (books your M365 calendar,
    invites attendees, stores the join link) or paste a link; push dispositioned
    items to **Halo tickets/opportunities** or **Zomentum opportunities**.

The QBR status advances itself (sync → schedule → approve → disposition → push,
never backwards), and every AI narrative is cached per client/quarter — only a
data change or explicit Regenerate calls Claude again.

Persistence is a local JSON store + secret file in dev (`.data/`, gitignored;
override the dir with `QBR_DATA_DIR`); in Azure it uses **Azure Table Storage**
(app data, references only) + **Key Vault** (secrets). The store/secret backends
switch automatically when `AzureWebJobsStorage` / `KEY_VAULT_URL` are set —
`GET /api/system` reports which backends are active plus whether AI and
server-side PDF are available, and the UI adapts (PDF button, secret-store copy).

Quarter pickers are driven by `GET /api/period/current` (the UI walks back to
the most recent quarter with data), and the QBR status advances forward
automatically — sync → `data_synced`, booking a meeting → `scheduled`, captured
dispositions → `dispositioned`, a successful push → `actions_pushed` — without
ever downgrading a later stage.

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
setting `KEY_VAULT_URL=https://<vault>.vault.azure.net/` — **without this the
app falls back to a local secret file, which is dev-only**. App data uses the
Function App's existing `AzureWebJobsStorage` (Table Storage) — no new resource.
Turn on **Entra Easy Auth** to lock the app to Mash IT logins (it also powers
the account menu and audit actor). PDF export is deferred on Consumption (print
the HTML report from the browser); the report + PPTX deck work. A 5-minute
keep-warm timer softens cold starts.

### Microsoft 365 email + Teams scheduling (one-time)

The app sends QBR emails and books Teams meetings **as the signed-in user** via
the Easy Auth token store — no extra login. Configure once:

1. **App registration** (the one Easy Auth created): *API permissions → Add →
   Microsoft Graph → Delegated* → `User.Read`, `Mail.Send`, `Calendars.ReadWrite`
   → **Grant admin consent**.
2. **Function App → Authentication**: ensure the **token store** is enabled.
3. Request the Graph scopes at login (the portal has no field for this — use az):

   ```bash
   az extension add --name authV2
   auth=$(az webapp auth show -g <rg> -n <app> | jq '.properties')
   auth=$(echo "$auth" | jq '.identityProviders.azureActiveDirectory.login += {"loginParameters":["scope=openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite"]}')
   az webapp auth set -g <rg> -n <app> --body "$auth"
   ```

4. **Sign out and back in** once so your session carries a Graph token.

Until then the Email/Meeting buttons explain what's missing instead of failing
silently. Tokens refresh transparently via `/.auth/refresh`.

> Locally, once the web is built, `npm run dev:api` also serves the SPA at
> http://localhost:7071 — the same single-app behavior as production.

The `Deploy` GitHub Action mirrors this path: it runs the tests, builds the
same self-contained `apps/api/deploy` package, and publishes it to the one
Function App (the old separate Static-Web-Apps deploy is gone).

## Grounding & safety

- The AI never does arithmetic — all totals, percentages, and QoQ deltas are
  pre-computed in `packages/core` and passed to the model.
- Every cited figure must trace back to a computed value; the guardrail
  regenerates the narrative on any mismatch and never auto-publishes.
- Verified narratives are **cached** per client/period, keyed on a hash of the
  exact metric bundle + model id — repeat report views don't re-call Claude,
  and any data re-sync or model upgrade regenerates automatically.
- Secrets live in Key Vault (referenced, never stored in the DB); SQL is
  Entra-only; data services are private-endpoint only. See `infra/main.bicep`.

## Status

Phase 3 — MCP OAuth (Client ID/Secret token exchange), signed-in identity +
compliance audit log, native M365 (email QBRs from your mailbox, create Teams
meetings), per-client QBR scoping with integration-centric org mapping, a Data
review tab (exclusions + manual metrics), a no-regenerate narrative editor, and
one-call dashboard loading with a keep-warm timer. Next: meeting attendance
completion, CIPP/Domotz/Dropsuite collectors, scheduled snapshot sync, and the
client-facing portal — see the build plan for the phased roadmap.
