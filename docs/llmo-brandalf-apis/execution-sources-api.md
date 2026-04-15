# Brand Presence Execution Sources API

Returns all `brand_presence_sources` rows for a single **brand presence execution**, with each row including the resolved **URL** and **hostname** from `source_urls`. Use this when the UI already knows an `executionId` (for example from prompt or topic detail) and needs source links without reloading full detail payloads.

---

## API Paths

OpenAPI: [`api.yaml`](../openapi/api.yaml) → `/org/{spaceCatId}/brands/all/.../sources` and `/org/{spaceCatId}/brands/{brandId}/.../sources` (see [`org-brand-presence-api.yaml`](../openapi/org-brand-presence-api.yaml)).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/executions/:executionId/sources` | Sources for an execution (any brand in the org) |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/executions/:executionId/sources` | Sources scoped to a specific brand |

**Path parameters:**

- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` or a brand UUID; when a UUID, the execution must belong to that brand or the API returns **404**
- `executionId` — `brand_presence_executions.id` (UUID)

---

## Query parameters

**Required** (must be present on every request; omitting any of them returns **400** with `Missing required query parameter: …`):

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | Start of date range for the parent execution lookup |
| `endDate` | `end_date` | string (YYYY-MM-DD) | End of date range |
| `platform` | `model` | string | LLM model enum (same values as other brand-presence APIs) |

Optional filters (same semantics as [Topic Detail API](topic-detail-api.md) / [Prompt Detail API](prompt-detail-api.md)):

| Parameter | Aliases | Type | Description |
|-----------|---------|------|-------------|
| `siteId` | `site_id` | string (UUID) | Filter by site; must belong to the organization |
| `regionCode` | `region`, `region_code` | string | Filter executions by region |
| `origin` | — | string | Filter by origin (case-insensitive partial match) |

The handler first loads the execution with these filters, then loads sources for `(execution_id, execution_date)` to align with partitioned `brand_presence_sources`.

---

## Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/executions/001b5813-283f-4563-9b94-3f32727f6051/sources?startDate=2026-02-01&endDate=2026-04-15&platform=chatgpt-free
```

---

## Response shape

```json
{
  "execution": {
    "executionId": "001b5813-283f-4563-9b94-3f32727f6051",
    "executionDate": "2025-04-28",
    "brandId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "siteId": "c2473d89-e997-458d-a86d-b4096649c12b",
    "model": "chatgpt-paid"
  },
  "sources": [
    {
      "urlId": "019cba12-b404-7077-9aa1-2992346a1767",
      "contentType": "earned",
      "isOwned": false,
      "url": "https://www.example.com/article",
      "hostname": "www.example.com"
    }
  ]
}
```

- `sources` is ordered as returned by PostgREST (not deduplicated by URL). Each item includes only `urlId`, `contentType`, `isOwned`, and resolved `url` / `hostname` from `source_urls`.
- `isOwned` mirrors `brand_presence_sources.is_owned`.

---

## Error responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ postgres) |
| 400 | Invalid `executionId` (not a UUID) |
| 400 | Missing required query parameter: `startDate`, `endDate`, or `platform` |
| 400 | Organization not found |
| 500 | PostgREST error while loading execution or sources (details are logged server-side only) |
| 403 | User does not belong to the organization |
| 403 | `siteId` does not belong to the organization |
| 404 | No execution matches `executionId` and filters (including brand scope) |

---

## Related APIs

- [Prompt Detail API](prompt-detail-api.md) — Full prompt detail including aggregated sources
- [Topic Detail API](topic-detail-api.md) — Topic-level detail and sources
- [Topics & Topic Prompts API](topics-api.md) — Table data that yields `executionId` values

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization and LLMO entitlement, consistent with other org brand-presence routes.
