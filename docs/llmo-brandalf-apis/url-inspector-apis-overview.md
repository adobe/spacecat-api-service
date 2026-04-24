# URL Inspector APIs — consolidated reference

Single entry point for all URL Inspector HTTP APIs backed by mysticat-data-service (PostgREST). These endpoints power the **URL Inspector** dashboard (Owned URLs, Trending URLs, Domains tabs, plus domain and URL drill-downs).

**Path pattern:** `GET /org/:spaceCatId/brands/{all|:brandId}/brand-presence/url-inspector/...`

- `:spaceCatId` — organization UUID.
- `all` — aggregate across brands; `:brandId` — filter to one brand (**only** applied by `owned-urls` and `trending-urls`; other endpoints ignore it because their RPC or summary table does not carry `brand_id`).

All URL Inspector endpoints are **site-scoped**. `siteId` is **required** on every call and is validated against the organization. Unlike the sibling `/brand-presence/*` endpoints, the model (`model` / `platform`) has **no default** — when omitted, no model filter is applied.

Deep-dive docs: [stats](url-inspector-stats-api.md), [owned-urls](url-inspector-owned-urls-api.md), [trending-urls](url-inspector-trending-urls-api.md), [cited-domains](url-inspector-cited-domains-api.md), [domain-urls](url-inspector-domain-urls-api.md), [url-prompts](url-inspector-url-prompts-api.md).

---

## Master table

| # | Method | API path | Purpose | Required query params | Optional query params | Detail doc |
|---|--------|----------|---------|-----------------------|-----------------------|------------|
| 1 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/url-inspector/stats` | Aggregate citation stats + per-ISO-week sparkline trends from the summary table. | `siteId` | `startDate`, `endDate`, `model`, `categoryId`, `regionCode` | [url-inspector-stats-api.md](url-inspector-stats-api.md) |
| 2 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/url-inspector/owned-urls` | Paginated owned URLs with per-URL citations, prompts, products, regions, and weekly arrays. | `siteId` | `startDate`, `endDate`, `model`, `categoryId`, `regionCode`, `page`, `pageSize` (default `50`). `:brandId` applied. | [url-inspector-owned-urls-api.md](url-inspector-owned-urls-api.md) |
| 3 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/url-inspector/trending-urls` | Paginated non-owned URLs grouped by URL with a `prompts[]` breakdown per URL. | `siteId` | `startDate`, `endDate`, `model`, `categoryId`, `regionCode`, `channel`, `page`, `pageSize` (default `50`). `:brandId` applied. | [url-inspector-trending-urls-api.md](url-inspector-trending-urls-api.md) |
| 4 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/url-inspector/cited-domains` | Paginated domain aggregation (total citations / URLs / prompts + dominant content type). | `siteId` | `startDate`, `endDate`, `model`, `categoryId`, `regionCode`, `channel`, `page`, `pageSize` (default `50`). `:brandId` **not** applied. | [url-inspector-cited-domains-api.md](url-inspector-cited-domains-api.md) |
| 5 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/url-inspector/domain-urls` | Paginated URLs inside a single hostname. | `siteId`, `hostname` (alias `domain`) | `startDate`, `endDate`, `model`, `channel`, `page`, `pageSize` (default `50`). `:brandId` / category / region **not** applied. | [url-inspector-domain-urls-api.md](url-inspector-domain-urls-api.md) |
| 6 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/url-inspector/url-prompts` | All prompts (with category, region, topics, citations) that cited a single URL. Unpaginated. | `siteId`, `urlId` (alias `url_id`) | `startDate`, `endDate`, `model`. `:brandId` / category / region **not** applied. | [url-inspector-url-prompts-api.md](url-inspector-url-prompts-api.md) |

---

## Data sources

Two backing stores, selected per RPC for performance reasons:

| Store | Used by | Why |
|-------|---------|-----|
| `url_inspector_domain_stats` (summary table, keyed by `site_id, execution_date, model, hostname, content_type`) | `stats`, `cited-domains` | 100× faster than raw tables on large sites. Carries pre-aggregated `unique_prompts`, `unique_urls`, `citation_count`, plus `categories TEXT[]` and `regions TEXT[]`. **No `brand_id`** — that's why brand filtering is not available on these endpoints. |
| `brand_presence_sources` + `brand_presence_executions` + `source_urls` (raw tables) | `owned-urls`, `trending-urls`, `domain-urls`, `url-prompts` | Need exact per-URL counts, per-prompt breakdowns, or ISO-week arrays that the summary does not carry. |

Summary-table endpoints return **approximate** `unique_urls` / `prompts_cited` — a URL or prompt appearing across multiple (hostname, date, model, content_type) groups is counted once per group. This is an accepted trade-off documented in migration `20260428120100_url_inspector_rpcs_summary_table.sql`.

---

## Common parameter semantics

- `model` / `platform` — when present, validated against the `llmo_execution_model` enum (`chatgpt`, `gemini`, `claude`, etc.) via `map_llmo_execution_model_input()`. When absent, the RPC applies **no** model filter (the SQL pattern is `v_platform IS NULL OR model = v_platform`).
- `channel` / `selectedChannel` — exact match on `brand_presence_sources.content_type` (`owned`, `earned`, `paid`, `partner`). `trending-urls` further hardcodes `content_type != 'owned'`.
- `categoryId` — summary-table endpoints match via `ANY(categories)` (array containment); raw-table endpoints match exactly on `brand_presence_executions.category_name`.
- `regionCode` — analogous (`ANY(regions)` vs exact `region_code`).
- Pagination — `parsePaginationParams(ctx, { defaultPageSize: 50 })`; `pageSize` is clamped to `[1, 1000]`. All paginated RPCs return a `total_count` (or `total_non_owned_urls` for trending) on every row; the controller reads it from the first row.

---

## Example responses

### 1. Stats

```json
{
  "stats": { "totalPromptsCited": 312, "totalPrompts": 1250, "uniqueUrls": 187, "totalCitations": 964 },
  "weeklyTrends": [
    { "week": "2026-W10", "totalPromptsCited": 48, "totalPrompts": 180, "uniqueUrls": 42, "totalCitations": 155 }
  ]
}
```

### 2. Owned URLs

```json
{
  "urls": [
    {
      "url": "https://www.example.com/pdf-editor",
      "citations": 42,
      "promptsCited": 18,
      "products": ["Acrobat"],
      "regions": ["US", "GB"],
      "weeklyCitations": [{ "week": "2026-W10", "value": 15 }],
      "weeklyPromptsCited": [{ "week": "2026-W10", "value": 7 }]
    }
  ],
  "totalCount": 187
}
```

### 3. Trending URLs

```json
{
  "urls": [
    {
      "url": "https://review-site.example.com/pdf-editors",
      "contentType": "earned",
      "totalCitations": 57,
      "prompts": [
        {
          "prompt": "best pdf editor for mac",
          "category": "Acrobat",
          "region": "US",
          "topics": "PDF Editing",
          "citationCount": 32,
          "executionCount": 4
        }
      ]
    }
  ],
  "totalNonOwnedUrls": 412
}
```

### 4. Cited Domains

```json
{
  "domains": [
    {
      "domain": "www.example.com",
      "totalCitations": 128,
      "totalUrls": 17,
      "promptsCited": 63,
      "contentType": "earned",
      "categories": "Acrobat,Analytics",
      "regions": "US,GB,DE"
    }
  ],
  "totalCount": 412
}
```

### 5. Domain URLs

```json
{
  "urls": [
    {
      "urlId": "019cba12-b404-7077-9aa1-2992346a1767",
      "url": "https://www.example.com/pdf-editor",
      "contentType": "earned",
      "citations": 42,
      "promptsCited": 18,
      "categories": "Acrobat,Analytics",
      "regions": "US,GB"
    }
  ],
  "totalCount": 17
}
```

### 6. URL Prompts

```json
{
  "prompts": [
    {
      "prompt": "best pdf editor for mac",
      "category": "Acrobat",
      "region": "US",
      "topics": "PDF Editing",
      "citations": 32
    }
  ]
}
```

---

## Authentication & errors

- Protected by `withBrandPresenceAuth` + `getOrgAndValidateAccess`; requires LLMO product entitlement and org access.
- All endpoints require a `siteId` that belongs to the organization.
- Common errors: **400** (missing `siteId` / `hostname` / `urlId`, invalid `model`, RPC error); **403** (site not in org or no org access); **500** (RPC exception, logged with endpoint-specific message).
- Routes are defined in `INTERNAL_ROUTES` — not exposed to S2S consumers.

---

## Ticket context

Introduced to solve the "brand_presence_sources too big to retrieve" problem from the URL Inspector dashboard (JIRA: LLMO-4030). The summary table + dedicated RPCs replace previous direct PostgREST queries that timed out on large sites.

See related PRs:
- mysticat-data-service RPCs: [#194](https://github.com/adobe/mysticat-data-service/pull/194)
- spacecat-api-service backend: [#2012](https://github.com/adobe/spacecat-api-service/pull/2012) (+ follow-up)
- project-elmo-ui frontend: [#1304](https://github.com/adobe/project-elmo-ui/pull/1304) / [#1429](https://github.com/adobe/project-elmo-ui/pull/1429)
