# Brand Presence Market Tracking Trends API

Returns weekly **brand** mention/citation counts (after prompt-level deduplication) plus per-competitor mention/citation totals per week for market-tracking charts. Uses `rpc_market_tracking_trends` — a PostgreSQL RPC that aggregates `brand_presence_executions` and `executions_competitor_data` server-side.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/market-tracking-trends` | Trends for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/market-tracking-trends` | Trends for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | — | string | `chatgpt` | LLM model |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID or name) | — | Filter by category UUID or category name |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code |

**Not supported on this endpoint (unlike filter-dimensions / sentiment-overview):** `topicIds`, `origin`.

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt` |

---

## Sample URLs

**All brands:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/market-tracking-trends?model=chatgpt
```

**Single brand with site and category:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/market-tracking-trends?startDate=2025-09-01&endDate=2025-09-30&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=0178a3f0-1234-7000-8000-000000000099&regionCode=US
```

---

## Internal Query (PostgREST RPC)

A single RPC call to `rpc_market_tracking_trends` performs all filtering, deduplication, and aggregation server-side in PostgreSQL.

**RPC parameters:** `p_organization_id`, `p_start_date`, `p_end_date`, `p_model`, optional `p_brand_id`, `p_site_id`, `p_category_id`, `p_category_name`, `p_region_code`, `p_max_competitors` (default 100).

---

## Aggregation (server-side in `rpc_market_tracking_trends`)

**Brand dedup:** Within each ISO week, rows from `brand_presence_executions` are deduplicated by `(prompt, topics, region_code, site_id)` using `BOOL_OR`. A key counts as mentioned/cited if any row for that key has the flag set.

**Competitor aggregation:** Rows from `executions_competitor_data` are grouped by `(week, competitor)` with `SUM(mentions)` / `SUM(citations)`. Competitors are ranked per week and capped at `p_max_competitors` (default 100).

**Ordering:** Weeks ascending. Competitors within a week sorted by `mentions + citations` descending.

The API handler (`reshapeMarketTrackingRows`) reshapes the flat RPC rows into the nested response format.

---

## Response Shape

The JSON body includes `weeklyTrends` and `weeklyTrendsForComparison`. Both properties hold the **same** week objects (duplicate arrays for clients that bind two chart series).

```json
{
  "weeklyTrends": [
    {
      "week": "2026-W10",
      "weekNumber": 10,
      "year": 2026,
      "mentions": 42,
      "citations": 18,
      "competitors": [
        { "name": "competitor_a", "mentions": 30, "citations": 10 },
        { "name": "competitor_b", "mentions": 12, "citations": 5 }
      ]
    }
  ]
}
```

`weeklyTrendsForComparison` repeats the `weeklyTrends` array (same length and entries).

**Per-week fields:**

| Field | Type | Description |
|-------|------|-------------|
| `week` | string | ISO week `YYYY-Wnn` |
| `weekNumber` | number | Week of year |
| `year` | number | ISO week year |
| `mentions` | number | Deduped brand mention count for the week |
| `citations` | number | Deduped brand citation count for the week |
| `competitors` | array | `{ name, mentions, citations }` per competitor, sorted by total activity |

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ postgres) |
| 400 | Organization not found |
| 400 | RPC query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization (when `siteId` provided; validated before queries) |

---

## Related APIs

- [Brand Presence Sentiment Overview API](sentiment-overview-api.md) — Weekly sentiment percentages
- [Share of Voice API](share-of-voice-api.md) — Topic-level SOV (RPC-backed)
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Filter dropdown values
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Applicable ISO weeks

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
