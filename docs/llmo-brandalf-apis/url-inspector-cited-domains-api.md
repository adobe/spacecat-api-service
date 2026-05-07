# URL Inspector Cited Domains API

Paginated domain-level citation aggregation: one row per hostname with total citations, distinct URLs, distinct prompts, dominant content type, plus comma-separated category/region breakdowns. Backs the "Domains" tab in the URL Inspector dashboard.

Computed by `rpc_url_inspector_cited_domains` against the `url_inspector_domain_stats` summary table (~1 s on large sites, same source as `stats`). Category and region strings are resolved via LATERAL joins on the **paginated** result rows only, so the aggregation cost scales with `pageSize`, not total domain count.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/cited-domains` | All brands for the site |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/cited-domains` | Brand UUID accepted but **not applied** (summary table has no `brand_id`) |

---

## Scope

Like `stats`, this endpoint is **site-scoped**. The summary table does not carry `brand_id`, so the `:brandId` path segment does not filter results.

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID |
| `startDate` | `start_date` | string | no | 28 days ago | |
| `endDate` | `end_date` | string | no | today | |
| `model` | `platform` | string | no | unset | LLM model enum |
| `categoryId` | `category_id`, `category` | string | no | — | Matches via `ANY(categories)` on the summary row |
| `regionCode` | `region_code`, `region` | string | no | — | Matches via `ANY(regions)` on the summary row |
| `channel` | `selectedChannel` | string | no | — | Exact match on `content_type` (`owned`, `earned`, `paid`, `partner`) |
| `page` | — | integer ≥ 0 | no | `0` | |
| `pageSize` | — | integer 1–1000 | no | `50` | |

---

## RPC Usage

**Function:** `rpc_url_inspector_cited_domains(UUID, DATE, DATE, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER)`

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
| `p_offset` | `page * pageSize` |

**Conceptual SQL:**
```sql
WITH grouped AS (
  SELECT hostname,
         SUM(citation_count) AS total_citations,
         SUM(unique_urls)    AS total_urls,
         SUM(unique_prompts) AS prompts_cited,
         MODE() WITHIN GROUP (ORDER BY content_type::TEXT) AS dom_content_type
  FROM url_inspector_domain_stats
  WHERE site_id = p_site_id
    AND execution_date BETWEEN p_start_date AND p_end_date
    AND (v_platform IS NULL OR model         = v_platform)
    AND (p_channel  IS NULL OR content_type::TEXT = p_channel)
    AND (p_category IS NULL OR p_category = ANY(categories))
    AND (p_region   IS NULL OR p_region   = ANY(regions))
  GROUP BY hostname
),
total  AS (SELECT COUNT(*) AS cnt FROM grouped),
ranked AS (SELECT *, (SELECT cnt FROM total) AS total_cnt FROM grouped
           ORDER BY total_citations DESC LIMIT p_limit OFFSET p_offset)
SELECT hostname AS domain, total_citations, total_urls, prompts_cited,
       dom_content_type AS content_type,
       cat_lateral AS categories, reg_lateral AS regions, total_cnt AS total_count
FROM ranked
LEFT JOIN LATERAL (...) cat_lateral ON true
LEFT JOIN LATERAL (...) reg_lateral ON true;
```

**Notes:**
- `total_urls` and `prompts_cited` are **approximate** for the same reason as `stats`: they sum per-group distinct counts from the summary table. Exact counts require the raw-table path.
- `content_type` per domain is the **statistical mode** across that domain's rows.
- `categories` and `regions` strings are comma-joined distinct tokens from all summary rows for each paginated hostname.

---

## Response Shape

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

- `domains[]` — up to `pageSize` entries, ordered by `totalCitations DESC`.
- `totalCount` — total distinct hostnames across the full window; lifted from the first RPC row (`0` for empty pages).

---

## Sample URLs

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/cited-domains?siteId=c2473d89-...&page=0&pageSize=50
```

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/cited-domains?siteId=c2473d89-...&channel=earned&regionCode=US&model=chatgpt
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; invalid `model`; RPC error |
| 403 | Site not in organization; no org access |
| 500 | RPC exception |

---

## Authentication & Access

Standard URL Inspector auth pipeline — `withBrandPresenceAuth`, `getOrgAndValidateAccess`, site–org validation.

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Domain URLs API](./url-inspector-domain-urls-api.md) — drill down into a single domain
- [URL Inspector Stats API](./url-inspector-stats-api.md) — shares the summary table
