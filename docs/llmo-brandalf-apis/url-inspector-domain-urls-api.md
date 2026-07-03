# URL Inspector Domain URLs API

Phase-2 drill-down for the URL Inspector: paginated list of URLs under a **single hostname**, each with citation count, prompt count, dominant content type, and comma-separated category/region breakdowns. Used when a user clicks a domain in the Cited Domains tab.

Data comes from `rpc_url_inspector_domain_urls` against the raw `brand_presence_sources` + `brand_presence_executions` + `source_urls` tables (exact per-URL counts needed; summary table not sufficient).

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/domain-urls` | URLs for a given hostname |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/domain-urls` | Brand UUID accepted but **not applied** (RPC does not take `p_brand_id`) |

---

## Scope

- Site-scoped; `:brandId`, `categoryId`, and `regionCode` are **not** forwarded to the RPC for this drilldown. Broader filtering is expected to happen at the parent `cited-domains` call; the drilldown is scoped purely by hostname.

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID |
| `hostname` | `domain` | string | **yes** | — | Exact hostname (`www.example.com`); matched against `source_urls.hostname` |
| `startDate` | `start_date` | string | no | 28 days ago | |
| `endDate` | `end_date` | string | no | today | |
| `model` | `platform` | string | no | unset | LLM model enum |
| `channel` | `selectedChannel` | string | no | — | Exact match on `content_type` |
| `page` | — | integer ≥ 0 | no | `0` | |
| `pageSize` | — | integer 1–1000 | no | `50` | |

Other query params (`categoryId`, `regionCode`, `topicIds`, `origin`) are parsed but intentionally **not** passed to the RPC — the drilldown is hostname-scoped.

---

## RPC Usage

**Function:** `rpc_url_inspector_domain_urls(UUID, DATE, DATE, TEXT, TEXT, TEXT, INTEGER, INTEGER)`

| RPC Parameter | API Source |
|---------------|------------|
| `p_site_id` | `siteId` |
| `p_start_date` | `startDate` |
| `p_end_date` | `endDate` |
| `p_hostname` | `hostname` |
| `p_channel` | `channel` |
| `p_platform` | `model` |
| `p_limit` | `pageSize` |
| `p_offset` | `page * pageSize` |

**Conceptual SQL:**
```sql
WITH url_agg AS (
  SELECT su.id AS url_id, su.url, bps.content_type::TEXT AS ct,
         COUNT(*)::BIGINT AS citations,
         COUNT(DISTINCT bpe.prompt||'|'||bpe.region_code||'|'||COALESCE(bpe.topics,''))::BIGINT AS prompts_cited
  FROM brand_presence_sources bps
  JOIN source_urls su ON su.id = bps.url_id
  JOIN brand_presence_executions bpe
    ON bpe.id = bps.execution_id AND bpe.execution_date = bps.execution_date
  WHERE bps.site_id = p_site_id
    AND su.hostname = p_hostname
    AND bps.execution_date BETWEEN p_start_date AND p_end_date
    AND (p_channel  IS NULL OR bps.content_type::TEXT = p_channel)
    AND (v_platform IS NULL OR bps.model = v_platform)
    AND (v_platform IS NULL OR bpe.model = v_platform)
  GROUP BY su.id, su.url, bps.content_type
),
total  AS (SELECT COUNT(*)::BIGINT AS cnt FROM url_agg),
ranked AS (SELECT * FROM url_agg ORDER BY citations DESC LIMIT p_limit OFFSET p_offset)
SELECT r.url_id, r.url, r.ct AS content_type, r.citations, r.prompts_cited,
       COALESCE(cat_sub.cat_str,'') AS categories,
       COALESCE(reg_sub.reg_str,'') AS regions,
       (SELECT cnt FROM total)::BIGINT AS total_count
FROM ranked r
LEFT JOIN LATERAL (SELECT string_agg(DISTINCT bpe2.category_name, ',')
                   FROM brand_presence_sources bps2
                   JOIN brand_presence_executions bpe2 ON ...
                   WHERE bps2.url_id = r.url_id ...) cat_sub ON true
LEFT JOIN LATERAL (...) reg_sub ON true
ORDER BY r.citations DESC;
```

The LATERAL joins resolve `categories` / `regions` only for the **paginated** rows, not for the full set.

---

## Response Shape

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

- `urls[]` — up to `pageSize` entries, sorted by `citations DESC`.
- `totalCount` — total URLs for this hostname in the window; `0` for empty pages.

---

## Sample URLs

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/domain-urls?siteId=c2473d89-...&hostname=www.example.com&page=0&pageSize=50
```

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/domain-urls?siteId=c2473d89-...&hostname=competitor.com&channel=earned&model=chatgpt&startDate=2026-02-01&endDate=2026-02-28
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; `hostname` missing; invalid `model`; RPC error |
| 403 | Site not in organization; no org access |
| 500 | RPC exception |

---

## Authentication & Access

Standard URL Inspector auth — `withBrandPresenceAuth`, `getOrgAndValidateAccess`, site–org validation, LLMO entitlement, internal-only.

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Cited Domains API](./url-inspector-cited-domains-api.md) — the parent table this drills into
- [URL Inspector URL Prompts API](./url-inspector-url-prompts-api.md) — the next drill-down level (prompts for one URL)
