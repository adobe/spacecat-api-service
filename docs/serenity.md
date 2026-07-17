# Semrush AIO proxy — operator guide

This document is the runtime reference for the `/v2/orgs/:spaceCatId/brands/:brandId/serenity/*` endpoints. The OpenAPI contract is in [`docs/openapi/serenity-api.yaml`](./openapi/serenity-api.yaml); this file covers what an operator needs to verify a deploy and onboard a customer.

## Architecture in one paragraph

api-service exposes nine endpoints that front the Adobe-hosted Semrush AIO API at `https://adobe-hackathon.semrush.com`. Authentication is IMS-bearer-only: the client sends an `Authorization: Bearer <ims_user_token>`, api-service forwards that header verbatim to Semrush, and the Adobe gateway exchanges the IMS token for Semrush's internal credential server-side. There are no Semrush cookies, API keys, or service accounts in api-service — every outbound request carries the caller's IMS user token. The brand-to-project mapping lives in the `brand_to_semrush_projects` table in mysticat-data-service; the Semrush workspace per org is read from `organizations.semrush_workspace_id` (already in place since PR #2403).

## Environment configuration

The proxy is configured via a single env var that is **required at runtime** — Lambda fails at first request if it is unset.

| Variable | Required | Source | Purpose |
|---|---|---|---|
| `SEMRUSH_PROJECTS_BASE_URL` | yes (no source default) | Vault `dx_mysticat/<env>/api-service`; locally `.env` | Upstream host for the Semrush AIO REST API. Must be `https://…`. Trailing slashes are stripped. Per-environment value so the production target can differ from the hackathon host without a code change. |

### Vault writes (dev / stage / prod)

```bash
export VAULT_ADDR=https://vault-amer.adobe.net
vault login -method=oidc   # opens browser

# value used for all three today; production target host may differ later
vault kv patch dx_mysticat/dev/api-service \
  SEMRUSH_PROJECTS_BASE_URL=https://adobe-hackathon.semrush.com
vault kv patch dx_mysticat/stage/api-service \
  SEMRUSH_PROJECTS_BASE_URL=https://adobe-hackathon.semrush.com
vault kv patch dx_mysticat/prod/api-service \
  SEMRUSH_PROJECTS_BASE_URL=https://adobe-hackathon.semrush.com

# verify (must export VAULT_ADDR — the CLI default is 127.0.0.1:8200)
export VAULT_ADDR=https://vault-amer.adobe.net
for ENV in dev stage prod; do
  echo "--- $ENV ---"
  vault kv get -field=SEMRUSH_PROJECTS_BASE_URL dx_mysticat/$ENV/api-service
done
```

The next `hedy --aws-update-secrets` deploy step ships the value through AWS Secrets Manager at `/helix-deploy/spacecat-services/api-service/latest`; the Lambda's `secrets` middleware then injects it into `context.env` on every cold start.

The IMS forwarding pipeline:

1. Caller hits `/v2/orgs/:spaceCatId/brands/:brandId/serenity/...` with `Authorization: Bearer <ims_user_token>`.
2. The existing `authWrapper` middleware in `src/index.js` validates the IMS token (caller identity, IMS org membership).
3. `SerenityController` calls `getImsUserToken(context)` from `src/support/utils.js` to extract the raw token, then builds a per-request `createSerenityTransport({ env, imsToken })` instance from `src/support/serenity/rest-transport.js`.
4. Every outbound `fetch` to Semrush carries `Authorization: Bearer ${imsToken}` plus `Accept: application/json` and `Content-Type: application/json`. No cookies, no `Auth-Data-Jwt`, no `User-Agent`.

If the caller omits the bearer, the controller returns `400 Missing Authorization header` before touching Semrush.

## Workspace resolution

Each request resolves the Semrush workspace from `organizations.semrush_workspace_id` for the `spaceCatId` path param:

```
src/support/serenity/workspace-resolver.js -> Organization.findById(spaceCatId).getSemrushWorkspaceId()
```

The resolver has a 5-minute in-memory LRU keyed by `spaceCatId` (including null workspaces, so non-onboarded orgs don't pay a DB round-trip on every call). If the org has no workspace set, the controller returns `404 Organization has no semrush_workspace_id`.

### Binding a workspace to an org

Use the existing admin `PATCH /organizations/:id`:

```bash
curl -X PATCH "${API_BASE}/organizations/${ORG_ID}" \
  -H "x-api-key: ${SPACECAT_ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"semrushWorkspaceId": "22222222-3333-4444-5555-666666666666"}'
```

The new workspace flows into the resolver cache on the next call.

## Serenity activation flag (org-wide rollout switch)

Binding a `semrush_workspace_id` no longer activates serenity by itself. The
whole `/serenity/*` surface is additionally gated on an **org-wide feature flag**
so the rollout can be decoupled from provisioning: an org (and its brands) can
have their `semrush_workspace_id` backfilled ahead of time while the customer UI
keeps reading the normal backend data, until the flag is flipped on per org.

- **Central predicate:** `isSerenityActiveForOrg(ctx, spaceCatId, log)` in
  `src/support/serenity/serenity-active.js` — the single source of truth, reused
  by the controller. It reads the flag (cached, mirroring the workspace resolver:
  5-minute positive TTL, 30-second negative TTL so an ON-flip propagates fast).
- **Flag identity:** `feature_flags` row keyed `(organization_id, product='LLMO',
  flag_name='serenity')`. Default **OFF** — a missing row, a `false` row, an
  unavailable PostgREST client, or a transient read error all resolve to inactive.
- **Effective gate = flag AND workspace.** The controller's `authorize` rejects
  the serenity surface with `404 Serenity is not active for this organization`
  when the flag is off (checked before brand resolution, so an inactive org never
  leaks brand existence); the existing workspace resolution supplies the "AND a
  Semrush workspace resolves" half. So serenity is served only when **both** the
  flag is on **and** a workspace resolves for the brand.

Flip the flag with the existing admin feature-flags endpoint:

```bash
# Activate serenity for an org
curl -X PUT "${API_BASE}/organizations/${ORG_ID}/feature-flags/llmo/serenity" \
  -H "x-api-key: ${SPACECAT_ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"value": true}'

# Deactivate (org falls back to the normal backend data)
curl -X DELETE "${API_BASE}/organizations/${ORG_ID}/feature-flags/llmo/serenity" \
  -H "x-api-key: ${SPACECAT_ADMIN_KEY}"
```

The org-level catalogue routes (`GET /serenity/models`, `GET /serenity/languages`,
without `:brandId`) are intentionally **not** gated — the add-brand wizard needs
them before a workspace (or the flag) exists.

### The flag also gates the serenity-adjusted brand endpoints

The same helper gates the Semrush **side-effects** on the v2 brand endpoints
(`src/controllers/brands.js`), so an inactive org operates as plain backend CRUD:

- `POST /v2/orgs/:org/brands` — a **Semrush-mode** create (`semrushMarket` /
  `generatePrompts`, i.e. one that would provision a sub-workspace) is rejected
  with `403 Serenity is not active for this organization` while the flag is off.
  A plain (flat) create is unaffected.
- `PATCH /v2/orgs/:org/brands/:brandId` — an edit that would **re-sync to
  Semrush** (URL / competitor / alias change on a brand that has a
  `semrush_workspace_id`) is rejected `403` while the flag is off, before the
  row is written. The same edit on a flat brand (no workspace) is a normal
  backend update.
- The brand **read** DTO is deliberately left alone: `semrushWorkspaceId` /
  `pendingSemrushProvisioning` are always returned as a faithful mirror of the
  row (the UI decides what to surface by reading the flag itself).
- `DELETE` and status-transition have no Semrush side-effect, so they are
  ungated.

## Endpoint surface

All endpoints require `Authorization: Bearer <ims_user_token>` and `organization:read` (GET) or `organization:write` (mutating) capability. The `:brandId` path param is UUID-only on this surface — name-based brand lookup is rejected with 400. The slice key for everything is `(brandId, geoTargetId, languageCode)`; the upstream workspace id and per-project upstream identifier are resolved server-side and never leak into request/response shapes.

| Method | Path | Purpose | OperationId |
|---|---|---|---|
| GET | `/serenity/prompts?geoTargetId=&languageCode=&page=&limit=&search=&tagIds=` | List prompts for one slice. geoTargetId and languageCode required. tagIds is repeatable (OR semantics, max 50). | `listSerenityPrompts` |
| POST | `/serenity/prompts` | Bulk create prompts grouped by (geoTargetId, languageCode); each input carries a non-empty `tagIds` (upstream ids, id-based write path). A `tags` (name-based) key is rejected with 400. | `createSerenityPrompts` |
| PATCH | `/serenity/prompts/:semrushPromptId` | Update a prompt; body carries slice + text + a non-empty `tagIds`. A `tags` (name-based) key is rejected with 400. | `updateSerenityPrompt` |
| POST | `/serenity/prompts/bulk-delete` | Delete prompts; body is `{ prompts: [{semrushPromptId, geoTargetId, languageCode}] }` | `bulkDeleteSerenityPrompts` |
| GET | `/serenity/markets` | List markets configured for the brand (incl. live `status`) | `listSerenityMarkets` |
| POST | `/serenity/markets` | Onboard a new (brand, geoTargetId, languageCode) slice | `createSerenityMarket` |
| DELETE | `/serenity/markets/:geoTargetId/:languageCode` | Remove a slice (idempotent; upstream-first, DB-second) | `deleteSerenityMarket` |
| GET | `/serenity/tags?geoTargetId=&languageCode=` | Unique tag names for one slice. Add `parentId` (present, even empty) to switch to the nested-tree read instead: `parentId=''` returns root categories with `childrenCount`, `parentId=<tagId>` returns that root's children with a `path` breadcrumb. | `listSerenityTags` |
| POST | `/serenity/tags` | Create/resolve a tag on one slice; body is `{ type, name, geoTargetId, languageCode, parentId? }`. `name` is always BARE — a `:` is rejected, as is a reserved dimension-root name. `type` names the dimension the value belongs to: `category` (open — customer-authored at any depth; `parentId` must be the `category` root or one of its descendants, and defaults to the root) or `intent`/`source`/`type` (closed — `name` must match the fixed enum, `parentId` is not allowed, resolve-before-create is idempotent, and the response is `200 { ..., created }` not `201`). | `createSerenityTag` |
| PATCH | `/serenity/tags/:tagId` | Rename and/or re-parent a tag by its upstream id. `name` is a bare value. `parentId`: an id RE-PARENTS within the tag's own dimension, omitted preserves the current parent, and an explicit `null` is rejected — the root level is reserved for the four dimension roots. The new parent may be neither the tag itself nor one of its descendants (400): upstream stores a parent pointer rather than a tree and would accept the edge, leaving the tag's subtree reachable from no root, and so unreachable and unrepairable through this API. The proxy always re-sends a parent upstream, because a PATCH that omits one promotes the tag to a root. A dimension root (400), a closed dimension's value (400), and an unknown id (404 `tagNotFound`) are all refused. | `updateSerenityTag` |
| GET | `/serenity/models?geoTargetId=&languageCode=` | AI models for one slice (catalog mode when no params) | `listSerenityModels` |
| PUT | `/serenity/models` | Replace the AI-model set for one slice (publishes after change) | `updateSerenityModels` |
| POST | `/serenity/activate` | Activate the brand into sub-workspace mode (ensure sub-workspace + publish supplied markets) | `activateSerenityBrand` |
| POST | `/serenity/deactivate` | Deactivate: decommission the sub-workspace + disconnect the brand back to flat mode | `deactivateSerenityBrand` |

The above are prefixed with `/v2/orgs/:spaceCatId/brands/:brandId`.

Two **org-level** catalogue routes are brand-independent (prefixed with `/v2/orgs/:spaceCatId`, no `:brandId`) and are used to populate UI selectors before any brand/market exists:

| Method | Path | Purpose | OperationId |
|---|---|---|---|
| GET | `/serenity/models` | Global AI-model catalog (`GET /v1/ai_models`) | `listSerenityOrgModels` |
| GET | `/serenity/languages` | Supported Semrush language catalog (`GET /v1/languages`) | `listSerenityOrgLanguages` |

## The onboarding flow

`POST /serenity/markets` writes a row to `brand_to_semrush_projects` **only after both upstream calls succeed**. The order is strict and the `findBySlice` 409 gate runs before any upstream call so safe retries are free:

```
1. validate body                                  -> 400 on missing/invalid fields
2. resolveLocation(market) via iso-3166           -> 400 on unknown market
3. findBySlice(brand, geoTargetId, languageCode)  -> 409 if a row already exists
4. resolveLanguageId(languageCode) via cached     -> 400 if language not in catalog
   `/v1/languages`
5. POST /v1/workspaces/{ws}/projects              -> 502 envelope on upstream error
6. POST .../publish                               -> 502 envelope, no row written
7. BrandSemrushProject.create({...})              -> 201 with the new market
```

If step 5 or 6 fails, no row is written and the caller may safely retry with the same body. The 409 gate catches the case where a previous attempt succeeded both upstream calls but failed the DB write — extremely unlikely in practice; covered by the integration tests in `test/it/`.

## Delete-market semantics

`DELETE /serenity/markets/:geoTargetId/:languageCode` removes a slice from the brand. Upstream support was verified 2026-05-28 against `adobe-hackathon.semrush.com`:

```
OPTIONS /v1/workspaces/{ws}/projects/{pid} → 405, allow: DELETE, GET, PATCH
DELETE  /v1/workspaces/{ws}/projects/<bogus> → 404 {"message":"not found"}
```

Ordering (mirrors the create flow in reverse):

```
1. findBySlice(brand, geoTargetId, languageCode)  -> 204 if no row (idempotent)
2. transport.deleteProject(ws, upstreamProjectId) -> 204 on success
                                                   -> treat upstream 404 as success
                                                   -> 502 envelope on non-404 failure (row stays)
3. row.remove()                                    -> 204 on success
                                                   -> 500 on failure (operator retries; step 2 idempotent)
```

The DELETE is **not soft**. The UI must confirm with the user before invoking — the linked upstream project (and all its prompts) is permanently destroyed.

## SpaceCat Site mirroring (`brand_sites`)

For backwards compatibility and integrations, every Semrush market (project) is mirrored as a SpaceCat **Site** on our side. The domain model is the key thing to hold onto:

- A **brand is a shell** with **no domain of its own** — like its Semrush sub-workspace. **Each market has its own primary URL/domain**, and that domain maps to a single Site (global `sites.base_url` uniqueness ⇒ at most one Site per domain). A brand whose markets span distinct domains therefore owns several market Sites.
- The Site is linked to the owning brand via a **`brand_sites` row tagged `type='serenity'`** (`src/support/serenity/site-linkage.js` → `ensureMarketSite`; the marker names the owning feature, not the provider). The marker is load-bearing:
  - **`syncBrandSites` preserves it.** That function rebuilds `brand_sites` from `brand.urls` on every brand edit (delete-all-then-reinsert). A market's domain is generally **not** in `brand.urls`, so an unmarked row would be silently deleted on the next edit. The marker excludes these rows from the delete and keeps their type from being downgraded on re-upsert.
  - **`mapDbBrandToV2` excludes it.** A market's domain is not a brand URL, so `type='serenity'` rows never surface in the brand V2 response (`urls[]` / `siteIds`). Integrations resolve them via the `sites` / `brand_sites` tables directly.
- **Lifecycle:** the Site (+ link) is ensured on **brand creation** (the provisioned domain), **activation** (the activated markets' domain), and **market creation in sub-workspace mode** (that market's domain — `ensureMarketSite` runs only on the `subworkspace` branch of `POST /serenity/markets`). A **flat-mode** brand is **not** mirrored on market creation; it gets a Site only once activation promotes it to sub-workspace mode. The Site is **never auto-deleted** — market deletion leaves the Site and its link in place. A market-mirror site's **`baseURL` is immutable at the API**: a `PATCH /sites` that changes it is rejected (the domain is the Semrush project anchor; `isSemrushMarketMirrorSite` gates the guard).
- **Best-effort, except on activation:** on the brand-create and market-create paths the Semrush project is the primary outcome and has already succeeded when mirroring runs, so a Site/link failure is logged and swallowed (never fails a live market). On **activation** the link is instead a **required** step — if the markets are live but the mirror fails, the brand stays `pending` and returns 502 (see Activate below). `Site.create` uses `deliveryType: 'other'` (not an AEM target).

## Activate / deactivate (sub-workspace dual-mode)

A brand runs in one of two modes, decided entirely by `brands.semrush_workspace_id`:
- **flat** (pointer NULL): markets resolve through the shared org parent workspace via the `BrandSemrushProject` mapping.
- **subworkspace** (pointer set): the brand has its own Semrush sub-workspace; markets resolve live from it via `listProjects`.

`POST /serenity/activate` moves a brand into sub-workspace mode. Two shapes:

- **Sub-workspace-only (no resolved `brandDomain`):** a brand with no primary URL
  has nothing to provision a project against, so activate only ensures the
  sub-workspace (which IS the active-brand anchor) and flips the brand active —
  **HTTP 200 with an empty `markets[]`**, no project, no Site mirror. The user
  adds markets later from the Markets tab. `generatePrompts` is rejected here
  (no project to attach prompts to). NOTE: this is the only path that does NOT
  require `brandDomain` — see the resolution rules below.
- **Project activation (resolved `brandDomain`):**

```
1. ensure the sub-workspace ONCE for the whole batch (create + settle, or re-grant)
2. for each market (resolved below; empty -> a single US/en fallback project):
   create-or-resume a draft project, attach models + generated topic prompts +
   brand URLs + competitor benchmarks, then publish
3. mirror every live market as a Site + brand_sites row (type='serenity')
4. ALL-OR-NOTHING: set brands.status = 'active' ONLY when EVERY market is live
   AND the brand_sites mirror succeeded. If any step fails, a pending brand
   STAYS pending (stash + workspace pointer left intact for an idempotent retry).
```

All markets in one activate batch share the single resolved `brandDomain`, so
they collapse to one Site mirror; the all-or-nothing site-link guarantee is
therefore satisfied by that one mirror. (Distinct-domain markets under one brand
are not produced by this path today; if that changes, step 4 must require a
linked Site per distinct market domain.)

- Body: `{ brandDomain?, brandNames?, brandDisplayName?, markets?: [{ market, languageCode, name? }] }`. **All body fields are optional** (the schema no longer marks any required): a pending-draft activation can send an empty body and resolve everything from the stash (see below). `markets` is **capped at 50** (400 above that) — each market is a sequential upstream create+publish.
- **Deferred-provisioning fallback (pending/draft brands).** `markets` and `brandDomain` are optional in the body: a brand saved via the wizard's "Save as pending" path carries its intended market(s) and primary URL in `brands.pending_semrush_provisioning`. When the body omits them, activate falls back to the stash — `markets` come from `pendingSemrushProvisioning.markets`, and `brandDomain` is derived from `pendingSemrushProvisioning.primaryUrl` (hostname only, via the shared `hostnameFromUrlString`). The body always wins when both are present. Resolution rules after the fallback:
  - **No URL/domain supplied at all** (neither body nor stash): the brand activates **sub-workspace-only** (HTTP 200, empty `markets[]`, no project) — see the sub-workspace-only shape above. This is NOT a 400.
  - **A URL/domain was supplied but did not resolve to a hostname**: 400 (`brandDomain is required to provision a Semrush market`) — a typo must not silently strand the user with a project-less brand.
  - **`markets` empty after resolution** (but `brandDomain` resolved): a single `US`/`en` fallback project is provisioned (matching the direct-create default). There is no longer a 400 for empty `markets`.
- **Stash lifecycle.** The deferred-provisioning stash is cleared (column set to `null`) **only on a fully-succeeded activation** (every market live AND the brand_sites mirror linked), saved atomically with the `active` flip. If any market fails — or every market is live but the site mirror fails — a pending brand STAYS pending and its stash (with the primaryUrl) is left intact for an idempotent retry; live markets return 409 `sliceExists` on the retry and the site-link + stash-clear re-run.
- Response: **200** when fully succeeded (pending brand flips to `active`). **502 `serenityActivationIncomplete`** when a *pending* brand's activation did not complete every step — any market failed, OR all markets are live but the `brand_sites` mirror failed; the brand stays `pending` and `markets[]` carries the per-market outcomes for a retry. **207 Multi-Status** applies ONLY to an *already-active* brand re-supplying markets where at least one fails — the brand is never downgraded and stays `active`.
- Idempotent: a market already live upstream returns 409 `sliceExists` and still counts as live, so a full re-activate of an already-live brand is a 200.

`POST /serenity/deactivate` moves a brand back to flat mode:

```
1. decommission the sub-workspace: delete EVERY project + release the allocation
   back to the parent pool
2. clear brands.semrush_workspace_id (disconnect → flat mode)
3. set brands.status = 'pending'
```

**Caveats operators must know:**
- **Deactivate is destructive, not a pause.** It deletes every project in the sub-workspace (all markets, prompts, benchmarks, competitors). There is **no stored market memory**: a later activate must re-supply the markets and rebuilds everything from scratch. Reactivation does NOT restore the prior data.
- **The sub-workspace shell is never deleted** (deletion is fail-closed behind `SERENITY_ALLOW_WORKSPACE_DELETE`, unset in every deployed env). Deactivate empties it and releases its allocation; the empty shell remains in the parent family and is reclaimed only by Semrush CS. A future activate allocates a fresh sub-workspace.
- **`status = 'pending'` is overloaded.** A deactivated brand and a never-finished onboarding both read `pending`; downstream consumers cannot distinguish "off by choice" from "incomplete" on status alone.
- **IMS-user only.** activate/deactivate (and all `/serenity/*`) require an IMS user token; a non-IMS S2S consumer is refused (401). There is no backend/automation path to activate a Semrush brand today.

## Prompt id semantics

`SerenityPrompt.semrushPromptId` is the upstream prompt UUID. The name carries the `semrush` prefix because the value genuinely IS Semrush's identifier — pretending otherwise (calling it `id`) would be misleading. The id changes whenever the prompt is re-created upstream (which happens on every PATCH — see `handleUpdatePrompt`); clients should refetch after a PATCH and use the new id.

## Error envelopes

| Status | Shape | Trigger |
|---|---|---|
| 400 | `{ error: "missingFields" | "invalidRequest" | "unknownMarket" | "unknownLanguage", message, ... }` | Validation failure (incl. non-UUID `:brandId`, missing required GET filters) before any upstream call |
| 404 | `{ message: "Organization has no semrush_workspace_id" }` or `{ error: "marketNotFound" | "promptNotFound" }` | Missing workspace, no `BrandSemrushProject` row for the slice, or upstream prompt id not in the slice |
| 409 | `{ error: "sliceExists", message }` | `findBySlice` returned a row before the upstream call |
| 502 | `{ error: "serenityUpstreamError", message }` | Upstream returned a non-2xx; provider-specific detail is logged server-side, not echoed to the client |
| 500 | `{ message }` | Unexpected error; logged with stack via `log.error` |

`SerenityTransportError` from `src/support/serenity/rest-transport.js` carries the upstream `status` and `body` for server-side logging; the 502 envelope deliberately does not echo provider details.

## Observability (Splunk)

Outbound calls to Semrush, plus the controller's 502/500 paths, ship to Splunk (index `dx_aem_engineering`, sourcetype `dx_aem_sites_spacecat_backend_<env>`, `service=api-service`). Coralogix has been retired platform-wide; use Splunk (or CloudWatch as a fallback). To verify a deploy after changes, run this SPL:

```spl
index=dx_aem_engineering sourcetype=dx_aem_sites_spacecat_backend_<env> service=api-service "semrush" | head 50
```

Greppable failure tokens worth alerting on: `SERENITY_MARKET_LINK_REJECTED` (the `brand_sites.type='serenity'` migration is not deployed in the env — every market create/activate then produces a Semrush project + Site with no link), `SERENITY_ACTIVATE_LINK_INCOMPLETE` (markets live upstream but the brand stayed pending because the site mirror failed), and `SERENITY_ACTIVATE_SAVE_DIVERGENCE` / `SERENITY_DEACTIVATE_SAVE_DIVERGENCE` (upstream succeeded but the status/pointer persist failed).

Expected fields in the structured log payload:
- outbound host: `adobe-hackathon.semrush.com`
- outbound auth: `Authorization: Bearer ...` (the token itself is redacted by the platform)
- the IMS sub of the caller in the `actor` field

## Dynamic AI resource allocation — operations (LLMO-6191)

The JIT top-up allocator (`SERENITY_DYNAMIC_ALLOCATION`, default OFF — see
`src/support/serenity/dynamic-allocation-active.js`) has its own operational surface, separate from
the request-path proxy documented above:

- **Metrics/SLIs:** `src/support/serenity/allocation-metrics.js` emits CloudWatch EMF metrics
  (namespace `Mysticat/SerenityAllocation`) — pool-free ratio, top-up latency, rejection/retry/
  release-outcome counters, and the hot-path (topped-up vs not) ratio. See that file's module doc
  for the full catalog and the pager-worthy/dashboard-only split.
- **Zombie-workspace recovery:** see
  [`docs/runbooks/serenity-zombie-workspace-recovery.md`](./runbooks/serenity-zombie-workspace-recovery.md)
  for diagnosing and recovering a sub-workspace stuck `workspaceBusy` after a partially-applied
  transfer, and for the alerting/paging guidance.
- **Rightsizing sweep:** `scripts/serenity-rightsizing-sweep.mjs` is a one-time backfill that
  lowers already-carved sub-workspaces (brands onboarded before the JIT allocator shipped) down to
  their actual usage, using `releaseAiSurplus` as the reclaim primitive. Run `--dry-run` first —
  see the script's own header comment for full usage and the auth caveat (requires an operator
  IMS token; there is no service-account path to Semrush in this repo).
- **Cross-container serialization:** `src/support/serenity/resource-lock.js` only serializes
  same-container contention. The cross-container gap and the options considered for closing it are
  recorded in
  [`docs/decisions/007-cross-container-resource-lock.md`](./decisions/007-cross-container-resource-lock.md).

## Dev environment smoke tests

After the api-service feature branch deploys to dev, exercise the surface against `https://spacecat.experiencecloud.live/api/ci`.

```bash
export API_BASE=https://spacecat.experiencecloud.live/api/ci
export ORG_ID=<dev-org-uuid>
export BRAND_ID=<dev-brand-uuid>   # MUST be a UUID; name-based lookup returns 400 on /serenity/*
export IMS=$(mysticat auth token --env dev)
```

Happy-path walkthrough:

```bash
# 1) List markets (empty for a fresh brand)
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/markets" | jq .

# 2) Onboard a (US, en) slice. `name` is optional; default is `<brand>-<6 hex>`.
curl -s -H "Authorization: Bearer ${IMS}" -H 'Content-Type: application/json' \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/markets" \
  -d '{ "market": "US", "languageCode": "en", "brandDomain": "adobe.com", "brandNames": ["Adobe"] }' | jq .

# 3) Bulk-create prompts in that slice. Prompts carry tags by UPSTREAM ID
#    (`tagIds`); a name-based `tags` key is rejected with 400. Resolve an id from
#    a POST /serenity/tags first (a category hangs off the `category` root).
TAG_ID=$(curl -s -H "Authorization: Bearer ${IMS}" -H 'Content-Type: application/json' \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/tags" \
  -d '{ "type": "category", "name": "Product", "geoTargetId": 2840, "languageCode": "en" }' | jq -r .id)

curl -s -H "Authorization: Bearer ${IMS}" -H 'Content-Type: application/json' \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/prompts" \
  -d "{ \"prompts\": [ { \"text\": \"What is Adobe Photoshop?\", \"geoTargetId\": 2840, \"languageCode\": \"en\", \"tagIds\": [\"${TAG_ID}\"] } ] }" | jq .

# 4) List prompts (filters are REQUIRED — 400 without them)
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/prompts?geoTargetId=2840&languageCode=en" | jq .

# 5) Tags + models for the slice
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/tags?geoTargetId=2840&languageCode=en" | jq .
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/models?geoTargetId=2840&languageCode=en" | jq .

# 6) Cleanup — DELETE market handles upstream + DB row, idempotent on 404
curl -s -X DELETE -H "Authorization: Bearer ${IMS}" \
  -o /dev/null -w '%{http_code}\n' \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/markets/2840/en"
# Expect 204 (success or already-gone). No separate upstream/DB cleanup needed.
```

Negative-path checks worth covering: non-UUID `:brandId` → 400 `invalidRequest`; missing `geoTargetId` or `languageCode` on a list → 400; org without `semrush_workspace_id` → 404; duplicate market POST → 409 `sliceExists`.

After the walkthrough, verify Splunk has the outbound traces:

```spl
index=dx_aem_engineering sourcetype=dx_aem_sites_spacecat_backend_<env> service=api-service "adobe-hackathon.semrush.com" | head 30
```

Expected: outbound host `adobe-hackathon.semrush.com`, IMS sub of the caller in `actor`, no `SerenityTransportError` entries beyond the deliberate 404/409 cases above.

## Troubleshooting

| Symptom | Likely cause | Verification |
|---|---|---|
| All `/serenity/*` endpoints return `503 configurationError` with `SEMRUSH_PROJECTS_BASE_URL is not set` | The env var is missing from the deployed Lambda secrets (Vault write skipped, or a new env wasn't seeded) | `aws secretsmanager get-secret-value --secret-id /helix-deploy/spacecat-services/api-service/latest` should include `SEMRUSH_PROJECTS_BASE_URL`. Fix via `vault kv patch dx_mysticat/<env>/api-service SEMRUSH_PROJECTS_BASE_URL=https://…` then re-deploy. |
| `createSerenityMarket` 400s with `unknownMarket` for ISO codes the rest of the platform accepts (`XK`, certain reserved or user-assigned codes) | `resolveLocation` reads from `iso31661Alpha2ToNumeric`, which only carries codes with an official ISO 3166-1 numeric (`XK`/Kosovo, for instance, has none) — so the formula `2000 + numeric` can't be applied | Known limitation. Kosovo's real Google Ads Geo Target ID is `2061632` (not a country-prefix value); supporting it cleanly requires the sub-national geo path (Semrush location-search endpoint or the Google geotargets CSV — see the TODO in `resolveLocation`). |
| Every endpoint 500s with `Cannot read property 'allByBrandId' of undefined` | api-service was deployed before `@adobe/spacecat-shared-data-access` published the `BrandSemrushProject` entity | `npm ls @adobe/spacecat-shared-data-access` on the lambda container; needs `>= 3.67.0` |
| All endpoints 404 with `Organization has no semrush_workspace_id` | The org never had `semrushWorkspaceId` set; or the LRU cache is stale from before it was set | Wait 5 min for the cache TTL, or restart the lambda container; verify via `GET /organizations/:id` |
| `createSerenityMarket` returns 400 `unknownLanguage` | The language tag isn't in Semrush's `/v1/languages` catalog response | The cache is module-scoped and lives for 1 h; if a new language landed in Semrush, restart the lambda or wait for the TTL |
| `listSerenityPrompts` returns `total: 0` immediately after create | Semrush publishes asynchronously; the prompt isn't queryable yet | Retry after ~5 s; if still empty, check the upstream Splunk logs for a publish failure |
| Splunk shows `Auth-Data-Jwt` or `Cookie` in the outbound headers | Stale Lambda container running pre-PR 2456 code | Re-deploy; the Phase 4 transport explicitly drops both branches |
