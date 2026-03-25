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
    { "value": "https://adobe.com" }
  ],
  "socialAccounts": [
    { "url": "https://twitter.com/adobe" }
  ],
  "earnedContent": [
    { "url": "https://techcrunch.com" }
  ],
  "brandAliases": ["Adobe Inc", "ADBE"],
  "competitors": ["Microsoft", "Canva"],
  "siteIds": ["c2473d89-e997-458d-a86d-b4096649c12b"],
  "updatedAt": "2026-01-02T00:00:00Z",
  "updatedBy": "user@adobe.com"
}
```

**Field notes:**
- `status` — `active` (default), `pending`, or `deleted`; use `pending` for brands awaiting review
- `origin` — `human` (default) or `ai`
- `region` — ISO 3166-1 alpha-2 country codes (e.g. `US`, `GB`)
- `urls` — brand site URLs; each is matched against the org's known sites to populate `siteIds`
- `socialAccounts` — only `url` is persisted; `platform` and `regions` sent by the UI are discarded
- `earnedContent` — only `url` is persisted; `name` and `regions` sent by the UI are discarded
- `brandAliases` — returned as a plain `string[]`; the UI's per-alias `regions` field is not stored
- `competitors` — returned as a plain `string[]`; the UI's per-competitor `url` and `regions` fields are not stored
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
| `socialAccounts` | no | Array of `{ url: string }` objects |
| `earnedContent` | no | Array of `{ url: string }` objects |
| `brandAliases` | no | Array of strings or `{ name: string }` objects |
| `competitors` | no | Array of strings or `{ name: string }` objects |

**Response:** Created/updated brand object (`200`).

---

## PATCH /v2/orgs/:spaceCatId/brands/:brandId

Partially updates a brand. Only fields present in the request body are modified.

`brandId` accepts either a UUID or the brand's exact name (case-insensitive).

**Important:** `brandAliases` and `competitors` are **append-only via upsert** — existing entries are not deleted when you send a shorter list. To remove an alias or competitor, delete it explicitly (not yet supported via this API; requires direct DB operation).

**Request body:** Any subset of the brand fields listed in the POST section above.

**Response:** Updated brand object (`200`), or `404` if not found.

---

## DELETE /v2/orgs/:spaceCatId/brands/:brandId

Soft-deletes a brand by setting `status = 'deleted'`. The brand remains in the database and can be retrieved with `?status=deleted`.

`brandId` accepts either a UUID or the brand's exact name (case-insensitive).

**Response:** `204 No Content` on success, `404` if not found.

---

## Prompts

Prompts are stored per-brand and used as LLM prompt templates.

### GET /v2/orgs/:spaceCatId/brands/:brandId/prompts

Returns all prompts for a brand.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by prompt type |
| `status` | string | Filter by status |

### POST /v2/orgs/:spaceCatId/brands/:brandId/prompts

Creates one or more prompts. Request body is an array of prompt objects.

### PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId

Updates a single prompt.

### DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId

Deletes a single prompt.

### POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/delete

Bulk-deletes prompts. Request body: `{ "promptIds": ["uuid1", "uuid2"] }`.

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

- [Opportunities API](./opportunities-api.md) — LLMO opportunities scoped to a brand
- [Brand Presence Stats API](./brand-presence-stats-api.md) — Visibility statistics per brand
- [Topics API](./topics-api.md) — Topics associated with a brand
