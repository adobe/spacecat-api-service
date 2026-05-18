# URL Inspector Filter Dimensions API

Returns the **option universe** for the top-of-page Category / Region / Channel dropdowns on the URL Inspector PG dashboard. One round-trip, three arrays of `{id, label}` objects, sourced from the `url_inspector_domain_stats` summary table — so cost scales with distinct summary rows in scope, not raw `brand_presence_*` rows.

This endpoint defines what the dropdowns *can* show. It is intentionally **not** filtered by Category / Region / Channel itself (no cascading behaviour) — the active selection on those dropdowns is irrelevant when populating the lists they choose from.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/filter-dimensions` | Dimensions for the site (all brands) |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/filter-dimensions` | Brand UUID accepted but **not applied** (summary table has no `brand_id`) |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — `all` (no brand filter) or a specific brand UUID. Forwarded to the RPC as `p_brand_id`, but currently a no-op — see [Scope](#scope).

> **LLMO-4525 fix:** earlier iterations of the handler read `brandId` from `ctx.data` (query string), which silently dropped the `:brandId` path segment. The handler now reads it from `ctx.params`, matching every other URL Inspector endpoint. The dual-route shape (`brands/all/...` and `brands/:brandId/...`) is the same pattern used by `stats`, `owned-urls`, `trending-urls`, etc.

---

## Scope

- URL Inspector endpoints are **site-scoped**; `siteId` is **required**.
- The summary table `url_inspector_domain_stats` has **no `brand_id` axis**, so `:brandId` is currently a documented no-op for this endpoint. The argument is kept on the RPC and the URL for API parity / forward compatibility — the day a `brand_id` column is added to the summary table the RPC body can wire it in without a Spacecat-side change. The `PERFORM p_brand_id;` placeholder in the RPC body is intentional (it makes the unused parameter explicit and silences PL/pgSQL warnings).
- The endpoint does **not** apply Category / Region / Channel filters — it returns the full distinct universe across the site + date + platform window. Cascading filter behaviour is a UX concern handled in the frontend if/when desired.
- The site is always validated against the organization (`spaceCatId`) before querying.
- Routes are in `INTERNAL_ROUTES` (see [`src/routes/required-capabilities.js`](../../src/routes/required-capabilities.js)) — not exposed to S2S consumers.

---

## Query Parameters

Parameters are read from `ctx.data` (merged query string / body) via `parseFilterDimensionsParams`. Only the four below are forwarded to the RPC; any other params parsed by the helper (`categoryId`, `regionCode`, `topicIds`, etc.) are intentionally ignored — see [Scope](#scope).

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID. Validated against organization membership. |
| `startDate` | `start_date` | string (YYYY-MM-DD) | no | 28 days ago | Inclusive lower bound on `execution_date`. |
| `endDate` | `end_date` | string (YYYY-MM-DD) | no | today | Inclusive upper bound on `execution_date`. |
| `platform` | `model` | string | no | **unset (no platform filter)** | LLM model. See [Platform handling](#platform-handling). |

**Differences vs `/brand-presence/filter-dimensions`:**
- `siteId` is **required** (not optional).
- Different RPC, different return shape — three dimensions (`categories`, `regions`, `content_types`) instead of brand-presence's nine.
- Only the platform query parameter is supported as a *filter*; brand-presence's filter-dimensions accepts cascading filters because its UI has them.

---

## Platform handling

`platform` (alias `model`) collapses three "no filter" sentinels to `p_platform = NULL`:
- absent / undefined
- empty string `""`
- the literal string `"all"` (case-insensitive)

Any other value is normalised via `validateModel` (see [`llmo-brand-presence.js → MODEL_QUERY_ALIASES`](../../src/controllers/llmo/llmo-brand-presence.js)). Aliases are accepted — for example `openai` is mapped to `chatgpt-paid` before being forwarded to the RPC. Unknown values return **400**.

**LLMO-4525 fix (major):** previously the RPC delegated platform normalisation blindly to `map_llmo_execution_model_input`, which returns `chatgpt-paid` for the legacy `'all'` alias. For this endpoint that would silently narrow the option universe to ChatGPT-Paid rows only. The RPC now special-cases `'all'` / `''` / `NULL` to mean "no model filter" *before* consulting the alias map, matching the `shouldApplyFilter` semantics used everywhere else in the controller layer.

**Canonical values** (`llmo_execution_model` enum):
`chatgpt-free`, `chatgpt-paid`, `perplexity`, `google-ai-mode`, `google-ai-overview`, `gemini`, `copilot`.

**Known aliases:** `openai` → `chatgpt-paid`.

---

## RPC Usage

**Function:** `rpc_url_inspector_filter_dimensions(UUID, DATE, DATE, TEXT, UUID)`

| RPC Parameter | API Source | Description |
|---------------|------------|-------------|
| `p_site_id` | `siteId` (query) | Site UUID (required) |
| `p_start_date` | `startDate` (query) | Start of range (defaults to 28 days ago) |
| `p_end_date` | `endDate` (query) | End of range (defaults to today) |
| `p_platform` | `platform` (query) | See [Platform handling](#platform-handling). NULL means no filter. |
| `p_brand_id` | `brandId` (path) | Specific brand UUID; `all` maps to NULL. **Currently a no-op** — see [Scope](#scope). |

**Data source:** `public.url_inspector_domain_stats` (summary table, keyed by `(site_id, hostname, execution_date, model, content_type)`). The function unnests `categories TEXT[]` and `regions TEXT[]` and collects the distinct scalar `content_type` values into one JSONB result. See migration [`20260506000200_rpc_url_inspector_filter_dimensions.sql`](../../../mysticat-data-service/db/migrations/20260506000200_rpc_url_inspector_filter_dimensions.sql) for the full definition.

**Plan-shape note:** the base CTE is declared `NOT MATERIALIZED` so PostgreSQL can inline the partition scan into each of the three downstream CTEs (`cats` / `regs` / `ctypes`) independently. This avoids spilling ~6.9 M rows to a 585 MB temp file and re-reading it twice; `adobe.com` 8-week window benchmark goes 4 s → 2 s, and the typical 4-week window goes 1.8 s → 1.3 s.

**Ordering guarantee:** the function uses the **aggregate** form `jsonb_agg(... ORDER BY ...)` rather than a subquery `ORDER BY` (which Postgres is free to discard when the result feeds into an aggregate). The emitted JSON arrays are guaranteed alphabetical — see the inline comment on lines 113–117 of the migration.

**Function attributes:** `STABLE PARALLEL SAFE` — the planner can use parallel workers for the partition scan; safe for read replicas.

---

## Response Shape

```json
{
  "categories": [
    { "id": "Acrobat",   "label": "Acrobat" },
    { "id": "Analytics", "label": "Analytics" }
  ],
  "regions": [
    { "id": "DE", "label": "DE" },
    { "id": "GB", "label": "GB" },
    { "id": "US", "label": "US" }
  ],
  "content_types": [
    { "id": "earned",  "label": "earned" },
    { "id": "owned",   "label": "owned" },
    { "id": "social",  "label": "social" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `categories` | `Array<{id, label}>` | Distinct category names from `url_inspector_domain_stats.categories` (a `TEXT[]` column) for the site + window + platform. Both `id` and `label` are the trimmed category string. Sorted alphabetically. Tenant-supplied data — no enum on `id`. |
| `regions` | `Array<{id, label}>` | Distinct region codes from `url_inspector_domain_stats.regions` (a `TEXT[]` column). Both `id` and `label` are the trimmed region code. Sorted alphabetically. Tenant-supplied data — no enum on `id`. |
| `content_types` | `Array<{id, label}>` | Distinct values of the scalar `url_inspector_domain_stats.content_type` column (Postgres `source_content_type` enum). `id` is one of `owned` / `earned` / `social` / `competitor` and is pinned in the OpenAPI schema. `label` mirrors `id`. Sorted alphabetically. |

**Empty values are filtered:** the RPC applies `c IS NOT NULL AND btrim(c) <> ''` to category and region elements before the DISTINCT, so empty strings, whitespace-only entries, and NULLs in upstream array data never leak into the dropdowns.

**Empty result:** if the summary table has zero rows for the site + window + platform, every array is `[]` (not omitted, not `null`).

---

## Sample URLs

**Default (last 28 days, no platform filter, all brands):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/filter-dimensions?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

**Custom date range:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/filter-dimensions?siteId=c2473d89-e997-458d-a86d-b4096649c12b&startDate=2026-02-01&endDate=2026-02-28
```

**Filtered to a specific platform (canonical enum value):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/filter-dimensions?siteId=c2473d89-e997-458d-a86d-b4096649c12b&platform=gemini
```

**Platform via alias (`openai` → `chatgpt-paid`):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/filter-dimensions?siteId=c2473d89-e997-458d-a86d-b4096649c12b&platform=openai
```

**Brand-scoped path (`brandId` accepted but not applied):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/e0a9a1f2-1b4c-4d0e-8f11-8f0a0c2b3d4e/brand-presence/url-inspector/filter-dimensions?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; invalid `platform` value (after alias resolution) |
| 403 | Site does not belong to the organization; user has no org access |
| 500 | RPC threw (transport-level failure) or PostgREST returned a non-2xx error body |

On 500, only the generic `Internal error processing URL Inspector filter dimensions` message is returned to the caller. The server log captures the full triage context (route, siteId, startDate, endDate, platform, hasBrandIdFilter) plus the PostgREST `code` / `details` / `hint` when present:

```
URL Inspector filter dimensions RPC error: Could not find function ... [code=PGRST202] [details=...] [hint=...]
URL Inspector filter dimensions RPC threw: ECONNRESET
```

The `e?.message || e` fallback in the catch block also handles non-`Error` rejections (rare, but some transports throw bare strings or numbers); the same triage context is logged.

---

## Authentication & Access

- Uses Brand Presence auth (`withBrandPresenceAuth`) with `getOrgAndValidateAccess`.
- Requires LLMO product entitlement and org access.
- Always validates the site–org relationship before querying.
- Routes are in `INTERNAL_ROUTES` — not exposed to S2S consumers.

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Stats API](./url-inspector-stats-api.md) — KPIs + per-week sparklines for the same dashboard
- [URL Inspector Cited Domains API](./url-inspector-cited-domains-api.md) — paginated domain aggregation, same summary-table source
- [Brand Presence Filter Dimensions API](./filter-dimensions-api.md) — sibling endpoint for the Brand Presence dashboard (different RPC, cascading filters)
- [Agentic Traffic Filter Dimensions API](./agentic-traffic-filter-dimensions-api.md) — analogous endpoint on the agentic-traffic side

---

## Ticket context

Introduced as part of LLMO-4525 to fix the broken Category / Region / Channel filter dropdowns on the URL Inspector PG dashboard. Implementation spans three repos:

- mysticat-data-service: [#461](https://github.com/adobe/mysticat-data-service/pull/461) — RPC + migration
- spacecat-api-service: [#2269](https://github.com/adobe/spacecat-api-service/pull/2269) — handler + route + OpenAPI
- project-elmo-ui: [#1599](https://github.com/adobe/project-elmo-ui/pull/1599) — React Query hook + dashboard wiring
