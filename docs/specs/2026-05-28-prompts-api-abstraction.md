# Serenity API: Hiding Semrush as an Implementation Detail

Status: Draft (2026-05-28)
Owner: rfriederich
Touched repos: `spacecat-shared`, `spacecat-api-service`, `project-elmo-ui`
Supersedes: nothing yet. Existing public surface is `/v2/orgs/:org/brands/:brand/serenity/*`.

## 1. Goal

Clean up the public `/serenity/*` surface so that **no Semrush-specific identifier** appears in any request/response. "Serenity" is Adobe's product name for the AI visibility surface and stays in the URL. Semrush is the current upstream and must not leak.

Concretely:
- Rename `semrushLocationId` (int) → `geoTargetId` (int). It is literally the Google Ads Geo Target ID and Semrush re-uses it; the name "semrush" on this field is wrong, not just leaky.
- Drop `semrushProjectId` from public DTOs and bulk-delete payloads. Server resolves the project internally from `(brandId, geoTargetId, languageCode)`.
- Keep `semrushPromptId` as the prompt identifier. The value IS Semrush's prompt UUID; pretending otherwise (calling it `id`) is misleading. **Naming rule for this refactor:** hide implementation details that ARE ours (project routing, logical tokens); honestly name values that are NOT ours (the prompt UUID belongs to Semrush and stays semrush-prefixed).
- Drop the synthetic base64 "logical id" entirely. PATCH and bulk-delete address prompts by `semrushPromptId` directly, with `(geoTargetId, languageCode)` in the body for slice resolution.
- Rename `language` → `languageCode` everywhere in the public API. The value is a BCP-47 primary subtag (`en`, `de`, `fr`), not a display name — `languageCode` is unambiguous.
- Replace the `/serenity/projects` resource with `/serenity/markets`. "Project" is a Semrush concept; "market" matches the UX concept (a `(geoTargetId, languageCode)` slice).
- Add `DELETE /serenity/markets/:geoTargetId/:languageCode` — currently missing. Removes the brand's mapping + best-effort upstream project teardown.
- Delete `/serenity/projects/:workspaceId/:projectId/tags`, `/models`, and `/serenity/workspaces/:workspaceId/projects`. Tags and models move under brand-scoped `/serenity/tags` and `/serenity/models` (workspace + project resolved server-side). The workspaces endpoint has zero consumers (verified 2026-05-28 — `grep -rn listSerenityWorkspaceProjects src` is empty in elmo).

Out of scope:
- Replacing the upstream provider — still Semrush AIO behind the curtain.
- Renaming the data-access entity or DB table `brand_to_semrush_projects`. Internal name; stays.
- Brand-presence pipeline (mysticat-projector). It reads `brand_to_semrush_projects` directly via PostgREST and is independent of the public API.

## 2. Current state — what leaks

| Concept in public API | Where exposed | What it actually is |
|---|---|---|
| `semrushLocationId` (int, e.g. `2840`) | request bodies, query params, response DTOs | **Google Ads Geo Target ID** (`criterion_id` for a country). Semrush re-uses it; the value is `2000 + ISO numeric` and is owned by Google Ads. The "semrush" naming is wrong. → renamed to `geoTargetId`. |
| `semrushProjectId` (uuid) | response DTOs, bulk-delete body (`{ semrushIds: [...] }`) | Upstream Semrush project UUID. Pure routing detail of the proxy. → dropped from public DTOs; server resolves from `(brandId, geoTargetId, languageCode)` via `BrandSemrushProject.findBySlice`. |
| `semrushId` (uuid) | response DTOs, bulk-delete body | Upstream Semrush prompt UUID — Semrush's own identifier for the prompt. → renamed to `semrushPromptId` for clarity (the value is genuinely Semrush's; honest naming beats fake abstraction). |
| `id` (base64 token) | response DTOs, PATCH URL | Server-synthesized opaque envelope encoding `{brandId, semrushLocationId, language, text}`. Round-trip-only — not in any DB row. → removed; replaced by `semrushPromptId` directly + slice fields in the body. |
| `language` (BCP-47 primary subtag) | bodies, query params, DTOs | Value is correct, name is ambiguous (could read as full language name). → renamed to `languageCode`. |
| `workspaceId`, `projectId` in URL path | `/serenity/projects/:workspaceId/:projectId/tags`, `/models`, `/serenity/workspaces/:workspaceId/projects` | Pure Semrush addressing. Resolved server-side from the brand. |
| `/serenity/projects` resource | GET + POST | Exposed because the UI needs the `(geoTargetId, languageCode)` matrix. Renamed to `/serenity/markets`. |
| (no DELETE for markets) | gap | Currently impossible to remove a `(geoTargetId, languageCode)` slice from a brand. Added as `DELETE /serenity/markets/:geoTargetId/:languageCode`. |
| `enrichment: 'failed'`, `domain`, `name` on project list | response DTO | Live-Semrush metadata. UI only consumes `name`; replaceable with a non-Semrush-flavoured `name` field on the market DTO (the value Semrush stores is the same value WE sent on create, so it's not really "Semrush data"). |
| `GET /serenity/workspaces/:wsId/projects` | endpoint | Zero callers in elmo or any other repo verified 2026-05-28. Deleted, not replaced. |

## 3. Target API

```
GET    /v2/orgs/:orgId/brands/:brandId/serenity/prompts                              // list — requires geoTargetId + languageCode
POST   /v2/orgs/:orgId/brands/:brandId/serenity/prompts                              // bulk create
PATCH  /v2/orgs/:orgId/brands/:brandId/serenity/prompts/:semrushPromptId             // partial update
POST   /v2/orgs/:orgId/brands/:brandId/serenity/prompts/bulk-delete                  // bulk delete

GET    /v2/orgs/:orgId/brands/:brandId/serenity/markets                              // brand's (geoTargetId, languageCode) matrix
POST   /v2/orgs/:orgId/brands/:brandId/serenity/markets                              // onboard a new slice for this brand
DELETE /v2/orgs/:orgId/brands/:brandId/serenity/markets/:geoTargetId/:languageCode   // remove a slice from this brand

GET    /v2/orgs/:orgId/brands/:brandId/serenity/tags?geoTargetId=&languageCode=      // tags for the slice — both filters required
GET    /v2/orgs/:orgId/brands/:brandId/serenity/models?geoTargetId=&languageCode=    // AI models for the slice — both filters required
```

`/v2/orgs/:org/brands/:brand` and the IMS-bearer auth flow are unchanged from today.

### GET query params

| Endpoint | Required | Optional |
|---|---|---|
| `/serenity/prompts` | `geoTargetId` (int), `languageCode` (string) | `page` (default 1), `limit` (default 50, max 1000), `search` |
| `/serenity/markets` | — | — |
| `/serenity/tags` | `geoTargetId`, `languageCode` | — |
| `/serenity/models` | `geoTargetId`, `languageCode` | — |

Missing required filters → 400 (`invalidRequest`). The endpoint always resolves to exactly one `BrandSemrushProject` → one upstream Semrush project; no fan-out, no merged-and-sliced pagination. Pagination on `/prompts` is real upstream pagination — `total` is the upstream-reported count, `page`/`limit` map 1:1 to the upstream call.

### 3.1 Prompt DTO

```jsonc
{
  "semrushPromptId": "<upstream Semrush prompt UUID>",
  "geoTargetId": 2840,
  "languageCode": "en",
  "text": "...",
  "tags": ["..."]
}
```

`semrushPromptId` is exactly the value `semrushId` carries today — same upstream UUID, clearer name. The synthetic base64 `id` is gone.

### 3.2 Request body shapes

```jsonc
// POST /serenity/prompts
{
  "prompts": [
    { "text": "...", "tags": [], "geoTargetId": 2840, "languageCode": "en" }
  ]
}

// PATCH /serenity/prompts/:semrushPromptId
//   :semrushPromptId is the upstream UUID. Body carries the slice so the
//   server can resolve the BrandSemrushProject without scanning every project.
{
  "geoTargetId": 2840,
  "languageCode": "en",
  "text": "...",    // optional — omit = preserve
  "tags": ["..."]   // optional — omit = preserve; explicit [] = clear
}

// POST /serenity/prompts/bulk-delete
{
  "prompts": [
    { "semrushPromptId": "<upstream UUID>", "geoTargetId": 2840, "languageCode": "en" }
  ]
}

// POST /serenity/markets
//   brand domain + brand names are read server-side from the `brands` row.
//   `name` defaults to `<brand display name>-<6 char random hex>` when omitted
//   (e.g. `Adobe-a3f7c1`). The random suffix lets operators distinguish
//   multiple projects in the Semrush workspace UI even when their (market,
//   language) tuple is identical — guards against accidental collisions in
//   shared workspaces and against re-create-after-delete confusion.
{
  "geoTargetId": 2840,
  "languageCode": "en",
  "name": "<optional display name; defaults to '<brand>-<random>' when omitted>"
}

// DELETE /serenity/markets/:geoTargetId/:languageCode
//   No body. Idempotent: deleting an absent slice returns 204.
//   See §3.5 for ordering + orphan handling.
```

### 3.3 Market DTO

```jsonc
{
  "geoTargetId": 2840,
  "languageCode": "en",
  "status": "live" | "pending" | "publish_failed" | "create_failed",
  "name": "<display name>",
  "createdAt": "...",
  "updatedAt": "..."
}
```

### 3.4 Tag / Model DTOs

```jsonc
{ "id": "<tag id>", "name": "<display>" }
{ "id": "<uuid>", "key": "openai-gpt-4o-mini", "name": "...", "icon": null }
```

Both `/serenity/tags` and `/serenity/models` require `geoTargetId` + `languageCode`. The server resolves the single `BrandSemrushProject` for that slice and makes one upstream call. No fan-out fallback — see §4 decision 9 for rationale.

### 3.5 DELETE market semantics

**Upstream support verified 2026-05-28** against `adobe-hackathon.semrush.com`:

```
OPTIONS /enterprise/projects/api/v1/workspaces/{ws}/projects/{pid}
→ HTTP/2 405, allow: DELETE, GET, PATCH

DELETE  /enterprise/projects/api/v1/workspaces/{ws}/projects/<bogus uuid>
→ HTTP 404, {"message":"not found"}
```

The `Allow` header confirms DELETE is implemented; the 404 on a bogus id confirms it's wired (not a 405 stub). Option A is the implementation; Option B is dropped.

Order (mirrors the create-then-publish-then-row pattern in reverse):

1. Look up `BrandSemrushProject` by `(brandId, geoTargetId, languageCode)`. If missing → 204 (idempotent).
2. Upstream cleanup: `DELETE /v1/workspaces/{ws}/projects/{pid}`. New `deleteProject(workspaceId, projectId)` method on `rest-transport.js`. Treat upstream 404 as idempotent success (the project is already gone).
3. Delete the `brand_to_semrush_projects` row.
4. Return 204 on success.

If step 2 fails on a non-404 (upstream 5xx, network, 401), do **not** delete the row — return 502 and leave the slice intact. This avoids the "row gone, project alive" half-state.

If step 2 succeeds and step 3 fails (DB write error), the slice is half-deleted: upstream project gone but DB row still present. Log `error` with both ids and return 500. Operator follow-up: re-run DELETE; step 2 returns 404 (idempotent), step 3 cleans up the row.

## 4. Decisions resolved

| # | Decision | Choice |
|---|---|---|
| 1 | Path scope | Brand-scoped (`/orgs/:org/brands/:brand/serenity/...`). Brands are not 1:1 with orgs and `brand_to_semrush_projects` is brand-keyed. |
| 2 | Public market identifier | Numeric `geoTargetId` (the real name). Same on-the-wire value as today's `semrushLocationId`. |
| 3 | Onboarding | Explicit `POST /serenity/markets`. |
| 4 | Prompt id field name | `semrushPromptId`. Value = upstream Semrush prompt UUID (same value as today's `semrushId`). Honest naming beats a fake-abstract `id`. PATCH and bulk-delete payloads carry `geoTargetId` + `languageCode` so the server can resolve the slice without scanning. |
| 5 | Rollout | Single coordinated cut-over. No parallel running, no fallback decoder, no deprecated routes. |
| 6 | Markets URL | Brand-scoped (`/brands/:brand/serenity/markets`). No global catalog endpoint in scope. |
| 7 | `language` naming | Renamed to `languageCode` (it's a BCP-47 primary subtag, not a display name). |
| 8 | DELETE market | New `DELETE /serenity/markets/:geoTargetId/:languageCode`. Best-effort upstream teardown; row deletion gated on upstream success. See §3.5. |
| 9 | GET filter requirements | `geoTargetId` + `languageCode` are **required** on `/prompts`, `/tags`, `/models`. No fan-out. Reason: real upstream pagination only works against a single project, and the merged-and-sliced fan-out today isn't true pagination (it pre-loads everything per request). The UI already always sends both filters from its market/language selectors. **Forward-looking:** if Semrush ever exposes endpoints that span multiple projects in one upstream call (cross-project prompt list, cross-project tags, etc.), these filters can be relaxed to optional — the fan-out workaround would no longer be needed and "all prompts/tags across the brand" becomes a single upstream request. Re-evaluate then. |

## 5. Per-repo changes

### 5.1 `spacecat-api-service`

Replaced files (1:1 swap, no new module structure):
- `src/controllers/serenity.js` — same controller, new route handler names, drop the workspace-path-verification helper. Rename `listProjects` → `listMarkets`, `createProject` → `createMarket`, add `deleteMarket`. Drop `listWorkspaceProjects`. **Tighten brand resolution:** the serenity controller now rejects non-UUID `:brandId` with 400 (`invalidRequest`) before calling `resolveBrandUuid`. The shared helper still accepts name-based lookup for other endpoints; this is a controller-level guard added only here. Reason: a renamed brand between page load and PATCH/DELETE would otherwise silently 404 (or worse, resolve to a different row if a name collision is introduced) — UUIDs are immutable.
- `src/support/serenity/handlers/projects.js` — renamed to `markets.js`. Exports become `handleListMarkets`, `handleCreateMarket`, `handleDeleteMarket`. Tag/model handlers move to `handlers/tags.js` and `handlers/models.js` (or stay alongside if small).
- `src/support/serenity/handlers/prompts.js` — drop `encodeLogicalId`/`decodeLogicalId` and the `findSemrushPromptByText` lookup. PATCH and bulk-delete now take `semrushPromptId` directly from the URL/body. The `BrandSemrushProject.findBySlice(brandId, geoTargetId, languageCode)` call is the slice resolver in both code paths. **Drop** the fan-out machinery in `handleListPrompts`: `filterProjects`, `Promise.allSettled` over projects, the merged-and-sliced pagination, the `errors[]` partial-failure field. GET requires the filters; one slice = one upstream call = real pagination.
- `src/support/serenity/rest-transport.js` — **modified**: add `deleteProject(workspaceId, projectId)` (DELETE `/v1/workspaces/{ws}/projects/{pid}`). Verify the endpoint exists upstream before merging (§3.5 Option A). If it doesn't, Option B path uses existing `deletePromptsByIds` only — no transport change.
- `src/routes/index.js` — new path strings; old paths removed (no aliasing).
- `src/routes/required-capabilities.js` — same capability keys, updated paths. `DELETE /serenity/markets/...` is `organization:write`.
- `docs/openapi/serenity-api.yaml` — full rewrite. DTOs renamed (`SemrushPromptListResponse` → `SerenityPromptListResponse`, fields renamed per §3) to match the new shape. Required query params (`geoTargetId`, `languageCode` on `/prompts`, `/tags`, `/models`) explicitly declared with `required: true` so the spec generates documented 400 responses. UUID-only brand path constraint declared via `pattern` on the `:brandId` path parameter.
- `docs/serenity.md` — update operator runbook (delete-market section, orphan handling).

Reused as-is:
- `src/support/serenity/workspace-resolver.js` — unchanged.
- `src/support/prompts-storage.js::resolveBrandUuid` — unchanged.
- `dataAccess.BrandSemrushProject` collection — unchanged (entity name stays internal).
- `resolveLocation()` in markets handler — still translates ISO-2 (on create) to geoTargetId. No public-facing change.

### 5.2 `project-elmo-ui`

Replaced files:
- `src/types/serenity.ts` — drop `semrushProjectId`, `semrushId`, `semrushLocationId`, `SerenityPromptDeleteTarget`, the synthetic `id` field. Add `semrushPromptId`, `geoTargetId`, `languageCode` (replace `language`). Add `geoTargetId`+`languageCode` to `SerenityPromptUpdateInput`.
- `src/api/spacecat.ts` — bulk-delete signature is `(orgId, brandId, prompts: Array<{semrushPromptId, geoTargetId, languageCode}>)`. PATCH signature is `(orgId, brandId, semrushPromptId, body: {geoTargetId, languageCode, text?, tags?})`. Rename `listSerenityProjects` → `listSerenityMarkets`, add `createSerenityMarket` and `deleteSerenityMarket`. Drop the `createSerenityProject` call from the prior draft.
- `src/hooks/useSerenityProjects.ts` → `useSerenityMarkets.ts`. The hook's public surface (`markets`, `languages`, `findProject`) is mostly the same; rename `findProject` → `findMarket`. The `locationNameFromId` helper stays — it converts geoTargetId to a country name for display. Add a `deleteMarket` mutation.
- `src/hooks/useSerenityPrompts.ts` — list responses use `semrushPromptId` as the React key. `deleteMutation` passes `{semrushPromptId, geoTargetId, languageCode}` per row, derived from each Prompt item. `updateMutation` passes `{geoTargetId, languageCode, ...}` in the body.
- `src/components/prompts-management/SerenityPromptsManagement.tsx` — `handleBulkDelete` becomes a simple `items.find` over selected ids, then maps to `{semrushPromptId, geoTargetId, languageCode}`. No more `semrushProjectId` field shuffle.
- `src/pages/PromptsManagement.tsx` — references to `serenityMarket`/`serenityLang` URL params stay (UI state, not API contract).

### 5.3 `spacecat-shared`

The naming cleanup applies to the data-access entity too. JS attribute names rename; DB column names stay (`semrush_location_id`, `language` are read directly by mysticat-data-service and the projector via PostgREST — column renames are an unrelated migration). Mapping is via electro's existing `postgrestField` override (see `src/util/postgrest.utils.js:63`).

Modified files in `packages/spacecat-shared-data-access/`:

- `src/models/brand-semrush-project/brand-semrush-project.schema.js`
  - `addAttribute('semrushLocationId', ...)` → `addAttribute('geoTargetId', { ..., postgrestField: 'semrush_location_id' })`
  - `addAttribute('language', ...)` → `addAttribute('languageCode', { ..., postgrestField: 'language' })`
  - `addAttribute('semrushProjectId', ...)` — **kept**. The value IS Semrush's project UUID; honest naming rule applies (same as `semrushPromptId` on the public API).
  - The slice index (`.addIndex` declarations that reference these attributes) updates the key names accordingly.
- `src/models/brand-semrush-project/brand-semrush-project.collection.js`
  - `findBySlice(brandId, semrushLocationId, language)` → `findBySlice(brandId, geoTargetId, languageCode)`. Update JSDoc.
- `src/models/brand-semrush-project/index.d.ts`
  - Rename accessor signatures: `getSemrushLocationId` → `getGeoTargetId`, `setSemrushLocationId` → `setGeoTargetId`, `getLanguage` → `getLanguageCode`, `setLanguage` → `setLanguageCode`. Keep `getSemrushProjectId` / `setSemrushProjectId`.
- `test/unit/models/brand-semrush-project/*.test.js`
  - Update all test fixtures + accessor calls.
- `CHANGELOG.md` — captured by semantic-release. Regular `feat:` commit → minor version bump. No `BREAKING CHANGE:` footer despite the JS API rename: a workspace-wide grep confirms spacecat-api-service is the only consumer of `BrandSemrushProject`, and it bumps in the same window. The major-version ceremony would only serve external consumers that don't exist.

The entity name (`BrandSemrushProject`) and table name (`brand_to_semrush_projects`) stay — those are storage-level identifiers and changing them is a much larger task.

## 6. Rollout

Single coordinated cut-over across three repos. The endpoint shape changes are breaking; we own client, server, and shared data-access; there are no third-party consumers.

Order (strict — each depends on the previous):
1. **spacecat-shared PR merges + a new minor version of `@adobe/spacecat-shared-data-access` is released** (semantic-release on merge to main; minor bump via `feat:` commit).
2. **api-service PR** opens with the new spacecat-shared version pinned in `package.json`, all rewrites in the same diff. CI must build green against the released shared version.
3. **project-elmo-ui PR** opens against the api-service PR's CI deploy. Elmo's PR-env build talks to `https://spacecat.experiencecloud.live/api/ci/` once the api-service PR reaches `ci`.
4. Verify end-to-end on `pr-N.amplifyapp.com` against `ci`.
5. Merge api-service to main, then elmo.

No `@deprecated` aliasing, no parallel surface, no decoder fallback. Any in-flight UI session that holds an old-shape DTO during cut-over breaks on next PATCH/delete — acceptable: the page also reloads its list on mutation, so the next interaction recovers.

**spacecat-shared release dependency:** if the shared-data-access release is delayed (CI flake, release-bot stall), api-service CI cannot install the pinned version. Mitigation: confirm the release lands and `npm view @adobe/spacecat-shared-data-access version` returns the new minor before opening the api-service PR.

## 7. Phases & validation gates

### Pre-flight — upstream capability check (before Phase 1)

Verify whether `DELETE /v1/workspaces/{ws}/projects/{pid}` is supported on `adobe-hackathon.semrush.com`. Quick `curl` with an IMS bearer + workspace + project id from the dev environment. Result determines whether §3.5 Option A or Option B ships.

**Validation gate:** decision recorded in the api-service PR description (Option A / Option B). If Option B, the operator runbook (`docs/serenity.md`) gains an "orphan project cleanup" section.

### Phase 0 — spacecat-shared (single PR)

Work:
- Rename attributes in `brand-semrush-project.schema.js` with `postgrestField` overrides preserving DB column names.
- Update `findBySlice` parameter names + JSDoc in `brand-semrush-project.collection.js`.
- Update TypeScript declarations in `index.d.ts`.
- Update all tests in `test/unit/models/brand-semrush-project/`.
- Commit as `feat:` for a minor semantic-release bump (no `BREAKING CHANGE:` footer — only consumer is api-service, bumped in the same window).

Validation gates (block merge):
- `npm test -- test/unit/models/brand-semrush-project/` — green.
- `npm run lint` — clean.
- `npm run check-types` (or equivalent) — green; the renamed accessors must surface in `.d.ts`.
- `git grep -E 'getSemrushLocationId|setSemrushLocationId|getLanguage\b|setLanguage\b' -- packages/spacecat-shared-data-access/src packages/spacecat-shared-data-access/test` returns nothing. (`getSemrushProjectId`/`setSemrushProjectId` stay.)
- Round-trip test against a local PostgREST: create a `BrandSemrushProject` row using the new accessors, fetch it back, verify the new accessor names return values, verify the DB row still has `semrush_location_id` and `language` columns.

After merge: confirm `npm view @adobe/spacecat-shared-data-access version` returns the new minor before starting Phase 1.

### Phase 1 — api-service (single PR)

Work:
- Bump `@adobe/spacecat-shared-data-access` to the new minor published in Phase 0.
- Rewrite controller + handlers, routes, capabilities, OpenAPI spec, operator runbook.
- Update all call sites: `project.getSemrushLocationId()` → `project.getGeoTargetId()`, `project.getLanguage()` → `project.getLanguageCode()`, `findBySlice(brandId, semrushLocationId, language)` → `findBySlice(brandId, geoTargetId, languageCode)`.
- Add `deleteProject` to `rest-transport.js` (gated on upstream API check — see §3.5).
- Unit tests cover: auth (IMS-only), brand resolution, geoTargetId↔location pass-through, list pagination, create dedup, PATCH preserve-tags semantics, bulk-delete via `{semrushPromptId, geoTargetId, languageCode}`, DELETE market happy path + idempotent 204 + upstream-failure 502 + half-delete 500.
- Integration test in `test/it/` against a mocked Semrush transport.

Validation gates (block merge):
- `npm test -- test/controllers/serenity.test.js test/support/serenity/` — green.
- `npm run test:it` — green.
- `npm run lint` — clean.
- OpenAPI contract test (`test/openapi-contract/serenity-api.test.js`) — green.
- Banned-name grep — these must NOT appear in `src/` or `docs/`:
  ```
  git grep -E 'semrushLocationId|semrushProjectId|semrushIds|\bsemrushId\b|encodeLogicalId|decodeLogicalId' -- src docs
  ```
  (`semrushPromptId` is allowed; the others are not. `BrandSemrushProject` and `brand_to_semrush_projects` remain — they're internal storage names.)
- `curl` against `ci`: `GET /v2/orgs/<aem-sites-eng-uuid>/brands/Adobe/serenity/markets` returns rows for adobe.com with `geoTargetId` not `semrushLocationId`, and `languageCode` not `language`.

### Phase 2 — project-elmo-ui (single PR, against the api-service PR's `ci`)

Work:
- Migrate types, api client, hooks, components per §5.2.

Validation gates:
- `npm test -- src/hooks/useSerenityPrompts.test.tsx src/hooks/useSerenityMarkets.test.tsx` — green.
- `npm run build` — green.
- Banned-name grep in `src/`:
  ```
  git grep -E 'semrushLocationId|semrushProjectId|semrushIds|\bsemrushId\b|encodeLogicalId|decodeLogicalId' -- src
  ```
  must be empty. (`semrushPromptId` is the kept name.)
- Manual smoke on the elmo PR env (`pr-N.d2ikwb7s634epv.amplifyapp.com`) once both PR builds are deployed: load prompts page, change market, change language, create, edit, bulk-delete, delete a market. Network tab shows the new field names (`semrushPromptId`, `geoTargetId`, `languageCode`) and no `semrushLocationId` / `semrushProjectId` / `semrushIds`.

### Phase 3 — none

There is no cleanup phase. Everything is removed in Phase 1.

## 8. Risk register

- **Brand path UUID-only.** Resolved by hardening: serenity endpoints reject non-UUID `:brandId` with 400 at the controller boundary. Name-based brand resolution still exists in the shared helper for other endpoints, but is closed off here. See §5.1.
- **Missing GET filters.** `/prompts`, `/tags`, `/models` without `geoTargetId` + `languageCode` return 400. Rejected before any upstream call. Explicitly documented in OpenAPI via `required: true`, so the 400 response is part of the published contract — not implicit behavior. See §4 decision 9 for the forward-looking note about relaxing this if Semrush adds multi-project endpoints.

- **DELETE market — upstream project teardown unverified.** §3.5 hinges on whether Semrush exposes `DELETE /v1/workspaces/{ws}/projects/{pid}`. **Action:** pre-flight check before Phase 1 (see §7). If absent, Option B (drain prompts, leave empty project) becomes the only implementation and operators need a runbook entry for the resulting orphan projects.
- **DELETE market — accidental data loss.** A delete-market wipes all prompts for that slice with no undo. **Required mitigation:** UI must render a confirmation dialog listing the affected prompt count (read from the same endpoint that drives the page count) before issuing the DELETE. Phase 2 acceptance criterion. Server is idempotent but does not soft-delete.
- **In-flight UI session during cut-over.** Accepted. A user mid-edit during deploy may see one failed mutation; the page recovers on next list refetch. Documented as known and not mitigated.

## 9. Open questions

None. Previously-open items resolved:

- `POST /serenity/markets` default `name` → `<brand display name>-<6 char random hex>` (e.g. `Adobe-a3f7c1`). The random suffix prevents collisions in shared workspaces and disambiguates re-create-after-delete. Explicit `name` in the body wins. See §3.2.
- `GET /serenity/markets` `status` field → included (`live` / `pending` / `publish_failed` / `create_failed`). Lets the UI surface a banner for `publish_failed` slices. See §3.3.

## 10. Tracker

- [ ] spacecat-shared PR — owner: TBD, ticket: TBD
- [ ] api-service PR (blocked on spacecat-shared release) — owner: TBD, ticket: TBD
- [ ] project-elmo-ui PR (blocked on api-service `ci` deploy) — owner: TBD, ticket: TBD
