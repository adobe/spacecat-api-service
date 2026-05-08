# URL Inspector URL Prompts API

Phase-3 drill-down for the URL Inspector: every prompt (+ its category, region, topics) that cited a **single URL**, along with how many times each (prompt, category, region, topics) group was cited in the window. Used when a user clicks a URL in the Domain URLs or Trending URLs tab to see which queries sent LLM traffic to it.

Data comes from `rpc_url_inspector_url_prompts`, which joins `brand_presence_sources` with `brand_presence_executions` by `(execution_id, execution_date)` and groups by prompt metadata.

No pagination — the typical result set for one URL is small (tens to low hundreds of rows), and the UI renders the list inline. If this becomes an issue for very popular URLs, pagination can be added.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/url-inspector/url-prompts` | Prompts for one URL |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/url-prompts` | Brand UUID accepted but **not applied** (RPC does not take `p_brand_id`) |

---

## Scope

- Scoped by `url_id`; brand/category/region filters are **not** forwarded. Apply those higher up the drill-down (cited-domains, stats).

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **yes** | — | Site UUID |
| `urlId` | `url_id` | string (UUID) | **yes** | — | URL UUID from `source_urls.id` (typically comes from `domain-urls` response) |
| `startDate` | `start_date` | string | no | 28 days ago | |
| `endDate` | `end_date` | string | no | today | |
| `model` | `platform` | string | no | unset | LLM model enum |

---

## RPC Usage

**Function:** `rpc_url_inspector_url_prompts(UUID, DATE, DATE, UUID, TEXT)`

| RPC Parameter | API Source |
|---------------|------------|
| `p_site_id` | `siteId` |
| `p_start_date` | `startDate` |
| `p_end_date` | `endDate` |
| `p_url_id` | `urlId` |
| `p_platform` | `model` |

**Conceptual SQL:**
```sql
SELECT bpe.prompt,
       bpe.category_name AS category,
       bpe.region_code   AS region,
       bpe.topics,
       COUNT(*)::BIGINT AS citations
FROM brand_presence_sources bps
JOIN brand_presence_executions bpe
  ON bpe.id = bps.execution_id AND bpe.execution_date = bps.execution_date
WHERE bps.url_id = p_url_id
  AND bps.site_id = p_site_id
  AND bps.execution_date BETWEEN p_start_date AND p_end_date
  AND (v_platform IS NULL OR bpe.model = v_platform)
GROUP BY bpe.prompt, bpe.category_name, bpe.region_code, bpe.topics
ORDER BY citations DESC;
```

Content type is **not** filtered here — the caller already chose a specific URL, which has a fixed `content_type`.

---

## Response Shape

```json
{
  "prompts": [
    {
      "prompt": "best pdf editor for mac",
      "category": "Acrobat",
      "region": "US",
      "topics": "PDF Editing",
      "citations": 32
    },
    {
      "prompt": "pdf editor comparison",
      "category": "Acrobat",
      "region": "GB",
      "topics": "PDF Editing",
      "citations": 25
    }
  ]
}
```

- Sorted by `citations DESC`.
- Empty `category` / `region` / `topics` strings are returned (not `null`) when the source row had a NULL value.

---

## Sample URLs

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/url-prompts?siteId=c2473d89-...&urlId=019cba12-b404-7077-9aa1-2992346a1767
```

```
GET /org/44568c3e-.../brands/all/brand-presence/url-inspector/url-prompts?siteId=c2473d89-...&urlId=019cba12-b404-7077-9aa1-2992346a1767&model=chatgpt&startDate=2026-02-01&endDate=2026-02-28
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` missing; `urlId` missing; invalid `model`; RPC error |
| 403 | Site not in organization; no org access |
| 500 | RPC exception |

---

## Authentication & Access

Standard URL Inspector auth — `withBrandPresenceAuth`, `getOrgAndValidateAccess`, site–org validation.

---

## Related APIs

- [URL Inspector APIs Overview](./url-inspector-apis-overview.md)
- [URL Inspector Domain URLs API](./url-inspector-domain-urls-api.md) — parent level that exposes `urlId`
- [URL Inspector Trending URLs API](./url-inspector-trending-urls-api.md) — alternate entry point where each row already carries its own `prompts[]` list
