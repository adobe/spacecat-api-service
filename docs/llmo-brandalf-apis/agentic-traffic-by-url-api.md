# Agentic Traffic by URL API

URL-level and user-agent breakdown endpoints for agentic traffic data. These three endpoints expose per-URL performance, user-agent composition, and URL hit-count movers for a site.

Data is queried from mysticat-data-service PostgreSQL via PostgREST RPC functions. All endpoints require LLMO organization access.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/agentic-traffic/by-url` | Per-URL traffic breakdown with performance metrics |
| GET | `/sites/:siteId/agentic-traffic/by-user-agent` | Traffic grouped by page type × agent type |
| GET | `/sites/:siteId/agentic-traffic/movers` | Top and bottom URL movers by hit-count change |

**Path parameters:**
- `siteId` — Site UUID

---

## Common Query Parameters

All three endpoints share the standard agentic traffic filters. See [Agentic Traffic API](./agentic-traffic-api.md#common-query-parameters) for the full parameter list and the platform code mapping.

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `platform` | — | string | — | AI platform UI code (mapped to DB value — see [platform mapping](./agentic-traffic-api.md#platform-code-mapping)) |
| `categoryName` | `category_name` | string | — | Filter by content category name |
| `agentType` | `agent_type` | string | — | Filter by agent type |
| `userAgent` | `user_agent` | string | — | Filter by user agent string |
| `contentType` | `content_type` | string | — | Filter by content type |

---

## Endpoint Details

### GET `/sites/:siteId/agentic-traffic/by-url`

Returns a **paginated** per-URL breakdown with traffic volume, performance, and citability metrics. Supports server-side substring search via `urlPathSearch`.

**Additional parameters:**

| Parameter | Aliases | Type | Default | Max | Description |
|-----------|---------|------|---------|-----|-------------|
| `pageSize` | — | integer | 50 | 500 | Rows per page |
| `pageOffset` | `page_offset` | integer | 0 | — | Zero-based row offset |
| `urlPathSearch` | `url_path_search` | string | — | — | Substring filter on `url_path` (server-side) |
| `sortBy` | `sort_by` | string | `total_hits` | — | Column to sort by |
| `sortOrder` | `sort_order` | string | `desc` | — | `asc` or `desc` |

**RPC:** `rpc_agentic_traffic_by_url`

**Response:**

```json
{
  "totalCount": 1240,
  "rows": [
    {
      "host": "www.example.com",
      "urlPath": "/blog/ai-tools",
      "totalHits": 4200,
      "uniqueAgents": 8,
      "uniqueAgentNames": ["GPTBot", "ChatGPT-User", "ClaudeBot"],
      "topAgent": "GPTBot",
      "topAgentType": "crawler",
      "responseCodes": [200, 301],
      "successRate": 0.97,
      "avgTtfbMs": 280.5,
      "categoryName": "Blog",
      "avgCitabilityScore": 0.82,
      "deployedAtEdge": true
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalCount` | number | Total URLs matching the filters (across all pages) |
| `rows` | array | URLs for the requested page |
| `rows[].host` | string | Hostname (e.g. `www.example.com`) |
| `rows[].urlPath` | string | URL path (e.g. `/blog/ai-tools`) |
| `rows[].totalHits` | number | Total AI-crawler requests to this URL |
| `rows[].uniqueAgents` | number | Number of distinct user-agent strings (true count from DB; may exceed `uniqueAgentNames.length` when the RPC caps names) |
| `rows[].uniqueAgentNames` | string[] | Agent name strings for tooltip display (capped at 20 by the RPC) |
| `rows[].topAgent` | string | Most frequent user-agent string |
| `rows[].topAgentType` | string | Agent type of `topAgent` |
| `rows[].responseCodes` | number[] | Distinct HTTP status codes seen for this URL |
| `rows[].successRate` | number \| null | Fraction of 2xx responses (0–1) |
| `rows[].avgTtfbMs` | number \| null | Average time-to-first-byte in milliseconds |
| `rows[].categoryName` | string | Content category |
| `rows[].avgCitabilityScore` | number \| null | Average citability score (0–1) |
| `rows[].deployedAtEdge` | boolean | Whether the URL is deployed at the edge |

**Pagination pattern:** use `pageOffset = page × pageSize` for cursor-free offset pagination. Use `totalCount` to determine whether more pages exist (`loadedCount < totalCount`).

---

### GET `/sites/:siteId/agentic-traffic/by-user-agent`

Returns traffic grouped by `(pageType, agentType)`. Useful for understanding which agent types target which page types.

> **Note:** `userAgent` / `user_agent` is not forwarded to this RPC — it groups by agent and filtering by a single user agent is not supported here.

**Additional parameters:**

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `sortBy` | `sort_by` | string | `total_hits` | Column to sort by |
| `sortOrder` | `sort_order` | string | `desc` | `asc` or `desc` |

**RPC:** `rpc_agentic_traffic_by_user_agent`

**Response:**

```json
[
  {
    "pageType": "article",
    "agentType": "crawler",
    "uniqueAgents": 5,
    "uniqueAgentNames": ["GPTBot", "ChatGPT-User", "ClaudeBot"],
    "totalHits": 18400
  },
  {
    "pageType": "product",
    "agentType": "assistant",
    "uniqueAgents": 2,
    "uniqueAgentNames": ["Claude-User"],
    "totalHits": 6100
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `pageType` | string | Page type (e.g. `article`, `product`) |
| `agentType` | string | Agent type (e.g. `crawler`, `assistant`) |
| `uniqueAgents` | number | Number of distinct user-agent strings in this group (true count from DB; may exceed `uniqueAgentNames.length` when the RPC caps names) |
| `uniqueAgentNames` | string[] | Agent name strings for tooltip display (capped at 20 by the RPC) |
| `totalHits` | number | Total hits for this `(pageType, agentType)` combination |

---

### GET `/sites/:siteId/agentic-traffic/movers`

Returns the URLs with the largest absolute change in hit count between the oldest and newest date in the range. A single call returns both top movers (increased hits) and bottom movers (decreased hits) in one array, distinguished by `direction`.

**Additional parameter:**

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `limit` | integer | 5 | 1–50 | Number of movers per direction |

**RPC:** `rpc_agentic_traffic_movers`

**Response:**

```json
[
  {
    "host": "www.example.com",
    "urlPath": "/docs/getting-started",
    "previousHits": 1200,
    "currentHits": 3800,
    "hitsChange": 2600,
    "changePercent": 2.17,
    "direction": "up"
  },
  {
    "host": "www.example.com",
    "urlPath": "/legacy/old-page",
    "previousHits": 900,
    "currentHits": 120,
    "hitsChange": -780,
    "changePercent": -0.87,
    "direction": "down"
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `host` | string | Hostname |
| `urlPath` | string | URL path |
| `previousHits` | number | Hit count at the oldest date in the range |
| `currentHits` | number | Hit count at the newest date in the range |
| `hitsChange` | number | `currentHits − previousHits` |
| `changePercent` | number \| null | Fractional change (`hitsChange / previousHits`). `null` if `previousHits` is 0. |
| `direction` | string | `"up"` (top mover) or `"down"` (bottom mover) |

The response contains up to `2 × limit` items — `limit` entries with `direction: "up"` followed by `limit` entries with `direction: "down"`.

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ `postgres`) |
| 400 | Site or organization not found |
| 400 | PostgREST/PostgreSQL RPC error |
| 403 | User does not belong to the site's organization |

---

## Authentication & Access

- Requires LLMO product access for the site's organization (`hasLlmoOrganizationAccess`)
- Routes are listed in `REQUIRED_CAPABILITIES`

---

## Related APIs

- [Agentic Traffic API](./agentic-traffic-api.md) — KPIs, trend, and grouping by region/category/page-type/status
- [Agentic Traffic Filter Dimensions API](./agentic-traffic-filter-dimensions-api.md) — Available filter values for the UI
- [Agentic Traffic URL Brand Presence API](./agentic-traffic-url-brand-presence-api.md) — Brand presence citation detail for a specific URL
