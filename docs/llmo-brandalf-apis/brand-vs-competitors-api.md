# Brand vs Competitors API

Returns aggregated competitor mention/citation data from the `brand_vs_competitors_by_date` database view, filtered by specific execution dates. This is the second step in the two-step query pattern.

---

## Two-Step Usage Pattern

This endpoint is designed to be used in conjunction with the [Execution Dates API](./execution-dates-api.md):

1. **Step 1** — Call `GET .../brand-presence/execution-dates?siteId=X` to discover available execution dates for a site
2. **Step 2** — Call `GET .../brand-presence/brand-vs-competitors?executionDates=2026-03-01,2026-03-08` with selected dates

This pattern keeps date-range logic in the application layer while the database provides simple view-based aggregation with partition-pruned queries.

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
| `executionDates` | `execution_dates` | string (comma-separated YYYY-MM-DD) | **Yes** | — | Execution dates to query |
| `siteId` | `site_id` | string (UUID) | No | — | Filter by site |
| `model` | — | string | No | `chatgpt` | LLM model |
| `categoryName` | `category_name` | string | No | — | Filter by category name |
| `regionCode` | `region_code`, `region` | string | No | — | Filter by region code |

---

## Sample URLs

**All brands, two dates:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/brand-vs-competitors?executionDates=2026-03-01,2026-03-08
```

**Single brand with filters:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/brand-vs-competitors?executionDates=2026-03-01&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryName=SEO&regionCode=US
```

---

## Internal Queries (PostgREST)

Queries `brand_vs_competitors_by_date` VIEW:
- Selects: `site_id`, `brand_id`, `brand_name`, `model`, `execution_date`, `category_name`, `region_code`, `competitor`, `total_mentions`, `total_citations`
- Always filters by `organization_id` and `model`
- Uses `.in('execution_date', dates)` with chunking (50 dates per chunk)
- Optional filters: `site_id`, `brand_id`, `category_name`, `region_code`
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
| 400 | `executionDates` not provided or empty |
| 400 | Organization not found |
| 400 | PostgREST query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization |

---

## Related APIs

- [Execution Dates API](execution-dates-api.md) — First step: discover available execution dates for a site
- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly brand mentions/citations with competitor totals
- [Share of Voice API](share-of-voice-api.md) — Topic-level SOV (RPC-backed)
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Filter dropdown values

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
