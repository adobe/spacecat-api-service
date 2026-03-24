# Brand Presence Execution Dates API

Returns distinct execution dates for a given site's brand presence data, sorted newest first. This is the first step in the two-step brand-vs-competitors query pattern: get available dates, then query competitor data for selected dates.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/execution-dates` | Execution dates for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/execution-dates` | Execution dates for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Required | Default | Description |
|-----------|---------|------|----------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | **Yes** | — | Site to get execution dates for |
| `model` | — | string | No | `chatgpt` | LLM model |

---

## Sample URLs

**All brands:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/execution-dates?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

**Single brand:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/execution-dates?siteId=c2473d89-e997-458d-a86d-b4096649c12b&model=chatgpt
```

---

## Internal Queries (PostgREST)

Queries `brand_presence_executions` table:
- Selects `execution_date` column
- Filters: `organization_id`, `site_id` (required), `model`, optionally `brand_id`
- Deduplicates dates client-side via `Set`
- Sorts descending (newest first)
- Row limit: 5000

---

## Response Format

```json
{
  "executionDates": [
    "2026-03-15",
    "2026-03-08",
    "2026-03-01",
    "2026-02-22"
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

- [Brand vs Competitors API](brand-vs-competitors-api.md) — Second step: query competitor data for selected execution dates
- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly brand mentions/citations with competitor totals
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Filter dropdown values

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
