# Semrush Elements API Wrapper — Reference Guide

> **Project Serenity** — SpaceCat wrapper layer over the Semrush Elements APIs for Brand Presence and URL Inspector dashboards.
>
> Wiki: https://wiki.corp.adobe.com/spaces/AEMSites/pages/3928196548/Project+Serenity+LLMO+x+Semrush+API+for+Brand+Presence+Data

---

## Table of Contents

1. [Overview](#overview)
2. [Entity Mapping](#entity-mapping)
3. [Upstream API Pattern](#upstream-api-pattern)
4. [Codebase Structure](#codebase-structure)
5. [Layer Responsibilities](#layer-responsibilities)
6. [Authentication](#authentication)
7. [SpaceCat Routes](#spacecatroutes)
8. [Adding a New Element](#adding-a-new-element)
9. [All Known Element IDs](#all-known-element-ids)
10. [Error Handling](#error-handling)
11. [Environment Variables](#environment-variables)

---

## Overview

The Semrush Elements APIs are a family of endpoints that power the Brand Presence and URL Inspector dashboards. All calls share a single URL template and POST method but differ in:

- **`elementId`** — a stable UUID that identifies the data type (never changes per org)
- **Payload** — data-type-specific filters, date ranges, pagination, and advanced filter expressions
- **Response** — typed and transformed before returning to the SpaceCat client

SpaceCat wraps these as standard `GET` REST endpoints, hiding the POST/payload complexity behind clean query-string parameters.

---

## Entity Mapping

| SpaceCat concept | Semrush concept | How it is resolved |
|---|---|---|
| Org (`spaceCatId`) | Workspace (`workspaceId`) | `resolveWorkspaceId(ctx, spaceCatId)` in `workspace-resolver.js` |
| Brand (`brandId`) | Subworkspace (`subworkspaceId`) | `resolveBrandSubworkspaceId(ctx, brandId)` in `workspace-resolver.js` |
| Location + Language | Project (`projectId`) | Surfaced in the filter-dimensions `regions` array as `semrush_project_id`; pass as `?projectIds=` in Phase 2 calls |

**Important invariants:**
- `elementId` UUIDs are Semrush-assigned and **never change** regardless of org, brand, or environment.
- `workspaceId` is org-scoped and read from the Organisation's `semrush_workspace_id` field.
- `projectId` values are discovered at runtime via the filter-dimensions `regions` array. Use the returned `semrush_project_id` field as `projectIds` in Phase 2 brand-scoped calls.
- SpaceCat stores the `brandId → semrushProjectId` mapping in `brand_to_semrush_projects` (`BrandSemrushProject` entity). This table is used to enrich filter-dimension regions with `spacecat_brand_id`, `geoTargetId`, and `languageCode`.

---

## Upstream API Pattern

All Semrush Elements calls follow this shape:

```
POST {SEMRUSH_PROJECTS_BASE_URL}/enterprise/pages/api/v3/workspaces/{workspaceId}/products/ai/elements/{elementId}/data
Authorization: Bearer <ims-access-token>
Content-Type: application/json

{ ...element-specific payload }
```

**Response envelope** (always):
```json
{
  "type": "columnBasedFilter | simpleNumeric | line | bar | table",
  "title": "",
  "blocks": { ...type-specific data },
  "config": { ...nullable metadata }
}
```

**Key payload features:**
- `comparison_data_formatting`: `"union"` (separate primary + comparison rows) or `"join"` (comparison columns merged into each row)
- `filters.simple`: Date ranges (`start_date`, `end_date`, `comparison_start_date`, `comparison_end_date`) and scalar filter shortcuts
- `filters.advanced`: Nested boolean filter tree (`{ op: "and"|"or", filters: [...] }`) with column expressions (`{ op: "eq"|"gte"|"lte"|"url_match", col: "CBF_*", val: "..." }`)
- `auto_bucketing`: `"date"` or `"week"` — groups time-series data by day or week
- `statistics`: Aggregate functions (e.g. `{ rowCount: { col: "*", func: "count" } }`)
- `pagination`: `{ limit, offset, sort_columns }`

**Note on shared UUIDs:** Some element UUIDs are reused for different dashboard sections with different payloads. For example, `b5281393` (TRENDS_MV) powers both the Aggregated Stats trends chart (row 9) and the Market Tracking Trends chart (row 11). Each usage gets its own definition file and service method.

---

## Codebase Structure

```
src/
├── controllers/
│   └── elements.js                       # ElementsController — route handlers + auth
│
└── support/
    └── elements/
        ├── element-ids.js                # All Semrush element UUID constants (ELEMENT_IDS.*)
        ├── errors.js                     # ElementsTransportError class
        ├── elements-transport.js         # Generic HTTP transport (single fetchElement method)
        ├── elements-service.js           # Service layer — one method per SpaceCat endpoint
        └── definitions/                  # Per-element payload builders + response transformers
            ├── index.js                  # Re-exports all definitions
            ├── brands.js                 # Row 1 — Brands filter dimension
            ├── markets.js                # Row 2 — Markets filter dimension
            └── topics.js                 # Row 3 — Topics (Tags) filter dimension
```

---

## Layer Responsibilities

### `element-ids.js` — UUID constants

Centralises all Semrush-assigned element UUIDs. Single source of truth so a future rename or UUID update touches exactly one file.

```js
export const ELEMENT_IDS = Object.freeze({
  BRANDS:   'b178ce4e-6471-4430-9a32-8228ce72b2e6',
  MARKETS:  '478968a7-8851-4daf-83f7-2e8fb6185ddc',
  // ...
});
```

---

### `errors.js` — Transport error class

```js
export class ElementsTransportError extends Error {
  constructor(status, message, body) { ... }
  // .status  — upstream HTTP status code
  // .body    — parsed upstream body (logged server-side ONLY, never sent to clients)
}
```

---

### `elements-transport.js` — HTTP transport

Single method: `fetchElement(workspaceId, elementId, payload)`.

- Reads base URL from `env.SEMRUSH_PROJECTS_BASE_URL` (same secret used by the Serenity transport)
- Enforces HTTPS — throws `ErrorWithStatusCode(503)` if misconfigured
- Authenticates with the caller's IMS bearer token forwarded unchanged
- `AbortController` timeout at 15 seconds — throws `ElementsTransportError(504)` on timeout
- Parses response body as JSON (falls back to raw text)
- Throws `ElementsTransportError(status, message, body)` for non-2xx responses

---

### `definitions/<name>.js` — Payload builder + response transformer

Each file exports exactly **two functions**:

| Export | Signature | Purpose |
|---|---|---|
| `build<Name>Payload(params)` | `(queryParams) → SemrushPayload` | Constructs the upstream POST body from SpaceCat query params |
| `transform<Name>Response(raw)` | `(rawResponse) → TypedResult` | Maps raw Semrush response to a typed SpaceCat-shaped object |

**Convention:** When an element UUID is reused for two different dashboard sections, create separate definition files (e.g. `trends-aggregated.js` and `trends-market-tracking.js`) with their own payload builders and transformers. The `ELEMENT_IDS` constant can point to the same UUID in both cases.

**Example — `brands.js`:**
```js
export function buildBrandsPayload({ model = 'search-gpt' } = {}) {
  return {
    comparison_data_formatting: 'union',
    filters: {
      advanced: { op: 'and', filters: [{ op: 'eq', val: model, col: 'CBF_model' }] },
    },
  };
}

export function transformBrandsToFilterDimensions(raw, spacecatBrands = []) {
  const brandIdByName = new Map(
    spacecatBrands.map((b) => [String(b.name ?? '').toLowerCase(), b.id]),
  );
  return (raw?.blocks?.value ?? []).map((item) => {
    const label = item.value ?? '';
    return {
      id: null,
      label,
      spacecat_brand_id: brandIdByName.get(label.toLowerCase()) ?? null,
    };
  });
}
```

---

### `elements-service.js` — Service layer

Composes transport + definitions. One method per logical SpaceCat endpoint. Method names describe **dashboard intent**, not the element UUID.

```js
export function createElementsService(transport) {
  return {
    async getUrlInspectorFilterDimensions(workspaceId, params, spacecatBrands = [], projects = []) {
      const [rawTopics, rawBrands, rawMarkets] = await Promise.all([
        transport.fetchElement(workspaceId, ELEMENT_IDS.TOPICS, buildTopicsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.BRANDS, buildBrandsPayload(params)),
        transport.fetchElement(workspaceId, ELEMENT_IDS.MARKETS, buildMarketsPayload({})),
      ]);
      return {
        brands: transformBrandsToFilterDimensions(rawBrands, spacecatBrands),
        regions: transformMarketsToFilterDimensions(rawMarkets, projects),
        // topics, categories, page_intents, origins ...
      };
    },
  };
}
```

---

### `controllers/elements.js` — Controller

Factory function following the `SerenityController` pattern.

Two authorization helpers (Phase 1 implements `authorizeOrg` only):

| Helper | Used by | Resolves to |
|---|---|---|
| `authorizeOrg(ctx)` | Org-scoped routes (`/v2/orgs/:spaceCatId/serenity/*`) | `workspaceId` from org's `semrush_workspace_id` |
| `authorizeBrand(ctx)` *(Phase 2)* | Brand-scoped routes (`/v2/orgs/:spaceCatId/brands/:brandId/serenity/*`) | `subworkspaceId` from brand's `semrush_workspace_id` |

**`authorizeOrg` flow:**
1. Fetch `Organization.findById(spaceCatId)` — 404 if not found
2. `AccessControlUtil.fromContext(ctx).hasAccess(org)` — 403 if denied
3. `resolveWorkspaceId(ctx, spaceCatId)` — 404 if org has no `semrush_workspace_id`
4. Return `{ workspaceId }`

**Route handler pattern:**
```js
const listUrlInspectorFilterDimensions = async (ctx) => {
  try {
    const auth = await authorizeOrg(ctx);
    if (auth.error) {
      return auth.error;
    }
    const result = await buildService(ctx)
      .getUrlInspectorFilterDimensions(auth.workspaceId, extractQuery(ctx));
    return ok(result);
  } catch (e) {
    return mapError(e, log);
  }
};
```

---

## Authentication

The Semrush Elements APIs authenticate via the caller's **IMS access token**. The token is:

1. Extracted from the inbound `Authorization: Bearer <token>` header by `requireImsBearer(ctx)`
2. Forwarded unchanged to Semrush in the upstream `Authorization: Bearer <token>` header

No service-to-service credentials are involved — the user's own IMS token is the auth mechanism. `requireImsBearer` throws `ErrorWithStatusCode(401)` if the header is missing or if the caller used a non-IMS auth method (e.g. scoped API key).

---

## SpaceCat Routes

### Brand-scoped (implemented)

The endpoints below use `authorizeOrg`, which resolves `:brandId` to that brand's Semrush sub-workspace (or the org's parent workspace when the brand has none provisioned yet).

| Method | Path | Controller | Description |
|---|---|---|---|
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/url-inspector/filter-dimensions` | `listUrlInspectorFilterDimensions` | Filter dimensions for the URL Inspector dashboard, scoped to that brand |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/weeks` | `listWeeks` | Weeks with Brand Presence data, scoped to that brand |

> **Note:** The brand-, market-, and tag-selector data (formerly served by dedicated `/serenity/brands`, `/serenity/*/markets`, and `/serenity/*/tags` endpoints) is now provided by the existing Serenity APIs. Only the aggregated URL Inspector filter-dimensions endpoint is served by this Elements wrapper.

---

**Query parameters — `listUrlInspectorFilterDimensions`:**

| Param | Required | Description |
|---|---|---|
| `model` | No | AI model filter (default: `search-gpt`) |

---

**Response shape — `listUrlInspectorFilterDimensions`:**

Fetches Brands, Topics, and Markets elements in parallel (three upstream calls). Brands and regions are enriched with SpaceCat metadata.

```json
{
  "brands": [
    {
      "id": null,
      "label": "Adobe",
      "spacecat_brand_id": "3e3556f0-6494-4e8f-858f-01f2c358861a"
    }
  ],
  "regions": [
    {
      "id": "AU",
      "semrush_project_id": "5f0e8c91-dbd5-4b96-91e4-803fc920a589",
      "label": "AU-en",
      "spacecat_brand_id": "3e3556f0-6494-4e8f-858f-01f2c358861a",
      "geoTargetId": 2036,
      "languageCode": "en"
    }
  ],
  "topics": [
    { "id": null, "label": "2026 Calendar" }
  ],
  "categories": [
    { "id": null, "label": "ACN - Acrobat" }
  ],
  "page_intents": [
    { "id": "COMMERCIAL", "label": "commercial" }
  ],
  "origins": [
    { "id": "human", "label": "human" }
  ]
}
```

> `brands.spacecat_brand_id` is resolved by case-insensitive name match against SpaceCat brands for the org.
> `regions` are enriched from `brand_to_semrush_projects` joined on `semrushProjectId`.
> `page_intents.id` is uppercased; `label` is kept as-is from Semrush.
> `regions.id` and `brands.id` are `null` — use `semrush_project_id` / `spacecat_brand_id` as stable identifiers.

---

### Phase 2 — Brand-scoped (subworkspace-level, not yet implemented)

These endpoints will use `authorizeBrand` and require `:brandId` in the path. Callers first read the filter-dimensions `regions` array to discover `semrush_project_id` values, then pass them as `?projectIds=uuid1,uuid2`.

| Method | Path | Description |
|---|---|---|
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/mentions` | Mentions KPI card |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/visibility` | Visibility KPI card |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/citations` | Citations KPI card |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/trends-mv` | Mentions + Visibility trend |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/trends-citations` | Citations trend |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/sentiment` | Sentiment bar chart |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/sentiment-movers` | Sentiment movers table |
| GET | `/v2/orgs/:spaceCatId/brands/:brandId/serenity/competitor-summary` | Competitor summary table |

---

## Adding a New Element

Follow these steps in order. Steps 1–4 are contained within `src/support/elements/` and require no cross-cutting changes.

1. **Add the UUID constant** to `src/support/elements/element-ids.js`:
   ```js
   MY_NEW_ELEMENT: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
   ```
   If the new element reuses an existing UUID (same element, different payload/section), point to the existing constant — do **not** add a duplicate UUID.

2. **Create the definition file** `src/support/elements/definitions/my-new-element.js`:
   ```js
   export function buildMyNewElementPayload({ ...params }) {
     return { /* Semrush payload shape */ };
   }
   
   export function transformMyNewElementResponse(raw) {
     return (raw?.blocks?.data ?? []).map(item => ({ /* typed fields */ }));
   }
   ```
   Refer to `/Users/vivesing/Code/ClaudeMemory/Semrush-LLMO-API.md` for the exact payload and response shape.

3. **Export from the barrel** `src/support/elements/definitions/index.js`:
   ```js
   export { buildMyNewElementPayload, transformMyNewElementResponse } from './my-new-element.js';
   ```

4. **Add a service method** to `src/support/elements/elements-service.js`:
   ```js
   async getMyNewElement(workspaceId, params) {
     const payload = buildMyNewElementPayload(params);
     const raw = await transport.fetchElement(workspaceId, ELEMENT_IDS.MY_NEW_ELEMENT, payload);
     return transformMyNewElementResponse(raw);
   },
   ```

5. **Add a route handler** to `src/controllers/elements.js`:
   ```js
   const getMyNewElement = async (ctx) => {
     try {
       const auth = await authorizeOrg(ctx); // or authorizeBrand for brand-scoped
       if (auth.error) {
         return auth.error;
       }
       const result = await buildService(ctx).getMyNewElement(auth.workspaceId, extractQuery(ctx));
       return ok(result);
     } catch (e) {
       return mapError(e, log);
     }
   };
   ```
   Add to the `return` object at the bottom of `ElementsController`.

6. **Register the route** in `src/routes/index.js`:
   ```js
   'GET /v2/orgs/:spaceCatId/serenity/my-new-element': elementsController.getMyNewElement,
   ```

---

## All Known Element IDs

Source: `src/support/elements/element-ids.js`

> **Surfaced endpoints:** `BRANDS`/`MARKETS`/`TOPICS` (rows 1–3) back the [URL Inspector Filter Dimensions](../llmo-semrush-apis/filter-dimensions-apis.md#1-list-url-inspector-filter-dimensions) endpoint; `WEEKS` (row 5) backs the [Weeks](../llmo-semrush-apis/filter-dimensions-apis.md#2-list-weeks) endpoint; `PROMPTS` backs the [Prompts (count)](../llmo-semrush-apis/filter-dimensions-apis.md#3-list-prompts) endpoint.

| Constant | UUID | Section | Row(s) |
|---|---|---|---|
| `PROMPTS` | `406ba6e0-0de2-475e-80d9-42fab8616032` | Prompts (count) | — |
| `BRANDS` | `b178ce4e-6471-4430-9a32-8228ce72b2e6` | Filter Dimensions | 1 |
| `MARKETS` | `478968a7-8851-4daf-83f7-2e8fb6185ddc` | Filter Dimensions | 2 |
| `TOPICS` | `ba3b19c1-22d4-460a-8dc3-1ff05c360852` | Filter Dimensions | 3 |
| `TOTAL_EXECUTIONS` | `a4defa1a-02f7-4443-b6ed-f2ca22b23402` | Filter Dimensions | 4 |
| `WEEKS` | `afa7458b-d34f-43d9-8cc5-e8794753551c` | Filter Dimensions | 5 |
| `MENTIONS` | `e1a6811b-d0c9-4d6f-8a29-290a32db863f` | Aggregated Stats | 6 |
| `VISIBILITY` | `2724878e-e0e9-4217-ad21-d6bcb7887a09` | Aggregated Stats | 7 |
| `CITATIONS_KPI` | `588054fe-b987-40f6-9360-b5673738bdfa` | Aggregated Stats | 8 |
| `TRENDS_MV` ⚠️ shared | `b5281393-ee98-4c38-9ed5-3437b0c450c3` | Aggregated Stats + Market Tracking | 9, 11 |
| `TRENDS_CITATIONS` ⚠️ shared | `b81af644-a8db-462b-a001-ecc1eedc0552` | Aggregated Stats + Market Tracking | 10, 12 |
| `SENTIMENT` ⚠️ shared | `f4153af8-6ce9-4058-8872-8a3cf11b9907` | Market Tracking + Sentiment Overview | 13, 14 |
| `SENTIMENT_MOVERS` | `ba62a018-03bc-40d8-8602-be24975dd4f0` | Sentiment Movers | 15 |
| `COMPETITOR_SUMMARY` | `6b0dc2ca-7c06-4c8d-b169-c49a2894eac8` | Competitor Summary | 16 |
| `SOV_PER_TOPIC` | `e4d7dc35-856b-4a69-8a32-2cfc7d2ef2b0` | Share of Voice | 17 |
| `SOV_BRAND_TOPIC` | `03e0dedd-ea2f-4e19-a0fa-d35cd9e3ee9f` | Share of Voice | 18 |
| `TOPIC_SENTIMENTS` | `324c9c6a-2f30-426c-9bce-d692b5a5e52b` | Topics | 19 |
| `TOPIC_MV_PROMPTS` | `0564b061-0985-4d1e-a3d9-0fc6f37b7ed9` | Topics + Search | 20, 26 |
| `CITATIONS_SOURCES` ⚠️ shared | `141adc88-830c-4801-a67d-f8a86d0a21f7` | Topics + Topic Prompts + Topic Details | 21, 23, 30 |
| `PROMPTS_BY_TOPIC` | `78864493-90a7-449a-89ab-1ba3d09a712e` | Topic Prompts | 22 |
| `SOURCES` | `553cd819-d507-460d-a8ff-e34486bad3e1` | Topic Prompts | 24 |
| `SOURCES_DATES` | `404fb017-7e44-41ec-896f-7138f731da60` | Topic Prompts + Execution Sources | 25, 31, 35 |
| `PROMPT_AI_ANSWERS` | `45d6251f-15cd-4b33-a7f6-de97925e900e` | Prompt Details | 32 |
| `PROMPT_SOURCES` | `7db0df5c-6679-4495-8ea8-ef2dfd7e5251` | Prompt Details | 33 |
| `PROMPT_VISIBILITY` | `f5230e00-b14f-4a52-bf89-2952ef7fe39b` | Prompt Details | 34 |

> ⚠️ **Shared UUID** — same element ID is used with different payloads for different dashboard sections. Each section gets its own definition file and service method.

---

## Error Handling

### `mapError` in `controllers/elements.js`

| Error type | Mapped response |
|---|---|
| `ErrorWithStatusCode` (e.g. 401 missing token, 404 org not found, 503 bad config) | Status from `e.status`, token from `e.code` or `errorTokenForStatus(status)` |
| `ElementsTransportError` with status 401 or 403 | `{ error: "forbidden", message: "Upstream authorization failed" }` — upstream URL never leaked |
| `ElementsTransportError` with any other status | `{ error: "elementsUpstreamError", message: "Upstream request failed" }` with HTTP 502 |
| `ElementsTransportError` with status 504 (timeout) | HTTP 502 — logged server-side |
| Any other `Error` | `{ error: "internalServerError", message: "Internal server error" }` with HTTP 500 |

Upstream error bodies are **never forwarded to clients** — they are logged server-side only via `log.error`.

---

## Environment Variables

| Variable | Source | Used by |
|---|---|---|
| `SEMRUSH_PROJECTS_BASE_URL` | Vault `dx_mysticat/<env>/api-service` | `elements-transport.js` `baseUrl()` — the Elements API base host (e.g. `https://adobe-hackathon.semrush.com`) |

No additional secrets are required. The Elements transport reuses the same `SEMRUSH_PROJECTS_BASE_URL` already configured for the Serenity (prompts/markets) transport.
