# ASO PLG Entitlement Tiers — Requirements & Design

## 1. Background & Problem Statement

### 1.1 ASO PLG Onboarding Motion

Spacecat's entitlement model originally supported two tiers: `FREE_TRIAL` and `PAID`. The ASO PLG (Product-Led Growth) motion introduces a two-phase onboarding pathway that requires two new tiers:

1. **Pre-onboarding phase** (`PRE_ONBOARD` tier): Sites are ingested into the system before they are provisioned as customer-facing entities. Background workers (audit, import, etc.) operate on these sites, but they must not appear in any customer-facing API response. This phase produces the data that will be ready for the customer when they first access the product.

2. **Onboarded phase** (`PLG` tier): Once PLG onboarding completes, the site's entitlement transitions from `PRE_ONBOARD` to `PLG`. At this point the site becomes customer-visible, behaving like a `FREE_TRIAL` site from the API's perspective. The `PLG` tier is exclusively for customers who entered through the PLG motion — it is never assigned through the traditional sales-led or trial flows.

### 1.2 Evolution from v1

The original PLG tier design (v1) introduced `PLG` as an **internal-only** tier. This document reflects the v2 design:

| Aspect | v1 (original) | v2 (current) |
|---|---|---|
| PLG customer-visibility | Internal-only (not in `CUSTOMER_VISIBLE_TIERS`) | **Customer-visible** (added to `CUSTOMER_VISIBLE_TIERS`) |
| Internal landing state | `PLG` | `PRE_ONBOARD` (new tier) |
| `getIsSummitPlgEnabled` | Checked `FREE_TRIAL` | Checks **`PLG`** (FREE_TRIAL is no longer part of PLG motion) |
| Transition path | PLG → FREE_TRIAL / PAID | PRE_ONBOARD → **PLG** → (optionally) FREE_TRIAL / PAID |
| FREE_TRIAL role in PLG | Landing tier after onboarding | **Not part of PLG motion** |

### 1.3 Why Two New Tiers

| Scenario | Without PRE_ONBOARD | With PRE_ONBOARD + PLG |
|---|---|---|
| Site enters via PLG motion | No dedicated state → site either exposed prematurely or workers can't operate | PRE_ONBOARD → workers operate; API excludes until ready |
| Workers operate on pre-onboarding site | Would need a separate mechanism to distinguish "not ready" from "ready" | PRE_ONBOARD entitlement → workers operate; API excludes |
| Onboarding completes | No clear transition signal | `createEntitlement('PLG')` → tier overwritten, site becomes visible |
| Distinguishing PLG from trial customers | Impossible — both are FREE_TRIAL | PLG tier is distinct, enabling PLG-specific UX, analytics, quotas |

### 1.4 Rejected Alternatives

**Option A — Keep PLG internal-only and use FREE_TRIAL for onboarded PLG customers**: Loses the ability to distinguish PLG customers from traditional trial customers in the data model, preventing PLG-specific UX, analytics, and quota policies.

**Option B — Add a boolean flag on entitlements instead of a new tier**: Would require filtering across all API paths on a secondary field, complicating the allow-list pattern. A dedicated tier is cleaner.

**Option C — Delay entitlement creation until onboarding completes**: Workers need an entitlement to operate on the site. Without one, `checkValidEntitlement()` returns empty and workers skip the site.

**Option D — Promote PLG to customer-visible and introduce PRE_ONBOARD for the internal landing state (selected)**: Preserves the existing allow-list architecture. The `CUSTOMER_VISIBLE_TIERS` allow-list gains `PLG`; `PRE_ONBOARD` is automatically excluded. Backward-compatible, no changes to workers, clean separation of pre-onboarding vs. onboarded state.

---

## 2. Proposal

Two new entitlement tiers with distinct roles:

**`PRE_ONBOARD` — Internal-only pre-provisioning tier:**

- **Internal-only**: PRE_ONBOARD-tier sites are never surfaced through customer-facing APIs. The tier is not in `CUSTOMER_VISIBLE_TIERS`.
- **Worker-transparent**: Background workers (audit, import) continue operating on PRE_ONBOARD sites as they do for all other tiers — they check entitlement existence, not tier value.
- **Transient**: PRE_ONBOARD is a landing state. Once a site completes the PLG onboarding flow, its entitlement transitions `PRE_ONBOARD` → `PLG` via the existing `createEntitlement()` upgrade path.

**`PLG` — Customer-visible onboarded tier:**

- **Customer-visible**: PLG-tier sites are surfaced through customer-facing APIs, identical to `FREE_TRIAL` and `PAID` sites.
- **PLG-exclusive**: The `PLG` tier is only assigned to customers who entered through the PLG motion (transitioned from `PRE_ONBOARD`). It is never used for traditional sales-led or trial flows.
- **Summit PLG flag**: `getIsSummitPlgEnabled` returns `true` for `PLG` tier only. `FREE_TRIAL` is no longer part of the PLG motion.
- **Upgradable**: PLG can transition to `FREE_TRIAL` or `PAID` via the existing `createEntitlement()` upgrade path.

**Both tiers:**

- **Worker-transparent**: Background workers check entitlement existence, not tier value.
- **Non-breaking**: No changes to existing FREE_TRIAL or PAID behavior anywhere.

> **Key design principle**: The API uses an allow-list (`CUSTOMER_VISIBLE_TIERS`) to control which tiers are visible to customers. Any tier *not* in this list is automatically hidden. This means `PRE_ONBOARD` requires zero changes to API guard logic — it is excluded by default.

---

## 3. Requirements

### 3.1 Functional Requirements

#### PLG Tier

| ID | Requirement |
|---|---|
| FR-PLG-01 | The system shall support `PLG` as a customer-visible entitlement tier alongside `FREE_TRIAL` and `PAID`. |
| FR-PLG-02 | PLG-tier sites shall be operable by all background workers (audit, import, etc.) without modification to those workers. |
| FR-PLG-03 | PLG-tier sites shall be returned in `GET /sites-resolve` responses when a valid siteId, organizationId, or imsOrg is supplied (same as FREE_TRIAL/PAID). |
| FR-PLG-04 | PLG-tier sites shall appear in `GET /organizations/:organizationId/sites` responses (both own sites and delegated sites), subject to enrollment. |
| FR-PLG-05 | A PLG-tier entitlement shall be upgradable to `FREE_TRIAL` or `PAID` without data loss or re-enrollment. |
| FR-PLG-06 | A PLG-tier entitlement shall be revocable (not protected like PAID). |
| FR-PLG-07 | The PLG tier shall be enforced as a valid enum value in the database, TypeScript types, and JavaScript model constants. |
| FR-PLG-08 | No existing FREE_TRIAL or PAID entitlement behavior shall be modified. |
| FR-PLG-09 | `getIsSummitPlgEnabled` shall return `true` only for PLG-tier sites (not FREE_TRIAL). |
| FR-PLG-10 | PLG-tier sites shall pass `validateEntitlement` checks for LLMO and product-gated endpoints. |
| FR-PLG-11 | PLG-tier entitlement validation shall NOT trigger `TrialUser` creation (unlike FREE_TRIAL). PLG users are not trial users. |

#### PRE_ONBOARD Tier

| ID | Requirement |
|---|---|
| FR-PRE-01 | The system shall support a `PRE_ONBOARD` entitlement tier in addition to `FREE_TRIAL`, `PAID`, and `PLG`. |
| FR-PRE-02 | PRE_ONBOARD-tier sites shall be operable by all background workers (audit, import, etc.) without modification to those workers. |
| FR-PRE-03 | PRE_ONBOARD-tier sites shall return a 404 response on `GET /sites-resolve` regardless of whether a siteId, organizationId, or imsOrg is supplied. |
| FR-PRE-04 | PRE_ONBOARD-tier sites shall not appear in `GET /organizations/:organizationId/sites` responses (neither in own sites nor delegated sites). |
| FR-PRE-05 | A PRE_ONBOARD-tier entitlement shall be directly upgradable to `PLG`, `FREE_TRIAL`, or `PAID` without data loss or re-enrollment. |
| FR-PRE-06 | A PRE_ONBOARD-tier entitlement shall be revocable (not protected like PAID). |
| FR-PRE-07 | The PRE_ONBOARD tier shall be enforced as a valid enum value in the database, TypeScript types, and JavaScript model constants. |
| FR-PRE-08 | No existing FREE_TRIAL, PAID, or PLG entitlement behavior shall be modified. |
| FR-PRE-09 | `getIsSummitPlgEnabled` shall return `false` for PRE_ONBOARD-tier sites. |
| FR-PRE-10 | PRE_ONBOARD-tier sites shall be blocked by `validateEntitlement` for LLMO and product-gated endpoints (403 response). |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-01 | Both tiers must be introduced via standard database migrations; no manual enum patching. |
| NFR-02 | PLG visibility must be achieved by adding `PLG` to the existing `CUSTOMER_VISIBLE_TIERS` allow-list — no structural changes to the filtering architecture. |
| NFR-03 | PRE_ONBOARD exclusion in the API layer is automatic via the allow-list — no explicit deny-list entry or new guard code is needed. |
| NFR-04 | `getIsSummitPlgEnabled` must use the `Entitlement.TIERS.PLG` constant, not a raw string, to prevent drift. |
| NFR-05 | All affected code paths must be covered by unit tests. |
| NFR-06 | Changes must be deployed in dependency order: DB → shared lib → API service. The PRE_ONBOARD tier must exist before PLG is added to `CUSTOMER_VISIBLE_TIERS`. |
| NFR-07 | The implementation must not introduce any new API endpoints or schema changes beyond the tier behavior changes. |

### 3.3 Out of Scope

- Changes to `spacecat-audit-worker`, `spacecat-import-worker`, or any other background worker.
- Tier-specific quota tracking (see OQ-1).
- Business logic for the PLG onboarding flow that transitions `PRE_ONBOARD` → `PLG` (Phase 4).
- Any changes to FREE_TRIAL or PAID tier behavior.

---

## 4. System Architecture

### 4.1 Tier Semantics

```
                     ┌──────────────────────────────────────────────────┐
                     │                Entitlement Tier                  │
                     ├──────────┬──────────┬──────────┬────────────────┤
                     │FREE_TRIAL│   PAID   │   PLG    │ PRE_ONBOARD │
                     ├──────────┼──────────┼──────────┼────────────────┤
  Customer-facing?   │   YES    │   YES    │   YES    │      NO        │
  Worker-visible?    │   YES    │   YES    │   YES    │      YES       │
  isSummitPlgEnabled │   NO     │   NO     │   YES    │      NO        │
  TrialUser created? │   YES    │   NO     │   NO     │      NO        │
  Revocable?         │   YES    │ via admin│   YES    │      YES       │
  Upgradable to PAID │   YES    │    —     │   YES    │      YES       │
  Upgradable to F_T  │    —     │    NO    │   YES    │      YES       │
  Upgradable to PLG  │    —     │    NO    │    —     │      YES       │
                     └──────────┴──────────┴──────────┴────────────────┘
```

### 4.2 Dependency Chain

Changes must be delivered in the following order:

```
mysticat-data-service       spacecat-shared              spacecat-api-service
(DB enum: PRE_ONBOARD) ──▶ (model + tier-client tests) ──▶ (CUSTOMER_VISIBLE_TIERS + getIsSummitPlgEnabled + dependency bump + tests)
```

### 4.3 Data Flow

```
Site enters via PLG motion
        │
        ▼
createEntitlement('PRE_ONBOARD')
  - org gets entitlement record (tier=PRE_ONBOARD)
  - site gets SiteEnrollment record
        │
        ├──▶ Audit Worker: checkValidEntitlement() → entitlement found → runs audit ✓
        │
        ├──▶ API: resolveSite() — any path
        │         → tier=PRE_ONBOARD → not in CUSTOMER_VISIBLE_TIERS → return 404 ✗
        │
        ├──▶ API: getSitesForOrganization()
        │         → tier=PRE_ONBOARD → not in CUSTOMER_VISIBLE_TIERS → return [] ✗
        │
        ├──▶ API: LLMO endpoints — validateEntitlement()
        │         → tier=PRE_ONBOARD → not in CUSTOMER_VISIBLE_TIERS
        │         → throw UnauthorizedProductError → 403 ✗
        │
        └──▶ PLG onboarding completes
                  │
                  ▼
             createEntitlement('PLG')
               - existing entitlement tier overwritten
                 (PRE_ONBOARD is non-PAID, so upgrade allowed)
               - SiteEnrollment preserved
                  │
                  ▼
             Site now customer-visible ✓
             isSummitPlgEnabled = true ✓
                  │
                  ├──▶ API: resolveSite() — any path
                  │         → tier=PLG → in CUSTOMER_VISIBLE_TIERS → return site ✓
                  │         → isSummitPlgEnabled = true (summit-plg handler + PLG tier)
                  │
                  ├──▶ API: getSitesForOrganization()
                  │         → tier=PLG → sites included ✓
                  │
                  ├──▶ API: LLMO endpoints — validateEntitlement()
                  │         → tier=PLG → allowed ✓
                  │         → TrialUser NOT created (PLG users are not trial users)
                  │
                  ├──▶ (Optional) Upgrade to FREE_TRIAL
                  │         createEntitlement('FREE_TRIAL')
                  │           → PLG is non-PAID, so tier overwritten
                  │           → isSummitPlgEnabled = false (FREE_TRIAL tier)
                  │
                  └──▶ (Optional) Upgrade to PAID
                            createEntitlement('PAID')
                              → PLG is non-PAID, so tier overwritten
                              → isSummitPlgEnabled = false (PAID tier)
```

---

## 5. Design

### 5.1 Repository 1: mysticat-data-service

#### 5.1.1 Database Migration — PRE_ONBOARD

New migration file: `db/migrations/20260406120000_entitlement_tier_add_pre_onboard.sql`

```sql
-- migrate:up
ALTER TYPE entitlement_tier ADD VALUE 'PRE_ONBOARD';

-- migrate:down
-- PostgreSQL does not support removing enum values; recreation required for rollback.
```

**Constraint**: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block. This is consistent with existing migrations in this repo (e.g., `20260326000000_entitlement_tier_add_plg.sql`).

The `PLG` enum value already exists from the v1 migration. No additional migration needed for PLG.

#### 5.1.2 TypeScript Type Regeneration

After migration is applied:

```bash
make migrate
make generate-ts-types
```

Affected file: `clients/typescript/src/database.types.ts`

Before:
```typescript
entitlement_tier: 'FREE_TRIAL' | 'PAID' | 'PLG'
```

After:
```typescript
entitlement_tier: 'FREE_TRIAL' | 'PAID' | 'PLG' | 'PRE_ONBOARD'
```

**Release**: Tag next available `types-ts-vX.Y.Z`.

---

### 5.2 Repository 2: spacecat-shared

#### 5.2.1 Entitlement Model Constants

File: `packages/spacecat-shared-data-access/src/models/entitlement/entitlement.model.js`

```js
static TIERS = {
  FREE_TRIAL: 'FREE_TRIAL',
  PAID: 'PAID',
  PLG: 'PLG',
  PRE_ONBOARD: 'PRE_ONBOARD',   // new
};
```

The `entitlement.schema.js` derives its allowed values from `Object.values(Entitlement.TIERS)`, so no schema change is needed.

#### 5.2.2 TypeScript Declaration

File: `packages/spacecat-shared-data-access/src/models/entitlement/index.d.ts`

```typescript
export type EntitlementTier = 'FREE_TRIAL' | 'PAID' | 'PLG' | 'PRE_ONBOARD';
```

#### 5.2.3 Tier-Client Dependency

File: `packages/spacecat-shared-tier-client/package.json`

Bump `@mysticat/data-service-types` to the Phase 1 tag containing the `PRE_ONBOARD` enum.

#### 5.2.4 Tier-Client Behavioral Analysis

No code changes required in `tier-client.js`. The existing logic is already correct for both PLG and PRE_ONBOARD:

| Method | Behavior | Change needed? |
|---|---|---|
| `createEntitlement('PRE_ONBOARD')` | Validates against `ENTITLEMENT_TIERS` enum (accepts PRE_ONBOARD after dependency update). Creates entitlement + enrollment. Hardcodes `llmo_trial_prompts: 200` — see OQ-1. | No |
| `checkValidEntitlement()` | Returns entitlement regardless of tier. Correct — workers need this. | No |
| `getAllEnrollment()` | Returns entitlement + enrollments regardless of tier. Caller (API layer) must filter. | No |
| `getFirstEnrollment()` | Returns first enrolled site regardless of tier. Caller (API layer) must filter. | No |
| `revokeEntitlement()` | Blocks only PAID tier. Both PLG and PRE_ONBOARD are revocable. | No |
| Upgrade PRE_ONBOARD → PLG | `createEntitlement('PLG')`: current tier is not PAID, so tier is overwritten. | No |
| Upgrade PRE_ONBOARD → PAID | `createEntitlement('PAID')`: same path, tier is overwritten directly. | No |
| Upgrade PLG → FREE_TRIAL | `createEntitlement('FREE_TRIAL')`: PLG is not PAID, so tier is overwritten. | No |
| Upgrade PLG → PAID | `createEntitlement('PAID')`: same path, tier is overwritten. | No |

#### 5.2.5 Unit Tests (tier-client)

File: `packages/spacecat-shared-tier-client/test/tier-client.test.js`

New test cases for PRE_ONBOARD:
- `createEntitlement('PRE_ONBOARD')` creates entitlement with tier=PRE_ONBOARD
- PRE_ONBOARD entitlement can be upgraded to PLG (tier overwritten)
- PRE_ONBOARD entitlement can be upgraded to PAID directly (tier overwritten)
- `revokeEntitlement()` succeeds for PRE_ONBOARD tier (not blocked like PAID)

Existing PLG test cases (from v1) remain valid:
- `createEntitlement('PLG')` creates entitlement with tier=PLG
- PLG entitlement can be upgraded to FREE_TRIAL
- PLG entitlement can be upgraded to PAID
- `revokeEntitlement()` succeeds for PLG tier

---

### 5.3 Repository 3: spacecat-api-service

#### 5.3.1 Add PLG to `CUSTOMER_VISIBLE_TIERS` — `src/support/utils.js`

**Change**: Add `PLG` to the allow-list.

```js
/**
 * Allow-list of entitlement tiers that are visible to customers via the API.
 * Any tier not in this list (e.g. PRE_ONBOARD) is treated as internal-only.
 * Adding a new tier here explicitly opts it into customer visibility.
 * @type {string[]}
 */
export const CUSTOMER_VISIBLE_TIERS = [
  EntitlementModel.TIERS.FREE_TRIAL,
  EntitlementModel.TIERS.PAID,
  EntitlementModel.TIERS.PLG,   // new — PLG is now customer-visible
];
```

This single change automatically makes PLG-tier sites visible — and keeps PRE_ONBOARD hidden — across all four API guard paths:
- `validateEntitlement` in `access-control-util.js` — PLG passes; PRE_ONBOARD throws `UnauthorizedProductError`
- `filterSitesForProductCode` in `utils.js` — PLG sites included; PRE_ONBOARD returns `[]`
- `resolveSite` in `sites.js` (all 3 sub-paths) — PLG sites returned; PRE_ONBOARD returns 404
- Delegated sites in `organizations.js` — PLG entitlements included; PRE_ONBOARD skipped

No changes to the guard logic itself — the allow-list pattern works as designed.

#### 5.3.2 Update `getIsSummitPlgEnabled` — `src/support/utils.js`

**Change**: Check for `PLG` tier instead of `FREE_TRIAL`. FREE_TRIAL is no longer part of the PLG motion.

Before:
```js
return entitlement?.getTier() === EntitlementModel.TIERS.FREE_TRIAL;
```

After:
```js
return entitlement?.getTier() === EntitlementModel.TIERS.PLG;
```

This means:
- PLG-tier sites with `summit-plg` handler enabled → `isSummitPlgEnabled = true`
- FREE_TRIAL-tier sites → `isSummitPlgEnabled = false` (FREE_TRIAL is no longer part of PLG motion)
- PRE_ONBOARD-tier sites → `isSummitPlgEnabled = false` (not yet onboarded)
- PAID-tier sites → `isSummitPlgEnabled = false`

> **Note on existing sites**: There are currently **no existing FREE_TRIAL sites** that were onboarded through the PLG motion. The PLG onboarding flow has not yet created any customer-facing entitlements. Therefore, changing `getIsSummitPlgEnabled` to check `PLG` instead of `FREE_TRIAL` has no impact on existing customers and requires no data migration.

#### 5.3.3 `validateEntitlement` — `src/support/access-control-util.js`

**No code change required.** The existing guard checks `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())`. With PLG added to the allow-list (5.3.1), PLG-tier sites pass this check automatically. PRE_ONBOARD-tier sites fail the check and receive a 403 response.

The `TrialUser` creation block that fires for `FREE_TRIAL` does not fire for `PLG` — this is correct and intentional per FR-PLG-11. PLG users are not trial users.

#### 5.3.4 Other Guard Paths — No Code Changes

| Guard path | File | Mechanism |
|---|---|---|
| `filterSitesForProductCode` | `src/support/utils.js` | `CUSTOMER_VISIBLE_TIERS.includes()` — PLG passes; PRE_ONBOARD returns `[]` |
| `resolveSite` (siteId path) | `src/controllers/sites.js` | `CUSTOMER_VISIBLE_TIERS.includes()` — PLG passes; PRE_ONBOARD returns 404 |
| `resolveSite` (orgId/imsOrg paths) | `src/controllers/sites.js` | `CUSTOMER_VISIBLE_TIERS.includes()` — PLG passes; PRE_ONBOARD returns 404 |
| Delegated sites | `src/controllers/organizations.js` | `CUSTOMER_VISIBLE_TIERS.includes()` — PLG passes; PRE_ONBOARD skips org |

#### 5.3.5 API Service Unit Tests

| Test file | New/Updated test cases |
|---|---|
| `getIsSummitPlgEnabled` tests (utils) | PLG → `true`; FREE_TRIAL → `false`; PRE_ONBOARD → `false` |
| `filterSitesForProductCode` tests | PLG → returns enrolled sites; PRE_ONBOARD → returns empty array |
| `validateEntitlement` tests (access-control-util) | PLG → passes (no UnauthorizedProductError); TrialUser NOT created for PLG; PRE_ONBOARD → throws UnauthorizedProductError |
| `resolveSite` tests | PLG → 200 with `isSummitPlgEnabled: true`; PRE_ONBOARD → 404 |
| `getSitesForOrganization` tests | PLG → sites included; PRE_ONBOARD → sites excluded |
| Transition test | PRE_ONBOARD site invisible → `createEntitlement('PLG')` → same site becomes visible with `isSummitPlgEnabled = true` |

---

## 6. What Does NOT Change

| Component | Reason |
|---|---|
| `spacecat-audit-worker` | Uses `checkValidEntitlement()` → entitlement exists → audit runs. Tier-agnostic. |
| `spacecat-import-worker` | Same as audit worker. |
| `TierClient` core methods | Tier-agnostic by design. Filtering is the API layer's responsibility. |
| `revokeEntitlement()` blocking logic | Already only blocks PAID. Both PLG and PRE_ONBOARD are revocable. |
| `createEntitlement()` upgrade logic | Already allows overwriting non-PAID tiers. PRE_ONBOARD → PLG, PLG → FREE_TRIAL, and PLG → PAID work as-is. |
| All four API guard paths (logic) | Already use `CUSTOMER_VISIBLE_TIERS.includes()`. Adding PLG to the allow-list is sufficient; PRE_ONBOARD is excluded by default. |
| `plg-onboarding.js` provisioner | **Current state**: The provisioner currently creates `FREE_TRIAL` entitlements (not `PLG` or `PRE_ONBOARD`). It does not emit PLG-motion entitlements yet. **Phase 4** will update it to emit `PRE_ONBOARD` as the landing state and `PLG` as the final onboarded state. This is a separate PR that depends on Phase 2. |
| `user-activities.js` `createActivityForSite` | Queries entitlements directly without a tier filter. PLG activity records are expected (customer-visible). PRE_ONBOARD activity records are acceptable (internal ops signal). |
| FREE_TRIAL tier behavior | Completely unchanged. FREE_TRIAL is no longer part of the PLG motion, but its existing behavior is preserved for traditional trial flows. |
| PAID tier behavior | Completely unchanged. |

### 6.1 What DOES Change

| Component | Change |
|---|---|
| `CUSTOMER_VISIBLE_TIERS` in `utils.js` | Gains `PLG` — single source of truth for PLG visibility |
| `getIsSummitPlgEnabled()` in `utils.js` | Checks `PLG` tier instead of `FREE_TRIAL` |
| `Entitlement.TIERS` in `entitlement.model.js` | Gains `PRE_ONBOARD` |
| `EntitlementTier` in `index.d.ts` | Gains `'PRE_ONBOARD'` |
| `entitlement_tier` PostgreSQL enum | Gains `'PRE_ONBOARD'` |

---

## 7. Verification Criteria

### 7.1 Technical Verification

After all changes are deployed end-to-end:

| Scenario | Expected Result |
|---|---|
| `GET /sites-resolve` with siteId of PLG site | 200 — site returned with `isSummitPlgEnabled: true` |
| `GET /sites-resolve` with orgId of PLG org | 200 — site returned with `isSummitPlgEnabled: true` |
| `GET /sites-resolve` with imsOrg of PLG org | 200 — site returned with `isSummitPlgEnabled: true` |
| `GET /organizations/:id/sites` for PLG org | PLG sites included in list |
| `GET /organizations/:id/sites` with delegated PLG org | PLG org's sites included in merged list |
| LLMO endpoint (`GET /sites/:id/llmo/config`) for PLG site | 200 — access granted; TrialUser NOT created |
| `GET /sites-resolve` with siteId of PRE_ONBOARD site | 404 (PRE_ONBOARD is not customer-visible) |
| `GET /sites-resolve` with orgId of PRE_ONBOARD org | 404 |
| `GET /organizations/:id/sites` for PRE_ONBOARD org | `[]` (empty sites list) |
| LLMO endpoint for PRE_ONBOARD site | 403 (PRE_ONBOARD blocked by validateEntitlement) |
| Audit worker processes PLG site | Audit runs normally |
| Audit worker processes PRE_ONBOARD site | Audit runs normally |
| `createEntitlement('PRE_ONBOARD')` then `createEntitlement('PLG')` | Site transitions from invisible to visible; `isSummitPlgEnabled` becomes `true` |
| `createEntitlement('PRE_ONBOARD')` then `createEntitlement('PAID')` | Site transitions from invisible to visible; `isSummitPlgEnabled` remains `false` |
| `createEntitlement('PLG')` then `createEntitlement('FREE_TRIAL')` | Site remains visible; `isSummitPlgEnabled` becomes `false` |
| `createEntitlement('PLG')` then `createEntitlement('PAID')` | Site remains visible; `isSummitPlgEnabled` becomes `false` |
| `revokeEntitlement()` on PLG entitlement | Entitlement and enrollments deleted |
| `revokeEntitlement()` on PRE_ONBOARD entitlement | Entitlement and enrollments deleted |
| `getIsSummitPlgEnabled` for PLG-tier site | `true` |
| `getIsSummitPlgEnabled` for FREE_TRIAL-tier site | `false` |
| `getIsSummitPlgEnabled` for PRE_ONBOARD-tier site | `false` |

### 7.2 Business Success Metrics

| Metric | Target | Owner |
|---|---|---|
| PRE_ONBOARD → PLG conversion rate | TBD by product | PLG onboarding team |
| PLG → PAID upgrade rate | TBD by product | Product |

---

## 8. Implementation Plan

> Changes must be applied in the order below. The PRE_ONBOARD tier (Phase 1-2) must be deployed before the PLG visibility change (Phase 3) to ensure the internal landing state exists before PLG becomes customer-visible.

### Phase 1 — mysticat-data-service (PRE_ONBOARD enum)

| # | Task | Notes |
|---|---|---|
| 1.1 | Create migration `20260406120000_entitlement_tier_add_pre_onboard.sql` | Cannot run in transaction block |
| 1.2 | Run `make migrate` + `make generate-ts-types` | Updates `database.types.ts` |
| 1.3 | Tag release `types-ts-vX.Y.Z` | Required by spacecat-shared |

### Phase 2 — spacecat-shared (PRE_ONBOARD constant + tests)

| # | Task | Notes |
|---|---|---|
| 2.1 | Add `PRE_ONBOARD` to `Entitlement.TIERS` in `entitlement.model.js` | Schema auto-picks it up |
| 2.2 | Update `EntitlementTier` in `index.d.ts` | TypeScript consumers |
| 2.3 | Bump `@mysticat/data-service-types` in `tier-client/package.json` | Points to Phase 1 tag |
| 2.4 | Add unit tests for PRE_ONBOARD in `tier-client.test.js` | create, upgrade to PLG, upgrade to PAID, revoke |

### Phase 3 — spacecat-api-service (PLG visibility + PRE_ONBOARD tests)

| # | Task | Notes |
|---|---|---|
| 3.1 | Add `EntitlementModel.TIERS.PLG` to `CUSTOMER_VISIBLE_TIERS` in `utils.js` | Single-line change to allow-list |
| 3.2 | Update `getIsSummitPlgEnabled` to check `PLG` instead of `FREE_TRIAL` | Single-line change. No data migration needed — no existing FREE_TRIAL PLG sites. |
| 3.3 | Bump `@adobe/spacecat-shared-data-access` and `@adobe/spacecat-shared-tier-client` | Points to Phase 2 versions |
| 3.4 | Update unit tests for `getIsSummitPlgEnabled` | PLG → true; FREE_TRIAL → false; PRE_ONBOARD → false |
| 3.5 | Update unit tests for `filterSitesForProductCode` | PLG → enrolled sites; PRE_ONBOARD → empty |
| 3.6 | Update unit tests for `validateEntitlement` | PLG passes (no TrialUser); PRE_ONBOARD → 403 |
| 3.7 | Add PRE_ONBOARD tests to confirm invisibility | PRE_ONBOARD sites return 404/403/[] |

### Phase 4 — plg-onboarding.js (deferred)

| # | Task | Notes |
|---|---|---|
| 4.1 | Update `plg-onboarding.js` provisioner to emit `PRE_ONBOARD` entitlements as landing state and `PLG` as final onboarded state | Separate PR; depends on Phase 2. The provisioner currently creates FREE_TRIAL entitlements (not PLG or PRE_ONBOARD). |

---

## 9. Risk & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PLG sites become visible before PRE_ONBOARD exists | High | High | Deploy PRE_ONBOARD (Phase 1-2) **before** adding PLG to CUSTOMER_VISIBLE_TIERS (Phase 3). The ordering is critical. |
| getIsSummitPlgEnabled check breaks existing sites | **None** | **None** | **There are no existing FREE_TRIAL sites created through the PLG motion.** The provisioner (`plg-onboarding.js`) has not yet created any PLG-motion entitlements. The `getIsSummitPlgEnabled` change can be deployed safely in Phase 3 without a data migration. |
| Workers accidentally skip PLG or PRE_ONBOARD sites | Low | High | Workers are tier-agnostic; no change to worker code eliminates this risk |
| PRE_ONBOARD site accidentally exposed via an uncovered API path | Low | High | Allow-list pattern means new tiers (PRE_ONBOARD) are denied by default |
| Enum rollback difficulty | Low | Low | PostgreSQL does not support removing enum values; acceptable for a low-risk addition |
| Dependency version mismatch (shared not updated before API service) | Medium | High | Phase 2 must be merged and published before Phase 3 PR is merged |
| Stuck PRE_ONBOARD sites consuming worker resources indefinitely | Low | Low | No TTL — sites remain in PRE_ONBOARD until the customer completes the PLG onboarding flow. Worker resource impact is negligible since audits are lightweight. |

---

## 10. Open Questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | `createEntitlement()` currently hardcodes `llmo_trial_prompts: 200` for all new entitlements. Should PLG and PRE_ONBOARD entitlements receive different quotas, or should PRE_ONBOARD be created with null quotas (since the site is not yet customer-visible)? | Product |
| OQ-2 | Should `GET /organizations/:id` (the org detail endpoint, not sites) expose the entitlement tier to callers? If so, should PRE_ONBOARD be filtered or visible? | API/product |
| OQ-3 | Should activity records (`createActivityForSite`) be suppressed for PRE_ONBOARD-tier sites, or is recording activity for internal/pre-provisioning sites acceptable? PLG-tier activity records are now expected since sites are customer-visible. | Product |
| OQ-4 | Should `validateEntitlement` create `TrialUser` records for PLG-tier sites (as it does for FREE_TRIAL), or is the PLG user model different? Current implementation: PLG does NOT create TrialUser (per FR-PLG-11). | Product |
