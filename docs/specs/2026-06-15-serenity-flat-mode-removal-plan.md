# Serenity: retiring "flat" mode (single-mode cleanup)

Status: planning (not started). Companion to
`2026-06-15-serenity-subworkspace-dual-mode-implementation-plan.md`.

## Why this exists

Serenity currently runs in **dual mode**. Every `/serenity/*` request resolves a
brand to one of two resolution paths (`src/support/serenity/workspace-resolver.js`,
`resolveBrandWorkspace`):

- **sub-workspace mode** — `brands.semrush_workspace_id` is set; the brand has
  its own Semrush sub-workspace and a slice → project is resolved from the live
  `listProjects` listing.
- **flat mode** — `brands.semrush_workspace_id` is NULL; operations run against
  the org's shared parent workspace (`organizations.semrush_workspace_id`) and a
  slice → project is resolved from the DB mapping table (`BrandSemrushProject`).

Flat mode is the pre-existing (transitional) path. Once every active Serenity
brand has its own sub-workspace, flat mode is dead weight and should be removed
so the codebase reflects a single way of working — with **no naming or comment
that hints two modes ever existed**.

> The ONLY behavioural difference between the modes is slice → project
> resolution (DB mapping vs live listing). Everything downstream is shared,
> project-keyed logic. That is what makes the removal almost entirely deletion +
> rename, not a rewrite.

## Precondition (do NOT start before this holds)

This is a forward-only retire, mirroring the V1→V2 retire pattern.

1. **Data backfill**: every brand that is active in Serenity has a non-NULL
   `brands.semrush_workspace_id`. Verify in prod:
   `SELECT count(*) FROM brands WHERE status='active' AND semrush_workspace_id IS NULL AND <is-a-serenity-brand>;` → must be 0.
2. **Prod signal**: no flat-mode resolutions are happening. Add a one-line
   `log.info('serenity resolve', { mode })` (temporary) and confirm Coralogix
   shows `mode=subworkspace` for 100% of `/serenity/*` traffic over a full
   weekly cycle before deleting the flat path.
3. `BrandSemrushProject` writes have stopped (no new flat markets created).

Gate: all three confirmed in prod. Until then, this plan stays unexecuted.

## What is flat-only, shared, or sub-workspace-only

Knowing which exports are shared is the whole game — deleting a shared core
breaks sub-workspace mode.

**Flat-only (DELETE):**
- `handlers/markets.js`: `handleListMarkets`, `handleGetMarket`,
  `handleCreateMarket`, `handleDeleteMarket`, `handleListTags`,
  `handleListModels`, `handleUpdateModels` (the thin flat wrappers — they take
  `dataAccess` + `semrushWorkspaceId` and resolve the project via the DB).
- `handlers/prompts.js`: `handleListPrompts`, `handleCreatePrompts`,
  `handleUpdatePrompt`, `handleBulkDeletePrompts` (flat wrappers).
- All `BrandSemrushProject` (DB slice→project mapping) reads in the above.
- `workspace-resolver.js`: the flat branch of `resolveBrandWorkspace` and the
  `mode` field itself.

**Shared, project-keyed cores (KEEP — move into the surviving handler files):**
- `markets.js`: `resolveLocation`, `resolveLanguageId`/`clearLanguageCache`,
  `listTagsForProject`, `listGlobalModelCatalog`, `listSliceModels`,
  `syncModelsForProject`, `invalidateTagCacheForProject`/`clearTagCache`,
  `defaultMarketName`.
- `prompts.js`: `buildPromptDto`, `normalizePromptInput`, `mapLimit`,
  `publishAffected`.

**Sub-workspace handlers (PROMOTE to be THE handlers):**
- `handlers/markets-subworkspace.js`, `handlers/prompts-subworkspace.js`,
  `subworkspace-projects.js` (the live-listing resolution).

**Still needed even after removal (do NOT delete):**
- `resolveWorkspaceId` (org parent workspace) — `ensureSubworkspace` needs the
  parent workspace id to CREATE a brand's sub-workspace on activate.
- `organizations.semrush_workspace_id` — the parent pool every sub-workspace is
  carved from.

## Removal steps (each step ends green: `npm test` + `npm run lint` + `npm run docs:lint`)

### Phase 1 — collapse the dispatch
- In `controllers/serenity.js`, delete the `auth.mode === 'subworkspace' ? … : …`
  ternary in all ~11 endpoints; call the (current) sub-workspace handler
  directly. Remove the flat-handler imports.
- `resolveBrandWorkspace` → return just the workspace id (drop `mode`). Rename it
  `resolveBrandSubworkspaceId` (or fold into the handlers) and have the
  controller 404 when it is null (no sub-workspace = not provisioned).
- Validation gate: controller tests still pass after deleting the "flat dispatch"
  assertions; every endpoint hits the listing-based resolution.

### Phase 2 — delete flat handlers, keep the cores
- Move the shared cores out of `markets.js`/`prompts.js` (or keep those files but
  delete only the flat wrapper functions). Delete the flat wrappers and their
  tests. Delete the `BrandSemrushProject` resolution code paths.
- Validation gate: no remaining import of any `handle*` flat wrapper; grep for
  `BrandSemrushProject` in `src/support/serenity` returns nothing.

### Phase 3 — naming cleanup (no trace of two modes)
This is the explicit requirement: **after removal nothing may indicate there were
ever two ways to do this.**
- Drop the `-subworkspace` suffix from the handler files: rename
  `markets-subworkspace.js` → `markets.js`, `prompts-subworkspace.js` →
  `prompts.js` (after the old flat files are gone), `subworkspace-projects.js` →
  `projects.js`.
- Drop the `Subworkspace` suffix from every handler function name
  (`handleListMarketsSubworkspace` → `handleListMarkets`, etc.).
- Remove every "flat mode", "sub-workspace mode", "dual-mode", "mode" word from
  comments, JSDoc, the OpenAPI specs, and the elmo types. A market just *has* a
  status; prompts/markets just resolve to a project. No qualifier.
- Validation gate: `grep -rin "flat\|dual-mode\|\bmode\b\|subworkspace" src/support/serenity src/controllers/serenity.js docs/openapi/serenity-api.yaml` returns only incidental matches (e.g. unrelated `mode` in other contexts), no two-mode language.

### Phase 4 — elmo (project-elmo-ui)
- `src/types/serenity.ts`: `SerenityMarket.status` and `semrushProjectId` become
  **required** (always present); delete the "child/flat mode only / undefined in
  flat mode" caveats. `SerenityMarketStatus` loses its "surfaced only in …" doc.
- `useSerenityMarkets.ts`: the poll-while-publishing path is now the only path;
  drop any "legacy markets carry no status" comments.
- Validation gate: `npx tsc --noEmit` + `npm run build` green; status badge
  renders for every market.

### Phase 5 — data-service follow-ups (separate PR, mysticat-data-service)
- Retire the `BrandSemrushProject` table (the flat DB mapping) once no code reads
  it — migration to drop it, after a deprecation window.
- Consider making `brands.semrush_workspace_id` effectively required for active
  Serenity brands (a partial CHECK or app-level invariant), since NULL no longer
  has a valid "flat" meaning for a provisioned brand. NULL then means only
  "not provisioned in Serenity".

## Out of scope / explicitly NOT removed
- The fail-closed `deleteWorkspace` guard and the never-delete decommission
  behaviour — unchanged; deletion of a sub-workspace stays forbidden.
- `organizations.semrush_workspace_id` and `resolveWorkspaceId` — still the
  parent pool used to mint sub-workspaces.

## Rollback
Until Phase 5's DB drop, every step is code-only and revertible by reverting the
PR. The `BrandSemrushProject` table is the point of no return — keep it (unused)
for at least one deprecation window after Phases 1–4 ship.
