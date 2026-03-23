# Brand Presence Search API

Full-text search across topics and prompts in the Data Insights table. Returns matching topic summaries with a `matchType` field indicating whether the match was on the topic name or a prompt within the topic.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/org/:spaceCatId/brands/all/brand-presence/search` | Search across all brands in the organization |
| GET | `/org/:spaceCatId/brands/:brandId/brand-presence/search` | Search within a specific brand |

**Path parameters:**
- `spaceCatId` — Organization ID (UUID)
- `brandId` — `all` (all brands) or a specific brand UUID

---

## Query Parameters

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `query` | — | string | — | **Required.** Search string matched against `topics` and `prompt` columns (case-insensitive substring match via `ILIKE`) |
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `model` | `platform` | string | `chatgpt` | LLM model (e.g. chatgpt, google-ai-mode, copilot) |
| `siteId` | `site_id` | string (UUID) | — | Filter by site |
| `categoryId` | `category_id` | string (UUID or name) | — | Filter by category UUID or name |
| `topicIds` | — | string (UUID CSV or array) | — | Filter by topic UUID(s) |
| `regionCode` | `region_code`, `region` | string | — | Filter by region code (e.g. US, DE, JP) |
| `origin` | — | string | — | Filter by origin (case-insensitive; e.g. `human`, `ai`) |
| `page` | — | integer | `0` | Zero-based page index |
| `pageSize` | — | integer | `100` | Number of items per page |
| `sortBy` | — | string | `name` | Sort field: `name`, `visibility`, `mentions`, `citations`, `sentiment`, `popularity`, `position` |
| `sortOrder` | — | string | `asc` | Sort direction: `asc` or `desc` |

---

## Sample URL

```
GET /org/44568c3e-efd4-4a7f-8ecd-8caf615f836c/brands/all/brand-presence/search?query=pdf&startDate=2026-02-09&endDate=2026-03-09&model=chatgpt&page=0&pageSize=100
```

---

## Response Shape

```json
{
  "topicDetails": [
    {
      "topic": "PDF Editing",
      "matchType": "topic",
      "promptCount": 47,
      "brandMentions": 312,
      "brandCitations": 198,
      "sourceCount": 85,
      "popularityVolume": "High",
      "averageVisibilityScore": 72.5,
      "averagePosition": 3.2,
      "averageSentiment": 75
    },
    {
      "topic": "Image Tools",
      "matchType": "prompt",
      "promptCount": 12,
      "brandMentions": 45,
      "brandCitations": 30,
      "sourceCount": 20,
      "popularityVolume": "Medium",
      "averageVisibilityScore": 60.0,
      "averagePosition": 4.1,
      "averageSentiment": 50
    }
  ],
  "totalCount": 2
}
```

### Topic Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `topic` | string | Topic/keyword name |
| `matchType` | string | `"topic"` if the topic name matched the query; `"prompt"` if only prompts within the topic matched |
| `promptCount` | number | Number of unique prompts (deduplicated by `prompt\|region_code`) |
| `brandMentions` | number | Total mention count across all execution rows |
| `brandCitations` | number | Total citation count across all execution rows |
| `sourceCount` | number | Count of unique source URLs across all executions |
| `popularityVolume` | string | `"High"`, `"Medium"`, `"Low"`, or `"N/A"` |
| `averageVisibilityScore` | number | Mean visibility score (0–100, rounded to 2 decimals) |
| `averagePosition` | number | Mean position (rounded to 2 decimals) |
| `averageSentiment` | number | Mean sentiment score: positive=100, neutral=50, negative=0 (-1 if no data) |

---

## Search Logic

1. **PostgREST query**: Uses `.or('topics.ilike.%query%,prompt.ilike.%query%')` for case-insensitive substring matching on both topic name and prompt text
2. **Aggregation**: Reuses the same `aggregateTopicData()` function as the topics endpoint (counts mentions/citations/sources from all execution rows, deduplicates prompts for `promptCount`)
3. **matchType tagging**: After aggregation, each topic is tagged:
   - `"topic"` — topic name contains the query string (case-insensitive)
   - `"prompt"` — topic name does NOT match, but at least one prompt within it does
4. **Sort and paginate** server-side (default `pageSize=100`)

---

## Empty Query Behavior

When `query` is empty or missing, the endpoint returns `{ topicDetails: [], totalCount: 0 }` immediately without querying the database.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (DATA_SERVICE_PROVIDER ≠ postgres) |
| 400 | Organization not found |
| 400 | PostgREST/PostgreSQL query error |
| 403 | User does not belong to the organization |
| 403 | Site does not belong to the organization |

---

## Related APIs

- [Topics API](topics-api.md) — Paginated topic summaries (used when not searching)
- [Brand Presence Filter Dimensions API](filter-dimensions-api.md) — Available filter options
- [Brand Presence Weeks API](brand-presence-weeks-api.md) — Applicable weeks

---

## Authentication

Requires valid authentication (JWT, IMS, or API key) with access to the organization.
