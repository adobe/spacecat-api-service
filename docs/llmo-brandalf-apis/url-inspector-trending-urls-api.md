# URL Inspector Trending URLs API

Paginated list of **non-owned** URLs (earned / competitor / third-party) that LLM answers cite, with the per-prompt breakdown that drove each URL's citations. Backs the "Trending URLs" tab in the URL Inspector dashboard.

The RPC returns one **flat row per URL × prompt**; the controller groups rows by URL into a `prompts[]` array on each item.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/trending-urls` | All brands for the site |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/trending-urls` | Filter to one brand UUID |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — `all` or a specific brand UUID (applied as `p_brand_id`)

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID (validated against org) |
| `startDate` | `start_date` | string (YYYY-MM-DD) | no | 28 days ago | |
| `endDate` | `end_date` | string (YYYY-MM-DD) | no | today | |
| `model` | `platform` | string | no | unset | LLM model enum; no default |
| `categoryId` | `category_id`, `category` | string | no | — | Exact match on `category_name` |
| `regionCode` | `region_code`, `region` | string | no | — | Exact match on `region_code` |
| `channel` | `selectedChannel` | string | no | — | Exact match on `brand_presence_sources.content_type` (e.g. `earned`, `paid`, `partner`). Note: `owned` is already excluded by the RPC — passing `owned` returns no rows. |
| `page` | — | integer ≥ 0 | no | `0` | |
| `pageSize` | — | integer 1–1000 | no | `50` | Default page size |

Pagination paginates by **URL**, not by flat (URL, prompt) rows — the RPC ranks URLs by total citations, takes the window `[offset, offset+limit)`, then emits all matching prompt rows for those URLs.

---

## RPC Usage

**Function:** `rpc_url_inspector_trending_urls(UUID, DATE, DATE, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, INTEGER)`

| RPC Parameter | API Source |
|---------------|------------|
| `p_site_id` | `siteId` |
| `p_start_date` | `startDate` |
| `p_end_date` | `endDate` |
| `p_category` | `categoryId` |
| `p_region` | `regionCode` |
| `p_channel` | `channel` |
| `p_platform` | `model` |
| `p_limit` | `pageSize` |
| `p_brand_id` | `:brandId` path |
| `p_offset` | `page * pageSize` |

**Conceptual SQL:**
```sql
WITH detail_agg AS (
  SELECT bps.url_id,
         bps.content_type::TEXT AS content_type,
         bpe.prompt, bpe.category_name, bpe.region_code, bpe.topics,
         COUNT(*) AS citation_count,
         COUNT(DISTINCT DATE_TRUNC('week', bpe.execution_date)) AS execution_count
  FROM brand_presence_sources bps
  JOIN brand_presence_executions bpe
    ON bpe.id = bps.execution_id AND bpe.execution_date = bps.execution_date
  WHERE bps.site_id = p_site_id
    AND bps.content_type != 'owned'                  -- hardcoded
    AND bps.execution_date BETWEEN v_start AND v_end
    AND (p_channel IS NULL OR bps.content_type::TEXT = p_channel)
    AND (v_platform IS NULL OR bps.model = v_platform)
    AND (v_platform IS NULL OR bpe.model = v_platform)
    AND (p_category IS NULL OR bpe.category_name = p_category)
    AND (p_region   IS NULL OR bpe.region_code   = p_region)
    AND (p_brand_id IS NULL OR bpe.brand_id      = p_brand_id)
  GROUP BY bps.url_id, bps.content_type, bpe.prompt, bpe.category_name, bpe.region_code, bpe.topics
),
url_rank AS (SELECT url_id, SUM(citation_count) AS total_citations FROM detail_agg GROUP BY url_id),
top_urls AS (SELECT url_id FROM url_rank ORDER BY total_citations DESC LIMIT p_limit OFFSET p_offset)
SELECT (SELECT COUNT(*) FROM url_rank) AS total_non_owned_urls,
       su.url, da.content_type, da.prompt, da.category_name AS category,
       da.region_code AS region, da.topics, da.citation_count, da.execution_count
FROM detail_agg da
JOIN top_urls tu ON tu.url_id = da.url_id
JOIN source_urls su ON su.id = da.url_id;
```

---

## Response Shape

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
        },
        {
          "prompt": "pdf editor comparison",
          "category": "Acrobat",
          "region": "GB",
          "topics": "PDF Editing",
          "citationCount": 25,
          "executionCount": 3
        }
      ]
    }
  ],
  "totalNonOwnedUrls": 412
}
```

- `urls[].contentType` — `earned`, `paid`, `partner`, etc. Derived from the first row seen per URL; within a URL it is a single value.
- `urls[].prompts[]` — all (prompt, category, region, topics) groups that cited this URL in the window.
- `urls[].totalCitations` — client-side sum of `prompts[].citationCount` (not returned directly by the RPC).
- `executionCount` — number of distinct **ISO weeks** (not individual executions) in which this (URL, prompt, category, region, topics) group was cited.
- `totalNonOwnedUrls` — total unique non-owned URLs across the full date range, **before pagination**. Reported on every RPC row and lifted from the first row.
- Rows with a NULL `url` (can appear when a URL was deleted from `source_urls`) are dropped by the handler before grouping.

---

## Sample URLs

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/trending-urls?siteId=c2473d89-...&page=0&pageSize=50
```

```
GET /org/44568c3e-.../brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/url-inspector/trending-urls?siteId=c2473d89-...&channel=earned&model=chatgpt&regionCode=US
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; invalid `model`; RPC error |
| 403 | Site does not belong to org; no org access |
| 500 | RPC exception |

---

## Authentication & Access

Same as the rest of the URL Inspector suite — `withBrandPresenceAuth`, site–org validation, LLMO entitlement, internal-only route.

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Owned URLs API](./url-inspector-owned-urls-api.md) — the owned-content counterpart
- [URL Inspector Cited Domains API](./url-inspector-cited-domains-api.md) — domain aggregation of the same data
