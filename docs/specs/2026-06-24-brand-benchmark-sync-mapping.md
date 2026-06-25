# Brand → Semrush benchmark sync: field mapping, lossy points, and decisions

Status: design / decision record (2026-06-24)
Area: serenity dual-mode brand provisioning (`src/support/serenity/*`, `src/support/brands-storage.js`, `src/controllers/brands.js`, `src/controllers/serenity.js`)

## Purpose

A brand on our side is the single source of truth for a set of attributes that
must fan out to **every** Semrush project in the brand's sub-workspace
(one project per region+language market). This records the field mapping, the
points where the transform is lossy, and the decisions taken on each.

## Mapping

| Brand attribute | Our store (child table) | Semrush target | Mapper |
|---|---|---|---|
| aliases `{name, regions}` | `brand_aliases(alias, regions)` | own-brand benchmark `brand_aliases[]` **+** project `settings.ai.brand_names` | `getBrandAliasNames`, `dedupeNames` |
| website URLs | `brand_urls(url)` | own-brand benchmark `brand_urls` `type:website` | `collectBrandUrlEntries` |
| social URLs `{url, regions}` | `brand_social_accounts(url, regions)` | own-brand benchmark `brand_urls` `type:social` | `collectBrandUrlEntries` |
| earned `{name, url, regions}` | `brand_earned_sources(url, regions)` | own-brand benchmark `brand_urls` `type:earned` | `collectBrandUrlEntries` |
| competitors `{name, url, aliases, regions}` | `competitors(name, url, aliases, regions)` | **separate** competitor benchmark `{brand_name, domain, brand_aliases}` | `collectCompetitorBenchmarks` |
| name | `brands.name` | project `brand_name_display` / benchmark `brand_name` | provisioning |
| vertical, description, brand_context, mention_sentiment_guidance | `brands.*` | — (no Semrush target) | — |

Notes:
- "Additional URLs" on a project = the own-brand benchmark's `brand_urls`
  (website/social/earned), NOT a separate project field. Competitors are their
  own benchmark rows (`main_brand:false`), not additional URLs.
- The sync reads from the **child tables**, not the legacy array columns on the
  `brands` row (`owned_urls[]`, `social[]`, `earned_sources[]`). Confirmed
  2026-06-24: those array columns are unused; the child tables are the sole
  source of truth.
- Upstream update endpoints are confirmed live (prod, 2026-06-24):
  `PATCH …/projects/{pid}` (`brand_names`) and
  `PUT …/projects/{pid}/ai_models/benchmarks/{bid}` (`brand_aliases`).

## Lossy points and decisions

1. **Competitor `aliases[]` — FIX (sync it).** Today `mapDbBrandToV2`
   (`brands-storage.js`, competitor map) and `getBrandCompetitors` drop the
   `competitors.aliases` column, and `collectCompetitorBenchmarks` emits only
   `{brand_name, domain}`. A competitor benchmark supports `brand_aliases`, so
   propagate them. Requires create + **update** (existing benchmark whose domain
   is unchanged but whose aliases changed needs a PUT — competitor sync is
   currently create+targeted-delete only).

2. **Alias `regions[]` — FIX (honor, clamped to markets).** `getBrandAliasNames`
   ignores `brand_aliases.regions` and applies every alias to every market.
   Honor regions via the existing `regionApplies(regions, market)` helper, so an
   alias only lands on projects whose market it lists (region-less / `ww` = all).
   Regions that match no existing project/market are no-ops (clamped to our
   markets by construction). Apply on BOTH project `brand_names` and benchmark
   `brand_aliases`, and on BOTH the create-market path and the edit re-sync.

3. **Competitor URL → domain — ACCEPT (document).** `normalizeBenchmarkDomain`
   reduces the URL to a bare host (no scheme/path/`www.`); URLs differing only by
   path dedupe. Inherent to Semrush's domain-keyed benchmark model. No change.

4. **earned-source `name` — ACCEPT (document).** `brand_earned_sources.name` is
   not carried onto the benchmark `brand_url` entry (`{url, type}` only). No
   upstream field for it. No change.

5. **Owned-URL `type` granularity — ACCEPT.** Owned URLs all sync as
   `type:website`. No change.

6. **Non-HTTPS URLs — ACCEPT.** `toEntry` requires `https://` (Semrush rejects
   http); http URLs are silently skipped. No change.

7. **`rejected_brand_aliases` — HANDLE.** The benchmark response carries
   `rejected_brand_aliases[]`: Semrush can reject aliases we send, so an alias can
   look "synced" on our side yet not be tracked. After each benchmark
   create/update, capture `rejected_brand_aliases`, log it with brand/alias
   context, and surface it to the caller (e.g. include in the sync result so the
   PATCH /brands response / UI can warn which aliases were rejected). Applies to
   own-brand aliases AND competitor aliases.

8. **Destructive full-reconcile is BY DESIGN — Semrush UI locked.** The brand-URL
   re-sync (and the upcoming alias re-sync) deletes any upstream value not in the
   brand's desired set. This is safe because the Semrush sub-workspace/project UI
   is **locked (read-only)** for these mapped surfaces — the brand is the sole
   source of truth and there are no Semrush-side edits to preserve. No
   reverse-capture of Semrush-side additions is built. Confirmed 2026-06-24: the
   Semrush-side lock will be enforced upstream.

## Implementation inventory

- `brands-storage.js`
  - `mapDbBrandToV2`: add `aliases: c.aliases || []` to the competitor shape (1).
  - `getBrandCompetitors`: select + return `aliases` (1) — feeds the create-market
    path in `serenity.js`.
  - `getBrandAliasNames`: return `{alias, regions}` (or a region-aware variant) (2).
- `src/support/serenity/competitor-benchmarks.js`
  - `collectCompetitorBenchmarks`: include `brand_aliases` in output + create body (1).
  - `syncCompetitorBenchmarksForProject`: detect alias drift on an existing
    competitor benchmark and PUT-update it; capture `rejected_brand_aliases` (1, 7).
- New `src/support/serenity/brand-aliases.js` (mirrors `brand-urls.js`)
  - `syncBrandAliasesAcrossMarkets`: per project, region-filter aliases (2), set
    project `brand_names` (PATCH) + benchmark `brand_aliases` (PUT), capture
    `rejected_brand_aliases` (7), republish best-effort.
- `src/support/serenity/rest-transport.js`
  - wire `updateProject` (PATCH `projects-patch-project`) and `updateBenchmark`
    (PUT `ai-update-benchmark`).
- `src/controllers/brands.js`
  - add `aliasesTouched`; extend the edit re-sync condition; call the alias sync;
    same hard-fail-on-edit semantics; thread `rejected_brand_aliases` into the
    response (2, 7).
- Create-market path (`handlers/markets-subworkspace.js` / `serenity.js`)
  - region-filter aliases when seeding a new project's `brand_names` (2).
- Tests: unit for the new sync + competitor-alias mapping; brands edit-path case;
  IT; OpenAPI note if the PATCH /brands response gains a rejected-aliases field.

## Status (2026-06-24)

DONE (unit-tested, lint-clean):
- Transport `updateProject` (PATCH) + `updateBenchmark` (PUT) — `rest-transport.js`.
- Shared alias helpers — `serenity/aliases.js` (`dedupeAliases`, `sameAliasSet`,
  `rejectedAliasesFrom`).
- Competitor `aliases` carried through `mapDbBrandToV2` + `getBrandCompetitors`;
  competitor benchmark sync now create/update(drift)/delete with `brand_aliases`
  and captures `rejected_brand_aliases` — `competitor-benchmarks.js` (1, 7).
- Brand alias rollout on edit — new `serenity/brand-aliases.js`
  (`syncBrandAliasesAcrossMarkets`, `collectAliasNames`): region-clamped per market
  (2), PATCH `brand_names` + PUT benchmark `brand_aliases`, captures rejects (7),
  hard-fail-on-edit. Wired into `brands.js` `updateBrandForOrg` via `aliasesTouched`;
  rejected aliases surfaced on the response as `semrushRejectedAliases`.

DONE — Phase 3 (create-time region honoring):
- `getBrandAliasNames` → `getBrandAliases` returns `{name, regions}[]`; `serenity.js`
  (createMarket + activation) and `brands.js` create pass the region-aware shape;
  `markets-subworkspace.js` region-clamps to the new market via `collectAliasNames`
  (feeds project `brand_names`, prompt `brandNames`, own-brand benchmark).
  `collectAliasNames` tolerates bare strings (region-less) for the create payload.

DONE — write-path + select fixes (caught by the IT, missed by mocked unit tests):
- `syncCompetitors` now persists competitor `aliases` (was dropping them — the whole
  competitor-alias feature was a no-op end-to-end without this).
- `BRAND_SELECT` competitors embed now reads `aliases` (was `name, url, regions`).

DONE — OpenAPI: `V2BrandCompetitor.aliases` added; `V2SemrushRejectedAlias` +
`V2BrandUpdateResponse` schemas added; PATCH /brands 200 → `V2BrandUpdateResponse`.

DONE — IT: `test/it/shared/tests/brands.js` round-trips alias regions + competitor
aliases through create / GET / PATCH on a flat-mode brand (no Semrush trigger);
passes against the postgres harness.

Coverage: changed files at 100% line/statement (codecov/patch). New files
`aliases.js` 100% branch; `brand-aliases.js` ~93% branch (>90% gate). Remaining
follow-up: none required; optional deeper branch coverage on `brand-aliases.js`.
