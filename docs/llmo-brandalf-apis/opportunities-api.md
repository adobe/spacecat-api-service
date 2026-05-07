# LLMO Opportunities API

Returns LLMO opportunity data at the organization level. Provides an aggregated count across all sites in the org, and a full listing of opportunities scoped to a brand or all org sites. Data is sourced from the SpaceCat DynamoDB opportunity store. Opportunities are filtered to LLMO-relevant types: `isElmo` tag, `prerender` type, or `llm-blocked` type, with status `NEW` or `IN_PROGRESS`.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/opportunities/count` | Total LLMO opportunity count across all org sites |
| GET | `/org/:spaceCatId/brands/all/opportunities` | All LLMO opportunities across all org sites |
| GET | `/org/:spaceCatId/brands/:brandId/opportunities` | LLMO opportunities for sites belonging to a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all org sites) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | — | Filter results to a single site. Must belong to the org (and the brand, for brand-scoped requests). Returns 403 if not. |

---

## Data Source & Filtering

Both endpoints query DynamoDB via the `Opportunity` data access model:

- **Site resolution:** `Site.allByOrganizationId(orgId)` for `brandId=all`; `getBrandById` (PostgREST) for a specific brand
- **Opportunity fetch:** `Opportunity.allBySiteId(siteId)` per site, processed with controlled concurrency (max 5 concurrent)
- **LLMO filter:** An opportunity is included if any of the following are true:
  - `tags` contains `isElmo`
  - `type === 'prerender'`
  - `type === 'llm-blocked'`
- **Status filter:** Only `NEW` or `IN_PROGRESS` opportunities are included
- **siteId filter:** When provided, the resolved site list is narrowed to the single matching site before fetching opportunities

---

## Response Shape

### `GET /org/:spaceCatId/opportunities/count`

```json
{
  "total": 12,
  "bySite": [
    {
      "siteId": "c2473d89-e997-458d-a86d-b4096649c12b",
      "baseURL": "https://www.example.com",
      "count": 7
    },
    {
      "siteId": "a1b2c3d4-0000-4000-8000-000000000001",
      "baseURL": "https://blog.example.com",
      "count": 5
    }
  ]
}
```

### `GET /org/:spaceCatId/brands/:brandId/opportunities`

Each opportunity in the `opportunities` array is the standard `OpportunityDto` shape enriched with `siteBaseURL`.

```json
{
  "brandId": "019cb903-1184-7f92-8325-f9d1176af316",
  "brandName": "Example Brand",
  "total": 2,
  "opportunities": [
    {
      "id": "opp-uuid-1",
      "siteId": "c2473d89-e997-458d-a86d-b4096649c12b",
      "siteBaseURL": "https://www.example.com",
      "type": "prerender",
      "status": "NEW",
      "title": "Prerender opportunity detected",
      "description": "...",
      "tags": ["isElmo"],
      "origin": "AI",
      "data": {},
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-02T00:00:00.000Z"
    }
  ]
}
```

For `brandId=all`, `brandName` is `"All"`.

---

## Sample URLs

**Total count across all org sites:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/opportunities/count
```

**Total count for a single site:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/opportunities/count?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

**All opportunities across all org sites:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/opportunities
```

**All opportunities for a specific brand:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/opportunities
```

**Opportunities for a specific brand, scoped to one site:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/opportunities?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 403 | User has no org access; `siteId` does not belong to the organization or brand |
| 404 | Organization not found; brand not found (specific brandId only) |
| 400 | Organization exceeds the 40-site limit for count requests; brand lookup requires PostgREST service but it is unavailable; unexpected error |
| 500 | Internal error fetching site list or opportunities |

Site-level fetch failures (e.g. DynamoDB timeout for a single site) are logged as warnings and do not fail the overall request — the affected site contributes 0 to the count or is omitted from the listing.

---

## Authentication & Access

- Requires LLMO product entitlement and organization membership (validated via `AccessControlUtil`)
- Routes are in `INTERNAL_ROUTES` (not exposed to S2S consumers)

---

## Related APIs

- [Brand Presence Stats API](./brand-presence-stats-api.md) — Visibility statistics for Brand Presence
- [Filter Dimensions API](./filter-dimensions-api.md) — Filter options for Brand Presence
