# Implementation Plan — Semrush proxy + onboarding (PR adobe/spacecat-api-service#2456)

## Context

`spacecat-api-service` needs a server-side proxy in front of the Semrush AIO API at
`adobe-hackathon.semrush.com` so Elmo can list/create/edit/delete prompts and onboard
new `(brand, market, language)` project slices without ever touching a Semrush user
credential client-side. Auth is IMS-bearer-only: the client sends its IMS user token,
api-service forwards it as `Authorization: Bearer <ims>`, and Semrush exchanges
IMS → Semrush server-side.

The full design is captured in
[`docs/plans/2026-05-21-semrush-proxy-and-onboarding.md`](./2026-05-21-semrush-proxy-and-onboarding.md)
and cross-repo design doc
[adobe-rnd/llmo-data-retrieval-service PR 1779](https://github.com/adobe-rnd/llmo-data-retrieval-service/pull/1779)
(§3.1–§3.6). This file is the **execution plan** that walks the work in order; it
does not restate the design.

Three repos change, all on branch `feat/semrush-proxy`:

1. `mysticat-data-service` — new `brand_to_semrush_projects` table
2. `spacecat-shared` — new `BrandToSemrushProject` PostgREST-backed entity
3. `spacecat-api-service` — proxy controller + routes + 9 endpoints + OpenAPI + contract tests

PR #2456 is open against `main`; this plan tracks the code that lands on
`feat/semrush-proxy` in each repo.

---

## Corrections to the design doc (apply during execution)

Phase-1 exploration turned up four concrete drifts between the design doc's
snippets and the current baseline. Fix these as the corresponding files are
touched — the design doc itself is not edited retroactively.

| # | Where the doc says... | Reality on baseline | Action |
|---|---|---|---|
| 1 | Migration uses `tg_set_updated_at()` | The repo's trigger function is `public.update_updated_at()` (`db/schema.sql:9116`) | Use `update_updated_at()` in the new migration |
| 2 | `GRANT SELECT,INSERT,UPDATE TO postgrest_writer; SELECT TO postgrest_anon` | Convention is `GRANT SELECT,INSERT TO postgrest_anon; GRANT UPDATE,DELETE TO postgrest_writer` (see `db/migrations/20250130000006_opportunities.sql`) | Flip the grant block to match convention |
| 3 | Shared-lib unit tests live at `test/models/brand-to-semrush-project/` | Tests live at `packages/spacecat-shared-data-access/test/unit/models/<entity>/` | Put new tests under `test/unit/models/brand-to-semrush-project/` |
| 4 | Doc implies registering an entity is just `export *` from `models/index.js` | Also requires an `EntityRegistry.registerEntity(BrandToSemrushProjectSchema, BrandToSemrushProjectCollection)` call in `packages/spacecat-shared-data-access/src/models/base/entity.registry.js` (mirror line 212 for `SiteEnrollment`) | Add the registry call in addition to the `index.js` re-export |

Two further items the doc was right about and should not be revisited:

- IMS bearer forwarding does **not** need new infrastructure. Use existing
  `getImsUserToken(context)` in `src/support/utils.js` and forward as
  `Authorization: Bearer ${imsUserToken}` (pattern at `src/controllers/brands.js:176`
  and `src/support/aem-content-api.js:96`).
- `Organization.getSemrushWorkspaceId() / setSemrushWorkspaceId() / findBySemrushWorkspaceId()`
  already exist in `@adobe/spacecat-shared-data-access`, and `semrushWorkspaceId`
  is already surfaced on `GET /organizations/:id` and `PATCH /organizations/:id`
  (`src/dto/organization.js:24` + controller). No shared-lib or admin-endpoint
  work for those.

---

## Phase 1 — mysticat-data-service: `brand_to_semrush_projects` table

### Files to author

- `db/migrations/20260528000000_brand_to_semrush_projects.sql` — body per design
  doc §"mysticat-data-service — brand_to_semrush_projects", with corrections #1
  and #2 applied.

### Things to mirror from existing migrations

- `CREATE TYPE ... AS ENUM` block pattern: see
  `db/migrations/20250130000006_opportunities.sql` (`opportunity_origin`,
  `opportunity_status`).
- FK on-delete behaviour: `ON DELETE CASCADE` on `brand_id` and `organization_id`
  (mirror `brand_aliases_brand_id_fkey` / `brand_aliases_organization_id_fkey`).
- `uuid DEFAULT public.uuid_generate_v7()` PK with `text` (not `varchar`) for
  Semrush IDs (mirror `organizations.semrush_workspace_id` from `20260525000000`).
- `NOTIFY pgrst, 'reload schema';` before the `migrate:down` marker (mirror
  `20260424074521_offsite_pipeline_hardening.sql`).
- `COMMENT ON TABLE` + per-column comments for the OpenAPI doc bot.

### Validation gates

```bash
cd mysticat-data-service
make migrate           # forward
make migrate-rollback  # only the new migration
make migrate           # idempotent re-apply

# PostgREST sees the table
curl -s http://localhost:3000/brand_to_semrush_projects?limit=1 | jq .
# expect: [] (empty array, 200)
```

Then `uv run python scripts/check_function_references.py` (mirrors the CI
Function Reference Check at `.github/workflows/ci.yml:230-281`).

### Done condition

- PR opened against `mysticat-data-service` `main`, CI green (Migration Review
  + Function Reference Check + all tests).
- Merged; api-service waits on dev deploy before Phase 5 IT tests.

---

## Phase 2 — spacecat-shared: `BrandToSemrushProject` entity

Package: `packages/spacecat-shared-data-access`

### Files to author

Mirror the layout of `src/models/site-enrollment/` 1:1:

```
src/models/brand-to-semrush-project/
  brand-to-semrush-project.schema.js     # SchemaBuilder w/ belongs_to Brand + Organization
  brand-to-semrush-project.model.js      # class BrandToSemrushProject extends BaseModel
  brand-to-semrush-project.collection.js # class BrandToSemrushProjectCollection extends BaseCollection
  index.js                               # re-export model + collection + schema
  index.d.ts                             # public TS types

test/unit/models/brand-to-semrush-project/
  brand-to-semrush-project.collection.test.js
  brand-to-semrush-project.model.test.js
```

### Schema shape

- Attributes: `brandId`, `organizationId`, `semrushWorkspaceId`, `semrushProjectId`,
  `category`, `market`, `language`,
  `status` (enum: `pending|live|publish_failed|create_failed`),
  `retryCount`, `nextRetryAt`, `lastError`.
- References: `belongs_to Brand`, `belongs_to Organization`.
- Indices: `byBrandId`, `bySemrushProjectId`, `byStatusAndNextRetryAt`.
  SchemaBuilder auto-generates `allByBrandId()`, `findBySemrushProjectId()`,
  `allByStatusAndNextRetryAt()`.

### Custom collection methods

- `findBySlice(brandId, category, market, language)` — composite lookup used by
  the 409-conflict check in `POST /semrush/projects`.
- `allDueForRetry()` — filters
  `status IN ('pending','publish_failed','create_failed') AND next_retry_at <= now()`,
  for the follow-up retry sweeper.

### Wiring (apply correction #4)

1. `src/models/index.js` — add
   `export * from './brand-to-semrush-project/index.js';`
   (mirror line 37 for `site-enrollment`).
2. `src/models/index.d.ts` — add
   `export type * from './brand-to-semrush-project';` (mirror line 43).
3. `src/models/base/entity.registry.js` — add
   `EntityRegistry.registerEntity(BrandToSemrushProjectSchema, BrandToSemrushProjectCollection);`
   (mirror line 212 for `SiteEnrollment`).

### Tests

Reuse `createElectroMocks(...)` from `test/unit/util.js` (same pattern as
`site-enrollment.collection.test.js`). Cover:
- constructor
- `allByBrandId`, `findBySlice`, `allDueForRetry`
- index-driven `findBySemrushProjectId`
- enum validation on `status`

### Validation gates

```bash
cd spacecat-shared/packages/spacecat-shared-data-access
npm test
npm run lint
```

### Release coordination

- No manual version bump — `semantic-release-monorepo` cuts the version from the
  conventional-commit type on merge to `main`. Commit must be
  `feat(data-access): add BrandToSemrushProject entity` for a minor bump.
- After merge, watch `npm view @adobe/spacecat-shared-data-access version` until
  the new version appears, then bump it in `spacecat-api-service/package.json`
  in Phase 3.

---

## Phase 3 — api-service: OpenAPI spec + generated types

### Files to author / modify

| File | Action |
|---|---|
| `docs/openapi/semrush-api.yaml` | NEW. Operations for all 9 endpoints. `security: [{ ims_key: [] }]` on every op. `operationId`s match controller method names. Mirror `docs/openapi/prompts-v2-api.yaml`. |
| `docs/openapi/schemas.yaml` | Add `SemrushPrompt`, `SemrushPromptListResponse`, `SemrushProjectRow`, `SemrushTag`, `SemrushModel`, `SemrushCreateProjectRequest`, `SemrushCreateProjectResponse`. |
| `docs/openapi/api.yaml` | Add 9 `$ref` entries under `paths:`. |
| `package.json` | Add devDep `openapi-typescript@^7`. Add scripts `gen:types:semrush` + `gen:types:semrush:upstream`. Bump `@adobe/spacecat-shared-data-access`. |
| `src/support/semrush/generated/api.d.ts` | NEW (generated, committed). |
| `src/support/semrush/generated/semrush-upstream.d.ts` | NEW (generated, committed). |

### Validation gates

```bash
cd spacecat-api-service
npm install
npm run docs:lint                       # clean
npm run docs:build                      # produces redoc html
npm run gen:types:semrush               # writes src/support/semrush/generated/api.d.ts
npm run gen:types:semrush:upstream      # writes semrush-upstream.d.ts
git diff --exit-code src/support/semrush/generated/   # no drift after fresh regen
```

This is the first time the repo has `openapi-typescript` or contract-test
infrastructure, so this phase doubles as laying the foundation for other
`*-api.yaml` files later.

---

## Phase 4 — Transport + workspace resolver

### Files to author

| File | Action |
|---|---|
| `src/support/semrush/rest-transport.js` | NEW. Port from `git show origin/feat/prompts-management:src/support/serenity/rest-transport.js` (186 lines), strip cookie / `Auth-Data-Jwt` / User-Agent branching (lines 39-51), change `DEFAULT_BASE_URL` to `'https://adobe-hackathon.semrush.com'`, add `createProject(workspaceId, body)` + `listLanguages()`. Single auth header: `Authorization: Bearer ${imsToken}`. |
| `src/support/semrush/workspace-resolver.js` | NEW. `resolveWorkspaceId(ctx, spaceCatId)` → `ctx.dataAccess.Organization.findById(spaceCatId).getSemrushWorkspaceId()`. 5-min LRU keyed by spaceCatId. Returns `null` for 404. |
| `src/support/semrush/data/locations.json` | NEW. Copy from `llmo-data-retrieval-service/scripts/serenity/locations.json` (ISO 2-letter → `{location_id, location_name}`). |
| `test/support/semrush/rest-transport.test.js` | NEW. Nock-driven. **Critical: outbound `Authorization: Bearer ${imsToken}` — not `Auth-Data-Jwt`, not `Cookie`.** Host = `adobe-hackathon.semrush.com`. |
| `test/support/semrush/workspace-resolver.test.js` | NEW. Cache hit/miss + null-workspace case. |

### Validation gates

```bash
npx mocha test/support/semrush/rest-transport.test.js test/support/semrush/workspace-resolver.test.js
```

100% line + branch coverage on both new files.

---

## Phase 5 — Handlers + controller + routes

### Files to author

| File | Action |
|---|---|
| `src/support/semrush/handlers/prompts.js` | NEW. Port from `feat/prompts-management:src/support/serenity/handlers/prompts.js`. Replace `resolveProject` / `listProjectsForBrand` / `resolveProjectsForPrompt` calls with `ctx.dataAccess.BrandToSemrushProject.allByBrandId(brandId)` + in-memory filter on `(category, market, language)`. Keep `encodeLogicalId` / `decodeLogicalId` verbatim. Drop `matrix.js`. Accept `workspaceId` as explicit arg. |
| `src/support/semrush/handlers/projects.js` | NEW. Onboarding per design doc — language UUID cache (1h TTL) + location_id from `locations.json` → upstream `POST /enterprise/projects/api/v1/workspaces/{ws}/projects` → write `pending` row → publish → row → `live` (or `publish_failed`). |
| `src/controllers/semrush.js` | NEW. Factory `SemrushController(ctx, log, env)`. 9 handlers. Each: `getImsUserToken(ctx)` → build transport → `resolveWorkspaceId` → delegate. Use **shared** `getImsUserToken` (throws), not the local `getImsToken` from prompts-management. |
| `src/routes/index.js` | 9 entries: `'<METHOD> /v2/orgs/:spaceCatId/brands/:brandId/semrush/<path>': semrushController.<method>`. |
| `src/routes/required-capabilities.js` | Reads → `organization:read`, writes → `organization:write`. |
| `src/index.js` | Instantiate `SemrushController(context, log, env)` per request. Pass as positional arg to `getRouteHandlers(...)`. |
| `test/support/semrush/handlers/prompts.test.js` | NEW. Replace `matrix` stubs with `dataAccess.BrandToSemrushProject` stubs. |
| `test/support/semrush/handlers/projects.test.js` | NEW. Happy path; `publish_failed` row write on upstream 5xx; 409 on existing slice (`live`/`pending`); retry-allowed on `publish_failed`/`create_failed`. |
| `test/controllers/semrush.test.js` | NEW. Per route: 400 / 404 / 502 / 200 envelope checks. |

### Validation gates

```bash
npx mocha test/controllers/semrush.test.js test/support/semrush/handlers/*.test.js
npm run lint
```

---

## Phase 6 — Contract tests + docs

### Files to author

| File | Action |
|---|---|
| `test/openapi-contract/_lib/openapi-loader.js` | NEW shared helper. Loads `docs/openapi/api.yaml`, resolves `$ref`s, exposes `operationsForTag('semrush')` + `buildResponseValidator(ajv, op, status)`. First contract-test infrastructure in the repo — long-lived asset. |
| `test/openapi-contract/semrush-api.test.js` | NEW. AJV-validates every 2xx response against schema. |
| `test/openapi-contract/types-in-sync.test.js` | NEW. Runs `npm run gen:types:semrush` into a temp dir, diffs against committed `.d.ts`. |
| `docs/semrush.md` | NEW. Operator-facing: env vars (none new), `getImsUserToken` flow, onboarding endpoint, how to set `semrushWorkspaceId`. |

### Validation gates

```bash
npx mocha test/openapi-contract/**/*.test.js
npm test                 # full suite green
npm run docs:lint        # OpenAPI clean
```

---

## Phase 7 — Dev environment end-to-end smoke tests

Execute the 7 smoke tests in design doc §"Testing plan → Dev environment end-to-end"
against `https://spacecat.experiencecloud.live/api/ci/`. Prerequisites:

1. Pick a dev org with `semrush_workspace_id` set via the existing admin
   `PATCH /organizations/:id` (PR #2403). Use either a dedicated dev workspace
   or `c522f571-76e9-42e5-9213-7a767f448453` (the adobe.com migration workspace).
2. Pick a brand under that org.
3. `IMS=$(mysticat auth token --env dev)`.

Then the Coralogix observability check:

```bash
coralogix-query --from 30m \
  "source logs | filter \$l.applicationname == 'spacecat-services--api-service' && \$l.subsystemname == 'semrush' | limit 50"
```

Should show outbound `Authorization: Bearer ...`, host `adobe-hackathon.semrush.com`,
and the IMS sub of the caller in the structured-log `actor` field.

---

## Cross-repo ordering / dependency chain

```
Phase 1 (mysticat-data-service migration) → merged + dev deployed
   ▼
Phase 2 (spacecat-shared entity) → merged + npm version published
   ▼
Phase 3–6 (spacecat-api-service) on feat/semrush-proxy:
   3 (OpenAPI + types) ─► 4 (transport) ─► 5 (handlers/controller/routes) ─► 6 (contract tests + docs)
   ▼
PR #2456 review → merge → dev deploy
   ▼
Phase 7 (smoke tests on dev)
```

---

## Verification matrix

| Layer | How verified | Phase |
|---|---|---|
| DB schema | `make migrate; make migrate-rollback; make migrate` clean; PostgREST sees the table | 1 |
| Shared-lib | `BrandToSemrushProject` unit tests green; `npm view` shows new version | 2 |
| OpenAPI | `npm run docs:lint`; `npm run docs:build`; `git diff` clean after type regen | 3 |
| HTTP transport | Nock asserts outbound `Authorization: Bearer ...` (no cookie / `Auth-Data-Jwt`); host `adobe-hackathon.semrush.com` | 4 |
| Workspace resolution | LRU hit/miss + null-workspace 404 unit tests | 4 |
| Handlers | 9 route handlers, 5 controller error codes (400/404/409/502/200) per route | 5 |
| Contract validation | AJV walks all 9 ops, response schemas verified end-to-end | 6 |
| Type drift | `types-in-sync.test.js` re-generates and diffs in CI | 6 |
| Dev smoke | 7 curl smoke tests + Coralogix observability check | 7 |

---

## Files not in scope

- `src/support/serenity/*` and `src/controllers/serenity-prompts.js` — live on
  `feat/prompts-management`, not on `main`; we port from them, not edit them.
- `spacecat-auth-service` — IMS validation already handled by `authWrapper`
  chain; outbound bearer forwarding is per-controller.
- `visibility-filters` / `visibility-response-normalize` / the gRPC
  `/apis/serenity/v1/ai-visibility/*` surface — separate feature.
- `POST /serenity/reporting/elements/:elementId` — dropped (different upstream auth).
- The `SEMRUSH_PROJECT_MATRIX` env var and `matrix.js` module — replaced by the
  new DB table; no env fallback.

---

## Follow-ups (file as separate Jira tickets after #2456 ships)

- Retry sweeper for `pending` / `publish_failed` / `create_failed` rows.
- Family-aware tag demux (cross-repo design §3.3.1).
- Site-cohort allow-list + `serenityEnabled` site-load bit (§4.4).
- `Idempotency-Key` + §6c error envelope alignment.
- Generalise `test/openapi-contract/_lib/openapi-loader.js` to other `*-api.yaml` files.
