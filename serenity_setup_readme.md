# Serenity Prompts Management — Local Setup Guide

End-to-end local setup for the Semrush-backed prompts management feature. After
following this guide you can list, create, edit and delete prompts in Elmo at
`https://localhost:3000`, with traffic flowing:

```
Elmo (https://localhost:3000)
   │  fetch with SpaceCat JWT
   ▼
spacecat-api-service (http://localhost:3002)
   │  cookie-authenticated REST call
   ▼
Semrush V2 AIO prompts API (https://www.semrush.com)
```

> Hackathon-quality. The matrix is hardcoded, Semrush auth is a captured cookie,
> and auth on the proxy is skipped. None of this is suitable for stage/prod.

---

## 1. PRs you need checked out

| Repo | Branch | PR |
| --- | --- | --- |
| `adobe/spacecat-api-service` | `feat/spacecat-api-service` | [#2393](https://github.com/adobe/spacecat-api-service/pull/2393) — serenity prompt CRUD proxy (rebased on top of #2385) |
| `adobe/project-elmo-ui` | `feat/prompts-management` | [#1735](https://github.com/adobe/project-elmo-ui/pull/1735) — Semrush-backed prompts management UI (rebased on top of #1700) |

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
- A Semrush account that can reach the AIO prompts UI (see §6)

---

## 3. Clone & check out

```bash
# spacecat-api-service
gh repo clone adobe/spacecat-api-service
cd spacecat-api-service
git checkout feat/spacecat-api-service
npm install

# project-elmo-ui (in a sibling directory)
cd ..
gh repo clone adobe/project-elmo-ui
cd project-elmo-ui
git checkout feat/prompts-management
npm install
```

---

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
prompts to. The matrix maps a brand to a Semrush project, so the IDs **must
match** the matrix exactly.

Open a `psql` session against the local DB:

```bash
psql postgresql://postgres:postgres@localhost:5432/postgres
```

Then run:

```sql
-- Use replica role so trigger-based FK checks don't trip us up while seeding
SET session_replication_role = 'replica';

-- 5a. Adobe organization — id must equal the prod SpaceCat org UUID for
--    908936ED5D35CC220A495CD4@AdobeOrg (so /auth/orgs2 from prod matches)
INSERT INTO organizations (id, ims_org_id, name)
VALUES (
  '160da889-39a2-4019-9315-82bbd4da59e7',
  '908936ED5D35CC220A495CD4@AdobeOrg',
  'Adobe (local dev)'
)
ON CONFLICT (id) DO NOTHING;

-- 5b. Brand id must match the matrix entry (Photoshop / US / en)
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

-- 5d. Category (matches the matrix). Without this row the Tracking
--     Recommendations Track-all dialog renders an empty Category picker.
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

Your IMS org UUID is the one you find via `mysticat org get '<imsOrg>' --json`.
The example above uses `908936ED5D35CC220A495CD4@AdobeOrg` which resolves to
`160da889-...`. If your IMS org is different, use that UUID in **both** the
`organizations.id` AND the matrix's `brandId.organization_id` chain — or you'll
end up with mismatched access-control denials.

---

## 6. Capture the Semrush cookie

The Semrush AIO prompts API is gated by Adobe ↔ Semrush IMS trust which is **not
wired up for hackathon**. The workaround is to forward a logged-in browser
session via the `Cookie` request header.

1. Open `https://www.semrush.com` in Chrome and log in to your enterprise
   account.
2. Open DevTools → Network tab → click any request to `www.semrush.com`.
3. In the Request Headers panel, find `cookie:` and copy the **entire** value.
4. Verify it contains `sso_token=…` — that's the critical bit. If it doesn't,
   you're not logged in to the right tenant.
5. Save it somewhere you can paste it into `.env` (it's long — ~3-6 kB).

Cookies expire roughly every few hours. When the proxy starts returning 401 from
Semrush, recapture the cookie and restart the proxy.

> Alternative (not currently used): IMS pass-through via `Auth-Data-Jwt`. The
> proxy supports it (see `src/support/serenity/rest-transport.js`) but Semrush
> doesn't trust Adobe IMS tokens today, so cookie is the only working mode.

---

## 7. Configure `spacecat-api-service` `.env`

```bash
cd spacecat-api-service
cp .env.example .env
```

Edit `.env` and set the following. Variables you must change are marked
**(YOU)**; everything else can keep the `.env.example` defaults.

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

# ── Semrush (Serenity) ─────────────────────────────────────────────────────
# (YOU) Paste the matrix JSON from §8.1 on one line, no newlines.
SEMRUSH_PROJECT_MATRIX={"workspaceId":"c522f571-76e9-42e5-9213-7a767f448453","rows":[{"brandId":"3e3556f0-6494-4e8f-858f-01f2c358861a","category":"Acrobat","market":"US","language":"en","projectId":"cbae5e32-2739-483c-9c1f-738500334433","slug":"acrobat_us_en"},{"brandId":"3e3556f0-6494-4e8f-858f-01f2c358861a","category":"Photoshop","market":"US","language":"en","projectId":"19f8806f-e1ec-44ed-a73f-2b8c4cb980f9","slug":"photoshop_us_en"},{"brandId":"3e3556f0-6494-4e8f-858f-01f2c358861a","category":"Adobe","market":"JP","language":"ja","projectId":"f0f958ce-6620-4ec7-9bbb-dd460457c277","slug":"adobe_jp_ja"}]}

# (YOU) The full Cookie header from §6. Must include sso_token. Quote it.
SEMRUSH_COOKIE='__cf_bm=…; sso_token=…; …'

# Optional overrides
# SEMRUSH_USER_AGENT=        # defaults to a Chrome-on-macOS UA
# SEMRUSH_PROJECTS_BASE_URL=https://www.semrush.com   # change for staging
```

Everything else in `.env.example` (`AWS_*`, `IMS_*`, `SLACK_*`, queue URLs, S3
buckets, `SCRAPE_JOB_CONFIGURATION`, `IMPORT_CONFIGURATION`,
`API_KEY_CONFIGURATION`) keeps its dummy default — the proxy doesn't reach any
of those services in this flow, but they must be present and parseable or the
service won't start.

### 7.1 Matrix JSON

The matrix is a `(brandId, category, market, language) → projectId` mapping.
The current Semrush workspace has three live projects we've tested against,
sourced from
`llmo-data-retrieval-service/tmp/exports/semrush_projects_mapping_*.csv`:

```json
{
  "workspaceId": "c522f571-76e9-42e5-9213-7a767f448453",
  "rows": [
    {
      "brandId":   "3e3556f0-6494-4e8f-858f-01f2c358861a",
      "category":  "Acrobat",
      "market":    "US",
      "language":  "en",
      "projectId": "cbae5e32-2739-483c-9c1f-738500334433",
      "slug":      "acrobat_us_en"
    },
    {
      "brandId":   "3e3556f0-6494-4e8f-858f-01f2c358861a",
      "category":  "Photoshop",
      "market":    "US",
      "language":  "en",
      "projectId": "19f8806f-e1ec-44ed-a73f-2b8c4cb980f9",
      "slug":      "photoshop_us_en"
    },
    {
      "brandId":   "3e3556f0-6494-4e8f-858f-01f2c358861a",
      "category":  "Adobe",
      "market":    "JP",
      "language":  "ja",
      "projectId": "f0f958ce-6620-4ec7-9bbb-dd460457c277",
      "slug":      "adobe_jp_ja"
    }
  ]
}
```

Add more rows to fan a prompt out across markets/languages. The `brandId` must
exist as a row in the local `brands` table (§5). All rows share the one
top-level `workspaceId` — if you need a project in a different workspace, the
schema needs to grow per-row `workspaceId` support first.

---

## 8. Start the proxy

```bash
cd spacecat-api-service
npm start
```

It listens on `http://localhost:3002`. Watch the logs for errors on startup —
the helix runtime parses every JSON env var (`SCRAPE_JOB_CONFIGURATION` etc.)
eagerly, so a typo there will crash the boot.

Quick sanity check:

```bash
curl http://localhost:3002/v2/orgs/160da889-39a2-4019-9315-82bbd4da59e7/brands/3e3556f0-6494-4e8f-858f-01f2c358861a/serenity/projects \
  -H "x-api-key: api_key_for_admin_requests"
```

Expected response (200):

```json
{
  "projects": [{ "workspaceId": "c522f5…", "projectId": "19f880…", "slug": "photoshop_us_en", "category": "Photoshop", "market": "US", "language": "en" }],
  "facets": { "categories": ["Photoshop"], "regions": ["US"], "languages": ["en"] }
}
```

If you get:
- `503 matrixNotConfigured` → `SEMRUSH_PROJECT_MATRIX` isn't loaded; check
  it's a single line and parseable.
- `502 semrushUpstreamError` → cookie is invalid/expired or the project id is
  wrong; recapture cookie (§6).
- `400 Missing IMS bearer token and SEMRUSH_COOKIE is not configured` →
  `SEMRUSH_COOKIE` is empty.

---

## 9. Enable the `brandalf` feature flag for the local org

This switches Elmo into org-centric mode and exposes the new sidebar entries.

```bash
curl -X PUT \
  http://localhost:3002/organizations/160da889-39a2-4019-9315-82bbd4da59e7/feature-flags/llmo/brandalf \
  -H "x-api-key: api_key_for_admin_requests" \
  -H "content-type: application/json" \
  -d '{"value": true}'
```

Verify:

```bash
curl 'http://localhost:3002/organizations/160da889-39a2-4019-9315-82bbd4da59e7/feature-flags?product=LLMO' \
  -H "x-api-key: api_key_for_admin_requests"
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

The repo ships `config/.env.localapi` already pointing at the local proxy — no
edits needed for the proxy URL. The LaunchDarkly client id is also pre-filled.

### 10.1 LaunchDarkly flag override

The new "SR AI Visibility" sidebar entries are gated by LaunchDarkly flag
`FT_LLMO-4799` (`showSerenityDashboards`). Bootstrap it locally so you don't
have to flip it in the LD UI:

```bash
export LD_FLAG_OVERRIDES='{"FT_LLMO-4799": true}'
```

You can stack multiple flags:

```bash
export LD_FLAG_OVERRIDES='{"FT_LLMO-4799": true, "FT_LLMO-3785": true}'
```

`LaunchDarklyProvider.tsx` reads `LD_FLAG_OVERRIDES` at init and applies it as
the SDK bootstrap. **In addition**, `src/utils/dashboardVisibility.ts` consults
the same env var at the gate check so the override wins over the live LD value
even after `ldClient.identify()` runs at sign-in — without this, LD would
replace the bootstrap on identify and the entries would vanish.

The variable must be set **before** starting the dev server (webpack's
`DotenvWebpack` inlines `process.env` at build time, not runtime).

### 10.2 Start the dev server

```bash
cd project-elmo-ui
npm run dev:localapi
```

It listens on `https://localhost:3000`. Accept the self-signed cert warning.

---

## 11. Click through the flow

1. Open `https://localhost:3000` and log in with the same Adobe IMS account
   whose org id you seeded in §5.
2. The app should land you in your org (or, if it doesn't, navigate manually to
   `https://localhost:3000/org/160da889-39a2-4019-9315-82bbd4da59e7/overview`).
3. Left sidebar should show the new "AI Visibility" section between Brand and
   Domain. If it doesn't:
   - Brandalf flag not set (§9), **or**
   - `FT_LLMO-4799` not bootstrapped (§10.1), **or**
   - You're on a site-centric URL like `/site2.example.com/...` — the new
     entries are only in `OrgSidebar`, not the site sidebar.
4. Open **Prompts Management** under the Brand section. You should see ~62
   prompts from the Photoshop project, paginated 50/page.
5. Create a new prompt — it lands in Semrush's draft state, then the proxy
   auto-publishes the project. Refresh: count goes up by one.

---

## 12. Common failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Elmo loads forever on prompts page | API service not running / wrong port | `lsof -iTCP:3002 -sTCP:LISTEN` |
| `Failed to fetch` in console | CORS preflight 401 | confirm `ENABLE_CORS=true` and `SKIP_AUTH=true` on the proxy |
| 401 from `/serenity/prompts` | `SEMRUSH_COOKIE` expired | recapture (§6), restart proxy |
| 503 `matrixNotConfigured` | bad JSON in `SEMRUSH_PROJECT_MATRIX` | re-paste on single line, restart |
| Prompts page shows 0 items but Semrush has them | wrong `projectId` in matrix | double-check the matrix row |
| Created a prompt but count didn't go up | Semrush draft buffer not published | proxy auto-publishes since [#2393]; if you're on an older commit, hit the project's publish endpoint manually |
| Sidebar shows old entries only | brandalf flag off (§9) OR `FT_LLMO-4799` off (§10.1) | enable both, hard-reload |
| `auth error` page right after login | Local DB missing the org / brand / site for your IMS org | re-run the seed SQL (§5) with **your** IMS org's UUID |
| Edit dialog shows wrong prompt's data | Pre-fix bug in PR #1735 — pull latest | `git pull` on `feat/prompts-management` |

---

## 13. What this PR set actually changes

### `spacecat-api-service` (PR #2393)

- `src/support/serenity/rest-transport.js` — REST transport for Semrush V2 AIO
  with dual auth (cookie or IMS bearer).
- `src/support/serenity/matrix.js` — `(brandId, category, market, language) →
  projectId` resolver. Reads `SEMRUSH_PROJECT_MATRIX` from env.
- `src/support/serenity/handlers/prompts.js` — list/create/update/delete logic.
  Paginates across all matrix projects for the brand, dedupes by logical id
  (base64url of `{brandId, category, language, text}`), publishes the project
  after every mutation so changes show up immediately.
- `src/controllers/serenity-prompts.js` — controller wiring.
- Routes (in `src/routes/index.js`):
  - `GET    /v2/orgs/:org/brands/:brand/serenity/projects`
  - `GET    /v2/orgs/:org/brands/:brand/serenity/prompts`
  - `POST   /v2/orgs/:org/brands/:brand/serenity/prompts`
  - `PATCH  /v2/orgs/:org/brands/:brand/serenity/prompts/:promptId`
  - `POST   /v2/orgs/:org/brands/:brand/serenity/prompts/bulk-delete`
- `.env.example` — documents `SEMRUSH_COOKIE`, `SEMRUSH_PROJECT_MATRIX`,
  optional `SEMRUSH_USER_AGENT`, `SEMRUSH_PROJECTS_BASE_URL`.

### `project-elmo-ui` (PR #1735)

- `src/types/serenityPrompt.ts` — types for the proxy contract.
- `src/api/spacecat.ts` — `listSerenityProjects`, `listSerenityPrompts`,
  `createSerenityPrompts`, `updateSerenityPrompt`,
  `bulkDeleteSerenityPrompts`.
- `src/hooks/useSerenityPromptsApi.ts` — TanStack Query hook with paginated
  list, debounced search, mutations, and a separate projects query for facets.
- `src/components/prompts-management/SerenityDataInsights.tsx` — table view
  with search, matrix-driven filters (category/market/language), tags column,
  pagination footer, bulk select+delete.
- `src/components/prompts-management/SerenityPromptDialog.tsx` — create/edit
  dialog. All form inputs are constrained to the matrix-supported values;
  Topics is a multi-select keyed by the prompts already in the project.
- `src/pages/PromptsManagement.tsx` — wired to the new hook; works on both
  org-centric (`/org/:orgId/...`) and site-centric (`/:siteId/...`) URLs.
- `src/locale/serenity-prompts.l10n.js` — strings.

---

## 14. Updating the cookie on a long-running session

When the cookie expires you'll see all upstream calls fail with 401. To rotate:

```bash
# 1. Capture new cookie (§6)
# 2. Edit spacecat-api-service/.env, replace SEMRUSH_COOKIE='...'
# 3. Restart the proxy
cd spacecat-api-service
# Ctrl+C the running npm start, then:
npm start
```

Elmo doesn't need to be restarted — it doesn't hold any Semrush state.

---

## 15. Brand Presence — clearing the "Configuration Required" gate

`/org/{orgId}/brand-presence` checks the local Postgres `prompts`/`categories`
tables for the brand and shows a full-screen "Configuration Required" overlay
when neither has rows. The Serenity prompts UI writes to **Semrush**, not to
local Postgres, so creating prompts there doesn't unblock the gate. To get
past the overlay, seed a minimal V2 prompt row directly:

```bash
psql postgresql://postgres:postgres@localhost:5432/postgres
```

```sql
SET session_replication_role = 'replica';

-- A topic in the Photoshop category (BP needs at least one V2 prompt to
-- consider the brand "configured"; the topic is its parent row).
INSERT INTO topics (id, organization_id, name, status)
VALUES (
  '55555555-5555-4555-b555-555555555555',
  '160da889-39a2-4019-9315-82bbd4da59e7',
  'Photo editing basics',
  'active'
) ON CONFLICT DO NOTHING;

INSERT INTO topic_categories (id, topic_id, category_id)
VALUES (
  gen_random_uuid(),
  '55555555-5555-4555-b555-555555555555',
  '44444444-4444-4444-b444-444444444444'
) ON CONFLICT DO NOTHING;

INSERT INTO prompts (
  id, organization_id, brand_id, category_id, topic_id,
  prompt, language, regions, status, origin, source
) VALUES (
  '66666666-6666-4666-b666-666666666666',
  '160da889-39a2-4019-9315-82bbd4da59e7',
  '3e3556f0-6494-4e8f-858f-01f2c358861a',
  '44444444-4444-4444-b444-444444444444',
  '55555555-5555-4555-b555-555555555555',
  'How do I remove a background in Photoshop?',
  'en',
  ARRAY['US'],
  'active',
  'human',
  'manual'
) ON CONFLICT DO NOTHING;

RESET session_replication_role;
```

After this, BP renders. Charts will still be empty because no
`brand_presence_executions` rows exist locally — that's produced by the DRS
audit pipeline which isn't part of this local stack.

> **Why a separate seed?** BP reads from local Postgres (`prompts`,
> `categories`, `topics`, `brand_presence_executions`). The Serenity proxy
> mutates Semrush — they're different data planes. There's no automatic
> mirror today; bridging them is one of the open items in §17.

---

## 16. Status — what's done, what's open

### Done (committed across both PRs)

**Proxy (`spacecat-api-service` #2393)**
- Semrush V2 AIO REST transport with cookie auth, retries-on-401 surfaced.
- Hardcoded matrix `(brandId, category, market, language) → projectId` read
  from `SEMRUSH_PROJECT_MATRIX`. Three live rows today: Acrobat / Photoshop /
  Adobe at US/US/JP, en/en/ja.
- CRUD handlers with full pagination, base64url logical ids, multi-tag
  `topics: string[]` input, project auto-publish after every mutation.
- `/serenity/projects` endpoint exposing matrix rows + derived facets
  (categories, regions, languages) so the UI doesn't have to know the matrix.

**UI (`project-elmo-ui` #1735)**
- Prompts Management page — list/create/edit/delete against Semrush via the
  proxy, with matrix-driven filters that cross-narrow to valid combinations.
- Create/Edit dialog — pickers source options from `/serenity/projects`
  facets; Topics multi-select keyed off the project's existing tags;
  pre-pinning of the just-saved Category/Market/Language after Track →
  Confirm hops to this page.
- Pagination footer (50/100/200/500 rows), Tags column, bulk-delete.
- Tracking Recommendations dashboard — Track-all and per-row Track both feed
  the same Serenity dialog (`POST /serenity/prompts`) with one prompt per
  hand-curated snapshot row, tagged with the topic name. Markets / Language
  pickers narrow off the matrix. Category is the anchor picker.
- LaunchDarkly local override via `LD_FLAG_OVERRIDES` that survives
  `ldClient.identify()` (real override, not just bootstrap).
- Webpack-dev-server overlay filter for the harmless `ResizeObserver loop`
  runtime warning.

### Open

1. **Brand Presence filters → Semrush-aware** *(next)*
   - Drop the legacy `selectedProject` filter from `brand-presence` and
     `brand-presence-pg` in `src/constants/dashboards.tsx`.
   - Add three new filter types — `SEMRUSH_CATEGORY`, `SEMRUSH_MARKET`,
     `SEMRUSH_LANGUAGE` — to `src/constants/filters.ts`. Each `loadOptions`
     reads matrix data via `listSerenityProjects(orgId, brandId)` (load once
     at dashboard level, push into the filter store's `rawData` channel so
     the existing pattern keeps working).
   - Cross-narrow the three options against each other with `dependsOn` so
     only combinations that map to a real Semrush project are selectable
     (same pattern the Prompts Management filters already use client-side).
   - Derive a `semrushProjectId` from the three values and thread it down to
     the BP widgets so the data fetch can target the right Semrush project.
     This is the heavy bit — every widget data hook currently keys off
     `selectedSite`/`selectedBrand`, none look at a Semrush projectId yet.
   - Considered: a small `useSemrushProjectFromMatrix(orgId, brandId,
     filters)` hook that the BP page header sets and pushes via context to
     the widgets below.

2. **Mirror Serenity prompts into the local Postgres `prompts` table**
   - Today the Serenity proxy only writes to Semrush. BP and the legacy
     v2-prompts surfaces read from Postgres. Creating prompts in the
     Serenity UI leaves BP gated by "Configuration Required" until you
     hand-seed (§15) — and even then the rows aren't tied to the Semrush
     project.
   - Plan: on `POST /serenity/prompts` success, the proxy upserts a matching
     V2 prompt row into Postgres (one per (matrix project × prompt text)).
     Same on PATCH / bulk-delete. Treat Semrush as the source of truth;
     Postgres becomes a denormalized projection used only for BP reads.
   - Need to confirm with data team whether the BP pipeline can backfill
     execution rows for prompts not seeded via the DRS path.

3. **Wire SR AI Visibility prompts list (currently 404 on local proxy)**
   - `/llmo/ai-visibility/brands/prompts` returns 404 locally because that
     route lives in a different service. The Tracking Recommendations card
     reports "0 prompts will be added" until the hand-curated snapshot is in
     place (since 2026-05-12; pulled into this branch already).
   - When the SR backend is wired, the snapshot fallback in
     `SRTrackingRecommendationsDashboard.tsx` falls back to live data
     automatically — no further UI work needed.

4. **Per-row workspace override in the matrix schema**
   - The matrix carries one top-level `workspaceId`. If you add a Semrush
     project in a different workspace, the matrix won't accept it. Easy to
     add `row.workspaceId` with the top-level as default.

5. **Polish**
   - The legacy `SRTrackTopicToPromptsDialog.tsx` is no longer rendered
     (per-row Track was rerouted to the bulk dialog) but still in the tree.
     Safe to delete in a cleanup commit.

---

## 17. Tearing it all down

```bash
cd spacecat-api-service
docker compose -f test/it/postgres/docker-compose.yml down -v   # wipe DB
# Ctrl+C the npm starts in both repos
```
