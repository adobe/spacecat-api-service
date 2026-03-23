# Brand Presence Prompt Detail API

Returns all execution rows, weekly aggregated statistics, and citation sources for a specific **prompt+region** combination within a topic — powering the **detail dialog** that opens when a user clicks "Details" on a prompt row in the Data Insights table.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompt-detail` | Prompt detail for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompt-detail` | Prompt detail for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID
- `topicId` — URL-encoded topic name (e.g. `PDF%20Editing`)

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `prompt` | — | string | **(required)** | The prompt text to look up |
| `promptRegion` | `prompt_region` | string | — | Region code to scope the prompt (e.g. US, DE) |
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. chatgpt, google-ai-mode, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `origin` | — | string | — | Filter by origin (case-insensitive; e.g. `human`, `ai`) |

---

## Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/topics/PDF%20Editing/prompt-detail?prompt=best%20pdf%20editor%20for%20mac&promptRegion=US&startDate=2026-02-09&endDate=2026-03-09&model=chatgpt
```

---

## Response Shape

```json
{
  "topic": "PDF Editing",
  "prompt": "best pdf editor for mac",
  "region": "US",
  "stats": {
    "visibilityScore": 82.5,
    "position": "2.3",
    "sentiment": 83,
    "mentions": 4,
    "citations": 3
  },
  "weeklyStats": [
    {
      "week": "2026-W10",
      "visibilityScore": 80,
      "position": 2.5,
      "mentions": 1,
      "citations": 1,
      "volume": "High",
      "sentiment": 75
    },
    {
      "week": "2026-W11",
      "visibilityScore": 85,
      "position": 2.0,
      "mentions": 1,
      "citations": 1,
      "volume": "High",
      "sentiment": 100
    }
  ],
  "executions": [
    {
      "prompt": "best pdf editor for mac",
      "region": "US",
      "executionDate": "2026-03-08",
      "week": "2026-W10",
      "answer": "Based on current reviews, the top PDF editors for Mac include...",
      "mentions": true,
      "citations": true,
      "visibilityScore": 85,
      "position": "2",
      "sentiment": "Positive",
      "volume": "-30",
      "origin": "human",
      "category": "Acrobat",
      "sources": "https://example.com/pdf-editor",
      "errorCode": ""
    }
  ],
  "sources": [
    {
      "url": "https://example.com/pdf-editor-review",
      "hostname": "example.com",
      "contentType": "earned",
      "citationCount": 3,
      "weeks": ["2026-W10", "2026-W11"],
      "prompts": [
        { "prompt": "best pdf editor for mac", "count": 3 }
      ]
    }
  ]
}
```

---

## Response Field Reference

### `stats` Object

| Field | Type | Description |
|-------|------|-------------|
| `visibilityScore` | number | Mean visibility score across all executions of this prompt (0–100, rounded to 2 decimals) |
| `position` | string | Mean position (rounded to 2 decimals; empty string if all positions are invalid or "Not Mentioned") |
| `sentiment` | number | Mean sentiment score: positive=100, neutral=50, negative=0 (rounded to integer; -1 if no data) |
| `mentions` | number | Total mention count across all executions |
| `citations` | number | Total citation count across all executions |

### `weeklyStats[]` Array

Pre-aggregated weekly statistics for the detail dialog mini-charts. Sorted chronologically (oldest first). Same structure as the [Topic Detail API](topic-detail-api.md#weeklystats-array).

| Field | Type | Description |
|-------|------|-------------|
| `week` | string | ISO week string (e.g. `"2026-W10"`) |
| `visibilityScore` | number | Average visibility score for the week (rounded to integer) |
| `position` | number | Average position for the week (rounded to 2 decimals; 0 if no valid positions) |
| `mentions` | number | Total mention count for the week |
| `citations` | number | Total citation count for the week |
| `volume` | string | `"High"`, `"Medium"`, `"Low"`, or `"N/A"` |
| `sentiment` | number | Average sentiment score for the week (-1 if no data) |

### `executions[]` Array

All execution rows for this prompt+region within the date range. Sorted newest-first by `execution_date`. Not deduplicated — includes every execution for weekly history tracking. Same structure as the [Topic Detail API](topic-detail-api.md#executions-array).

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The prompt text |
| `region` | string | Region code |
| `executionDate` | string | Execution date (YYYY-MM-DD) |
| `week` | string | ISO week string derived from `executionDate` |
| `answer` | string | The AI answer text |
| `mentions` | boolean | Whether the brand was mentioned |
| `citations` | boolean | Whether the brand was cited |
| `visibilityScore` | number | Visibility score (0–100) |
| `position` | string | Ranking position or empty string |
| `sentiment` | string | `"Positive"`, `"Neutral"`, `"Negative"`, or empty |
| `volume` | string | Raw volume value as string |
| `origin` | string | Origin of the prompt |
| `category` | string | Category name |
| `sources` | string | URL from the execution |
| `errorCode` | string | Error code if the execution failed, empty otherwise |

### `sources[]` Array

Aggregated citation sources for this prompt. Deduplicated by URL. Same structure as the [Topic Detail API](topic-detail-api.md#sources-array).

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Full source URL |
| `hostname` | string | Extracted hostname from the URL |
| `contentType` | string | Content type: `"owned"`, `"competitor"`, `"social"`, `"earned"` |
| `citationCount` | number | Total number of times this URL was cited |
| `weeks` | string[] | ISO week strings when this URL appeared, sorted chronologically |
| `prompts` | object[] | Per-prompt citation breakdown: `{ prompt: string, count: number }` |

---

## Aggregation Logic

1. Query all `brand_presence_executions` rows matching the topic, prompt text, and (optionally) region code
2. Compute prompt-level stats inline:
   - Average `visibility_score` (excluding null/NaN)
   - Average `position` (excluding "Not Mentioned" and non-numeric)
   - Average `sentiment` (positive=100, neutral=50, negative=0)
   - Count `mentions` and `citations` (boolean fields)
3. Compute weekly stats via `aggregateWeeklyDetailStats` (same as topic detail)
4. Build execution entries from all rows (not deduplicated) sorted newest-first
5. Fetch sources via `brand_presence_sources` joined with `source_urls` for all execution IDs
6. Aggregate sources via `aggregateDetailSources`

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Organization not found |
| 400 | Invalid topic ID encoding (malformed percent-encoding in `:topicId`) |
| 400 | Missing required query parameter: `prompt` |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization |

---

## Related APIs

- [Topic Detail API](topic-detail-api.md) — Same detail view at the topic level (aggregates all prompts)
- [Topics & Topic Prompts API](topics-api.md) — Topic summaries and prompt-level data for the Data Insights table
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
