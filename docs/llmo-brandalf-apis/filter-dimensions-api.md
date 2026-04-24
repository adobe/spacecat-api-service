# Brand Presence Filter Dimensions API

Returns available filter options for the Brand Presence feature: **brands**, **categories**, **topics**, fixed **origins** (`human`, `ai`), **regions** (from the `regions` reference table), **stats** (prompt counts and placeholder execution fields), and **page_intents**.

Dimensions are loaded from **mysticat-data-service** reference data (`regions`, `brands`, `categories`, `topics`) via PostgREST—not from `rpc_brand_presence_filter_dimensions`. **`distinct_prompt_count`** is a count of `prompts` rows for the same org/brand scope; **`total_execution_count`** and **`empty_answer_execution_count`** are reserved and currently returned as **`0`** until wired to executions data.

---

## API Paths

| Method | Path | Description |
|--------|------|--------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/filter-dimensions` | Filter dimensions for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions` | Filter dimensions for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query parameters

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| `siteId` | `site_id` | string (UUID) | Optional. When set, validates the site belongs to the organization and scopes brands (via `brand_sites` and legacy `brands.site_id`), topics, stats, and page intents to that site. |

Other query parameters may be present on shared Brand Presence URLs; **this handler only reads `siteId` / `site_id`**. Date range, model, category, topic, region, and origin filters are **not** applied to these dimension lists (use other Brand Presence APIs for execution-backed analytics).

---

## Sample URLs

**All brands:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions
```

**Single brand:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/filter-dimensions
```

**With site scope:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

---

## Response shape

```json
{
  "brands": [
    { "id": "uuid", "label": "Brand Name" }
  ],
  "categories": [
    { "id": "0178a3f0-1234-7000-8000-0000000000aa", "label": "Books" }
  ],
  "topics": [
    { "id": "0178a3f0-1234-7000-8000-0000000000aa", "label": "Topic A" }
  ],
  "origins": [
    { "id": "human", "label": "human" },
    { "id": "ai", "label": "ai" }
  ],
  "regions": [
    { "id": "US", "label": "United States" }
  ],
  "stats": {
    "total_execution_count": 0,
    "distinct_prompt_count": 12,
    "empty_answer_execution_count": 0
  },
  "page_intents": [
    { "id": "informational", "label": "informational" }
  ]
}
```

| Field | Source |
|--------|--------|
| `brands` | Org-wide: `brands` (active/pending). With `siteId`: **`brand_sites`** rows for that org + site, with embedded `brands` (id, name) |
| `categories` | `categories` (org, active/pending); each `id` is **`categories.id`** (UUID) for use as `categoryId` on other Brand Presence APIs |
| `topics` | `topics` filtered by org and optional brand scope |
| `origins` | Fixed: `human`, `ai` |
| `regions` | `regions` reference table |
| `stats.distinct_prompt_count` | Count of `prompts` for org / brand scope |
| `stats.total_execution_count`, `stats.empty_answer_execution_count` | Placeholder `0` until wired |
| `page_intents` | Distinct `page_intent` from `page_intents` (see below) |

---

## Page intents

Distinct `page_intent` values are loaded from the `page_intents` table:

- **`siteId` set:** `page_intents` for that site (after org validation).
- **`brands/all` without `siteId`:** org-wide query via `sites` join (same pattern as before, avoids huge `IN` lists).
- **`brands/:brandId` without `siteId`:** resolves a primary site from `brands.site_id` or `brand_sites` and queries `page_intents` for that site (or returns an empty list when no site can be resolved).

---

## Error responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | `brandId` is not `all` and not a valid UUID |
| 400 | Organization not found |
| 400 | Generic / access validation error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization (`siteId`) |
| 403 | Single brand not found, not accessible, or not linked to `siteId` when `siteId` is set |

---

## Related APIs

- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Applicable weeks for a given model, optionally filtered by brand or site.
- [Brand Presence Sentiment Overview API](sentiment-overview-api.md) — Weekly sentiment percentages
- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly mentions, citations, and competitor breakdown

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.

---

## Implementation

Handler: `createFilterDimensionsHandler` in `src/controllers/llmo/llmo-mysticat-controller.js` → `src/controllers/llmo/llmo-brand-presence.js`.
