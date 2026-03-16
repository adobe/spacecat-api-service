# Brand Presence Weeks API

Returns applicable ISO weeks (YYYY-Wnn) for the given model, optionally filtered by brand or site. Used to populate week selectors in the Brand Presence UI. Data is queried from `brand_metrics_weekly` via PostgREST (mysticat-data-service). The table stores pre-aggregated weekly metrics with `week` already in YYYY-Wnn format.

---

## API Paths

| Method | Path | Description |
|--------|------|--------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/weeks` | Weeks for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/weeks` | Weeks for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. openai, chatgpt, gemini, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter weeks to a specific site |

---

## Query Details

The API queries `brand_metrics_weekly` via PostgREST. The table already has `week` in YYYY-Wnn format and the required filters (organization_id, model, site_id, brand_id). Results are ordered by `week` descending so the most recent weeks are returned within the limit.

**PostgREST query:**
```javascript
client
  .from('brand_metrics_weekly')
  .select('week')
  .eq('organization_id', organizationId)
  .eq('model', model)
  // + .eq('site_id', siteId)   when siteId query param provided
  // + .eq('brand_id', brandId)  when path has specific brand (not 'all')
  .order('week', { ascending: false })
  .limit(100000);
```

**Equivalent SQL:**
```sql
SELECT week
FROM brand_metrics_weekly
WHERE organization_id = :orgId
  AND model = :model
  -- AND site_id = :siteId   (when provided)
  -- AND brand_id = :brandId (when single brand route)
ORDER BY week DESC
LIMIT 100000;
```

**Parameter mapping:**
| Query/Path | Maps to |
|------------|---------|
| `spaceCatId` (path) | `organization_id` |
| `model` / `platform` (query) | `model` |
| `siteId` / `site_id` (query) | `site_id` |
| `brandId` (path, when not `all`) | `brand_id` |

**Response processing:** Distinct `week` values are deduplicated (multiple rows can share the same week across category/topic/region) and sorted descending.

**Row limit:** 100,000 rows so all available weeks are returned. `brand_metrics_weekly` has many rows per week (site × brand × category × region × topic); a lower cap (e.g. 5,000) would truncate older weeks.

**Data source (brand_metrics_weekly):** Pre-aggregated weekly metrics. One row per (site_id, week, model, brand_name, category_name, region_code, topic). Example columns used: `organization_id`, `site_id`, `week`, `model`, `brand_id`.

---

## Response Shape

```json
{
  "weeks": [
    {
      "2026-W11": {
        "startDate": "2026-03-09",
        "endDate": "2026-03-15"
      }
    },
    {
      "2026-W10": {
        "startDate": "2026-03-02",
        "endDate": "2026-03-08"
      }
    },
    {
      "2026-W09": {
        "startDate": "2026-02-23",
        "endDate": "2026-03-01"
      }
    }
  ]
}
```

Each week is an object keyed by the ISO week string (YYYY-Wnn). The value is `startDate` (Monday) and `endDate` (Sunday) in YYYY-MM-DD format. Weeks are sorted descending (most recent first).

---

## Sample URLs

**All brands, default model (chatgpt):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/weeks
```

**Single brand, openai model:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/weeks?model=openai
```

**Weeks for a specific site:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/weeks?model=gemini&siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

---

## Access Control

- Requires LLMO product access for the organization
- When `siteId` is provided, the site must belong to the organization (403 if not)

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Organization not found |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization (when siteId provided) |
| 200 | Success (weeks may be empty if no data in brand_metrics_weekly for the org/model) |

---

## Related APIs

- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options (brands, categories, topics, origins, regions, page_intents) for the Brand Presence feature.

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
