# URL Inspector Stats API

Aggregate citation statistics (total prompts cited, total prompts, unique URLs, total citations) plus a per-ISO-week sparkline breakdown for the URL Inspector dashboard. Data is computed via the `rpc_url_inspector_stats` RPC in mysticat-data-service against the `url_inspector_domain_stats` summary table.

Unlike `/brand-presence/stats`, trends are **always returned** (no `showTrends` flag) because the sparklines are a first-class part of every URL Inspector stats card.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/stats` | Stats for the site (all brands) |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats` | Same stats (brandId in path is accepted but **not applied** — see "Scope" below) |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — `all` or a specific brand UUID (ignored by the underlying RPC)

---

## Scope

- URL Inspector endpoints are **site-scoped**, not brand-scoped. `siteId` is **required**.
- The underlying `rpc_url_inspector_stats` RPC does **not** accept `p_brand_id`. The summary table `url_inspector_domain_stats` does not carry a `brand_id` dimension, so the `:brandId` path segment does not filter results.
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
| `categoryId` | `category_id`, `category` | string | no | — | Category filter. Matched via `ANY(categories)` on the summary row. |
| `regionCode` | `region_code`, `region` | string | no | — | Region filter. Matched via `ANY(regions)` on the summary row. |

**Differences vs `/brand-presence/stats`:**
- `siteId` is **required** (not optional).
- `model` has **no default** — omitted means "no model filter" (unlike brand-presence which defaults to `chatgpt-free`).
- `topicIds`, `origin`, and `showTrends` are **not supported**. Trends are always returned.
- Category/region filtering matches via array-containment on the aggregated summary table, so values must match the tokens stored there exactly.

---

## RPC Usage

**Function:** `rpc_url_inspector_stats(UUID, DATE, DATE, TEXT, TEXT, TEXT)`

| RPC Parameter | API Source | Description |
|---------------|------------|-------------|
| `p_site_id` | `siteId` | Site UUID (required) |
| `p_start_date` | `startDate` | Start of range |
| `p_end_date` | `endDate` | End of range |
| `p_category` | `categoryId` | Category token or NULL |
| `p_region` | `regionCode` | Region code or NULL |
| `p_platform` | `model` | Mapped to `llmo_execution_model` via `map_llmo_execution_model_input()`; NULL means no model filter |

**Data source:** `public.url_inspector_domain_stats` — a pre-aggregated summary table keyed by `(site_id, execution_date, model, hostname, content_type)` with `unique_prompts`, `unique_urls`, `citation_count`, `categories TEXT[]`, `regions TEXT[]`. Summary-table queries return in ~1 s on large sites where the raw-table equivalent would take 100+ s.

**Conceptual SQL (summary table):**
```sql
WITH base AS (
  SELECT execution_date, content_type, unique_prompts, unique_urls, citation_count
  FROM url_inspector_domain_stats
  WHERE site_id = p_site_id
    AND execution_date BETWEEN p_start_date AND p_end_date
    AND (v_platform IS NULL OR model = v_platform)
    AND (p_category IS NULL OR p_category = ANY(categories))
    AND (p_region IS NULL OR p_region = ANY(regions))
),
owned AS (
  SELECT execution_date,
         SUM(unique_prompts) AS owned_prompts,
         SUM(unique_urls)    AS owned_urls,
         SUM(citation_count) AS owned_citations
  FROM base WHERE content_type = 'owned'
  GROUP BY execution_date
),
all_data AS (
  SELECT execution_date, SUM(unique_prompts) AS total_prompts
  FROM base GROUP BY execution_date
)
-- Aggregate row (week = NULL) + one row per ISO week (TO_CHAR(date, 'IYYY-"W"IW')).
```

**Approximation note:** `unique_urls` and `totalPromptsCited` are **sums of per-group distinct counts** over the summary table — a URL or prompt that appears in multiple (hostname, date, model, content_type) groups is counted once per group. Accepted trade-off for the 100× query speedup. Exact counts require the raw-table path (off by default).

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

- `stats` — aggregate across the full `[startDate, endDate]` window (owned content only for cited/URLs/citations; all prompts for `totalPrompts`).
- `weeklyTrends` — one entry per ISO week (`IYYY-"W"IW`), **ascending** (oldest first, since trends are returned sorted NULLS FIRST).

---

## Sample URLs

**Default (last 28 days, no platform filter):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/url-inspector/stats?siteId=c2473d89-e997-458d-a86d-b4096649c12b
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
| 400 | `siteId` missing; invalid `model` value; RPC error |
| 403 | Site does not belong to the organization; user has no org access |
| 500 | RPC exception (logged as `URL Inspector stats RPC error`) |

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
- [Brand Presence APIs Overview](./brand-presence-apis-overview.md)
