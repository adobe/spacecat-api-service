# URL Inspector Owned URLs API

Paginated list of **owned** URLs (content the brand publishes) with per-URL citation counts, prompt counts, category/region breakdowns, and weekly mini-trend arrays. Backs the "Owned URLs" tab in the URL Inspector dashboard.

Data comes from `rpc_url_inspector_owned_urls` in mysticat-data-service. Unlike the stats endpoint, this RPC queries the **raw** tables (`brand_presence_sources` + `brand_presence_executions`) because it needs exact per-URL counts and weekly breakdowns that the summary table does not carry.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/owned-urls` | All brands for the site |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/owned-urls` | Filter to one brand UUID |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — `all` or a specific brand UUID. Unlike the other URL Inspector endpoints, `:brandId` **is applied** here (RPC accepts `p_brand_id`).

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID (validated against org) |
| `startDate` | `start_date` | string (YYYY-MM-DD) | no | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | no | today | End of date range |
| `model` | `platform` | string | no | unset | LLM model enum (e.g. `chatgpt`, `gemini`). No default. |
| `categoryId` | `category_id`, `category` | string | no | — | Exact match on `brand_presence_executions.category_name` |
| `regionCode` | `region_code`, `region` | string | no | — | Exact match on `brand_presence_executions.region_code` |
| `page` | — | integer ≥ 0 | no | `0` | Page index |
| `pageSize` | — | integer 1–1000 | no | `50` | Page size (server clamps to 1000) |

Pagination is parsed via `parsePaginationParams(ctx, { defaultPageSize: 50 })`. The controller passes `p_limit = pageSize` and `p_offset = page * pageSize` to the RPC. `page` / `pageSize` are **not** echoed back in the response — the caller already owns those values.

---

## RPC Usage

**Function:** `rpc_url_inspector_owned_urls(UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER)`

| RPC Parameter | API Source | Description |
|---------------|------------|-------------|
| `p_site_id` | `siteId` | required |
| `p_start_date` | `startDate` | |
| `p_end_date` | `endDate` | |
| `p_category` | `categoryId` | exact `category_name` match |
| `p_region` | `regionCode` | exact `region_code` match |
| `p_platform` | `model` | mapped via `map_llmo_execution_model_input()` |
| `p_brand_id` | `:brandId` path | `NULL` when `brandId = 'all'`, otherwise the brand UUID |
| `p_limit` | `pageSize` | |
| `p_offset` | `page * pageSize` | |

**Conceptual SQL:**
```sql
WITH base AS (
  SELECT su.url, bpe.prompt, bpe.category_name, bpe.region_code, bpe.topics,
         TO_CHAR(bps.execution_date, 'IYYY-"W"IW') AS week
  FROM brand_presence_sources bps
  JOIN source_urls su ON su.id = bps.url_id
  JOIN brand_presence_executions bpe
    ON bpe.id = bps.execution_id AND bpe.execution_date = bps.execution_date
  WHERE bps.site_id = p_site_id
    AND bps.content_type = 'owned'
    AND bps.execution_date BETWEEN p_start_date AND p_end_date
    AND (v_platform IS NULL OR bpe.model = v_platform)
    AND (p_category IS NULL OR bpe.category_name = p_category)
    AND (p_region   IS NULL OR bpe.region_code  = p_region)
    AND (p_brand_id IS NULL OR bpe.brand_id     = p_brand_id)
),
url_agg AS (
  SELECT url,
         COUNT(*) AS citations,
         COUNT(DISTINCT prompt||'|'||region_code||'|'||COALESCE(topics,'')) AS prompts_cited,
         ARRAY_AGG(DISTINCT category_name) FILTER (WHERE category_name IS NOT NULL) AS products,
         ARRAY_AGG(DISTINCT region_code)   FILTER (WHERE region_code   IS NOT NULL) AS regions
  FROM base GROUP BY url
)
SELECT url, citations, prompts_cited, products, regions,
       weekly_citations_json, weekly_prompts_cited_json,
       (SELECT COUNT(*) FROM url_agg) AS total_count
FROM url_agg ORDER BY citations DESC LIMIT p_limit OFFSET p_offset;
```

Weekly arrays (`weekly_citations`, `weekly_prompts_cited`) are JSONB arrays of `{"week":"IYYY-WNN","value":N}` produced by `JSONB_AGG` against the same `base` CTE.

---

## Response Shape

```json
{
  "urls": [
    {
      "url": "https://www.example.com/pdf-editor",
      "citations": 42,
      "promptsCited": 18,
      "products": ["Acrobat"],
      "regions": ["US", "GB"],
      "weeklyCitations": [
        { "week": "2026-W09", "value": 10 },
        { "week": "2026-W10", "value": 15 },
        { "week": "2026-W11", "value": 17 }
      ],
      "weeklyPromptsCited": [
        { "week": "2026-W09", "value": 5 },
        { "week": "2026-W10", "value": 7 },
        { "week": "2026-W11", "value": 6 }
      ]
    }
  ],
  "totalCount": 187
}
```

- `urls[].products` — unique `category_name` values observed for this URL in the window
- `urls[].regions` — unique `region_code` values
- `weeklyCitations` / `weeklyPromptsCited` — sorted ascending by ISO week
- `totalCount` is the full count across all pages, returned in every row of the RPC result; the controller reads it from the first row (or `0` if the page is empty)

---

## Sample URLs

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/owned-urls?siteId=c2473d89-...&page=0&pageSize=50
```

```
GET /org/44568c3e-.../brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/url-inspector/owned-urls?siteId=c2473d89-...&startDate=2026-02-01&endDate=2026-02-28&model=chatgpt&categoryId=Acrobat&regionCode=US
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; invalid `model`; RPC error |
| 403 | Site does not belong to the organization; no org access |
| 500 | RPC exception |

---

## Authentication & Access

Same as other URL Inspector endpoints — `withBrandPresenceAuth`, `getOrgAndValidateAccess`, site validated against org, LLMO entitlement required, internal-only route.

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Stats API](./url-inspector-stats-api.md)
- [URL Inspector Trending URLs API](./url-inspector-trending-urls-api.md) — the non-owned/earned counterpart
