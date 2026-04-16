# URL Inspector PG Endpoints

**Ticket:** [LLMO-4030](https://jira.corp.adobe.com/browse/LLMO-4030)
**Date:** 2026-03-31 (updated 2026-04-15)
**Status:** Implementation complete, pending deployment

## Problem

The URL Inspector page in project-elmo-ui fetches ALL brand_presence data from spreadsheets (HLX Weekly API) and processes everything client-side. The `brand_presence_sources` table in PostgreSQL has ~60M rows and ~4.4M distinct URLs. Client-side aggregation is not viable at this scale.

## Context

PR #194 (`feat: url inspector rpcs`) added 4 PostgreSQL RPCs to mysticat-data-service. Those initial RPCs queried raw `brand_presence_sources` + `brand_presence_executions` tables directly, which proved too slow at scale (~135s for stats on adobe.com).

A follow-up investigation (see `mysticat-data-service/docs/plans/2026-04-02-url-inspector-performance.md`) led to:

1. A **`url_inspector_domain_stats` summary table** — pre-aggregated domain-level citation data, ~14x smaller than the raw tables
2. **Rewritten RPCs** — `rpc_url_inspector_stats` now queries the summary table (50ms vs 135s)
3. **New drilldown RPCs** — `rpc_url_inspector_domain_urls` and `rpc_url_inspector_url_prompts` for lazy loading URL and prompt details
4. **Pagination on cited-domains** — the cited-domains RPC now supports server-side pagination

The current set of RPCs in mysticat-data-service:

| RPC | Purpose | Data source |
|-----|---------|-------------|
| `rpc_url_inspector_stats` | Aggregate citation stats + weekly sparkline trends | `url_inspector_domain_stats` (summary table) |
| `rpc_url_inspector_owned_urls` | Paginated per-URL citation aggregates with JSONB weekly arrays | Raw tables (`brand_presence_sources` + `brand_presence_executions`) |
| `rpc_url_inspector_trending_urls` | Paginated non-owned URL citations with per-prompt breakdown | Raw tables |
| `rpc_url_inspector_cited_domains` | Domain-level citation aggregations with dominant content type | Raw tables |
| `rpc_url_inspector_domain_urls` | Phase 2 drilldown: paginated URLs within a specific domain | Raw tables (scoped to one domain, fast) |
| `rpc_url_inspector_url_prompts` | Phase 3 drilldown: prompt breakdown for a specific URL | Raw tables (scoped to one URL, fast) |

## Changes

### New file: `src/controllers/llmo/llmo-url-inspector.js`

6 handler factories that call the RPCs via PostgREST:

| Handler | Route sub-path | RPC |
|---------|---------------|-----|
| `createUrlInspectorStatsHandler` | `url-inspector/stats` | `rpc_url_inspector_stats` |
| `createUrlInspectorOwnedUrlsHandler` | `url-inspector/owned-urls` | `rpc_url_inspector_owned_urls` |
| `createUrlInspectorTrendingUrlsHandler` | `url-inspector/trending-urls` | `rpc_url_inspector_trending_urls` |
| `createUrlInspectorCitedDomainsHandler` | `url-inspector/cited-domains` | `rpc_url_inspector_cited_domains` |
| `createUrlInspectorDomainUrlsHandler` | `url-inspector/domain-urls` | `rpc_url_inspector_domain_urls` |
| `createUrlInspectorUrlPromptsHandler` | `url-inspector/url-prompts` | `rpc_url_inspector_url_prompts` |

### Routes (12 total)

```
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/stats
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/owned-urls
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/owned-urls
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/trending-urls
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/trending-urls
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/cited-domains
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/cited-domains
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/domain-urls
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/domain-urls
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/url-prompts
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/url-prompts
```

### Modified files

- `src/controllers/llmo/llmo-brand-presence.js` — exported shared utilities (`withBrandPresenceAuth`, `shouldApplyFilter`, `parseFilterDimensionsParams`, `defaultDateRange`, `parsePaginationParams`, `validateSiteBelongsToOrg`, `validateModel`) for reuse
- `src/controllers/llmo/llmo-mysticat-controller.js` — instantiates and exports all 6 handlers
- `src/routes/index.js` — registers 12 routes
- `src/routes/required-capabilities.js` — adds all routes to `INTERNAL_ROUTES`

### Tests

- `test/controllers/llmo/llmo-url-inspector.test.js` — covers all handlers

## Key Decisions

### 1. Route prefix: `/brand-presence/url-inspector/` (not a top-level `/url-inspector/`)

Reuses the existing `/org/:spaceCatId/brands/:brandId/brand-presence/` prefix. This keeps the endpoints within the established auth wrapper (`withBrandPresenceAuth`), capabilities framework, and PostgREST client injection pattern. No new middleware, no new access control logic needed.

### 2. `siteId` as a required query parameter

The URL Inspector RPCs are site-scoped (`p_site_id`), unlike brand-presence RPCs which are organization-scoped (`p_organization_id`). Rather than creating new org-less routes, we keep the org-scoped route for access control and pass `siteId` as a required query param — consistent with how existing brand-presence endpoints already accept `siteId` via `parseFilterDimensionsParams`.

All handlers validate that the site belongs to the organization before calling the RPC.

### 3. Platform filter is optional with no default

Unlike brand-presence endpoints (which default to `chatgpt-free`), URL Inspector endpoints pass `null` for platform when not provided. This shows data across all models by default, matching the existing URL Inspector UI behavior. When provided, the platform is validated against the `llm_model` enum.

### 4. Trending URLs: server-side row grouping

The `rpc_url_inspector_trending_urls` RPC returns flat rows (one per URL+prompt combination). The handler groups these by URL and nests prompts, so the UI receives a clean nested structure:

```json
{
  "urls": [
    {
      "url": "https://example.com",
      "contentType": "earned",
      "totalCitations": 55,
      "prompts": [
        { "prompt": "...", "category": "...", "citationCount": 30 }
      ]
    }
  ],
  "totalNonOwnedUrls": 12345
}
```

This grouping happens in the API layer (not the DB or UI) because:
- The RPC intentionally returns flat rows for flexibility and to avoid JSONB aggregation overhead
- The UI should not need to do any data transformation
- The grouping is trivial in JS and bounded by `p_limit` (max 50 URLs per page)

### 5. Cited domains: paginated

`rpc_url_inspector_cited_domains` now supports server-side pagination via `p_limit` and `p_offset` parameters, with a `total_count` field returned in each row. The handler uses `parsePaginationParams` (default page size: 50). Each row in the response includes `totalCount` for the client to know the full dataset size.

### 6. Domain URL drilldown: `hostname` required

The `domain-urls` handler requires a `hostname` query parameter (also accepted as `domain`) identifying which domain to drill into. This is the Phase 2 lazy-loading endpoint — when a user clicks a domain in the cited-domains table, this returns the individual URLs within that domain, paginated. The query is fast because it's scoped to a single domain (thousands of rows, not millions).

### 7. URL prompt breakdown: `urlId` required

The `url-prompts` handler requires a `urlId` (also accepted as `url_id`) query parameter. This is the Phase 3 drilldown — when a user clicks a URL, this returns the prompts that cited it. Scoped to a single URL, so queries are sub-second.

### 8. Exported shared utilities from `llmo-brand-presence.js`

Rather than duplicating auth, validation, and parsing utilities, `withBrandPresenceAuth`, `shouldApplyFilter`, `parseFilterDimensionsParams`, `defaultDateRange`, `parsePaginationParams`, `validateSiteBelongsToOrg`, and `validateModel` were exported from the existing file. This avoids code duplication while keeping the URL Inspector handlers in a separate, focused file.

## Data Flow

### Stats (uses summary table — 50ms vs 135s)

```
UI (url-inspector-pg)
  → GET /org/:orgId/brands/all/brand-presence/url-inspector/stats?siteId=...
    → spacecat-api-service: createUrlInspectorStatsHandler
      → PostgREST: client.rpc('rpc_url_inspector_stats', { p_site_id, ... })
        → PostgreSQL: aggregation over url_inspector_domain_stats (summary table)
          → ~1.1M summary rows per site-month vs 10.7M raw source rows
          → No JOIN to brand_presence_executions needed
        ← Returns aggregate row (week=NULL) + weekly rows
      ← Handler splits into { stats, weeklyTrends }
    ← JSON response
  ← useUrlInspectorPgStats hook → StatsCardV2 components
```

### Domain drilldown (lazy three-phase loading)

```
Phase 1 — Cited Domains (domain overview, paginated)
  → GET .../url-inspector/cited-domains?siteId=...&page=0&pageSize=50
    → rpc_url_inspector_cited_domains → ranked domain list
  ← { domains: [...], totalCount }

Phase 2 — Domain URLs (on domain click)
  → GET .../url-inspector/domain-urls?siteId=...&hostname=reddit.com&page=0&pageSize=50
    → rpc_url_inspector_domain_urls → URLs within that domain
  ← { urls: [...], totalCount }

Phase 3 — URL Prompts (on URL click)
  → GET .../url-inspector/url-prompts?siteId=...&urlId=<uuid>
    → rpc_url_inspector_url_prompts → prompts that cited that URL
  ← { prompts: [...] }
```
