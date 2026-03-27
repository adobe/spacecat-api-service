# PLG Entitlement Tier — Requirements & Design

## 1. Background & Problem Statement

### 1.1 ASO PLG Onboarding Motion

Spacecat's current entitlement model supports two tiers: `FREE_TRIAL` and `PAID`. Sites exposed through the customer-facing API must carry one of these tiers.

The ASO PLG (Product-Led Growth) motion introduces a new onboarding pathway where sites are ingested into the system **before** they are provisioned as customer-facing entities. During this pre-provisioning window, background workers (audit, import, etc.) must be able to operate on these sites. However, they must not appear in any customer-facing API response.

### 1.2 Current Gaps

The existing architecture does not accommodate this pre-provisioning state cleanly:

| Scenario | Current Behavior | Desired Behavior |
|---|---|---|
| Site enters via PLG motion | No entitlement → workers skip site | Site has entitlement → workers operate normally |
| PLG site queried via API | No entitlement → 404 (correct by accident) | Explicit PLG exclusion → 404 (correct by design) |
| PLG site transitions to FREE_TRIAL/PAID | Not supported as a flow | `createEntitlement()` upgrade path handles this |
| Adding PLG-specific logic in future | No dedicated tier → needs exceptions everywhere | Dedicated PLG tier → clean extension point |

### 1.3 Rejected Alternatives

**Option A — Reuse FREE_TRIAL with a feature flag**: Would require adding gate exceptions across worker and API layers, diluting existing entitlement checks.

**Option B — Create a separate "pre-onboarding" table**: Adds significant data model complexity, duplicate worker logic, and an additional migration surface.

**Option C — Introduce PLG as a new internal tier (selected)**: Clean, backward-compatible, requires no changes to workers, and provides a dedicated extension point for future PLG-specific logic.

---

## 2. Proposal

Introduce `PLG` as a **first-class but internally scoped** entitlement tier:

- **Internal-only**: PLG-tier sites are never surfaced through customer-facing APIs.
- **Worker-transparent**: Background workers (audit, import) continue operating on PLG sites as they do for FREE_TRIAL/PAID — they check entitlement existence, not tier value.
- **Transient**: PLG is a landing state. Once a site completes the PLG onboarding flow, its entitlement transitions PLG → FREE_TRIAL or PAID via the existing `createEntitlement()` upgrade path.
- **Non-breaking**: No changes to existing FREE_TRIAL or PAID behavior anywhere.

> **Key principle**: The PLG tier is invisible to customers and to workers. It is only visible to the API filter layer, which explicitly excludes it.

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement |
|---|---|
| FR-01 | The system shall support a `PLG` entitlement tier in addition to `FREE_TRIAL` and `PAID`. |
| FR-02 | PLG-tier sites shall be operable by all background workers (audit, import, etc.) without modification to those workers. |
| FR-03 | PLG-tier sites shall return a 404 response on `GET /sites-resolve` regardless of whether a siteId, organizationId, or imsOrg is supplied. |
| FR-04 | PLG-tier sites shall not appear in `GET /organizations/:organizationId/sites` responses (neither in own sites nor delegated sites). |
| FR-05 | A PLG-tier entitlement shall be upgradable to `FREE_TRIAL` or `PAID` without data loss or re-enrollment. |
| FR-06 | A PLG-tier entitlement shall be revocable (not protected like PAID). |
| FR-07 | The PLG tier shall be enforced as a valid enum value in the database, TypeScript types, and JavaScript model constants. |
| FR-08 | No existing FREE_TRIAL or PAID entitlement behavior shall be modified. |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-01 | The PLG tier must be introduced via a standard database migration; no manual enum patching. |
| NFR-02 | PLG filtering in the API layer must use the `Entitlement.TIERS.PLG` constant, not a raw string, to prevent drift. |
| NFR-03 | All three affected code paths in the API layer must be covered by unit tests asserting PLG sites return 404 / empty list. |
| NFR-04 | Changes must be deployed in dependency order: DB → shared lib → API service. |
| NFR-05 | The implementation must not introduce any new API endpoints or schema changes beyond the enum extension. |

### 3.3 Out of Scope

- Changes to `spacecat-audit-worker`, `spacecat-import-worker`, or any other background worker.
- PLG-specific quota tracking (quotas remain null for PLG, same as PAID today).
- Business logic for the PLG → FREE_TRIAL/PAID provisioning step (handled by the PLG onboarding flow, not this change).
- Any customer-facing visibility into PLG tier status.

---

## 4. System Architecture

### 4.1 Tier Semantics

```
                     ┌─────────────────────────────────┐
                     │       Entitlement Tier           │
                     ├──────────┬──────────┬────────────┤
                     │FREE_TRIAL│   PAID   │    PLG     │
                     ├──────────┼──────────┼────────────┤
  Customer-facing?   │   YES    │   YES    │    NO      │
  Worker-visible?    │   YES    │   YES    │    YES     │
  Revocable?         │   YES    │ via admin│    YES     │
  Upgradable to PAID │   YES    │    —     │    YES     │
  Upgradable to F_T  │    —     │    NO    │    YES     │
                     └──────────┴──────────┴────────────┘
```

### 4.2 Dependency Chain

Changes must be delivered in the following order:

```
mysticat-data-service       spacecat-shared           spacecat-api-service
      (DB enum)          ──▶  (model + tier-client)  ──▶  (API filter layer)
```

### 4.3 Data Flow

```
PLG Site enters system
        │
        ▼
createEntitlement('PLG')
  - org gets entitlement record (tier=PLG)
  - site gets SiteEnrollment record
        │
        ├──▶ Audit Worker: checkValidEntitlement() → entitlement found → runs audit ✓
        │
        ├──▶ API: resolveSite()
        │         checkValidEntitlement() → entitlement found, tier=PLG → return 404 ✗
        │
        ├──▶ API: getSitesForOrganization()
        │         filterSitesForProductCode() → tier=PLG → return [] ✗
        │
        └──▶ PLG onboarding completes
                  │
                  ▼
             createEntitlement('FREE_TRIAL' | 'PAID')
               - existing entitlement tier overwritten (PLG is non-PAID, so upgrade allowed)
               - SiteEnrollment preserved
                  │
                  ▼
             Site now customer-visible ✓
```

---

## 5. Design

### 5.1 Repository 1: mysticat-data-service

#### 5.1.1 Database Migration

New migration file: `db/migrations/20260326000000_entitlement_tier_add_plg.sql`

```sql
-- migrate:up
ALTER TYPE entitlement_tier ADD VALUE 'PLG';

-- migrate:down
-- PostgreSQL does not support removing enum values; recreation required for rollback.
```

**Constraint**: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block. This is consistent with existing migrations in this repo.

#### 5.1.2 TypeScript Type Regeneration

After migration is applied:

```bash
make migrate
make generate-ts-types
```

Affected file: `clients/typescript/src/database.types.ts`

Before:
```typescript
entitlement_tier: 'FREE_TRIAL' | 'PAID'
MYSTICAT_ENUMS.entitlement_tier = { FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID' }
```

After:
```typescript
entitlement_tier: 'FREE_TRIAL' | 'PAID' | 'PLG'
MYSTICAT_ENUMS.entitlement_tier = { FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG' }
```

**Release**: Tag `types-ts-v1.12.0` (or next available patch).

---

### 5.2 Repository 2: spacecat-shared

#### 5.2.1 Entitlement Model Constants

File: `packages/spacecat-shared-data-access/src/models/entitlement/entitlement.model.js`

```js
static TIERS = {
  FREE_TRIAL: 'FREE_TRIAL',
  PAID: 'PAID',
  PLG: 'PLG',   // new
};
```

The `entitlement.schema.js` derives its allowed values from `Object.values(Entitlement.TIERS)`, so no schema change is needed.

#### 5.2.2 TypeScript Declaration

File: `packages/spacecat-shared-data-access/src/models/entitlement/index.d.ts`

```typescript
export type EntitlementTier = 'FREE_TRIAL' | 'PAID' | 'PLG';
```

#### 5.2.3 Tier-Client Dependency

File: `packages/spacecat-shared-tier-client/package.json`

```json
"@mysticat/data-service-types": "git+https://github.com/adobe/mysticat-data-service.git#types-ts-v1.12.0"
```

#### 5.2.4 Tier-Client Behavioral Analysis

No code changes required in `tier-client.js`. The existing logic is already correct for PLG:

| Method | Behavior with PLG | Change needed? |
|---|---|---|
| `createEntitlement('PLG')` | Validates against `ENTITLEMENT_TIERS` enum (will accept PLG after dependency update). Creates entitlement + enrollment. | No |
| `checkValidEntitlement()` | Returns entitlement regardless of tier. Correct — workers need this. | No |
| `getFirstEnrollment()` | Returns first enrolled site regardless of tier. Caller (API layer) must filter. | No |
| `revokeEntitlement()` | Blocks only PAID tier. PLG is revocable. | No |
| Upgrade PLG → FREE_TRIAL | `createEntitlement('FREE_TRIAL')`: current tier (PLG) is not PAID, so tier is overwritten. | No |
| Upgrade PLG → PAID | `createEntitlement('PAID')`: same path, PLG is not PAID, tier is overwritten. | No |

#### 5.2.5 Unit Tests (tier-client)

File: `packages/spacecat-shared-tier-client/test/tier-client.test.js`

New test cases:
- `createEntitlement('PLG')` creates entitlement with tier=PLG
- PLG entitlement can be upgraded to FREE_TRIAL (tier overwritten)
- PLG entitlement can be upgraded to PAID (tier overwritten)
- `revokeEntitlement()` succeeds for PLG tier (not blocked like PAID)

---

### 5.3 Repository 3: spacecat-api-service

The API service is the **only layer** that enforces PLG invisibility. Three code paths must be updated.

#### 5.3.1 `filterSitesForProductCode` — `src/support/utils.js`

This function gates `GET /organizations/:organizationId/sites`.

Current flow:
1. Call `tierClient.checkValidEntitlement()`
2. If no entitlement → return `[]`
3. Fetch enrollments → filter and return enrolled sites

**Change**: Add PLG check after step 2.

```js
export const filterSitesForProductCode = async (context, organization, sites, productCode) => {
  const { SiteEnrollment } = context.dataAccess;
  const tierClient = TierClient.createForOrg(context, organization, productCode);
  const { entitlement } = await tierClient.checkValidEntitlement();

  if (!isNonEmptyObject(entitlement)) {
    return [];
  }

  // PLG tier is internal-only; not exposed to customers
  if (entitlement.getTier?.() === EntitlementModel.TIERS.PLG) {
    return [];
  }

  const siteEnrollments = await SiteEnrollment.allByEntitlementId(entitlement.getId());
  const enrolledSiteIds = new Set(siteEnrollments.map((se) => se.getSiteId()));
  return sites.filter((site) => enrolledSiteIds.has(site.getId()));
};
```

`EntitlementModel` is already imported in `utils.js`.

#### 5.3.2 `resolveSite` — `src/controllers/sites.js`

Three code paths within `resolveSite`:

**Path 1 — siteId provided** (approx. line 1167):

```js
// Before
if (entitlement && enrollments?.length) {

// After
if (entitlement && entitlement.getTier?.() !== Entitlement.TIERS.PLG && enrollments?.length) {
```

**Path 2 — organizationId provided** (approx. lines 1186–1196):

```js
const { entitlement, site: enrolledSite } = await tierClient.getFirstEnrollment();
if (enrolledSite && entitlement?.getTier?.() !== Entitlement.TIERS.PLG) {
  // ... return enrolledSite
}
```

**Path 3 — imsOrg provided** (approx. lines 1202–1214):

```js
const { entitlement, site: enrolledSite } = await tierClient.getFirstEnrollment();
if (enrolledSite && entitlement?.getTier?.() !== Entitlement.TIERS.PLG) {
  // ... return enrolledSite
}
```

Import `Entitlement` from `@adobe/spacecat-shared-data-access` if not already imported in `sites.js`.

#### 5.3.3 `getSitesForOrganization` — delegated sites path — `src/controllers/organizations.js`

The delegated sites path (approx. lines 228–233) fetches entitlements for target orgs and merges their enrolled sites. Add PLG guard when processing each target org's entitlement:

```js
const entitlement = entitlementResults[i];
if (entitlement && entitlement.getTier?.() !== Entitlement.TIERS.PLG) {
  // ... existing enrollment lookup and site merge
}
```

Import `Entitlement` model in `organizations.js` if not already present.

#### 5.3.4 API Service Unit Tests

| Test file | New test cases |
|---|---|
| `resolveSite` tests | PLG-tier site returns 404 for siteId path; PLG-tier site returns 404 for orgId path; PLG-tier site returns 404 for imsOrg path |
| `getSitesForOrganization` tests | PLG-tier org's own sites excluded; PLG-tier target org's delegated sites excluded |
| `filterSitesForProductCode` tests | PLG-tier entitlement returns empty array |

All three test files should include fixture data with `tier: 'PLG'` entitlements.

---

## 6. What Does NOT Change

| Component | Reason |
|---|---|
| `spacecat-audit-worker` | Uses `checkValidEntitlement()` → entitlement exists → audit runs. Tier-agnostic. |
| `spacecat-import-worker` | Same as audit worker. |
| `TierClient` core methods | Tier-agnostic by design. Filtering is the API layer's responsibility. |
| `revokeEntitlement()` blocking logic | Already only blocks PAID. PLG is revocable. |
| `createEntitlement()` upgrade logic | Already allows overwriting non-PAID tiers. PLG → FREE_TRIAL/PAID works as-is. |
| PLG onboarding flow (provisioner) | Transition logic is external to this change. |
| Any other API endpoint not listed above | Not on entitlement-gated paths or already returns empty for no-entitlement case. |

---

## 7. Verification Criteria

After all changes are deployed end-to-end:

| Scenario | Expected Result |
|---|---|
| `GET /sites-resolve` with siteId of PLG site | 404 |
| `GET /sites-resolve` with orgId of PLG org | 404 |
| `GET /sites-resolve` with imsOrg of PLG org | 404 |
| `GET /organizations/:id/sites` for PLG org | `[]` (empty sites list) |
| `GET /organizations/:id/sites` with delegated PLG org | PLG org's sites excluded from merged list |
| Audit worker processes PLG site | Audit runs normally |
| `createEntitlement('PLG')` then `createEntitlement('FREE_TRIAL')` | Site visible in API after transition |
| `createEntitlement('PLG')` then `createEntitlement('PAID')` | Site visible in API after transition |
| `revokeEntitlement()` on PLG entitlement | Entitlement and enrollments deleted |

---

## 8. Implementation Plan

> Changes must be applied in the order below. Each repo depends on artifacts from the previous.

### Phase 1 — mysticat-data-service

| # | Task | Notes |
|---|---|---|
| 1.1 | Create migration `20260326000000_entitlement_tier_add_plg.sql` | Cannot run in transaction block |
| 1.2 | Run `make migrate` + `make generate-ts-types` | Updates `database.types.ts` |
| 1.3 | Tag release `types-ts-v1.12.0` | Required by spacecat-shared |

### Phase 2 — spacecat-shared

| # | Task | Notes |
|---|---|---|
| 2.1 | Add `PLG` to `Entitlement.TIERS` in `entitlement.model.js` | Schema auto-picks it up |
| 2.2 | Update `EntitlementTier` in `index.d.ts` | TypeScript consumers |
| 2.3 | Bump `@mysticat/data-service-types` in `tier-client/package.json` | Points to Phase 1 tag |
| 2.4 | Add unit tests for PLG in `tier-client.test.js` | create, upgrade, revoke |
| 2.5 | (Optional) Add PLG seed row in integration test SQL | For IT coverage |

### Phase 3 — spacecat-api-service

| # | Task | Notes |
|---|---|---|
| 3.1 | Add PLG exclusion to `filterSitesForProductCode` in `utils.js` | Uses existing import |
| 3.2 | Add PLG exclusion to `resolveSite` (3 paths) in `sites.js` | Import `Entitlement` if needed |
| 3.3 | Add PLG exclusion to delegated sites in `organizations.js` | Import `Entitlement` if needed |
| 3.4 | Add unit tests for all three code paths | Fixtures with PLG entitlements |

---

## 9. Risk & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Workers accidentally skip PLG sites | Low | High | Workers are tier-agnostic; no change to worker code eliminates this risk |
| PLG site accidentally exposed via a 4th API path | Medium | Medium | Code search for all `checkValidEntitlement` / `getFirstEnrollment` call sites before shipping |
| Enum rollback difficulty | Low | Low | Document rollback requires type recreation; acceptable for internal tier |
| Dependency version mismatch (shared not updated) | Medium | High | Phase 2 must be merged and published before Phase 3 PR is merged |
| `createEntitlement('PLG')` rejected by tier-client | Low | High | Tier-client validates against mysticat types; Phase 1 + 2 together resolves this |

---

## 10. Open Questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | Should a PLG entitlement carry any quotas (e.g., audit run limits during pre-onboarding)? | Product |
| OQ-2 | Is there a defined SLA for how long a site can remain in PLG state before onboarding completes or the entitlement is revoked? | PLG onboarding team |
| OQ-3 | Should `GET /organizations/:id` (the org detail endpoint, not sites) expose the PLG tier to callers? | API/product |
| OQ-4 | Do we need a monitoring/alerting signal for sites stuck in PLG tier longer than expected? | Platform/ops |
