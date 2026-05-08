# LLMO-4525: URL Inspector PG — Fix Top-of-Page Filter Dropdowns (API Service Changes)

**Ticket:** [LLMO-4525](https://jira.corp.adobe.com/browse/LLMO-4525)  
**Branch:** `fix/url-inspector-pg-fix-top-LLMO-4525`  
**Full working notes:** `mysticat-data-service/docs/plans/2026-04-24-llmo-4525-url-inspector-pg-filter-dropdowns.md`

---

## What Changed in This Repo

New endpoint that exposes `rpc_url_inspector_filter_dimensions` (defined in `mysticat-data-service`) so the UI can populate the Category, Region, and Channel filter dropdowns on the URL Inspector PG page.

### Files

| File | Change |
|------|--------|
| `src/controllers/llmo/llmo-url-inspector.js` | `createUrlInspectorFilterDimensionsHandler` added |
| `src/controllers/llmo/llmo-mysticat-controller.js` | Import + export of new handler |
| `src/routes/index.js` | 2 new route entries |
| `src/routes/required-capabilities.js` | 2 new capability entries |
| `docs/openapi/api.yaml` | New path ref |
| `docs/openapi/llmo-api.yaml` | New operation definition |
| `docs/openapi/schemas.yaml` | New `UrlInspectorFilterDimensions` schema |
| `test/controllers/llmo/llmo-url-inspector.test.js` | 5 new test cases + import |
| `test/routes/index.test.js` | 2 new route assertions |

### New Routes

```
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/filter-dimensions
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/filter-dimensions
```

Query params: `siteId` (required), `startDate`, `endDate`, `platform` (optional).

Returns:

```json
{
  "categories":     [{ "id": "...", "label": "..." }],
  "regions":        [{ "id": "...", "label": "..." }],
  "content_types":  [{ "id": "...", "label": "..." }]
}
```

### Deploy Order

This service must be deployed **after** the `mysticat-data-service` migration that creates `rpc_url_inspector_filter_dimensions`. See full notes for details.
