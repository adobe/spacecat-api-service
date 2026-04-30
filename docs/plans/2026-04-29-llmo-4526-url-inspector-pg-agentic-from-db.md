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
| `src/controllers/llmo/llmo-agentic-traffic.js` | New `VALID_AGENT_TYPES_CANONICAL` / `VALID_AGENT_TYPES_LOOKUP`; `parseAgentTypes` helper (now **exported** for reuse from the URL Inspector handler); `parseAgenticTrafficParams` plumbs the parsed value through; `buildRpcParams` conditionally adds `p_agent_types` to the kpis-trend and by-url RPC payloads only; by-url response now exposes `hits_trend → hitsTrend`. |
| `src/controllers/llmo/llmo-url-inspector.js` *(Option C)* | Imports `parseAgentTypes`. `createUrlInspectorOwnedUrlsHandler` now reads `agentTypes` (or legacy `agent_types`) from the query string, parses + validates it, and **conditionally** sets `rpcParams.p_agent_types` only when the result is non-null. Owned-URL response rows now include `agenticHits` (from `agentic_hits`, defaulted to `0`) and `agenticHitsTrend` (from `agentic_hits_trend`, defaulted to `[]`, with each `{week_start, value}` rebound to `{weekStart, value}`). Other handlers in the file are unchanged. |
| `test/controllers/llmo/llmo-agentic-traffic.test.js` | `describe` block covering the parse helper, validation, conditional forwarding, and 400 on unknown values. Coverage tightened post-PR-push for empty-token branch, non-string array members, and `hits_trend` mapping with null values. |
| `test/controllers/llmo/llmo-url-inspector.test.js` *(Option C)* | Existing owned-URLs test extended to assert `agenticHits` / `agenticHitsTrend` are present and camelCased (incl. `weekStart`). Null-row test asserts `agentic_hits = null` and `agentic_hits_trend = null` map to `0` and `[]`, *and* that omitting `agentTypes` from the query causes the handler to **not** send `p_agent_types` to the RPC. New tests for `agentTypes` forwarding (comma-separated, array-shaped, unknown-dropped, casing canonicalisation). |

### Key Decisions

1. **Comma-separated query parameter** — matches the existing project conventions (`platform`, `provider`, etc.) and avoids inventing repeated `agentTypes=...&agentTypes=...` syntax.
2. **Whitelist with canonical normalisation** — values are accepted case-insensitively (`chatbots`, `Chatbots`, `CHATBOTS`) but always forwarded to the DB in canonical form. Unknown values are silently dropped (the handler only sends `p_agent_types` when at least one valid value remains), so a UI bug doesn't accidentally widen the inclusion list.
3. **Conditional forwarding** — `p_agent_types` is added **only** to the kpis-trend, by-url, and owned-URLs RPC payloads. The movers and distinct-filters RPCs are byte-for-byte identical to today. This minimises the schema-cache surface affected by deploy.
4. **Map `hits_trend → hitsTrend` on by-url response** — lets the URL Details dialog render per-URL multi-week agentic charts without a second request. The RPC was already returning the array; this just exposes it.
5. **Owned-URLs camelCase mapping (Option C)** — the RPC returns `agentic_hits` / `agentic_hits_trend` with snake_case `week_start` inside the JSONB array. The handler converts to `agenticHits`, `agenticHitsTrend: [{weekStart, value}]`. This keeps the UI side free of snake_case leakage and matches the pattern used for `weekly_citations → weeklyCitations`.
6. **Reusing `parseAgentTypes`** — exporting from `llmo-agentic-traffic.js` rather than duplicating the validation lookup. Single source of truth for "what is a valid agent type" across both URL Inspector and Agentic Traffic surfaces.

### Backwards Compatibility

The new param is purely additive. Without `agentTypes` the controller produces identical RPC payloads (no `p_agent_types`) and identical response shapes — except:
- by-url rows now carry the additive `hitsTrend` field; existing consumers that don't read it are unaffected.
- owned-URLs rows now carry `agenticHits` (always present, defaults to `0`) and `agenticHitsTrend` (always present, defaults to `[]`). Existing UI that doesn't read those fields is unaffected.

The existing test suite continues to pass unchanged.

### Deploy Order

This service must be deployed **after** mysticat-data-service#490 is on DEV/stage/prod (whichever target is being deployed): until the new RPC signatures (all three — `rpc_agentic_traffic_kpis_trend`, `rpc_agentic_traffic_by_url`, `rpc_url_inspector_owned_urls`) are live and PostgREST has reloaded its schema cache, calls with `agentTypes` would fail with "no overload matches".

The UI (`project-elmo-ui#1640`) consumes this controller, so it must be deployed **after** this service.

See the full working notes (`mysticat-data-service/docs/plans/2026-04-29-llmo-4526-url-inspector-pg-agentic-from-db.md`) for the rationale, the multi-persona PR review findings, and the detailed deploy sequencing.
