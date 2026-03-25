# Brand Presence Sentiment Overview API

Returns per-week sentiment distribution (positive, neutral, negative) for charting the Brand Presence sentiment overview. Data is read from `brand_presence_executions` via PostgREST (mysticat-data-service). Prompts are deduplicated per ISO week using the key `prompt|region_code|topics` so counts align with the legacy Brand Presence UI (unique prompts, not raw execution rows).

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/sentiment-overview` | Sentiment trends for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/sentiment-overview` | Sentiment trends for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

Parameters are read from the request the same way as other Brand Presence org routes (typically query string fields merged into `context.data`).

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID or name) | — | Filter by category UUID or category name |
| `topicIds` | — | string or array | — | Filter by topic UUID(s). Comma-separated, array, or single UUID; non-UUID values ignored |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, WW) |
| `origin` | — | string | — | Filter by origin (case-insensitive `ILIKE` match) |

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt` |

---

## Sample URLs

**All brands, default range:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/sentiment-overview
```

**Single brand with filters:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/sentiment-overview?startDate=2025-09-01&endDate=2025-09-30&model=gemini&regionCode=US
```

---

## Internal Query (PostgREST)

The handler selects from `brand_presence_executions`:

- **Columns:** `execution_date`, `sentiment`, `prompt`, `region_code`, `topics`
- **Filters:** `organization_id`, `execution_date` range, `model`, optional `site_id`, `brand_id` (when path is not `all`), `category_id` / `category_name`, `topic_id IN (...)`, `region_code`, `origin`
- **Row limit:** 200,000 rows (`WEEKS_QUERY_LIMIT`)

```javascript
client
  .from('brand_presence_executions')
  .select('execution_date, sentiment, prompt, region_code, topics')
  .eq('organization_id', organizationId)
  .gte('execution_date', startDate)
  .lte('execution_date', endDate)
  .eq('model', model)
  // + optional filters: site_id, brand_id, category_id/category_name, topic_id in, region_code, origin ilike
  .limit(200000)
```

---

## Aggregation (`aggregateSentimentByWeek`)

1. **Bucket by ISO week** — Each `execution_date` is mapped to a week string `YYYY-Wnn` (UTC).
2. **Deduplicate per week** — One row per `prompt|region_code|topics` per week; duplicates are skipped.
3. **Count sentiment** — `positive`, `neutral`, and `negative` are counted case-insensitively; empty or other values do not increment sentiment buckets but still count toward `totalPrompts`.
4. **Percentages** — `positivePct` and `negativePct` are rounded to integers; `neutralPct` = `100 - positivePct - negativePct` (so the three segments sum to 100 for display).

When `brands/all` is used and the same prompt appears for multiple brands, only the first-seen row per dedup key in iteration order is used (avoids double-counting across brands).

---

## Response Shape

```json
{
  "weeklyTrends": [
    {
      "week": "2026-W11",
      "weekNumber": 11,
      "year": 2026,
      "sentiment": [
        { "name": "Positive", "value": 45, "color": "#047857" },
        { "name": "Neutral", "value": 30, "color": "#4B5563" },
        { "name": "Negative", "value": 25, "color": "#B91C1C" }
      ],
      "totalPrompts": 120,
      "promptsWithSentiment": 100,
      "mentions": 0,
      "citations": 0,
      "visibilityScore": 0,
      "competitors": []
    }
  ]
}
```

**Field descriptions (per week object):**

| Field | Type | Description |
|-------|------|-------------|
| `week` | string | ISO week `YYYY-Wnn` |
| `weekNumber` | number | Week of year |
| `year` | number | ISO week year |
| `sentiment` | array | Three slices for charts: Positive, Neutral, Negative with `value` = percentage (0–100) and fixed `color` |
| `totalPrompts` | number | Unique prompts in the week (after dedup) |
| `promptsWithSentiment` | number | Subset of those with a recognized positive/neutral/negative sentiment |
| `mentions` | number | Always `0` in current implementation (reserved for chart compatibility) |
| `citations` | number | Always `0` |
| `visibilityScore` | number | Always `0` |
| `competitors` | array | Always `[]` for this endpoint |

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ postgres) |
| 400 | Organization not found |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization (when `siteId` provided) |

---

## Related APIs

- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly mentions, citations, and competitor breakdown
- [Brand Presence Sentiment Movers API](sentiment-movers-api.md) — Top/bottom sentiment movers between dates
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Filter dropdown values
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Applicable ISO weeks for selectors

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
