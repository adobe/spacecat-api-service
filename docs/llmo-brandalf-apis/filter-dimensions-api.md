# Brand Presence Filter Dimensions API

Returns available filter options (brands, categories, topics, origins, regions), execution **stats** from the same filtered row set, and **page_intents** for the Brand Presence feature. Dimensions and **stats** come from the PostgreSQL function `rpc_brand_presence_filter_dimensions` via PostgREST (mysticat-data-service). **page_intents** are loaded in a separate query.

---

## API Paths

| Method | Path | Description |
|--------|------|--------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/filter-dimensions` | Filter dimensions for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/filter-dimensions` | Filter dimensions for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | — | enum | `chatgpt-free` | LLM model. Must be one of: `chatgpt-paid`, `chatgpt-free`, `google-ai-overview`, `perplexity`, `google-ai-mode`, `copilot`, `gemini`, `google`, `microsoft`, `mistral`, `anthropic`, `amazon`. Returns 400 if invalid. |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID or name) | — | Filter by category. If UUID → `category_id`; if not UUID (e.g. "Acrobat") → `category_name` |
| `topicIds` | — | string or array | — | Filter by topic UUID(s). Single UUID, comma-separated UUIDs (e.g. `uuid1,uuid2`), or repeated param. Non-UUID values are ignored. Uses `topic_id` column. |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, WW) |
| `origin` | — | string | — | Filter by origin (`ILIKE` pattern on executions, same as RPC; e.g. `%organic%` or `ai`) |

**Parameters accepted for future schema support** (not yet applied):
- `user_intent` / `userIntent`
- `branding` / `promptBranding` / `prompt_branding`

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt-free` |

---

## Sample URL (All Parameters)

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions?startDate=2025-09-27&endDate=2025-09-30&model=google-ai-mode&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=Acrobat&topicIds=0178a3f0-1234-7000-8000-0000000000aa&regionCode=US&origin=ai
```

**Multiple topicIds (comma-separated):**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions?topicIds=uuid1,uuid2,uuid3
```

**Single brand variant:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/filter-dimensions?startDate=2025-09-27&endDate=2025-09-30&model=chatgpt-free&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=Acrobat&topicIds=0178a3f0-1234-7000-8000-0000000000aa&regionCode=US&origin=ai
```

---

## Response Shape

```json
{
  "brands": [
    { "id": "uuid", "label": "Brand Name" }
  ],
  "categories": [
    { "id": "Acrobat", "label": "Acrobat" }
  ],
  "topics": [
    { "id": "0178a3f0-1234-7000-8000-0000000000aa", "label": "combine pdf" }
  ],
  "origins": [
    { "id": "ai", "label": "ai" }
  ],
  "regions": [
    { "id": "US", "label": "US" }
  ],
  "stats": {
    "total_execution_count": 1200,
    "distinct_prompt_count": 80,
    "empty_answer_execution_count": 12
  },
  "page_intents": [
    { "id": "TRANSACTIONAL", "label": "TRANSACTIONAL" },
    { "id": "INFORMATIONAL", "label": "INFORMATIONAL" }
  ]
}
```

**stats** — From the RPC, over the same filtered executions as the dimension lists. Returned as numbers; the API coerces missing or non-finite values to `0`. If the database function does not yet return a `stats` key (older deployment), the response still includes **`stats`** with all three fields set to **`0`** so clients stay stable.

| Field | Meaning |
|--------|---------|
| `total_execution_count` | Row count after filters |
| `distinct_prompt_count` | Distinct non-null `prompt_id` values |
| `empty_answer_execution_count` | Rows with no answer (NULL, empty, or whitespace-only) |

**page_intents** — Distinct `page_intent` values from the `page_intents` table. See [Page Intents Scenarios](#page-intents-scenarios) for how site scope is determined.

---

## Internal: filter dimensions RPC (PostgREST)

The handler calls **`rpc_brand_presence_filter_dimensions`** with organization id, date range, resolved model, and optional filters (`p_brand_id`, `p_site_id`, `p_category_id`, `p_category_name`, `p_topic_ids`, `p_region_code`, `p_origin`). The RPC returns one JSON object: dimension arrays plus **`stats`**.

**Example request:**

```
POST /rpc/rpc_brand_presence_filter_dimensions
Content-Type: application/json

{
  "p_organization_id": "44568c3e-efd4-4a7f-8ecd-8caf615f836c",
  "p_start_date": "2025-09-27",
  "p_end_date": "2025-09-30",
  "p_model": "google-ai-mode",
  "p_site_id": "c2473d89-e997-458d-a86d-b4096649c12b",
  "p_category_name": "Acrobat",
  "p_topic_ids": ["uuid1", "uuid2"],
  "p_region_code": "US",
  "p_origin": "%organic%"
}
```

**topicIds parsing (query string → RPC):** Comma-separated string, array, or single UUID; non-UUID tokens dropped. Passed as `p_topic_ids`.

**Schema:** mysticat-data-service `docs/llmo-database-schema.md` § `rpc_brand_presence_filter_dimensions`.

---

### Page Intents Query (second query)

After the main query, the API fetches distinct `page_intent` values from the `page_intents` table.

#### Page Intents Scenarios

| Scenario | Path / Params | Query strategy | PostgREST query |
|----------|---------------|----------------|-----------------|
| **1. All brands, org only** | `brands/all` + no `siteId` | Org-based join (avoids URL length limits with 100+ sites) | `page_intents` joined with `sites` where `sites.organization_id = orgId` |
| **2. Specific brandId** | `brands/:brandId` + no `siteId` | Batched `.in()` (chunks of 50 site IDs) | `page_intents` where `site_id` in (distinct sites from executions) |
| **3. siteId provided** | Any path + `?siteId=xxx` | Single-site filter | `page_intents` where `site_id = siteId` |

**Result:** Page intents are returned for the scoped sites in each case.

```javascript
// 1. brands/all: org-based join (no URL length limit)
client
  .from('page_intents')
  .select('page_intent,sites!inner(organization_id)')
  .eq('sites.organization_id', organizationId)
  .limit(5000)

// 2. specific brand: batched .in() when many sites (chunk size 50)
for (chunk of siteIds in batches of 50) {
  client.from('page_intents').select('page_intent').in('site_id', chunk).limit(5000)
}

// 3. siteId param: single-site filter
client.from('page_intents').select('page_intent').eq('site_id', siteId).limit(5000)
```

**page_intents table** (mysticat-data-service): `id`, `site_id`, `url`, `page_intent` (enum: INFORMATIONAL, NAVIGATIONAL, TRANSACTIONAL, COMMERCIAL), `topic`, `created_at`, `updated_at`, `updated_by`

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Invalid `model` query parameter (not in llm_model enum) |
| 400 | Organization not found |
| 400 | PostgREST/PostgreSQL error |
| 403 | User does not belong to the organization |

---

## Related APIs

- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Returns applicable weeks for a given model, optionally filtered by brand or site.
- [Brand Presence Sentiment Overview API](sentiment-overview-api.md) — Weekly sentiment percentages
- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly mentions, citations, and competitor breakdown

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
