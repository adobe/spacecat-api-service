# Semrush proxy — point at `adobe-hackathon.semrush.com` + project-creation endpoint

**Status:** plan only (draft PR); no code in this PR yet
**Base branch:** `feat/prompts-management`
**Cross-repo design doc:** `adobe-rnd/llmo-data-retrieval-service` PR #1779 (`docs/design/serenity-adobe-com-semrush-integration-1-week-scope.md` §3.4)

---

## Context

The hackathon proxy under `/v2/orgs/:spaceCatId/brands/:brandId/serenity/*` (PR #2397 + #2385, currently on `feat/prompts-management`) hits `https://www.semrush.com` directly and uses a dual auth shim: `Auth-Data-Jwt` header for IMS pass-through, `SEMRUSH_COOKIE` fallback for dev. Semrush has since shipped a dedicated proxy host **`adobe-hackathon.semrush.com`** that accepts a plain `Authorization: Bearer <IMS-User-Token>` and handles IMS→Semrush user + workspace mapping server-side. That collapses our client-side auth: drop the `Auth-Data-Jwt` shim, drop the cookie fallback, point at the new host.

Organization → Semrush workspace mapping is now on `mysticat-data-service` `main` (`organizations.semrush_workspace_id`, migration `20260525000000`, exposed via PostgREST). The proxy will resolve workspace per request from there instead of carrying it in the env matrix.

Onboarding a new `(brand, market, language)` slice also needs a project-creation endpoint — the migration script (in `llmo-data-retrieval-service`) creates Semrush projects today via a manual cookie-auth path, but onboarding from the Elmo UI requires a proxied endpoint.

## Scope

### In scope

Endpoints under `/v2/orgs/:spaceCatId/brands/:brandId/serenity/*`:

| Method | Path | Status | What changes |
|---|---|---|---|
| GET | `/prompts` | existing | re-tune auth + workspace resolution |
| POST | `/prompts` | existing | re-tune auth + workspace resolution |
| PATCH | `/prompts/:promptId` | existing | re-tune auth + workspace resolution |
| POST | `/prompts/bulk-delete` | existing | re-tune auth + workspace resolution |
| GET | `/projects` | existing | re-tune auth + workspace resolution |
| GET | `/projects/:workspaceId/:projectId/tags` | existing | re-tune auth |
| POST | `/projects` | **new** | onboarding — create AIO project for a (brand, market, language) slice |

Cross-cutting changes:

- Transport base URL default: `https://adobe-hackathon.semrush.com` (replaces `https://www.semrush.com`)
- Inbound auth header: `Authorization: Bearer <IMS>` forwarded as-is to Semrush (replaces `Auth-Data-Jwt`)
- Remove `SEMRUSH_COOKIE` / `SEMRUSH_USER_AGENT` cookie-fallback branch
- Workspace per request from `organizations.semrush_workspace_id` (5-min LRU cache)
- Shrink `SEMRUSH_PROJECT_MATRIX` schema: `(brandId, category, market, language) → projectId` (workspaceId removed)

### Out of scope (separate PRs)

- Family-aware tag demux (`category:` / `topic:` / `intent:` / `branded:` / `source:`) — §3.3.1
- Site-cohort allow-list (`SERENITY_SITE_ALLOWLIST`) and `serenityEnabled` bit — §4.4
- Idempotency-Key + §6c error envelope alignment — §3.4
- `brand_to_semrush_projects` DB table on data-service (replaces env matrix later) — §3.1
- Reporting endpoints (`/serenity/reporting/*`) — different upstream auth (Apikey), left intact
- AI Visibility gRPC routes on main (`/apis/serenity/v1/ai-visibility/*`) — untouched
- Swagger-driven contract tests — §3.6

## Architecture — request flow

```
Client (Elmo)
  │  Authorization: Bearer <IMS user token>
  │  e.g. GET /v2/orgs/{spaceCatId}/brands/{brandId}/serenity/prompts
  ▼
spacecat-api-service
  │  1. inbound auth: validate IMS, attach ctx.imsUser            (existing)
  │  2. resolve workspaceId:                                       (new)
  │       org = dataAccess.Organization.findById(spaceCatId)
  │       workspaceId = org.getSemrushWorkspaceId()
  │       404 if null
  │  3. resolve projectId(s) from SEMRUSH_PROJECT_MATRIX:          (existing, refactored)
  │       matrix.listProjectsForBrand(brandId) → [{projectId, category, market, language}]
  │       (or matrix.resolveProject(brandId, {category, market, language}) for writes)
  │  4. forward to adobe-hackathon.semrush.com                     (refactored)
  │       Authorization: Bearer {imsToken}
  ▼
adobe-hackathon.semrush.com
  │  exchanges IMS → Semrush token, maps user, forwards            (server side)
  ▼
Semrush AIO
```

**Two-tier resolution is intentional**: workspace mapping is durable (orgs onboard one-by-one over months), project mapping churns weekly as new markets / languages get added. Project mapping moves to a DB table later (out of scope).

## Endpoint contracts

All paths under `/v2/orgs/:spaceCatId/brands/:brandId/serenity`. All require `Authorization: Bearer <IMS>`. All return 404 if the org has no `semrush_workspace_id`.

### `GET /prompts`

- Query: `?page=1&limit=50&search=&category=&market=&language=`
- Behaviour: fan-out across all projects in `matrix.listProjectsForBrand(brandId)`, merge results, paginate
- Upstream: `POST /enterprise/projects/api/v2/workspaces/{ws}/projects/{pid}/aio/prompts/by_tags` per project
- Response: `{ items: [{id, logicalId, text, tags: [...], market, language, category, ...}], total, page, limit }`

### `POST /prompts`

- Body: `{ prompts: [{text, tags: [], category, topic, intent, market, language}] }`
- Behaviour: group by `(category, market, language)`, look up `projectId` per group, POST tagged prompts, publish each touched project
- Upstream: `POST /v2/.../aio/prompts/tagged` + `POST /v1/.../publish`
- Response: `{ created: [{logicalId, semrushId, projectId, ...}], failed: [...] }`

### `PATCH /prompts/:promptId`

- `:promptId` is the logical id (base64url JSON of `{brandId, category, language, text}`)
- Body: `{ text?, tags?, ... }`
- Behaviour: decode logical id → resolve project → DELETE old + POST new + publish (same as hackathon branch)
- Response: `{ id: <new-logicalId>, semrushId, ... }`

### `POST /prompts/bulk-delete`

- Body: `{ semrushIds: [{projectId, promptId}, ...] }`
- Behaviour: group by project, DELETE per project, publish per touched project
- Upstream: `DELETE /v2/.../aio/prompts`
- Response: `{ deleted: number, failed: [...] }`

### `GET /projects`

- Query: `?category=&market=&language=`
- Behaviour: return matrix rows for the brand (workspace from DB, projects from matrix), enrich with live Semrush metadata via `listWorkspaceProjects`
- Response: `{ items: [{projectId, workspaceId, name, category, market, language, status, ...}] }`

### `GET /projects/:workspaceId/:projectId/tags`

- Pass-through to Semrush
- Upstream: `GET /v1/workspaces/{ws}/projects/{pid}/tags`
- Response: `{ items: [{id, name}] }` (raw shape; tag demux is follow-up)

### `POST /projects` (new — onboarding)

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
  2. 409 conflict if matrix already has a row for `(brandId, category, market, language)`
  3. Resolve `language_id` (Semrush UUID) by calling `GET /v1/languages` once on boot, cached 1h
  4. Resolve `location_id` from a static `countryLocationMap` shipped in the repo (ISO 2-letter → Google geo target id) — same map the migration script uses
  5. POST `POST /enterprise/projects/api/v1/workspaces/{ws}/projects` with `{name, type, brand_name_display, brand_names, domain, country_code, location_id, location_name, language_id}`
  6. On success, publish (`POST /v1/.../publish`)
- Response: `{ workspaceId, projectId, name, status: "draft" | "published" }`
- Out of scope: writing a row to `brand_to_semrush_projects`. Matrix env JSON has to be updated manually after onboarding (acceptable — onboarding is rare, 19 projects total for adobe.com).

## Files to modify

| File | Change | Why |
|---|---|---|
| `src/support/serenity/rest-transport.js` | Drop `SEMRUSH_COOKIE` / `SEMRUSH_USER_AGENT` branch from `buildHeaders`. Switch IMS header from `Auth-Data-Jwt` to `Authorization: Bearer <token>`. Change `DEFAULT_BASE_URL` to `https://adobe-hackathon.semrush.com`. Add `createProject(workspaceId, body)`. Keep existing `publishProject`. | Core auth + base URL refactor + new endpoint |
| `src/support/serenity/matrix.js` | Remove `workspaceId` from matrix schema. `listProjectsForBrand` and `resolveProject` return rows without workspaceId. | Workspace now comes from DB; matrix is project-only |
| `src/support/serenity/workspace-resolver.js` | **New file.** Export `resolveWorkspaceId(ctx, spaceCatId)` — reads `ctx.dataAccess.Organization.findById(spaceCatId)`, returns `semrush_workspace_id` or null. In-memory 5-min LRU cache keyed by spaceCatId. | Centralised workspace lookup |
| `src/support/serenity/handlers/prompts.js` | `handleListPrompts` / `handleCreatePrompts` / `handleUpdatePrompt` / `handleBulkDeletePrompts` take `workspaceId` as an arg instead of pulling it from matrix rows. | Two-tier resolution |
| `src/support/serenity/handlers/projects.js` | **New file.** Export `handleCreateProject(transport, env, {workspaceId, body, log})`. Looks up language UUID + location_id, calls `transport.createProject`, then `transport.publishProject`. | Onboarding logic |
| `src/support/serenity/data/locations.json` | **New file.** ISO 2-letter → `{location_id, location_name}` map. Copy from migration script's `COUNTRY_LOCATION_BY_CODE`. | Static data for project creation |
| `src/controllers/serenity-prompts.js` | Each controller method: call `resolveWorkspaceId(ctx, spaceCatId)`, 404 if null, pass workspaceId into the handler. | Wire workspace resolution |
| `src/controllers/serenity-projects.js` | **New file (or extend serenity-prompts.js).** `createProject(ctx)` handler. | New endpoint |
| `src/routes/index.js` | Add `POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/projects`. | New endpoint |
| `test/support/serenity/rest-transport.test.js` | Update header assertions, base URL, add `createProject` tests. | Test surface follows code |
| `test/support/serenity/matrix.test.js` | Update matrix schema (no workspaceId). | Schema change |
| `test/support/serenity/workspace-resolver.test.js` | **New.** Test the cache + the data-access call. | New module |
| `test/support/serenity/handlers/prompts.test.js` | Pass workspaceId explicitly to handlers. | API shift |
| `test/support/serenity/handlers/projects.test.js` | **New.** Test handleCreateProject with mocked transport + language cache. | New module |
| `test/controllers/serenity-prompts.test.js` | Stub `dataAccess.Organization.findById`. Add 404 case (org has no semrush_workspace_id). | New auth path |
| `test/controllers/serenity-projects.test.js` | **New.** POST `/projects` flow with mocked transport + dataAccess. | New endpoint |
| `docs/openapi/*` | Update Semrush proxy endpoint specs to reflect new auth + add the `/projects` POST. | OpenAPI-first per repo conventions |
| `README.md` (or new `docs/serenity.md`) | Document env vars + the new auth model + the onboarding endpoint. | Operator-facing |

## Dependencies

1. **`@adobe/spacecat-shared-data-access`** must expose `getSemrushWorkspaceId()` on the `Organization` entity. The column exists in DB + PostgREST; if the shared lib's entity model doesn't surface it yet:
   - **Preferred:** add the getter in `adobe/spacecat-shared` (small follow-up PR)
   - **Interim:** fall back to `ctx.dataAccess.services.postgrestClient` raw query in `workspace-resolver.js`
2. **No new env vars required** — `SEMRUSH_PROJECTS_BASE_URL` already exists; we just change its default. The matrix env JSON shape changes (workspaceId removed) — deployment must update Vault / Helix env values before this lands in dev / prod.

## Implementation order

1. Verify `@adobe/spacecat-shared-data-access` exposes `Organization.getSemrushWorkspaceId()`; file the follow-up or wire raw PostgREST.
2. Refactor `rest-transport.js`: header + base URL + drop cookie branch.
3. Add `workspace-resolver.js` + tests.
4. Refactor `matrix.js`: drop workspaceId from schema + tests.
5. Refactor existing handlers + controllers to wire workspace resolution.
6. Update existing tests for new header shape + matrix shape.
7. Add `createProject` to transport + `handlers/projects.js` + `controllers/serenity-projects.js`.
8. Add the new route + tests.
9. Update OpenAPI specs + `README.md` / `docs/serenity.md`.
10. Mark PR ready-for-review.

## Verification

End-to-end (post-deploy to dev):

- `mysticat auth token --env dev` → grab IMS token
- `curl -H "Authorization: Bearer $TOKEN" 'https://spacecat.experiencecloud.live/api/ci/v2/orgs/<spaceCatId>/brands/<brandId>/serenity/prompts?limit=5'` → expect `200` with list shape
- `curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"prompts":[{"text":"test","tags":[],"market":"AU","language":"en"}]}' '.../serenity/prompts'` → expect `200` with `semrushId`
- Non-onboarded org (no `semrush_workspace_id`) → expect `404`
- `curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"name":"...","market":"AU","language":"en","category":"Creative Cloud","brandDomain":"adobe.com"}' '.../serenity/projects'` → expect `201` with `{workspaceId, projectId, status:"published"}`

Unit / integration:

- `npm test -- --grep 'serenity'` — all renamed / added suites pass
- `nock` recorder confirms outbound `Authorization: Bearer ...` (not `Auth-Data-Jwt`) and `adobe-hackathon.semrush.com` host

## Open questions

- Does `adobe-hackathon.semrush.com` honour the same paths as `www.semrush.com/enterprise/projects/api/v1|v2/...`? Verify with one curl before merging the code PR. If paths differ, env-driven path prefix is trivial.
- Does the `Organization` entity expose `getSemrushWorkspaceId()` in `@adobe/spacecat-shared-data-access` already? (see Dependencies §1)
- Should the matrix env JSON also be removed entirely and replaced with a per-request DB lookup against `brand_to_semrush_projects`? Out of scope here but worth a tracking ticket once the table exists.

## Follow-ups (file as Jira tickets after this PR)

- Family-aware tag demux (§3.3.1)
- Site-cohort allow-list + `serenityEnabled` bit (§4.4)
- Idempotency-Key + §6c error envelope
- `brand_to_semrush_projects` DB table on `mysticat-data-service`
- `Organization.getSemrushWorkspaceId()` on `@adobe/spacecat-shared-data-access` (if not already there)
- Swagger-driven contract tests against Semrush spec (§3.6)
