# Categories API

CRUD management for prompt categories scoped to an organization. Categories group prompts by theme or product area (e.g. "Acrobat", "PDF Editing") and are shared across all brands within the org. Data is stored in Postgres via PostgREST.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/orgs/:spaceCatId/categories` | List all categories for an org |
| POST | `/v2/orgs/:spaceCatId/categories` | Create a new category |
| PATCH | `/v2/orgs/:spaceCatId/categories/:categoryId` | Update a category (partial) |
| DELETE | `/v2/orgs/:spaceCatId/categories/:categoryId` | Soft-delete a category |

**Path parameters:**
- `spaceCatId` — Organization UUID
- `categoryId` — Category business key (slug-style, e.g. `acrobat`)

---

## Category Data Model

```json
{
  "id": "acrobat",
  "uuid": "019cb903-1184-742b-9a16-bc7a8696962f",
  "name": "Acrobat",
  "status": "active",
  "origin": "human",
  "updatedAt": "2026-01-02T00:00:00Z",
  "updatedBy": "user@adobe.com"
}
```

**Field notes:**
- `id` — Business key (slug), auto-derived from `name` at creation time (e.g. `"PDF Editing"` → `pdf-editing`); used in path parameters and as the `categoryId` on prompt objects
- `uuid` — Internal database UUID; not used in API paths
- `name` — Display name of the category
- `status` — `active` (default) or `deleted`; soft-deletes set this to `deleted`
- `origin` — `human` (default for user-created categories) or `ai` (auto-created during prompt upsert)
- `updatedBy` — Email of the user who last modified the category, or `system` for auto-created categories

---

## GET /v2/orgs/:spaceCatId/categories

Returns all categories for the organization, sorted alphabetically by name.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter to a specific status (`active` or `deleted`). Omit to return all non-deleted categories. |

**Response:**

```json
{
  "categories": [
    {
      "id": "acrobat",
      "uuid": "019cb903-1184-742b-9a16-bc7a8696962f",
      "name": "Acrobat",
      "status": "active",
      "origin": "human",
      "updatedAt": "2026-01-02T00:00:00Z",
      "updatedBy": "user@adobe.com"
    }
  ]
}
```

---

## POST /v2/orgs/:spaceCatId/categories

Creates a new category. The `id` (business key) is auto-generated from the `name`.

If a category with the same derived `id` already exists for the org, it is returned as-is (no error).

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Display name of the category (used to derive the `id` slug) |
| `origin` | no | `human` (default) or `ai` |
| `status` | no | `active` (default) or `pending` |

**Response:** Created category object (`201`).

---

## PATCH /v2/orgs/:spaceCatId/categories/:categoryId

Partially updates a category. Only fields present in the request body are modified.

**Request body:**

| Field | Description |
|-------|-------------|
| `name` | New display name |
| `origin` | New origin value |
| `status` | New status (`active` or `deleted`) — use `active` to restore a soft-deleted category |

**Response:** Updated category object (`200`), or `404` if not found.

---

## DELETE /v2/orgs/:spaceCatId/categories/:categoryId

Soft-deletes a category by setting `status = 'deleted'`. The category remains in the database and can be retrieved with `?status=deleted` or restored via PATCH.

Prompts associated with a deleted category retain their `categoryId` reference — the category can be restored without data loss.

**Response:** `204 No Content` on success, `404` if not found.

---

## Auto-Created Categories

Categories are automatically created with `origin: 'ai'` when a prompt is upserted with a `categoryId` that references a name not yet in the database. These auto-created categories appear in the list response alongside user-created ones and can be updated via PATCH to correct the name or change the origin.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid `spaceCatId` (not a UUID) |
| 400 | Missing required `name` field in POST body |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not have access to the organization |
| 404 | Category not found |
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

- [Prompts Management API](./prompts-management-api.md) — Prompts that reference categories
- [Brands API](./brands-api.md) — Brand management
