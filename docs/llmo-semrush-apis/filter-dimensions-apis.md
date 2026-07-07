<!--
  Copyright 2026 Adobe. All rights reserved.
  This file is licensed to you under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may obtain a copy
  of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

# LLMO Semrush Elements API — Filter Dimensions, Weeks & Cited Domains

SpaceCat wrapper endpoints over the Semrush Elements APIs for the Brand Presence / URL Inspector dashboards.

> **Upstream wiki:** https://wiki.corp.adobe.com/spaces/AEMSites/pages/3928196548/Project+Serenity+LLMO+x+Semrush+API+for+Brand+Presence+Data

---

## Index

1. [List URL Inspector Filter Dimensions](#1-list-url-inspector-filter-dimensions)
2. [List Weeks](#2-list-weeks)
3. [List Cited Domains](#3-list-cited-domains)
4. [Supported Models](#4-supported-models)

---

## 1. List URL Inspector Filter Dimensions

**`GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/url-inspector/filter-dimensions`**

Returns all filter dimensions needed to initialise the URL Inspector dashboard in a single call. Makes **three upstream Elements API calls in parallel** (Brands, Topics, Markets) and merges the results.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `model` | query | ❌ | AI model filter. See [Supported Models](#2-supported-models) for valid values (default: `search-gpt`) |

### Underlying Elements

| Dimension | Element | UUID |
|---|---|---|
| `brands` | `BRANDS` | `b178ce4e-6471-4430-9a32-8228ce72b2e6` |
| `regions` | `MARKETS` | `478968a7-8851-4daf-83f7-2e8fb6185ddc` |
| `topics`, `categories`, `page_intents`, `origins` | `TOPICS` | `ba3b19c1-22d4-460a-8dc3-1ff05c360852` |

### What it returns

A single object with six dimension arrays, each shaped for direct use as filter picker options.

- **`brands`** — workspace brands enriched with `spacecat_brand_id` via case-insensitive name match against SpaceCat brands
- **`regions`** — all workspace markets enriched with `spacecat_brand_id`, `geoTargetId`, `languageCode` from `brand_to_semrush_projects`
- **`topics`** — tags prefixed `topic:` from the Topics element
- **`categories`** — tags prefixed `category:` from the Topics element
- **`page_intents`** — tags prefixed `intent:`; `id` is uppercased, `label` is kept as-is from Semrush
- **`origins`** — tags prefixed `source:` from the Topics element

### Response example

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

| Dimension | `id` | `label` | Extra fields |
|---|---|---|---|
| `brands` | Always `null` | Brand name from Semrush | `spacecat_brand_id` |
| `regions` | Country code from label (e.g. `"AU"`) | Market label (e.g. `"AU-en"`) | `semrush_project_id`, `spacecat_brand_id`, `geoTargetId`, `languageCode` |
| `topics` | Always `null` | Topic name (after `topic:` prefix) | — |
| `categories` | Always `null` | Category name (after `category:` prefix) | — |
| `page_intents` | Uppercased intent (e.g. `"COMMERCIAL"`) | Raw intent from Semrush (e.g. `"commercial"`) | — |
| `origins` | Source value (e.g. `"human"`) | Same as `id` | — |

---

## 2. List Weeks

**`GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/weeks`**

Returns the weeks that have Brand Presence data, for the week/date filter dropdown. **Drop-in compatible with the legacy Brand Presence `weeks` contract**, so the URL Inspector filter consumes it unchanged.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `model` / `platform` | query | ❌ | AI model filter. Accepts **either** key (`model` wins if both are sent). UI platform codes are translated to Semrush models — see [Supported Models](#4-supported-models) (default: `search-gpt`) |
| `siteId` / `site_id` | query | ❌ | Site UUID. Reverse-mapped to the site's **primary brand** (`brands.site_id`), which scopes the weeks via a `CBF_ws_brand` filter. Returns `404` if the site has no brand. Omitted → workspace-wide weeks |

### Underlying Element

| Element | UUID | Shape |
|---|---|---|
| `WEEKS` | `afa7458b-d34f-43d9-8cc5-e8794753551c` | `table` — one row per day that has data (`{ date, models }`) |

### What it returns

The daily rows are rolled up into ISO weeks spanning the earliest→latest day present, ordered **newest-first**. Each entry matches the legacy contract exactly:

- **`week`** — ISO week string `YYYY-Wnn`
- **`startDate`** — Monday of that week (`YYYY-MM-DD`)
- **`endDate`** — Sunday of that week (`YYYY-MM-DD`)

### Response example

```json
{
  "weeks": [
    { "week": "2026-W27", "startDate": "2026-06-29", "endDate": "2026-07-05" },
    { "week": "2026-W26", "startDate": "2026-06-22", "endDate": "2026-06-28" }
  ]
}
```

> **`siteId` → brand:** Semrush has no concept of a site. The endpoint resolves `siteId` to the site's primary brand via `getBrandBySite` and scopes the query with `CBF_ws_brand` (brand **name**), mirroring the Markets element. The brand ID itself is not sent upstream.

> **⚠️ Open (POC):** (1) the `openai`→`gpt-5` and `chatgpt`→`search-gpt` model mappings are provisional pending product confirmation; (2) whether the `WEEKS` element honours `CBF_ws_brand` is unverified — if it does not, brand scoping will move to `CBF_project` via the brand's Semrush projects.

---

## 3. List Cited Domains

**`GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/url-inspector/cited-domains`**

Returns the domains most frequently cited alongside owned URLs, for the URL Inspector **Cited Domains** panel. **Drop-in compatible with the legacy `url-inspector/cited-domains` contract** — same JSON shape, so the panel consumes it unchanged.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `brandId` | path | ✅ | SpaceCat brand UUID. Selects the brand whose Semrush **sub-workspace** is queried (every element is brand-scoped); classified as an LLMO ReBAC `brand` resource so FACS enforces `llmo/can_view` on it, and it requires the `brand:read` S2S capability. `404` if the brand isn't in the org. The URL Inspector UI cross-maps its selected site → `brandId`. See gap 3 for sub-workspace vs flat-mode |
| `model` / `platform` | query | ❌ | AI model filter. Accepts **either** key (`model` wins). Translated via [Supported Models](#4-supported-models) (default: `search-gpt`) |
| `startDate` / `start_date` | query | ❌ | ISO date `YYYY-MM-DD`. Default: 28 days ago |
| `endDate` / `end_date` | query | ❌ | ISO date `YYYY-MM-DD`. Default: today |
| `categoryId` / `category` | query | ❌ | Category label (e.g. `Firefly`). Pushed to Semrush **server-side** as the tag `category:<label>` |
| `channel` / `selectedChannel` | query | ❌ | Content-type (e.g. `Owned`, `Social`, `Earned`). Applied **client-side** on `contentType` (case-insensitive) — the element has no server-side content-type filter |
| `region` | query | ❌ | Region code (e.g. `US`, `AU`). Resolved to the market's Semrush **project** (via the Markets element) and sent as top-level `project_id`. `all`/absent → all markets |
| `page` | query | ❌ | 0-based page index (default `0`) |
| `pageSize` | query | ❌ | Rows per page (default `50`, clamped to `[1, 1000]`) |

### Underlying Element

| Element | UUID | Shape |
|---|---|---|
| `CITED_DOMAINS` | `98b91d00-9531-4120-b3b5-17cc27489fce` | `table` — one row per cited domain ("Stats per Domain") |

The element accepts **only** a date range (`CBF_date__start`/`CBF_date__end`, duplicated in both the `simple` and `advanced` filter blocks — a Semrush quirk) and `CBF_model`.

### What it returns

Rows are sorted by `totalCitations` **descending** and sliced client-side (Semrush has no server-side pagination); `totalCount` is the full pre-slice count. Fields map from the element as:

- **`domain`** ← `domain`
- **`totalCitations`** ← `mentions_end`
- **`totalUrls`** ← `urls_count`
- **`promptsCited`** ← `prompts_with_citations`
- **`contentType`** ← `domain_type` (Owned / Other / Social / Earned / Benchmark Competitors) — the UI filters its Third-Party table on `contentType !== 'owned'`, so the Semrush ownership class maps directly
- **`categories`**, **`regions`** → **`''`** (see gap below)

### Response example

```json
{
  "domains": [
    {
      "domain": "example.com",
      "totalCitations": 42,
      "totalUrls": 7,
      "promptsCited": 19,
      "contentType": "Benchmark Competitors",
      "categories": "",
      "regions": ""
    }
  ],
  "totalCount": 128
}
```

> **Filters (behaviour confirmed via live testing 2026-07-06):**
> - **`model` — server-side** (`CBF_model`). Works.
> - **`category` — server-side** as the tag `category:<label>`. Works (e.g. `Firefly` → result set shrinks).
> - **`channel` — client-side** on `contentType`/`domain_type` (the element ignores a server-side content-type filter, but we already receive `domain_type` per row). Case-insensitive.
> - **`region` — server-side** via a top-level `project_id` (NOT a `CBF_*` filter, which the element ignores). The region code is resolved to the market's Semrush project via the Markets element. Works (US → 1,675, AU → 12,655, all → 14,012 in the hackathon workspace). All three (region, category, channel) compose correctly.
>
> **⚠️ Gaps (POC):**
> 1. Element `98b91d00` cannot source `categories` or `regions` — returned as **`''`** (matching the legacy handler's `|| ''` and the UI's non-nullable `string` contract). *Ask Semrush* to expose per-domain category/region breakdowns.
> 2. **`channel` value taxonomy:** the client-side filter matches the UI's channel value against Semrush `domain_type` (Owned / Other / Social / Earned / Benchmark Competitors). This assumes the channel dropdown is populated from those values; the Serenity `filter-dimensions` endpoint does not yet return a `content_types` list, so populating that dropdown is a separate follow-up.
> 3. **Region resolution is org-wide, not site-brand-scoped.** The Markets element and `project_id` are resolved across ALL of the org's brands (the site's own primary brand may own no Semrush projects), preferring the site's brand only as a tiebreaker. When multiple brands share a region code this is a best-effort pick.
> 4. **Brand scoping is via the sub-workspace, not `CBF_ws_brand`.** Every Semrush element is scoped by the brand's mapped **sub-workspace**; this endpoint takes a required `brandId`, verifies it belongs to the org, and queries `brand.semrushWorkspaceId` (`CBF_ws_brand` is a confirmed no-op and is not sent). **Flat-mode brands** (no sub-workspace minted) fall back to the org/parent workspace — so a flat-mode brand's results are org-wide until its sub-workspace exists. The sibling endpoints (`filter-dimensions`, `weeks`) still take no brand and query the org workspace — that fix (add required `brandId` + sub-workspace) is tracked in **LLMO-6029**.

---

## 4. Supported Models

The `model` (or `platform`) query parameter is accepted by these endpoints. Only the following Semrush values are valid; any unrecognised value silently falls back to the default (`search-gpt`).

| # | Model value | Default |
|---|---|---|
| 1 | `google-ai-mode` | |
| 2 | `grok-3` | |
| 3 | `google-ai-overview` | |
| 4 | `microsoft-copilot` | |
| 5 | `open-evidence` | |
| 6 | `gemini-2.5-flash` | |
| 7 | `claude-sonnet-4` | |
| 8 | `gpt-5` | |
| 9 | `deepseek` | |
| 10 | `search-gpt` | ✅ |
| 11 | `perplexity` | |

### UI platform code → Semrush model

The UI keeps sending its existing platform filter codes (project-elmo-ui `PLATFORM_CODES`); SpaceCat translates them to Semrush model values via `resolveElementModel`. Codes already identical to a Semrush model, and Semrush-only models with no UI counterpart, pass through unchanged.

| UI platform code | Semrush model | Note |
|---|---|---|
| `openai` (ChatGPT Paid) | `gpt-5` | ⚠️ provisional — confirm with product |
| `chatgpt` (ChatGPT Free) | `search-gpt` | ⚠️ provisional — confirm with product |
| `copilot` | `microsoft-copilot` | rename |
| `gemini` | `gemini-2.5-flash` | rename |
| `google-ai-overview` | `google-ai-overview` | identical |
| `google-ai-mode` | `google-ai-mode` | identical |
| `perplexity` | `perplexity` | identical |

> Source of truth: [`src/support/elements/constants.js`](../../src/support/elements/constants.js) — `ELEMENT_MODELS`, `DEFAULT_ELEMENT_MODEL`, `PLATFORM_TO_ELEMENT_MODEL`, and `resolveElementModel`.
