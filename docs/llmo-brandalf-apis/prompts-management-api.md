# Prompts Management API

CRUD management for prompts scoped to a brand within an organization. Prompts are the LLM queries tracked for brand visibility analysis. Data is stored in Postgres via PostgREST.

**Topics and categories are associated with prompts.** Topics are auto-created when referenced by name during prompt creation — there are no standalone topic management endpoints. Categories have their own management API (see [Categories API](./categories-api.md)).

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/prompts` | List prompts for a brand |
| POST | `/v2/orgs/:spaceCatId/brands/:brandId/prompts` | Bulk create or update prompts |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Get a single prompt |
| PATCH | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Update a prompt (partial) |
| DELETE | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Soft-delete a prompt |
| POST | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/delete` | Bulk soft-delete prompts |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `brandId` — Brand UUID
- `promptId` — Prompt UUID

---

## Prompt Data Model

```json
{
  "id": "019cb903-1184-742b-9a16-bc7a8696962f",
  "prompt": "best pdf editor for mac",
  "name": "PDF Editor Mac",
  "regions": ["US", "CA"],
  "categoryId": "acrobat",
  "topicId": "pdf-editing",
  "status": "active",
  "origin": "human",
  "source": "config",
  "updatedAt": "2026-01-02T00:00:00Z",
  "updatedBy": "user@adobe.com",
  "brandId": "019cb903-1184-742b-9a16-bc7a8696962e",
  "brandName": "Adobe",
  "category": {
    "id": "acrobat",
    "name": "Acrobat",
    "origin": "human"
  },
  "topic": {
    "id": "pdf-editing",
    "name": "PDF Editing",
    "categoryId": "acrobat"
  }
}
```

**Field notes:**
- `id` — Prompt UUID (business key); auto-generated on creation if omitted
- `prompt` — The prompt text (required)
- `name` — Optional display name for the prompt
- `regions` — Array of ISO 3166-1 alpha-2 country codes (e.g. `US`, `GB`); empty array means no region filter
- `categoryId` — Business key of the associated category (slug-style, e.g. `acrobat`); resolved from name if category auto-created
- `topicId` — Business key of the associated topic; topics are auto-created if referenced by name and do not yet exist
- `status` — `active` (default), `pending`, or `deleted`; soft-deletes set this to `deleted`
- `origin` — `human` (default for user-added prompts) or `ai`
- `source` — `config`, `api`, or custom string indicating how the prompt was added
- `category` / `topic` — Nested objects; `null` if not associated
- `updatedBy` — Email of the user who last modified the prompt, or `system` for programmatic changes

---

## GET /v2/orgs/:spaceCatId/brands/:brandId/prompts

Returns a paginated list of prompts for a brand. Active and deleted prompts are returned separately — use `status` to filter.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | 1-based page number |
| `limit` | integer | `50` | Items per page (max 5000) |
| `status` | string | — | Filter by status: `active`, `pending`, or `deleted`. Omit to return all. |
| `search` | string | — | Case-insensitive substring match against the prompt text |
| `categoryId` | string | — | Filter by category business key |
| `topicId` | string | — | Filter by topic business key |
| `region` | string | — | Filter by region code (e.g. `US`) |
| `origin` | string | — | Filter by origin: `human` or `ai` |
| `sort` | string | `updatedAt` | Sort field: `topic`, `prompt`, `category`, `origin`, `status`, `updatedAt` |
| `order` | string | `desc` | Sort direction: `asc` or `desc` |

**Response:**

```json
{
  "items": [ /* array of prompt objects */ ],
  "total": 142,
  "limit": 50,
  "page": 1
}
```

---

## POST /v2/orgs/:spaceCatId/brands/:brandId/prompts

Bulk creates or updates prompts. Accepts an array of prompt objects (max 3000 per request).

**Upsert behavior:**
- If a prompt with the same `id` (UUID) already exists for the brand, it is updated
- If no `id` is provided, deduplication falls back to matching on `prompt` text + normalized `regions` combination
- If neither matches an existing record, a new prompt is created

**Topic and category auto-creation:**
- If `categoryId` or `topicId` reference names that don't yet exist as records, they are auto-created with `origin: 'ai'` and `status: 'active'`
- Categories and topics created this way can be managed via the [Categories API](./categories-api.md) or updated in subsequent prompt requests

**Request body:** Array of prompt input objects.

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | yes | The prompt text |
| `id` | no | UUID for the prompt; auto-generated if omitted |
| `name` | no | Optional display name |
| `regions` | no | Array of region codes; defaults to `[]` |
| `categoryId` | no | Category business key or name |
| `topicId` | no | Topic business key or name; topic is auto-created if missing |
| `status` | no | `active` (default), `pending`, or `deleted` |
| `origin` | no | `human` (default) or `ai` |
| `source` | no | Source identifier string |

**Response:**

```json
{
  "created": 12,
  "updated": 3,
  "prompts": [ /* array of full prompt objects */ ]
}
```

---

## GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId

Returns a single prompt with full nested category and topic objects.

**Response:** Prompt object (see data model above). Returns `404` if not found.

---

## PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId

Partially updates a prompt. Only fields present in the request body are modified.

**Request body:** Any subset of the writable prompt fields:

| Field | Description |
|-------|-------------|
| `prompt` | New prompt text |
| `name` | New display name |
| `regions` | Replacement array of region codes (full replace) |
| `categoryId` | New category business key |
| `topicId` | New topic business key |
| `status` | New status (`active`, `pending`, `deleted`) — use `active` to restore a soft-deleted prompt |
| `origin` | New origin value |

**Response:** Updated prompt object (`200`), or `404` if not found.

---

## DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId

Soft-deletes a prompt by setting `status = 'deleted'`. The prompt remains in the database and can be retrieved with `?status=deleted` or restored via PATCH.

**Response:** `204 No Content` on success, `404` if not found.

---

## POST /v2/orgs/:spaceCatId/brands/:brandId/prompts/delete

Bulk soft-deletes prompts. Processes each prompt independently — partial success is possible.

**Request body:**

```json
{
  "promptIds": ["uuid1", "uuid2", "uuid3"]
}
```

Max 100 IDs per request.

**Response:**

```json
{
  "metadata": {
    "total": 3,
    "success": 2,
    "failure": 1
  },
  "failures": [
    {
      "promptId": "uuid3",
      "reason": "Prompt not found"
    }
  ]
}
```

---

## Topics

Topics are associated with prompts but do not have standalone CRUD endpoints. They are:

- **Auto-created** during prompt creation (POST) when a `topicId` references a name that doesn't yet exist
- **Updated implicitly** by updating the prompts that reference them
- **Readable** on each prompt object via the nested `topic` field

The `topicId` on a prompt is the topic's business key (a slug derived from the topic name, e.g. `pdf-editing` for "PDF Editing").

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid `spaceCatId` or `brandId` (not a UUID) |
| 400 | Missing required `prompt` field in POST body |
| 400 | POST body exceeds 3000 items; DELETE body exceeds 100 IDs |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not have access to the organization |
| 404 | Brand not found; prompt not found |
| 503 | PostgREST service unavailable |
| 500 | Unexpected storage error |

---

## Authentication & Access

- Requires LLMO product entitlement and organization membership (validated via `AccessControlUtil`)
- Requires Postgres-backed storage (`DATA_SERVICE_PROVIDER=postgres`)
- Routes are registered in `src/routes/index.js` under the `v2/orgs` prefix
- The `updatedBy` field is populated from the authenticated user's IMS profile email

---

## Related APIs

- [Brands API](./brands-api.md) — Brand management; brands scope the prompts
- [Categories API](./categories-api.md) — Org-level category management
- [Topics & Topic Prompts API](./topics-api.md) — Brand presence stats by topic (read-only analytics)
- [Brand Presence Stats API](./brand-presence-stats-api.md) — Visibility statistics per brand
