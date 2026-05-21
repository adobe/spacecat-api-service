# Semrush proxy + onboarding — implementation plan

**Status:** draft plan; code lands on this branch in follow-up commits
**Base branch:** `origin/main` (replaces the prior plan that stacked on `feat/prompts-management`)
**Working branch (all four repos):** `feat/semrush-proxy`
**Worktree session:** `/Users/rfriederich/dev/mysticat-workspace/.worktrees/feat-semrush-proxy`

PRs (planned):
- `adobe/mysticat-data-service` — `brand_to_semrush_projects` table + RPC + grants
- `adobe/spacecat-shared` — `BrandToSemrushProject` entity on `spacecat-shared-data-access` (optional; PostgREST raw fallback if not ready)
- `adobe/spacecat-api-service#2451` — this plan + code (rebased onto `main`)

Supersedes:
- `docs/plans/2026-05-20-adobe-hackathon-semrush-proxy.md` (on `feat/adobe-hackathon-semrush-proxy`)

Cross-repo design doc reference: `adobe-rnd/llmo-data-retrieval-service` PR #1779, §3.1–§3.6.

---

## What changes vs the prior plan

| Decision | Prior plan | This plan |
|---|---|---|
| Base branch | `feat/prompts-management` (stacked) | `origin/main` — port only the Semrush proxy pieces we need |
| Auth modes | IMS bearer + `SEMRUSH_COOKIE` fallback | **IMS bearer only.** Drop cookie path entirely. |
| Upstream host | `www.semrush.com` (with cookie shim) | `adobe-hackathon.semrush.com` (server-side IMS → Semrush exchange) |
| Workspace mapping | `organizations.semrush_workspace_id` (DB) | unchanged — `organizations.semrush_workspace_id` (DB) |
| Project mapping | `SEMRUSH_PROJECT_MATRIX` env JSON | **`brand_to_semrush_projects` DB table on `mysticat-data-service`** |
| URL namespace | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/*` | `/v2/orgs/:spaceCatId/brands/:brandId/semrush/*` |
| Reporting endpoint | `POST /serenity/reporting/elements/:elementId` | **dropped** — unused, different upstream (Apikey), separate feature |
| `visibility-filters` / `visibility-response-normalize` | brought along (part of gRPC bridge) | **not in scope** — those belong to the `/apis/serenity/v1/ai-visibility/*` gRPC bridge feature, untouched |
| OpenAPI | bullet in scope list | **first-class deliverable** — new `docs/openapi/semrush-api.yaml`, generated TS types, swagger-driven contract tests |
| Cross-repo work | api-service only | api-service + **mysticat-data-service** (table + RPC) + optional spacecat-shared entity |

---

## Scope

### In scope

Endpoints under `/v2/orgs/:spaceCatId/brands/:brandId/semrush/*` on `spacecat-api-service`:

| Method | Path | Status |
|---|---|---|
| `GET` | `/prompts` | new (port from `feat/prompts-management`) |
| `POST` | `/prompts` | new (port) |
| `PATCH` | `/prompts/:promptId` | new (port) |
| `POST` | `/prompts/bulk-delete` | new (port) |
| `GET` | `/projects` | new (port) |
| `GET` | `/projects/:workspaceId/:projectId/tags` | new (port) |
| `GET` | `/projects/:workspaceId/:projectId/models` | new (port) |
| `GET` | `/workspaces/:workspaceId/projects` | new (port) |
| `POST` | `/projects` | **new (this plan)** — onboarding a `(brand, market, language)` slice |

Cross-repo:

- **`mysticat-data-service`:** new `brand_to_semrush_projects` table + indices + grants. Optional helper RPC for the proxy's `(brand_id, market, language)` upsert path on `POST /semrush/projects`.
- **`spacecat-shared` (optional, parallel):** `BrandToSemrushProject` electroDB entity on `spacecat-shared-data-access`. If it doesn't ship in time, the proxy falls back to `context.dataAccess.services.postgrestClient` raw reads/writes; the swap is a follow-up commit.

OpenAPI / contract tests:

- New `docs/openapi/semrush-api.yaml` describing all 9 endpoints with request/response schemas, examples, and `security: [{ ims_key: [] }]`.
- Wire into `docs/openapi/api.yaml` `paths:` block and `redocly-config.yaml`.
- Add `openapi-typescript` dev-dep + `npm run gen:types:semrush` script that emits `src/support/semrush/generated/api.d.ts` and `src/support/semrush/generated/semrush-upstream.d.ts` (the latter from Semrush's `public_swagger.json`).
- Contract tests: `test/openapi-contract/semrush-api.test.js` walks every route registered under `/semrush/*`, fires a stubbed request, and validates the response body against the operation's `responses['200'].content['application/json'].schema` using AJV.

### Out of scope (separate PRs / follow-ups)

- Family-aware tag demux (`category:` / `topic:` / `intent:` / `branded:` / `source:` prefixes) — cross-repo design §3.3.1
- Site-cohort allow-list (`SERENITY_SITE_ALLOWLIST`) and `serenityEnabled` bit on site-load response — §4.4
- `Idempotency-Key` + `§6c` error envelope alignment — §3.4
- Brand Presence reporting endpoints (`/serenity/reporting/*`) — different upstream auth (Apikey), separate feature
- gRPC bridge under `/apis/serenity/v1/ai-visibility/*` — untouched, lives behind `controllers/serenity.js` (separate plan/PR)
- Retry sweeper for failed Semrush project creates — §3.1 mentions `retry_count`, `next_retry_at`; not modelled in the proxy yet (table includes the columns for a future worker)
- Removing the env-driven `SEMRUSH_PROJECT_MATRIX` fallback entirely — kept as escape hatch for the first dev/CI cohort until the DB table is populated for adobe.com

---

## Architecture — request flow

```
Client (Elmo)
  │  Authorization: Bearer <IMS user token>
  │  e.g. GET /v2/orgs/{spaceCatId}/brands/{brandId}/semrush/prompts
  ▼
spacecat-api-service
  │  1. authWrapper validates IMS bearer (existing AdobeImsHandler / JwtHandler)
  │  2. routeRequiredCapabilities enforces organization:read|write
  │  3. controller extracts IMS bearer via getImsUserToken(ctx)            (existing util)
  │  4. resolveWorkspaceId(ctx, spaceCatId)                                (new)
  │       → dataAccess.Organization.findById(spaceCatId).getSemrushWorkspaceId()
  │       → 5-min in-memory LRU cache keyed by spaceCatId
  │       → 404 if null
  │  5. resolveProjects(ctx, brandId, filter)                              (new)
  │       → reads brand_to_semrush_projects via postgrestClient
  │         (or BrandToSemrushProject electroDB entity if shipped)
  │       → returns rows {projectId, market, language, category, status}
  │  6. forward to adobe-hackathon.semrush.com                             (new transport)
  │       Authorization: Bearer <IMS user token>   (forwarded as-is)
  ▼
adobe-hackathon.semrush.com
  │  exchanges IMS → Semrush token server-side; maps user; forwards        (Semrush proxy)
  ▼
Semrush AIO backend
```

### Why two-tier (workspace from `organizations`, projects from `brand_to_semrush_projects`)

- **Workspace** is durable and org-level (one Semrush workspace per Adobe org; onboarded one-time when Semrush provisions the workspace). Lives on `organizations.semrush_workspace_id` (already shipped, migration `20260525000000`).
- **Projects** churn weekly per brand × market × language as customers onboard new locales. Lives on a junction table keyed by brand. `POST /semrush/projects` is the write path; `GET /semrush/projects` reads it.

### IMS token forwarding

No new mechanism required. The pattern already exists in this repo (`src/support/utils.js#getImsUserToken`):

```js
// src/support/utils.js (existing)
export function getImsUserToken(context) {
  const authorizationHeader = context.pathInfo?.headers?.authorization;
  if (!hasText(authorizationHeader) || !authorizationHeader.startsWith('Bearer ')) {
    throw new ErrorWithStatusCode('Missing Authorization header', STATUS_BAD_REQUEST);
  }
  return authorizationHeader.substring('Bearer '.length);
}
```

The Semrush transport accepts the token as a constructor arg and emits `Authorization: Bearer ${imsToken}` on outbound calls. Inbound auth is already validated by the global `authWrapper` chain (`AdobeImsHandler` / `JwtHandler`) before the controller runs, so we don't re-validate — we only re-encode.

Reference patterns for the same shape:
- `src/controllers/brands.js:176` — `getImsUserToken(context)` → forwards as `Bearer ${imsUserToken}` to `BrandClient.getBrandsForOrganization`
- `src/support/aem-content-api.js:96` — same pattern for AEM Content API calls

`spacecat-auth-service` does **not** need changes for this plan — it owns IMS token validation infrastructure, but inbound validation already happens via the `authWrapper` chain in api-service, and outbound bearer forwarding is a per-controller concern.

---

## Endpoint contracts

All paths under `/v2/orgs/:spaceCatId/brands/:brandId/semrush`. All require `Authorization: Bearer <IMS>`. All return:

- `400` if the IMS bearer is missing
- `404` if the org has no `semrush_workspace_id`
- `404` if the brand has no rows in `brand_to_semrush_projects` (except `POST /projects` — that's the write path)
- `502` if Semrush returns a non-2xx (envelope: `{ error: 'semrushUpstreamError', status, message, body }`)
- `503` if neither the matrix env JSON nor the DB has data (only during the env-fallback phase)

### `GET /prompts`

- Query: `?page=1&limit=50&search=&category=&region=&language=`
- Behaviour: list `brand_to_semrush_projects` rows for `brandId`, filter by `category/region/language` if provided, fan out `POST .../aio/prompts/by_tags` per project, merge + paginate
- Response: `{ items: [{logicalId, semrushId, projectId, text, tags, category, market, language, ...}], total, page, limit }`
- Notes: `logicalId` is `base64url(JSON({b: brandId, c: category, l: language, t: text}))` — stable across regions

### `POST /prompts`

- Body: `{ prompts: [{text, tags: [], category, topic, intent, market, language}] }`
- Behaviour: group by `(category, market, language)`, lookup `projectId` from the table per group, `POST /v2/.../aio/prompts/tagged` + `POST /v1/.../publish` per touched project
- Response: `{ created: [{logicalId, semrushId, projectId, ...}], skipped: [...], failed: [...] }`

### `PATCH /prompts/:promptId`

- `promptId` is the logical id (base64url JSON described above)
- Body: `{ text?, tags?, ... }`
- Behaviour: decode logical id → resolve project from table → `DELETE` old + `POST` new + publish
- Response: `{ id: <new-logicalId>, semrushId, ... }`

### `POST /prompts/bulk-delete`

- Body: `{ semrushIds: [{projectId, promptId}, ...] }`
- Behaviour: group by project, `DELETE /v2/.../aio/prompts` per project, publish per touched project
- Response: `{ deleted: number, failed: [...] }`

### `GET /projects`

- Query: `?category=&market=&language=`
- Behaviour: read `brand_to_semrush_projects` rows for the brand, enrich each row with live Semrush metadata via `listWorkspaceProjects(workspaceId)` (single upstream call, then merged in memory)
- Response: `{ items: [{projectId, workspaceId, name, category, market, language, status, ...}] }`

### `GET /projects/:workspaceId/:projectId/tags`

- Pass-through to Semrush `GET /v1/workspaces/{ws}/projects/{pid}/tags`
- Response: `{ items: [{id, name}] }`

### `GET /projects/:workspaceId/:projectId/models`

- Pass-through to Semrush `GET /v1/workspaces/{ws}/projects/{pid}/ai_models?limit=100`
- Response: `{ models: [{id, key, name, icon}] }` — `key` is the `CBF_model` value the Reporting API expects

### `GET /workspaces/:workspaceId/projects`

- Pass-through to Semrush `GET /v2/workspaces/{ws}/projects?type=AIO&publish_status=live,live_with_unpublished_updates&limit=100`
- Response: `{ projects: [{id, name, domain}] }`

### `POST /projects` — onboarding (new in this plan)

- Body:
  ```json
  {
    "name": "adobe-com · AU · en",
    "category": "Creative Cloud",
    "market": "AU",
    "language": "en",
    "brandDomain": "adobe.com",
    "brandNames": ["Adobe", "Adobe.com"],
    "projectType": "aio"
  }
  ```
- Behaviour:
  1. Resolve `workspaceId` from `org.getSemrushWorkspaceId()` (404 if not onboarded)
  2. `409 Conflict` if `brand_to_semrush_projects` already has a row for `(brandId, category, market, language)` in status `live` or `pending`
  3. Resolve `language_id` (Semrush UUID) — cache `GET /v1/languages` once on boot, 1h TTL
  4. Resolve `location_id` from a static `src/support/semrush/data/locations.json` (ISO 2-letter → Google geo target id) — same map the migration scripts use (`adobe-rnd/llmo-data-retrieval-service` `scripts/serenity/`)
  5. `POST /enterprise/projects/api/v1/workspaces/{ws}/projects` with `{name, type, brand_name_display, brand_names, domain, country_code, location_id, location_name, language_id}` — store the `(workspaceId, brandId, category, market, language, semrushProjectId, status=pending)` row in `brand_to_semrush_projects` **before** the publish call so a publish failure leaves the row in `pending` for the future retry sweeper
  6. `POST /v1/workspaces/{ws}/projects/{pid}/publish` — update the row to `status=live` on success, `status=publish_failed` (with `retry_count` bump + `next_retry_at`) on failure
- Response: `{ workspaceId, projectId, name, status: 'live' | 'pending' | 'publish_failed' }`

---

## `mysticat-data-service` — `brand_to_semrush_projects`

### Migration

`db/migrations/20260528000000_brand_to_semrush_projects.sql`:

```sql
-- migrate:up

-- =============================================================================
-- Table: brand_to_semrush_projects
--
-- Junction between an Adobe brand and a Semrush AIO project. Each row pins
-- a (brand, category, market, language) slice to a Semrush projectId inside
-- the org's workspace (organizations.semrush_workspace_id).
--
-- Read path: spacecat-api-service /v2/orgs/:org/brands/:brand/semrush/*
-- Write path: spacecat-api-service POST /semrush/projects (onboarding)
--             llmo-data-retrieval-service scripts/serenity/* (bulk migration)
--
-- retry_count + next_retry_at + status drive a future Semrush retry sweeper.
-- They are populated on POST /semrush/projects publish failures and consumed
-- by a follow-up worker (not modelled in this PR).
-- =============================================================================

CREATE TYPE brand_to_semrush_status AS ENUM (
    'pending',          -- project create succeeded, publish in flight
    'live',             -- project created + published
    'publish_failed',   -- publish returned non-2xx; sweeper will retry
    'create_failed'     -- create itself failed; row written for retry/audit
);

CREATE TABLE brand_to_semrush_projects (
    id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    brand_id               uuid NOT NULL
        REFERENCES brands (id) ON DELETE CASCADE,
    organization_id        uuid NOT NULL
        REFERENCES organizations (id) ON DELETE CASCADE,
    semrush_workspace_id   text NOT NULL,
    semrush_project_id     text NOT NULL,
    category               text NOT NULL,
    market                 text NOT NULL,
    language               text NOT NULL,
    status                 brand_to_semrush_status NOT NULL DEFAULT 'pending',
    retry_count            integer NOT NULL DEFAULT 0,
    next_retry_at          timestamptz,
    last_error             text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    created_by             text DEFAULT 'system',
    updated_by             text DEFAULT 'system',
    CONSTRAINT uq_brand_to_semrush_slice
        UNIQUE (brand_id, category, market, language),
    CONSTRAINT uq_brand_to_semrush_project
        UNIQUE (semrush_workspace_id, semrush_project_id)
);

CREATE INDEX idx_b2s_brand                ON brand_to_semrush_projects (brand_id);
CREATE INDEX idx_b2s_organization         ON brand_to_semrush_projects (organization_id);
CREATE INDEX idx_b2s_project              ON brand_to_semrush_projects (semrush_project_id);
CREATE INDEX idx_b2s_retry_sweeper        ON brand_to_semrush_projects (status, next_retry_at)
    WHERE status IN ('pending', 'publish_failed', 'create_failed');

GRANT SELECT, INSERT, UPDATE ON brand_to_semrush_projects TO postgrest_writer;
GRANT SELECT ON brand_to_semrush_projects TO postgrest_anon;

COMMENT ON TABLE brand_to_semrush_projects IS
'Junction between Adobe brands and Semrush AIO projects. One row per (brand, category, market, language) slice. Read by spacecat-api-service /v2/orgs/:org/brands/:brand/semrush/*; written by POST /semrush/projects onboarding + migration scripts.';
COMMENT ON COLUMN brand_to_semrush_projects.semrush_workspace_id IS
'Denormalised from organizations.semrush_workspace_id for direct lookups without a join. Must match the org''s current workspace.';
COMMENT ON COLUMN brand_to_semrush_projects.semrush_project_id IS
'Semrush AIO project identifier. UNIQUE across the table — one project can only be bound to one slice.';
COMMENT ON COLUMN brand_to_semrush_projects.status IS
'Lifecycle: pending (create OK, publish in flight) → live (publish OK), or publish_failed / create_failed (sweeper retries via next_retry_at).';
COMMENT ON COLUMN brand_to_semrush_projects.retry_count IS
'Increments on each sweeper retry; sweeper drops the row to a DLQ when it crosses a configured threshold.';

-- updated_at trigger — uses the workspace's existing tg_set_updated_at()
CREATE TRIGGER trg_b2s_set_updated_at
    BEFORE UPDATE ON brand_to_semrush_projects
    FOR EACH ROW
    EXECUTE FUNCTION tg_set_updated_at();

NOTIFY pgrst, 'reload schema';

-- migrate:down

DROP TABLE IF EXISTS brand_to_semrush_projects;
DROP TYPE IF EXISTS brand_to_semrush_status;
```

### Validation gates (per repo `MUST include validation gates`)

- `dbmate up` clean on a fresh dev DB
- `dbmate down` followed by `dbmate up` roundtrips (idempotent)
- `npx mocha tests/...` (or whatever IT runner mysticat-data-service uses) green
- Re-running migration on a populated dev DB does not error
- PostgREST schema reload picks up the new table (visible at `/brand_to_semrush_projects?limit=1`)

### Optional helper RPC (deferred decision)

A `wrpc_b2s_upsert_pending(brand_id, organization_id, ws, pid, category, market, language, created_by)` SECURITY DEFINER function could centralise the "row write then update on publish" path. Defer until the proxy code exists and we know whether two PostgREST round-trips (POST then PATCH) cause issues. For the first PR, simple table CRUD via PostgREST is enough.

---

## `spacecat-shared-data-access` (optional, parallel PR)

If it ships in time, add a `BrandToSemrushProject` entity at `packages/spacecat-shared-data-access/src/models/brand-to-semrush-project/` mirroring the `Organization` entity layout:

- `brand-to-semrush-project.schema.js` — electroDB-style schema mirroring the SQL table
- `index.d.ts` — `getBrandId() / getSemrushProjectId() / setStatus() / ...` getters + `BrandToSemrushProjectCollection.allByBrandId() / findBySemrushProjectId() / ...`

If it does **not** ship in time, the proxy reads/writes via `context.dataAccess.services.postgrestClient` directly (precedent: `src/support/llmo-onboarding-mode.js`). The swap is a single-file follow-up commit.

---

## `spacecat-api-service` — file-by-file change table

| File | Change | Notes |
|---|---|---|
| `src/support/semrush/rest-transport.js` | **NEW.** Semrush HTTP client. Single auth mode: `Authorization: Bearer ${imsToken}`. `DEFAULT_BASE_URL = 'https://adobe-hackathon.semrush.com'`. Methods: `listPromptsByTags`, `createTaggedPrompts`, `deletePromptsByIds`, `publishProject`, `listWorkspaceProjects`, `listAiModels`, `listLanguages`, `createProject`. | Port of `feat/prompts-management`'s `rest-transport.js` minus the cookie/UA branch and base URL change; **adds** `createProject` + `listLanguages`. |
| `src/support/semrush/repository.js` | **NEW.** Data-access layer over `brand_to_semrush_projects`. Exports `listProjectsForBrand(ctx, brandId, filter)`, `resolveProject(ctx, brandId, slice)`, `upsertPendingProject(ctx, row)`, `markProjectStatus(ctx, projectId, status, errorMessage?)`. Uses `BrandToSemrushProject` collection if exposed; else uses `ctx.dataAccess.services.postgrestClient`. | Drop-in replacement for the old `matrix.js` env JSON. Keeps env JSON only as a `bootstrap()` helper that **seeds** the table from `SEMRUSH_PROJECT_MATRIX` if the table is empty for the brand (one-shot dev convenience). |
| `src/support/semrush/workspace-resolver.js` | **NEW.** `resolveWorkspaceId(ctx, spaceCatId)` — calls `ctx.dataAccess.Organization.findById(spaceCatId).getSemrushWorkspaceId()`. 5-min in-memory LRU cache keyed by spaceCatId. Returns `null` if org has no workspace (controller turns that into a 404). | The `getSemrushWorkspaceId()` getter already exists on `@adobe/spacecat-shared-data-access`. |
| `src/support/semrush/handlers/prompts.js` | **NEW.** Port of `feat/prompts-management`'s `handlers/prompts.js`. Accepts a `workspaceId` arg (resolved by the controller) instead of pulling it from the matrix. Uses `repository.listProjectsForBrand` / `repository.resolveProject` instead of the matrix module. Encodes/decodes the same base64url logical id. | ~528 line port, minus matrix-shape changes. |
| `src/support/semrush/handlers/projects.js` | **NEW.** `handleCreateProject(transport, repository, env, {workspaceId, brandId, body, log, actor})` — runs the §5 onboarding flow (resolve language UUID + location_id → POST project → upsert pending row → publish → update row status). | New for this plan. |
| `src/support/semrush/data/locations.json` | **NEW.** ISO 2-letter → `{location_id, location_name}` map. Copy from `llmo-data-retrieval-service/scripts/serenity/locations.json`. | Static, ~250 rows. |
| `src/support/semrush/generated/api.d.ts` | **NEW (generated).** `openapi-typescript` output from `docs/openapi/semrush-api.yaml`. Committed; CI regenerates and diffs. | See OpenAPI section. |
| `src/support/semrush/generated/semrush-upstream.d.ts` | **NEW (generated).** `openapi-typescript` output from Semrush's `public_swagger.json`. Committed; CI regenerates and diffs. | Type-checks `rest-transport.js` request/response shapes during dev via `// @ts-check`. |
| `src/controllers/semrush.js` | **NEW.** `SemrushController(context, log)` — wires `workspace-resolver`, `repository`, `rest-transport` to the 9 route handlers. Each handler: extract IMS bearer (`getImsUserToken`), build transport with the bearer, resolve workspace, delegate to `handlers/prompts.js` or `handlers/projects.js`, map errors. | Port of `feat/prompts-management`'s `controllers/serenity-prompts.js` minus the cookie-fallback branch and the reporting endpoint, plus the new `createProject` handler. |
| `src/routes/index.js` | Register the 9 routes; inject `semrushController` into the route table. | One block, ~10 lines. |
| `src/routes/required-capabilities.js` | Add capability entries: `GET /semrush/prompts → organization:read`, `POST/PATCH/POST-bulk → organization:write`, `GET /semrush/projects* / workspaces* → organization:read`, `POST /semrush/projects → organization:write`. | Mirrors the existing serenity prompt entries. |
| `src/index.js` | Wire `SemrushController` into the controller list passed to `Router`. | One import + one line in the controllers obj. |
| `docs/openapi/api.yaml` | Add `paths:` entries for the 9 `/v2/orgs/{spaceCatId}/brands/{brandId}/semrush/...` routes, each `$ref`-ing into `semrush-api.yaml`. | ~9 lines under `paths:`. |
| `docs/openapi/semrush-api.yaml` | **NEW.** Full spec for the 9 endpoints — `parameters`, `requestBody`, `responses` with reusable `$ref: './schemas.yaml#/SemrushPrompt'` etc. `security: [{ ims_key: [] }]` on every operation. `operationId`s match the controller method names. | Models follow the prompts-v2-api.yaml shape. |
| `docs/openapi/schemas.yaml` | Add `SemrushPrompt`, `SemrushProjectRow`, `SemrushTag`, `SemrushModel`, `SemrushCreateProjectRequest`, `SemrushCreateProjectResponse` schemas. | Reusable, referenced from `semrush-api.yaml`. |
| `package.json` | Add devDep `openapi-typescript`. Add scripts `gen:types:semrush` and `gen:types:semrush:upstream`. Wire `npm test` to also assert the generated `.d.ts` is in sync (`gen:types:* && git diff --exit-code src/support/semrush/generated/`). | Dev-only. |
| `test/support/semrush/rest-transport.test.js` | **NEW.** Nock-driven tests for every transport method. Confirms `Authorization: Bearer ${ims}` (not `Auth-Data-Jwt`), `adobe-hackathon.semrush.com` base URL, request shapes. | Port + adapt. |
| `test/support/semrush/repository.test.js` | **NEW.** Stub `postgrestClient` / `BrandToSemrushProjectCollection`. Cover list / resolve / upsert / status update + the empty-table fallback path. | New. |
| `test/support/semrush/workspace-resolver.test.js` | **NEW.** Cache hits, cache misses, null `semrush_workspace_id`. | New. |
| `test/support/semrush/handlers/prompts.test.js` | **NEW.** Adapted from `feat/prompts-management` tests; pass workspaceId explicitly; switch matrix mocks to repository mocks. | Port. |
| `test/support/semrush/handlers/projects.test.js` | **NEW.** Mock transport + repository; cover happy path, publish failure (row → `publish_failed`), 409 on existing slice. | New. |
| `test/controllers/semrush.test.js` | **NEW.** End-to-end controller tests for each route: 400 on missing IMS bearer, 404 on missing workspace, 404 on empty brand projects, 502 envelope on Semrush 5xx, 200 happy path. | New. |
| `test/openapi-contract/semrush-api.test.js` | **NEW.** Swagger-driven contract tests. Loads `docs/openapi/semrush-api.yaml`, builds AJV validators per operation response schema, drives the controller via supertest-style stubs, asserts every response validates against its declared 2xx schema. | New — this is the "swagger-driven contract tests" deliverable. |
| `test/openapi-contract/types-in-sync.test.js` | **NEW.** Runs `npm run gen:types:semrush` in a temp dir, diffs against the committed `.d.ts`. Fails if drift. | Catches "spec changed but types weren't regenerated". |
| `README.md` (or `docs/semrush.md`) | Document the new env vars, the `getImsUserToken` flow, and the onboarding endpoint. | Operator-facing. |

---

## OpenAPI + TypeScript types + contract tests

### Spec layout (`docs/openapi/semrush-api.yaml`)

```yaml
v2-semrush-prompts:
  parameters:
    - name: spaceCatId
      in: path
      required: true
      schema: { type: string, format: uuid }
    - name: brandId
      in: path
      required: true
      schema: { type: string }
  get:
    operationId: listSemrushPrompts
    security: [{ ims_key: [] }]
    parameters:
      - { name: page,     in: query, schema: { type: integer, minimum: 1, default: 1 } }
      - { name: limit,    in: query, schema: { type: integer, minimum: 1, maximum: 1000, default: 50 } }
      - { name: search,   in: query, schema: { type: string } }
      - { name: category, in: query, schema: { type: string } }
      - { name: region,   in: query, schema: { type: string } }
      - { name: language, in: query, schema: { type: string } }
    responses:
      '200':
        content:
          application/json:
            schema: { $ref: './schemas.yaml#/SemrushPromptListResponse' }
      '400': { $ref: './schemas.yaml#/BadRequest' }
      '404': { $ref: './schemas.yaml#/NotFound' }
      '502': { $ref: './schemas.yaml#/UpstreamError' }

  post:
    operationId: createSemrushPrompts
    # ...

# v2-semrush-prompt-by-id, v2-semrush-prompts-bulk-delete,
# v2-semrush-projects (GET + POST), v2-semrush-project-tags,
# v2-semrush-project-models, v2-semrush-workspace-projects — all follow the same shape
```

Wire into `docs/openapi/api.yaml` `paths:` block:

```yaml
/v2/orgs/{spaceCatId}/brands/{brandId}/semrush/prompts:
  $ref: './semrush-api.yaml#/v2-semrush-prompts'
/v2/orgs/{spaceCatId}/brands/{brandId}/semrush/prompts/{promptId}:
  $ref: './semrush-api.yaml#/v2-semrush-prompt-by-id'
# ... 7 more
```

### Type generation

`package.json`:

```json
{
  "devDependencies": {
    "openapi-typescript": "^7.x"
  },
  "scripts": {
    "gen:types:semrush": "openapi-typescript docs/openapi/api.yaml -o src/support/semrush/generated/api.d.ts --root-types --enum",
    "gen:types:semrush:upstream": "openapi-typescript https://www.semrush.com/path/to/public_swagger.json -o src/support/semrush/generated/semrush-upstream.d.ts --root-types"
  }
}
```

(Exact upstream URL TBD — `adobe-rnd/llmo-data-retrieval-service` `scripts/serenity/` references `public_swagger.json`; we mirror the resolved URL into a `SEMRUSH_OPENAPI_URL` env var with a sane default.)

Generated `.d.ts` files are **committed** so CI doesn't need network access to validate. Drift is caught by `test/openapi-contract/types-in-sync.test.js`.

### Swagger-driven contract tests

`test/openapi-contract/semrush-api.test.js`:

```js
import { describe, it } from 'mocha';
import { expect } from 'chai';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { loadOpenAPISpec, buildResponseValidator } from './_lib/openapi-loader.js'; // ← shared helper
import { stubSemrushTransport, stubDataAccess } from '../support/semrush/_stubs.js';

const spec = await loadOpenAPISpec('docs/openapi/api.yaml');
const ajv = addFormats(new Ajv({ strict: false }));

describe('OpenAPI contract — /v2/orgs/{spaceCatId}/brands/{brandId}/semrush/*', () => {
  for (const op of spec.operationsForTag('semrush')) {
    it(`${op.method.toUpperCase()} ${op.path} 200 response matches schema`, async () => {
      const ctx = stubControllerContext({ /* ... */ });
      const result = await callController(op, ctx);
      const validate = buildResponseValidator(ajv, op, 200);
      expect(validate(JSON.parse(result.body))).to.equal(true, ajv.errorsText());
    });
  }
});
```

The same pattern can be reused for other `*-api.yaml` files later — `_lib/openapi-loader.js` is the long-lived investment.

---

## Dependencies + cross-repo coordination

1. **`mysticat-data-service` migration `20260528000000`** must land + be deployed to `dev` before `spacecat-api-service` code can hit any non-mock environment. Local IT tests use `docker-compose` with `mysticat-data-service:latest` so the migration must be in a published image before `test/it/postgres/semrush-*.test.js` can run.
2. **`@adobe/spacecat-shared-data-access` BrandToSemrushProject entity** is optional. If it ships, the api-service repository module uses it; if not, the api-service repository uses raw PostgREST and a follow-up PR swaps to the entity. Decision deferred until we know the shared-lib release cadence vs the data-service migration cadence.
3. **`Organization.getSemrushWorkspaceId()`** already exists in `@adobe/spacecat-shared-data-access` (verified in this worktree's `node_modules`). No shared-lib change required for workspace resolution.

---

## Implementation order

### Phase 1 — `mysticat-data-service` migration

1. Author `db/migrations/20260528000000_brand_to_semrush_projects.sql`
2. `dbmate up` + `dbmate down` roundtrip locally
3. PostgREST schema reload + `curl http://localhost:3000/brand_to_semrush_projects?limit=1` → 200 empty
4. Open PR; merge; verify dev deploy

**Validation gate:** dev `mysticat-data-service` exposes `brand_to_semrush_projects` via PostgREST and the table is empty.

### Phase 2 — `spacecat-api-service` OpenAPI spec first

1. Author `docs/openapi/semrush-api.yaml` (all 9 endpoints) + schemas
2. Wire into `api.yaml`
3. `npm run docs:lint` clean
4. `npm install openapi-typescript --save-dev`
5. `npm run gen:types:semrush` → commit `src/support/semrush/generated/api.d.ts`
6. `npm run gen:types:semrush:upstream` → commit `src/support/semrush/generated/semrush-upstream.d.ts`

**Validation gate:** `npm run docs:lint && npm run gen:types:semrush && git diff --exit-code` is clean.

### Phase 3 — transport, workspace resolver, repository

1. `src/support/semrush/rest-transport.js` (port + drop cookie/UA + add `createProject` + `listLanguages`)
2. `src/support/semrush/workspace-resolver.js` (use the existing shared-lib getter)
3. `src/support/semrush/repository.js` (PostgREST-first; can be swapped to electroDB later)
4. Tests for all three

**Validation gate:** `npx mocha test/support/semrush/{rest-transport,workspace-resolver,repository}.test.js` green; 100% coverage.

### Phase 4 — handlers + controller + routes

1. `src/support/semrush/handlers/prompts.js` (port + repository swap)
2. `src/support/semrush/handlers/projects.js` (new — onboarding)
3. `src/controllers/semrush.js`
4. `src/routes/index.js` + `src/routes/required-capabilities.js`
5. `src/index.js` controller wiring
6. Controller + handler tests

**Validation gate:** `npx mocha test/controllers/semrush.test.js test/support/semrush/handlers/*.test.js` green.

### Phase 5 — contract tests + docs

1. `test/openapi-contract/semrush-api.test.js`
2. `test/openapi-contract/types-in-sync.test.js`
3. `README.md` / `docs/semrush.md` operator notes

**Validation gate:** full `npm test` green; `npm run docs:lint` clean.

### Phase 6 — end-to-end on dev

1. Onboard one brand via direct `INSERT` into `brand_to_semrush_projects` (mimicking what the migration script will do at scale)
2. `mysticat auth token --env dev` → grab IMS bearer
3. `curl -H "Authorization: Bearer $TOKEN" .../semrush/prompts?limit=5` → expect 200 with list shape
4. `curl -H ... -X POST -d '{prompts:[...]}' .../semrush/prompts` → expect 200 with `semrushId`
5. `curl -H ... -X POST -d '{name,category,market,language,...}' .../semrush/projects` → expect 200 with `{status:'live', projectId}` and a new row in `brand_to_semrush_projects`
6. Non-onboarded org (no `semrush_workspace_id`) → expect 404

**Validation gate:** all 6 dev curls match expected envelope.

---

## Verification

### Unit / integration

- `npx mocha test/support/semrush/**` — green
- `npx mocha test/controllers/semrush.test.js` — green
- `npx mocha test/openapi-contract/**` — green
- `npm run docs:lint` — clean
- `c8` coverage on the new files — 100%

### Outbound shape (nock)

- Recorder confirms outbound `Authorization: Bearer ${imsToken}` header (not `Auth-Data-Jwt`, not `Cookie`)
- Recorder confirms outbound host is `adobe-hackathon.semrush.com`
- Recorder confirms `POST /enterprise/projects/api/v1/workspaces/{ws}/projects` body shape on onboarding

### End-to-end (dev)

- See Phase 6 above
- `coralogix-query --from 1h "source logs | filter $l.applicationname == 'spacecat-services--api-service' && $d.message ~ 'semrush'"` shows the structured proxy logs

---

## Open questions

1. **`@adobe/spacecat-shared-data-access` `BrandToSemrushProject` entity** — ship in time, or PostgREST-first + swap later? Default: PostgREST-first.
2. **Semrush `public_swagger.json` URL** — what's the canonical, fetchable URL for type generation? Cross-repo doc §3.6 references it but doesn't pin a URL.
3. **`POST /semrush/projects` `409 Conflict` semantics** — should a `publish_failed` row block re-onboarding the same slice, or should onboarding clear `publish_failed` and retry? Default: 409 on `live` + `pending`, allow re-onboard on `publish_failed` / `create_failed`.
4. **Migration script (in `llmo-data-retrieval-service`) write target** — does it write directly to the new table via PostgREST, or call `POST /semrush/projects` per row? Direct PostgREST writes are simpler; calling the proxy gets us free integration testing. Default: direct PostgREST for bulk, proxy for one-off onboarding from Elmo.

---

## Follow-up Jira tickets (file after this PR ships)

- Family-aware tag demux (cross-repo §3.3.1)
- Site-cohort allow-list + `serenityEnabled` site-load bit (§4.4)
- `Idempotency-Key` + `§6c` error envelope alignment
- Retry sweeper for `pending` / `publish_failed` / `create_failed` rows in `brand_to_semrush_projects`
- `@adobe/spacecat-shared-data-access` `BrandToSemrushProject` electroDB entity (if PostgREST-first chosen above)
- Swagger-driven contract tests for the other `*-api.yaml` files (extend the `test/openapi-contract/_lib/openapi-loader.js` helper repo-wide)
