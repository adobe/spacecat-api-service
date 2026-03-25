# Brand Presence Stats API

Returns aggregated visibility statistics (total executions, average visibility score, total mentions, total citations) for the Brand Presence feature. Data is computed via the `rpc_brand_presence_stats` RPC in mysticat-data-service. Optional weekly trends can be requested with `showTrends=true`.

---

## API Paths

| Method | Path | Description |
|--------|------|--------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/stats` | Stats for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/stats` | Stats for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

Parameters are passed in the request body (POST-style) or as query params, depending on how the client sends them. The handler uses `parseFilterDimensionsParams` for filter dimensions and `ctx.data` for body params.

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|--------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. chatgpt, gemini, copilot) |
| `showTrends` | `show_trends` | boolean/string | `false` | When truthy, adds weekly trends (max 8 weeks, newest-first) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site. Validated against org membership. |
| `categoryId` | `category_id` | string (UUID) | — | Filter by category. Must be valid UUID. |
| `topicIds` | — | string or array | — | Filter by topic UUID(s). Single UUID, comma-separated, or repeated param. |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, WW) |
| `origin` | — | string | — | Filter by origin (e.g. human, ai) |

**showTrends behavior:**
- Accepted values: `true`, `1`, `"true"`, `"1"` (case-insensitive)
- When enabled: splits the date range into 7-day weeks backward from `endDate`, up to 8 weeks
- Trends are returned in **newest-first** order
- Each trend entry has `startDate`, `endDate`, and `data.stats`

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt` |

---

## RPC Usage

The API calls the mysticat-data-service PostgREST RPC:

**Function:** `rpc_brand_presence_stats`

**Parameters (mapped from API):**

| RPC Parameter | API Source | Description |
|--------------|------------|-------------|
| `p_organization_id` | `spaceCatId` | Organization UUID |
| `p_start_date` | `startDate` | Start of range |
| `p_end_date` | `endDate` | End of range |
| `p_model` | `model` | LLM model |
| `p_brand_id` | `brandId` (when not `all`) | Brand UUID or NULL |
| `p_site_id` | `siteId` | Site UUID or NULL |
| `p_category_id` | `categoryId` (if valid UUID) | Category UUID or NULL |
| `p_topic_ids` | `topicIds` (parsed to array) | UUID array or NULL |
| `p_origin` | `origin` | Origin string or NULL |
| `p_region_code` | `regionCode` | Region code or NULL |

**SQL query (conceptual):**
```sql
SELECT
  COUNT(*)::BIGINT AS total_executions,
  COALESCE(ROUND(AVG(COALESCE(visibility_score, 0)), 2), 0) AS average_visibility_score,
  COUNT(*) FILTER (WHERE mentions = TRUE)::BIGINT AS total_mentions,
  COUNT(*) FILTER (WHERE citations = TRUE)::BIGINT AS total_citations
FROM brand_presence_executions
WHERE organization_id = p_organization_id
  AND execution_date >= p_start_date
  AND execution_date <= p_end_date
  AND model = p_model
  AND (p_brand_id IS NULL OR brand_id = p_brand_id)
  AND (p_site_id IS NULL OR site_id = p_site_id)
  AND (p_category_id IS NULL OR category_id = p_category_id)
  AND (p_topic_ids IS NULL OR cardinality(p_topic_ids) = 0 OR topic_id = ANY(p_topic_ids))
  AND (p_origin IS NULL OR origin = p_origin)
  AND (p_region_code IS NULL OR region_code = p_region_code);
```

---

## Response Shape

### Without trends (default)

```json
{
  "stats": {
    "total_executions": 1250,
    "average_visibility_score": 4.2,
    "total_mentions": 89,
    "total_citations": 312
  }
}
```

### With trends (`showTrends=true`)

```json
{
  "stats": {
    "total_executions": 1250,
    "average_visibility_score": 4.2,
    "total_mentions": 89,
    "total_citations": 312
  },
  "trends": [
    {
      "startDate": "2025-01-15",
      "endDate": "2025-01-21",
      "data": {
        "stats": {
          "total_executions": 180,
          "average_visibility_score": 4.5,
          "total_mentions": 12,
          "total_citations": 45
        }
      }
    },
    {
      "startDate": "2025-01-08",
      "endDate": "2025-01-14",
      "data": {
        "stats": { ... }
      }
    }
  ]
}
```

Trends are ordered **newest-first** (most recent week first).

---

## Sample URLs

**Basic stats (all brands, default date range):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/stats
```

**Stats with date range and model:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/stats?startDate=2025-01-01&endDate=2025-01-31&model=gemini
```

**Stats with weekly trends:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/stats?startDate=2025-01-01&endDate=2025-02-28&showTrends=true
```

**Stats for a specific brand with filters:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/stats?startDate=2025-01-01&endDate=2025-01-31&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=0178a3f0-1234-7000-8000-0000000000bb&topicIds=uuid1,uuid2&regionCode=US&origin=ai
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing `postgrestService`; organization not found; RPC error; site does not belong to org |
| 403 | User has no org access; site does not belong to organization |

---

## Authentication & Access

- Uses Brand Presence auth (`withBrandPresenceAuth`) with `getOrgAndValidateAccess`
- Requires LLMO product entitlement and organization access
- When `siteId` is provided, validates that the site belongs to the organization before querying
- Routes are in `INTERNAL_ROUTES` (not exposed to S2S consumers)

---

## Related APIs

- [Filter Dimensions API](./filter-dimensions-api.md) — Filter options for Brand Presence
- [Brand Presence Weeks API](./brand-presence-weeks-api.md) — Available weeks for date picker
- [Brand Presence Sentiment Overview API](./sentiment-overview-api.md) — Weekly sentiment distribution
- [Brand Presence Market Tracking Trends API](./market-tracking-trends-api.md) — Weekly mentions, citations, and competitors
