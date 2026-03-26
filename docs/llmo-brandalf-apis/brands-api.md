# Brands API

CRUD management for brands within an organization. Brands group one or more sites under a named entity and carry metadata used across LLMO features (brand presence, opportunities, market tracking). Data is stored in normalized Postgres tables via PostgREST.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/orgs/:spaceCatId/brands` | List all brands for an org |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId` | Get a single brand by ID |
| POST | `/v2/orgs/:spaceCatId/brands` | Create a new brand |
| PATCH | `/v2/orgs/:spaceCatId/brands/:brandId` | Update a brand (partial) |
| DELETE | `/v2/orgs/:spaceCatId/brands/:brandId` | Soft-delete a brand |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/prompts` | List prompts for a brand |
| POST | `/v2/orgs/:spaceCatId/brands/:brandId/prompts` | Create prompts for a brand |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Get a single prompt |
| PATCH | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Update a prompt |
| DELETE | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Delete a prompt |
| POST | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/delete` | Bulk-delete prompts |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — Brand UUID (or brand name for PATCH/DELETE — resolved via case-insensitive name lookup if not a UUID)
- `promptId` — Prompt UUID

---

## Brand Data Model

All brand endpoints return and accept the same shape:

```json
{
  "id": "019cb903-1184-742b-9a16-bc7a8696962f",
  "name": "Adobe",
  "status": "active",
  "origin": "human",
  "description": "Adobe Inc.",
  "vertical": "Software & Technology",
  "region": ["US", "GB", "DE"],
  "urls": [
    { "value": "https://adobe.com" },
    { "value": "https://adobe.com/products" }
  ],
  "socialAccounts": [
    { "url": "https://twitter.com/adobe", "regions": ["US"] }
  ],
  "earnedContent": [
    { "name": "TechCrunch", "url": "https://techcrunch.com", "regions": ["US"] }
  ],
  "brandAliases": [
    { "name": "Adobe Inc", "regions": ["US"] },
    { "name": "ADBE", "regions": [] }
  ],
  "competitors": [
    { "name": "Microsoft", "url": null, "regions": [] },
    { "name": "Canva", "url": "https://canva.com", "regions": ["US"] }
  ],
  "siteIds": ["c2473d89-e997-458d-a86d-b4096649c12b"],
  "updatedAt": "2026-01-02T00:00:00Z",
  "updatedBy": "user@adobe.com"
}
```

**Field notes:**
- `status` — `active` (default), `pending`, or `deleted`; use `pending` for brands awaiting review
- `origin` — `human` (default) or `ai`
- `region` — ISO 3166-1 alpha-2 country codes (e.g. `US`, `GB`)
- `urls` — brand site URLs, optionally with paths (e.g. `https://adobe.com/products`); matched against the org's known sites to populate `siteIds`. Multiple paths under the same base URL share one `brand_sites` row.
- `socialAccounts` — `url` and `regions` are persisted and returned; `platform` sent by the UI is discarded
- `earnedContent` — `name`, `url`, and `regions` are persisted and returned
- `brandAliases` — each entry includes `name` and `regions`; accepts plain strings or `{ name }` objects on write
- `competitors` — each entry includes `name`, `url` (nullable), and `regions`; accepts plain strings or `{ name }` objects on write
- `siteIds` — read-only, resolved from `urls` via the `brand_sites` join table

---

## GET /v2/orgs/:spaceCatId/brands

Returns all non-deleted brands for the organization, sorted alphabetically by name.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter to a specific status (`active`, `pending`, `deleted`). Omit to return all non-deleted brands. |

**Response:**

```json
{
  "brands": [ /* array of brand objects */ ]
}
```

---

## GET /v2/orgs/:spaceCatId/brands/:brandId

Returns a single brand. `brandId` must be a UUID (name lookup is not supported for GET).

**Response:** Brand object (see data model above).

---

## POST /v2/orgs/:spaceCatId/brands

Creates a brand. Uses `organization_id + name` as the upsert conflict key — posting a brand with an existing name updates it instead.

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Brand name (unique per org) |
| `status` | no | `active` (default) or `pending` |
| `origin` | no | `human` (default) or `ai` |
| `description` | no | Free-text description |
| `vertical` | no | Industry vertical |
| `region` | no | Array of country codes |
| `urls` | no | Array of `{ value: string }` objects; matched to org sites |
| `socialAccounts` | no | Array of `{ url: string, regions?: string[] }` objects |
| `earnedContent` | no | Array of `{ name: string, url: string, regions?: string[] }` objects |
| `brandAliases` | no | Array of strings or `{ name: string, regions?: string[] }` objects |
| `competitors` | no | Array of strings or `{ name: string, url?: string, regions?: string[] }` objects |

**Response:** Created/updated brand object (`200`).

---

## PATCH /v2/orgs/:spaceCatId/brands/:brandId

Partially updates a brand. Only fields present in the request body are modified.

`brandId` accepts either a UUID or the brand's exact name (case-insensitive).

**Important:** All child arrays (`brandAliases`, `competitors`, `socialAccounts`, `earnedContent`, `urls`) use **full replace semantics** — when a field is present in the request body, all existing entries for that field are deleted and replaced with the submitted list. Omit a field entirely to leave it unchanged.

**Request body:** Any subset of the brand fields listed in the POST section above.

**Response:** Updated brand object (`200`), or `404` if not found.

---

## DELETE /v2/orgs/:spaceCatId/brands/:brandId

Soft-deletes a brand by setting `status = 'deleted'`. The brand remains in the database and can be retrieved with `?status=deleted`.

`brandId` accepts either a UUID or the brand's exact name (case-insensitive).

**Response:** `204 No Content` on success, `404` if not found.

---

## Prompts

Prompt management endpoints are documented separately. See [Prompts Management API](./prompts-management-api.md) for full details on listing, creating, updating, and bulk-deleting prompts scoped to a brand.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid `spaceCatId` (not a UUID); missing `brandId` or `name` |
| 403 | User does not have access to the organization |
| 404 | Organization not found; brand not found |
| 503 | PostgREST service unavailable (V2 config requires Postgres) |
| 500 | Unexpected storage error |

---

## Authentication & Access

- Requires LLMO product entitlement and organization membership (validated via `AccessControlUtil`)
- Routes are registered in `src/routes/index.js` under the `v2/orgs` prefix

---

## Related APIs

- [Prompts Management API](./prompts-management-api.md) — Prompt CRUD scoped to a brand
- [Categories API](./categories-api.md) — Org-level category management
- [Opportunities API](./opportunities-api.md) — LLMO opportunities scoped to a brand
- [Brand Presence Stats API](./brand-presence-stats-api.md) — Visibility statistics per brand
- [Topics & Topic Prompts API](./topics-api.md) — Brand presence analytics by topic (read-only)
