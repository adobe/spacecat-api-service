# PLG Entitlement Tier — Requirements & Design (v2)

## 1. Background & Problem Statement

### 1.1 ASO PLG Onboarding Motion

Spacecat's entitlement model supports the following tiers: `FREE_TRIAL`, `PAID`, `PLG`, and `PRE_ONBOARD`.

The ASO PLG (Product-Led Growth) motion introduces a two-phase onboarding pathway:

1. **Pre-onboarding phase** (`PRE_ONBOARD` tier): Sites are ingested into the system before they are provisioned as customer-facing entities. Background workers (audit, import, etc.) operate on these sites, but they must not appear in any customer-facing API response. See the [PRE_ONBOARD tier design document](plg_preonboard_tier_requirement_and_design.md) for full details on this tier.

2. **Onboarded phase** (`PLG` tier): Once PLG onboarding completes, the site's entitlement transitions from `PRE_ONBOARD` to `PLG`. At this point the site becomes customer-visible, behaving like a `FREE_TRIAL` site from the API's perspective. The `PLG` tier is exclusively for customers who entered through the PLG motion — it is never assigned through the traditional sales-led or trial flows.

### 1.2 Evolution from v1

The original PLG tier design (v1) introduced `PLG` as an **internal-only** tier. This document (v2) reflects the following changes:

| Aspect | v1 (original) | v2 (current) |
|---|---|---|
| PLG customer-visibility | Internal-only (not in `CUSTOMER_VISIBLE_TIERS`) | **Customer-visible** (added to `CUSTOMER_VISIBLE_TIERS`) |
| Internal landing state | `PLG` | `PRE_ONBOARD` (new tier) |
| `getIsSummitPlgEnabled` | Checked `FREE_TRIAL` | Checks **`PLG`** (FREE_TRIAL is no longer part of PLG motion) |
| Transition path | PLG → FREE_TRIAL / PAID | PRE_ONBOARD → **PLG** → (optionally) PAID |
| FREE_TRIAL role in PLG | Landing tier after onboarding | **Not part of PLG motion** |

### 1.3 Rejected Alternatives

**Option A — Keep PLG internal-only and use FREE_TRIAL for onboarded PLG customers**: Loses the ability to distinguish PLG customers from traditional trial customers in the data model, preventing PLG-specific UX, analytics, and quota policies.

**Option B — Add a boolean flag on entitlements instead of a new tier**: Would require filtering across all API paths on a secondary field, complicating the allow-list pattern. A dedicated tier is cleaner.

**Option C — Promote PLG to customer-visible and introduce PRE_ONBOARD for the internal landing state (selected)**: Preserves the existing allow-list architecture. The `CUSTOMER_VISIBLE_TIERS` allow-list gains `PLG`; `PRE_ONBOARD` is automatically excluded. Backward-compatible, no changes to workers, clean separation of pre-onboarding vs. onboarded state.

---

## 2. Proposal

`PLG` becomes a **customer-visible** entitlement tier:

- **Customer-visible**: PLG-tier sites are surfaced through customer-facing APIs, identical to `FREE_TRIAL` and `PAID` sites.
- **PLG-exclusive**: The `PLG` tier is only assigned to customers who entered through the PLG motion (transitioned from `PRE_ONBOARD`). It is never used for traditional sales-led or trial flows.
- **Worker-transparent**: Background workers (audit, import) continue operating on PLG sites as they do for FREE_TRIAL/PAID — they check entitlement existence, not tier value.
- **Summit PLG flag**: `getIsSummitPlgEnabled` returns `true` for `PLG` tier only. `FREE_TRIAL` is no longer part of the PLG motion.
- **Upgradable**: PLG can transition to `PAID` via the existing `createEntitlement()` upgrade path.
- **Non-breaking**: No changes to existing FREE_TRIAL or PAID behavior anywhere.

> **Key principle**: The PLG tier is now a first-class customer-facing tier. The pre-provisioning internal state is handled by the separate `PRE_ONBOARD` tier (see [PRE_ONBOARD design doc](plg_preonboard_tier_requirement_and_design.md)).

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement |
|---|---|
| FR-01 | The system shall support `PLG` as a customer-visible entitlement tier alongside `FREE_TRIAL` and `PAID`. |
| FR-02 | PLG-tier sites shall be operable by all background workers (audit, import, etc.) without modification to those workers. |
| FR-03 | PLG-tier sites shall be returned in `GET /sites-resolve` responses when a valid siteId, organizationId, or imsOrg is supplied (same as FREE_TRIAL/PAID). |
| FR-04 | PLG-tier sites shall appear in `GET /organizations/:organizationId/sites` responses (both own sites and delegated sites), subject to enrollment. |
| FR-05 | A PLG-tier entitlement shall be upgradable to `PAID` without data loss or re-enrollment. |
| FR-06 | A PLG-tier entitlement shall be revocable (not protected like PAID). |
| FR-07 | The PLG tier shall be enforced as a valid enum value in the database, TypeScript types, and JavaScript model constants (alongside `PRE_ONBOARD`). |
| FR-08 | No existing FREE_TRIAL or PAID entitlement behavior shall be modified. |
| FR-09 | `getIsSummitPlgEnabled` shall return `true` only for PLG-tier sites (not FREE_TRIAL). |
| FR-10 | PLG-tier sites shall pass `validateEntitlement` checks for LLMO and product-gated endpoints. |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-01 | The PLG tier visibility change must be achieved by adding `PLG` to the existing `CUSTOMER_VISIBLE_TIERS` allow-list — no structural changes to the filtering architecture. |
| NFR-02 | `getIsSummitPlgEnabled` must use the `Entitlement.TIERS.PLG` constant, not a raw string, to prevent drift. |
| NFR-03 | All affected code paths must be covered by unit tests asserting PLG sites are visible and `isSummitPlgEnabled` is `true` for PLG. |
| NFR-04 | Changes must be deployed in dependency order: DB → shared lib → API service. |
| NFR-05 | The implementation must not introduce any new API endpoints or schema changes beyond the tier behavior changes. |

### 3.3 Out of Scope

- Changes to `spacecat-audit-worker`, `spacecat-import-worker`, or any other background worker.
- PLG-specific quota tracking (see OQ-1).
- The `PRE_ONBOARD` tier implementation (covered in a [separate design document](plg_preonboard_tier_requirement_and_design.md)).
- Business logic for the PLG onboarding flow that transitions `PRE_ONBOARD` → `PLG`.
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
  Revocable?         │   YES    │ via admin│   YES    │      YES       │
  Upgradable to PAID │   YES    │    —     │   YES    │      YES       │
  Upgradable to PLG  │    —     │    NO    │    —     │      YES       │
                     └──────────┴──────────┴──────────┴────────────────┘
```

### 4.2 Dependency Chain

Changes must be delivered in the following order:

```
mysticat-data-service       spacecat-shared           spacecat-api-service
(DB enum: PRE_ONBOARD)──▶(model + tier-client)  ──▶(CUSTOMER_VISIBLE_TIERS + getIsSummitPlgEnabled)
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
        │         → tier=PRE_ONBOARD → return [] ✗
        │
        ├──▶ API: LLMO endpoints — validateEntitlement()
        │         → tier=PRE_ONBOARD → throw UnauthorizedProductError → 403 ✗
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
                  │
                  └──▶ (Optional) Upgrade to PAID
                            createEntitlement('PAID')
                              → PLG is non-PAID, so tier overwritten
                              → isSummitPlgEnabled = false (PAID tier)
```

---

## 5. Design

### 5.1 Repository 1: mysticat-data-service

No changes required for making PLG customer-visible. The `PLG` enum value already exists in the database from the v1 migration (`20260326000000_entitlement_tier_add_plg.sql`).

The `PRE_ONBOARD` enum addition is covered in the [PRE_ONBOARD design document](plg_preonboard_tier_requirement_and_design.md).

---

### 5.2 Repository 2: spacecat-shared

No changes required for the PLG tier itself. The `PLG` constant already exists in `Entitlement.TIERS` and `EntitlementTier` type declaration from the v1 implementation.

The `PRE_ONBOARD` constant addition is covered in the [PRE_ONBOARD design document](plg_preonboard_tier_requirement_and_design.md).

---

### 5.3 Repository 3: spacecat-api-service

Two changes are required to make PLG customer-visible:

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

This single change automatically makes PLG-tier sites visible across all four API guard paths:
- `validateEntitlement` in `access-control-util.js` — PLG passes the `CUSTOMER_VISIBLE_TIERS.includes()` check
- `filterSitesForProductCode` in `utils.js` — PLG sites are included in results
- `resolveSite` in `sites.js` (all 3 sub-paths) — PLG sites are returned
- Delegated sites in `organizations.js` — PLG entitlements are not skipped

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

#### 5.3.3 `validateEntitlement` — `src/support/access-control-util.js`

**No code change required.** The existing guard checks `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())`. With PLG added to the allow-list (5.3.1), PLG-tier sites pass this check automatically. The `TrialUser` creation block that fires for `FREE_TRIAL` does not fire for `PLG` — this is correct since PLG users are not trial users.

#### 5.3.4 `filterSitesForProductCode` — `src/support/utils.js`

**No code change required.** The existing guard checks `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())`. PLG passes after 5.3.1.

#### 5.3.5 `resolveSite` — `src/controllers/sites.js`

**No code change required.** All three sub-paths check `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())`. PLG passes after 5.3.1.

#### 5.3.6 `getSitesForOrganization` — delegated sites path — `src/controllers/organizations.js`

**No code change required.** The delegated sites loop checks `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())`. PLG passes after 5.3.1.

#### 5.3.7 API Service Unit Tests

| Test file | New/Updated test cases |
|---|---|
| `getIsSummitPlgEnabled` tests (utils) | PLG-tier site with summit-plg handler returns `true`; FREE_TRIAL-tier site returns `false`; PRE_ONBOARD-tier site returns `false` |
| `resolveSite` tests | PLG-tier site is returned (not 404) for siteId/orgId/imsOrg paths; `isSummitPlgEnabled` is `true` for PLG-tier |
| `getSitesForOrganization` tests | PLG-tier org's sites are included; PLG-tier delegated sites are included |
| `filterSitesForProductCode` tests | PLG-tier entitlement returns enrolled sites (not empty array) |
| `validateEntitlement` tests (access-control-util) | PLG-tier passes (no UnauthorizedProductError); TrialUser is NOT created for PLG tier |
| Transition test | PRE_ONBOARD site is invisible → `createEntitlement('PLG')` → same site becomes visible with `isSummitPlgEnabled = true` |

---

## 6. What Does NOT Change

| Component | Reason |
|---|---|
| `spacecat-audit-worker` | Uses `checkValidEntitlement()` → entitlement exists → audit runs. Tier-agnostic. |
| `spacecat-import-worker` | Same as audit worker. |
| `TierClient` core methods | Tier-agnostic by design. Filtering is the API layer's responsibility. |
| `revokeEntitlement()` blocking logic | Already only blocks PAID. PLG is revocable. |
| `createEntitlement()` upgrade logic | Already allows overwriting non-PAID tiers. PRE_ONBOARD → PLG and PLG → PAID work as-is. |
| `validateEntitlement` guard logic | Already uses `CUSTOMER_VISIBLE_TIERS.includes()`. Adding PLG to the allow-list is sufficient. |
| `filterSitesForProductCode` guard logic | Same as above. |
| `resolveSite` guard logic | Same as above. |
| Delegated sites guard logic | Same as above. |
| `user-activities.js` `createActivityForSite` | Queries entitlements directly without a tier filter. PLG sites generating activity records is now expected and correct — they are customer-visible. |
| FREE_TRIAL tier behavior | Completely unchanged. FREE_TRIAL is no longer part of the PLG motion, but its existing behavior is preserved for traditional trial flows. |
| PAID tier behavior | Completely unchanged. |
| Any API endpoint not using `CUSTOMER_VISIBLE_TIERS` | Not affected by the allow-list change. |

### 6.1 What DOES Change

| Component | Change |
|---|---|
| `CUSTOMER_VISIBLE_TIERS` in `utils.js` | Gains `PLG` — single source of truth for PLG visibility |
| `getIsSummitPlgEnabled()` in `utils.js` | Checks `PLG` tier instead of `FREE_TRIAL` — FREE_TRIAL is no longer part of PLG motion |

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
| LLMO endpoint (`GET /sites/:id/llmo/config`) for PLG site | 200 — access granted (validateEntitlement passes) |
| `GET /sites-resolve` with siteId of PRE_ONBOARD site | 404 (PRE_ONBOARD is not customer-visible) |
| LLMO endpoint for PRE_ONBOARD site | 403 (PRE_ONBOARD blocked by validateEntitlement) |
| Audit worker processes PLG site | Audit runs normally |
| Audit worker processes PRE_ONBOARD site | Audit runs normally |
| `createEntitlement('PRE_ONBOARD')` then `createEntitlement('PLG')` | Site transitions from invisible to visible |
| `createEntitlement('PLG')` then `createEntitlement('PAID')` | Site remains visible; `isSummitPlgEnabled` becomes `false` |
| `revokeEntitlement()` on PLG entitlement | Entitlement and enrollments deleted |
| `getIsSummitPlgEnabled` for PLG-tier site | `true` |
| `getIsSummitPlgEnabled` for FREE_TRIAL-tier site | `false` |

### 7.2 Business Success Metrics

| Metric | Target | Owner |
|---|---|---|
| PRE_ONBOARD → PLG conversion rate | TBD by product | PLG onboarding team |
| Median time-in-PRE_ONBOARD before conversion | TBD — threshold for "stuck" site alert | Platform/ops |
| PLG → PAID upgrade rate | TBD by product | Product |
| PLG sites stuck > 30 days without upgrade | Alert threshold for ops | Platform/ops |

---

## 8. Implementation Plan

> Changes must be applied in the order below. The PRE_ONBOARD tier (Phase 1-2) must be deployed before the PLG visibility change (Phase 3) to ensure the internal landing state exists before PLG becomes customer-visible.

### Phase 1 — mysticat-data-service (PRE_ONBOARD enum)

See [PRE_ONBOARD design document](plg_preonboard_tier_requirement_and_design.md) — Phase 1.

### Phase 2 — spacecat-shared (PRE_ONBOARD constant)

See [PRE_ONBOARD design document](plg_preonboard_tier_requirement_and_design.md) — Phase 2.

### Phase 3 — spacecat-api-service (PLG visibility + getIsSummitPlgEnabled)

| # | Task | Notes |
|---|---|---|
| 3.1 | Add `EntitlementModel.TIERS.PLG` to `CUSTOMER_VISIBLE_TIERS` in `utils.js` | Single-line change to allow-list |
| 3.2 | Update `getIsSummitPlgEnabled` to check `PLG` instead of `FREE_TRIAL` | Single-line change in return statement |
| 3.3 | Update unit tests for `getIsSummitPlgEnabled` | PLG → true; FREE_TRIAL → false |
| 3.4 | Update unit tests for `resolveSite` | PLG sites return 200 with `isSummitPlgEnabled: true` |
| 3.5 | Update unit tests for `filterSitesForProductCode` | PLG sites included |
| 3.6 | Update unit tests for `validateEntitlement` | PLG passes; no TrialUser created |
| 3.7 | Add PRE_ONBOARD tests to confirm invisibility | PRE_ONBOARD sites return 404/403/[] |

### Phase 4 — plg-onboarding.js (deferred)

| # | Task | Notes |
|---|---|---|
| 4.1 | Update `plg-onboarding.js` provisioner to emit `PRE_ONBOARD` entitlements as landing state and `PLG` as final onboarded state | Separate PR; depends on Phase 2 |

---

## 9. Risk & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PLG sites become visible before PRE_ONBOARD exists | High | High | Deploy PRE_ONBOARD (Phase 1-2) **before** adding PLG to CUSTOMER_VISIBLE_TIERS (Phase 3). The ordering is critical. |
| getIsSummitPlgEnabled returns false for existing PLG-motion sites still on FREE_TRIAL | Medium | Medium | During transition, existing FREE_TRIAL PLG sites lose the summit PLG flag. Coordinate with PLG onboarding team to migrate existing sites to PLG tier before deploying Phase 3, or accept temporary regression. |
| Workers accidentally skip PLG or PRE_ONBOARD sites | Low | High | Workers are tier-agnostic; no change to worker code eliminates this risk |
| PRE_ONBOARD site accidentally exposed via an uncovered API path | Low | High | Allow-list pattern means new tiers (PRE_ONBOARD) are denied by default |
| Enum rollback difficulty | Low | Low | PostgreSQL does not support removing enum values; acceptable for a low-risk addition |
| Dependency version mismatch (shared not updated before API service) | Medium | High | Phase 2 must be merged and published before Phase 3 PR is merged |

---

## 10. Open Questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | `createEntitlement()` currently hardcodes `llmo_trial_prompts: 200` for all new entitlements. Should PLG and PRE_ONBOARD entitlements receive different quotas? | Product |
| OQ-2 | What is the defined TTL for a site in `PRE_ONBOARD` before it is considered stuck? A 30-day threshold is proposed. | PLG onboarding team |
| OQ-3 | Should `GET /organizations/:id` (the org detail endpoint, not sites) expose the PLG tier to callers? | API/product |
| OQ-4 | Should existing FREE_TRIAL sites that were onboarded through the PLG motion be migrated to PLG tier? What is the migration strategy? | PLG onboarding team |
| OQ-5 | Should activity records (`createActivityForSite`) be suppressed for PRE_ONBOARD-tier sites? PLG-tier activity records are now expected since sites are customer-visible. | Product |
| OQ-6 | Should `validateEntitlement` create `TrialUser` records for PLG-tier sites (as it does for FREE_TRIAL), or is the PLG user model different? | Product |
