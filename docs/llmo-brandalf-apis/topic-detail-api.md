# Brand Presence Topic Detail API

Returns all execution rows, weekly aggregated statistics, and citation sources for a specific topic — powering the **detail dialog** that opens when a user clicks "Details" on a topic row in the Data Insights table.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/topics/:topicId/detail` | Topic detail for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/detail` | Topic detail for a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID
- `topicId` — URL-encoded topic name (e.g. `PDF%20Editing`)

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. chatgpt, google-ai-mode, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, WW) |
| `origin` | — | string | — | Filter by origin (case-insensitive; e.g. `human`, `ai`) |

---

## Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/topics/PDF%20Editing/detail?startDate=2026-02-09&endDate=2026-03-09&model=chatgpt&siteId=c2473d89-e997-458d-a86d-b4096649c12b
```

---

## Response Shape

```json
{
  "topic": "PDF Editing",
  "topicId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "stats": {
    "averageVisibilityScore": 72.5,
    "averagePosition": 3.2,
    "averageSentiment": 75,
    "popularityVolume": "High",
    "brandMentions": 312,
    "brandCitations": 198,
    "promptCount": 47,
    "sourceCount": 85
  },
  "weeklyStats": [
    {
      "week": "2026-W10",
      "visibilityScore": 70,
      "position": 3.5,
      "mentions": 78,
      "citations": 50,
      "volume": "High",
      "sentiment": 72
    },
    {
      "week": "2026-W11",
      "visibilityScore": 74,
      "position": 3.1,
      "mentions": 82,
      "citations": 55,
      "volume": "High",
      "sentiment": 78
    }
  ],
  "executions": [
    {
      "prompt": "best pdf editor for mac",
      "promptId": "019cb903-1184-7f92-8325-f9d1176af316",
      "topicId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "executionId": "019cb903-1184-7f92-8325-f9d1176af317",
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
      "citationCount": 12,
      "weeks": ["2026-W10", "2026-W11"],
      "prompts": [
        { "prompt": "best pdf editor for mac", "count": 5 },
        { "prompt": "compare pdf editing tools", "count": 7 }
      ]
    }
  ]
}
```

**Stable ids caveat:** Root **`topicId`** is `null` when the path is a topic **name** (not a UUID) and execution rows have no `topic_id` in Postgres. Each **`executions[]`** entry always includes **`topicId`** and **`promptId`** as strings; they are `""` when the corresponding column is null (legacy rows).

---

## Response Field Reference

### Top-level fields

| Field | Type | Description |
|-------|------|-------------|
| `topic` | string | Display label: newest row with non-empty `topics`, else older rows, else decoded path |
| `topicId` | string \| null | Stable topic UUID: newest row with `topic_id`, else older rows, else path UUID or null (see caveat) |

### `stats` Object

| Field | Type | Description |
|-------|------|-------------|
| `averageVisibilityScore` | number | Mean visibility score across all execution rows (0–100, rounded to 2 decimals) |
| `averagePosition` | number | Mean position across all execution rows (rounded to 2 decimals; excludes "Not Mentioned") |
| `averageSentiment` | number | Mean sentiment score: positive=100, neutral=50, negative=0 (rounded to integer; -1 if no data) |
| `popularityVolume` | string | `"High"`, `"Medium"`, `"Low"`, or `"N/A"` — derived from volume column |
| `brandMentions` | number | Total mention count across all execution rows in the date range |
| `brandCitations` | number | Total citation count across all execution rows in the date range |
| `promptCount` | number | Number of unique prompts (deduplicated by `prompt\|region_code`) |
| `sourceCount` | number | Count of unique source URLs from `brand_presence_sources` |

### `weeklyStats[]` Array

Pre-aggregated weekly statistics for the detail dialog mini-charts. Sorted chronologically (oldest first).

| Field | Type | Description |
|-------|------|-------------|
| `week` | string | ISO week string (e.g. `"2026-W10"`) — derived from `execution_date` via ISO week calculation |
| `visibilityScore` | number | Average visibility score for the week (rounded to integer) |
| `position` | number | Average position for the week (rounded to 2 decimals; 0 if no valid positions) |
| `mentions` | number | Total mention count for the week |
| `citations` | number | Total citation count for the week |
| `volume` | string | `"High"`, `"Medium"`, `"Low"`, or `"N/A"` — derived from average volume for the week |
| `sentiment` | number | Average sentiment score for the week (positive=100, neutral=50, negative=0; -1 if no data) |

### `executions[]` Array

All execution rows for the topic within the date range. Sorted newest-first by `execution_date`. Not deduplicated — includes every execution for weekly history tracking.

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The prompt text |
| `promptId` | string | Prompt UUID; `""` when null |
| `topicId` | string | Topic UUID for this execution row; `""` when null |
| `executionId` | string | Execution row UUID; `""` when null |
| `region` | string | Region code (e.g. US, DE) |
| `executionDate` | string | Execution date (YYYY-MM-DD) |
| `week` | string | ISO week string derived from `executionDate` |
| `answer` | string | The AI answer text |
| `mentions` | boolean | Whether the brand was mentioned |
| `citations` | boolean | Whether the brand was cited |
| `visibilityScore` | number | Visibility score (0–100) |
| `position` | string | Ranking position or empty string |
| `sentiment` | string | `"Positive"`, `"Neutral"`, `"Negative"`, or empty |
| `volume` | string | Raw volume value as string |
| `origin` | string | Origin of the prompt (e.g. `"human"`, `"ai"`) |
| `category` | string | Category name |
| `sources` | string | URL from the execution |
| `errorCode` | string | Error code if the execution failed, empty otherwise |

### `sources[]` Array

Aggregated citation sources across all executions in the topic. Deduplicated by URL.

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

1. Query all `brand_presence_executions` rows matching the topic and filters (using the `DETAIL_SELECT` columns which include `answer`)
2. Compute overall topic stats via `aggregateTopicData` (same logic as the `/topics` endpoint)
3. Compute weekly stats via `aggregateWeeklyDetailStats`:
   - Group rows by ISO week (derived from `execution_date`)
   - Per week: average visibility, average position, sum mentions/citations, average volume → category, average sentiment
4. Build execution entries from all rows (not deduplicated) sorted newest-first
5. Fetch sources via `brand_presence_sources` joined with `source_urls` for all execution IDs
6. Aggregate sources via `aggregateDetailSources`: group by URL, count citations, collect weeks and per-prompt counts

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Organization not found |
| 400 | Invalid topic ID encoding (malformed percent-encoding in `:topicId`) |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization |

---

## Related APIs

- [Topics & Topic Prompts API](topics-api.md) — Topic summaries and prompt-level data for the Data Insights table
- [Prompt Detail API](prompt-detail-api.md) — Same detail view for a single prompt+region
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
