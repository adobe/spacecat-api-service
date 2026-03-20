# Share of Voice API

Returns per-topic share-of-voice data including brand mentions, competitor breakdown, ranking, and popularity. Aggregation is performed server-side by the `rpc_share_of_voice` PostgreSQL function (mysticat-data-service) and reshaped by the API handler.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/share-of-voice` | Share of voice for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/share-of-voice` | Share of voice for a specific brand |

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
| `categoryId` | `category_id` | string (UUID) | — | Filter by category (must be a valid UUID) |
| `topicIds` | — | string or array | — | Filter by topic UUID(s). Single UUID, comma-separated, or repeated param. Non-UUID values are ignored. |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, WW) |
| `origin` | — | string | — | Filter by origin (case-insensitive; e.g. `human`, `ai`) |
| `maxCompetitors` | `max_competitors` | integer | `5` | Max competitors returned per topic. Set higher (e.g. `50`) for detailed views. |

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt` |

---

## Sample URLs

**All brands, default filters:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/share-of-voice
```

**Single brand with filters:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/share-of-voice?startDate=2025-09-27&endDate=2025-09-30&model=gemini&siteId=c2473d89-e997-458d-a86d-b4096649c12b&categoryId=0178a3f0-1234-7000-8000-000000000099&regionCode=US&origin=ai
```

---

## Internal Query (RPC)

The API calls the `rpc_share_of_voice` PostgreSQL function via PostgREST. This function aggregates `brand_presence_executions` server-side, avoiding large payload transfers.

**PostgREST RPC call:**
```javascript
client.rpc('rpc_share_of_voice', {
  p_organization_id: organizationId,
  p_start_date: startDate,
  p_end_date: endDate,
  p_model: model,
  p_brand_id: brandId || null,
  p_site_id: siteId || null,
  p_category_id: categoryId || null,
  p_topic_ids: topicIds || null,
  p_origin: origin || null,
  p_region_code: regionCode || null,
  p_max_competitors: maxCompetitors || 5,
});
```

**RPC returns flat rows:**

| Column | Type | Description |
|--------|------|-------------|
| `topic` | text | Topic name (COALESCE to `'Unknown'` when NULL) |
| `brand_mentions` | bigint | Count of rows where `mentions = TRUE` for this topic |
| `competitor_name` | text | Individual competitor parsed from semicolon-separated `business_competitors`. NULL when topic has no competitors. |
| `competitor_mentions` | bigint | Count of rows containing this competitor name |
| `volume` | integer | Representative volume for the topic (`MIN` to preserve imputed negative sentinels) |

**RPC SQL logic:**
1. **filtered** CTE — filters `brand_presence_executions` by org, date range, model, and optional dimensions
2. **topic_brand** CTE — groups by topic, counts brand mentions (`mentions = TRUE`), takes `MIN(volume)`
3. **topic_competitors** CTE — uses `regexp_split_to_table` to parse semicolon-separated `business_competitors`, counts per competitor per topic
4. **ranked_competitors** CTE — assigns `ROW_NUMBER()` partitioned by topic, ordered by `comp_mentions DESC`
5. **Final SELECT** — LEFT JOINs `topic_brand` with `ranked_competitors` where `rn <= p_max_competitors` (or all when NULL), ordered by topic then competitor mentions descending

### Configured Competitors (parallel query)

A second query fetches configured competitor names and aliases from the `competitors` table for the organization. These are used to tag competitor entries with `source: 'configured'` vs `source: 'detected'`.

```javascript
client
  .from('competitors')
  .select('name, aliases')
  .eq('organization_id', organizationId)
  // + .eq('brand_id', brandId)  when path has specific brand
  .limit(5000)
```

### Brand Name Resolution

When a specific `brandId` is provided, the brand name is resolved from the `brands` table for display:

```javascript
client.from('brands').select('name').eq('id', brandId).limit(1)
```

Falls back to `'Our Brand'` if not found.

---

## Response Processing (aggregateShareOfVoice)

The handler reshapes the flat RPC rows into `ShareOfVoiceData[]`:

1. **Group by topic** — accumulates `brandMentions`, `volume`, and a competitors map per topic
2. **Compute popularity** — maps `volume` to a category:
   - `-30` → High, `-20` → Medium, `-10` → Low (imputed sentinel values)
   - Positive values use percentile bucketing against the average positive volume (33%/66% thresholds)
   - `0` or `null` → N/A
3. **Build entities** — each competitor + the brand entity get `name`, `mentions`, `shareOfVoice` (%), and `source`
4. **Rank** — entities sorted by SOV descending, brand prioritized over competitors at equal SOV
5. **Top competitors** — first 5 non-brand entities returned as `topCompetitors`; all as `allCompetitors`
6. **Sort topics** — final array sorted by popularity (High > Medium > Low > N/A), then by brand SOV descending

---

## Response Shape

```json
{
  "shareOfVoiceData": [
    {
      "id": "EVs-15-5",
      "topic": "EVs",
      "popularity": "High",
      "brandMentions": 5,
      "totalMentions": 15,
      "shareOfVoice": 33.33,
      "ranking": 2,
      "topCompetitors": [
        {
          "name": "tesla",
          "mentions": 6,
          "shareOfVoice": 40.0,
          "source": "configured"
        },
        {
          "name": "ford",
          "mentions": 4,
          "shareOfVoice": 26.67,
          "source": "detected"
        }
      ],
      "allCompetitors": [
        {
          "name": "tesla",
          "mentions": 6,
          "shareOfVoice": 40.0,
          "source": "configured"
        },
        {
          "name": "ford",
          "mentions": 4,
          "shareOfVoice": 26.67,
          "source": "detected"
        }
      ],
      "brandShareOfVoice": {
        "name": "Our Brand",
        "mentions": 5,
        "shareOfVoice": 33.33
      }
    }
  ]
}
```

**Field descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Composite key: `{topic}-{totalMentions}-{brandMentions}` |
| `topic` | string | Topic name |
| `popularity` | string | `High`, `Medium`, `Low`, or `N/A` |
| `brandMentions` | number | Count of brand mentions for this topic |
| `totalMentions` | number | Brand mentions + all competitor mentions |
| `shareOfVoice` | number \| null | Brand's SOV percentage. `null` when brand has no mentions. |
| `ranking` | number \| null | Brand's position among all entities (1-based). `null` when brand has no mentions. |
| `topCompetitors` | array | Top 5 competitors by SOV (excludes brand) |
| `allCompetitors` | array | All competitors by SOV (excludes brand) |
| `brandShareOfVoice` | object \| undefined | Brand entity with name, mentions, SOV. Undefined when brand has no mentions. |

**Competitor/brand entity shape:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Competitor or brand name (lowercased, trimmed) |
| `mentions` | number | Number of mentions |
| `shareOfVoice` | number | SOV percentage |
| `source` | string | `configured` (matches competitors table name/alias) or `detected` (found only in execution data) |

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Organization not found |
| 400 | RPC error (e.g. function does not exist, query failure) |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization (when siteId provided) |

---

## Access Control

- Requires valid authentication (JWT, IMS, or API key) with access to the organization
- Required capability: `brand:read`
- When `siteId` is provided, the site must belong to the organization (validated via `sites` table)

---

## Related APIs

- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options for the Brand Presence feature.
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Returns applicable weeks for a given model.
