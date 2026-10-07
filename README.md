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
| `packages/core` | Domain model, quarter periods, QoQ trend engine, blended **CIS v8 / NIST CSF 2.0** maturity scorecard, dashboard **flags engine**, seed data from real QBRs |
| `packages/integrations` | **Direct vendor API clients** — HaloPSA, NinjaOne, Hudu, Huntress, Check Point, Dropsuite, Printix, ConnectSecure, CIPP, Google Workspace, DefensX — plus snapshot assembly (legacy MASH-MCP path kept only as a fallback) |
| `packages/narrative` | Claude-backed executive narrative with a **figure-verification guardrail** + deterministic offline drafter |
| `packages/report` | One view-model → branded HTML, **designed pdfmake PDF**, rebuilt pptxgenjs deck |
| `apps/api` | Azure Functions (v4) HTTP API + orchestration, data/secret/**document** stores (Table Storage / Key Vault / Blob), live sync + workflow pipeline, Outlook `.eml` drafts |
| `apps/web` | React (Vite) + **Mantine v7** admin app (Dashboard, Clients, Integrations, QBR workspace, Settings), gated by Entra ID auth |
| `infra` | Bicep: one Flex Consumption (FC1) Function App (Node 24, Easy Auth) + Storage (tables, blobs, deployment container) + Key Vault + Log Analytics |

## Develop

Requires **Node 22** or later.

```bash
npm install
npm run typecheck   # tsc across the workspace
npm test            # vitest (513 tests)
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
`ANTHROPIC_API_KEY` to use Claude (`claude-opus-4-8`) for the narrative. PDF
(pdfmake) and deck (pptxgenjs) export work out of the box — no Chromium needed.
(`func start` from `apps/api` still works for production parity if you have
Core Tools v4.)

## Using the app

The header shows **who's signed in** (Easy Auth / Entra) with sign-out; every
mutation is written to the **Audit log** page (who / what / when) for compliance.

- **Dashboard** — the admin cockpit: one row per QBR client with the **last
  QBR** (quarter + workflow state + meeting date), **maturity rating**,
  **account health** (a holistic 0–100 blending posture, open flags, review
  engagement and a churn signal — hover for the drivers), **MRR** (from Halo
  contracts), **roadmap $** (the annualized open-opportunity pipeline), **spend
  movement QoQ**, and **attention flags** (patch/MFA/AV gaps, failing backups,
  out-of-warranty devices, critical vulnerabilities, security incidents,
  maturity drops, spend spikes). Rows click straight into the workspace;
  report/PDF are one click from here. Account health and roadmap $ are
  **internal only** — neither reaches the client-facing report.
- **Clients** — all clients with a **QBR toggle** (you don't review everyone —
  imports from Halo arrive with QBR off; enable just the ones you do). Each
  client can carry a **compliance standard** (HIPAA, TISAX, SOC 2…) — the AI
  narrative and the scorecard framing reflect it with a light touch (compliance
  *intent*, never an audit report).
- **Integrations** — every tool connects **directly with its own API
  credentials**: HaloPSA (Client ID/Secret — tickets with real date windows,
  classified by **ITIL ticket type** (type ids resolved via `/api/TicketType`)
  so the headline is human **service-desk** volume — Incidents / Service
  Requests / Change Requests — while automated RMM/security tickets are broken
  out as **Automated alerts** instead of inflating the count; an optional
  **ticket-type allowlist** narrows it further; **SLA outcomes** computed from
  each ticket's respond-by / fix-by deadline vs. the actual response/close;
  contracts/invoices for MRR + an **invoice breakdown by
  Halo item group** — Managed Services / Subscriptions / Software…, ticket
  push), NinjaOne (API client,
  `monitoring` scope — devices, health, AV, **quarterly patch compliance**
  from the install history, org-scoped backup), Hudu (API key — assets +
  warranty/domain/SSL expirations), Huntress (API key/secret — quarterly
  summary + MFA), **CIPP** (the CIPP-API app registration — per-tenant M365
  posture: MFA coverage **scoped to licensed users on the primary domain**
  the same way Huntress is, user counts, Conditional Access,
  license waste), **Google Workspace** (service account with domain-wide
  delegation — users + 2-Step Verification coverage; each connection is
  dedicated to one QBR client), Check Point (Infinity Portal Client ID +
  Access Key — keys are per-tenant, so dedicate the connection to that
  client), Dropsuite (reseller token — mailbox backup health plus **protected
  data volume, emails protected, stale-backup detection, seats, OneDrive and
  SharePoint coverage, connection failures**), Printix (tenant + API client —
  Printix tenants are per-client, so add one connection per client and
  dedicate it to that QBR client),
  ConnectSecure (pod + Client ID/Secret), **DefensX** (Partner API Bearer token
  — cyber-resilience score, protected & risky users, risky browser extensions,
  blocked malicious/credential-theft sites per customer), and Zomentum. Each connection has
  **Test** and **Map clients** (pick who's who from the orgs found in the
  tool) — and **Halo mappings accept multiple entities per client** (service
  + billing companies get summed; Madison Peds maps to both its Halo
  records). Secrets go to **Key Vault**; only references are stored. Synology
  ABB has no public API — use manual metrics + the report inbox. (The legacy
  MASH-MCP connection still works until you delete it.)
- **Settings** — upload the **Mash IT logo** once (plus house colors); it
  becomes the default branding on every report, PDF and deck. Until then a
  built-in wordmark is used, so deliverables are never unbranded.
- **QBR workspace** (`/clients/:id`) — quarter picker (marks quarters with
  data) and a header where every deliverable is one click: **Sync · Report ·
  PDF · Deck · Email draft**. The tabs follow the QBR lifecycle:
  - *Overview* — what the client will see: executive summary with the **Edit
    narrative** editor (save wording instantly with no AI call; **Regenerate**
    re-drafts; **Approve** advances the workflow), maturity ring + radar, QoQ
    chart, recommendations, attached reports. The editor also carries the
    **AI direction** controls: pick a **QBR focus** (business security,
    continuity, cost optimization…), add standing guidance ("backup counts
    changed because we re-tuned monitoring — not a trend"), and comment on any
    **section summary** with a small edit button — regenerate re-drafts with
    your feedback included. Direction is remembered per client and feeds every
    future quarter's draft.
  - *Data* — everything Sync pulled, grouped by source, **reviewed before it
    enters the QBR**: untick metrics to exclude them everywhere, add **manual
    metrics** for the API gaps (Synology, SAT), and manage **attached
    documents** — the Huntress quarterly PDF lands here automatically on
    Sync; upload anything else (Synology exports, Dropsuite summaries). All
    attachments are listed in the report appendix.
  - *Meeting* — **pre-wire the agenda** before the call (quick-add topics,
    reorder), fill in responses live (items flip planned → discussed), choose
    dispositions and owners, untick "On report" for internal-only items —
    answered items flow onto the final report's Discussion & Decisions
    section. Scheduling lives here too: **Create Teams meeting** (books your
    M365 calendar, invites attendees) or paste a link.
  - *Actions* — push outcomes to work: **Halo ticket** opens a form where you
    set the summary, details, **ticket type, agent, team and priority**
    (lookup lists come live from Halo); Halo/Zomentum opportunities push
    one-click.
  - *Reports* — the client's report repository across all quarters: rename,
    categorize, move between quarters (multi-select to delete in bulk) — or
    hit **AI match** and Claude reads each PDF (native PDF input) and suggests
    the vendor, a clean name, the quarter its *content* covers, and a
    category, with a one-click **Match** button to accept. The
    **Extract metrics** button goes further: Claude pulls the quarter-scoped
    numbers out of the PDF (a Check Point Security Checkup's phishing/spam/
    DLP counts, a Dropsuite digest…) into a review list; what you accept
    joins that quarter's snapshot under a `pdf:<vendor>` source and flows
    into the report, scorecard and trends like any synced metric. Upload a
    **previous QBR** to a past quarter and extract it the same way — instant
    quarter-over-quarter history for a new client.
  - *Opportunities* — the cross-quarter initiative board (idea → discussing →
    approved → pushed → closed) with drag-and-drop and push-to-Halo. Each card
    can carry an **estimated value** (one-time or monthly MRR); the board shows
    per-column and total **annualized pipeline**, and the sum rolls up to the
    dashboard's roadmap-$ column. Values are internal only.
  - *Studio* — **strategic goals & alignment** (the client's business
    objectives + how IT supports them — these open the report as a *Strategic
    Goals & IT Alignment* section and give the AI narrative context to frame
    the quarter around them; qualitative, no figures), per-client branding
    overrides (client logo shows alongside the Mash IT logo), section
    show/hide, custom sections. Deliverables always wear the Mash IT theme from
    Settings — per-client config contributes only the display name and logo.

**Email draft** deserves a note: it downloads a ready-to-send `.eml` that
opens in Outlook desktop as an **unsent draft** — recipient prefilled from the
client contact, a three-line message, the branded PDF attached (with the
attached vendor reports appended to its back pages), and every attached
report as its own file too. Review and hit Send from your own mailbox; no
Graph permissions involved.

### The report inbox (email ingestion)

For data the vendor APIs don't expose — the Check Point report, NinjaOne's
"Endpoint Management Report for QBRs" (Ninja's public API has **no** reports
endpoint), Dropsuite digests, Synology exports — every client has a **report
inbox**: forward (or schedule the vendor to send) reports to
`qbr-reports+{clientId}@yourdomain`, and a 5-minute poll files the
attachments onto that client's QBR automatically. Put a quarter tag like
`2026-Q3` in the subject to file into a specific quarter; otherwise the
current one is used. Filed reports appear in the workspace, the report
appendix, the back of the PDF, and the email draft. The exact address per
client is shown on the workspace **Data** tab.

One-time setup:

1. Create a **shared mailbox** (e.g. `qbr-reports@mashit.net`) — plus
   addressing is on by default in Exchange Online.
2. **App registration** (a new one, or reuse an automation app): *API
   permissions → Microsoft Graph → Application* → `Mail.ReadWrite` → **Grant
   admin consent**. Recommended: scope it to just this mailbox with an
   [ApplicationAccessPolicy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access).
3. Function App settings: `REPORTS_MAILBOX`, `REPORTS_TENANT_ID`,
   `REPORTS_CLIENT_ID`, and `REPORTS_CLIENT_SECRET` (store the secret in Key
   Vault and use an `@Microsoft.KeyVault(SecretUri=…)` reference).

4. Optional: `REPORTS_ALLOWED_SENDERS`, a comma-separated list of sender
   addresses or bare domains allowed to file reports (for example
   `checkpoint.com,reports@huntress.io`). Mail from the mailbox's own domain
   is always accepted, so staff forwards keep working. Unset means only that
   domain is trusted. Mail from anyone else is not filed.

The poll also reads Junk, but nothing in Junk is ever filed, whoever it claims
to be from: a spoof of our own domain that fails DMARC lands there. Junk mail
is categorized `QBR: untrusted`. To file a real report that landed in Junk,
forward it from a staff mailbox.

Messages are marked read and categorized (`QBR: filed` / `QBR: unrouted` /
`QBR: untrusted` / `QBR: failed`) so the mailbox itself stays auditable. A
message that fails to process is marked `QBR: failed`, listed in the poll
result's `failed` array (id, subject, error) and logged, and the poll moves on
to the next one. Filed documents record the sender address. `POST /api/inbox/poll` triggers a check
immediately.

The QBR status advances itself (sync → schedule → approve → disposition → push).
Forward moves are automatic; a backwards move is never automatic and needs an
explicit override with a reason, which is audited. Approve needs synced data,
and marking the package sent records the first send date only. Every AI
narrative is cached per client/quarter — only a
data change or explicit Regenerate calls Claude again.

### AI cost controls

The tool is deliberately stingy with the Claude API: every generated draft is
cached (even ones that failed figure verification — the warning shows and
Regenerate re-drafts), an API failure (rate limit, empty credits) triggers a
5-minute cooldown instead of retrying on every page view, the metrics bundle
is sent as compact JSON, and the AI matcher/extractor send at most 6 / 30 PDF
pages respectively. Two optional app settings tune the cost/quality point of
the narrative itself: `NARRATIVE_MODEL` (default `claude-opus-4-8` at $5/$25
per MTok; `claude-sonnet-5` runs ~40% cheaper) and `NARRATIVE_EFFORT`
(default `high`; `medium` spends fewer reasoning tokens). Changing the model
regenerates narratives on next view (the model id is part of the cache key).

For HIPAA clients, ticket subjects and samples are withheld from the model by
default, for the narrative and for the Meeting tab's agenda suggestions alike,
and the recurring-theme insight drops its clustering word as well. Set
`NARRATIVE_ALLOW_PHI=1` only when a BAA covering the model provider is in
place; it lets ticket samples reach both prompts for every client.

Persistence is a local JSON store + secret file in dev (`.data/`, gitignored;
override the dir with `QBR_DATA_DIR`); in Azure it uses **Azure Table Storage**
(app data, references only) + **Key Vault** (secrets) + **Blob Storage**
(attached documents — the `qbr-documents` container is auto-created on the
Function App's own storage account, no setup). The backends switch
automatically when `AzureWebJobsStorage` / `KEY_VAULT_URL` are set —
`GET /api/system` reports which are active plus whether AI is available.

Quarter pickers are driven by `GET /api/period/current` (the UI walks back to
the most recent quarter with data), and the QBR status advances forward
automatically — sync → `data_synced`, booking a meeting → `scheduled`, captured
dispositions → `dispositioned`, a successful push → `actions_pushed` — without
ever downgrading a later stage.

## Deploy to Azure (one Function App)

Deployed as a **single Flex Consumption (FC1) Azure Function App on Node 24** that serves both the
API and the React UI at one URL (mirrors the Mash IT MCP gateway). Build the
self-contained package and deploy the folder:

```bash
npm install
npm run deploy:build          # builds web + API, assembles + prunes apps/api/deploy/
# VS Code: Open Folder -> apps/api/deploy -> Azure -> Deploy to Function App
```

`deploy:build` prunes type-declaration/doc/map files from the deploy
`node_modules` so the zip stays well under 65,535 entries — past that the zipper
emits ZIP64 and Kudu rejects it with *"Offset to Central Directory cannot be
held in an Int64"*. If a deploy still fails that way (or the VS Code zipper
produces a bad archive), deploy from the CLI instead, which uses a reliable
zipper:

```bash
# from apps/api/deploy   (PowerShell)
Compress-Archive -Path * -DestinationPath ..\deploy.zip -Force
az functionapp deployment source config-zip -g QBRTool -n mashqbr --src ..\deploy.zip
```

Portal one-time: create the Function App (Flex Consumption / Node 24),
enable system-assigned **managed identity**, put `ANTHROPIC_API_KEY` in **Key
Vault**, and add the app setting `ANTHROPIC_API_KEY=@Microsoft.KeyVault(SecretUri=…)`.
For the portal-managed integrations, grant the identity **Key Vault Secrets
Officer** (write, so the app can store connection secrets) and add the app
setting `KEY_VAULT_URL=https://<vault>.vault.azure.net/` — **without this the
app falls back to a local secret file, which is dev-only**. App data uses the
Function App's existing `AzureWebJobsStorage` (Table Storage) — no new resource.
Turn on **Entra Easy Auth** to lock the app to Mash IT logins (it also powers
the account menu and audit actor). Report, **PDF** (pdfmake, works on
Flex Consumption), PPTX deck, and Outlook email drafts all work out of the box. A
5-minute keep-warm timer softens cold starts.

The API also checks for the Easy Auth principal itself: on App Service
(`WEBSITE_INSTANCE_ID` set) every route except the booking page and its API
returns 401 without one, even if Easy Auth is misconfigured. App Service sets
the read-only `WEBSITE_AUTH_ENABLED=True` when Easy Auth is on; if it is
missing, the API fails closed and answers 401 on every gated route, because
without Easy Auth nothing strips a forged `x-ms-client-principal` header.
`QBR_AUTH_REQUIRED=1` forces the check on anywhere. `QBR_AUTH_REQUIRED=0` turns
it off for local dev only; on App Service it is ignored with a warning. In Azure without `KEY_VAULT_URL`, saving connection credentials is
refused and `GET /api/system` reports `secretStore: 'local-insecure'`.

`infra/main.bicep` provisions this exact topology: Log Analytics + App
Insights, a Storage account (TLS 1.2, HTTPS only, no public blob access, the
`qbr-documents` container), Key Vault (RBAC, 90-day soft delete, purge
protection), a Flex Consumption (FC1) plan, the Function App on Node 24
(`functionAppConfig` runtime `node` 24, deployed from the private `app-package`
blob container) with a system identity scoped to **Key Vault Secrets Officer**
on the vault and **Storage Blob Data Contributor** on the deployment container,
`authsettingsV2` with the four booking paths excluded, and diagnostic
settings for the app, blob, table and vault. Parameters: `namePrefix` (9
characters at most), `env`, `location`, `aadClientId`, `aadTenantId`,
`aadClientSecretSettingName` and `loginParameters`.

Read this before running the template against anything that already exists:

- **It is for provisioning a fresh environment.** `siteConfig.appSettings`
  replaces every app setting on the Function App, so `ANTHROPIC_API_KEY`,
  `REPORTS_*`, `NARRATIVE_*`, `RESEARCH_MODEL` and any `QBR_*` setting you
  added in the portal must be re-applied after an IaC deploy.
- **The Key Vault name carries a unique suffix** (like the storage account), so
  deploying the template over an environment created with the old
  `<prefix>-<env>-kv` name creates a second, empty vault and points
  `KEY_VAULT_URL` at it. Migrate the connection secrets first, or keep using
  the portal-managed app and skip the infra job.
- **Create Teams meeting and server-side send need the token store**, which
  needs the Easy Auth client secret and the Graph login scopes. Put the secret
  in an app setting (a Key Vault reference works), pass its name as
  `aadClientSecretSettingName`, and leave `loginParameters` at its default
  unless your scopes differ. Without them Easy Auth still signs people in; only
  those two features stay off.

The Deploy workflow (`.github/workflows/deploy.yml`) ships code on every manual
run and only provisions infrastructure when its `provision_infra` input is
ticked. It needs an `AAD_CLIENT_ID` repository variable (the Easy Auth app
registration's client id) alongside the existing `AZURE_RESOURCE_GROUP` and
`FUNCTION_APP_NAME` variables and the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID` secrets. When provisioning, `FUNCTION_APP_NAME` must
equal the template's app name (`mashqbr-prod-func`); the job refuses to run
otherwise, so the infra job and the deploy job can never target two different
apps.

### Microsoft 365 Teams scheduling (one-time)

QBR emails need **no setup**: the Email draft button downloads an `.eml` that
opens in Outlook as an unsent message. The optional Graph integration below is
only for **Create Teams meeting** (and the legacy server-side send), which run
**as the signed-in user** via the Easy Auth token store — no extra login.
Configure once:

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

### Client self-scheduling (booking page, one-time)

Each client/quarter gets a private **booking link** (Meeting tab → "Client
self-scheduling", and automatically inside the QBR email draft until a meeting
is booked). The page at `/book/{token}` looks and feels like Microsoft
Bookings: the client picks a day and a time that's actually open on the
organizer's calendar, and a **Teams invite goes to both sides automatically**.
Booking rules (organizer, duration, weekdays, day window, timezone, minimum
notice, how far out) live under **Settings → QBR self-scheduling**. A booked
slot marks the QBR **scheduled** and pings the notification bell. Setup:

1. On the **report-inbox app registration** (the booking page reuses
   `REPORTS_TENANT_ID` / `REPORTS_CLIENT_ID` / `REPORTS_CLIENT_SECRET`; or set
   `GRAPH_*` equivalents): *API permissions → Microsoft Graph → Application* →
   `Calendars.ReadWrite` → **Grant admin consent**.
2. Make the booking routes public so clients reach them without a Mash IT
   login, via Easy Auth **excluded paths**. Three gotchas, all learned the hard
   way: (a) there is NO portal field for them — they are NOT the "Allowed token
   audiences" box on the identity-provider page; (b) `az webapp auth set --body`
   from `az webapp auth show` WIPES your identity provider, because `show`
   returns the AAD `registration` blanked out — never use that round-trip; and
   (c) excluded paths match EXACTLY, so `/book` alone does NOT cover
   `/book/{token}` — you need the base path AND a `/*` subpath entry. The safe
   way is a raw ARM GET → edit → PUT (the raw GET returns the real registration,
   so the round-trip preserves the IdP), in Cloud Shell (Bash):

   ```bash
   sub=$(az account show --query id -o tsv)
   base="https://management.azure.com/subscriptions/$sub/resourceGroups/<rg>/providers/Microsoft.Web/sites/<app>/config/authsettingsV2?api-version=2022-03-01"
   az rest --method get --uri "$base" > current.json
   jq '{properties: (.properties | .globalValidation.excludedPaths = ["/book","/book/*","/api/book","/api/book/*"])}' current.json > updated.json
   az rest --method put --uri "$base" --headers "Content-Type=application/json" --body @updated.json
   ```

   (PATCH is not supported on `authsettingsV2` — it's PUT-only.) Then **verify
   in a fresh incognito window** that `https://<app>.azurewebsites.net/book/<token>`
   loads instead of redirecting to login; restart the Function App if it still
   redirects. The unguessable 24-char CSPRNG token is the sole authorization;
   the endpoints expose only display names and open slots.
3. Set the **organizer email** in Settings and save.

Without step 1 the page still works — it offers the configured windows without
conflict-checking and records the choice (you send the invite yourself); the
portal tells you which mode you're in.

### Notifications & the QBR pipeline

The header **bell** collects: new vendor/emailed reports as they're ingested,
client bookings, and **"time to schedule" reminders** (a QBR-enabled client
has data for the quarter but nothing on the calendar once the quarter enters
its final month — checked on the 5-minute timer, at most twice a day, one ping
per client per quarter). The Workspace **Overview** tab opens with a pipeline
stepper — Sync → File reports → Narrative → Schedule → Meet → Send package →
Complete — where each step reflects live state (the email-draft download
stamps "Send package") and **Mark this QBR complete** closes the quarter, after
which the workspace targets the next one automatically.

> Locally, once the web is built, `npm run dev:api` also serves the SPA at
> http://localhost:7071 — the same single-app behavior as production.

The `Deploy` GitHub Action mirrors this path: it runs the tests, builds the
same self-contained `apps/api/deploy` package, and publishes it to the one
Function App (the old separate Static-Web-Apps deploy is gone).

## Grounding & safety

- The narrative is written for executives: a headline, a short summary, and
  **one plain-English takeaway sentence per report section** (rendered under
  each section heading in the report, PDF and deck) — enough data to show the
  value, high-level enough to hold a non-technical room.
- The AI never does arithmetic — all totals, percentages, and QoQ deltas are
  pre-computed in `packages/core` and passed to the model.
- Every cited figure must trace back to a computed value; the guardrail
  regenerates the narrative on any mismatch and never auto-publishes.
- Verified narratives are **cached** per client/period, keyed on a hash of the
  exact metric bundle + model id — repeat report views don't re-call Claude,
  and any data re-sync or model upgrade regenerates automatically.
- Secrets live in Key Vault (referenced, never stored in the DB) and the app
  refuses to store them anywhere else in Azure. Easy Auth fronts every route
  but the booking page, and the API rejects requests without a principal as
  a second layer. The template does not configure VNet integration, so
  Storage and Key Vault keep public endpoints, protected by account keys, Entra RBAC and TLS 1.2, with
  diagnostics to Log Analytics. See `infra/main.bicep`.

## Status

Phase 5 — direct vendor API collectors for the whole stack (Halo, Ninja, Hudu,
Huntress, Check Point, Dropsuite, Printix, ConnectSecure; MASH MCP demoted to
a legacy fallback), vendor-report aggregation into the QBR (auto-pull + upload
to Blob, appendix on the report), a designed branded pdfmake PDF + rebuilt
PowerPoint deck + org-level branding via Settings, Outlook `.eml` email
drafts, a pre-wireable meeting agenda that flows onto the final report, Halo
ticket push with full field control, an admin dashboard (last QBR, rating,
MRR, spend Δ, flags), and a fewer-clicks workspace. Next: CIPP/Domotz
collectors, scheduled snapshot sync, meeting attendance completion, and the
client-facing portal — see the build plan for the phased roadmap.
