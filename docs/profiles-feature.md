# Profiles (AI Profile Builder) — Setup & Architecture

This document explains the **AI Profile Builder** feature end to end: the local
setup for both services, how the api-service talks to the mysticat data service,
and the request/design flow — so a new developer can run and extend it.

> **Status:** Local demo / prototype. A few things are intentionally hardcoded
> for the demo (called out inline with `TEMP`). Read the [Demo shortcuts](#demo-shortcuts-to-productionize)
> section before shipping.

---

## 1. What this feature does

A customer types a free-form request on the ASO UI **Profiles** page, e.g.:

> "create a profile using invalid meta tags and broken backlinks"

The backend:

1. Loads that site's real **opportunities**.
2. Asks **Claude** (Amazon Bedrock, Fable 5) to pick **up to 2 renderable
   components** from a fixed catalog and fill them from the opportunity data.
3. Validates and **persists** the resulting profile to Postgres.
4. Returns the profile; the UI shows it and lets the user open a detail page.

A **profile** is a saved, goal-oriented view: `{ name, rationale, components[],
opportunityIds[] }` scoped to a `siteId`.

---

## 2. The three repos involved

| Repo | Role | Port (local) |
|------|------|------|
| `experience-success-studio-ui` | React SPA — the Profiles page, chat box, profile detail page | `9080` (webpack dev server) |
| `spacecat-api-service` | API — the `/profiles` endpoints, Claude call, persistence | `3004` |
| `mysticat-data-service` | PostgreSQL + PostgREST — owns the `profiles` table + migrations | `3000` (PostgREST), `5432` (Postgres) |

```
Browser (9080)                    api-service (3004)                mysticat (PostgREST 3000 -> Postgres 5432)
──────────────                    ──────────────────                ───────────────────────────────────────
Profiles page  ── /chat-local ──▶ POST /sites/:siteId/profiles/chat
  (chat box)      (webpack proxy)   1. dataAccess.Opportunity.allBySiteId  ──▶  opportunities table
                                    2. Claude (Bedrock Converse)  ──▶  (external) Bedrock
                                    3. postgrestClient.from('profiles')  ──▶  profiles table (INSERT)
                                  ◀── { profileId, components, ... }
ProfilePage    ── /chat-local ──▶ GET /sites/:siteId/profiles/:profileId  ──▶  profiles table (SELECT)
```

---

## 3. Initial setup

### 3.1 mysticat-data-service (database + PostgREST)

Stack: PostgreSQL 16 + PostgREST 14 + dbmate (migrations), run via Docker.

```bash
cd mysticat-data-service

make setup     # start Docker services, run migrations, seed data
# or individually:
make up        # start Postgres + PostgREST + Swagger
make migrate   # apply pending migrations (creates the profiles table)
```

Verify PostgREST is serving the `profiles` table:

```bash
curl -s http://localhost:3000/profiles?limit=1   # -> [] with HTTP 200
```

> **After any schema change**, PostgREST must reload its cache:
> `docker compose -f docker/docker-compose.yml restart postgrest`

Useful targets: `make db-shell` (psql), `make migrate-status`, `make migrate-rollback`, `make lint`.

### 3.2 spacecat-api-service (API)

Node ≥ 24. Runs locally via `npm start` → `test/dev/server.mjs`
(`@adobe/helix-universal-devserver`), serving plain HTTP on `PORT`.

Required `.env` entries for this feature:

```bash
PORT=3004
SKIP_AUTH=true                      # local-only: injects a mock admin identity (see src/index.js SkipAuthHandler)

# Data service (mysticat) — the postgrestClient is built from these
DATA_SERVICE_PROVIDER=postgres
POSTGREST_URL=http://localhost:3000

# Claude via Amazon Bedrock (Converse API). Leave BEDROCK_API_KEY empty and the
# profile builder returns null -> the endpoint responds 503 (no profile made).
BEDROCK_API_KEY=
BEDROCK_ENDPOINT=
BEDROCK_MODEL_ID=
BEDROCK_REGION=
```

```bash
cd spacecat-api-service
npm start                           # http://localhost:3004
curl -s http://localhost:3004/sites # sanity check (200)
```

### 3.3 experience-success-studio-ui (SPA)

The UI reaches the api-service through a **same-origin webpack proxy** (avoids
CORS / mixed-content and needs no auth token locally). Defined in
`webpack.dev.config.js`:

```js
proxy: [
  { context: ['/chat-local'], target: 'http://localhost:3004',
    pathRewrite: { '^/chat-local': '' }, changeOrigin: true, secure: false },
]
```

So the browser calls `https://localhost.corp.adobe.com:9080/chat-local/...`
and webpack forwards to `http://localhost:3004/...`.

```bash
cd experience-success-studio-ui
yarn start                          # restart required after proxy config changes
```

---

## 4. How api-service integrates with mysticat

The api-service does **not** hit PostgREST with raw `fetch`. It uses the shared
`postgrestClient` (a `@supabase/postgrest-js` client) that
`spacecat-shared-data-access` builds from `POSTGREST_URL` and exposes at:

```js
context.dataAccess.services.postgrestClient   // .from('table').select()/.insert()/...
```

This is the established pattern across the api-service (feature-flags, brands,
etc.). The `profiles` storage layer follows it — see
`src/support/profiles-storage.js`.

Two data paths are used:

| Data | Access | Where |
|------|--------|-------|
| **Opportunities** (read) | ElectroDB model: `dataAccess.Opportunity.allBySiteId(siteId)` | existing spacecat model |
| **Profiles** (read/write) | `postgrestClient.from('profiles')` | the new table in mysticat |

Both point at the **same** local Postgres (mysticat), so the `profiles` table
lives alongside `opportunities`, `sites`, etc.

---

## 5. Data model — `profiles` table

Migration: `mysticat-data-service/db/migrations/20260706051609_profiles.sql`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK (`uuid_generate_v7()`) | the profile id |
| `site_id` | uuid FK → `sites(id)` ON DELETE CASCADE | which site |
| `name` | text | human name (from the request) |
| `rationale` | text | Claude's explanation |
| `components` | jsonb | `ProfileComponentSpec[]` — exactly what the UI renders |
| `opportunity_ids` | uuid[] | the real opportunities the profile was built from |
| `created_at` / `updated_at` | timestamptz | `updated_at` auto-maintained by trigger |
| `created_by` | text | defaults `system` |

Grants follow the repo convention: `postgrest_anon` gets `SELECT, INSERT`;
`postgrest_writer` gets `UPDATE, DELETE`. (That is why an unauthenticated
`DELETE` returns 401 — mutations need the writer role.)

**Why `components` is denormalized JSON:** the profile detail page renders the
stored components directly, without re-querying or re-deriving from
opportunities. `opportunity_ids` keeps the link back to source truth.

---

## 6. Backend code map (spacecat-api-service)

| File | Responsibility |
|------|----------------|
| `src/controllers/profiles.js` | The 3 handlers: `createFromChat`, `list`, `getById` |
| `src/support/profile-builder.js` | Component **catalog**, the Bedrock (Claude) call, and **validation** of the LLM output |
| `src/support/profiles-storage.js` | PostgREST persistence (`createProfile`, `getProfileById`, `listProfilesBySite`) + row↔API mapping |
| `src/index.js` | Instantiates `ProfilesController` and passes it to `getRouteHandlers` |
| `src/routes/index.js` | Registers the routes |

### Endpoints

```
POST /sites/:siteId/profiles/chat   { message }   -> 201 { profileId, name, components, opportunityIds, reply }
GET  /sites/:siteId/profiles                       -> 200 [ profile, ... ]
GET  /sites/:siteId/profiles/:profileId            -> 200 profile | 404
```

### The component catalog (the key contract)

Claude has **no knowledge of the UI** unless we tell it. `profile-builder.js`
holds `COMPONENT_CATALOG` — the list of renderable component `id`s and their
`data` shapes. This **must stay in sync** with the UI's `RenderedComponent`
switch in:

```
experience-success-studio-ui/src/dx-excshell-1/web-src/src/pages/Profiles/ProfilePage/ProfilePage.tsx
```

The catalog is sent to Claude in the system prompt so it knows the exact menu of
components it may emit. After Claude responds, `validateProfileSpec` rejects any
unknown component id, caps at 2 components, and filters `opportunityIds` to the
ones we actually fetched.

---

## 7. The request flow (create a profile)

`POST /sites/:siteId/profiles/chat` with `{ message }`:

1. **Validate** — `message` is required (400 otherwise).
2. **Load site + opportunities** — `Site.findById`, `Opportunity.allBySiteId`.
   - No site → 404. No opportunities at all → **404** ("no opportunities to
     build from").
3. **Ask Claude** (`selectComponentsWithClaude`) — send the request + the
   candidate opportunities (`id`, `type`, `title`, `data`) + the component
   catalog. Claude returns `{ name, rationale, components, opportunityIds, reply }`.
   - Bedrock not configured / call failed → **503**.
4. **Validate** (`validateProfileSpec`) — against the catalog and the real
   opportunity ids.
   - Nothing usable survived (e.g. none of the site's opportunities match the
     request) → **404** ("no matching opportunities").
5. **Persist** (`createProfile` → `postgrestClient.from('profiles').insert`).
6. **Return** `201 { ...profile, reply }`.

### Status-code cheat sheet

| Situation | Status |
|-----------|--------|
| Missing `message` | 400 |
| Site not found | 404 |
| Site has zero opportunities | 404 |
| Opportunities exist but none match the request | 404 |
| Bedrock unavailable / errored | 503 |
| Success | 201 |

---

## 8. Frontend code map (experience-success-studio-ui)

| File | Responsibility |
|------|----------------|
| `components/molecules/ProfileBuilderChat/ProfileBuilderChat.tsx` | The chat box on the Profiles page; creates a profile, shows the reply + "Open profile" |
| `components/molecules/ProfileBuilderChat/SavedProfilesList.tsx` | "Your profiles" list on the Profiles page |
| `components/molecules/ProfileBuilderChat/profileBuilderChat.service.ts` | `fetch` wrappers hitting `/chat-local/...` (create, list) |
| `pages/Profiles/ProfilesListingPage/ProfilesListingPage.tsx` | Renders the chat + saved list above the static cards |
| `pages/Profiles/ProfilePage/ProfilePage.tsx` | Detail page — renders the stored `components` |
| `store/thunks/profiles.ts` → `fetchProfileById` | Fetches a persisted profile by id and maps it to `ProfileSpec` |

The UI calls the api-service via the `/chat-local` proxy prefix — **not** the
normal `SPACECAT_API_BASE_URL` used by the rest of the app.

---

## 9. Demo shortcuts (to productionize)

These are marked `TEMP` in the code:

1. **Hardcoded demo site.** `DEMO_SITE_ID` (bd.com) is hardcoded in
   `ProfileBuilderChat.tsx`, `ProfilePage.tsx`, and passed to `SavedProfilesList`
   because it's the only locally-seeded site with opportunities. **Data
   operations** use the demo site; **URL navigation** uses the route's real
   `siteId` (the Experience Cloud shell rejects an unknown site in the URL).
   Remove `DEMO_SITE_ID` and use the route `siteId` once real sites have
   opportunities.
2. **`/chat-local` proxy** is dev-only. Production needs a real routed path +
   auth (the endpoints currently rely on `SKIP_AUTH=true`).
3. **Auth.** All `/profiles` endpoints run behind `SKIP_AUTH` locally. In
   deployed environments they go through the standard IMS/JWT auth wrapper.
4. **Profile refinement chat** (`ProfileChatPanel` on the detail page) still
   points at older mock data, not the new backend.
5. **Opportunities table** on the detail page is a static placeholder — it does
   not yet render the real linked `opportunityIds`.

---

## 10. Verifying end to end (curl)

Use a site that has opportunities (locally, bd.com =
`aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa`, seeded with `alt-text`, `meta-tags`,
`broken-backlinks`).

```bash
SITE=aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa

# create
curl -s -X POST "http://localhost:3004/sites/$SITE/profiles/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"create a profile using invalid meta tags and broken backlinks"}'

# list
curl -s "http://localhost:3004/sites/$SITE/profiles"

# fetch one (use a profileId from create/list)
curl -s "http://localhost:3004/sites/$SITE/profiles/<profileId>"
```

In the browser: start all three services, open the Profiles page, type a
request, Send, then click **Open profile**.
