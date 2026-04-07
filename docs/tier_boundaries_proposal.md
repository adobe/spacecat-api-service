# Entitlement Tier Boundaries — Proposal

## Purpose

This document defines clear, non-overlapping boundaries for the four entitlement tiers:
`PRE_ONBOARD`, `PLG`, `FREE_TRIAL`, and `PAID`. It is not an implementation plan. Its
goal is to answer the question: **what is each tier for, and what makes each one
categorically different from the others?**

The driver is that `PLG` and `FREE_TRIAL` currently lack meaningful differentiation.
Both are customer-visible, both are revocable, and both allow LLMO access once
`CUSTOMER_VISIBLE_TIERS` includes `PLG`. Without explicit capability boundaries, they
become two names for the same thing.

---

## 1. What the Code Currently Tells Us

### 1.1 Observed tier-differentiated behavior (current state)

| Behavior | PRE_ONBOARD | PLG | FREE_TRIAL | PAID |
|---|---|---|---|---|
| Customer-facing API | NO | NO (today) | YES | YES |
| Workers operate | YES | YES | YES | YES |
| Login JWT includes tenant | NO | NO (today) | YES | YES |
| `subServices` in JWT | — | — | `auto_suggest`, `auto_fix` (hardcoded) | From IMS product context |
| `isSummitPlgEnabled` flag | NO | NO (today) | YES (current check) | NO |
| `TrialUser` record created on access | NO | NO | YES | NO |
| `llmo_trial_prompts` quota created | YES (all tiers, hardcoded) | YES | YES | YES |
| Max enrolled sites per org | none (internal) | **quota field** (proposed) | none enforced | none enforced |
| Audit run frequency cap | none (workers decide) | **quota field** (proposed) | none enforced | none enforced |
| Revocable without admin | YES | YES | YES | NO |
| Upgrade blocked if current is PAID | YES | YES | YES | — |
| IMS product context required for PAID access | — | — | NO | YES |
| Summit-PLG config handler enrollment | NO | NO | YES (PLG onboarding flow) | NO |

**Key observations from the code:**

1. **`login.js` line 202–204**: Only `FREE_TRIAL` gets `auto_suggest`/`auto_fix` sub-services
   injected into the JWT when there is no IMS product context. `PLG` gets nothing if there is
   no product context — it would behave identically to a paid org with no license.

2. **`utils.js` line 627**: `getIsSummitPlgEnabled` checks `FREE_TRIAL` today. This is the
   primary runtime differentiator between a PLG-onboarded customer and a PAID customer.

3. **`plg-onboarding.js` line 53**: The PLG onboarding flow creates a `FREE_TRIAL` entitlement,
   not a `PLG` one. `PLG` tier exists in the model but is not yet assigned by any flow.

4. **`access-control-util.js` line 149–163**: `TrialUser` record creation is gated on
   `FREE_TRIAL` specifically. This tracks the trial user lifecycle (email, status, last seen).

5. **`tier-client.js` line 178–180**: `llmo_trial_prompts: 200` quota is hardcoded for all
   new entitlements regardless of tier — no distinction exists at creation time.

6. **`login.js` line 177–179**: `PAID` tier with no IMS product context throws
   `NO_ACCESS_TO_PRODUCT_ERROR`. Neither `FREE_TRIAL` nor `PLG` has this gate.

---

## 2. The Core Problem: PLG vs FREE_TRIAL

Both tiers are intended to be customer-visible and revocable. Without explicit separation,
the system has no way to enforce or observe any behavioral difference between them. The
code already has `FREE_TRIAL`-specific logic in three places (JWT sub-services, summit-plg
check, TrialUser creation). If `PLG` is customer-visible without equivalent gating, it
becomes either a clone of `FREE_TRIAL` or an untracked gap.

The question that must be answered before any implementation: **what does a PLG customer
get that a FREE_TRIAL customer does not (or vice versa)?**

---

## 3. Proposed Tier Boundaries

### 3.1 `PRE_ONBOARD` — Internal pre-provisioning state

**Purpose**: Allow background workers to operate on a site before the customer ever sees it.
Bought time for the system to prepare data (audits, brand profiles, opportunities) so the
customer's first login is populated rather than empty.

**Entry**: Created by the PLG onboarding provisioner when a site is ingested.

**Exit**: Overwritten to `PLG` when onboarding completes and the site is ready for the customer.

**Capability boundary**:
- Not customer-facing. Zero API surface.
- No JWT tenant. The customer cannot log in to this org's data.
- No TrialUser record.
- No summit-plg handler, no auto-suggest/auto-fix sub-services.
- Workers (audit, import, brand) operate normally — entitlement presence is the gate, not tier.

**What makes it distinct**: It is the only tier where the customer has zero visibility and
zero access. It is a preparation state, not a product state.

---

### 3.2 `PLG` — Self-service onboarded customer, pre-conversion

**Purpose**: Represent a customer who completed the PLG onboarding journey and is actively
using the product in a self-service capacity, without a sales-led contract.

**Entry**: Overwritten from `PRE_ONBOARD` by the provisioner when onboarding completes.

**Exit**: Upgraded to `FREE_TRIAL` (converts to traditional trial) or `PAID` (converts to
licensed customer). Both paths are non-destructive — entitlement tier is overwritten, site
enrollment is preserved.

**Capability boundary (proposed)**:
- Customer-facing. Visible in all API responses.
- JWT tenant included. Customer can log in.
- **`isSummitPlgEnabled = true`**: The PLG-specific UI/UX experience is active. This is the
  primary behavioral differentiator from FREE_TRIAL.
- **Sub-services**: `auto_suggest` and `auto_fix` (same as FREE_TRIAL) — PLG customers should
  have access to the core suggestion and fix capabilities.
- **No TrialUser record**: PLG customers entered through the PLG motion, not through a
  traditional self-service trial signup. Tracking them in the TrialUser table would conflate
  two distinct acquisition motions.
- **`llmo_trial_prompts` quota**: Should be explicitly set for PLG. Whether PLG customers
  share the `200` trial quota or have a distinct limit is a product decision (see OQ-1).
- **`max_enrolled_sites` quota**: PLG orgs are capped at a defined number of enrolled sites
  (proposed default: 1, see OQ-6). Enforced at enrollment creation time in
  `TierClient.createEntitlement()` — before creating a new `SiteEnrollment`, check
  `SiteEnrollment.allByEntitlementId(entitlement.getId()).length` against
  `entitlement.getQuotas().max_enrolled_sites`. PAID and FREE_TRIAL have no cap.
- **`max_audit_runs_per_day` quota**: PLG sites are restricted to a defined number of
  on-demand audit runs per day per site (proposed default: 3, see OQ-7). Enforced at the
  audit trigger layer by checking recent `Audit` records for the site within a rolling 24-hour
  window before queuing a new run. Workers processing scheduled audits are unaffected — only
  customer-triggered on-demand runs are subject to this cap. PAID and FREE_TRIAL have no cap.
- Revocable without admin.

**What makes it distinct from FREE_TRIAL**:

| Dimension | PLG | FREE_TRIAL |
|---|---|---|
| Acquisition motion | PLG onboarding flow (automated) | Traditional trial signup (sales/marketing) |
| `isSummitPlgEnabled` | **YES** | NO |
| TrialUser record | **NO** | YES |
| Summit-PLG UI experience | **YES** | NO |
| Max enrolled sites | **Capped** (`max_enrolled_sites` quota) | Uncapped |
| On-demand audit runs/day | **Capped** (`max_audit_runs_per_day` quota) | Uncapped |
| Entry path | `PRE_ONBOARD → PLG` | Direct creation via `createEntitlement('FREE_TRIAL')` |
| Conversion path | `PLG → FREE_TRIAL` or `PLG → PAID` | `FREE_TRIAL → PAID` |

**What makes it distinct from PAID**:
- No IMS product context required for login.
- Revocable without admin.
- `isSummitPlgEnabled` is true for PLG, false for PAID (PAID customers have a full contract
  and do not need the PLG conversion experience).

---

### 3.3 `FREE_TRIAL` — Traditional self-service trial

**Purpose**: Represent a customer who signed up for a time-limited trial through the
traditional marketing/sales motion, not through the PLG automated flow.

**Entry**: Direct creation by sales or marketing tooling. Also the landing tier for
Slack-based onboarding (`/onboard-site` command, default tier in `utils.js`).

**Exit**: Upgraded to `PAID` via license purchase.

**Capability boundary**:
- Customer-facing. Visible in all API responses.
- JWT tenant included with `auto_suggest` and `auto_fix` sub-services (hardcoded in
  `login.js` when no IMS product context exists).
- **TrialUser record created** on first LLMO access via `validateEntitlement`. Tracks email,
  status (REGISTERED → ACTIVE), and last-seen timestamp for trial lifecycle management.
- **`isSummitPlgEnabled = false`**: This is not a PLG customer. They should not see the
  PLG-specific summit experience.
- `llmo_trial_prompts: 200` quota (current behavior).
- Revocable without admin.

**What makes it distinct from PLG**:
- TrialUser lifecycle tracking applies.
- No `isSummitPlgEnabled`.
- Entry is through traditional flows, not the automated PLG provisioner.
- A FREE_TRIAL customer has never been through `PRE_ONBOARD`.

---

### 3.4 `PAID` — Licensed customer

**Purpose**: Represent a customer with a formal commercial contract.

**Entry**: Either directly created by the provisioning system or upgraded from `FREE_TRIAL`
or `PLG` via `createEntitlement('PAID')`.

**Exit**: Revocable only by admin via `revokePaidEntitlement()` (separate from
`revokeEntitlement()` which blocks PAID).

**Capability boundary**:
- Customer-facing.
- JWT tenant included with sub-services from IMS product context (not hardcoded). If no
  IMS product context exists, `login.js` throws `NO_ACCESS_TO_PRODUCT_ERROR` — PAID
  requires a valid license in IMS.
- No TrialUser tracking.
- No `isSummitPlgEnabled` — PAID customers have a full contract and are not in a conversion
  funnel.
- Revocation requires admin action (protected by tier-client's `revokeEntitlement` block).

---

## 4. Boundary Summary

```
                    PRE_ONBOARD     PLG             FREE_TRIAL      PAID
───────────────────────────────────────────────────────────────────────
Customer-facing?         NO          YES              YES             YES
JWT tenant               NO          YES              YES             YES
Auto sub-services        —           YES (*)          YES             From IMS
isSummitPlgEnabled       NO          YES              NO              NO
TrialUser tracking       NO          NO               YES             NO
Max enrolled sites       —           Capped (**)      Uncapped        Uncapped
On-demand audit runs/day —           Capped (***)     Uncapped        Uncapped
Entry path           Provisioner  PRE_ONBOARD→    Direct/Slack     Any→PAID
                                    PLG
Exit path              →PLG       →FREE_TRIAL      →PAID           Admin only
                                    or PAID
Revocable           YES (auto)    YES (auto)       YES (auto)      Admin only
IMS context gate         NO          NO               NO              YES
───────────────────────────────────────────────────────────────────────
(*)   Sub-services for PLG need product decision — see OQ-1
(**)  Proposed default: 1 site — see OQ-6
(***) Proposed default: 3 on-demand runs/day — see OQ-7
```

---

## 5. Where This Requires Code Alignment

The following behaviors currently diverge from the proposed boundaries. These are not
implementation tasks for this document — they are the gaps that must be closed in
implementation PRs.

| Location | Current behavior | Required change |
|---|---|---|
| `login.js` line 202 | Sub-services injected only for `FREE_TRIAL`, nothing for `PLG` | Also inject `auto_suggest`/`auto_fix` for `PLG` tier |
| `utils.js` line 627 | `getIsSummitPlgEnabled` checks `FREE_TRIAL` | Change to check `PLG` |
| `plg-onboarding.js` line 53 | Creates `FREE_TRIAL` entitlement | Change to create `PRE_ONBOARD`, then transition to `PLG` on completion |
| `access-control-util.js` line 149 | `TrialUser` created for `FREE_TRIAL` | No change needed — `PLG` must not trigger this |
| `tier-client.js` line 178 | `llmo_trial_prompts: 200` hardcoded for all tiers | Depends on OQ-1 resolution |
| `tier-client.js` `createEntitlement` | No `max_enrolled_sites` or `max_audit_runs_per_day` fields set | Add these quota fields when tier is `PLG` |
| `tier-client.js` `createEntitlement` | No enrollment count check before creating `SiteEnrollment` | Before creating enrollment for `PLG` tier, check current count against `max_enrolled_sites` quota; reject if exceeded |
| Audit trigger layer (api-service) | No per-site daily run cap | For `PLG` tier, count audit records within rolling 24h window; reject on-demand trigger if `max_audit_runs_per_day` exceeded |
| `CUSTOMER_VISIBLE_TIERS` | Contains `FREE_TRIAL`, `PAID` only | Add `PLG` |

---

## 6. Open Questions (Product Decisions Required)

| # | Question | Impact |
|---|---|---|
| OQ-1 | Should PLG customers have the same `llmo_trial_prompts: 200` quota as FREE_TRIAL, a different limit, or unlimited? | Drives tier-client `createEntitlement` change |
| OQ-2 | Can a PLG customer be downgraded to FREE_TRIAL (`PLG → FREE_TRIAL`), or is the only forward path `PLG → PAID`? If FREE_TRIAL is a less capable tier, downgrading would remove TrialUser tracking retroactively. | Drives whether `PLG → FREE_TRIAL` is a valid transition |
| OQ-3 | When a PLG customer converts to PAID, does `isSummitPlgEnabled` become false immediately, or is there a grace period? | Affects summit-plg handler enrollment logic |
| OQ-4 | Should FREE_TRIAL customers who entered the PLG flow (currently created as FREE_TRIAL by `plg-onboarding.js`) be retroactively migrated to PLG tier, or do they remain FREE_TRIAL permanently? | Drives the data migration scope before going live |
| OQ-5 | Is there a defined time-to-live for `PRE_ONBOARD` sites that never convert? | Drives monitoring and cleanup runbook |
| OQ-6 | What is the `max_enrolled_sites` limit for a PLG org? Proposed: 1 (single site per PLG journey). If a customer legitimately owns multiple sites at the PLG stage, this needs a higher value or a per-org override mechanism. | Drives the quota value written to the entitlement at creation; also determines whether a per-org override is needed |
| OQ-7 | What is the `max_audit_runs_per_day` limit for a PLG site? Proposed: 3 on-demand triggers per site per rolling 24h window. This does not affect scheduled worker runs — only customer-initiated triggers (e.g. via the UI or API). | Drives enforcement logic at the audit trigger layer; also determines whether the limit should be configurable per site |
