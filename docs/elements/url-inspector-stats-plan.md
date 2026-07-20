# Implementation Plan — `GET .../brand-presence/url-inspector/stats`

> Status: **Implemented.**
> Endpoint: `GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/url-inspector/stats`
>
> Companion references: [`semrush-elements-api-reference.md`](./semrush-elements-api-reference.md)
> (shared transport/definitions/service conventions) and
> [`brand-presence-stats-plan.md`](./brand-presence-stats-plan.md) (this plan reuses
> its per-week fan-out pattern for the trends breakdown).
>
> Reference contract this mirrors: the Aurora/Postgres-backed
> `docs/llmo-brandalf-apis/url-inspector-stats-api.md` — same response shape
> (`{ stats, weeklyTrends }`), but this endpoint replaces the HLX/Postgres source
> with Semrush so the `url-inspector-sr` dashboard's 4 KPI cards (previously
> blurred, waiting on this endpoint — see `URLInspectorSRDashboard.tsx`'s
> `blurSections` comments) can un-blur.

---

## 0. API Reference

`GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/brand-presence/url-inspector/stats`

Auth: same as every other Elements-wrapper route (`authorizeOrg` — IMS/promise-token,
org + brand access, resolves the brand's Semrush sub-workspace).

### Path parameters

| Param | Required | Description |
|---|---|---|
| `spaceCatId` | Yes | SpaceCat organization UUID. |
| `brandId` | Yes | SpaceCat brand UUID (must be a valid UUID and belong to `spaceCatId`). |

### Query parameters

| Param | Aliases | Required | Description |
|---|---|---|---|
| `startDate` | `start_date` | **Yes** | Range start, `YYYY-MM-DD`. 400 if missing or not a valid calendar date. Required (not defaulted) — mirrors `listOwnedUrls`/`listCitedDomains`/`listDomainUrls`, not `getStats` (Brand Presence), which defaults. |
| `endDate` | `end_date` | **Yes** | Range end, `YYYY-MM-DD`. 400 if missing, invalid, or before `startDate`. Span capped at 366 days (mirrors `listOwnedUrls`/`listDomainUrls`). |
| `model` | `platform` | No | AI model/platform filter, e.g. `search-gpt`. Unrecognized values fall back to the default (`resolveElementModel`). |
| `siteId` | `site_id` | No | Must resolve (via `getBrandBySite`) to the same brand as `:brandId`; 400 otherwise. Cross-check only. |
| `region` | — | No | A single region code (e.g. `US`) → its one Semrush `projectId` via `resolveRegionProjectId`; 404 if unmatched. Omitted/`all` → aggregate across every project the brand owns (mirrors `listOwnedUrls`/`listDomainUrls`, not `getStats`'s `regionCode` naming). |
| `categoryId` | `category`, `category_id` | No | Category label → Semrush tag `category__<label>`, applied to both the Stats-per-URL and Prompts element calls. |

### Response shape

```json
{
  "stats": {
    "uniqueUrls": 187,
    "totalCitations": 964,
    "totalPromptsCited": 312,
    "totalPrompts": 1250
  },
  "weeklyTrends": [
    {
      "weekStart": "2026-06-24",
      "weekEnd": "2026-06-30",
      "uniqueUrls": 42,
      "totalCitations": 155,
      "totalPromptsCited": 48,
      "totalPrompts": 1250
    }
  ]
}
```

- `stats` covers the full requested `[startDate, endDate]` window.
- `weeklyTrends` is **always** returned (no `showTrends` flag — matches the Aurora
  reference contract, where trends are a first-class part of every stats card),
  capped to the **most recent 8 weeks** regardless of how wide the requested range
  is (see §2, reusing `splitDateRangeIntoWeeksBackward`'s default `maxWeeks`).
- Each `weeklyTrends` entry uses `weekStart`/`weekEnd` (the actual 7-day window
  boundary built backward from `endDate`), **not** an ISO-week label
  (`"YYYY-Www"`) — unlike the Aurora contract's `week` field. The 7-day windows
  here are not necessarily Monday-Sunday aligned, so attaching an ISO-week label
  would misrepresent the boundary. The frontend hook maps this to its own
  `weekStart`-keyed `TrendIndicator` shape (already used elsewhere in
  `URLInspectorSRDashboard.tsx`), so this is a non-issue for the one consumer.

### Error responses

| Status | `error` token | Cause |
|---|---|---|
| 400 | `invalidRequest` | `brandId` not a UUID; missing/malformed/out-of-order `startDate`/`endDate`; range > 366 days; `siteId` doesn't belong to `:brandId`'s brand |
| 401 | `authenticationRequired` | Missing/invalid `Authorization` bearer (non-IMS caller with no `x-promise-token`) |
| 403 | `forbidden` | Caller lacks access to the organization |
| 404 | `notFound` | Organization/brand not found; brand has no resolvable Semrush workspace; `region` doesn't match any market |
| 503 | `configurationError` | PostgREST client unavailable |
| 502 | `elementsUpstreamError` | Non-auth Semrush upstream failure (incl. timeout) |
| 500 | `internalServerError` | Unexpected error |

---

## 1. Goal

Give the `url-inspector-sr` dashboard's 4 blurred KPI cards (Unique Prompts With
Citations, Total Unique Prompts, Unique Cited URLs, Total Times Cited) a real
Semrush-backed data source, replacing the legacy HLX fetch
(`useURLs`/`processURLDataDual`) that currently feeds them while blurred.

---

## 2. Element mapping

No new element UUIDs — reuses two elements already wired for sibling URL
Inspector endpoints:

| Stats field | Element (constant) | Source |
|---|---|---|
| `uniqueUrls` | `STATS_PER_URL` (`9af5ed83`) | Same element as `getOwnedUrls`, fanned out per project (region), **without** the `URL_TRENDS` element (no per-URL trend needed here) — see `aggregateUrlInspectorStats` (`definitions/url-inspector-stats.js`). Distinct URL count across all queried projects, `domain_type='Owned'` only (client-side filter, same as `owned-urls.js`/`domain-urls.js`). |
| `totalCitations` | `STATS_PER_URL` | Sum of `citations` across the same deduped owned-URL set. |
| `totalPromptsCited` | `STATS_PER_URL` | Sum of `prompts_with_citation` across the same set. **Known gap, see §4.1.** |
| `totalPrompts` | `PROMPTS` (`406ba6e0`) | Single call (not per-project, not per-range) — `count` from `transformPromptsResponse`. **Known gap, see §4.2.** |

`weeklyTrends` reuses `STATS_PER_URL` once per week window (via
`splitDateRangeIntoWeeksBackward`, bounded concurrency
`STATS_TRENDS_WEEK_CONCURRENCY`, same as `getBrandPresenceStats`) for
`uniqueUrls`/`totalCitations`/`totalPromptsCited`; `totalPrompts` is NOT
re-fetched per week (see §4.2) — the same single value is repeated on every
`weeklyTrends` entry.

---

## 3. Codebase changes

### 3.1 `src/support/elements/definitions/url-inspector-stats.js` (new)

`aggregateUrlInspectorStats(projectResults)` — dedupes owned URLs across a
project (region) fan-out into `{ uniqueUrls, totalCitations, totalPromptsCited }`.
Same per-URL grouping logic as `transformOwnedUrlsResponse` (`owned-urls.js`)
minus the `URL_TRENDS` merge.

### 3.2 `src/support/elements/elements-service.js#getUrlInspectorStats` (new)

Fetches `PROMPTS` once (date-unscoped — see §4.2), fetches `STATS_PER_URL` per
project for the full range (`stats`), then once per week (capped at 8 weeks,
same pattern as `getBrandPresenceStats`) for `weeklyTrends`.

### 3.3 `src/controllers/elements.js#getUrlInspectorStats` (new)

Mirrors `listOwnedUrls`/`listDomainUrls`'s auth/date-validation/region-resolution
shape (required dates, 366-day cap, `siteId` cross-check, `region` → single
project or all-brand-projects fan-out) rather than `getStats`'s (Brand Presence)
shape (optional dates with a 28-day default, `regionCode` naming, 56-day cap) —
this endpoint is a *url-inspector* sibling, so it follows that family's
conventions.

### 3.4 Routing

- `src/routes/index.js` — new route entry.
- `src/routes/required-capabilities.js` — `brand:read` (matches every other
  `url-inspector/*` v2 route).
- `src/routes/facs-capabilities.js` — `llmo/can_view` (matches every other
  `url-inspector/*` v2 route). No new `:param`s introduced (`spaceCatId`/`brandId`
  are already classified), so no `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES`/
  `FACS_NON_RESOURCE_PARAMS` change needed.

### 3.5 Tests

- `test/support/elements/definitions/url-inspector-stats.test.js` (new) —
  `aggregateUrlInspectorStats` dedup/sum/filter behavior.
- `test/support/elements/elements-service.test.js` — added `getUrlInspectorStats`
  cases (single PROMPTS call reused across stats+trends, per-project fan-out,
  per-week trend fan-out capped at 8, error propagation).
- `test/controllers/elements.test.js` — added `getUrlInspectorStats` cases
  (date validation/required-ness, region resolution vs. aggregate fan-out,
  siteId cross-check, error propagation) mirroring `listOwnedUrls`/`getStats`.
- `test/routes/index.test.js` — added the new route key to
  `expectedDynamicRouteKeys`.

---

## 4. Known gaps (approximations, not exact matches to the Aurora contract)

### 4.1 — `totalPromptsCited` overcounts vs. Aurora's distinct-prompt semantics

The Aurora RPC (`rpc_url_inspector_total_prompts_cited`) counts **distinct**
prompts with ≥1 owned citation. Semrush's `Stats-per-URL` element only exposes
`prompts_with_citation` — a **per-URL count**, not prompt IDs — so summing it
across owned URLs (as `aggregateUrlInspectorStats` does) double-counts any
prompt that cites more than one owned URL. This is an **upper bound**, not an
exact distinct count. No Semrush element currently exposes a distinct
per-brand prompts-cited count; if Semrush adds one, `aggregateUrlInspectorStats`
should be revisited to use it instead of the per-URL sum.

**Decision (per product/eng direction): ship the approximation now** rather than
block the endpoint on a Semrush-side element that doesn't exist yet — flagged
here and in the code as a known, documented limitation rather than a silent
inaccuracy.

### 4.2 — `totalPrompts` is not date-scoped

The Aurora RPC scopes `totalPrompts` to prompts that are `status = 'active'`
**and ran within `[startDate, endDate]`**. Semrush's `PROMPTS` element
(`buildPromptsPayload`) has **no date filter at all** — it only supports
model/tags/project scoping. So `totalPrompts` here reflects the brand's
currently-configured active/tagged prompt count regardless of date range, not a
window-scoped count. Consequently every `weeklyTrends` entry repeats the exact
same `totalPrompts` value (fetched once, not per week) — there is no way to
produce a genuinely time-varying `totalPrompts` sparkline from Semrush today.

### 4.3 — `weeklyTrends` capped to the most recent 8 weeks

Unlike the Aurora endpoint (a single cheap grouped SQL query, so trends are
always returned for the full requested range), each Semrush trend week costs a
real fan-out of upstream calls. `splitDateRangeIntoWeeksBackward`'s default
`maxWeeks=8` (same cap `getBrandPresenceStats` uses) silently truncates a wider
request to its most recent 8 weeks of sparkline data — `stats` itself is
unaffected and always covers the full requested range.

---

## 5. Implementation status

1. ✅ `definitions/url-inspector-stats.js` + barrel export + unit tests.
2. ✅ `elements-service.js#getUrlInspectorStats` (per-range + per-week fan-out,
   single date-unscoped PROMPTS call) + unit tests.
3. ✅ `controllers/elements.js#getUrlInspectorStats` wired (date validation,
   region→projectId resolution, aggregate project-id fan-out, siteId
   cross-check) + unit tests.
4. ✅ Route registered in `routes/index.js` + `required-capabilities.js` +
   `facs-capabilities.js`; `test/routes/index.test.js` updated.
5. ✅ `npm test` / `npm run lint` pass with no regressions.
6. ⏳ **Not done — recommended before merging to prod:** manual verification
   against a real brand/subworkspace, in particular confirming the
   `totalPromptsCited` approximation's actual overcounting magnitude on a live
   brand (§4.1) so product can decide if it's acceptable to ship long-term.
7. Not done — no integration test coverage, same pre-existing gap as every
   other `ElementsController` endpoint (no Elements API vendor mock in the IT
   stack yet — see `brand-presence-stats-plan.md`'s "Known gap" section, which
   applies identically here).
