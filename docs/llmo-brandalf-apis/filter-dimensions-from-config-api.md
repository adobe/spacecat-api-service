# Brand Presence Filter Dimensions From Config API

Returns filter options for Brand Presence **from reference data** (no execution time window, no LLM model). Use this endpoint when building UIs that follow **configured** brands, categories, topics, and prompts rather than slicing `brand_presence_executions` by date and model.

Compared to [Filter Dimensions API](filter-dimensions-api.md), this route:

- Does **not** accept `startDate`, `endDate`, `model`, `categoryId`, `topicIds`, `regionCode`, or `origin`.
- Does **not** call `rpc_brand_presence_filter_dimensions`. Dimensions are loaded from PostgREST tables (`regions`, `brands`, `categories`, `topics`, `page_intents`, etc.).
- Returns **origins** as fixed options `human` and `ai` (reference `category_origin` values for prompts).
- Returns **stats** with **`distinct_prompt_count`** from the **`prompts`** table (scoped like the brand list). **`total_execution_count`** and **`empty_answer_execution_count`** are **`0`** until wired to execution-based metrics.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/filter-dimensions-from-config` | Dimensions for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions-from-config` | Dimensions scoped to one brand (`brandId` UUID) |

**Path parameters:**

- `spaceCatId` — Organization ID (UUID), maps to `organization_id` in mysticat.
- `brandId` — `all` (all brands in scope) or a specific brand UUID.

**Required capability:** `brand:read` (see `src/routes/required-capabilities.js`).

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `siteId` | `site_id` | string (UUID) | — | Optional. When set, validates the site belongs to the organization, then scopes **brands** to that site (via `brand_sites` M2M and legacy `brands.site_id`). Also scopes **page_intents** to that site. |

Skip values such as `all`, empty string, `*`, or `null` are treated as “no site filter” (same semantics as other Brand Presence handlers).

---

## Sample URLs

**Org-wide (all brands), no site:**

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions-from-config
```

**Single brand:**

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/filter-dimensions-from-config
```

**With site scope:**

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions-from-config?siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

---

## Response Shape

```json
{
  "brands": [
    { "id": "uuid", "label": "Brand Name" }
  ],
  "categories": [
    { "id": "category_id", "label": "Display Name" }
  ],
  "topics": [
    { "id": "0178a3f0-1234-7000-8000-0000000000aa", "label": "Topic label" }
  ],
  "origins": [
    { "id": "human", "label": "human" },
    { "id": "ai", "label": "ai" }
  ],
  "regions": [
    { "id": "US", "label": "United States" }
  ],
  "stats": {
    "distinct_prompt_count": 42,
    "total_execution_count": 0,
    "empty_answer_execution_count": 0
  },
  "page_intents": [
    { "id": "informational", "label": "informational" }
  ]
}
```

### Dimensions (summary)

| Key | Source |
|-----|--------|
| `brands` | `brands` filtered by `organization_id`, optional site linkage (`brand_sites` + legacy `site_id`), `status` in `pending` / `active` when listing by org. |
| `categories` | `categories` for the org, `status` in `pending` / `active`. |
| `topics` | `topics` for the org; optional `brand_id` on topic rows is respected so topics match the resolved brand list. |
| `origins` | Fixed: `human`, `ai`. |
| `regions` | `regions` reference table (ordered by name). |
| `page_intents` | Distinct `page_intent` from `page_intents` for the resolved site scope (see below). |

### stats

| Field | Meaning |
|--------|---------|
| `distinct_prompt_count` | Count of rows in **`prompts`** with `organization_id`, `status` in `pending` / `active`, and `brand_id` in the same brand scope as **`brands`** in this response (single brand or union of visible brands). Chunked queries are used when many brand IDs apply. |
| `total_execution_count` | Reserved; always **`0`** until execution-based stats are added. |
| `empty_answer_execution_count` | Reserved; always **`0`** until execution-based stats are added. |

The **`prompts`** table has no `site_id`; site filtering affects the count only through which **brand IDs** are included (same as the `brands` array).

---

## Page intents scope (config endpoint)

`page_intents` uses the same `fetchPageIntents` helper as the execution-based filter-dimensions API, but site lists come from **config** (no executions query):

| Scenario | Condition | Behavior |
|----------|-----------|----------|
| **Site query param** | `siteId` set (and valid for org) | `page_intents` where `site_id = siteId`. |
| **All brands, no site** | `brands/all`, no `siteId` | Org-wide join on `page_intents` / `sites` (`sites.organization_id = org`). |
| **Specific brand, no site** | `brands/:brandId`, no `siteId` | Resolves a primary `site_id` from `brands.site_id` or first `brand_sites` row, then loads intents for that site (or none if unresolved). |

---

## Internal implementation (spacecat-api-service)

Handler: `createFilterDimensionsFromConfigHandler` in `src/controllers/llmo/llmo-mysticat-controller.js` → `src/controllers/llmo/llmo-brand-presence.js`.

PostgREST client: `context.dataAccess.Site.postgrestService` (mysticat-data-service). No `rpc_*` call for the main payload.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ postgres) |
| 400 | `brandId` is not `all` and is not a valid UUID |
| 400 | Organization not found or other org lookup error (message from access helper) |
| 403 | User does not belong to the organization |
| 403 | `siteId` does not belong to the organization |
| 403 | Single `brandId` not found or not accessible (including not linked to `siteId` when `siteId` is set) |

---

## Related APIs

- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Date range, model, execution-backed dimensions and RPC stats.
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Applicable weeks for a model (optional brand/site).

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization and **`brand:read`** for these routes.
