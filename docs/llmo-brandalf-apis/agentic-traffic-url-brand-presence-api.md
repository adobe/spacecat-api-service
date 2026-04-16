# Agentic Traffic URL Brand Presence API

Returns brand presence citation detail for a specific URL within a site's agentic traffic context. Bridges the Agentic Traffic and Brand Presence features: given a URL (from the `by-url` breakdown), this endpoint shows how often that URL is cited in brand presence LLM executions, the weekly citation trends, and the specific prompts that cite it.

The URL is resolved via `source_urls.url_hash` (MD5 fast-lookup) so the caller must pass the full URL. The `organisation_id` is derived from the site so the access model stays consistent with all other site-scoped agentic traffic endpoints.

---

## API Path

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sites/:siteId/agentic-traffic/url-brand-presence` | Brand presence citation detail for a URL |

**Path parameters:**
- `siteId` — Site UUID

---

## Query Parameters

| Parameter | Aliases | Type | Required | Description |
|-----------|---------|------|----------|-------------|
| `url` | — | string | **Yes** | Full URL to look up (e.g. `https://www.example.com/blog/ai-tools`) |
| `startDate` | `start_date` | string (YYYY-MM-DD) | No | Start of date range. Default: 28 days ago |
| `endDate` | `end_date` | string (YYYY-MM-DD) | No | End of date range. Default: today |
| `platform` | — | string | No | AI platform UI code. Maps to the `model` RPC parameter via the platform mapping. Accepts same values as other agentic traffic endpoints (e.g. `chatgpt`, `gemini`) |

> **Note:** `platform` is passed to the RPC as `p_model`, not `p_platform`. The same [platform code mapping](./agentic-traffic-api.md#platform-code-mapping) applies.

---

## RPC

**Function:** `rpc_brand_presence_url_detail`

| RPC Parameter | Source |
|--------------|--------|
| `p_organization_id` | `site.getOrganizationId()` — resolved from the site, not a caller-supplied value |
| `p_url` | `url` query parameter |
| `p_start_date` | `startDate` / `start_date` |
| `p_end_date` | `endDate` / `end_date` |
| `p_model` | `platform` after platform code mapping |
| `p_site_id` | `:siteId` path param |

The RPC returns a JSONB object (not an array). PostgREST delivers it directly.

---

## Response Shape

```json
{
  "totalCitations": 312,
  "totalMentions": 89,
  "uniquePrompts": 14,
  "weeklyTrends": [
    {
      "week": "2026-W11",
      "citations": 42,
      "mentions": 12
    },
    {
      "week": "2026-W10",
      "citations": 38,
      "mentions": 9
    }
  ],
  "prompts": [
    {
      "promptId": "019cb903-1184-7f92-8325-f9d1176af316",
      "prompt": "best pdf tools for mac",
      "citations": 28,
      "mentions": 7
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalCitations` | number | Total times the URL was cited as a source |
| `totalMentions` | number | Total times the brand was mentioned (with or without citation) |
| `uniquePrompts` | number | Number of distinct prompts that cited this URL |
| `weeklyTrends` | array | Weekly citation/mention counts. Shape depends on the RPC — forwarded as-is. |
| `prompts` | array | Top prompts that cited the URL. Shape depends on the RPC — forwarded as-is. |

---

## Sample URLs

**Citation detail for a specific URL:**
```
GET /sites/c2473d89-e997-458d-a86d-b4096649c12b/agentic-traffic/url-brand-presence?url=https%3A%2F%2Fwww.example.com%2Fblog%2Fai-tools
```

**With date range and platform:**
```
GET /sites/c2473d89-e997-458d-a86d-b4096649c12b/agentic-traffic/url-brand-presence?url=https%3A%2F%2Fwww.example.com%2Fblog%2Fai-tools&startDate=2026-03-01&endDate=2026-03-31&platform=chatgpt
```

---

## Error Responses

| Status | Condition |
|--------|-----------|
| 400 | `url` parameter missing or empty |
| 400 | PostgREST not configured (`DATA_SERVICE_PROVIDER` ≠ `postgres`) |
| 400 | Site or organization not found |
| 400 | PostgREST/PostgreSQL RPC error |
| 403 | User does not belong to the site's organization |

---

## Authentication & Access

- Requires LLMO product access for the site's organization (`hasLlmoOrganizationAccess`)
- `organisation_id` is always derived server-side from the site — callers cannot supply a different org
- Route is listed in `REQUIRED_CAPABILITIES`

---

## Related APIs

- [Agentic Traffic by URL API](./agentic-traffic-by-url-api.md) — Per-URL breakdown where URLs for this endpoint are discovered
- [Agentic Traffic API](./agentic-traffic-api.md) — Site-level KPIs and grouping endpoints
- [Brand Presence Stats API](./brand-presence-stats-api.md) — Org-level brand presence stats
