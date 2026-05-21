# Semrush AIO proxy — operator guide

This document is the runtime reference for the `/v2/orgs/:spaceCatId/brands/:brandId/semrush/*` endpoints. The OpenAPI contract is in [`docs/openapi/semrush-api.yaml`](./openapi/semrush-api.yaml); this file covers what an operator needs to verify a deploy and onboard a customer.

## Architecture in one paragraph

api-service exposes nine endpoints that front the Adobe-hosted Semrush AIO API at `https://adobe-hackathon.semrush.com`. Authentication is IMS-bearer-only: the client sends an `Authorization: Bearer <ims_user_token>`, api-service forwards that header verbatim to Semrush, and the Adobe gateway exchanges the IMS token for Semrush's internal credential server-side. There are no Semrush cookies, API keys, or service accounts in api-service — every outbound request carries the caller's IMS user token. The brand-to-project mapping lives in the `brand_to_semrush_projects` table in mysticat-data-service; the Semrush workspace per org is read from `organizations.semrush_workspace_id` (already in place since PR #2403).

## Environment configuration

No new env vars. The proxy reads:

| Variable | Default | Purpose |
|---|---|---|
| `SEMRUSH_PROJECTS_BASE_URL` | `https://adobe-hackathon.semrush.com` | Override target host (used in tests; left default in dev/stage/prod) |

The IMS forwarding pipeline:

1. Caller hits `/v2/orgs/:spaceCatId/brands/:brandId/semrush/...` with `Authorization: Bearer <ims_user_token>`.
2. The existing `authWrapper` middleware in `src/index.js` validates the IMS token (caller identity, IMS org membership).
3. `SemrushController` calls `getImsUserToken(context)` from `src/support/utils.js` to extract the raw token, then builds a per-request `createSemrushTransport({ env, imsToken })` instance from `src/support/semrush/rest-transport.js`.
4. Every outbound `fetch` to Semrush carries `Authorization: Bearer ${imsToken}` plus `Accept: application/json` and `Content-Type: application/json`. No cookies, no `Auth-Data-Jwt`, no `User-Agent`.

If the caller omits the bearer, the controller returns `400 Missing Authorization header` before touching Semrush.

## Workspace resolution

Each request resolves the Semrush workspace from `organizations.semrush_workspace_id` for the `spaceCatId` path param:

```
src/support/semrush/workspace-resolver.js -> Organization.findById(spaceCatId).getSemrushWorkspaceId()
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

## Endpoint surface

All endpoints require `Authorization: Bearer <ims_user_token>` and `organization:read` (GET) or `organization:write` (mutating) capability.

| Method | Path | Purpose | OperationId |
|---|---|---|---|
| GET | `/semrush/prompts` | List prompts across every project mapped to the brand | `listSemrushPrompts` |
| POST | `/semrush/prompts` | Bulk create prompts grouped by (semrushLocationId, language) | `createSemrushPrompts` |
| PATCH | `/semrush/prompts/:promptId` | Update a prompt by its logical id | `updateSemrushPrompt` |
| POST | `/semrush/prompts/bulk-delete` | Delete prompts by Semrush ids | `bulkDeleteSemrushPrompts` |
| GET | `/semrush/projects` | List `brand_to_semrush_projects` rows enriched with live metadata | `listSemrushProjects` |
| POST | `/semrush/projects` | Onboard a new (brand, market, language) slice | `createSemrushProject` |
| GET | `/semrush/projects/:workspaceId/:projectId/tags` | Unique tag names in a project | `listSemrushProjectTags` |
| GET | `/semrush/projects/:workspaceId/:projectId/models` | AI models configured for a project | `listSemrushProjectModels` |
| GET | `/semrush/workspaces/:workspaceId/projects` | All projects in a workspace | `listSemrushWorkspaceProjects` |

All paths are prefixed with `/v2/orgs/:spaceCatId/brands/:brandId`.

## The onboarding flow

`POST /semrush/projects` writes a row to `brand_to_semrush_projects` **only after both Semrush calls succeed**. The order is strict and the `findBySlice` 409 gate runs before any upstream call so safe retries are free:

```
1. validate body                              -> 400 on missing/invalid fields
2. resolveLocation(market) via locations.json -> 400 on unknown market
3. findBySlice(brand, locationId, language)   -> 409 if a row already exists
4. resolveLanguageId(language) via cached     -> 400 if language not in catalog
   `/v1/languages`
5. POST /v1/workspaces/{ws}/projects          -> 502 envelope on upstream error
6. POST .../publish                           -> 502 envelope, no row written
7. BrandSemrushProject.create({...})          -> 201 with the new row
```

If step 5 or 6 fails, no row is written and the caller may safely retry with the same body. The 409 gate catches the case where a previous attempt succeeded both upstream calls but failed the DB write — extremely unlikely in practice; covered by the integration tests in `test/it/`.

## Logical prompt id

`SemrushPrompt.id` is a `base64url(JSON({b, l, lang, t}))` string where:

| key | meaning |
|---|---|
| `b` | brand UUID |
| `l` | `semrush_location_id` (Google Ads Geo Target ID) |
| `lang` | lowercase BCP 47-shaped language tag |
| `t` | prompt text |

It is opaque to clients but `decodeLogicalId` in `src/support/semrush/handlers/prompts.js` reverses it. The id is stable across Semrush re-creates (re-creating the prompt yields the same logical id even when the underlying `semrushId` changes).

## Error envelopes

| Status | Shape | Trigger |
|---|---|---|
| 400 | `{ error: "missingFields" | "invalidRequest" | "unknownMarket" | "unknownLanguage" | "invalidLogicalId", message, ... }` | Validation failure before any upstream call |
| 404 | `{ message: "Organization has no semrush_workspace_id" }` or `{ error: "projectNotFound" }` | Missing workspace or no `BrandSemrushProject` row for the slice |
| 409 | `{ error: "sliceExists", semrushProjectId, message }` | `findBySlice` returned a row before the upstream call |
| 502 | `{ error: "semrushUpstreamError", status, message, body }` | Semrush returned a non-2xx; `status` is the upstream HTTP status, `body` is its parsed JSON |
| 500 | `{ message }` | Unexpected error; logged with stack via `log.error` |

`SemrushTransportError` from `src/support/semrush/rest-transport.js` carries `status` and `body` so the 502 envelope reflects what Semrush actually said.

## Observability (Coralogix)

Outbound calls to Semrush, plus the controller's 502/500 paths, log to Coralogix under `applicationname=spacecat-services--api-service`. To verify a deploy after changes, query:

```bash
coralogix-query --from 30m \
  "source logs | filter \$l.applicationname == 'spacecat-services--api-service' && \$d.message ~ 'semrush' | limit 50"
```

Expected fields in the structured log payload:
- outbound host: `adobe-hackathon.semrush.com`
- outbound auth: `Authorization: Bearer ...` (the token itself is redacted by the platform)
- the IMS sub of the caller in the `actor` field

## Phase 7 — dev environment end-to-end smoke tests

Run these after the api-service feature branch deploys to dev. Each command shows the curl invocation, what to assert, and what to do on failure.

### Prerequisites

1. **An IMS token**: `IMS=$(mysticat auth token --env dev)` (requires `mysticat login` first).
2. **A dev org with `semrush_workspace_id` set**. Either pick a dev workspace Semrush provisions for the team, or temporarily bind the adobe.com migration workspace `c522f571-76e9-42e5-9213-7a767f448453` to a dev test org via `PATCH /organizations/:id` (cleanup at the end).
3. **A brand under that org**. Note the brand UUID.
4. Export the convenience env vars (all 7 calls reuse them):
   ```bash
   export API_BASE=https://spacecat.experiencecloud.live/api/ci
   export ORG_ID=<dev-org-uuid>
   export BRAND_ID=<dev-brand-uuid>
   export WORKSPACE_ID=<workspace-uuid-bound-to-org>
   export IMS=<ims-bearer>
   ```

### Test 1 — IMS bearer missing returns 400

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/projects"
```

Expected: `400`. Confirms `authWrapper` doesn't admit anonymous requests for these paths.

### Test 2 — Org without semrush_workspace_id returns 404

Pick an org you know has no workspace bound (any non-onboarded dev org). With a valid IMS token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/<org-without-workspace>/brands/${BRAND_ID}/semrush/projects"
```

Expected: `404`. Body shape:
```json
{ "message": "Organization has no semrush_workspace_id" }
```

### Test 3 — List projects (empty initially)

```bash
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/projects" | jq .
```

Expected: `200` with `{ "items": [] }` for a brand that has no Semrush projects yet. Validates the DB query path and the resolver cache without depending on any upstream success.

### Test 4 — Onboard a slice (US/en) and capture the project id

```bash
RESP=$(curl -s -H "Authorization: Bearer ${IMS}" \
  -H "Content-Type: application/json" \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/projects" \
  -d '{
    "name": "Smoke test — US/en",
    "market": "US",
    "language": "en",
    "brandDomain": "adobe.com",
    "brandNames": ["Adobe", "Adobe Inc."]
  }')
echo "$RESP" | jq .
export PROJECT_ID=$(echo "$RESP" | jq -r .semrushProjectId)
```

Expected: `201` and a `SemrushCreateProjectResponse` body:
```json
{
  "semrushProjectId": "<uuid>",
  "semrushLocationId": 2840,
  "language": "en",
  "name": "Smoke test — US/en",
  "workspaceId": "<workspace-uuid>"
}
```

A row in `brand_to_semrush_projects` lands with these fields. **On failure:** check that the language `"en"` resolves to a UUID in Semrush's `/v1/languages` catalog and that the dev token has the org membership the workspace expects.

### Test 5 — Duplicate slice returns 409 (idempotency check)

Re-run test 4 verbatim:

```bash
curl -s -o /tmp/resp.json -w '%{http_code}\n' \
  -H "Authorization: Bearer ${IMS}" \
  -H "Content-Type: application/json" \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/projects" \
  -d '{
    "name": "Smoke test — US/en",
    "market": "US",
    "language": "en",
    "brandDomain": "adobe.com",
    "brandNames": ["Adobe", "Adobe Inc."]
  }'
cat /tmp/resp.json | jq .
```

Expected: `409` and `{"error":"sliceExists","semrushProjectId":"<same-id-as-test-4>","message":"..."}`. Confirms `findBySlice` runs before the upstream call.

### Test 6 — Bulk-create three prompts in the slice and publish

```bash
curl -s -H "Authorization: Bearer ${IMS}" \
  -H "Content-Type: application/json" \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/prompts" \
  -d "$(jq -n --arg loc 2840 '{
    prompts: [
      { text: "What is Adobe Photoshop?", semrushLocationId: ($loc|tonumber), language: "en", tags: ["product"] },
      { text: "How does Adobe Acrobat compare to Foxit?", semrushLocationId: ($loc|tonumber), language: "en", tags: ["comparison"] },
      { text: "Best Adobe Creative Cloud plan for freelancers?", semrushLocationId: ($loc|tonumber), language: "en" }
    ]
  }')" | jq '{created_count: (.created|length), skipped_count: (.skipped|length), failed_count: (.failed|length)}'
```

Expected: `200`, `created_count = 3`, both `skipped_count` and `failed_count` = 0. Then immediately query the list endpoint to confirm fan-out + publish made them visible (Semrush publishes asynchronously, retry once after a few seconds if list shows empty):

```bash
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/prompts?limit=10" \
  | jq '{total, item_texts: (.items|map(.text))}'
```

### Test 7 — Tags + models + workspace projects from path params

```bash
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/projects/${WORKSPACE_ID}/${PROJECT_ID}/tags" \
  | jq '{tag_count: (.items|length), tag_names: (.items|map(.name))}'

curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/projects/${WORKSPACE_ID}/${PROJECT_ID}/models" \
  | jq '{model_count: (.models|length), keys: (.models|map(.key))}'

curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/workspaces/${WORKSPACE_ID}/projects" \
  | jq '{project_count: (.projects|length), names: (.projects|map(.name))}'
```

Expected: each returns `200` with a non-empty response shape that matches its OpenAPI schema. Tags should include `product` and `comparison` from test 6. Models should include at least `gpt-4o` if the workspace is configured against OpenAI.

### Observability check

After all 7 tests:

```bash
coralogix-query --from 15m \
  "source logs | filter \$l.applicationname == 'spacecat-services--api-service' && \$d.message ~ 'adobe-hackathon.semrush.com' | limit 30"
```

Confirm outbound requests are going to the right host, the IMS sub matches the caller in the structured `actor` field, and there are no `SemrushTransportError` entries (other than the expected 404/409 from tests 2 and 5).

### Cleanup

Smoke tests provision **two** resources that need teardown: the prompts/project on Semrush's side and the `brand_to_semrush_projects` row on our side. Delete both — otherwise the shared hackathon workspace accumulates test stubs.

```bash
# 1. Delete the test prompts (collect {semrushProjectId, semrushPromptId} pairs
#    from test 6's response)
curl -s -H "Authorization: Bearer ${IMS}" \
  -H "Content-Type: application/json" \
  -X POST "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/semrush/prompts/bulk-delete" \
  -d '{"semrushIds": [<list of {semrushProjectId, semrushPromptId} from test 6>]}'

# 2. Delete the upstream Semrush project so it doesn't linger in the
#    workspace. Use the project id returned by test 2's createProject call.
#    Replace ${WS_ID} with the workspace id from test 2's response.
curl -X DELETE "https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WS_ID}/projects/${SEMRUSH_PROJECT_ID}" \
  -H "Authorization: Bearer ${IMS}"

# 3. Delete the brand_to_semrush_projects row (PostgREST direct — no proxy
#    endpoint deletes it today; coordinate with mysticat-data-service oncall).
#    Use the same (brand_id, semrush_location_id, language) you onboarded.
# (See follow-up: ticket TBD for a proxy DELETE /semrush/projects/:id.)

# 4. If you bound a temporary workspace to the org in step 1, unbind it:
curl -X PATCH "${API_BASE}/organizations/${ORG_ID}" \
  -H "x-api-key: ${SPACECAT_ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"semrushWorkspaceId": null}'
```

## Troubleshooting

| Symptom | Likely cause | Verification |
|---|---|---|
| Every endpoint 500s with `Cannot read property 'allByBrandId' of undefined` | api-service was deployed before `@adobe/spacecat-shared-data-access` published the `BrandSemrushProject` entity | `npm ls @adobe/spacecat-shared-data-access` on the lambda container; needs `>= 3.67.0` |
| All endpoints 404 with `Organization has no semrush_workspace_id` | The org never had `semrushWorkspaceId` set; or the LRU cache is stale from before it was set | Wait 5 min for the cache TTL, or restart the lambda container; verify via `GET /organizations/:id` |
| `createSemrushProject` returns 400 `unknownLanguage` | The language tag isn't in Semrush's `/v1/languages` catalog response | The cache is module-scoped and lives for 1 h; if a new language landed in Semrush, restart the lambda or wait for the TTL |
| `listSemrushPrompts` returns `total: 0` immediately after create | Semrush publishes asynchronously; the prompt isn't queryable yet | Retry after ~5 s; if still empty, check the upstream Coralogix logs for a publish failure |
| Coralogix shows `Auth-Data-Jwt` or `Cookie` in the outbound headers | Stale Lambda container running pre-PR #2456 code | Re-deploy; the Phase 4 transport explicitly drops both branches |
