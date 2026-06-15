# Implementation Plan — Serenity Semrush Sub‑Workspace Provisioning (Phase 1, dual‑mode)

> **Implementation deviations (post-review):** the following items described
> below were **dropped during implementation as unwired/unused** and are NOT in
> the shipped code: the `rest-transport.js` methods `removeWorkspaceMember` and
> `getProject`, and the error predicates `isAllocationFailure`,
> `isWorkspaceNotReady`, `isWorkspaceDrift` (+ their `ERROR_CODES`). Member
> removal at decommission stays deferred (parent admins inherit access). A
> hard invariant was **added** that is not in the original plan: a brand's
> sub-workspace must never equal the org parent workspace (enforced at the
> controller `authorize()` chokepoint and in `ensureSubworkspace` /
> `decommissionBrandWorkspace`).
>
> **Hardening pass (post-review, gap audit):** five further safety/correctness
> gaps were closed. (1) The sub-workspace **title now embeds the brand id**
> (`"<name> [<uuid>]"`) so ambiguous-create recovery cannot adopt a *same-named*
> brand's workspace; adoption additionally verifies the candidate is
> **project-empty** before adopting. (2) `ensureSubworkspace` takes an optional
> `reloadPointer` and, on the create path, **re-reads the brand pointer before
> persisting** — if a concurrent activation already won, it releases its own
> freshly-created workspace's allocation and adopts the winner (residual race
> noted; a fully race-free fix needs a conditional DB write). (3) The
> duplicate-slice `orderKey` **no longer falls back to the mutable `updated_at`**
> (id-stable tie-break; updated_at would flip the canonical project on edit).
> (4) `activate` returns **207 whenever any market failed** (not 200), and
> **counts `409 sliceExists` as live** so a full idempotent re-activate reports
> 200/active instead of 207/pending. (5) The `decommissionBrandWorkspace`
> linked-sub-workspace child guard is **gated behind
> `SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD` (default off)** until the
> `GET …/family` leaf-direction semantics are live-verified — an always-on guard
> would falsely 409 every deactivate if `family(leaf)` returns siblings. The
> parent-equality guard remains always-on.

**Status:** Plan · 2026-06-15
**Implements:** `adobe/serenity-docs` PR #12 → `docs/discovery/brand-semrush-provisioning-v2-phase1-sync.md` (cited as *design §N*) and `…-v2-phase1-implementation.md`.
**Scope decisions (confirmed with requester 2026-06-15):**

1. **Baseline = current `main`.** The in‑flight PRs the design assumes as prerequisites (api-service 2513 cohort gate + `markets[]` DTO, 2584 defer‑publish + finalize + publish‑status) are **NOT** treated as blockers and are **NOT** re‑implemented here. We build dual‑mode on the serenity surface that exists today. Onboarding/finalize integration (design flow 1) is therefore explicitly deferred (see §8 Out of scope) because it has no landing point on `main`.
2. **elmo UI** changes are built **on top of PR 1868's branch** (`feat/semrush-proxy-ims-prod`) in a **separate successor branch** — not on `main`, not on this worktree's branch.
3. **Local development points at the REAL Semrush dev gateway** (no local Semrush fake). The dev **parent workspace** is `bb0f4e1c-8bb1-402e-88f2-f68618ea7397`.
4. **Execution model = local‑first.** Implement every step on per‑repo feature branches, bring up the **complete local stack**, and validate the whole feature end‑to‑end locally. **PRs are created only at the end, once everything works** — there is no gated PR‑per‑step merge sequence. The step breakdown below is the build order and the eventual PR boundaries, not a merge gate.

**Typed‑clients note (unchanged from design):** dedicated typed project‑engine / sub‑workspace clients are out of scope. Every new upstream call lands in the existing hand‑rolled `src/support/serenity/rest-transport.js` as a thin URL+verb+classification wrapper so the later swap is mechanical.

---

## 1. The dual‑mode backbone

One dispatch predicate, computed once at the controller edge and passed down — never re‑derived inside handlers:

```
resolveBrandWorkspace(ctx, spaceCatOrgId, brandId) →
  { mode: 'legacy', workspaceId: <org parent ws> }   // brands.semrush_workspace_id NULL / absent / 'null'-string
  { mode: 'child',  workspaceId: <brand child ws> }  // brands.semrush_workspace_id set
```

- **Legacy mode** = today's `main` behaviour, **frozen**: resolves the **org parent** workspace (`Organization.getSemrushWorkspaceId()` via `workspace-resolver.js`), reads/writes the `BrandSemrushProject` postgres mapping, keeps the current create/delete/floor semantics. No new features land here.
- **Child mode** = *design* behaviour: resolves the **brand child** workspace, enumerates markets live from Semrush (`listProjects`, no DB mapping), runs workspace lifecycle (create / re‑grant / never‑delete decommission), no floor check.
- **Switch = data, not a flag.** Setting `brands.semrush_workspace_id` flips a brand to child mode; clearing it rolls back to legacy (which still serves from the untouched flat `BrandSemrushProject` rows). No new runtime feature flag.
- **One freeze exception:** the `handleUpdateModels` "publish‑after‑mutation" fix (Step 5) applies to **both** modes — model edits stage in the upstream draft layer regardless of workspace topology, so the silent‑inert bug is mode‑independent.

Grounding note: today `src/controllers/serenity.js#authorize()` resolves the **org** workspace and the brand UUID, then passes a single `semrushWorkspaceId` into every handler. Dual‑mode changes that one resolution point to produce `{ mode, workspaceId }`; handlers branch on `mode`.

---

## 2. Verified current state (baseline on this branch)

Confirmed by reading the code, not the design's inventory:

- **`rest-transport.js`** exposes 11 methods, all project/catalog scoped, base prefix `API_PREFIX = '/enterprise/projects/api'`, IMS‑bearer passthrough via `buildHeaders`, `SerenityTransportError(status, message, body)`, 15 s timeout. **No workspace‑lifecycle, no `listProjects`/`getProject`/`getInitStatus`.**
- **`workspace-resolver.js`** resolves **org → parent** workspace only, TTL cache (5 min pos / 30 s neg, 1024 cap). **No `'null'`-string guard.** No brand‑level resolution.
- **`handlers/markets.js`** — `handleListMarkets`/`handleGetMarket` are **pure `BrandSemrushProject` DB reads**; `handleCreateMarket` does create→publish→DB‑row with best‑effort orphan cleanup; `handleDeleteMarket` does findBySlice→upstream delete (404‑as‑success)→`row.remove()` with a floor‑free delete already (no last‑market guard exists today — the design's "legacy keeps its floor check" does not match `main`; see §5 note). `handleUpdateModels` **never republishes** (the bug). Slice key = `(brandId, geoTargetId, languageCode)`; `geoTargetId = 2000 + ISO‑3166 numeric` via `resolveLocation`.
- **`errors.js`** — only `isUpstreamGone` (SerenityTransportError && 404) and `ERROR_CODES = { MARKET_NOT_FOUND }`.
- **spacecat-shared-data-access** — `BrandSemrushProject` postgres entity exists (the pattern to mirror); `Organization.getSemrushWorkspaceId()` exists; **no `Brand` entity**.
- **mysticat-data-service** — `brands` table has **no** `semrush_workspace_id` column (it exists on `organizations`).
- **project-elmo-ui** — current checkout has only the read‑side SR AI‑Visibility client; the serenity markets/prompts client (PR 1868) lives on `feat/semrush-proxy-ims-prod`.

---

## 3. Work breakdown — build order and eventual PR boundaries

**Execution is local‑first (scope decision §intro.4):** implement the steps in dependency order on per‑repo feature branches, validate the whole thing against the local stack (§4), and **open the PRs only after the feature works end‑to‑end locally.** Each step's "Gate" is the **local acceptance check** you run before moving on — not a merge gate.

**Branching:** one feature branch name across all four repos, e.g. `feat/serenity-subworkspace-dual-mode`, each cut from its repo's `origin/main`. Cross‑repo dependency (api‑service → the new `Brand` entity in spacecat‑shared) is satisfied locally via `npm link` (§4.6) so the package does **not** need to be released before validating; the spacecat‑shared release happens as part of opening its PR.

**Build order:** **0 → 1 → 2 → 3 → 4/5 → 6**, then **7 (migration) / 8 (retire)** after merge. elmo (Step 4‑elmo) is built off the 1868 branch in parallel.

**PR set created at the end (one per repo):**
- `mysticat-data-service` — Step 0
- `spacecat-shared` — Step 1
- `spacecat-api-service` — Steps 2–6 (single PR, or split 2–5 / 6 if review size demands)
- `project-elmo-ui` — Step 4‑elmo (off the `feat/semrush-proxy-ims-prod` branch)

### Step 0 — mysticat-data-service: `brands.semrush_workspace_id` migration

**Repo:** `mysticat-data-service` · **Release:** `feat:` (minor)

- New dbmate migration `db/migrations/<ts>_brands_add_semrush_workspace_id.sql`:
  ```sql
  -- migrate:up
  SET lock_timeout = '5s';
  SET statement_timeout = '120s';

  ALTER TABLE brands ADD COLUMN semrush_workspace_id TEXT;
  COMMENT ON COLUMN brands.semrush_workspace_id IS
    'Brand → Semrush child workspace. NULL = never activated (legacy/flat mode); '
    'set = child workspace exists, kept across deactivation — never deleted. '
    'See serenity-docs brand-semrush-provisioning-v2-phase1-sync.md §6.';
  NOTIFY pgrst, 'reload schema';

  -- migrate:down
  ALTER TABLE brands DROP COLUMN IF EXISTS semrush_workspace_id;
  ```
- **No `UNIQUE`** (unlike the `organizations` column): a child workspace id is unique per brand by construction, but adding a unique index now would block the migration's recovery path (clear‑and‑re‑activate could transiently collide). Resolution is by PK lookup, so no index is needed.
- The lock‑timeout header is **mandatory** for `ALTER TABLE` (SITES‑44731, enforced by `scripts/review_migration.py check_lock_timeout`) — the older `organizations` migration omitted it; do not repeat that.
- Update `docs/llmo-database-schema.md` (`brands` section) **in the same PR**.
- Regenerate clients: `make generate-clients` (needs running PostgREST).

**Gate 0:** `make lint` (sqlfluff clean) · `make test` · dbmate round‑trip `migrate → rollback → migrate` · schema‑doc diff reviewed. **Also file the IDOPS promise‑definition ticket now** (phase‑2 long‑lead, design §9) — tracked, not blocking.

### Step 1 — spacecat-shared-data-access: minimal `Brand` entity

**Repo:** `spacecat-shared` (`packages/spacecat-shared-data-access`) · **Release:** `feat:` (minor)

- Add the 4‑file entity `src/models/brand/{brand.model.js, brand.collection.js, brand.schema.js, index.js}` mirroring `brand-semrush-project`. Minimal attributes: `brandId` (PK), `status`, `semrushWorkspaceId` (+ `name` if free). Generate `getSemrushWorkspaceId()/setSemrushWorkspaceId()` and `getStatus()/setStatus()`. `camelToSnake` covers all names (no `postgrestField` overrides needed).
- Register in `src/models/base/entity.registry.js` (one import pair + one `registerEntity(BrandSchema, BrandCollection)`); export from `src/models/index.js`; hand‑write `src/models/brand/index.d.ts`.
- **Do NOT** flip `BrandSemrushProject.brandId` to `.addReference('belongs_to', 'Brand')` yet — that entity is on the retirement path (Step 9). Leave its documented workaround in place.

**Gate 1:** unit tests (100% lines/statements, 97% branch threshold — exercise every validator) · `npm run test:it` against local PostgREST · semver release published · api-service dependency bump merged.

### Step 2 — spacecat-api-service: transport additions (no behaviour change)

**Repo:** `spacecat-api-service` · **File:** `src/support/serenity/rest-transport.js`

Add thin wrappers (all under `API_PREFIX`, all via the existing `request()` helper):

| Method | Verb · Upstream path | Notes |
|---|---|---|
| `createChildWorkspace(parentWsId, title, resources)` | POST `…/v2/workspaces/{parent}/child` | no `X-Upload-Receipt`; `resources.ai` non‑zero **mandatory** (design §6) |
| `getWorkspaceStatus(wsId)` | GET `…/v1/workspaces/{id}/status` | poll until `created` |
| `listWorkspaceFamily(parentWsId)` | GET `…/v1/workspaces/{id}/family` | ambiguous‑create adoption |
| `transferWorkspaceResources(wsId, payload)` | POST `…/v1/workspaces/{id}/resources/transfer` | grant **and** release; payload shape pinned by Gate‑A smoke |
| `removeWorkspaceMember(wsId, memberId)` | DELETE `…/v1/workspaces/{id}/members` | decommission, best‑effort |
| `deleteWorkspace(wsId)` | DELETE `…/v1/workspaces/{id}` | **test cleanup only** — guard comment; production flows never call it |
| `listProjects(wsId)` | GET `…/v1/workspaces/{id}/projects` | v1 **default view** (draft‑faithful) |
| `getProject(wsId, projectId)` | GET `…/v1/workspaces/{id}/projects/{id}` | v1 by‑id read |
| `getInitStatus(wsId, projectId)` | GET `…/v1/workspaces/{id}/projects/{id}/aio/init_status` | detail‑read enrichment only |

Extend **`errors.js`** with normative classification (design §6) and new `ERROR_CODES`:
- `405` + `text/html` body on publish → **permanent allocation failure** (`allocationFailure`) — never retried as transient.
- `500` on project ops right after workspace create → **`not ready` transient** (`workspaceNotReady`) — wait for `created`.
- `403` on a brand's own workspace → **out‑of‑band‑deletion drift** (`workspaceDrift`) — alert; never an expected state.
Add predicates (`isAllocationFailure`, `isWorkspaceNotReady`, `isWorkspaceDrift`) alongside `isUpstreamGone`, keeping the strict `instanceof SerenityTransportError` shape. Note: classifying the 405 requires inspecting `error.body` being a string (HTML), which `parseBody` already preserves for non‑JSON.

**Gate 2 (= design Gate A):** unit tests per method incl. every classification branch · **net‑zero live smoke** against the dev **parent `bb0f4e1c-8bb1-402e-88f2-f68618ea7397`**, env‑flag‑gated (same pattern as other live‑gated tests, never default CI): create child `{ai:{projects:1,prompts:50}}` → poll `created` → create draft → add model (`model_id`) → tagged prompts → publish → `publish_status: live` → v1 list shows the slice faithfully → **decommission round‑trip**: delete project → release allocation via `resources/transfer` (pin the payload + confirm the parent pool grows back) → re‑grant → fresh publish succeeds → `deleteWorkspace` (cleanup) → reads 403. **The release→re‑grant→republish round‑trip is the contract this design newly depends on — pin it here before any dependent step.**

### Step 3 — spacecat-api-service: brand resolution + `ensureChildWorkspace`

**Files:** `src/support/serenity/workspace-resolver.js`, `src/controllers/serenity.js`, new `src/support/serenity/workspace-lifecycle.js`

1. **Resolver:** add `resolveBrandWorkspace(ctx, spaceCatOrgId, brandId)` returning `{ mode, workspaceId }`. Brand‑level TTL cache mirroring the org cache (incl. negative TTL). Reads `dataAccess.Brand.findById(brandId).getSemrushWorkspaceId()`; treats absent/empty as legacy mode. (No `'null'`-string coercion guard — per requester, the historical `'null'`-string rows are already cleaned up and out of scope here.)
2. **`ensureChildWorkspace(ctx, brand, marketCount)`** (new lifecycle module):
   - no ws → `createChildWorkspace(parentWsId, brand.title, { ai: { projects: marketCount + 2, prompts: 500 * (marketCount + 2) } })` (sizing default is a placeholder, design §12) → poll `getWorkspaceStatus` until `created` → persist `brands.semrush_workspace_id` **after** `created`.
   - ws set but de‑resourced (decommissioned) → `transferWorkspaceResources` re‑grant, same sizing.
   - **Ambiguous create** (timeout): `listWorkspaceFamily` by exact title, adopt a `created` + project‑empty match; **multiple matches → fail with alert**, never guess (design §6).
3. **Controller:** `authorize()` now produces `{ mode, workspaceId }` and passes it down (replacing the single `semrushWorkspaceId` arg). Handlers receive the resolution object.

**Gate 3:** unit suite — legacy‑vs‑child resolution, create‑vs‑re‑grant branch, family‑list adoption, multi‑match alert, cache (positive/negative TTL, eviction).

### Step 4 — spacecat-api-service: dual‑mode reads

**File:** `handlers/markets.js` (+ `handlers/prompts.js` read paths)

- `handleListMarkets`: legacy unchanged (DB read). **Child mode** = one `listProjects` (v1 default view) → map each project to its slice (`geoTargetId` from `location`, `languageCode` from language) + a `status` mapped **1:1 from `publish_status`** (`draft`/`publishing`/`publish_failed`/`live`/`live_with_unpublished_updates`, design §3). No DB read.
- `handleGetMarket`: child mode = listing match → resolved `semrushProjectId` + `status` + `initialized` (one `getInitStatus`, detail only).
- **Duplicate‑slice deterministic read:** >1 project on a slice → **oldest `created_at` wins** + error‑level alert (design §7).
- `prompts.js`/`tags`/`models` read paths: child mode resolves the project by slice **from the listing** instead of `findBySlice`.

**Gate 4 (= design Gate B):** unit + IT · OpenAPI updated (`status`/`initialized`/`semrushProjectId` **additive** only) · **parity harness** asserting the listing‑backed `GET /serenity/markets`/detail carry the exact PR‑1868 DTO field‑for‑field (`{items:[{brandId, geoTargetId, languageCode, createdAt?, updatedAt?}]}`, timestamps from the project) · duplicate‑slice oldest‑wins test.

### Step 4‑elmo — project-elmo-ui successor PR (parallel, off the 1868 branch)

**Repo:** `project-elmo-ui` · **Branch:** new branch **based on `feat/semrush-proxy-ims-prod`** (PR 1868), superseding 1868. Per requester: keep 1868's slice‑keyed client/DTOs; add only the new surface.

- Markets list surfaces `status` (badge/chip for the five values; `draft` is a normal visible state, `publish_failed` needs a user‑visible signal); poll the list while `publishing`.
- Market detail consumes `initialized` for AIO readiness.
- `status`/`initialized` are **optional enrichment** — absent (legacy‑mode brands during the dual‑mode window) renders exactly as 1868 does today. Drop the now‑wrong "row's existence ⇒ market active" type‑doc contract.
- Everything else (slice‑keyed client, prompts/models UX) carries over from 1868 unchanged.

**Gate 4‑elmo:** preview build against a dev cohort org with one child‑mode and one legacy‑mode brand — both render; status badges only on the child‑mode brand. Mergeable any time **after** Step 4's api‑service deploy (fields are additive).

### Step 5 — spacecat-api-service: dual‑mode writes

**File:** `handlers/markets.js` (+ `handlers/prompts.js` write paths)

- `handleCreateMarket` **child path:** `ensureChildWorkspace` → listing check (live slice → 409; leftover draft → **adopt** and resume) → create draft → models → publish‑once → bounded confirm via `getProject`/`publish_status`. **No mapping write, no best‑effort rollback** — leftovers are resumable state (design §7). Legacy path untouched.
- `handleDeleteMarket` **child path:** listing match → project delete (404‑as‑success); **no floor check**. *(Note: `main` already has no floor check, so legacy is unchanged either way — the design's "legacy keeps its floor" assumed PR 2513 semantics that aren't on our baseline.)*
- `handleUpdateModels`: **+ publish after mutation + bounded confirm, in BOTH modes** (the freeze exception, §1).
- `prompts.js` write handlers: child mode resolves project by slice from the listing; per‑write republish behaviour unchanged.

**Gate 5:** unit + IT — adopt‑and‑resume, concurrent‑create race (two projects on one slice → reads deterministic + alert), publish‑failure leaves visible `draft`, both‑modes republish for models · codecov patch target.

### Step 6 — spacecat-api-service: activate / deactivate

**File:** new `src/support/serenity/workspace-lifecycle.js` + controller wiring

- `decommissionBrandWorkspace(ctx, brand)` (convergent, design §6): delete every project from the listing (404‑as‑success) → `transferWorkspaceResources` release‑to‑parent → `removeWorkspaceMember` best‑effort. **Workspace + `semrush_workspace_id` kept.**
- **Activate** (design flow 5): `ensureChildWorkspace` → per caller‑supplied market: draft → models → publish‑once → confirm; `brands.status='active'` once ≥1 live.
- **Deactivate** (design flow 6): `decommissionBrandWorkspace` → `brands.status='pending'`.
- **Open item to resolve at step start (design §7 plan‑specific):** trigger surface — dedicated `/serenity` activate/deactivate endpoints vs hooking the brand status PATCH. **Recommendation given our baseline:** add **explicit `POST /v2/orgs/:orgId/brands/:brandId/serenity/activate` and `.../deactivate`** endpoints (the brand‑status PATCH onboarding hook from PR 2513 is not on `main`). Confirm with elmo/backoffice owners before coding.

> **Deferred to a follow‑on (needs 2513/2584):** design flow 1 (onboard + finalize) and flow 2 (customer‑wide Slack offboard). Both require the onboarding serenity block and the DRS finalize trigger that live in PRs 2513/2584, which this plan does not build. Tracked as the next epic once those land.

**Gate 6:** unit + IT (decommission convergence: re‑run skips missing projects, zero‑release no‑op) · dev e2e deactivate → reactivate round‑trip (allocation released then re‑granted, publish works again).

### Step 7 — migration + per‑brand cutover

- Cutover script per active brand: **preferred** Semrush‑side project transfer (admin‑only today — standing ask, design §10/§12); **fallback** delete + recreate: market list from the brand's frozen `BrandSemrushProject` rows (their only remaining use), prompts read **by tags from the old flat project** → re‑pushed tagged into the new drafts → publish. `semrushPromptId` churn accepted (clients tolerate it).
- **Gate D diff script** before flipping each brand: old mapping rows vs new child‑workspace listing — slices 1:1, publish state preserved. Old flat projects deleted only **after** the diff passes (so rollback = clear the column).
- Waves: dev → stage → prod cohort. elmo needs no per‑wave work (Step 4‑elmo tolerates status‑absent legacy and status‑bearing child responses side by side).

**Gate 7:** Gate D green per brand · post‑cutover smoke (markets list + one prompt write) per wave · error‑budget watch between waves.

### Step 8 — retirement (separate, last)

Preconditions: every active brand cut over + agreed quiet period. Then remove legacy branches from handlers/resolver, drop `BrandSemrushProject` usage from api‑service, release; **separately and announced**, drop `brand_to_semrush_projects` in mysticat‑data‑service after confirming no other consumer via org‑wide `gh search code` (backward‑compat rule: own migration, after consumers confirmed off it).

**Gate 8:** zero code references (org‑wide search) · one full release cycle with the legacy path dead‑but‑present before the table drop · prod error budget clean.

---

## 4. Complete local development setup (real Semrush dev gateway)

This is the part the design docs do not cover. Everything runs from the worktree session dir
`/Users/rfriederich/dev/mysticat-workspace/.worktrees/feat-support-subworktrees` unless noted. **Always use `mise run local-run -- <target>`** from the session dir — a plain `make -C local run-<target>` silently launches the MAIN checkout's code (workspace CLAUDE.md, local‑dev skill "Worktree Sessions").

### 4.1 Topology

```
Native: project-elmo-ui :3005 ──localapi──▶ spacecat-api-service :3004 ──IMS bearer──▶ Semrush DEV gateway (real)
                                                  │                                        parent ws bb0f4e1c-…
                                                  ▼
Docker (shared): Postgres :5432 · PostgREST :3000/:3002 · Swagger :8080  (LocalStack :4566 optional)
```

The Semrush Project Engine accepts **only real user IMS tokens** and is forwarded verbatim by `rest-transport.js`. There is **no local fake** — so serenity endpoints cannot be exercised under `SKIP_AUTH=true`; they need a real IMS bearer and live dev‑gateway reachability.

### 4.2 One‑time setup

1. **Prereqs / ports** (from `local/`): `make doctor` · `make doctor-services`.
2. **Local env file:** `cp local/.env.example local/.env`. Then set the serenity‑specific values in `local/.env`:
   - `SEMRUSH_PROJECTS_BASE_URL=https://<semrush-dev-gateway-host>` — the **dev** gateway origin (HTTPS, origin only — `rest-transport.js#baseUrl` strips any path/userinfo and rejects non‑https). Pull the dev host from Vault `dx_mysticat/dev/api-service` (`./init.sh --only secrets` after `vault login -method=oidc`).
   - Leave `SKIP_AUTH` **unset/false** for serenity testing (a real IMS token is required; `requireImsBearer` rejects non‑IMS auth). Other non‑serenity local calls can still use `SKIP_AUTH` in a separate run if desired.
3. **elmo deps:** `cd project-elmo-ui && npm ci` (once).

### 4.3 Bring up the stack

```bash
# from local/ (workspace root) — shared infra
cd /Users/rfriederich/dev/mysticat-workspace/local
make up                 # Postgres :5432, PostgREST :3000/:3002, Swagger :8080
make db-setup           # db-migrate (dbmate) + db-seed + db-reload-postgrest
make verify

# from the SESSION dir — api-service against THIS worktree's code
cd /Users/rfriederich/dev/mysticat-workspace/.worktrees/feat-support-subworktrees
mise run local-run -- api        # foreground on :3004  (or: api-bg)

# from the SESSION dir — elmo against local api
mise run local-run -- ui-localapi   # https://localhost:3005, data → local :3004
```

> **Verify the localapi port wiring once:** `project-elmo-ui/config/.env.localapi` has historically carried `SPACECAT_URL=http://localhost:3002` while the api‑service starts on `:3004`. Confirm `.env.localapi` points at the port `local/.env` actually binds (`PORT=3004`) before trusting end‑to‑end calls; fix in the elmo successor branch if stale.

### 4.4 Seed data for dual‑mode (both modes side‑by‑side)

After `make db-setup`, seed an org + two brands so you can exercise legacy and child mode together. (Use the data‑service seed fixtures or psql via `make db-shell`.)

- **Organization:** set `organizations.semrush_workspace_id = 'bb0f4e1c-8bb1-402e-88f2-f68618ea7397'` (the dev **parent**). This is what legacy mode and `ensureChildWorkspace` resolve as the parent.
- **Brand A (legacy mode):** `brands.semrush_workspace_id = NULL` + a couple of `brand_to_semrush_projects` rows pointing at existing flat dev projects → exercises the frozen legacy path.
- **Brand B (child mode):** create a real child workspace under the parent via the Step‑2 `createChildWorkspace` smoke (or the Step‑6 activate endpoint once built), then set `brands.semrush_workspace_id` to that child id → exercises the live‑listing path.

### 4.5 Calling serenity locally (real IMS token)

```bash
mysticat login            # once, interactive
TOKEN=$(mysticat auth token --ims)

# child-mode brand: live listing from the dev child workspace
curl -sk https://localhost:3004/v2/orgs/<orgId>/brands/<brandB>/serenity/markets \
  -H "Authorization: Bearer $TOKEN" | jq

# legacy-mode brand: DB-backed listing (no upstream call)
curl -sk https://localhost:3004/v2/orgs/<orgId>/brands/<brandA>/serenity/markets \
  -H "Authorization: Bearer $TOKEN" | jq
```

The same `$TOKEN` is forwarded to the Semrush dev gateway for child‑mode reads/writes. Everything created against the dev parent during testing must be torn down (`decommissionBrandWorkspace` + `deleteWorkspace` cleanup) to leave the tenant at baseline — the Gate‑A smoke is net‑zero by construction.

### 4.6 spacecat-shared local loop

```bash
cd spacecat-shared
npm test    -w packages/spacecat-shared-data-access      # unit (sinon, no Docker)
npm run test:it -w packages/spacecat-shared-data-access  # IT against local PostgREST (needs Docker + ECR login)
npm run lint -w packages/spacecat-shared-data-access
```

To consume an unreleased `Brand` entity in api‑service before publishing, `npm link` the package (or pin a prerelease) — but the merge order assumes Step 1 is released and bumped before Step 3 lands.

### 4.7 Teardown

```bash
cd /Users/rfriederich/dev/mysticat-workspace/local
make stop-services && make down
```

---

## 5. Testing strategy

- **Project‑engine test double** pinned to live‑verified behaviour wherever the swagger diverges (design §11 / workspace doc §4/§5/§7): zero‑quota publish → bare nginx 405 HTML; `not ready` → 500; draft‑layer staging with live‑layer counts; tagged‑route‑only prompt ingestion + text dedup; v1‑vs‑v2 listing divergence on drafts; verbatim titles; family listing; `resources/transfer` release/re‑grant (payload pinned by the Step‑2 smoke).
- **Parity harness** (Step 4) is the PR‑1868 compatibility lock — run on every serenity‑surface PR from Step 4 on.
- **Live smokes** are net‑zero, env‑flag‑gated, **dev parent `bb0f4e1c‑…` only** — never default CI. Mirror the existing live‑gated test pattern in the repo (env flag the same way other live‑AWS test gates do).
- Unit tests follow the repo pattern: mocha + chai + sinon + esmock; stub `transport` and `dataAccess.Brand`/`BrandSemrushProject`. IT tests in `test/it/postgres/` with shared factories + seed‑ids.

---

## 6. Rollout, flags, rollback

- **No new runtime flag.** `brands.semrush_workspace_id` is the per‑brand, data‑driven switch.
- **Per‑brand rollback** = clear the column (legacy resumes on untouched flat projects).
- Legacy path frozen except the `handleUpdateModels` republish fix (both modes).
- Cohort gating (PR 2513's `feature_flags` row) is **out of baseline** — child mode is gated purely by the column being set on chosen test/dev brands until the cohort mechanism lands separately.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `resources/transfer` release/re‑grant contract unverified in detail | Pinned by the Step‑2 Gate‑A smoke against `bb0f4e1c‑…` **before** any dependent step; if release‑to‑parent proves impossible, decommission degrades to "delete projects, keep allocation" (limits not redistributed — functional, escalate the ask) |
| Concurrent duplicate‑create race (accepted, design §7) | Oldest‑`created_at`‑wins reads + error alert (Step 4) + runbook delete‑newer (Step 5) |
| Allocation sizing default is a placeholder | `markets + 2` / `500 × projects` until a sizing owner decides (design §12); tunable per call |
| Local serenity needs live dev‑gateway + real IMS token (no offline fake) | Documented in §4; non‑serenity local work is unaffected and can still use `SKIP_AUTH` |
| elmo successor branch diverges from 1868 if 1868 changes | Branch off `feat/semrush-proxy-ims-prod` and merge forward; status/initialized are additive so api‑service can ship first |
| Large uncommitted local work across 4 repos before PRs | Commit incrementally to per‑repo feature branches as each step's local gate passes (commits ≠ PRs); open PRs only after the end‑to‑end local validation |
| Bundle drop of non‑JS assets (SITES‑45260) | Keep all new lookup data as JS‑module imports; no `readFileSync(import.meta.url)`; run `npm run build` if the bundle layer is touched |

---

## 8. Out of scope (this iteration)

- **Onboard + finalize (design flow 1)** and **customer‑wide Slack offboard (flow 2)** — depend on PRs 2513 (onboarding serenity block, cohort gate, `markets[]` DTO) and 2584 (defer‑publish, finalize endpoint, publish‑status), which we are **not** building on this baseline. Next epic once those land.
- **`SERENITY_DEFER_PUBLISH` removal** — flag never existed on our baseline; nothing to delete.
- **Typed project‑engine / sub‑workspace clients** — additions stay in `rest-transport.js` for a mechanical later swap.
- **Phase 2** (queues, reconciler, promise‑token OBO, FIFO serialization, batches) — `…-v2-phase2-async.md`.
- **Automating the Semrush‑CS deprovisioning handoff** — manual runbook until the process exists.

## 9. Open items (carried)

Allocation‑sizing owner + policy · default‑model policy at activation · markets‑per‑activation bound · the standing Semrush asks (parent‑pool carve‑out semantics, exact `resources/transfer` release/re‑grant contract, user‑token project‑transfer for migration) · activate/deactivate trigger surface (Step 6) · quiet‑period length before retirement (Step 8).
