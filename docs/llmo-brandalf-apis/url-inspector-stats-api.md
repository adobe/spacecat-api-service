# URL Inspector Stats API

Aggregate citation statistics (total prompts cited, total prompts, unique URLs, total citations) plus a per-ISO-week sparkline breakdown for the URL Inspector dashboard. The controller fans out four per-KPI RPCs in mysticat-data-service in parallel (`Promise.all`) and assembles the response.

Trends are **always returned** (no `showTrends` flag) because the sparklines are a first-class part of every URL Inspector stats card.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/stats` | Stats for the site (all brands) |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats` | Stats scoped to a single brand on the site |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — `all` (no brand filter) or a specific brand UUID (scopes `totalPrompts` / `totalPromptsCited` to that brand's prompts)

---

## Scope

- URL Inspector endpoints are **site-scoped**; `siteId` is **required**.
- When `brandId` is a specific UUID, the split RPCs take a brand-aware plan:
  - `totalPrompts` — distinct `prompts.id` rows that are `status = 'active'` for the brand AND ran in the window (driven from `prompts`, semi-joined to `brand_presence_executions`).
  - `totalPromptsCited` — same brand-active prompts, further filtered by existence of at least one owned citation in `brand_presence_sources` in the window.
  - `uniqueUrls` / `totalCitations` — raw owned citations, filtered by the brand's execution rows (via `brand_presence_executions.brand_id`).
- When `brandId` is `all`, the split RPCs take a brand-agnostic plan driven from `brand_presence_executions` / `brand_presence_sources` in the window. This is the fast path for site-wide totals.
- The site is always validated against the organization (`spaceCatId`) before querying.

---

## Query Parameters

Parameters are read from `ctx.data` (merged query string / body) via `parseFilterDimensionsParams`.

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID. Validated against organization membership. |
| `startDate` | `start_date` | string (YYYY-MM-DD) | no | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | no | today | End of date range |
| `model` | `platform` | string | no | **unset (no platform filter)** | LLM model. If provided, validated against the `llmo_execution_model` enum (e.g. `chatgpt`, `gemini`). |
| `categoryId` | `category_id`, `category` | string | no | — | Category filter. Matched against `brand_presence_executions.category_name`. |
| `regionCode` | `region_code`, `region` | string | no | — | Region filter. Matched against `brand_presence_executions.region_code`. |

**Differences vs `/brand-presence/stats`:**
- `siteId` is **required** (not optional).
- `model` has **no default** — omitted means "no model filter" (unlike brand-presence which defaults to `chatgpt-free`).
- `topicIds`, `origin`, and `showTrends` are **not supported**. Trends are always returned.

---

## RPC Usage

The controller calls four per-KPI RPCs in parallel. Each RPC has the same 7-parameter signature and returns rows shaped as `(week, week_number, year_val, value)`; the `week IS NULL` row is the aggregate for the full window, the remaining rows are the per-ISO-week breakdown.

| Metric | RPC |
|--------|-----|
| `totalPromptsCited` | `rpc_url_inspector_total_prompts_cited(UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID)` |
| `totalPrompts` | `rpc_url_inspector_total_prompts(UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID)` |
| `uniqueUrls` | `rpc_url_inspector_unique_urls(UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID)` |
| `totalCitations` | `rpc_url_inspector_total_citations(UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID)` |

| RPC Parameter | API Source | Description |
|---------------|------------|-------------|
| `p_site_id` | `siteId` | Site UUID (required) |
| `p_start_date` | `startDate` | Start of range |
| `p_end_date` | `endDate` | End of range |
| `p_category` | `categoryId` | Category name or NULL |
| `p_region` | `regionCode` | Region code or NULL |
| `p_platform` | `model` | Mapped to `llmo_execution_model` via `map_llmo_execution_model_input()`; NULL means no model filter |
| `p_brand_id` | `brandId` (path) | Specific brand UUID; `all` maps to NULL (no brand filter) |

**Data source:** `public.brand_presence_executions` and `public.brand_presence_sources` (raw partitioned tables), joined to `public.prompts` when `p_brand_id` is set. Each RPC uses `GROUPING SETS ((), (week_expr))` so the aggregate and per-week breakdown come from a single scan.

**Plan-shape note:** The split RPCs always repeat the `execution_date` range and `site_id` predicate on both `brand_presence_executions` and `brand_presence_sources` so the planner can prune partitions on both sides of the join. Skipping this makes the planner scan every partition of the other table and blows latency up from ~1 s to ~100 s on large sites.

**Why fan-out and not a single RPC:** End-to-end latency is `max(t_totalPromptsCited, t_totalPrompts, t_uniqueUrls, t_totalCitations)` ≈ the single slowest metric, not the sum. The four RPCs also let Postgres compile a specialized plan per KPI instead of one generic plan that has to serve all four, which matters because `COUNT(DISTINCT …)` plans are very different across the four metrics. See [`mysticat-data-service/docs/plans/2026-04-02-url-inspector-performance.md`](../../../mysticat-data-service/docs/plans/2026-04-02-url-inspector-performance.md) §6 Experiment 6 for the benchmarks and rationale.

---

## Response Shape

```json
{
  "stats": {
    "totalPromptsCited": 312,
    "totalPrompts": 1250,
    "uniqueUrls": 187,
    "totalCitations": 964
  },
  "weeklyTrends": [
    {
      "week": "2026-W10",
      "totalPromptsCited": 48,
      "totalPrompts": 180,
      "uniqueUrls": 42,
      "totalCitations": 155
    },
    {
      "week": "2026-W11",
      "totalPromptsCited": 52,
      "totalPrompts": 193,
      "uniqueUrls": 45,
      "totalCitations": 163
    }
  ]
}
```

- `stats` — aggregate across the full `[startDate, endDate]` window. Every metric measures owned citations / brand-active prompts only (see Scope above for the exact definitions).
- `weeklyTrends` — one entry per ISO week (`IYYY-"W"IW`), **ascending** (oldest first). Weeks are unioned across the four RPCs; if one metric has no data for a week, that metric is reported as `0` for the week rather than dropping the row.

---

## Sample URLs

**Default (last 28 days, no platform filter, all brands):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/stats?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

**Single brand:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/e0a9a1f2-1b4c-4d0e-8f11-8f0a0c2b3d4e/brand-presence/url-inspector/stats?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

**Custom date range + platform:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/stats?siteId=c2473d89-e997-458d-a86d-b4096649c12b&startDate=2026-02-01&endDate=2026-02-28&model=chatgpt
```

**Filtered by category and region:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/stats?siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=Acrobat&regionCode=US
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; invalid `model` value |
| 403 | Site does not belong to the organization; user has no org access |
| 500 | Any of the four split RPCs errored (logged as `URL Inspector stats RPC error (<fn>): <message>`) |

On a 500, only the generic `Internal error processing URL Inspector stats` message is returned to the caller; the specific RPC name and the Postgres error are written to the server log.

---

## Authentication & Access

- Uses Brand Presence auth (`withBrandPresenceAuth`) with `getOrgAndValidateAccess`.
- Requires LLMO product entitlement and org access.
- Always validates the site–org relationship before querying.
- Routes are in `INTERNAL_ROUTES` (not exposed to S2S consumers).

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Owned URLs API](./url-inspector-owned-urls-api.md) — paginated per-URL owned citations
- [URL Inspector Cited Domains API](./url-inspector-cited-domains-api.md) — domain-level aggregations
- [URL Inspector Filter Dimensions API](./url-inspector-filter-dimensions-api.md) — option universe for the top-of-page filter dropdowns
- [Brand Presence APIs Overview](./brand-presence-apis-overview.md)
