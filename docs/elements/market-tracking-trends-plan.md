# Implementation Plan — `GET .../brand-presence/market-tracking-trends`

> Status: **Implemented.**
> Endpoint: `GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/market-tracking-trends`
>
> Companion reference: [`semrush-elements-api-reference.md`](./semrush-elements-api-reference.md)
> — read that first for the shared conventions (transport, definitions, service layer)
> this plan builds on.

Powers the **Competitor Comparison** chart (`CitationsMentionsTrendChart`) on the
`brand-presence-sr-ui` dashboard: a weekly time series of mentions and citations for the
tracked brand and each of its competitors.

> **Verified against the Brand Presence MFE.** The element mapping below was derived by
> observing the request/response shapes of the Semrush micro-frontend's "Market Tracking"
> chart (Mentions and Citations tabs) — not inferred from the migration wiki. The wiki's
> documented citations trend element (`b81af644`, domain-level) is **not** what this chart
> uses. All brand names and metrics in the examples below are synthetic.

---

## 0. API Reference

`GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/market-tracking-trends`

Auth: same as every other Elements-wrapper route (`authorizeOrg` — IMS/promise-token, org +
brand access, resolves the brand's Semrush workspace). FACS `llmo/can_view`; S2S `brand:read`.

### Query parameters (all optional)

| Param | Aliases | Default | Description |
|---|---|---|---|
| `startDate` | `start_date` | 28 days before today | Range start, `YYYY-MM-DD`. 400 if not a valid calendar date. |
| `endDate` | `end_date` | today | Range end, `YYYY-MM-DD`. 400 if invalid, or before `startDate`. |
| `model` | `platform` | `search-gpt` (via `resolveElementModel`) | AI model/platform filter. Unrecognized values fall back to the default. |
| `regionCode` | `region_code`, `region` | — | One region+language code (e.g. `US`) → a single Semrush `projectId` via `resolveRegionProjectId`; 404 if it matches no market. `all`/absent → aggregate across **every** project the brand owns. |
| `siteId` | `site_id` | — | Cross-check only: must resolve (via `getBrandBySite`) to the same brand as `:brandId`; 400 otherwise. Does not itself narrow the query. |

**Both or neither** (mirrors the URL-inspector handlers): if only one of `startDate`/`endDate`
is supplied, both are ignored and the full 28-day default range is used as a unit — a
half-supplied bound never pairs with the default's other half. The resolved span is capped at
**`MAX_RANGE_DAYS = 366`** (400 otherwise) to bound upstream fan-out.

Bucketing is **weekly only** for now (`auto_bucketing: "week"` is hardcoded). Day/month is a
trivial future extension via a `granularity` param.

### Response shape

```json
{
  "weeklyTrends": [
    {
      "week": "2026-07-05",
      "weekNumber": 27,
      "year": 2026,
      "mentions": 900,
      "citations": 5000,
      "competitors": [
        { "name": "Rival One", "mentions": 150, "citations": 300 },
        { "name": "Rival Two", "mentions": 120, "citations": 250 }
      ]
    }
  ]
}
```

- One entry per ISO week (`week` = the element's week-start `x`, `YYYY-MM-DD`), sorted ascending.
- `mentions`/`citations` are the **tracked brand's** own totals that week; each competitor's
  totals sit in `competitors[]` (sorted by mentions desc).
- Visibility is intentionally **not** included (out of scope for this chart).

### Error responses

| Status | `error` token | Cause |
|---|---|---|
| 400 | `invalidRequest` | `brandId` not a UUID; malformed/out-of-order dates; `siteId` doesn't belong to `:brandId` |
| 401 | `authenticationRequired` | Missing/invalid bearer (non-IMS caller with no `x-promise-token`) |
| 403 | `forbidden` | Caller lacks org access |
| 404 | `notFound` | Org/brand not found; brand has no Semrush workspace; `regionCode` matches no market |
| 502 | `elementsUpstreamError` | Non-auth Semrush upstream failure |
| 500 | `internalServerError` | Unexpected error |

---

## 1. Element mapping (confirmed against live payloads)

Both elements are `type: "line"`, `auto_bucketing: "week"`, with **no brand filter** — that is
what makes the response include one series per tracked competitor (competitors are tracked as
Semrush benchmarks). Each `blocks.lines[]` row is `{ legend, x, y__mentions, … }` where
`legend` is the brand/competitor **name** and `x` is the ISO week-start date.

| Chart metric | Element | Constant | Project filter col | Value field |
|---|---|---|---|---|
| Mentions | `b5281393-ee98-4c38-9ed5-3437b0c450c3` | `TRENDS_MV` (pre-existing) | `CBF_project` (singular) | `y__mentions` |
| Citations | `2e5a6f4e-f287-4951-a7e2-7e29981c86d8` | `MARKET_CITATIONS_TREND` (new) | `CBF_projects` (**plural**) | `y__mentions` |

> ⚠️ **`y__mentions` means different things per element.** In `TRENDS_MV` it is the mention
> count; in `MARKET_CITATIONS_TREND` the *same key* carries the **citation** count (Semrush
> reuses the generic field name). The transform maps `TRENDS_MV.y__mentions → mentions` and
> `MARKET_CITATIONS_TREND.y__mentions → citations`. (The citations element also returns
> `y__prompts_with_mentions` and `y__visibility`, which power the MFE's sibling "Responses with
> Citations" / "Source Visibility" sub-tabs — unused here.)

### Confirmed request payload (both elements)

```json
{
  "auto_bucketing": "week",
  "filters": {
    "simple": { "start_date": "2026-06-16", "end_date": "2026-07-15" },
    "advanced": { "op": "and", "filters": [
      { "op": "or", "filters": [{ "op": "eq", "val": "search-gpt", "col": "CBF_model" }] },
      { "op": "or", "filters": [
        { "op": "eq", "val": "<projectId1>", "col": "CBF_project" },
        { "op": "eq", "val": "<projectId2>", "col": "CBF_project" }
      ] }
    ] }
  }
}
```

Citations differs only in the project column name (`CBF_projects`). Note: unlike the KPI/URL
elements, these trend elements take plain `start_date`/`end_date` in `simple` (not
`CBF_date__start`/`end`) and send **no** `comparison_data_formatting`.

---

## 2. Codebase changes

- **`src/support/elements/element-ids.js`** — new `MARKET_CITATIONS_TREND` constant.
- **`src/support/elements/definitions/market-tracking-trends.js`** (new) —
  `buildMarketMentionsTrendPayload` (`CBF_project`), `buildMarketCitationsTrendPayload`
  (`CBF_projects`), and `transformMarketTrackingTrends(mentionsRaw, citationsRaw, brandName)`
  which groups both `blocks.lines[]` by ISO week, splits the brand line
  (`legend === brandName`, case-insensitive) from competitor lines, and defaults a missing
  metric to 0. Exported from `definitions/index.js`.
- **`src/support/elements/elements-service.js`** — `getMarketTrackingTrends(workspaceId, {...})`
  fetches the two elements in parallel and returns `{ weeklyTrends }`. No per-week fan-out (the
  elements are already weekly-bucketed) and no per-competitor fan-out (`legend` carries them).
  `projectId` (single region) takes precedence over `projectIds` (aggregate all projects).
- **`src/controllers/elements.js`** — `getMarketTrackingTrends` handler (mirrors the URL
  Inspector handlers: `authorizeOrg`, `siteId` cross-check, optional-date validation with a
  28-day default via `defaultTrailingDateRange`, region→`projectId` resolution else all projects,
  `cachedOk`).
- **`src/routes/index.js`**, **`src/routes/facs-capabilities.js`** (`llmo/can_view`),
  **`src/routes/required-capabilities.js`** (`brand:read`) — route registration + classification.

No new element UUIDs beyond `MARKET_CITATIONS_TREND`; `brandId` is already a classified LLMO
FACS brand resource.

## 3. Tests

- `test/support/elements/definitions/market-tracking-trends.test.js` — payload builders
  (singular vs plural project col, no-projectIds branch, model fallback) + transform
  (brand/competitor split, week grouping, missing-metric → 0, case-insensitive brand match,
  malformed-line skipping).
- `test/support/elements/elements-service.test.js` — `getMarketTrackingTrends` (both element
  calls, merge, `projectId` precedence, error propagation).
- `test/controllers/elements.test.js` — auth reuse, date defaulting/validation, region
  resolution + 404, `siteId` cross-check, error mapping.
- `test/routes/index.test.js` — route registration.

## 4. Out of scope

UI wiring; Competitor Summary / Share of Voice / Sentiment endpoints; visibility; day/month
bucketing.
