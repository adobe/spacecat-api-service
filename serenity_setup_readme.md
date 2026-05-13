# Serenity / Brand Presence — Local Setup Guide

End-to-end local setup for two Semrush-backed surfaces:

1. **Prompts Management** — CRUD over Semrush AIO prompts via the
   `SEMRUSH_PROJECT_MATRIX` projects (cookie-authenticated `/enterprise/projects/api`).
2. **Brand Presence dashboard** — KPI cards, trend charts, and prompt-rankings
   widgets backed by the Semrush v4-raw **Reporting API** (API-key auth) plus
   the Semrush AIO Projects API for the Category / Tags / Platform filter
   options.

After following this guide you can:

- list / create / edit / delete prompts in Elmo at
  `https://localhost:3000/org/<orgId>/prompts-management`,
- open `/org/<orgId>/insights/brand-presence` and see all six KPI cards (Share of
  Voice, Source Visibility, AI Visibility, Brand Visibility, Brand Mentions,
  Citations) pulling live data from Semrush for the active project,
- filter by Category (= one Semrush project per option), Market, Language,
  Platform (= the project's actual Semrush models), and Tags.

Traffic:

```
Elmo (https://localhost:3000)
   │  fetch with SpaceCat JWT
   ▼
spacecat-api-service (http://localhost:3002)
   ├─► /enterprise/projects/api (cookie auth)   — prompts, projects, models, tags
   └─► api.semrush.com/apis/v4-raw (Apikey)     — Reporting API element queries
```

> Hackathon-quality. The Reporting API key is a personal token, Semrush UI auth
> is a captured cookie, the proxy skips auth locally. None of this is suitable
> for stage/prod.

---

## 1. PRs you need checked out

| Repo | Branch | PR |
| --- | --- | --- |
| `adobe/spacecat-api-service` | `feat/prompts-management` | [#2397](https://github.com/adobe/spacecat-api-service/pull/2397) — Serenity prompts CRUD proxy + Brand Presence widget endpoints (workspace projects, project models, project tags, reporting-element proxy). |
| `adobe/project-elmo-ui` | `feat/prompts-management` | [#1735](https://github.com/adobe/project-elmo-ui/pull/1735) — Semrush-backed Prompts Management UI + Brand Presence widget wiring (live KPIs, dynamic Category/Platform/Tags filters, SR fireball badge on live widgets). |

Optional dependency:

| Repo | Branch | Notes |
| --- | --- | --- |
| `adobe/mysticat-data-service` | `main` (or any tag ≥ `v5.14.2`) | Provides the PostgreSQL + PostgREST images the proxy talks to |

---

## 2. Prerequisites

- Node 22 (use `mise` or `nvm`)
- `npm`
- Docker (for the Postgres + PostgREST stack)
- AWS CLI configured with the `spacecat-dev` profile (for the ECR `docker login`
  used to pull the `mysticat-data-service` images)
- `gh` / `git` for cloning
- A Semrush account that can reach the AIO prompts UI **and** an enterprise
  API key for the Reporting API (see §6)

---

## 3. Clone & check out

```bash
# spacecat-api-service
gh repo clone adobe/spacecat-api-service
cd spacecat-api-service
git checkout feat/prompts-management
npm install

# project-elmo-ui (in a sibling directory)
cd ..
gh repo clone adobe/project-elmo-ui
cd project-elmo-ui
git checkout feat/prompts-management
npm install
```

---

> **Want to skip Postgres entirely?** Set `STUB_DATA_SERVICE=true` in
> `project-elmo-ui/config/.env.localapi` and skip §4 and §5. The UI will fake
> all the data-service endpoints client-side; only the proxy needs to be
> running (for the Semrush-backed Serenity calls). Details in §10.3.

## 4. Run the local Postgres + PostgREST stack

The proxy needs a PostgREST server to look up orgs, brands, sites, and feature
flags. The repo ships a docker-compose file that boots both:

```bash
cd spacecat-api-service

# Authenticate Docker against Adobe's private ECR (renews every 12h)
aws ecr get-login-password --profile spacecat-dev --region us-east-1 \
  | docker login --username AWS --password-stdin \
    682033462621.dkr.ecr.us-east-1.amazonaws.com

# Start Postgres (port 5432) and PostgREST (port 3300)
docker compose -f test/it/postgres/docker-compose.yml up -d
```

Verify:

```bash
curl http://localhost:3300/ | head -c 200   # PostgREST OpenAPI
docker ps                                    # both containers Up
```

The image tag is pinned in `test/it/postgres/docker-compose.yml`. If the pull
fails with `denied: User: …`, your ECR login expired — re-run the
`aws ecr get-login-password` command.

---

## 5. Seed the local database

The proxy needs an Adobe Organization, a Site, and an Adobe Brand to attach the
prompts to. The IDs **must match** the values your local checkout expects, or
you'll hit access-control denials.

Open a `psql` session against the local DB:

```bash
psql postgresql://postgres:postgres@localhost:5432/postgres
```

Then run:

```sql
SET session_replication_role = 'replica';

-- 5a. Adobe organization — id must equal the SpaceCat org UUID for
--     908936ED5D35CC220A495CD4@AdobeOrg
INSERT INTO organizations (id, ims_org_id, name)
VALUES (
  '160da889-39a2-4019-9315-82bbd4da59e7',
  '908936ED5D35CC220A495CD4@AdobeOrg',
  'Adobe (local dev)'
)
ON CONFLICT (id) DO NOTHING;

-- 5b. Adobe brand
INSERT INTO brands (id, organization_id, name)
VALUES (
  '3e3556f0-6494-4e8f-858f-01f2c358861a',
  '160da889-39a2-4019-9315-82bbd4da59e7',
  'Adobe'
)
ON CONFLICT (id) DO NOTHING;

-- 5c. A site so site-centric URLs work (any valid uuid)
INSERT INTO sites (id, organization_id, base_url, name)
VALUES (
  '22222222-2222-4222-b222-222222222222',
  '160da889-39a2-4019-9315-82bbd4da59e7',
  'https://site2.example.com',
  'Local test site'
)
ON CONFLICT (id) DO NOTHING;

-- 5d. Category (matches the Photoshop matrix entry). Without this row the
--     Tracking Recommendations Track-all dialog renders an empty Category
--     picker for the Prompts Management flow.
INSERT INTO categories (id, organization_id, name, origin, status)
VALUES (
  '44444444-4444-4444-b444-444444444444',
  '160da889-39a2-4019-9315-82bbd4da59e7',
  'Photoshop',
  'human',
  'active'
)
ON CONFLICT DO NOTHING;

RESET session_replication_role;
```

> The Brand Presence dashboard does **not** need any local Postgres data — it
> reads exclusively from Semrush via the proxy. The seed above only affects
> Prompts Management and the trial-overlay gates. If you only care about BP,
> the org + brand rows are still required for access control to pass.

---

## 6. Capture Semrush credentials

You need **two** different Semrush credentials for the two API surfaces:

### 6.1 Semrush UI cookie (for Prompts Management + Project metadata)

The AIO Projects API (`/enterprise/projects/api/...`) is gated by Adobe ↔
Semrush IMS trust which is **not wired up for hackathon**. The workaround is
to forward a logged-in browser session via the `Cookie` request header.

1. Open `https://www.semrush.com` in Chrome and log in to your enterprise
   account.
2. Open DevTools → Network tab → click any request to `www.semrush.com`.
3. In the Request Headers panel, find `cookie:` and copy the **entire** value.
4. Verify it contains `sso_token=…` — that's the critical bit. If it doesn't,
   you're not logged in to the right tenant.
5. Save it somewhere you can paste it into `.env` (it's long — ~3-6 kB).

Cookies expire roughly every few hours. When the proxy starts returning 401
from Semrush for `prompts` / `projects` / `models` / `tags` calls, recapture
the cookie and restart the proxy.

### 6.2 Semrush Reporting API key (for Brand Presence widgets)

The Brand Presence widgets call the v4-raw Reporting API
(`https://api.semrush.com/apis/v4-raw/external-api/v1/...`) using `Apikey`
authentication. The key currently in use is documented in
`feat-serenity/api_requests.md` under "Api key:". Save it for the proxy
`.env`. The key is long-lived; rotate it via Semrush admin.

---

## 7. Configure `spacecat-api-service` `.env`

```bash
cd spacecat-api-service
cp .env.example .env
```

Edit `.env`. Variables you must change are marked **(YOU)**; everything else
can keep the `.env.example` defaults.

```bash
# ── Data access ────────────────────────────────────────────────────────────
DATA_SERVICE_PROVIDER=postgres
POSTGREST_URL=http://localhost:3300
POSTGREST_SCHEMA=public
POSTGREST_API_KEY=<keep the JWT from .env.example>

# ── Auth: skip for local dev ───────────────────────────────────────────────
SKIP_AUTH=true
ENABLE_CORS=true
CORS_ALLOWED_ORIGINS=https://localhost:3000

# ── Semrush — AIO Projects API (cookie auth) ───────────────────────────────
# (YOU) Paste the matrix JSON from §7.1 on one line, no newlines. Drives the
#       Prompts Management screen (which projects to fan a prompt out across).
SEMRUSH_PROJECT_MATRIX={"workspaceId":"a827e263-fafb-49af-96f6-d3ef7fe2c33d","rows":[{"brandId":"3e3556f0-6494-4e8f-858f-01f2c358861a","category":"Acrobat","market":"US","language":"en","projectId":"cbae5e32-2739-483c-9c1f-738500334433","slug":"acrobat_us_en"},{"brandId":"3e3556f0-6494-4e8f-858f-01f2c358861a","category":"Photoshop","market":"US","language":"en","projectId":"19f8806f-e1ec-44ed-a73f-2b8c4cb980f9","slug":"photoshop_us_en"},{"brandId":"3e3556f0-6494-4e8f-858f-01f2c358861a","category":"Adobe","market":"JP","language":"ja","projectId":"f0f958ce-6620-4ec7-9bbb-dd460457c277","slug":"adobe_jp_ja"}]}

# (YOU) The full Cookie header from §6.1. Must include sso_token. Quote it.
SEMRUSH_COOKIE='__cf_bm=…; sso_token=…; …'

# Optional overrides for the AIO Projects API
# SEMRUSH_USER_AGENT=        # defaults to a Chrome-on-macOS UA
# SEMRUSH_PROJECTS_BASE_URL=https://www.semrush.com   # change for staging

# ── Semrush — Reporting API (Apikey auth, Brand Presence widgets) ──────────
# (YOU) Personal Semrush enterprise API key from §6.2.
SEMRUSH_REPORTING_API_KEY=4026f54a05819f71786ac8788f5af272

# Optional override
# SEMRUSH_REPORTING_BASE_URL=https://api.semrush.com
```

Everything else in `.env.example` (`AWS_*`, `IMS_*`, `SLACK_*`, queue URLs, S3
buckets, `SCRAPE_JOB_CONFIGURATION`, `IMPORT_CONFIGURATION`,
`API_KEY_CONFIGURATION`) keeps its dummy default — the proxy doesn't reach any
of those services in this flow, but they must be present and parseable or the
service won't start.

### 7.1 Matrix JSON

The matrix is a `(brandId, category, market, language) → projectId` mapping
used by Prompts Management. The Brand Presence dashboard does **not** use the
matrix — it lists all active AIO projects in the workspace via
`/v2/workspaces/{ws}/projects?type=AIO&publish_status=live,…`.

Three sample matrix rows are pre-baked in §7. Add more rows to fan a prompt
out across markets/languages. The `brandId` must exist as a row in the local
`brands` table (§5). All rows share the one top-level `workspaceId`.

---

## 8. Start the proxy

```bash
cd spacecat-api-service
npm start
```

It listens on `http://localhost:3002`. Watch the logs for errors on startup —
the helix runtime parses every JSON env var (`SCRAPE_JOB_CONFIGURATION` etc.)
eagerly, so a typo there will crash the boot.

Quick sanity checks:

```bash
# 1) AIO projects list (matrix-driven; used by Prompts Management)
curl http://localhost:3002/v2/orgs/160da889-39a2-4019-9315-82bbd4da59e7/brands/3e3556f0-6494-4e8f-858f-01f2c358861a/serenity/projects

# 2) Workspace AIO projects list (used by BP Category filter)
curl http://localhost:3002/v2/orgs/160da889-39a2-4019-9315-82bbd4da59e7/brands/3e3556f0-6494-4e8f-858f-01f2c358861a/serenity/workspaces/a827e263-fafb-49af-96f6-d3ef7fe2c33d/projects

# 3) Models for a specific project (used by BP Platform filter)
curl http://localhost:3002/v2/orgs/160da889-39a2-4019-9315-82bbd4da59e7/brands/3e3556f0-6494-4e8f-858f-01f2c358861a/serenity/projects/a827e263-fafb-49af-96f6-d3ef7fe2c33d/23156795-a905-41db-be20-ae944590c1d1/models

# 4) Reporting element passthrough (used by BP KPI cards)
curl -X POST http://localhost:3002/v2/orgs/160da889-39a2-4019-9315-82bbd4da59e7/brands/3e3556f0-6494-4e8f-858f-01f2c358861a/serenity/reporting/elements/3886e794-7e75-4e6b-a100-4813ded946e0 \
  -H "content-type: application/json" \
  -d '{"workspaceId":"a827e263-fafb-49af-96f6-d3ef7fe2c33d","render_data":{"comparison_data_formatting":"union","project_id":"23156795-a905-41db-be20-ae944590c1d1","filters":{"simple":{"start_date":"2026-04-13","end_date":"2026-05-12","comparison_start_date":"2026-03-14","comparison_end_date":"2026-04-12"},"advanced":{"op":"and","filters":[{"op":"eq","val":"Adobe","col":"CBF_brand"}]}}}}'
```

Common failures:
- `503 matrixNotConfigured` → `SEMRUSH_PROJECT_MATRIX` isn't loaded; check
  it's a single line and parseable.
- `502 semrushUpstreamError` → cookie is invalid/expired (for AIO endpoints)
  or the Reporting API key is wrong (for `/reporting/elements/...`).
- `503 SEMRUSH_REPORTING_API_KEY is not configured` → set the env var (§7).
- `400 Missing IMS bearer token and SEMRUSH_COOKIE is not configured` →
  `SEMRUSH_COOKIE` is empty.

---

## 9. Enable the `brandalf` feature flag for the local org

This switches Elmo into org-centric mode and exposes the new sidebar entries.

```bash
curl -X PUT \
  http://localhost:3002/organizations/160da889-39a2-4019-9315-82bbd4da59e7/feature-flags/llmo/brandalf \
  -H "content-type: application/json" \
  -d '{"value": true}'
```

Verify:

```bash
curl 'http://localhost:3002/organizations/160da889-39a2-4019-9315-82bbd4da59e7/feature-flags?product=LLMO'
```

To disable later, `DELETE` the same path (it sets `flagValue=false`; the row
remains).

---

## 10. Configure `project-elmo-ui`

Generate the local HTTPS cert (only once per checkout):

```bash
cd project-elmo-ui
npm run generate-certs
```

The repo ships `config/.env.localapi` already pointing at the local proxy.
The LaunchDarkly client id is also pre-filled.

### 10.1 LaunchDarkly flag overrides

Three LaunchDarkly flags control the new surfaces. Set them locally via
`LD_FLAG_OVERRIDES` in `config/.env.localapi` so you don't have to flip them
in the LD UI:

| Flag | Key | What it gates |
| --- | --- | --- |
| `usePgDashboards` | `FT_LLMO-4071` | Routes `/insights/brand-presence` to **`BrandPresencePgDashboard`** (the new dashboard with Semrush widgets). Without it you'd land on the legacy `BrandPresenceDashboard`. |
| `brandalfOnboarding` | `FT_LLMO-3785` | Org-nav sidebar layout + onboarding overlays scoped to the org route. |
| `showSerenityDashboards` | `FT_LLMO-4799` | Surfaces the **AI Visibility** sidebar section (SR Insights landing, Results, Prompt / Competitor Research, Tracking Recommendations). |

`config/.env.localapi`:

```bash
ELMO_SITES=[{"url":"https://frescopa.coffee/","brand":"Frescopa","dataFolder":"frescopa.coffee","isDemo":"true","envs":"all, local, demo","tags":["fullyOnboarded","demo"]}]
IMS_ENV='prod'
MYSTIQUE_URL='http://localhost:8080'
SPACECAT_URL='http://localhost:3002'
CHAT_ENABLED='true'
DEBUG='true'
LD_CLIENT_ID='68c18490db10c1099c466895'

# Local LD overrides — wins over per-user values returned by ldClient.identify().
LD_FLAG_OVERRIDES='{"FT_LLMO-4071":true,"FT_LLMO-3785":true,"FT_LLMO-4799":true}'

ADOBE_USER_EMAIL=
ADOBE_USER_PASSWORD=
```

`LaunchDarklyProvider.tsx` reads `LD_FLAG_OVERRIDES` at init and applies it as
the SDK bootstrap. **In addition**, `src/utils/dashboardVisibility.ts`
consults the same env var via `resolveFlag()` at every gate check (sidebar
visibility, the `pgComponent` switch in `MainApp.tsx`) so the override wins
over the live LD value even after `ldClient.identify()` runs at sign-in.
Without that two-layer wiring, LD would replace the bootstrap on identify
and the entries / dashboards would vanish.

`LD_FLAG_OVERRIDES` must be set **before** starting the dev server —
webpack's `DotenvWebpack` inlines `process.env` at build time, not runtime.

### 10.2 Start the dev server

```bash
cd project-elmo-ui
npm run dev:localapi
```

It listens on `https://localhost:3000`. Accept the self-signed cert warning.

### 10.3 Stub the data-service (skip Docker / PostgREST / seed SQL)

For pure hackathon dev — only Brand Presence + Prompts Management — you can
short-circuit every data-service call from the browser and skip §4 and §5
entirely. The proxy still has to be running so Semrush traffic flows, but it
won't query Postgres because the UI never asks it to.

Set this in `project-elmo-ui/config/.env.localapi`:

```bash
STUB_DATA_SERVICE=true
```

When enabled, `src/api/dataServiceStub.ts` intercepts the following URLs the
proxy normally serves from PostgREST and returns canned JSON:

| URL pattern | Fixture response |
| --- | --- |
| `/organizations/by-ims-org-id/...` | One org (`160da889-…`) |
| `/organizations/{orgId}` | Same org |
| `/organizations/{orgId}/entitlements` | `[llmo_optimizer, aso]` (paid tier) |
| `/organizations/{orgId}/feature-flags?product=LLMO` | `[{flagName: 'brandalf', flagValue: true}]` |
| `/organizations/{orgId}/sites` | One site |
| `/organizations/{orgId}/userDetails` | `{}` |
| `/organizations/{orgId}/trial-users` | `[]` |
| `/organizations/{orgId}/feature-flags/{product}/{flag}` (PUT/DELETE) | `200 {ok:true}` (no-op toggle) |
| `/sites` | `{sites: [<one site>]}` |
| `/sites/{siteId}` | One site |
| `/v2/orgs/{orgId}/brands` | `{brands: [<Adobe brand>]}` |
| `/v2/orgs/{orgId}/brands/{brandId}` | Adobe brand |
| `/v2/orgs/{orgId}/categories` | `{categories: []}` |

URLs containing `/serenity/`, `/llmo/`, or `/demo/` are **not** intercepted —
they pass through to the real proxy as normal. Anything else also falls
through, so missing endpoints show up clearly in DevTools.

**Skipping §9** as well: the brandalf flag is hardcoded `true` in the stub,
so you don't need to PUT it via the proxy.

**Trade-offs (versus real Postgres):**
- One org / brand / site only. Multi-tenant flows can't be exercised.
- Feature-flag toggles in the UI are no-ops; the value won't change.
- Trial-state transitions that mutate `customer-configuration` are inert.
- Any future Postgres-backed surface needs a new pattern in
  `dataServiceStub.ts`. The unmatched URLs hit the proxy and fail
  (loudly) so you'll know.

The env var is read at webpack build time (`DotenvWebpack` inlines
`process.env`), so restart `npm run dev:localapi` after toggling it.

---

## 11. Click through the flow

### 11.1 Prompts Management

1. Open `https://localhost:3000` and log in with the same Adobe IMS account
   whose org id you seeded in §5.
2. Navigate to
   `https://localhost:3000/org/160da889-39a2-4019-9315-82bbd4da59e7/prompts-management`.
3. You should see the prompts from the matrix projects (Photoshop / Acrobat /
   Adobe-JP), paginated 50/page.
4. Create a new prompt — it lands in Semrush's draft state, then the proxy
   auto-publishes the project. Refresh: count goes up by one.

### 11.2 Brand Presence

1. Navigate to
   `https://localhost:3000/org/160da889-39a2-4019-9315-82bbd4da59e7/insights/brand-presence`.
2. The page should render the six KPI cards (each marked with the small SR
   fireball badge in the top-right) backed by live Semrush data:
   - Share of Voice
   - Source Visibility
   - AI Visibility (gauge)
   - Brand Visibility
   - Brand Mentions
   - Citations
3. The filter bar shows:
   - **Date Range** — drives `start_date` / `end_date` (and the auto-mirrored
     comparison window) on every widget.
   - **Category** — one entry per active Semrush project in the workspace.
     Defaults to the "Adobe" project; switching it rebinds all widgets,
     tags, and models to the new project.
   - **Market** — locked to `US` (pinned). Sent as `CBF_country` on the
     widgets that support it.
   - **Language** — locked to `EN`.
   - **Platform** — the active project's actual Semrush models (Chat GPT,
     Claude, Gemini, etc.). Sent as `CBF_model`.
   - **Tags** — the active project's tags. UI-only today (no `CBF_tag*`
     column documented in the Semrush API).

If the sidebar doesn't show "AI Visibility":
- Brandalf flag not set (§9), **or**
- `FT_LLMO-4799` not bootstrapped (§10.1), **or**
- You're on a site-centric URL like `/site2.example.com/...` — the new
  entries are only in `OrgSidebar`, not the site sidebar.

If `/insights/brand-presence` shows the **legacy** dashboard (no Semrush
widgets) — `FT_LLMO-4071` isn't bootstrapped. Add it to `LD_FLAG_OVERRIDES`
and restart the dev server.

---

## 12. Common failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Elmo loads forever on prompts page | API service not running / wrong port | `lsof -iTCP:3002 -sTCP:LISTEN` |
| `Failed to fetch` in console | CORS preflight 401 | confirm `ENABLE_CORS=true` and `SKIP_AUTH=true` on the proxy |
| 401 from `/serenity/prompts` or `/serenity/projects/*/models` | `SEMRUSH_COOKIE` expired | recapture (§6.1), restart proxy |
| KPI cards stay on skeleton forever | `SEMRUSH_REPORTING_API_KEY` missing or wrong | set it (§7), restart proxy |
| 502 on `/serenity/reporting/elements/...` | Reporting API key invalid, or filter combo upstream rejects | check proxy logs for the upstream body |
| 503 `matrixNotConfigured` | bad JSON in `SEMRUSH_PROJECT_MATRIX` | re-paste on single line, restart |
| 500 on workspace `/projects?type=AIO` | Cookie permissions don't include AIO project listing | recapture cookie from a user with AIO access |
| Prompts page shows 0 items but Semrush has them | wrong `projectId` in matrix | double-check the matrix row |
| Created a prompt but count didn't go up | Semrush draft buffer not published | proxy auto-publishes since #2397; older commits need a manual publish |
| Sidebar shows old entries only | brandalf flag off (§9) OR LD flags off (§10.1) | enable both, hard-reload |
| `/insights/brand-presence` shows the legacy mock charts | `FT_LLMO-4071` not in `LD_FLAG_OVERRIDES` | add it, restart dev server |
| Platform dropdown shows "Deepseek" instead of ChatGPT | Project models query in flight or returned empty | wait for fetch; if persistent, check `/serenity/projects/*/models` response |
| Category filter empty | Workspace projects query failed (cookie 500/403) | recapture cookie, restart proxy |
| Redirect / refresh loop on the BP page | A `dependsOn` cascade is racing the URL sync — usually means a fresh edit broke an effect | revert the offending change and re-test |

---

## 13. What this PR set actually changes

### `spacecat-api-service` (PR #2397)

- `src/support/serenity/rest-transport.js` — Cookie-authenticated transport
  for `/enterprise/projects/api`. New methods:
  `listPromptsByTags`, `createTaggedPrompts`, `deletePromptsByIds`,
  `publishProject`, **`listWorkspaceProjects`** (v2 selector endpoint,
  `?type=AIO&publish_status=live,…`), **`listAiModels`**.
- `src/support/serenity/reporting-transport.js` — **NEW.** Apikey-authenticated
  transport for `api.semrush.com/apis/v4-raw/external-api/v1`. Single method
  `queryElement(workspaceId, elementId, body)` — passes the customer's
  `render_data` payload through verbatim and returns the upstream response.
- `src/support/serenity/matrix.js` — `(brandId, category, market, language) →
  projectId` resolver for Prompts Management.
- `src/support/serenity/handlers/prompts.js` — list / create / update /
  delete logic (paginates across matrix projects, dedupes by base64url
  logical id, auto-publishes after every mutation).
- `src/controllers/serenity-prompts.js` — controller wiring.
- Routes (in `src/routes/index.js`):
  - **Prompts Management**
    - `GET    /v2/orgs/:org/brands/:brand/serenity/projects`
    - `GET    /v2/orgs/:org/brands/:brand/serenity/prompts`
    - `POST   /v2/orgs/:org/brands/:brand/serenity/prompts`
    - `PATCH  /v2/orgs/:org/brands/:brand/serenity/prompts/:promptId`
    - `POST   /v2/orgs/:org/brands/:brand/serenity/prompts/bulk-delete`
  - **Brand Presence dashboard**
    - `GET    /v2/orgs/:org/brands/:brand/serenity/projects/:workspaceId/:projectId/tags`
    - `GET    /v2/orgs/:org/brands/:brand/serenity/projects/:workspaceId/:projectId/models`
    - `GET    /v2/orgs/:org/brands/:brand/serenity/workspaces/:workspaceId/projects`
    - `POST   /v2/orgs/:org/brands/:brand/serenity/reporting/elements/:elementId`
- `.env.example` — documents `SEMRUSH_COOKIE`, `SEMRUSH_PROJECT_MATRIX`,
  **`SEMRUSH_REPORTING_API_KEY`**, optional `SEMRUSH_USER_AGENT`,
  `SEMRUSH_PROJECTS_BASE_URL`, `SEMRUSH_REPORTING_BASE_URL`.

### `project-elmo-ui` (PR #1735)

- `src/types/serenityPrompt.ts` — types for the proxy contract.
- `src/api/spacecat.ts` — `listSerenityProjects`, `listSerenityPrompts`,
  `createSerenityPrompts`, `updateSerenityPrompt`,
  `bulkDeleteSerenityPrompts`, **`listSerenityProjectTags`**,
  **`listSerenityProjectModels`**, **`listSerenityWorkspaceProjects`**,
  **`querySerenityReportingElement`**.
- `src/hooks/useSerenityPromptsApi.ts` — TanStack Query hook for Prompts
  Management.
- `src/hooks/useSerenityReportingElement.ts` — **NEW.** Thin TanStack Query
  wrapper around `querySerenityReportingElement`.
- `src/components/prompts-management/SerenityDataInsights.tsx` — table view.
- `src/components/prompts-management/SerenityPromptDialog.tsx` — create/edit.
- `src/components/dashboards/brand-presence-pg/BrandPresencePgDashboard.tsx` —
  rebuilt around the Semrush widgets:
  - Pinned workspace + default project, switchable via the Category filter.
  - Fetches workspace projects, project models, and project tags.
  - Builds a per-project `srMatrix` payload that drives all dashboard filters
    via `loadDynamicFilterOptions`.
  - Defaults the Platform filter to the project's "normal ChatGPT" model
    (one-shot per project via a ref guard).
  - Sends six concurrent reporting queries (Share of Voice, Source
    Visibility, AI Visibility, Brand Visibility, Brand Mentions, Citations)
    keyed off the active project, with comparison-period dates auto-mirrored.
- `src/constants/filters.ts` — Category / Region / Language / Platform / Tags
  loadOptions all detect a `srMatrix` in rawData and serve project-derived
  options. `dependsOn` removed from Platform / Topic to prevent cascade
  resets from looping with the URL sync.
- `src/constants/dashboards.tsx` — BP filter set updated to
  `[TIME_RANGE, PRODUCT, REGION, LANGUAGE, PLATFORM, TOPIC]`.
- `src/utils/dashboardVisibility.ts` — `resolveFlag(flag, flags)` helper that
  makes `LD_FLAG_OVERRIDES` authoritative across all flag checks.
- `src/components/MainApp.tsx` — `pgComponent` switch uses `resolveFlag()`
  so `FT_LLMO-4071` override is respected.
- `src/components/common/LiveDataIndicator.tsx` — **NEW.** Wraps a widget
  with the SR partner fireball mini badge to signal "this card uses live
  Semrush data".
- `src/components/dashboards/ai-visibility/ModelLogo.tsx` — dispatcher
  extended to match Semrush model names (`"Chat GPT"`, `"chat-gpt"`,
  `"search-gpt"`, bare `"gpt"`).
- `src/api/dataServiceStub.ts` — **NEW.** Hackathon-only fixture
  interceptor for the proxy's Postgres-backed endpoints (org / brand /
  site / feature-flag / entitlement). Enabled by `STUB_DATA_SERVICE=true`
  in `config/.env.localapi`; lets local dev skip Postgres + PostgREST +
  seed SQL entirely. See §10.3 for the full URL pattern table.
- `config/.env.localapi` — documents `STUB_DATA_SERVICE` and the three
  `LD_FLAG_OVERRIDES` flags (`FT_LLMO-4071`, `FT_LLMO-3785`,
  `FT_LLMO-4799`).

---

## 14. Updating the Semrush cookie on a long-running session

When the UI cookie expires you'll see all `/serenity/*` upstream calls fail
with 401 (the Reporting API key is independent — it doesn't share the same
TTL). To rotate:

```bash
# 1. Capture new cookie (§6.1)
# 2. Edit spacecat-api-service/.env, replace SEMRUSH_COOKIE='...'
# 3. Restart the proxy
cd spacecat-api-service
# Ctrl+C the running npm start, then:
npm start
```

Elmo doesn't need to be restarted — it doesn't hold any Semrush state.

---

## 15. Brand Presence — clearing the "Configuration Required" gate

`/org/{orgId}/insights/brand-presence` (the new dashboard) is gated on
`useSerenityPromptsApi(...).total > 0` — meaning the brand has at least one
prompt in any matrix project. If you've used Prompts Management to create or
import a prompt, the gate is already cleared.

If the gate still triggers ("Configuration Required" overlay), it's because
the matrix has no projects for the brand or the prompts list returns empty.
Confirm with:

```bash
curl http://localhost:3002/v2/orgs/160da889-39a2-4019-9315-82bbd4da59e7/brands/3e3556f0-6494-4e8f-858f-01f2c358861a/serenity/prompts | jq .total
```

If you need to bypass the gate without creating prompts, the **legacy** BP
dashboard's gate is what `BrandPresenceOverlay.tsx` checks. See git history
for the older seed-SQL workaround if you're stuck on a build that pre-dates
the Serenity-aware overlay.

---

## 16. Status — what's done, what's open

### Done (committed across both PRs)

**Proxy (`spacecat-api-service` #2397)**
- Semrush AIO REST transport with cookie auth.
- Semrush Reporting API transport with `Apikey` auth.
- Hardcoded matrix `(brandId, category, market, language) → projectId` read
  from `SEMRUSH_PROJECT_MATRIX`.
- Prompts CRUD with full pagination, base64url logical ids, multi-tag input,
  project auto-publish after every mutation.
- Workspace projects list (active AIO projects only).
- Per-project models list and tags list.
- Reporting-element passthrough (six BP widget element IDs).

**UI (`project-elmo-ui` #1735)**
- Prompts Management page — list/create/edit/delete against Semrush via the
  proxy, with matrix-driven filters that cross-narrow to valid combinations.
- Tracking Recommendations Track-all / Track-topic both publish through the
  same Serenity dialog (one prompt per snapshot row, tagged with topic).
- Brand Presence dashboard — six KPI cards backed by the Reporting API,
  Category filter that switches between workspace projects (with
  `friendlyCategoryLabel` lay-person labels: General / Doodle / GMI /
  HEIC to PDF / Adobe Stock), Platform filter driven by the project's
  Semrush models, Tags filter driven by the project's tags,
  comparison-period date math, SR fireball badge on every live widget,
  loading skeletons until each query lands.
- LaunchDarkly local override that survives `ldClient.identify()`.
- Optional `STUB_DATA_SERVICE=true` flag — fakes every Postgres-backed
  data-service endpoint in the browser so local dev only needs the proxy
  running, no Docker / no PostgREST / no seed SQL.

### Open

1. **Trend charts inside the BP tabs panels** — `SemrushMockInsightsSection`
   still shows mock series for the Share-of-Voice trend, Source-Visibility
   trend, AI-Visibility trend, and Sentiment chart. Element IDs for the SoV
   trend and Prompt-Rankings tables exist in `api_requests.md`; the others
   need request examples from Semrush to be wired. See
   `BP_REPORTING_ELEMENT_IDS` in `BrandPresencePgDashboard.tsx`.

2. **`CitationsMentionsTrendChart` widgets** — still mock data. The doc has
   `Trends` (element `1f992fe3-…`) which carries `y__mentions`, `y__sov`,
   `y__brand_visibility` per point but no `y__citations` field. Need a
   citations-trend example.

3. **AI Citations / AI Visibility tables** in the bottom rankings panel —
   no element IDs yet.

4. **Tags filter end-to-end** — the picker populates from the project's
   tags, but no `CBF_*` column is documented for tag filtering on the
   Reporting elements, so selecting tags currently doesn't affect any
   widget. Needs a Semrush UI request capture with tags applied.

5. **Mirror Serenity prompts into the local Postgres `prompts` table** —
   today the Serenity proxy only writes to Semrush. The legacy v2-prompts
   surfaces and the trial-overlay gate read from Postgres. Plan: on
   `POST /serenity/prompts` success, upsert a matching V2 prompt row.

6. **Per-row workspace override in the matrix schema** — matrix carries one
   top-level `workspaceId`. If you add a Semrush project in a different
   workspace, the matrix won't accept it. Easy to add `row.workspaceId` with
   the top-level as default.

7. **Polish** — `SRTrackTopicToPromptsDialog.tsx` is unused; safe to delete.
   `SemrushMockInsightsSection.tsx` should be renamed once its sections are
   wired to live data.

---

## 17. Tearing it all down

```bash
cd spacecat-api-service
docker compose -f test/it/postgres/docker-compose.yml down -v   # wipe DB
# Ctrl+C the npm starts in both repos
```
