# Agentic Traffic Filter Dimensions API

Returns the available filter values for the Agentic Traffic UI: categories, agent types, platforms, content types, and user agents. All five dimensions are returned in a single round-trip using a single RPC call with cascading behavior — each dimension list respects the other active filters but ignores its own filter.

Data is queried from mysticat-data-service PostgreSQL via PostgREST. Requires LLMO organization access.

---

## API Path

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/agentic-traffic/filter-dimensions` | All filter dimensions for the site |

**Path parameters:**
- `siteId` — Site UUID

---

## Query Parameters

Accepts the standard agentic traffic filters. The cascading behavior means each dimension list is computed with all other filters applied except its own.

| Parameter | Aliases | Type | Default | Description |
|-----------|---------|------|---------|-------------|
| `startDate` | `start_date` | string (YYYY-MM-DD) | 28 days ago | Start of date range |
| `endDate` | `end_date` | string (YYYY-MM-DD) | today | End of date range |
| `platform` | — | string | — | AI platform UI code (mapped to DB value — see [platform mapping](./agentic-traffic-api.md#platform-code-mapping)) |
| `categoryName` | `category_name` | string | — | Active category filter (cascades to other dimensions) |
| `agentType` | `agent_type` | string | — | Active agent type filter |
| `userAgent` | `user_agent` | string | — | Active user agent filter |
| `contentType` | `content_type` | string | — | Active content type filter |

---

## RPC

**Function:** `rpc_agentic_traffic_distinct_filters`

All standard agentic traffic RPC parameters are forwarded. The function returns all five dimension arrays in one row as a JSONB result.

---

## Response Shape

```json
{
  "categories": ["Blog", "Product", "Documentation"],
  "agentTypes": ["crawler", "assistant", "api"],
  "platforms": ["ChatGPT", "Gemini", "Perplexity"],
  "contentTypes": ["text/html", "application/json"],
  "userAgents": ["GPTBot", "Google-Extended", "ClaudeBot"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `categories` | string[] | Distinct content category names with data in the date range |
| `agentTypes` | string[] | Distinct agent type values |
| `platforms` | string[] | Distinct platform values **as stored in the DB** (e.g. `ChatGPT`, not `openai`) |
| `contentTypes` | string[] | Distinct content type values |
| `userAgents` | string[] | Distinct user agent strings |

> **Note:** `platforms` in the response contains raw DB values (e.g. `ChatGPT`). When sending a `platform` filter back to any agentic traffic endpoint, use the corresponding UI code (e.g. `openai` or `chatgpt`) — the mapping is applied server-side.

---

## Sample URL

```
GET /sites/c2473d89-e997-458d-a86d-b4096649c12b/agentic-traffic/filter-dimensions
```

**With active filters (cascading):**
```
GET /sites/c2473d89-e997-458d-a86d-b4096649c12b/agentic-traffic/filter-dimensions?startDate=2026-03-01&endDate=2026-03-31&platform=chatgpt
```

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
- Route is listed in `REQUIRED_CAPABILITIES`

---

## Related APIs

- [Agentic Traffic API](./agentic-traffic-api.md) — KPIs, trend, and grouping by region/category/page-type/status
- [Agentic Traffic by URL API](./agentic-traffic-by-url-api.md) — Per-URL breakdown, user-agent breakdown, URL movers
- [Agentic Traffic Weeks API](./agentic-traffic-weeks-api.md) — Available ISO weeks for the date picker
