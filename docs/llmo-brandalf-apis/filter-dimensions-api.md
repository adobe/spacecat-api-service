# Brand Presence Filter Dimensions API

Returns available filter options (brands, categories, topics, origins, regions, page_intents) for the Brand Presence feature. Used to populate filter dropdowns in the UI. Data is queried from the `brand_presence_executions` table via PostgREST (mysticat-data-service).

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
| `model` | — | string | `chatgpt` | LLM model (e.g. chatgpt, gemini, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID or name) | — | Filter by category. If UUID → `category_id`; if not UUID (e.g. "Acrobat") → `category_name` |
| `topicId` | `topic_id`, `topic`, `topics` | string | — | Filter by topic (exact match on `topics` column) |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, WW) |
| `origin` | — | string | — | Filter by origin (exact match, case-insensitive; e.g. `human`, `ai`) |

**Parameters accepted for future schema support** (not yet applied):
- `user_intent` / `userIntent`
- `branding` / `promptBranding` / `prompt_branding`

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt` |

---

## Sample URL (All Parameters)

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/filter-dimensions?startDate=2025-09-27&endDate=2025-09-30&model=google-ai-mode&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=Acrobat&topicId=combine%20pdf&regionCode=US&origin=AI
```

**Single brand variant:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/filter-dimensions?startDate=2025-09-27&endDate=2025-09-30&model=chatgpt&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=Acrobat&topicId=combine%20pdf&regionCode=US&origin=AI
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
    { "id": "combine pdf", "label": "combine pdf" }
  ],
  "origins": [
    { "id": "ai", "label": "ai" }
  ],
  "regions": [
    { "id": "US", "label": "US" }
  ],
  "page_intents": [
    { "id": "TRANSACTIONAL", "label": "TRANSACTIONAL" },
    { "id": "INFORMATIONAL", "label": "INFORMATIONAL" }
  ]
}
```

**page_intents** — Distinct `page_intent` values from the `page_intents` table. See [Page Intents Scenarios](#page-intents-scenarios) for how site scope is determined.

---

## Internal Query (PostgREST)

The API builds a PostgREST query against the `brand_presence_executions` table. Equivalent logic:

```javascript
// Base query
client
  .from('brand_presence_executions')
  .select('brand_id, brand_name, category_name, topics, origin, region_code, site_id')
  .eq('organization_id', organizationId)
  .gte('execution_date', startDate)
  .lte('execution_date', endDate)
  .eq('model', model)

  // Optional filters (applied when param is provided and not empty)
  .eq('site_id', siteId)                    // if siteId
  .eq('brand_id', brandId)                  // if brandId !== 'all' (path param)
  .eq('category_id', categoryId)            // if categoryId is valid UUID
  .eq('category_name', categoryId)          // if categoryId is NOT valid UUID (e.g. "Acrobat")
  .eq('topics', topicId)                    // if topicId
  .eq('region_code', regionCode)            // if regionCode
  .ilike('origin', origin)                  // if origin (exact match, case-insensitive)

  .limit(5000)
```

**Equivalent PostgREST HTTP request** (example with all filters):
```
GET /brand_presence_executions?select=brand_id,brand_name,category_name,topics,origin,region_code&organization_id=eq.44568c3e-efd4-4a7f-8ecd-8caf615f836c&execution_date=gte.2025-09-27&execution_date=lte.2025-09-30&model=eq.google-ai-mode&site_id=eq.c2473d89-e997-458d-a86d-b4096649c12b&category_name=eq.Acrobat&topics=eq.combine%20pdf&region_code=eq.US&origin=ilike.ai&limit=5000
```

**Response processing:** The API deduplicates and sorts the results to build `brands`, `categories`, `topics`, `origins`, `regions`, and `page_intents` arrays. Each array is an array of `{ id, label }` objects.

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
| 400 | Organization not found |
| 400 | PostgREST/PostgreSQL error |
| 403 | User does not belong to the organization |

---

## Related APIs

- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Returns applicable weeks for a given model, optionally filtered by brand or site.

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
