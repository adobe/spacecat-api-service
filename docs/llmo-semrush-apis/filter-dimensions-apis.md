<!--
  Copyright 2026 Adobe. All rights reserved.
  This file is licensed to you under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may obtain a copy
  of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

# LLMO Semrush Elements API — Filter Dimensions, Weeks & Prompts

SpaceCat wrapper endpoints over the Semrush Elements APIs for the Brand Presence / URL Inspector dashboards.

> **Upstream wiki:** https://wiki.corp.adobe.com/spaces/AEMSites/pages/3928196548/Project+Serenity+LLMO+x+Semrush+API+for+Brand+Presence+Data

---

## Index

1. [List URL Inspector Filter Dimensions](#1-list-url-inspector-filter-dimensions)
2. [List Weeks](#2-list-weeks)
3. [List Prompts](#3-list-prompts)
4. [Supported Models](#4-supported-models)

---

## 1. List URL Inspector Filter Dimensions

**`GET /v2/orgs/:spaceCatId/serenity/:brandId/brand-presence/url-inspector/filter-dimensions`**

Returns all filter dimensions needed to initialise the URL Inspector dashboard in a single call, scoped to a single brand. Makes **three upstream Elements API calls in parallel** (Brands, Topics, Markets) and merges the results.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `brandId` | path | ✅ | SpaceCat brand UUID. Resolves to the brand's Semrush sub-workspace (falling back to the org's parent workspace if the brand has none provisioned yet) |
| `model` | query | ❌ | AI model filter. See [Supported Models](#4-supported-models) for valid values (default: `search-gpt`) |

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

**`GET /v2/orgs/:spaceCatId/serenity/:brandId/brand-presence/weeks`**

Returns the weeks that have Brand Presence data, for the week/date filter dropdown, scoped to a single brand. **Drop-in compatible with the legacy Brand Presence `weeks` contract**, so the URL Inspector filter consumes it unchanged.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `brandId` | path | ✅ | SpaceCat brand UUID. Weeks are scoped to this brand via its resolved Semrush (sub-)workspace — the request does **not** add a `CBF_ws_brand` name filter (see note below) |
| `model` / `platform` | query | ❌ | AI model filter. Accepts **either** key (`model` wins if both are sent). UI platform codes are translated to Semrush models — see [Supported Models](#4-supported-models) (default: `search-gpt`) |
| `siteId` / `site_id` | query | ❌ | Site UUID. Must resolve (via `brands.site_id`) to the **same brand** named in the path — a mismatched or unrelated `siteId` is rejected with `400` |

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

> **`siteId` → brand:** Semrush has no concept of a site. When `siteId` is sent, the endpoint resolves it to the site's primary brand via `getBrandBySite` and verifies it matches the path's `:brandId` — a mismatch is rejected with `400`. It is used only for this validation, not as an upstream filter.

> **`CBF_ws_brand` filter:** `buildWeeksPayload` still supports an optional brand-name filter (`{ op: 'eq', val: brand, col: 'CBF_ws_brand' }`), but the controller no longer passes it — brand scoping comes entirely from the resolved workspace/sub-workspace for `:brandId`. Passing a brand name (e.g. `"Lovesac"`) that isn't registered as a `CBF_ws_brand` value in that workspace caused upstream `404 element not found in workspace` errors, so it's omitted by default.

> **⚠️ Open (POC):** (1) the `openai`→`gpt-5` and `chatgpt`→`search-gpt` model mappings are provisional pending product confirmation; (2) whether the `WEEKS` element honours `CBF_ws_brand` is unverified — if it does not, brand scoping will move to `CBF_project` via the brand's Semrush projects.

---

## 3. List Prompts

**`GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/prompts`**

Returns the prompts matching the given filters, plus their **count**. Powers the prompt healthcheck metrics: **intent %** is derived by grouping the returned rows on `primary_intent`; **branded %** by comparing a topic-filtered count against the unfiltered count.

**Brand-scoped (not org-scoped).** Semrush projects — and therefore prompts — live only in a brand's own Semrush **sub-workspace**, never in the org's shared parent workspace (verified against prod: the same project payload returns data on the sub-workspace and `0` on the parent). The endpoint resolves the brand's sub-workspace and **refuses to run against an org workspace**.

**Auth (required).** Like all Semrush-wrapping endpoints, this needs **two** credentials on the request:

- `Authorization: Bearer <jwt>` — a **spacecat JWT session token** (authenticates the caller to SpaceCat).
- `x-promise-token: <token>` — exchanged server-side for the upstream Semrush IMS token. A request without it cannot reach Semrush.

In project-elmo-ui the JWT is attached automatically by `authenticatedFetch`; the promise token is **not** — the v2 machinery (`getValidPromiseToken()`, `POST /auth/v2/promise`) is built but has no live consumer yet, so this endpoint would be its first. Attach it per the pattern in the elmo `docs/api/promise-token.md`: `headers: { 'x-promise-token': await getValidPromiseToken() }`.

### Parameters

| Name | In | Required | Description |
|---|---|---|---|
| `spaceCatId` | path | ✅ | SpaceCat organisation UUID |
| `brandId` | path | ✅ | Brand UUID. Must be a UUID (`400` otherwise) and resolve to a brand in the org (`404` otherwise) |
| `model` / `platform` | query | ❌ | AI model filter. Accepts **either** key (`model` wins if both are sent). UI platform codes are translated to Semrush models — see [Supported Models](#4-supported-models) (default: `search-gpt`) |
| `tag` | query | ❌ | Comma-separated **full** tag values (`tags contains <value>`), AND-ed (a prompt must carry all). Pass the whole prefixed value — the tag taxonomy varies by brand: `type:branded` / `type:non-branded`, `category:<name>`, `intent:<name>`, `source:<name>`, `topic:<name>`. Omitted → no tag filter |
| `projectId` / `project_id` | query | ❌ | Comma-separated Semrush project UUIDs to scope to (OR-ed). The UI already holds these as `semrush_project_id` from the [filter-dimensions `regions`](#1-list-url-inspector-filter-dimensions). Omitted → all of the brand's projects in its sub-workspace |

### Computing the prompt healthcheck metrics (per project)

Both metrics are **per project** — issue one request per `projectId`.

- **Intent coverage** — one call, no tag filter. Group the returned rows by
  `primary_intent` and compare each intent's share against its target band. `count` is
  the denominator. `primary_intent` is the **Semrush 5-value taxonomy**:
  `informational` / `task` / `commercial` / `transactional` / `navigational`. This is
  the same set the serenity SR surface already uses (`SRBrandTopicCatalogIntent`); the
  legacy LLMO 6-value intents map onto it via `INTENT_MAP` in mysticat-data-service
  (`scripts/serenity_migration/tags.py`): `informational→Informational`,
  `instructional→Task`, `comparative→Commercial`, `transactional→Transactional`,
  `delegation→Task`, `planning→Task` (`Navigational` is Semrush-only, no LLMO source).
- **Branded / unbranded** — the branded flag is a **tag**, not a row field. Two counts:
  - total = `?projectId=<id>` → `count`
  - branded = `?projectId=<id>&tag=type:branded` → `count`
  - branded% = branded ÷ total. (`type:branded` + `type:non-branded` partition the
    total exactly — verified in prod: 510 + 687 = 1197 → **43%**.)

### Consumer integration (project-elmo-ui prompt healthcheck)

The serenity healthcheck consumes this **raw** endpoint and aggregates client-side (the
established serenity pattern — e.g. `buildTopicResearchIntentBreakdownFromRows`), rather
than the brand-wide `/prompts/stats` + Postgres RPC used by the legacy path. Wiring it up
means:

1. **Attach `x-promise-token`** on the call (see Auth above) — the endpoint's hard
   requirement and elmo's first live use of the v2 promise-token path.
2. **Resolve per-project ids.** The health panel holds only `orgId` + `brandId`; fetch
   the brand's Semrush project ids (the `regions` from [filter-dimensions](#1-list-url-inspector-filter-dimensions),
   held as `semrush_project_id`) and issue one call per project. Omitting `projectId`
   yields a brand-wide number instead.
3. **Branded needs a second call** per project (`&tag=type:branded`) divided by the
   unfiltered total.
4. **Re-base the intent tile.** `IntentCoverageTile` / `intentCoverageMath.ts` still
   encode the legacy 6-value LLMO taxonomy; point them at the 5-value Semrush set above
   so the bands line up with `primary_intent` (this aligns the tile with the rest of the
   serenity surface).

### Errors

| Status | error | When |
|---|---|---|
| `400` | `invalidRequest` | `brandId` is not a UUID |
| `403` | `forbidden` | Caller has no access to the organisation |
| `404` | `notFound` | Organisation or brand not found |
| `404` | `subWorkspaceRequired` | Brand has no Semrush sub-workspace (flat mode / org workspace) — nothing to query |
| `409` | `workspaceMisconfigured` | Brand sub-workspace pointer equals the org parent workspace (bad backfill) |

### Underlying Element

| Element | UUID | Shape |
|---|---|---|
| `PROMPTS` | `406ba6e0-0de2-475e-80d9-42fab8616032` | `table` — one row per prompt (`{ prompt, prompt_topic, primary_intent, volume }`) |

### What it returns

`count` (number of matching prompts) plus the `prompts` array. Semrush field names are passed through unchanged; each row means:

| Field | Meaning |
|---|---|
| `prompt` | The prompt text — the question a user asked the LLM |
| `prompt_topic` | The topic the prompt belongs to. Assigned by a Semrush-developed model that groups together prompts which ask similar things and receive similar replies. **Not a tag** — a derived grouping, one topic per prompt |
| `primary_intent` | The primary intent **of the `prompt_topic`** (a property of the topic, not the individual prompt). The field the intent-coverage metric groups on |
| `volume` | Estimated number of times per month a user asked the LLM a question about this topic. A per-topic estimate, so prompts sharing a topic carry the same volume |

### Response example

```json
{
  "count": 2,
  "prompts": [
    { "prompt": "can i make ai influencer for free", "prompt_topic": "AI Instagram Influencers", "primary_intent": "informational", "volume": 2119 },
    { "prompt": "What is the best AI free image generator?", "prompt_topic": "AI Image Generators", "primary_intent": "informational", "volume": 997 }
  ]
}
```

> **Project ids stay explicit:** within the resolved sub-workspace, the endpoint filters by Semrush project id via `CBF_project` (the UI already holds these as `semrush_project_id` from the filter-dimensions `regions`). Omitting `projectId` returns every prompt in the brand's sub-workspace.

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
