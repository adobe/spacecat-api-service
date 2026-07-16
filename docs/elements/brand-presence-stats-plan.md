# Implementation Plan — `GET .../brand-presence/stats`

> Status: **Implemented.**
> Endpoint: `GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/stats`
>
> Companion reference: [`semrush-elements-api-reference.md`](./semrush-elements-api-reference.md)
> — read that first for the shared conventions (transport, definitions, service layer)
> this plan builds on.
>
> **Post-implementation correction:** while wiring this up, we discovered the actual
> reference contract already lives in this codebase —
> `src/controllers/llmo/llmo-brand-presence.js#createBrandPresenceStatsHandler`
> (Postgres-RPC-backed) — not an external "mysticat" endpoint as originally assumed.
> Its real response contract differs from what §1's original draft assumed in two ways,
> both reflected in the final implementation below:
> - **No `has_data_for_last_week` field at all.** Dropped entirely.
> - **Each `trends[]` week returns all 4 stats fields** (`total_executions`,
>   `average_visibility_score`, `total_mentions`, `total_citations`), not just
>   mentions+visibility. Since no Semrush element returns all 4 pre-bucketed by week,
>   the implementation re-runs the same 4 KPI element calls once per week window
>   instead of using `TRENDS_MV` — see §3.2 (updated).

---

## 0. API Reference

`GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/stats`

Auth: same as every other Elements-wrapper route (`authorizeOrg` — IMS/promise-token,
org + brand access, resolves the brand's Semrush workspace).

### Path parameters

| Param | Required | Description |
|---|---|---|
| `spaceCatId` | Yes | SpaceCat organization UUID. |
| `brandId` | Yes | SpaceCat brand UUID (must be a valid UUID and belong to `spaceCatId`). |

### Query parameters

| Param | Aliases | Required | Default | Description |
|---|---|---|---|---|
| `startDate` | `start_date` | No | 28 days before today | Range start, `YYYY-MM-DD`. 400 if not a valid calendar date. |
| `endDate` | `end_date` | No | today | Range end, `YYYY-MM-DD`. 400 if not a valid calendar date, or if before `startDate`. |
| `model` | `platform` | No | `search-gpt` (via `resolveElementModel`) | AI model/platform filter, e.g. `search-gpt`, `gpt-5`, `perplexity`, `microsoft-copilot`. Unrecognized values fall back to the default. |
| `siteId` | `site_id` | No | — | Must resolve (via `getBrandBySite`) to the same brand as `:brandId`; 400 otherwise. Used only as a cross-check today — it does not itself narrow the Semrush query. |
| `regionCode` | `region_code`, `region` | No | — | One region+language code (e.g. `US`). Resolves to a single Semrush `projectId` via `resolveRegionProjectId`; 404 if it doesn't match any of the brand's markets. When omitted, the response aggregates across **every** project the brand owns. |
| `showTrends` | `show_trends` | No | `false` | `true`/`1` (case-insensitive string or boolean/number) → include the weekly `trends[]` array, split backward from `endDate` into up to 8 7-day weeks. |

**Accepted but not yet implemented** (present in the reference Postgres-backed contract,
no confirmed Semrush Elements equivalent yet — see §2's gap notes): `categoryId(s)`,
`topicIds`, `origin`, `userIntent`, `promptBranding`. These are currently no-ops.

### Response shape

```json
{
  "stats": {
    "total_executions": 19528,
    "total_mentions": 14635,
    "average_visibility_score": 48.77,
    "total_citations": 158903
  },
  "trends": [
    {
      "startDate": "2026-07-01",
      "endDate": "2026-07-07",
      "data": {
        "stats": {
          "total_executions": 9764,
          "total_mentions": 7318,
          "average_visibility_score": 47.2,
          "total_citations": 79451
        }
      }
    },
    {
      "startDate": "2026-07-08",
      "endDate": "2026-07-14",
      "data": {
        "stats": {
          "total_executions": 9764,
          "total_mentions": 7317,
          "average_visibility_score": 50.34,
          "total_citations": 79452
        }
      }
    }
  ]
}
```

- `stats` is always present and covers the full `[startDate, endDate]` range.
- `trends` is present **only** when `showTrends` is truthy; each entry's `data.stats`
  has the identical 4-field shape as the top-level `stats`, scoped to that one week.
- No `has_data_for_last_week` field (see §4.2 — dropped, it doesn't exist in the real
  reference contract this endpoint mirrors).

### Error responses

| Status | `error` token | Cause |
|---|---|---|
| 400 | `invalidRequest` | `brandId` not a UUID; malformed/out-of-order `startDate`/`endDate`; `siteId` doesn't belong to `:brandId`'s brand |
| 401 | `authenticationRequired` | Missing/invalid `Authorization` bearer (non-IMS caller with no `x-promise-token`) |
| 403 | `forbidden` | Caller lacks access to the organization |
| 404 | `notFound` | Organization/brand not found; brand has no resolvable Semrush workspace; `regionCode` doesn't match any market |
| 503 | `configurationError` | PostgREST client unavailable |
| 502 | `elementsUpstreamError` | Non-auth Semrush upstream failure (incl. timeout) |
| 500 | `internalServerError` | Unexpected error |

---

## 1. Goal

Replace the scaffolded placeholder in `getStats` with real aggregation over 4 Semrush
Elements API calls per date range, matching
`llmo-brand-presence.js#createBrandPresenceStatsHandler`'s response contract:

```json
{
  "stats": {
    "total_executions": 19528,
    "average_visibility_score": 48.77,
    "total_mentions": 14635,
    "total_citations": 158903
  },
  "trends": [
    {
      "startDate": "2026-06-28",
      "endDate": "2026-07-04",
      "data": { "stats": { "total_executions": 4386, "average_visibility_score": 51.83, "total_mentions": 4511, "total_citations": 39000 } }
    }
  ]
}
```

`trends` is included only when `showTrends=true`/`show_trends=1`, split backward from
`endDate` into (up to 8) 7-day weeks — see §3.2.

---

## 2. Element mapping (confirmed against live sample payloads)

All 5 element UUIDs already exist in `src/support/elements/element-ids.js` — **no new
constants needed**: `TOTAL_EXECUTIONS`, `MENTIONS`, `VISIBILITY`, `CITATIONS_KPI`, `TRENDS_MV`.

| Stats field | Element (constant) | Response envelope | Extraction |
|---|---|---|---|
| `total_executions` | `TOTAL_EXECUTIONS` (`a4defa1a`) | `simpleNumeric` | `blocks.firstSectionMainValue[0].firstSectionMainValue` |
| `total_mentions` | `MENTIONS` (`e1a6811b`) | `simpleNumeric` | `blocks.firstSectionMainValue[0].firstSectionMainValue` |
| `average_visibility_score` | `VISIBILITY` (`2724878e`) | `simpleNumeric` | `blocks.firstSectionMainValue[0].firstSectionMainValue` **× 100** (see §4.3 — value comes back as a 0–1 fraction, e.g. `0.4877`) |
| `total_citations` | `CITATIONS_KPI` (`588054fe`) | `simpleNumeric` | `blocks.firstSectionMainValue[0].firstSectionMainValue` |
| `trends[]` (mentions + visibility per week) | `TRENDS_MV` (`b5281393`) | `line` | `blocks.lines[]` filtered to `legend === brand.name`, one entry per ISO week `x` |

> **Note on `comparison_start_date`/`comparison_end_date`:** the captured Mentions/
> Visibility/Citations sample payloads include these fields (Semrush's built-in
> period-over-period comparison), and the sample responses correspondingly include
> `blocks.firstSectionSecondaryValue[]` (`previous`/`current`). The `/stats` response
> contract has no "compared to previous period" field, so **our payload builders
> should omit `comparison_start_date`/`comparison_end_date`/`comparison_data_formatting`
> entirely** and the transforms should only read `blocks.firstSectionMainValue[0]
> .firstSectionMainValue` — `firstSectionSecondaryValue` is unused. If Semrush requires
> `comparison_data_formatting` to be present even with no comparison dates, verify the
> element tolerates its absence during implementation; fall back to sending it with no
> comparison dates if not.

### Confirmed request payload shapes

**Mentions (`MENTIONS`)** — `advanced` filter `CBF_ws_brand` (eq) + `CBF_model` (eq) +
optional `CBF_project` (singular, `or` block, one `eq` per project UUID):
```json
{
  "comparison_data_formatting": "union",
  "filters": {
    "simple": { "start_date": "...", "end_date": "...", "comparison_start_date": "...", "comparison_end_date": "..." },
    "advanced": { "op": "and", "filters": [
      { "op": "eq", "val": "<brand>", "col": "CBF_ws_brand" },
      { "op": "eq", "val": "<model>", "col": "CBF_model" },
      { "op": "or", "filters": [{ "op": "eq", "val": "<projectId>", "col": "CBF_project" }] }
    ] }
  }
}
```

**Visibility (`VISIBILITY`)** — same `simple` shape; `advanced` differs slightly: `CBF_model`
is *also* wrapped in its own `or` block (not a bare `eq` like Mentions):
```json
"advanced": { "op": "and", "filters": [
  { "op": "eq", "val": "<brand>", "col": "CBF_ws_brand" },
  { "op": "or", "filters": [{ "op": "eq", "val": "<model>", "col": "CBF_model" }] },
  { "op": "or", "filters": [
    { "op": "eq", "val": "<projectId1>", "col": "CBF_project" },
    { "op": "eq", "val": "<projectId2>", "col": "CBF_project" }
  ] }
] }
```

**Citations (`CITATIONS_KPI`)** — **gotcha, differs from Mentions/Visibility in two ways**:
uses `CBF_brand` (not `CBF_ws_brand`) and `CBF_projects` (**plural** column name, not
`CBF_project`):
```json
"advanced": { "op": "and", "filters": [
  { "op": "eq", "val": "<brand>", "col": "CBF_brand" },
  { "op": "eq", "val": "<model>", "col": "CBF_model" },
  { "op": "or", "filters": [
    { "op": "eq", "val": "<projectId1>", "col": "CBF_projects" },
    { "op": "eq", "val": "<projectId2>", "col": "CBF_projects" }
  ] }
] }
```

**Total Executions (`TOTAL_EXECUTIONS`)** — no `advanced.CBF_project*` filter at all;
project scoping is a **top-level `project_id`** (singular value, not an array):
```json
{
  "project_id": "<projectId>",
  "comparison_data_formatting": "union",
  "filters": {
    "simple": { "start_date": "...", "end_date": "..." },
    "advanced": { "op": "and", "filters": [{ "op": "eq", "val": "<model>", "col": "CBF_model" }] }
  }
}
```
Per the team's clarification (§4.1, resolved): **omitting `project_id` returns the
total automatically combined across all projects in the subworkspace** — this is
exactly what's needed for the aggregate "all regions" view, so no fan-out/summing is
required.

**Trends — Mentions & Visibility (`TRENDS_MV`)** — `auto_bucketing: "week"`, no brand
filter at all (returns one line-series per brand/competitor found in the subworkspace):
```json
{
  "auto_bucketing": "week",
  "filters": {
    "simple": { "start_date": "...", "end_date": "..." },
    "advanced": { "op": "and", "filters": [
      { "op": "eq", "val": "<model>", "col": "CBF_model" },
      { "op": "or", "filters": [{ "op": "eq", "val": "<projectId>", "col": "CBF_project" }] }
    ] }
  }
}
```
Response `blocks.lines[]`: one row per `(legend, x)` = `(brand/competitor name, ISO week
start)`, with `y__mentions`, `y__visibility` (0–1 fraction), `y__sov`, `y__position`,
`y__prompts_mentioned`, `y__total_num_prompts`. **Must filter to `legend === brand.name`**
(case-insensitive) to isolate this brand's own series — the subworkspace also returns
tracked competitors.

---

## 3. Codebase changes (following the conventions in `semrush-elements-api-reference.md`)

No new element UUIDs. New/changed files:

### 3.1 `src/support/elements/definitions/brand-presence-stats.js` (implemented)

One pair of `build*`/`transform*` functions per element usage. `TRENDS_MV` is **not**
used — see §3.2 for why:

```js
export function transformStatsSimpleNumericResponse(raw) { ... } // shared extractor, -> number

export function buildStatsTotalExecutionsPayload({ model, platform, startDate, endDate, projectId }) { ... }
export const transformStatsTotalExecutionsResponse = transformStatsSimpleNumericResponse;

// brandName is always included (CBF_ws_brand) — see Open Decision 4.4 (resolved: keep).
export function buildStatsMentionsPayload({ model, platform, startDate, endDate, projectIds, brandName }) { ... }
export const transformStatsMentionsResponse = transformStatsSimpleNumericResponse;

// brandName is always included (CBF_ws_brand) — see Open Decision 4.4 (resolved: keep).
export function buildStatsVisibilityPayload({ model, platform, startDate, endDate, projectIds, brandName }) { ... }
export function transformStatsVisibilityResponse(raw) { ... } // -> number, ×100 applied here

// brandName is always included (CBF_brand, NOT CBF_ws_brand — see §2) — see Open
// Decision 4.4 (resolved: keep).
export function buildStatsCitationsPayload({ model, platform, startDate, endDate, projectIds, brandName }) { ... }
export const transformStatsCitationsResponse = transformStatsSimpleNumericResponse;
```

Each `build*Payload` accepts `projectIds` as an array — the **common, single-region
case** (a user has picked one region+language on the Brand Presence page) is simply
`projectIds: [oneProjectId]`; the aggregate "all regions" case passes every project id
the brand owns. Mentions/Visibility/Trends OR them under `CBF_project` (singular);
Citations ORs them under `CBF_projects` (plural) — see §2. A single-element `or` block
degrades gracefully to "exactly one project", so no special-casing is needed in the
payload builders themselves for the single-region path.

Export all six from `definitions/index.js` (barrel).

### 3.2 `src/support/elements/elements-service.js` — `getBrandPresenceStats` (implemented)

**Design change from the original draft:** the real contract needs all 4 stats fields
per trend week (§ intro), and no Semrush element returns all 4 pre-bucketed by week —
`TRENDS_MV` only has weekly mentions+visibility. So instead of a dedicated trends
element, `getBrandPresenceStats` factors the 4-element fetch into a
`fetchStatsForRange(rangeStart, rangeEnd)` helper and calls it once for the full
range (`stats`), then once per week (`trends`, only when `showTrends` is true) —
reusing `src/support/elements/week-utils.js#splitDateRangeIntoWeeksBackward` (added
in this implementation, copied verbatim from
`llmo-brand-presence.js#splitDateRangeIntoWeeksBackward` per the existing
support/elements convention of not importing controller code) for identical week
boundaries (backward from `endDate`, max 8 weeks). Per-week fan-out is bounded via
`mapWithConcurrency` (`STATS_TRENDS_WEEK_CONCURRENCY`).

```js
async getBrandPresenceStats(workspaceId, {
  model, platform, startDate, endDate, projectId, projectIds, brandName, showTrends,
}) {
  // A single resolved region (projectId) is the common path — every element scopes
  // to that one project. The aggregate "all regions" path (projectId absent,
  // projectIds = every project the brand owns) needs no fan-out either: Mentions/
  // Visibility/Citations OR all project ids into one call, and Total Executions
  // omits project_id entirely (resolved decision — see §4.1).
  const resolvedProjectIds = projectId ? [projectId] : projectIds;

  const fetchStatsForRange = async (rangeStart, rangeEnd) => {
    const [totalExec, mentions, visibility, citations] = await Promise.all([
      transport.fetchElement(workspaceId, ELEMENT_IDS.TOTAL_EXECUTIONS,
        buildStatsTotalExecutionsPayload({ model, platform, startDate: rangeStart, endDate: rangeEnd, projectId })),
      transport.fetchElement(workspaceId, ELEMENT_IDS.MENTIONS,
        buildStatsMentionsPayload({
          model, platform, startDate: rangeStart, endDate: rangeEnd, projectIds: resolvedProjectIds, brandName,
        })),
      transport.fetchElement(workspaceId, ELEMENT_IDS.VISIBILITY,
        buildStatsVisibilityPayload({
          model, platform, startDate: rangeStart, endDate: rangeEnd, projectIds: resolvedProjectIds, brandName,
        })),
      transport.fetchElement(workspaceId, ELEMENT_IDS.CITATIONS_KPI,
        buildStatsCitationsPayload({
          model, platform, startDate: rangeStart, endDate: rangeEnd, projectIds: resolvedProjectIds, brandName,
        })),
    ]);
    return {
      total_executions: transformStatsTotalExecutionsResponse(totalExec),
      total_mentions: transformStatsMentionsResponse(mentions),
      average_visibility_score: transformStatsVisibilityResponse(visibility),
      total_citations: transformStatsCitationsResponse(citations),
    };
  };

  const response = { stats: await fetchStatsForRange(startDate, endDate) };

  if (showTrends) {
    const weeks = splitDateRangeIntoWeeksBackward(startDate, endDate);
    const weekStats = await mapWithConcurrency(
      weeks, STATS_TRENDS_WEEK_CONCURRENCY,
      (week) => fetchStatsForRange(week.startDate, week.endDate),
    );
    response.trends = weeks.map((week, i) => ({
      startDate: week.startDate, endDate: week.endDate, data: { stats: weekStats[i] },
    }));
  }

  return response;
},
```

**Cost tradeoff (accepted per the "fetch all 4 per week" decision):** with
`showTrends=true` this is up to `4 + (8 weeks × 4) = 36` upstream Semrush calls per
`/stats` request. Noted as a future optimization target if Semrush ever exposes a
single weekly-bucketed element covering all 4 metrics; out of scope for now.

### 3.3 `src/controllers/elements.js#getStats` — wire the real call

Region+language scoping is a **first-class, optional** filter here — the Brand
Presence page lets a user pick one region+language combination, which maps 1:1 to a
single Semrush `projectId` within the brand's subworkspace (per product requirement).
So `getBrandPresenceStats` takes an **optional single `projectId`**, not a list:

Replace the zeroed `response` object with:
1. If `siteId`/`regionCode` is present, resolve it to a single `projectId` (reuse
   `resolveRegionProjectId`, already used by `listCitedDomains`/`listOwnedUrls`) and
   pass just that one id through — this is the common case and needs exactly one call
   per element, no fan-out.
2. If no region/site filter is given (aggregate "all regions" view), resolve **all**
   of the brand's project ids via `fetchBrandSemrushProjects` (already imported/used by
   `listUrlInspectorFilterDimensions`/`listOwnedUrls`) and fan out (see Open Decision
   4.1 for how each element handles multi-project aggregation).
3. Call `service.getBrandPresenceStats(auth.workspaceId, { ...query, projectId, projectIds, brandName: auth.brand.name, showTrends: parseShowTrends(query) })` —
   `projectId` set when step 1 resolved a single region, `projectIds` set when step 2
   fanned out across all of the brand's regions. Exactly one of the two is populated.
4. Return via `cachedOk(result)` (matches the existing pattern for this handler).

### 3.4 Tests (implemented)

- `test/support/elements/definitions/brand-presence-stats.test.js` (new) — payload
  shape + response transform unit tests per element.
- `test/support/elements/week-utils.test.js` (new) — `addDaysToDate`/
  `splitDateRangeIntoWeeksBackward` (previously untested in this layer).
- `test/support/elements/elements-service.test.js` — added `getBrandPresenceStats`
  cases (parallel calls, project_id omission in aggregate mode, per-week trend
  fan-out, error propagation).
- `test/controllers/elements.test.js` — replaced the zeroed-stats `getStats` describe
  block with stub-driven assertions (region resolution, date validation, param
  pass-through, error propagation) mirroring `listWeeks`/`listCitedDomains`.

---

## 4. Decisions (all resolved)

### 4.1 — How to compute `total_executions` when a brand has multiple projects (regions) — **RESOLVED: omit `project_id`**

**Decision: when no single region is selected (aggregate "all regions" view), omit
`project_id` from the `TOTAL_EXECUTIONS` payload entirely** — per team confirmation,
Semrush automatically combines data across all projects in the subworkspace's response
when `project_id` is not passed. No fan-out/sum needed; this is a single call in both
the single-region path (`project_id` set) and the aggregate path (`project_id` omitted).
`getTotalExecutions`/`buildStatsTotalExecutionsPayload` (§3.1/§3.2) simplify to: pass
`project_id` only when `projectId` was resolved from a selected region, otherwise omit
the field.

### 4.2 — `has_data_for_last_week` — **MOOT: field does not exist in the real contract**

Dropped — see the "Post-implementation correction" note at the top of this doc. The
real reference handler (`llmo-brand-presence.js#createBrandPresenceStatsHandler`)
never returns this field; it was carried over incorrectly from the wiki's UI
description. The implementation does not compute or return it.

### 4.3 — `average_visibility_score` units — **RESOLVED: multiply by 100**

**Decision: multiply the Visibility element's raw value by 100** in
`transformStatsVisibilityResponse` — the element returns a 0–1 fraction (e.g.
`0.4877`), and the contract expects a 0–100 percentage.

### 4.4 — `CBF_ws_brand`/`CBF_brand` filters: keep or drop? — **RESOLVED: keep**

**Decision: keep the `CBF_ws_brand`/`CBF_brand` filter** (using `auth.brand.name`) on
Mentions/Visibility/Citations, matching the captured samples. Unlike every other
brand-scoped handler in this file (`listWeeks`, `listCitedDomains`, etc.), which
deliberately **omit** brand-name filters and rely on `auth.workspaceId` (the resolved
sub-workspace) to already scope the call to one brand, `/stats` needs the explicit
filter — the captured `TRENDS_MV` sample response includes competitor brands too, so
sub-workspace scoping alone is not sufficient here.
`buildStatsMentionsPayload`/`buildStatsVisibilityPayload`/`buildStatsCitationsPayload`
(§3.1) should accept `brandName` and always include the `CBF_ws_brand`
(Mentions/Visibility) or `CBF_brand` (Citations) filter.

### 4.5 — Citations/executions trends via per-week fan-out — **SUPERSEDED, see §3.2**

Originally flagged as "not needed today" on the assumption trends only needed
mentions+visibility (`TRENDS_MV`). Once the real contract (all 4 stats per week) was
found, this became moot: the implementation reuses the same 4 KPI element calls
per-week instead of `TRENDS_MV`, so citations and executions are trivially included in
every trend week — no per-brand citations trend element was ever needed.

---

## 5. Implementation status

All steps complete:

1. ✅ `definitions/brand-presence-stats.js` + barrel export + unit tests.
2. ✅ `week-utils.js#addDaysToDate`/`splitDateRangeIntoWeeksBackward` (new) + unit tests.
3. ✅ `elements-service.js#getBrandPresenceStats` (per-range + per-week fan-out) + unit tests.
4. ✅ `controllers/elements.js#getStats` wired to the real service call
   (date validation/defaulting, region→projectId resolution, aggregate project-id
   fan-out), existing test suite replaced with stub-driven assertions.
5. ✅ `npm test` / `npm run lint` pass with no regressions (coverage for
   `elements.js` improved from the scaffold's 98.64%/92.53% to 99.76%/94.04%
   stmts/branches).
6. ⏳ **Not done — recommended before merging to prod:** manual verification against
   a real brand/subworkspace. In particular, confirm `TOTAL_EXECUTIONS` omitting
   `project_id` truly scopes to just this brand's subworkspace projects and not a
   wider pool (§4.1), and spot-check the `average_visibility_score` ×100 conversion
   against the current UI's expected units (§4.3).
7. Not done — `categoryId(s)`/`topicIds`/`origin` query params are accepted but are
   currently no-ops (documented in the `getStats` docstring) pending a confirmed
   Semrush filter equivalent — see the wiki gap analysis from the initial research.
8. ✅ `MAX_RANGE_DAYS = 56` (8 weeks) cap on the effective `[startDate, endDate]`
   range, matching the Brand Presence date picker's max selectable range and the
   `TRENDS_MAX_WEEKS` trends fan-out cap — mirrors the `MAX_RANGE_DAYS` pattern in
   `listOwnedUrls`/`listDomainUrls` (366 there; 56 here since this endpoint has no
   equivalent "unbounded historical browse" use case).

### Known gap: no integration test coverage (blocked on infra, not in scope here)

**Status: not done, and not currently possible without new test infrastructure.**
`test/it/` has zero IT coverage for this endpoint — and in fact zero for *any*
`ElementsController` endpoint (`url-inspector/filter-dimensions`, `weeks`, `prompts`,
`cited-domains`, `owned-urls`, `domain-urls`). This is a pre-existing gap across the
whole file, not something introduced by this change.

**Root cause:** `test/it/postgres/docker-compose.yml` only ships two Semrush vendor
mocks — `project-engine-mock` and `user-manager-mock` — Counterfact mocks of the
classic Semrush Project Engine API (`@adobe/spacecat-shared-project-engine-client`:
markets/tags/prompts/models) used by `SerenityController`. There is **no mock for the
Elements API** (`POST .../products/ai/elements/{elementId}/data`) that
`ElementsController` (and this endpoint) depends on — confirmed by inspecting the
Project Engine client package source, which has zero references to "elements". A true
happy-path 200 IT test isn't achievable today without standing up a new Elements API
mock container (or extending an existing one).

**Follow-up needed** (tracked as a separate infra effort, not part of this PR): add an
Elements-API-compatible vendor mock to the IT stack, then backfill IT coverage for the
whole `ElementsController` surface (not just `/stats`) in one pass.
