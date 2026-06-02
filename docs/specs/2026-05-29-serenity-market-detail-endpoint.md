# Serenity: market detail endpoint exposing `semrushProjectId`

Follow-up to `2026-05-28-prompts-api-abstraction.md` (LLMO-5190). Decided 2026-05-29.

## 1. Problem

LLMO-5190 hid Semrush as an implementation detail: it dropped `semrushProjectId`
from the public `/serenity/*` DTOs and resolves the upstream project server-side
from the `(brandId, geoTargetId, languageCode)` slice. The `/serenity/markets`
list now returns only `{ brandId, geoTargetId, languageCode, createdAt, updatedAt }`.

That removed the value a UI consumer used to compute:

```js
// before LLMO-5190 — serenityProjectsApi.projects[].semrushProjectId
const semrushProjectId = projects.find(
  (p) => p.semrushLocationId === selectedMarketId && p.language === selectedLanguage,
)?.semrushProjectId;
```

The embedded **Semrush AIO renderer MFE** needs the upstream project id to mount
the dashboard for the selected market. With the new surface there is no way for
the client to obtain it. This use case (embedding Semrush's own widget) was not
covered by LLMO-5190, which assumed the elmo Prompts Management page only needs
list/CRUD — not a Semrush-rendered dashboard.

## 2. Options considered

**A — re-add `semrushProjectId` as a field on the `/serenity/markets` list item.**
Minimal code, no extra round trip, exact analog of the old `.find().semrushProjectId`.
But it reverses LLMO-5190 on the **most-used** surface: every `/markets` consumer
sees the id, any consumer can silently couple to it, and removing it later is a
breaking change to the list contract.

**B — dedicated single-resource detail endpoint** that returns the slice plus the
resolved `semrushProjectId`. One explicit, named place where the id crosses the
boundary; the list stays provider-free; only the MFE bridge calls it; deprecating
or swapping the provider touches one route. Costs one keyed DB lookup per market
selection (negligible — the list is already fetched and the result is trivially
client-cacheable).

## 3. Decision — Option B

`GET /v2/orgs/:spaceCatId/brands/:brandId/serenity/markets/:geoTargetId/:languageCode`

- `200` → `SerenityMarketDetail` = `SerenityMarket` + `semrushProjectId` (string).
- `404` `marketNotFound` when the slice has no row. Unlike the list (where an
  absent slice is an empty success), addressing one specific missing resource is
  a hard 404 — mirrors `handleListPrompts` / `handleUpdatePrompt`.
- `400` on a malformed slice (`geoTargetId` not a positive integer; `languageCode`
  not `^[a-z]{2,3}(-[a-z]{2,4})?$`). Same strict `/^\d+$/` path-segment guard as
  `deleteMarket` so `2840abc` cannot resolve the legit `(2840, en)` slice.
- IMS-only auth (`requireImsBearer`), capability `organization:read`.
- Reuses the existing `v2-serenity-market-by-slice` path object (it already
  declares the `:geoTargetId/:languageCode` params and the `DELETE` operation).

Long-run rationale: B preserves the abstraction the team just paid to build,
contains the one unavoidable Semrush leak (embedding Semrush's own UI genuinely
requires Semrush's id) to a single deliberate route, and keeps the heavily-used
list contract clean. The only thing A wins — the round trip — is trivial.

## 4. Deviation from the abstraction spec

LLMO-5190 §1/§2 state `semrushProjectId` is a routing detail to be dropped from
public DTOs. This endpoint intentionally re-exposes it. The deviation is scoped
and justified: it surfaces the id at exactly one named detail route, for the one
consumer that embeds Semrush's renderer, while the list surface stays
provider-free. Recorded in the abstraction spec §11 with this rationale; agreed
with the spec owner (Rainer Friederich).

The field keeps the honest name `semrushProjectId` — the value genuinely is
Semrush's project UUID. This follows the same naming rule LLMO-5190 applied to
`semrushPromptId`: hide details that are ours (project routing), honestly name
values that are not (the provider's UUID).

## 5. Changes

| File | Change |
|------|--------|
| `src/support/serenity/handlers/markets.js` | add `handleGetMarket(dataAccess, brandId, geoTargetId, languageCode)` — validate slice, `findBySlice`, 404 `marketNotFound` if absent, else return detail incl. `getSemrushProjectId()` |
| `src/controllers/serenity.js` | add `getMarket` (IMS gate + `authorize` + strict-digit geo guard), export it |
| `src/routes/index.js` | register `GET .../serenity/markets/:geoTargetId/:languageCode` → `getMarket` |
| `src/routes/required-capabilities.js` | gate it at `organization:read` |
| `docs/openapi/serenity-api.yaml` | add `get:` (`operationId: getSerenityMarket`) to `v2-serenity-market-by-slice` |
| `docs/openapi/schemas.yaml` | add `SerenityMarketDetail` (`allOf` SerenityMarket + `semrushProjectId`) |
| `docs/specs/2026-05-28-prompts-api-abstraction.md` | §11 deviation note |
| tests | unit (`markets.test.js`), controller (`serenity.test.js`), OpenAPI contract fixture (`serenity-api.test.js`), IT auth-gate (`it/shared/tests/serenity.js`) |

`api.yaml` already references `v2-serenity-market-by-slice`, so the new `get:` is
picked up without an `api.yaml` change.

## 6. Validation gates

Each must pass before the next:

1. `npm run lint`
2. `npm run docs:lint` — OpenAPI valid (new schema + operation).
3. `npm run docs:build` — bundled spec regenerates.
4. `npx mocha test/support/serenity/handlers/markets.test.js` — handler unit tests.
5. `npx mocha test/controllers/serenity.test.js` — controller tests.
6. `npx mocha test/openapi-contract/serenity-api.test.js` — operationId↔fixture
   parity + `getSerenityMarket` 200 body conforms to `SerenityMarketDetail`.
7. `npm run build` — Lambda bundle gate (no new assets/FS reads expected).
8. IT (`test/it/postgres/serenity.test.js`) — runs in CI; locally needs Docker + ECR.

## 7. Follow-up (out of scope here)

- **project-elmo-ui**: add a `getSerenityMarket(orgId, brandId, geoTargetId, languageCode)`
  client + hook and feed `semrushProjectId` to the renderer MFE. Lives on the
  elmo serenity feature branch (PR #1815), not on `main`. This is the consumer
  Kirill needs; it is a separate PR in a separate repo.
