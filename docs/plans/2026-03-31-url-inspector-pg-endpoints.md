# URL Inspector PG Endpoints

**Ticket:** [LLMO-4030](https://jira.corp.adobe.com/browse/LLMO-4030)
**Date:** 2026-03-31
**Status:** Implementation complete, pending deployment

## Problem

The URL Inspector page in project-elmo-ui fetches ALL brand_presence data from spreadsheets (HLX Weekly API) and processes everything client-side. The `brand_presence_sources` table in PostgreSQL has ~2.1M rows and ~333K distinct URLs. Client-side aggregation is not viable at this scale.

## Context

PR #194 (`feat: url inspector rpcs`) already added 4 PostgreSQL RPCs to mysticat-data-service:

| RPC | Purpose |
|-----|---------|
| `rpc_url_inspector_stats` | Aggregate citation stats + weekly sparkline trends |
| `rpc_url_inspector_owned_urls` | Paginated per-URL citation aggregates with JSONB weekly arrays |
| `rpc_url_inspector_trending_urls` | Paginated non-owned URL citations with per-prompt breakdown |
| `rpc_url_inspector_cited_domains` | Domain-level citation aggregations with dominant content type |

These RPCs leverage covering indexes (`idx_bps_site_content_date`, `idx_bps_urlid_site_date`), monthly partitioning by `execution_date`, and server-side pagination — all the optimization work is already in the DB layer.

**What was missing:** API endpoints in spacecat-api-service to expose these RPCs to the UI.

## Changes

### New file: `src/controllers/llmo/llmo-url-inspector.js`

4 handler factories that call the existing RPCs via PostgREST:

| Handler | Route sub-path | RPC |
|---------|---------------|-----|
| `createUrlInspectorStatsHandler` | `url-inspector/stats` | `rpc_url_inspector_stats` |
| `createUrlInspectorOwnedUrlsHandler` | `url-inspector/owned-urls` | `rpc_url_inspector_owned_urls` |
| `createUrlInspectorTrendingUrlsHandler` | `url-inspector/trending-urls` | `rpc_url_inspector_trending_urls` |
| `createUrlInspectorCitedDomainsHandler` | `url-inspector/cited-domains` | `rpc_url_inspector_cited_domains` |

### Routes (8 total)

```
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/stats
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/stats
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/owned-urls
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/owned-urls
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/trending-urls
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/trending-urls
GET /org/:spaceCatId/brands/all/brand-presence/url-inspector/cited-domains
GET /org/:spaceCatId/brands/:brandId/brand-presence/url-inspector/cited-domains
```

### Modified files

- `src/controllers/llmo/llmo-brand-presence.js` — exported 5 shared utilities for reuse
- `src/controllers/llmo/llmo-mysticat-controller.js` — instantiates and exports the 4 new handlers
- `src/routes/index.js` — registers 8 new routes
- `src/routes/required-capabilities.js` — adds routes to `INTERNAL_ROUTES`

### Tests

- `test/controllers/llmo/llmo-url-inspector.test.js` — covers all 4 handlers

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

### 5. Cited domains: no pagination

`rpc_url_inspector_cited_domains` returns all domains without pagination. Domain count per site is bounded (typically hundreds to low thousands of distinct hostnames), so the response size is manageable. Can be added later via a new migration if profiling shows issues.

### 6. Exported shared utilities from `llmo-brand-presence.js`

Rather than duplicating `withBrandPresenceAuth`, `shouldApplyFilter`, `parseFilterDimensionsParams`, `defaultDateRange`, and `parsePaginationParams`, these were exported from the existing file. This avoids code duplication while keeping the URL Inspector handlers in a separate, focused file.

## Data Flow

```
UI (url-inspector-pg)
  → GET /org/:orgId/brands/all/brand-presence/url-inspector/stats?siteId=...
    → spacecat-api-service: createUrlInspectorStatsHandler
      → PostgREST: client.rpc('rpc_url_inspector_stats', { p_site_id, ... })
        → PostgreSQL: CTE aggregation over brand_presence_sources + brand_presence_executions
          → Uses idx_bps_site_content_date covering index
          → Partition pruning on execution_date
        ← Returns aggregate row (week=NULL) + weekly rows
      ← Handler splits into { stats, weeklyTrends }
    ← JSON response
  ← useUrlInspectorPgStats hook → StatsCardV2 components
```
