# Brand Presence Sentiment Movers API

Returns the top 10 prompts whose sentiment changed the most between the earliest and latest execution dates. "Top movers" have improved sentiment; "bottom movers" have declined sentiment. Ranked by execution count (number of raw execution records) as a proxy for data volume and confidence.

Data is computed by the `rpc_sentiment_movers` PostgreSQL function via PostgREST (mysticat-data-service).

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/sentiment-movers` | Sentiment movers for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/sentiment-movers` | Sentiment movers for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `type` | — | string | `top` | Mover type: `top` (sentiment improved) or `bottom` (sentiment declined) |
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. chatgpt, google-ai-mode, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID) | — | Filter by category UUID |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, JP) |
| `origin` | — | string | — | Filter by origin (case-insensitive; e.g. `human`, `ai`) |
| `topicIds` | — | string (UUID CSV or array) | — | Filter by topic UUID(s). Accepts a single UUID, comma-separated UUIDs, or an array. Non-UUID values are ignored. |

---

## Default Values

| Parameter | Default |
|-----------|---------|
| `type` | `top` |
| `startDate` | 28 days before today |
| `endDate` | Today |
| `model` | `chatgpt` |

---

## Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/sentiment-movers?type=top&startDate=2026-02-09&endDate=2026-03-09&model=google-ai-mode&regionCode=US
```

**Bottom movers for a specific brand:**
```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/019cb903-1184-7f92-8325-f9d1176af316/brand-presence/sentiment-movers?type=bottom&startDate=2026-02-09&endDate=2026-03-09&model=chatgpt
```

---

## Response Shape

```json
{
  "movers": [
    {
      "prompt": "best pdf merge tool for mac",
      "topic": "Merge PDF",
      "category": "Acrobat",
      "region": "GB",
      "origin": "HUMAN",
      "popularity": "High",
      "fromSentiment": "neutral",
      "toSentiment": "positive",
      "fromDate": "2026-02-23",
      "toDate": "2026-03-09",
      "executionCount": 48
    }
  ]
}
```

### Mover Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The prompt text |
| `topic` | string | Topic/keyword the prompt belongs to |
| `category` | string | Content category |
| `region` | string | Geographic region code |
| `origin` | string | AI platform (e.g. "HUMAN", "AI") |
| `popularity` | string | `"High"`, `"Medium"`, `"Low"`, or `"N/A"` — derived from volume column |
| `fromSentiment` | string | Sentiment at the earliest execution date (lowercase) |
| `toSentiment` | string | Sentiment at the latest execution date (lowercase) |
| `fromDate` | string | Execution date of earliest record (YYYY-MM-DD) |
| `toDate` | string | Execution date of latest record (YYYY-MM-DD) |
| `executionCount` | number | Number of raw execution records (ranking key) |

---

## Algorithm

The `rpc_sentiment_movers` PostgreSQL function implements this logic:

1. **Filter** `brand_presence_executions` by organization, date range, model, and optional filters
2. **Rank** rows per `(prompt, region_code, site_id)` partition to find the first and last execution by date
3. **Score** sentiments: positive=2, neutral=1, negative=0
4. **Select** movers where sentiment changed in the requested direction:
   - `type=top`: last_score > first_score (improvement)
   - `type=bottom`: first_score > last_score (decline)
5. **Order** by execution_count DESC, topic ASC, prompt ASC
6. **Limit** to 10 results

When duplicates exist for the same `(prompt, region, site_id, execution_date)`, tie-breaking uses alphabetical sentiment ordering (ASC for first, DESC for last) to ensure deterministic results.

---

## Internal Query (PostgREST RPC)

The API calls the PostgreSQL function via PostgREST `.rpc()`:

```javascript
client.rpc('rpc_sentiment_movers', {
  p_organization_id: organizationId,
  p_start_date: startDate,
  p_end_date: endDate,
  p_model: model,
  p_type: type,           // 'top' or 'bottom'
  p_brand_id: brandId,    // optional
  p_site_id: siteId,      // optional
  p_category_id: categoryId, // optional (UUID only)
  p_origin: origin,       // optional
  p_region_code: regionCode, // optional
  p_topic_ids: topicIds,  // optional (UUID[])

});
```

**Equivalent PostgREST HTTP request:**
```
POST /rpc/rpc_sentiment_movers
Content-Type: application/json

{
  "p_organization_id": "44568c3e-efd4-4a7f-8ecd-8caf615f836c",
  "p_start_date": "2026-02-09",
  "p_end_date": "2026-03-09",
  "p_model": "google-ai-mode",
  "p_type": "top"
}
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Organization not found |
| 400 | Invalid `type` parameter (not "top" or "bottom") |
| 400 | PostgREST/PostgreSQL error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization |

---

## Related APIs

- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Returns applicable weeks

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
