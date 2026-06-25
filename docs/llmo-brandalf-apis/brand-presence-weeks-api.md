# Brand Presence Weeks API

Returns applicable ISO weeks (YYYY-Wnn) for the given model, optionally filtered by brand or site. Used to populate week selectors in the Brand Presence UI. Data is queried from `brand_presence_executions` via the `rpc_brand_presence_execution_date_range` RPC (mysticat-data-service). The RPC returns the min/max execution date range; the caller generates all ISO weeks between those dates.

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
| `model` | — | enum | `chatgpt-free` | LLM model. Must be one of: `chatgpt-paid`, `chatgpt-free`, `google-ai-overview`, `perplexity`, `google-ai-mode`, `copilot`, `gemini`, `google`, `microsoft`, `mistral`, `anthropic`, `amazon`. Returns 400 if invalid. |
| `siteId` | `site_id` | string (UUID) | — | Filter weeks to a specific site |

---

## Query Details

The API calls `rpc_brand_presence_execution_date_range` to get the min/max `execution_date` from `brand_presence_executions` for the given organization and model. The app then generates all ISO weeks between those dates and returns them sorted descending.

**RPC call:**
```javascript
const { data, error } = await client.rpc('rpc_brand_presence_execution_date_range', {
  p_organization_id: organizationId,
  p_model: model,
  p_site_id: siteId ?? null,
  p_brand_id: brandId ?? null,
});
// data: [{ min_date: '2026-01-12', max_date: '2026-03-15' }]
```

**Parameter mapping:**
| Query/Path | Maps to |
|------------|---------|
| `spaceCatId` (path) | `p_organization_id` |
| `model` (query) | `p_model` |
| `siteId` / `site_id` (query) | `p_site_id` |
| `brandId` (path, when not `all`) | `p_brand_id` |

**Response processing:** All ISO weeks between `min_date` and `max_date` are generated on the application side and returned sorted descending. Weeks with no executions within the range may appear (gap assumption).

**Data source:** `brand_presence_executions` via the `rpc_brand_presence_execution_date_range` RPC.

---

## Response Shape

```json
{
  "weeks": [
    {
      "week": "2026-W11",
      "startDate": "2026-03-09",
      "endDate": "2026-03-15"
    },
    {
      "week": "2026-W10",
      "startDate": "2026-03-02",
      "endDate": "2026-03-08"
    },
    {
      "week": "2026-W09",
      "startDate": "2026-02-23",
      "endDate": "2026-03-01"
    }
  ]
}
```

Each item has `week` (ISO week string YYYY-Wnn), `startDate` (Monday), and `endDate` (Sunday) in YYYY-MM-DD format. Weeks are sorted descending (most recent first).

---

## Sample URLs

**All brands, default model (chatgpt-free):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/weeks
```

**Single brand, chatgpt-paid model:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/weeks?model=chatgpt-paid
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
| 400 | Invalid `model` query parameter (not in llm_model enum) |
| 400 | Organization not found |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization (when siteId provided) |
| 200 | Success (weeks may be empty if no executions exist for the org/model) |

---

## Related APIs

- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options (brands, categories, topics, origins, regions, page_intents) for the Brand Presence feature.
- [Brand Presence Sentiment Overview API](sentiment-overview-api.md) — Weekly sentiment distribution
- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly mentions, citations, and competitor breakdown

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
