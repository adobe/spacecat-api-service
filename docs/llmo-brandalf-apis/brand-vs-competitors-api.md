# Brand vs Competitors API

Returns aggregated competitor mention/citation data for a site. Internally performs two PostgREST queries: first discovers execution dates from `brand_presence_executions`, then queries the `brand_vs_competitors_by_date` view with those dates.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/brand-vs-competitors` | Competitor data for all brands |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/brand-vs-competitors` | Competitor data for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **Yes** | — | Site to get competitor data for |
| `startDate` | `start_date` | string (YYYY-MM-DD) | No | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | No | today | End of date range |
| `model` | — | string | No | `chatgpt` | LLM model |
| `categoryName` | `category_name` | string | No | — | Filter by category name |
| `regionCode` | `region_code`, `region` | string | No | — | Filter by region code |

---

## Sample URLs

**All brands, default date range:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/brand-vs-competitors?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

**Single brand with date range and filters:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/brand-vs-competitors?siteId=c2473d89-e997-458d-a86d-b4096649c12b&startDate=2026-01-01&endDate=2026-03-31&categoryName=SEO&regionCode=US
```

---

## Internal Queries (PostgREST)

This endpoint performs two sequential PostgREST queries:

**Step 1 — Discover execution dates:**
- Queries `brand_presence_executions` table
- Selects `execution_date`, filtered by `organization_id`, `site_id`, `model`, date range (`gte`/`lte`), optionally `brand_id`
- Deduplicates dates client-side via `Set`

**Step 2 — Query competitor aggregation:**
- Queries `brand_vs_competitors_by_date` VIEW
- Selects: `site_id`, `brand_id`, `brand_name`, `model`, `execution_date`, `category_name`, `region_code`, `competitor`, `total_mentions`, `total_citations`
- Uses `.in('execution_date', dates)` with chunking (50 dates per chunk)
- Optional filters: `brand_id`, `category_name`, `region_code`
- Row limit: 5000 per chunk

The underlying VIEW aggregates `executions_competitor_data` joined with `brand_presence_executions` and `organizations`, grouping by competitor (using `COALESCE(parent_company, competitor)` for fallback).

---

## Response Format

```json
{
  "competitorData": [
    {
      "siteId": "c2473d89-e997-458d-a86d-b4096649c12b",
      "brandId": "019cb903-1184-7f92-8325-f9d1176af316",
      "brandName": "Acme Corp",
      "model": "chatgpt",
      "executionDate": "2026-03-01",
      "categoryName": "SEO",
      "regionCode": "US",
      "competitor": "Competitor Inc",
      "totalMentions": 42,
      "totalCitations": 7
    }
  ]
}
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `siteId` not provided |
| 400 | Organization not found |
| 400 | PostgREST query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization |

---

## Related APIs

- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly brand mentions/citations with competitor totals
- [Share of Voice API](share-of-voice-api.md) — Topic-level SOV (RPC-backed)
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Filter dropdown values

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
