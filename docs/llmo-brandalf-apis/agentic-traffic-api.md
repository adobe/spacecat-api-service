# Agentic Traffic API

Site-scoped endpoints that surface AI-crawler traffic metrics for a single site. Data is queried from the `agentic_traffic` table in mysticat-data-service via PostgREST RPC functions. All endpoints require LLMO organization access.

---

## API Paths

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/agentic-traffic/kpis` | Aggregate KPIs for the date range |
| GET | `/sites/:siteId/agentic-traffic/kpis-trend` | KPIs broken down by time interval |
| GET | `/sites/:siteId/agentic-traffic/by-region` | Total hits grouped by region |
| GET | `/sites/:siteId/agentic-traffic/by-category` | Total hits grouped by content category |
| GET | `/sites/:siteId/agentic-traffic/by-page-type` | Total hits grouped by page type |
| GET | `/sites/:siteId/agentic-traffic/by-status` | Total hits grouped by HTTP status code |

**Path parameters:**
- `siteId` — Site UUID

---

## Common Query Parameters

All endpoints in this file share these query parameters.

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `platform` | — | string | — | AI platform filter. Accepts UI codes — see platform mapping below. |
| `categoryName` | `category_name` | string | — | Filter by content category name |
| `agentType` | `agent_type` | string | — | Filter by agent type |
| `userAgent` | `user_agent` | string | — | Filter by user agent string |
| `contentType` | `content_type` | string | — | Filter by content type |

### Platform Code Mapping

The `platform` parameter accepts UI-friendly codes that are mapped to the values stored in the `agentic_traffic.platform` column before being sent to the database. Unknown codes and `all` resolve to `null` (no filter applied).

| UI Code | DB Value |
|---------|----------|
| `openai` | `ChatGPT` |
| `chatgpt` | `ChatGPT` |
| `anthropic` | `Anthropic` |
| `mistral` | `MistralAI` |
| `perplexity` | `Perplexity` |
| `gemini` | `Gemini` |
| `google` | `Google` |
| `amazon` | `Amazon` |

> **Note:** Before this mapping was added, raw UI codes (e.g. `openai`) were forwarded to the DB verbatim and never matched any rows. Always pass a recognised UI code or omit the parameter entirely.

---

## Endpoint Details

### GET `/sites/:siteId/agentic-traffic/kpis`

Returns aggregate KPIs for the site over the requested date range.

**RPC:** `rpc_agentic_traffic_kpis`

**Response:**

```json
{
  "totalHits": 48230,
  "successRate": 0.94,
  "avgTtfbMs": 312.5,
  "avgCitabilityScore": 0.71
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalHits` | number | Total AI-crawler requests |
| `successRate` | number \| null | Fraction of 2xx responses (0–1). `null` if no data. |
| `avgTtfbMs` | number \| null | Average time-to-first-byte in milliseconds. `null` if no data. |
| `avgCitabilityScore` | number \| null | Average citability score (0–1). `null` if no data. |

---

### GET `/sites/:siteId/agentic-traffic/kpis-trend`

Returns KPIs grouped by time interval. Useful for sparklines and trend charts.

**Additional parameter:**

| Parameter | Type | Default | Valid values |
|-----------|------|---------|-------------|
| `interval` | string | `week` | `day`, `week`, `month` |

**RPC:** `rpc_agentic_traffic_kpis_trend`

**Response:**

```json
[
  {
    "periodStart": "2026-03-02",
    "totalHits": 11200,
    "successRate": 0.95,
    "avgTtfbMs": 298.1,
    "avgCitabilityScore": 0.73
  },
  {
    "periodStart": "2026-02-23",
    "totalHits": 10800,
    "successRate": 0.93,
    "avgTtfbMs": 315.4,
    "avgCitabilityScore": 0.70
  }
]
```

Each item covers one `interval` period starting at `periodStart`.

---

### GET `/sites/:siteId/agentic-traffic/by-region`

Returns total hits grouped by geographic region.

**RPC:** `rpc_agentic_traffic_by_region`

**Response:**

```json
[
  { "region": "US", "totalHits": 24100 },
  { "region": "DE", "totalHits": 8400 }
]
```

---

### GET `/sites/:siteId/agentic-traffic/by-category`

Returns total hits grouped by content category.

> **Note:** `categoryName` / `category_name` is not forwarded to this RPC — the function groups by category and filtering by a single category is not supported here. Use `by-url` with a `categoryName` filter for per-category URL breakdowns.

**RPC:** `rpc_agentic_traffic_by_category`

**Response:**

```json
[
  { "categoryName": "Blog", "totalHits": 18900 },
  { "categoryName": "Uncategorized", "totalHits": 5200 }
]
```

---

### GET `/sites/:siteId/agentic-traffic/by-page-type`

Returns total hits grouped by page type.

**RPC:** `rpc_agentic_traffic_by_page_type`

**Response:**

```json
[
  { "pageType": "article", "totalHits": 21300 },
  { "pageType": "Other", "totalHits": 4100 }
]
```

---

### GET `/sites/:siteId/agentic-traffic/by-status`

Returns total hits grouped by HTTP response status code.

**RPC:** `rpc_agentic_traffic_by_status`

**Response:**

```json
[
  { "httpStatus": 200, "totalHits": 45300 },
  { "httpStatus": 404, "totalHits": 2900 }
]
```

---

## RPC Parameter Mapping

All site-scoped RPCs receive these parameters:

| RPC Parameter | Source |
|--------------|--------|
| `p_site_id` | `:siteId` path param |
| `p_start_date` | `startDate` / `start_date` |
| `p_end_date` | `endDate` / `end_date` |
| `p_platform` | `platform` after `PLATFORM_CODE_TO_DB` mapping |
| `p_category_name` | `categoryName` / `category_name` |
| `p_agent_type` | `agentType` / `agent_type` |
| `p_user_agent` | `userAgent` / `user_agent` |
| `p_content_type` | `contentType` / `content_type` |

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
- Routes are listed in `REQUIRED_CAPABILITIES` (no capability token required beyond auth)

---

## Related APIs

- [Agentic Traffic by URL API](./agentic-traffic-by-url-api.md) — Per-URL breakdown, user-agent breakdown, URL movers
- [Agentic Traffic Filter Dimensions API](./agentic-traffic-filter-dimensions-api.md) — Available filter values for the UI
- [Agentic Traffic Weeks API](./agentic-traffic-weeks-api.md) — ISO weeks with data, for the date picker
- [Agentic Traffic URL Brand Presence API](./agentic-traffic-url-brand-presence-api.md) — Brand presence citation detail for a specific URL
- [Agentic Traffic Global API](./agentic-traffic-global-api.md) — Cross-site global weekly hit totals
