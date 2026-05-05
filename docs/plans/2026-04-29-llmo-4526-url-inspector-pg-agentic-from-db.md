# LLMO-4526: URL Inspector PG — Agentic Data from PostgreSQL (API Changes)

**Ticket:** [LLMO-4526](https://jira.corp.adobe.com/browse/LLMO-4526)
**Branch:** `feat/url-inspector-pg-migrate-agentic-LLMO-4526`
**Full working notes:** `mysticat-data-service/docs/plans/2026-04-29-llmo-4526-url-inspector-pg-agentic-from-db.md`

PRs:
- adobe/mysticat-data-service#490
- adobe/spacecat-api-service#2290 (this repo)
- adobe/project-elmo-ui#1640

---

## What Changed in This Repo

Forwarded a new `agentTypes` query parameter from the agentic-traffic and URL Inspector owned-URLs endpoints to the corresponding mysticat RPCs (which gained an additive `p_agent_types TEXT[]` parameter — see #490). Existing callers without `agentTypes` are unaffected.

The URL Inspector owned-URLs endpoint additionally now exposes two new per-row fields, `agenticHits` and `agenticHitsTrend`, sourced from the new server-side agentic JOIN inside `rpc_url_inspector_owned_urls` (Option C — addresses *M2 — Owned URLs > 500 are silently truncated; duplicate-key paths overwrite* from the multi-persona PR review).

### Files

| File | Change |
|------|--------|
| `src/controllers/llmo/llmo-agent-types.js` *(Char review — extract)* | **NEW.** Hosts `VALID_AGENT_TYPES_CANONICAL`, `VALID_AGENT_TYPES_LOOKUP`, and `parseAgentTypes`. Single source of truth for the agent-type allowlist + the "silent-drop unknown values" semantic, shared by the agentic-traffic and URL Inspector controllers. Char's review (May 5) flagged the original cross-controller import (`llmo-agentic-traffic.js` → `llmo-url-inspector.js`) as awkward coupling; this module fixes that and is the obvious place to add a third call site. |
| `src/controllers/llmo/llmo-agentic-traffic.js` | Imports `parseAgentTypes` from `llmo-agent-types.js` (re-exports it for back-compat with existing internal imports); `parseAgenticTrafficParams` plumbs the parsed value through; `buildRpcParams` conditionally adds `p_agent_types` to the kpis-trend and by-url RPC payloads only; by-url response now exposes `hits_trend → hitsTrend`. |
| `src/controllers/llmo/llmo-url-inspector.js` *(Option C)* | Imports `parseAgentTypes` from `llmo-agent-types.js` (was previously imported from `llmo-agentic-traffic.js`). `createUrlInspectorOwnedUrlsHandler` now reads `agentTypes` (or legacy `agent_types`) from the query string, parses + validates it, and **conditionally** sets `rpcParams.p_agent_types` only when the result is non-null. Owned-URL response rows now include `agenticHits` (from `agentic_hits`, defaulted to `0`) and `agenticHitsTrend` (from `agentic_hits_trend`, defaulted to `[]`, with each `{week_start, value}` rebound to `{weekStart, value}`). Other handlers in the file are unchanged. |
| `src/controllers/llmo/llmo-url-inspector.js` *(Phase 4 hardening)* | `createUrlInspectorUrlPromptsHandler` now treats Postgres SQLSTATE `22P02` (`invalid input syntax for type uuid`) as "no prompts for this URL" and returns `200 { prompts: [] }` instead of `500`. This unblocks the URL Inspector PG dashboard's URL Details dialog when opened from the Owned URLs table, where the dashboard synthesises `url-${index}-${slug}` ids because `rpc_url_inspector_owned_urls` does not return `source_urls.id`. Other Postgres errors (anything other than the UUID parse failure) continue to bubble up as 500. Two new unit tests pin both branches (SQLSTATE-based and message-based detection); coverage stays at 100%. |
| `docs/openapi/parameters.yaml` *(Char review — OpenAPI)* | New reusable `agentTypes` query parameter with full description, the dual-parameter intersection NOTE, and example values (`Chatbots`, `Chatbots,Research`). Re-used by the three affected operations to avoid duplication. |
| `docs/openapi/llmo-api.yaml` *(Char review — OpenAPI)* | `getAgenticTrafficKpisTrend`, `getAgenticTrafficByUrl`, and `getUrlInspectorOwnedUrls` now reference `parameters.yaml#/agentTypes`. |
| `docs/openapi/schemas.yaml` *(Char review — OpenAPI)* | `AgenticTrafficByUrlRow` gains `hitsTrend` (array of `{weekStart, hits}`); `UrlInspectorOwnedUrlRow` gains `agenticHits` and `agenticHitsTrend` (array of `{weekStart, value}`). Descriptions cite LLMO-4526 and the M2 fix. |
| `test/it/postgres/llmo-url-inspector.test.js` *(Char review — IT scaffolding)* | **NEW.** Harness file mirroring the existing `llmo-onboarding.test.js`. |
| `test/it/shared/tests/llmo-url-inspector.js` *(Char review — IT scaffolding)* | **NEW.** Smoke tests for the modified owned-URLs endpoint: validation (400 on missing/invalid `siteId`), and a response-shape contract assertion that pins `agenticHits` / `agenticHitsTrend` on every row regardless of which mysticat image is running (the controller maps with `?? 0` / `?? []` fallbacks, so the contract holds even on data-service v1.67.8 which pre-dates the new RPC columns). Two `it.skip` placeholders document the full `agentTypes` exercise that gets enabled once `test/it/postgres/docker-compose.yml` is bumped to a release containing the LLMO-4526 mysticat migrations (follow-up; not gated on this PR since the data-service image bump itself depends on mysticat#490 being merged + published). |
| `test/controllers/llmo/llmo-agentic-traffic.test.js` | `describe` block covering the parse helper, validation, conditional forwarding, and 400 on unknown values. Coverage tightened post-PR-push for empty-token branch, non-string array members, and `hits_trend` mapping with null values. |
| `test/controllers/llmo/llmo-url-inspector.test.js` *(Option C)* | Existing owned-URLs test extended to assert `agenticHits` / `agenticHitsTrend` are present and camelCased (incl. `weekStart`). Null-row test asserts `agentic_hits = null` and `agentic_hits_trend = null` map to `0` and `[]`, *and* that omitting `agentTypes` from the query causes the handler to **not** send `p_agent_types` to the RPC. New tests for `agentTypes` forwarding (comma-separated, array-shaped, unknown-dropped, casing canonicalisation). |

### Key Decisions

1. **Comma-separated query parameter** — matches the existing project conventions (`platform`, `provider`, etc.) and avoids inventing repeated `agentTypes=...&agentTypes=...` syntax.
2. **Whitelist with canonical normalisation** — values are accepted case-insensitively (`chatbots`, `Chatbots`, `CHATBOTS`) but always forwarded to the DB in canonical form. Unknown values are silently dropped (the handler only sends `p_agent_types` when at least one valid value remains), so a UI bug doesn't accidentally widen the inclusion list.
3. **Conditional forwarding** — `p_agent_types` is added **only** to the kpis-trend, by-url, and owned-URLs RPC payloads. The movers and distinct-filters RPCs are byte-for-byte identical to today. This minimises the schema-cache surface affected by deploy.
4. **Map `hits_trend → hitsTrend` on by-url response** — lets the URL Details dialog render per-URL multi-week agentic charts without a second request. The RPC was already returning the array; this just exposes it.
5. **Owned-URLs camelCase mapping (Option C)** — the RPC returns `agentic_hits` / `agentic_hits_trend` with snake_case `week_start` inside the JSONB array. The handler converts to `agenticHits`, `agenticHitsTrend: [{weekStart, value}]`. This keeps the UI side free of snake_case leakage and matches the pattern used for `weekly_citations → weeklyCitations`.
6. **Reusing `parseAgentTypes`** — single source of truth for "what is a valid agent type" across both URL Inspector and Agentic Traffic surfaces. Originally exported from `llmo-agentic-traffic.js` and imported into `llmo-url-inspector.js`. Char's review (May 5) flagged that as cross-controller coupling — a third caller would create awkward import chains. **Resolved post-PR-push** by extracting to `src/controllers/llmo/llmo-agent-types.js`, which is imported by both controllers (and re-exported from the agentic-traffic controller for back-compat). The agent-type allowlist now has one obvious home.

### Char's review (post first-push) — addressed in this PR

- **OpenAPI spec gap (high; actionable before merge).** `docs/openapi/` did not document the new `agentTypes` query parameter or the new response fields (`agenticHits`, `agenticHitsTrend`, `hitsTrend`). Per the project's API Design Principles ("OpenAPI First"). Added: a reusable `agentTypes` parameter in `parameters.yaml` (with the dual-parameter intersection NOTE), `$ref` wiring on the three affected operations in `llmo-api.yaml`, and the new schema fields in `schemas.yaml`. The `agent_types` snake_case alias is intentionally **not** documented — it is preserved in code for legacy callers but the canonical OpenAPI surface is `agentTypes` only.
- **No integration tests (high; actionable before merge).** Per CLAUDE.md "New or modified endpoints must include integration tests in `test/it/`". Added `test/it/postgres/llmo-url-inspector.test.js` + the shared spec under `test/it/shared/tests/llmo-url-inspector.js`. Includes: validation tests, a response-shape contract test that pins the new fields on every row regardless of mysticat image version, and two `it.skip` placeholders for the full `agentTypes` exercise once the data-service image is bumped (separately tracked; depends on mysticat#490 being published).
- **Cross-module coupling for `parseAgentTypes` (design).** Resolved by extracting to `llmo-agent-types.js` — see Decision 6 above.
- **Silent-drop on unknown `agentTypes` values (defensive).** Acknowledged but kept as-is. Silent-drop is the existing project-wide convention for whitelist-based filter params (matches `successRate`, `platform`, etc.). Returning `400` only when *every* supplied value is unknown is a reasonable future tightening, but inconsistent with the rest of the agentic-traffic controller — deferring to a project-wide policy decision.
- **`rpc_agentic_traffic_kpis` gap not surfaced (doc).** The non-trend KPIs handler does not receive `p_agent_types` — correct per the test plan but called out here explicitly. **Known gap:** a caller filtering by `agentTypes` against `/agentic-traffic/kpis` (the non-trend variant) silently gets unfiltered totals because the param is not forwarded. Left as-is for this PR because no UI surface uses that combination today; trivial follow-up if/when one does.
- **Nits (resolved or acknowledged):** the `ctx`/`context` mixing on the affected handler is unchanged (matches the existing pattern across `llmo-url-inspector.js`); a comment linking `VALID_AGENT_TYPES_CANONICAL` to the source DB column is now in the new `llmo-agent-types.js` module ("mirrors the values stored in `agentic_traffic_weekly.agent_type`"); the cross-repo plan-doc reference is intentionally retained because LLMO-4526 is the canonical pointer to the long-form working notes for the lifetime of this PR.

### Backwards Compatibility

The new param is purely additive. Without `agentTypes` the controller produces identical RPC payloads (no `p_agent_types`) and identical response shapes — except:
- by-url rows now carry the additive `hitsTrend` field; existing consumers that don't read it are unaffected.
- owned-URLs rows now carry `agenticHits` (always present, defaults to `0`) and `agenticHitsTrend` (always present, defaults to `[]`). Existing UI that doesn't read those fields is unaffected.

The existing test suite continues to pass unchanged.

### Deploy Order

This service must be deployed **after** mysticat-data-service#490 is on DEV/stage/prod (whichever target is being deployed): until the new RPC signatures (all three — `rpc_agentic_traffic_kpis_trend`, `rpc_agentic_traffic_by_url`, `rpc_url_inspector_owned_urls`) are live and PostgREST has reloaded its schema cache, calls with `agentTypes` would fail with "no overload matches".

The UI (`project-elmo-ui#1640`) consumes this controller, so it must be deployed **after** this service.

See the full working notes (`mysticat-data-service/docs/plans/2026-04-29-llmo-4526-url-inspector-pg-agentic-from-db.md`) for the rationale, the multi-persona PR review findings, and the detailed deploy sequencing.
