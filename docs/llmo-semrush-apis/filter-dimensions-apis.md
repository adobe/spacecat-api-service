<!--
  Copyright 2026 Adobe. All rights reserved.
  This file is licensed to you under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may obtain a copy
  of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

# LLMO Semrush Elements API — Filter Dimensions

SpaceCat wrapper endpoints over the Semrush Elements APIs for the Brand Presence / URL Inspector dashboards.

> **Upstream wiki:** https://wiki.corp.adobe.com/spaces/AEMSites/pages/3928196548/Project+Serenity+LLMO+x+Semrush+API+for+Brand+Presence+Data

---

## Index

1. [List Brands](#1-list-brands)
2. [List All Markets](#2-list-all-markets)
3. [List Markets for a Brand](#3-list-markets-for-a-brand)
4. [List Tags (workspace-wide)](#4-list-tags-workspace-wide)
5. [List Tags for a Brand](#5-list-tags-for-a-brand)
6. [List URL Inspector Filter Dimensions](#6-list-url-inspector-filter-dimensions)
7. [Supported Models](#7-supported-models)

---

## 1. List Brands

**`GET /v2/orgs/:spaceCatId/serenity/brands`**

Returns all brands tracked in the Semrush workspace for this org. Powers the brand selector dropdown.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `model` | query | ❌ | AI model filter. See [Supported Models](#7-supported-models) for valid values (default: `search-gpt`) |

### Underlying Element

| Element | UUID |
|---|---|
| `BRANDS` | `b178ce4e-6471-4430-9a32-8228ce72b2e6` |

### What it returns

A list of brand objects enriched with the matching SpaceCat brand ID. `spacecat_brand_id` is resolved via case-insensitive name match against SpaceCat brands for the org, and is `null` when no match is found.

### Response example

```json
[
  {
    "id": null,
    "label": "Adobe",
    "spacecat_brand_id": "3e3556f0-6494-4e8f-858f-01f2c358861a"
  },
  {
    "id": null,
    "label": "Adobe Express",
    "spacecat_brand_id": null
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | null | Always `null` — Semrush has no stable brand ID |
| `label` | string | Brand display name as stored in Semrush |
| `spacecat_brand_id` | string \| null | SpaceCat brand UUID matched by name (case-insensitive), or `null` if unmatched |

---

## 2. List All Markets

**`GET /v2/orgs/:spaceCatId/serenity/all/markets`**

Returns all markets (location + language combinations) across the entire workspace, with no brand filter. Powers the region selector when no specific brand is selected.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |

### Underlying Element

| Element | UUID |
|---|---|
| `MARKETS` | `478968a7-8851-4daf-83f7-2e8fb6185ddc` |

### What it returns

All Semrush projects (markets) in the workspace, enriched with SpaceCat metadata from `brand_to_semrush_projects`. Fields sourced from SpaceCat are `null` when no matching row exists.

### Response example

```json
[
  {
    "id": "AU",
    "semrush_project_id": "5f0e8c91-dbd5-4b96-91e4-803fc920a589",
    "label": "AU-en",
    "spacecat_brand_id": "3e3556f0-6494-4e8f-858f-01f2c358861a",
    "geoTargetId": 2036,
    "languageCode": "en"
  },
  {
    "id": "US",
    "semrush_project_id": "b558a5e8-d9cb-4ace-907d-825eb4f9c0db",
    "label": "US-en",
    "spacecat_brand_id": "3e3556f0-6494-4e8f-858f-01f2c358861a",
    "geoTargetId": 2840,
    "languageCode": "en"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | string \| null | Country/region code extracted from label (e.g. `"AU-en"` → `"AU"`). `null` if label has no `-`. |
| `semrush_project_id` | string | Semrush project UUID — use this as `projectId` in subsequent API calls |
| `label` | string | Human-readable market label (e.g. `"AU-en"`) |
| `spacecat_brand_id` | string \| null | SpaceCat brand UUID from `brand_to_semrush_projects`, or `null` if not yet registered |
| `geoTargetId` | number \| null | Google Ads Geo Target ID from `brand_to_semrush_projects` |
| `languageCode` | string \| null | BCP-47 language subtag from `brand_to_semrush_projects` |

---

## 3. List Markets for a Brand

**`GET /v2/orgs/:spaceCatId/serenity/:brandId/markets`**

Returns markets for a specific SpaceCat brand. The brand's name is resolved from SpaceCat and used to filter the Semrush workspace by `CBF_ws_brand`.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `brandId` | path | ✅ | SpaceCat brand UUID |

### Underlying Element

| Element | UUID |
|---|---|
| `MARKETS` | `478968a7-8851-4daf-83f7-2e8fb6185ddc` |

### What it returns

Same shape as [List All Markets](#2-list-all-markets), filtered to the given brand. The brand name is resolved via `getBrandById` and passed as `CBF_ws_brand` to the Elements API. `BrandSemrushProject.allByBrandId(brandId)` is fetched in parallel for enrichment.

### Response example

```json
[
  {
    "id": "US",
    "semrush_project_id": "b558a5e8-d9cb-4ace-907d-825eb4f9c0db",
    "label": "US-en",
    "spacecat_brand_id": "3e3556f0-6494-4e8f-858f-01f2c358861a",
    "geoTargetId": 2840,
    "languageCode": "en"
  }
]
```

> Returns `404` if `brandId` does not belong to the org.

---

## 4. List Tags (workspace-wide)

**`GET /v2/orgs/:spaceCatId/serenity/tags`**

Returns all tags available in the workspace. Optionally scoped to a specific Semrush project via `projectId`.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `model` | query | ❌ | AI model filter. See [Supported Models](#7-supported-models) for valid values (default: `search-gpt`) |
| `projectId` | query | ❌ | Semrush project UUID — scopes tags to a specific market |

### Underlying Element

| Element | UUID |
|---|---|
| `TOPICS` | `ba3b19c1-22d4-460a-8dc3-1ff05c360852` |

### What it returns

A list of tag objects. Each tag has a colon-separated `value` from Semrush (`type:name`) which is split into `type` and `name`.

### Response example

```json
[
  { "value": "topic:2026 Calendar", "type": "topic", "name": "2026 Calendar" },
  { "value": "category:ACN - Acrobat", "type": "category", "name": "ACN - Acrobat" },
  { "value": "intent:commercial", "type": "intent", "name": "commercial" },
  { "value": "source:human", "type": "source", "name": "human" }
]
```

| Field | Type | Description |
|---|---|---|
| `value` | string | Raw tag value from Semrush (e.g. `"category:Firefly"`) |
| `type` | string | Tag type prefix: `topic`, `category`, `intent`, or `source` |
| `name` | string | Tag name after the colon |

---

## 5. List Tags for a Brand

**`GET /v2/orgs/:spaceCatId/serenity/:brandId/tags`**

Returns all tags across all of the brand's Semrush projects, aggregated and deduplicated. Project IDs are resolved automatically from `brand_to_semrush_projects` — no need to pass them manually.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `brandId` | path | ✅ | SpaceCat brand UUID |
| `model` | query | ❌ | AI model filter. See [Supported Models](#7-supported-models) for valid values (default: `search-gpt`) |

### Underlying Element

| Element | UUID |
|---|---|
| `TOPICS` | `ba3b19c1-22d4-460a-8dc3-1ff05c360852` |

### What it returns

Same shape as [List Tags](#4-list-tags-workspace-wide). Fetches tags for every `BrandSemrushProject` row for the brand in parallel, then deduplicates by `value`. If no `BrandSemrushProject` row exists, falls back to workspace-wide tags (no `project_id` filter applied).

### Response example

```json
[
  { "value": "topic:2026 Calendar", "type": "topic", "name": "2026 Calendar" },
  { "value": "category:ACN - Acrobat", "type": "category", "name": "ACN - Acrobat" }
]
```

> Returns `404` if `brandId` does not belong to the org.

---

## 6. List URL Inspector Filter Dimensions

**`GET /v2/orgs/:spaceCatId/serenity/all/brand-presence/url-inspector/filter-dimensions`**

Returns all filter dimensions needed to initialise the URL Inspector dashboard in a single call. Makes **three upstream Elements API calls in parallel** (Brands, Topics, Markets) and merges the results.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `model` | query | ❌ | AI model filter. See [Supported Models](#7-supported-models) for valid values (default: `search-gpt`) |

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

## 7. Supported Models

The `model` query parameter is accepted by the Brands, Topics, and Filter Dimensions endpoints. Only the following values are valid. Any unrecognised value silently falls back to the default (`search-gpt`).

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

> Source of truth: [`src/support/elements/constants.js`](../../src/support/elements/constants.js) — `ELEMENT_MODELS` and `DEFAULT_ELEMENT_MODEL`.
