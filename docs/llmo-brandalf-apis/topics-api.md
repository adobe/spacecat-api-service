# Brand Presence Topics & Topic Prompts API

Two endpoints that power the **Data Insights table** in the Brand Presence dashboard. Topics returns aggregated summaries; Topic Prompts returns prompt-level detail for a single topic (lazy-loaded on row expansion).

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/topics` | Topic summaries for all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/topics` | Topic summaries for a specific brand |
| GET | `/org/:spaceCatId/brands/all/brand-presence/topics/:topicId/prompts` | Prompts for a single topic (all brands) |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/topics/:topicId/prompts` | Prompts for a single topic (specific brand) |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID
- `topicId` (topic prompts routes only) — URL-encoded **display topic name** (e.g. `Merge%20PDF`) or a **topic UUID** from `topics` / execution `topic_id`; same resolution as [Prompt Detail API](prompt-detail-api.md)

---

## Query Parameters

Both endpoints share the same filter and pagination parameters:

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. chatgpt, google-ai-mode, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID or name) | — | Filter by category UUID or name |
| `categoryIds` | `category_ids` | string or array | — | Multiple categories (comma-separated or repeated); merged with `categoryId` |
| `topicIds` | — | string (UUID CSV or array) | — | Filter by topic UUID(s) |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, JP) |
| `regionCodes` | `region_codes` | string or array | — | Multiple regions; merged with `regionCode` |
| `origin` | — | string | — | Filter by origin (case-insensitive; e.g. `human`, `ai`) |
| `page` | — | integer | `0` | Zero-based page index |
| `pageSize` | — | integer | `20` | Number of items per page |
| `sortBy` | — | string | `name` | Sort field (topics only): `name`, `visibility`, `mentions`, `citations`, `sentiment`, `popularity`, `position` |
| `sortOrder` | — | string | `asc` | Sort direction: `asc` or `desc` |

---

## 1. Topics Endpoint

### Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/topics?startDate=2026-02-09&endDate=2026-03-09&model=chatgpt&page=0&pageSize=20&sortBy=mentions&sortOrder=desc
```

### Response Shape

```json
{
  "topicDetails": [
    {
      "topic": "PDF Editing",
      "topicId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "promptCount": 47,
      "brandMentions": 312,
      "brandCitations": 198,
      "sourceCount": 85,
      "popularityVolume": "High",
      "averageVisibilityScore": 72.5,
      "averagePosition": 3.2,
      "averageSentiment": 75
    }
  ],
  "totalCount": 142
}
```

`topicId` is the stable **topics table UUID** for that row’s topic group when `rpc_brand_presence_topics` returns `topic_id` (from executions in the window). It is JSON `null` when every matching execution has a null `topic_id`.

### Topic Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic/keyword name |
| `topicId` | string \| null | Stable topic UUID (`topics.id` / execution `topic_id`) for use in `…/topics/:topicId/prompts`, `…/detail`, and `…/prompt-detail` when non-null; otherwise fall back to URL-encoded `topic` |
| `promptCount` | number | Number of unique prompts (deduplicated by `prompt\|region_code`, keeping latest execution) |
| `brandMentions` | number | Total mention count across **all** execution rows in the date range |
| `brandCitations` | number | Total citation count across **all** execution rows in the date range |
| `sourceCount` | number | Count of unique source URLs (from `brand_presence_sources`) across all executions |
| `popularityVolume` | string | `"High"`, `"Medium"`, `"Low"`, or `"N/A"` — derived from volume column |
| `averageVisibilityScore` | number | Mean visibility score across all execution rows (0–100, rounded to 2 decimals) |
| `averagePosition` | number | Mean position across all execution rows (rounded to 2 decimals; excludes "Not Mentioned") |
| `averageSentiment` | number | Mean sentiment score: positive=100, neutral=50, negative=0 (rounded to integer; -1 if no data) |

### Aggregation Logic

Topic summaries are produced in PostgreSQL via **`rpc_brand_presence_topics`** (PostgREST `rpc`): filters, `GROUP BY` topic label, metrics, `topic_id` per group, sort, and pagination are applied server-side. The API maps each RPC row to the camelCase response above (including `topicId` from `topic_id`).

---

## 2. Topic Prompts Endpoint

Topic prompts queries `brand_presence_executions` with the same **category** and **region** execution filters as sentiment overview, search, and drill-down routes (when those query params are present). Previously only `regionCode` was applied here; category filters now narrow prompts consistently with the rest of the dashboard.

### Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/topics/PDF%20Editing/prompts?startDate=2026-02-09&endDate=2026-03-09&model=chatgpt&page=0&pageSize=20
```

### Response Shape

```json
{
  "topic": "PDF Editing",
  "topicId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "items": [
    {
      "topic": "PDF Editing",
      "topicId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "prompt": "best pdf editor for mac",
      "promptId": "019cb903-1184-7f92-8325-f9d1176af316",
      "region": "US",
      "category": "Acrobat",
      "executionDate": "2026-03-08",
      "answer": "",
      "sources": "",
      "relatedURL": "https://example.com/pdf-editor",
      "citationsCount": 1,
      "mentionsCount": 1,
      "isAnswered": true,
      "visibilityScore": 85,
      "position": "2",
      "sentiment": "Positive",
      "errorCode": "",
      "origin": "human"
    }
  ],
  "totalCount": 47
}
```

Root **`topic`** and **`topicId`** mirror the [Topic Detail API](topic-detail-api.md) conventions: values are taken from execution rows (preferring the **newest `execution_date`** row that has `topics` / `topic_id`, then scanning older rows), with the same `:topicId` path fallbacks as topic detail. `topicId` is `null` when the path is a topic name and no row carries a `topic_id`.

Each **`items[]`** row includes **`topicId`** and **`promptId`** as strings when the backing execution row has `topic_id` / `prompt_id`; otherwise those fields are the empty string (`""`). Legacy data may omit UUIDs in Postgres — clients should treat empty string like “unknown id” (same as [Topic Detail](topic-detail-api.md) / [Prompt Detail](prompt-detail-api.md) envelopes, where `topicId` can still be `null` at the root when the topic cannot be resolved to a UUID).

### Prompt Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic name |
| `topicId` | string | Topic UUID from the latest execution row for this prompt+region; `""` when null |
| `prompt` | string | The prompt text |
| `promptId` | string | Prompt UUID from the latest execution row; `""` when null |
| `region` | string | Region code (e.g. US, DE) |
| `category` | string | Category name |
| `executionDate` | string | Date of the latest execution (YYYY-MM-DD) |
| `answer` | string | Always empty (excluded from SELECT for payload size) |
| `sources` | string | Always empty (source data is at the topic level) |
| `relatedURL` | string | Related URL from the execution |
| `citationsCount` | number | 1 if cited, 0 otherwise (from latest execution) |
| `mentionsCount` | number | 1 if mentioned, 0 otherwise (from latest execution) |
| `isAnswered` | boolean | `true` if no `error_code` |
| `visibilityScore` | number | Visibility score (0–100) |
| `position` | string | Ranking position or empty string |
| `sentiment` | string | `"Positive"`, `"Neutral"`, `"Negative"`, or empty |
| `errorCode` | string | Error code if the execution failed, empty otherwise |
| `origin` | string | Origin of the prompt (e.g. `"human"`, `"ai"`) |

### Optional Search Filtering

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | — | When provided, filters returned prompts to only those whose `prompt` text contains the query (case-insensitive substring match). Used by the UI to show only matching prompts when a topic was found via prompt-level search. |

### Deduplication

Prompts are deduplicated by `prompt|region_code` — when multiple executions exist for the same prompt+region combination, only the row with the latest `execution_date` is kept.

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

- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Returns available filter options
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Returns applicable weeks
- [Brand Presence Sentiment Overview API](sentiment-overview-api.md) — Weekly sentiment distribution for charts
- [Brand Presence Market Tracking Trends API](market-tracking-trends-api.md) — Weekly mentions, citations, and competitors
- [Brand Presence Sentiment Movers API](sentiment-movers-api.md) — Top/bottom sentiment movers

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
