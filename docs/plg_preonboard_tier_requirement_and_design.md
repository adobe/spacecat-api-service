# PRE_ONBOARD Entitlement Tier — Requirements & Design

## 1. Background & Problem Statement

### 1.1 Two-Phase PLG Onboarding

The ASO PLG (Product-Led Growth) motion uses a two-phase lifecycle for customer sites:

1. **Pre-onboarding** — The site is ingested into the system and background workers (audit, import, brand profile, etc.) begin operating on it. The customer cannot see the site yet. This phase produces the data that will be ready for the customer when they first access the product.

2. **Onboarded** — The site becomes customer-visible. The customer can now see audit results, opportunities, and recommendations that were generated during pre-onboarding.

The `PRE_ONBOARD` tier represents phase 1. When the PLG onboarding process completes, the entitlement transitions from `PRE_ONBOARD` to `PLG` (which is customer-visible). See the [PLG tier design document](plg_tier_requirement_and_design.md) for the customer-visible phase.

### 1.2 Why a Dedicated Tier

The `PRE_ONBOARD` tier replaces the original internal-only role that `PLG` served in v1 of the tier design. With PLG now promoted to customer-visible status, a new internal tier is needed for the pre-provisioning window.

| Scenario | Without PRE_ONBOARD | With PRE_ONBOARD |
|---|---|---|
| Site enters via PLG motion | Must use PLG (now customer-visible) → site exposed prematurely | PRE_ONBOARD → site hidden until ready |
| Workers operate on pre-onboarding site | Would need a separate mechanism to distinguish "not ready" PLG from "ready" PLG | PRE_ONBOARD entitlement → workers operate; API excludes |
| Onboarding completes | No clear transition signal | `createEntitlement('PLG')` → tier overwritten, site becomes visible |

### 1.3 Rejected Alternatives

**Option A — Use a status flag on PLG entitlements**: Would require adding a secondary filter across all API guard paths, breaking the clean allow-list pattern. Every path checking `CUSTOMER_VISIBLE_TIERS` would also need to check the flag.

**Option B — Delay entitlement creation until onboarding completes**: Workers need an entitlement to operate on the site. Without one, `checkValidEntitlement()` returns empty and workers skip the site.

**Option C — Introduce PRE_ONBOARD as a new internal tier (selected)**: Clean, backward-compatible, requires no changes to workers or to the existing allow-list guard architecture. The `CUSTOMER_VISIBLE_TIERS` allow-list automatically excludes `PRE_ONBOARD` without any code changes to the guard paths.

---

## 2. Proposal

Introduce `PRE_ONBOARD` as a **first-class but internally scoped** entitlement tier:

- **Internal-only**: PRE_ONBOARD-tier sites are never surfaced through customer-facing APIs. The tier is not in `CUSTOMER_VISIBLE_TIERS`.
- **Worker-transparent**: Background workers (audit, import) continue operating on PRE_ONBOARD sites as they do for all other tiers — they check entitlement existence, not tier value.
- **Transient**: PRE_ONBOARD is a landing state. Once a site completes the PLG onboarding flow, its entitlement transitions `PRE_ONBOARD` → `PLG` via the existing `createEntitlement()` upgrade path.
- **Non-breaking**: No changes to existing FREE_TRIAL, PAID, or PLG behavior anywhere.

> **Key principle**: The PRE_ONBOARD tier is invisible to customers and to workers. It is only visible to the API filter layer, which automatically excludes it because it is not in the `CUSTOMER_VISIBLE_TIERS` allow-list.

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement |
|---|---|
| FR-01 | The system shall support a `PRE_ONBOARD` entitlement tier in addition to `FREE_TRIAL`, `PAID`, and `PLG`. |
| FR-02 | PRE_ONBOARD-tier sites shall be operable by all background workers (audit, import, etc.) without modification to those workers. |
| FR-03 | PRE_ONBOARD-tier sites shall return a 404 response on `GET /sites-resolve` regardless of whether a siteId, organizationId, or imsOrg is supplied. |
| FR-04 | PRE_ONBOARD-tier sites shall not appear in `GET /organizations/:organizationId/sites` responses (neither in own sites nor delegated sites). |
| FR-05 | A PRE_ONBOARD-tier entitlement shall be upgradable to `PLG` (and transitively to `PAID`) without data loss or re-enrollment. |
| FR-06 | A PRE_ONBOARD-tier entitlement shall be revocable (not protected like PAID). |
| FR-07 | The PRE_ONBOARD tier shall be enforced as a valid enum value in the database, TypeScript types, and JavaScript model constants. |
| FR-08 | No existing FREE_TRIAL, PAID, or PLG entitlement behavior shall be modified. |
| FR-09 | `getIsSummitPlgEnabled` shall return `false` for PRE_ONBOARD-tier sites. |
| FR-10 | PRE_ONBOARD-tier sites shall be blocked by `validateEntitlement` for LLMO and product-gated endpoints (403 response). |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-01 | The PRE_ONBOARD tier must be introduced via a standard database migration; no manual enum patching. |
| NFR-02 | PRE_ONBOARD exclusion in the API layer is automatic via the `CUSTOMER_VISIBLE_TIERS` allow-list — no explicit deny-list entry or new guard code is needed. |
| NFR-03 | All affected code paths must be covered by unit tests asserting PRE_ONBOARD sites return 404 / empty list / 403. |
| NFR-04 | Changes must be deployed in dependency order: DB → shared lib → API service. The PRE_ONBOARD tier must exist before PLG is added to `CUSTOMER_VISIBLE_TIERS`. |
| NFR-05 | The implementation must not introduce any new API endpoints or schema changes beyond the enum extension. |

### 3.3 Out of Scope

- Changes to `spacecat-audit-worker`, `spacecat-import-worker`, or any other background worker.
- PRE_ONBOARD-specific quota tracking. Note: `createEntitlement()` in `tier-client.js` currently hardcodes `llmo_trial_prompts: 200` for all new entitlements regardless of tier. Whether PRE_ONBOARD entitlements should receive these quotas or be created with null quotas is an open question (see OQ-1).
- Business logic for the PRE_ONBOARD → PLG provisioning step (handled by the PLG onboarding flow, not this change).
- Any customer-facing visibility into PRE_ONBOARD tier status.
- Changes to `CUSTOMER_VISIBLE_TIERS` or `getIsSummitPlgEnabled` (covered in the [PLG tier v2 design document](plg_tier_requirement_and_design.md)).

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
  Upgradable to F_T  │    —     │    NO    │   YES    │      YES       │
  Upgradable to PLG  │    —     │    NO    │    —     │      YES       │
                     └──────────┴──────────┴──────────┴────────────────┘
```

### 4.2 Dependency Chain

Changes must be delivered in the following order:

```
mysticat-data-service       spacecat-shared           spacecat-api-service
  (DB enum addition)     ──▶  (model + tier-client)  ──▶  (no guard changes needed)
```

### 4.3 Data Flow

```
Site enters via PLG motion (pre-onboarding)
        │
        ▼
createEntitlement('PRE_ONBOARD')
  - org gets entitlement record (tier=PRE_ONBOARD)
  - site gets SiteEnrollment record
        │
        ├──▶ Audit Worker: checkValidEntitlement() → entitlement found → runs audit ✓
        │
        ├──▶ API: resolveSite() — siteId path
        │         getAllEnrollment() → entitlement found, tier=PRE_ONBOARD
        │         → tier not in CUSTOMER_VISIBLE_TIERS → return 404 ✗
        │
        ├──▶ API: resolveSite() — orgId / imsOrg paths
        │         getFirstEnrollment() → enrolledSite found, entitlement.tier=PRE_ONBOARD
        │         → tier not in CUSTOMER_VISIBLE_TIERS → return 404 ✗
        │
        ├──▶ API: getSitesForOrganization()
        │         filterSitesForProductCode() / delegated path
        │         → tier=PRE_ONBOARD → not in CUSTOMER_VISIBLE_TIERS → return [] ✗
        │
        ├──▶ API: LLMO endpoints — validateEntitlement() (single chokepoint)
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
```

---

## 5. Design

### 5.1 Repository 1: mysticat-data-service

#### 5.1.1 Database Migration

New migration file: `db/migrations/YYYYMMDDHHMMSS_entitlement_tier_add_pre_onboard.sql`

```sql
-- migrate:up
ALTER TYPE entitlement_tier ADD VALUE 'PRE_ONBOARD';

-- migrate:down
-- PostgreSQL does not support removing enum values; recreation required for rollback.
```

**Constraint**: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block. This is consistent with existing migrations in this repo (e.g., `20260326000000_entitlement_tier_add_plg.sql`).

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
MYSTICAT_ENUMS.entitlement_tier = { FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG' }
```

After:
```typescript
entitlement_tier: 'FREE_TRIAL' | 'PAID' | 'PLG' | 'PRE_ONBOARD'
MYSTICAT_ENUMS.entitlement_tier = { FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD' }
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

No code changes required in `tier-client.js`. The existing logic is already correct for PRE_ONBOARD:

| Method | Behavior with PRE_ONBOARD | Change needed? |
|---|---|---|
| `createEntitlement('PRE_ONBOARD')` | Validates against `ENTITLEMENT_TIERS` enum (will accept PRE_ONBOARD after dependency update). Creates entitlement + enrollment. Hardcodes `llmo_trial_prompts: 200` — see OQ-1. | No (pending OQ-1 resolution) |
| `checkValidEntitlement()` | Returns entitlement regardless of tier. Correct — workers need this. | No |
| `getAllEnrollment()` | Returns entitlement + enrollments regardless of tier. Caller (API layer) must filter. | No |
| `getFirstEnrollment()` | Returns first enrolled site regardless of tier. Caller (API layer) must filter. | No |
| `revokeEntitlement()` | Blocks only PAID tier. PRE_ONBOARD is revocable. | No |
| Upgrade PRE_ONBOARD → PLG | `createEntitlement('PLG')`: current tier (PRE_ONBOARD) is not PAID, so tier is overwritten. | No |
| Upgrade PRE_ONBOARD → PAID | `createEntitlement('PAID')`: same path, PRE_ONBOARD is not PAID, tier is overwritten. | No |

#### 5.2.5 Unit Tests (tier-client)

File: `packages/spacecat-shared-tier-client/test/tier-client.test.js`

New test cases:
- `createEntitlement('PRE_ONBOARD')` creates entitlement with tier=PRE_ONBOARD
- PRE_ONBOARD entitlement can be upgraded to PLG (tier overwritten)
- PRE_ONBOARD entitlement can be upgraded to PAID (tier overwritten)
- `revokeEntitlement()` succeeds for PRE_ONBOARD tier (not blocked like PAID)

---

### 5.3 Repository 3: spacecat-api-service

**No changes to the API guard paths are required.** The PRE_ONBOARD tier is automatically excluded because it is not in `CUSTOMER_VISIBLE_TIERS`. The allow-list pattern works as designed — any tier not explicitly listed is invisible to customers.

#### 5.3.1 Verification of Automatic Exclusion

The following API guard paths already exclude PRE_ONBOARD without any code changes:

| Guard path | File | Mechanism |
|---|---|---|
| `validateEntitlement` | `src/support/access-control-util.js` | `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())` → `false` for PRE_ONBOARD → throws `UnauthorizedProductError` |
| `filterSitesForProductCode` | `src/support/utils.js` | `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())` → `false` → returns `[]` |
| `resolveSite` (siteId path) | `src/controllers/sites.js` | `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())` → `false` → returns 404 |
| `resolveSite` (orgId/imsOrg paths) | `src/controllers/sites.js` | `CUSTOMER_VISIBLE_TIERS.includes(entitlement?.getTier())` → `false` → returns 404 |
| Delegated sites | `src/controllers/organizations.js` | `CUSTOMER_VISIBLE_TIERS.includes(entitlement.getTier())` → `false` → skips org |

#### 5.3.2 `getIsSummitPlgEnabled` — No Change Needed

`getIsSummitPlgEnabled` checks `entitlement?.getTier() === EntitlementModel.TIERS.PLG` (after the v2 PLG change). PRE_ONBOARD naturally returns `false` — the site is not yet in the PLG program until onboarding completes.

#### 5.3.3 API Service Unit Tests

| Test file | New test cases |
|---|---|
| `resolveSite` tests | PRE_ONBOARD-tier site returns 404 for siteId/orgId/imsOrg paths |
| `getSitesForOrganization` tests | PRE_ONBOARD-tier org's own sites excluded; PRE_ONBOARD-tier delegated sites excluded |
| `filterSitesForProductCode` tests | PRE_ONBOARD-tier entitlement returns empty array |
| `validateEntitlement` tests (access-control-util) | PRE_ONBOARD-tier throws UnauthorizedProductError |
| Transition test | `createEntitlement('PRE_ONBOARD')` → site invisible; then `createEntitlement('PLG')` → same site becomes customer-visible with `isSummitPlgEnabled = true` |

All test files should include fixture data with `tier: 'PRE_ONBOARD'` entitlements.

---

## 6. What Does NOT Change

| Component | Reason |
|---|---|
| `spacecat-audit-worker` | Uses `checkValidEntitlement()` → entitlement exists → audit runs. Tier-agnostic. |
| `spacecat-import-worker` | Same as audit worker. |
| `TierClient` core methods | Tier-agnostic by design. Filtering is the API layer's responsibility. |
| `revokeEntitlement()` blocking logic | Already only blocks PAID. PRE_ONBOARD is revocable. |
| `createEntitlement()` upgrade logic | Already allows overwriting non-PAID tiers. PRE_ONBOARD → PLG works as-is. |
| `CUSTOMER_VISIBLE_TIERS` | Not modified by this change. PRE_ONBOARD is excluded by default (not in the allow-list). |
| `getIsSummitPlgEnabled()` | Returns `false` for PRE_ONBOARD naturally (checks PLG tier specifically). |
| All four API guard paths | No code changes. The allow-list pattern automatically excludes PRE_ONBOARD. |
| `user-activities.js` `createActivityForSite` | Queries entitlements directly without a tier filter. PRE_ONBOARD sites will generate activity records, which is acceptable — activity recording is an internal ops signal, not a customer-facing data path. If activity records for PRE_ONBOARD sites are undesirable, this is a separate follow-up. |
| FREE_TRIAL, PAID, PLG tier behavior | Completely unchanged. |
| Any other API endpoint not listed above | Not on entitlement-gated paths or already returns empty for no-entitlement case. |

---

## 7. Verification Criteria

### 7.1 Technical Verification

After all changes are deployed end-to-end:

| Scenario | Expected Result |
|---|---|
| `GET /sites-resolve` with siteId of PRE_ONBOARD site | 404 |
| `GET /sites-resolve` with orgId of PRE_ONBOARD org | 404 |
| `GET /sites-resolve` with imsOrg of PRE_ONBOARD org | 404 |
| `GET /organizations/:id/sites` for PRE_ONBOARD org | `[]` (empty sites list) |
| `GET /organizations/:id/sites` with delegated PRE_ONBOARD org | PRE_ONBOARD org's sites excluded from merged list |
| LLMO endpoint (`GET /sites/:id/llmo/config`) for PRE_ONBOARD site | 403 (validateEntitlement blocks) |
| Audit worker processes PRE_ONBOARD site | Audit runs normally |
| `createEntitlement('PRE_ONBOARD')` then `createEntitlement('PLG')` | Site transitions from invisible to visible; `isSummitPlgEnabled` becomes `true` |
| `createEntitlement('PRE_ONBOARD')` then `createEntitlement('PAID')` | Site transitions from invisible to visible; `isSummitPlgEnabled` remains `false` |
| `revokeEntitlement()` on PRE_ONBOARD entitlement | Entitlement and enrollments deleted |
| `getIsSummitPlgEnabled` for PRE_ONBOARD-tier site | `false` |

### 7.2 Business Success Metrics

| Metric | Target | Owner |
|---|---|---|
| PRE_ONBOARD → PLG conversion rate | TBD by product | PLG onboarding team |
| Median time-in-PRE_ONBOARD before conversion | TBD — threshold for "stuck" site alert | Platform/ops |
| PRE_ONBOARD site abandoned rate (no conversion, no revocation) | TBD | Product |
| PRE_ONBOARD sites stuck > 30 days (monitoring query) | Alert threshold for ops | Platform/ops |

> These targets must be defined before launch. The monitoring query for stuck PRE_ONBOARD sites (see OQ-2) is a prerequisite for the ops alert.

---

## 8. Implementation Plan

> Changes must be applied in the order below. Each repo depends on artifacts from the previous. The PRE_ONBOARD tier must be deployed **before** PLG is added to `CUSTOMER_VISIBLE_TIERS` (see [PLG tier v2 design](plg_tier_requirement_and_design.md) — Phase 3).

### Phase 1 — mysticat-data-service

| # | Task | Notes |
|---|---|---|
| 1.1 | Create migration `YYYYMMDDHHMMSS_entitlement_tier_add_pre_onboard.sql` | Cannot run in transaction block |
| 1.2 | Run `make migrate` + `make generate-ts-types` | Updates `database.types.ts` |
| 1.3 | Tag release `types-ts-vX.Y.Z` | Required by spacecat-shared |

### Phase 2 — spacecat-shared

| # | Task | Notes |
|---|---|---|
| 2.1 | Add `PRE_ONBOARD` to `Entitlement.TIERS` in `entitlement.model.js` | Schema auto-picks it up |
| 2.2 | Update `EntitlementTier` in `index.d.ts` | TypeScript consumers |
| 2.3 | Bump `@mysticat/data-service-types` in `tier-client/package.json` | Points to Phase 1 tag |
| 2.4 | Add unit tests for PRE_ONBOARD in `tier-client.test.js` | create, upgrade to PLG, upgrade to PAID, revoke |
| 2.5 | (Optional) Add PRE_ONBOARD seed row in integration test SQL | For IT coverage |

### Phase 3 — spacecat-api-service

| # | Task | Notes |
|---|---|---|
| 3.1 | Add unit tests confirming PRE_ONBOARD sites return 404/403/[] | No production code changes needed |
| 3.2 | Bump `@adobe/spacecat-shared-data-access` and `@adobe/spacecat-shared-tier-client` | Points to Phase 2 versions |

> **Note**: No changes to `CUSTOMER_VISIBLE_TIERS` or guard logic are needed. PRE_ONBOARD is automatically excluded by the allow-list pattern. The only API service changes are dependency bumps and tests.

### Phase 4 — PLG visibility change (separate)

After PRE_ONBOARD is deployed end-to-end, the PLG tier can be made customer-visible. See [PLG tier v2 design document](plg_tier_requirement_and_design.md) — Phase 3.

---

## 9. Risk & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Workers accidentally skip PRE_ONBOARD sites | Low | High | Workers are tier-agnostic; no change to worker code eliminates this risk |
| PRE_ONBOARD site accidentally exposed via an uncovered API path | Low | High | Allow-list pattern means new tiers are denied by default. No new deny-list code needed. |
| Enum rollback difficulty | Low | Low | Document rollback requires type recreation; acceptable for internal tier |
| Dependency version mismatch (shared not updated) | Medium | High | Phase 2 must be merged and published before Phase 3 PR is merged |
| `createEntitlement('PRE_ONBOARD')` rejected by tier-client | Low | High | Tier-client validates against mysticat types; Phase 1 + 2 together resolves this |
| Stuck PRE_ONBOARD sites consuming worker resources indefinitely | Medium | Medium | Define TTL (OQ-2) and add age-based monitoring alert before launch |
| PLG made customer-visible before PRE_ONBOARD exists | High | High | Deployment ordering is critical: PRE_ONBOARD (this doc) must be deployed before PLG visibility change (PLG v2 doc). Both design docs document this dependency. |

---

## 10. Open Questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | `createEntitlement()` currently hardcodes `llmo_trial_prompts: 200` for all new entitlements. Should PRE_ONBOARD entitlements receive these quotas, or should they be created with null quotas (since the site is not yet customer-visible)? | Product |
| OQ-2 | What is the defined TTL for a PRE_ONBOARD site before it is considered stuck (no conversion to PLG, no revocation)? A 30-day threshold is proposed. This threshold drives the ops monitoring query and alert. | PLG onboarding team |
| OQ-3 | Should `GET /organizations/:id` (the org detail endpoint, not sites) expose the PRE_ONBOARD tier to callers, or should it be filtered? | API/product |
| OQ-4 | Is a monitoring/alerting signal for sites stuck in PRE_ONBOARD tier longer than the TTL (OQ-2) required before launch, or is it a post-launch follow-up? | Platform/ops |
| OQ-5 | Should activity records (`createActivityForSite`) be suppressed for PRE_ONBOARD-tier sites, or is recording activity for internal/pre-provisioning sites acceptable? | Product |
