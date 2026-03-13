# Plan: V2 Prompts CRUD in Aurora (Brand-Scoped)

*Created: 2026-03-12*

## Summary

Implement a brand-scoped prompts CRUD API backed by the Aurora `prompts` table via PostgREST. Prompts are stored per brand with proper FKs to `brands`, `categories`, and `topics`. This plan aligns with the LLM database schema (2026-03-12) and the existing `prompts-storage.js` module.

---

## 1. Clarification: Data Access Patterns

### Where will this data surface?

| Consumer | Use case |
|----------|----------|
| Internal UI | Brand presence config, prompt management screens |
| Customer-facing UI | LLMO brand setup, prompt editing |
| Internal services | Brand presence execution pipeline (reads prompts for LLM queries) |

### Query patterns required

| Pattern | Supported | Notes |
|---------|------------|-------|
| List prompts by brand | Yes | `GET /v2/orgs/:spaceCatId/brands/:brandId/prompts` |
| Filter by categoryId, topicId, status | Yes | Query params on list endpoint |
| Get single prompt by prompt_id | Yes | `GET .../prompts/:promptId` |
| Create/upsert prompts | Yes | Bulk POST to brand-scoped endpoint |
| Update single prompt | Yes | PATCH by prompt_id |
| Soft delete | Yes | DELETE sets `status = 'deleted'` |
| Pagination | Yes | Offset-based with `limit` (page size) and `page`; returns `total` |
| Sort by field | No | Not required for initial scope |

### Read vs write frequency

- **Read**: High — prompts are read for every brand presence execution and config UI load
- **Write**: Low — config edits, bulk imports, AI-generated prompt additions

### Data model summary

- **Simple fields**: `prompt_id`, `name`, `text`, `status`, `origin`, `regions` (TEXT[])
- **References**: `brand_id`, `category_id`, `topic_id` (FKs)
- **Metadata**: `created_by`, `updated_by`, `created_at`, `updated_at`
- **Unique**: `(brand_id, prompt_id)` — business key per brand

---

## 2. Schema Alignment

### prompts table (from LLM schema)

| Column | Type | Required | API mapping |
|--------|------|----------|-------------|
| id | uuid | auto | Internal; not exposed in API |
| organization_id | uuid | yes | From spaceCatId |
| brand_id | uuid | yes | Resolved from brandId path param |
| prompt_id | text | yes | Business key; path param or body |
| name | text | yes | From body; default: text.slice(0,255) |
| text | text | yes | `prompt` in API |
| category_id | uuid | no | Resolved from categoryId (business key) |
| topic_id | uuid | no | Resolved from topicId (business key) |
| regions | TEXT[] | no | Normalized: lowercase, sorted |
| status | reference_status | no | active \| pending \| deleted |
| origin | category_origin | no | ai \| human |
| created_by | text | no | From auth |
| updated_by | text | no | From auth |
| created_at | timestamptz | auto | Read-only |
| updated_at | timestamptz | auto | Read-only |

### Dependencies

- **brands** — Must exist; `resolveBrandUuid()` supports uuid, config id, or name
- **categories** — Optional; `resolveCategoryUuid()` by `category_id` business key
- **topics** — Optional; `resolveTopicUuid()` by `topic_id` business key

---

## 3. API Design (OpenAPI First)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/prompts` | List prompts for a brand |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Get single prompt |
| POST | `/v2/orgs/:spaceCatId/brands/:brandId/prompts` | Create/upsert prompts (bulk) |
| PATCH | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Update single prompt |
| DELETE | `/v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` | Soft delete prompt |

### Query parameters (list endpoint)

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| limit | integer | no | Page size (default 100, min 1, max 500) |
| page | integer | no | Page number, 1-based (default 1) |
| categoryId | string | no | Filter by category business key |
| topicId | string | no | Filter by topic business key |
| status | string | no | active \| pending \| deleted; default excludes deleted |

### List response format (paginated)

```json
{
  "items": [ { "id", "prompt", "name", "regions", "categoryId", "topicId", "status", "origin", "updatedAt", "updatedBy", "brandId", "brandName", "category", "topic" } ],
  "total": 42,
  "limit": 100,
  "page": 1
}
```

### POST upsert uniqueness

For bulk create/upsert, a prompt is considered a match (and thus updated) if **either**:

1. **By id**: The request includes an `id` that matches an existing `prompt_id` for the brand, or
2. **By text + regions**: The `text` and `regions` (normalized: lowercase, sorted) match an existing row for the brand.

If neither matches, a new prompt is inserted.

### Request/response shapes

Reuse/extend `CustomerConfigPrompt` schema. Response includes enriched `brand`, `category`, `topic` objects for list/get.

### Access control

- **Organization-scoped**: User must have access to the organization (spaceCatId)
- **Product entitlement**: LLMO product (if applicable)
- Use `AccessControlUtil.hasAccess(organization)` before any operation

### PostgREST requirement

All endpoints require `DATA_SERVICE_PROVIDER=postgres` and `POSTGREST_URL`. Return 503 with clear message when PostgREST unavailable.

---

## 4. Implementation Steps

### Phase 1: OpenAPI spec

1. Add path definitions in `docs/openapi/paths/` or `customer-config-api.yaml`:
   - `GET /v2/orgs/:spaceCatId/brands/:brandId/prompts` (list)
   - `GET /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId` (single)
   - `POST /v2/orgs/:spaceCatId/brands/:brandId/prompts` (bulk upsert; uniqueness by id or text+regions)
   - `PATCH /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId`
   - `DELETE /v2/orgs/:spaceCatId/brands/:brandId/prompts/:promptId`
2. Add/update schemas in `schemas.yaml` (e.g. `V2Prompt`, `V2PromptListResponse` with `items`, `total`, `limit`, `page`)
3. Add examples in `examples.yaml`
4. Run `npm run docs:lint`

### Phase 2: Storage layer

- **Already implemented** in `src/support/prompts-storage.js`:
  - `resolveBrandUuid`, `resolveCategoryUuid`, `resolveTopicUuid`
  - `listPrompts`, `upsertPrompts`, `updatePromptById`, `deletePromptById`
- **Extend `listPrompts`** for pagination: Add `limit` (page size, default 100, max 500) and `page` (1-based). Return `{ items, total, limit, page }`. Use PostgREST `range` for offset/limit; run count query for total.
- **Upsert matching** (in `upsertPrompts`): Match by `prompt_id` (id) **or** by `(text, regions)` (normalized). If either matches, update; otherwise insert.
- **Add** `getPromptById` if not present — fetch single prompt by `(organizationId, brandUuid, promptId)`

### Phase 3: Controller methods

Add to `BrandsController` (or new `PromptsController` if preferred):

| Method | Storage call | Notes |
|--------|--------------|-------|
| `listPromptsByBrand` | `listPrompts({ brandId, categoryId, topicId, status, limit, page })` | Returns `{ items, total, limit, page }` |
| `getPromptByBrandAndId` | `getPromptById` (new) or `listPrompts` + filter | Single prompt |
| `createPrompts` | `upsertPrompts` | Bulk; match by id or (text, regions) |
| `updatePrompt` | `updatePromptById` | PATCH semantics |
| `deletePrompt` | `deletePromptById` | Soft delete |


### Phase 4: Routes and index

1. Add routes in `src/routes/index.js`
2. Add required capabilities in `src/routes/required-capabilities.js` (e.g. `organization:read`, `organization:write`)
3. Add route handlers in `src/index.js` if new pattern (e.g. `:brandId`, `:promptId` params)
4. Ensure UUID validation for `spaceCatId`; `brandId` and `promptId` are flexible (uuid or business key)

### Phase 5: DTO / response mapping

**List item** (and single get):

```javascript
{
  id: row.prompt_id,           // business key
  prompt: row.text,
  name: row.name,
  regions: row.regions || [],
  categoryId: category?.category_id ?? null,
  topicId: topic?.topic_id ?? null,
  status: row.status || 'active',
  origin: row.origin || 'human',
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  brandId: brand?.id ?? null,
  brandName: brand?.name ?? null,
  category: { id, name, origin } | null,
  topic: { id, name, categoryId } | null
}
```

**List response** (paginated):

```javascript
{
  items: [...],
  total: 42,
  limit: 100,
  page: 1
}
```

### Phase 6: Testing

1. **Unit tests** (`test/controllers/` or `test/support/`):
   - Mock `prompts-storage` and PostgREST
   - Test access control (403 for denied org)
   - Test 404 for missing brand/prompt
   - Test validation (required fields, invalid status)
   - Test bulk create/upsert: match by id, match by text+regions, insert when no match
   - Test pagination: limit respected, page returns correct page, total returned

2. **Integration tests** (`test/it/`):
   - Add seed data: `brands`, `categories`, `topics`, `prompts` in `postgres/seed-data/`
   - Register seeds in `postgres/seed.js`
   - Shared test factory in `test/it/shared/tests/prompts.js`
   - Wire in `test/it/postgres/prompts.test.js`
   - Test: list (with pagination: limit, page, total), get, create, update, delete with admin/user personas

3. **Docs build**: `npm run docs:build`

---

## 5. Behavior and Edge Cases

| Scenario | Behavior |
|----------|----------|
| Brand not found | 404 |
| Prompt not found | 404 |
| PostgREST unavailable | 503 with message |
| Duplicate on upsert (by id or text+regions) | Update existing row |
| categoryId/topicId invalid | 400 or resolve to null (document choice) |
| Empty regions | Normalize to `[]` |
| status=deleted on list | Excluded by default; include with `?status=deleted` |

---

## 6. Migration Notes

### Config vs prompts table

- **getCustomerConfig** / **getCustomerConfigLean** — Still read from `llmo_customer_config` JSONB. Brand `prompts` in config response may be stale if prompts are written via the prompts API.
- **Options**:
  - A) Sync prompts from `prompts` table into config on config read (merge)
  - B) Deprecate prompts-in-config; config returns `prompts: []` and clients use prompts API
  - C) Backfill: one-time migration script to copy config prompts → `prompts` table

---

## 7. Documentation Requirements (per workspace rules)

- **Query patterns**: List supports `categoryId`, `topicId`, `status` filters (index-based where applicable)
- **Pagination**: Offset-based with `limit` (page size) and `page` (1-based); response includes `items`, `total`, `limit`, `page`
- **Bandwidth**: List can be large; consider `GET .../prompts?fields=id,prompt,name` projection later
- **Concurrent updates**: Upsert uses `(brand_id, prompt_id)` unique; single-row PATCH is atomic
- **Access control**: Organization-level; user must have `hasAccess(organization)`

---

## 8. Checklist

- [x] OpenAPI paths and schemas
- [x] `getPromptById` in prompts-storage
- [x] Controller methods
- [x] Routes and capabilities
- [x] Unit tests (listPromptsByBrand)
- [ ] IT seed data (brands, categories, topics, prompts) — deferred; requires prompts table in mysticat-data-service
- [ ] IT shared tests and postgres wiring
- [x] docs:lint and docs:build
