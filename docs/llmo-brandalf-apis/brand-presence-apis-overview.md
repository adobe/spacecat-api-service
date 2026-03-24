# Brand Presence APIs — consolidated reference

Single entry point for all org-scoped Brand Presence HTTP APIs backed by mysticat-data-service (PostgREST). Each route exists in two variants: `brands/all` (organization-wide) and `brands/:brandId` (single brand UUID).

**Path pattern:** `GET /org/:spaceCatId/brands/{all|:brandId}/brand-presence/...`

- `:spaceCatId` — organization UUID (same as SpaceCat org id).
- `all` — aggregate across brands; `:brandId` — filter to one brand.

Parameters are typically supplied as **query string** fields (merged into request `data` by the API gateway). Aliases such as `start_date` / `startDate` are noted per endpoint.

Deep-dive docs: [filter-dimensions](filter-dimensions-api.md), [weeks](brand-presence-weeks-api.md), [sentiment-overview](sentiment-overview-api.md), [market-tracking-trends](market-tracking-trends-api.md), [topics & prompts](topics-api.md), [search](search-api.md), [topic detail](topic-detail-api.md), [prompt detail](prompt-detail-api.md), [sentiment-movers](sentiment-movers-api.md), [share-of-voice](share-of-voice-api.md), [stats](brand-presence-stats-api.md), [execution-dates](execution-dates-api.md), [brand-vs-competitors](brand-vs-competitors-api.md).

---

## Master table

Each **Query parameters** cell lists one parameter per line as `name : sample (optional)` or `(required)`. Lists use HTML (`<ul><li>`) so they render on separate lines in GitHub, many IDEs, and doc tools; if your viewer strips HTML, use the **Detail doc** link for the same parameters in Markdown.

| # | Method | API path | Purpose | Query parameters | Example response | Detail doc |
|---|--------|----------|---------|------------------|------------------|------------|
| 1 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/filter-dimensions` | Returns distinct filter values for dropdowns: brands, categories, topics, origins, regions, page_intents. | <ul><li><code>startDate</code> : <code>2025-09-27</code> (optional)</li><li><code>endDate</code> : <code>2025-09-30</code> (optional)</li><li><code>model</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : <code>c2473d89-e997-458d-a86d-b4096649c12b</code> (optional)</li><li><code>categoryId</code> : <code>Acrobat</code> or category UUID (optional)</li><li><code>topicIds</code> : <code>0178a3f0-1234-7000-8000-0000000000aa,0178a3f0-1234-7000-8000-0000000000bb</code> (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>ai</code> (optional)</li></ul> | [§1](#1-filter-dimensions) | [filter-dimensions-api.md](filter-dimensions-api.md) |
| 2 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/weeks` | Returns ISO weeks (`YYYY-Wnn`) with calendar start/end for week pickers from `brand_metrics_weekly`. | <ul><li><code>model</code> : <code>gemini</code> (optional)</li><li><code>siteId</code> : <code>c2473d89-e997-458d-a86d-b4096649c12b</code> (optional)</li></ul> | [§2](#2-weeks) | [brand-presence-weeks-api.md](brand-presence-weeks-api.md) |
| 3 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/sentiment-overview` | Weekly positive/neutral/negative **percentages** and prompt counts (deduped per week) for sentiment charts. | <ul><li><code>startDate</code> : <code>2025-09-01</code> (optional)</li><li><code>endDate</code> : <code>2025-09-30</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : <code>c2473d89-e997-458d-a86d-b4096649c12b</code> (optional)</li><li><code>categoryId</code> : <code>Acrobat</code> or UUID (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>human</code> (optional)</li></ul> | [§3](#3-sentiment-overview) | [sentiment-overview-api.md](sentiment-overview-api.md) |
| 4 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/market-tracking-trends` | Weekly brand mentions/citations (deduped) plus competitor mention/citation totals per week. | <ul><li><code>startDate</code> : <code>2025-09-01</code> (optional)</li><li><code>endDate</code> : <code>2025-09-30</code> (optional)</li><li><code>model</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : <code>c2473d89-e997-458d-a86d-b4096649c12b</code> (optional)</li><li><code>categoryId</code> : <code>0178a3f0-1234-7000-8000-000000000099</code> (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li></ul> <em>Not supported:</em> <code>topicIds</code>, <code>origin</code>. | [§4](#4-market-tracking-trends) | [market-tracking-trends-api.md](market-tracking-trends-api.md) |
| 5 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/topics` | Paginated **topic summaries** for the Data Insights table (aggregates per topic). | <ul><li><code>startDate</code> : <code>2026-02-09</code> (optional)</li><li><code>endDate</code> : <code>2026-03-09</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>categoryId</code> : UUID or name (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>DE</code> (optional)</li><li><code>origin</code> : <code>ai</code> (optional)</li><li><code>page</code> : <code>0</code> (optional)</li><li><code>pageSize</code> : <code>20</code> (optional)</li><li><code>sortBy</code> : <code>mentions</code> (optional; <code>name</code>, <code>visibility</code>, <code>citations</code>, <code>sentiment</code>, <code>popularity</code>, <code>position</code>)</li><li><code>sortOrder</code> : <code>desc</code> (optional; <code>asc</code>)</li></ul> | [§5](#5-topics) | [topics-api.md — Topics](topics-api.md#1-topics-endpoint) |
| 6 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/topics/:topicId/prompts` | Prompt-level rows for one topic (`:topicId` = URL-encoded topic name). Same filters/pagination as topics. | <ul><li><code>:topicId</code> (path) : <code>PDF%20Editing</code> (required)</li><li><code>startDate</code> : <code>2026-02-09</code> (optional)</li><li><code>endDate</code> : <code>2026-03-09</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>categoryId</code> : UUID or name (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>ai</code> (optional)</li><li><code>page</code> : <code>0</code> (optional)</li><li><code>pageSize</code> : <code>20</code> (optional)</li><li><code>query</code> : <code>merge</code> (optional; prompt text substring)</li></ul> | [§6](#6-topic-prompts) | [topics-api.md — Topic prompts](topics-api.md#2-topic-prompts-endpoint) |
| 7 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/search` | Search topics/prompts; returns topic summaries with `matchType` (`topic` vs `prompt`). | <ul><li><code>query</code> : <code>pdf</code> (required; 2–500 chars)</li><li><code>startDate</code> : <code>2026-02-09</code> (optional)</li><li><code>endDate</code> : <code>2026-03-09</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>categoryId</code> : UUID or name (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>JP</code> (optional)</li><li><code>origin</code> : <code>human</code> (optional)</li><li><code>page</code> : <code>0</code> (optional)</li><li><code>pageSize</code> : <code>20</code> (optional)</li><li><code>sortBy</code> : <code>mentions</code> (optional)</li><li><code>sortOrder</code> : <code>desc</code> (optional)</li></ul> | [§7](#7-search) | [search-api.md](search-api.md) |
| 8 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/topics/:topicId/detail` | Full **topic** drill-down: stats, weekly mini-stats, all executions, citation sources. | <ul><li><code>:topicId</code> (path) : <code>PDF%20Editing</code> (required)</li><li><code>startDate</code> : <code>2026-02-09</code> (optional)</li><li><code>endDate</code> : <code>2026-03-09</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>human</code> (optional)</li></ul> <em>Note:</em> detail query does not apply <code>categoryId</code> / <code>topicIds</code>. | [§8](#8-topic-detail) | [topic-detail-api.md](topic-detail-api.md) |
| 9 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/topics/:topicId/prompt-detail` | Drill-down for one **prompt** (+ optional region) inside a topic. | <ul><li><code>:topicId</code> (path) : <code>PDF%20Editing</code> (required)</li><li><code>prompt</code> : <code>best pdf editor for mac</code> (required)</li><li><code>promptRegion</code> / <code>prompt_region</code> : <code>US</code> (optional)</li><li><code>startDate</code> : <code>2026-02-09</code> (optional)</li><li><code>endDate</code> : <code>2026-03-09</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>chatgpt</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>origin</code> : <code>human</code> (optional)</li></ul> | [§9](#9-prompt-detail) | [prompt-detail-api.md](prompt-detail-api.md) |
| 10 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/sentiment-movers` | Top/bottom prompts by sentiment change (RPC `rpc_sentiment_movers`). | <ul><li><code>type</code> : <code>top</code> or <code>bottom</code> (optional)</li><li><code>startDate</code> : <code>2026-02-09</code> (optional)</li><li><code>endDate</code> : <code>2026-03-09</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>google-ai-mode</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>categoryId</code> : category UUID (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>human</code> (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li></ul> | [§10](#10-sentiment-movers) | [sentiment-movers-api.md](sentiment-movers-api.md) |
| 11 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/share-of-voice` | Per-topic share of voice, competitors, rankings (`rpc_share_of_voice`). | <ul><li><code>startDate</code> : <code>2025-09-27</code> (optional)</li><li><code>endDate</code> : <code>2025-09-30</code> (optional)</li><li><code>model</code> : <code>gemini</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>categoryId</code> : <code>0178a3f0-1234-7000-8000-000000000099</code> (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>ai</code> (optional)</li><li><code>maxCompetitors</code> / <code>max_competitors</code> : <code>5</code> (optional)</li></ul> | [§11](#11-share-of-voice) | [share-of-voice-api.md](share-of-voice-api.md) |
| 12 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/stats` | Org/brand execution totals and averages via `rpc_brand_presence_stats`; optional weekly slices. | <ul><li><code>startDate</code> : <code>2025-01-01</code> (optional)</li><li><code>endDate</code> : <code>2025-01-31</code> (optional)</li><li><code>model</code> / <code>platform</code> : <code>gemini</code> (optional)</li><li><code>showTrends</code> / <code>show_trends</code> : <code>true</code> (optional)</li><li><code>siteId</code> : site UUID (optional)</li><li><code>categoryId</code> : category UUID (optional)</li><li><code>topicIds</code> : comma-separated UUIDs (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li><li><code>origin</code> : <code>ai</code> (optional)</li></ul> | [§12](#12-stats) | [brand-presence-stats-api.md](brand-presence-stats-api.md) |
| 13 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/execution-dates` | Distinct execution dates for a site's brand presence data, sorted newest first. First step in the two-step brand-vs-competitors query pattern. | <ul><li><code>siteId</code> : <code>c2473d89-e997-458d-a86d-b4096649c12b</code> (required)</li><li><code>model</code> : <code>chatgpt</code> (optional)</li></ul> | [§13](#13-execution-dates) | [execution-dates-api.md](execution-dates-api.md) |
| 14 | GET | `/org/:spaceCatId/brands/{all\|:brandId}/brand-presence/brand-vs-competitors` | Aggregated competitor mention/citation data from `brand_vs_competitors_by_date` view, filtered by specific execution dates. Second step in the two-step query pattern. | <ul><li><code>executionDates</code> : <code>2026-03-01,2026-03-08</code> (required)</li><li><code>siteId</code> : <code>c2473d89-e997-458d-a86d-b4096649c12b</code> (optional)</li><li><code>model</code> : <code>chatgpt</code> (optional)</li><li><code>categoryName</code> : <code>SEO</code> (optional)</li><li><code>regionCode</code> / <code>region</code> : <code>US</code> (optional)</li></ul> | [§14](#14-brand-vs-competitors) | [brand-vs-competitors-api.md](brand-vs-competitors-api.md) |

---

## Example responses (backend shape)

Illustrative JSON; real data varies by org and filters.

### 1. Filter dimensions

```json
{
  "brands": [{ "id": "019cb903-1184-7f92-8325-f9d1176af316", "label": "Acrobat" }],
  "categories": [{ "id": "Acrobat", "label": "Acrobat" }],
  "topics": [{ "id": "0178a3f0-1234-7000-8000-0000000000aa", "label": "combine pdf" }],
  "origins": [{ "id": "ai", "label": "ai" }],
  "regions": [{ "id": "US", "label": "US" }],
  "page_intents": [{ "id": "TRANSACTIONAL", "label": "TRANSACTIONAL" }]
}
```

### 2. Weeks

```json
{
  "weeks": [
    { "week": "2026-W11", "startDate": "2026-03-09", "endDate": "2026-03-15" },
    { "week": "2026-W10", "startDate": "2026-03-02", "endDate": "2026-03-08" }
  ]
}
```

### 3. Sentiment overview

```json
{
  "weeklyTrends": [
    {
      "week": "2026-W11",
      "weekNumber": 11,
      "year": 2026,
      "sentiment": [
        { "name": "Positive", "value": 45, "color": "#047857" },
        { "name": "Neutral", "value": 30, "color": "#4B5563" },
        { "name": "Negative", "value": 25, "color": "#B91C1C" }
      ],
      "totalPrompts": 120,
      "promptsWithSentiment": 100,
      "mentions": 0,
      "citations": 0,
      "visibilityScore": 0,
      "competitors": []
    }
  ]
}
```

### 4. Market tracking trends

```json
{
  "weeklyTrends": [
    {
      "week": "2026-W10",
      "weekNumber": 10,
      "year": 2026,
      "mentions": 42,
      "citations": 18,
      "competitors": [
        { "name": "competitor_a", "mentions": 30, "citations": 10 },
        { "name": "competitor_b", "mentions": 12, "citations": 5 }
      ]
    }
  ],
  "weeklyTrendsForComparison": []
}
```

*(Production: `weeklyTrendsForComparison` duplicates `weeklyTrends`.)*

### 5. Topics

```json
{
  "topicDetails": [
    {
      "topic": "PDF Editing",
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

### 6. Topic prompts

```json
{
  "items": [
    {
      "topic": "PDF Editing",
      "prompt": "best pdf editor for mac",
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

### 7. Search

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
    }
  ],
  "totalCount": 1
}
```

### 8. Topic detail

```json
{
  "topic": "PDF Editing",
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
    }
  ],
  "executions": [
    {
      "prompt": "best pdf editor for mac",
      "region": "US",
      "executionDate": "2026-03-08",
      "week": "2026-W10",
      "answer": "Based on current reviews…",
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
      "weeks": ["2026-W10"],
      "prompts": [{ "prompt": "best pdf editor for mac", "count": 2 }]
    }
  ]
}
```

### 9. Prompt detail

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
    }
  ],
  "executions": [],
  "sources": []
}
```

### 10. Sentiment movers

```json
{
  "movers": [
    {
      "promptId": "019cb903-1184-7f92-8325-f9d1176af316",
      "prompt": "best pdf merge tool for mac",
      "topicId": "019cb903-2295-7f92-8325-a8c2045bf427",
      "topic": "Merge PDF",
      "categoryId": "019cb903-3306-7f92-8325-b7d3156cg538",
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

### 11. Share of voice

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
        { "name": "tesla", "mentions": 6, "shareOfVoice": 40.0, "source": "configured" }
      ],
      "allCompetitors": [
        { "name": "tesla", "mentions": 6, "shareOfVoice": 40.0, "source": "configured" },
        { "name": "ford", "mentions": 4, "shareOfVoice": 26.67, "source": "detected" }
      ],
      "brandShareOfVoice": { "name": "Our Brand", "mentions": 5, "shareOfVoice": 33.33 }
    }
  ]
}
```

### 12. Stats

**Without** `showTrends`:

```json
{
  "stats": {
    "total_executions": 1250,
    "average_visibility_score": 4.2,
    "total_mentions": 89,
    "total_citations": 312
  }
}
```

**With** `showTrends=true` (excerpt):

```json
{
  "stats": {
    "total_executions": 1250,
    "average_visibility_score": 4.2,
    "total_mentions": 89,
    "total_citations": 312
  },
  "trends": [
    {
      "startDate": "2025-01-15",
      "endDate": "2025-01-21",
      "data": {
        "stats": {
          "total_executions": 180,
          "average_visibility_score": 4.5,
          "total_mentions": 12,
          "total_citations": 45
        }
      }
    }
  ]
}
```

### 13. Execution dates

```json
{
  "executionDates": [
    "2026-03-15",
    "2026-03-08",
    "2026-03-01",
    "2026-02-22"
  ]
}
```

### 14. Brand vs competitors

```json
{
  "competitorData": [
    {
      "siteId": "c2473d89-e997-458d-a86d-b4096649c12b",
      "brandId": "019cb903-1184-7f92-8325-f9d1176af316",
      "brandName": "Acme Corp",
      "model": "chatgpt",
      "executionDate": "2026-03-01",
      "categoryName": "SEO",
      "regionCode": "US",
      "competitor": "Competitor Inc",
      "totalMentions": 42,
      "totalCitations": 7
    }
  ]
}
```

---

## Authentication and errors

- All endpoints: authenticated user/API key with access to the organization; Brand Presence uses PostgREST (`DATA_SERVICE_PROVIDER=postgres`).
- Common errors: **400** (misconfiguration, bad request, PostgREST error, bad `topicId` encoding); **403** (not in org, or invalid `siteId` for org).

See per-topic docs for RPC parameters, row limits, and edge cases.
