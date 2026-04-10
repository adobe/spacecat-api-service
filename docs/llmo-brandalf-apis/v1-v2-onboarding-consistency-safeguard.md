# LLMO v1 / v2 (Brandalf) Onboarding Mode Resolution

**Jira:** [LLMO-4176](https://jira.corp.adobe.com/browse/LLMO-4176)
**Epic:** [LLMO-4054 — Brandalf GA (Brandalf v1 fast follows)](https://jira.corp.adobe.com/browse/LLMO-4054)
**Status:** Proposal / implementation plan

## Problem

We currently have no safeguard preventing customers from being onboarded into both
v1 and v2 (Brandalf) flows within the same organization. Today the v1 vs v2
decision is made purely from the org-level `brandalf` feature flag — so a
pre-existing v1 customer that later gets `brandalf=true` (or a new site
onboarded after the flag is flipped) ends up with a mix of v1 and v2 sites in
one org, which is hard to recover from.

We want a **simple, deterministic rule** that decides v1 vs v2 at onboarding
time based on whether the customer existed before Brandalf GA, without
requiring any new admin guardrails on the feature-flag endpoints.

## The rule

At onboarding time, when `performLlmoOnboarding` resolves the mode for an org:

```
if org has FF brandalf == true:
    → v2
else if org has any sites onboarded before 2026-04-01:
    → v1   (legacy customer — keep them on v1)
else:
    → v2   (new customer — default to v2)
```

In words:

- **Legacy customers** (any site in the org was onboarded before the Brandalf GA
  cutoff of 2026-04-01) stay on **v1** unless an operator has explicitly opted
  them in by setting `brandalf=true`.
- **Brand-new customers** (no sites in the org predate the cutoff) go to **v2**
  by default.
- The `brandalf` feature flag remains an explicit override that always wins.

The cutoff date `2026-04-01` is encoded as a constant
(`LLMO_BRANDALF_GA_DATE`) so it can be tweaked without hunting through the
codebase.

### Why this works

- It's a single check inside `resolveLlmoOnboardingMode`, with no second
  endpoint to guard.
- It is **idempotent**: re-running onboarding for the same org always picks the
  same mode.
- It does not depend on per-site markers — `Site.allByOrganizationId` plus
  `site.getCreatedAt()` is enough.
- It is **automatically consistent** for an org's lifetime: once the org has at
  least one pre-cutoff site, every subsequent onboarding for that org returns
  v1 (unless `brandalf=true` is set), so the org can never drift into a mixed
  state via the onboarding flow.
- Existing v2 customers (onboarded after the cutoff) are unaffected — they have
  no pre-cutoff sites, so the new branch is a no-op for them.

### What it does **not** do

- It does **not** retroactively migrate v1 sites to v2.
- It does **not** prevent an admin from setting `brandalf=true` on a legacy
  org. If they do, the next onboarding will go to v2 — this is the intentional
  opt-in path. (We accept the residual risk: an admin who sets the flag is
  responsible for the outcome.)
- It does **not** add a flag-flip guard on
  `PUT/DELETE /organizations/:id/feature-flags/LLMO/brandalf`. The original
  plan had one; we are dropping it in favor of the simpler rule above.

## Background — how the flow works today

There is **only one onboarding entry point**:
[`performLlmoOnboarding`](../../src/controllers/llmo/llmo-onboarding.js) is called
from both `POST /llmo/onboard` and the Slack `/onboard-llmo` flow. The v1 vs v2
decision is made early in that function by
[`resolveLlmoOnboardingMode`](../../src/support/llmo-onboarding-mode.js), which
today reads only the `brandalf` row in the `feature_flags` table:

- `brandalf = true`  → mode `v2`
- `brandalf = false` → mode `v1`
- row missing       → mode falls back to `LLMO_ONBOARDING_DEFAULT_VERSION`

The change in this plan is to add a third input to that function: the
`createdAt` timestamps of the org's existing sites.

## Design

### Helper — `hasPreBrandalfSites`

New helper, exported from `src/support/llmo-onboarding-mode.js`:

```js
export const LLMO_BRANDALF_GA_DATE = new Date('2026-04-01T00:00:00Z');

/**
 * Returns true if the organization has any site whose createdAt is strictly
 * before LLMO_BRANDALF_GA_DATE. Treats missing/invalid createdAt as "not
 * pre-cutoff" to avoid false positives.
 */
export async function hasPreBrandalfSites(organizationId, context) {
  const { Site } = context.dataAccess;
  const sites = await Site.allByOrganizationId(organizationId);
  return sites.some((s) => {
    const createdAt = s.getCreatedAt?.();
    if (!createdAt) return false;
    const ts = createdAt instanceof Date ? createdAt : new Date(createdAt);
    return !Number.isNaN(ts.getTime()) && ts < LLMO_BRANDALF_GA_DATE;
  });
}
```

### Updated `resolveLlmoOnboardingMode`

```js
export async function resolveLlmoOnboardingMode(organizationId, context) {
  const { log = console } = context || {};
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;

  // 1. Explicit override always wins.
  try {
    const override = await readBrandalfFlagOverride(organizationId, postgrestClient);
    if (override === true)  return LLMO_ONBOARDING_MODE_V2;
    if (override === false) return LLMO_ONBOARDING_MODE_V1;
  } catch (error) {
    log.warn(
      `Failed to resolve brandalf feature flag for organization ${organizationId}: ${error.message}`,
    );
  }

  // 2. Legacy customers (any site predates the GA cutoff) stay on v1.
  try {
    if (await hasPreBrandalfSites(organizationId, context)) {
      return LLMO_ONBOARDING_MODE_V1;
    }
  } catch (error) {
    log.warn(
      `Failed to check pre-Brandalf sites for organization ${organizationId}: ${error.message}`,
    );
  }

  // 3. Default for new customers.
  const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;
  const defaultMode = normalizeLlmoOnboardingMode(configuredDefault);
  if (configuredDefault && configuredDefault !== defaultMode) {
    log.warn(
      `Invalid LLMO_ONBOARDING_DEFAULT_VERSION "${configuredDefault}", falling back to ${defaultMode}`,
    );
  }
  return defaultMode;
}
```

No changes to `performLlmoOnboarding` itself, no changes to the
feature-flags controller, no new error type — the rule is entirely contained in
mode resolution.

### Flow diagram

```
performLlmoOnboarding
        │
        ▼
resolveLlmoOnboardingMode
        │
        ▼
┌────────────────────────┐
│ brandalf flag set?     │
└────────────────────────┘
   │ true        │ false / null
   ▼             ▼
  v2     ┌────────────────────────────┐
         │ org has any site created   │
         │ before 2026-04-01?         │
         └────────────────────────────┘
            │ yes       │ no
            ▼           ▼
            v1          v2 (default)
```

## Tests

### Unit tests — `test/support/llmo-onboarding-mode.test.js`

Add to the existing file:

- `resolveLlmoOnboardingMode`
  - `brandalf=true` → `v2` regardless of site history (existing test).
  - `brandalf=false` → `v1` regardless of site history (existing test).
  - `brandalf` row missing, org has a site with `createdAt = 2026-03-31` → `v1`.
  - `brandalf` row missing, org has a site with `createdAt = 2026-04-01` → `v2`
    (cutoff is exclusive — `<`, not `<=`).
  - `brandalf` row missing, org has a site with `createdAt = 2026-05-01` → `v2`.
  - `brandalf` row missing, org has no sites → `v2` (default).
  - `brandalf` row missing, org has multiple sites, one of which is pre-cutoff
    → `v1`.
  - Site with missing/invalid `createdAt` does not trip the legacy branch.
  - `Site.allByOrganizationId` throws → falls back to default, logs warning,
    does not throw out of `resolveLlmoOnboardingMode`.

- `hasPreBrandalfSites` (focused tests)
  - returns `false` for an org with no sites.
  - returns `true` when at least one site predates the cutoff.
  - returns `false` when all sites are at or after the cutoff.
  - returns `false` for sites with `null`/`undefined`/invalid `createdAt`.

### Integration tests — `test/it/`

Add to `test/it/shared/tests/llmo-onboarding.js` /
`test/it/postgres/llmo-onboarding.test.js`:

- Seed an org with one site `created_at = 2026-03-15`, no `brandalf` flag
  row. `POST /llmo/onboard` for a new site → site is created via the **v1**
  branch (assert no v2 customer-config row was written, no Brandalf job
  triggered).
- Seed an org with one site `created_at = 2026-05-15`, no `brandalf` flag
  row. `POST /llmo/onboard` → **v2** branch (assert v2 customer-config row
  exists, `brandalf=true` is set on the org by the onboarding flow as today).
- Seed an org with one site `created_at = 2026-03-15` **and** `brandalf=true`
  → onboarding still goes through **v2** (explicit override wins).
- Seed a brand-new org with no sites → onboarding goes through **v2**
  (default).

Add seed data under `test/it/postgres/seed-data/` and register in
`postgres/seed.js` per the project conventions.

## Monitoring

Goal from the original Slack thread: *"need to do monitoring to check if there
is orgs which have sites onboarded with v1 and v2"*. Still in scope.

Add a one-shot read-only script (under `src/scripts/` or
`test/it/test_script/`) that:

1. Lists all organizations.
2. For each, reads the current `brandalf` flag via `readBrandalfFlagOverride`.
3. Lists sites via `Site.allByOrganizationId(orgId)`.
4. Cross-references with the v2 customer-config table populated by
   `ensureInitialCustomerConfigV2`. A site that has an `llmoConfig` but **no**
   corresponding v2 customer-config row is treated as v1.
5. Reports orgs where the set is mixed.

Output is a CSV/JSON file for manual remediation. The script is **read-only**.

## OpenAPI

No OpenAPI changes are required for the rule itself — the request/response
shapes of `POST /llmo/onboard` and the feature-flags endpoints are unchanged.

## Open questions

1. **Cutoff date.** Plan uses `2026-04-01T00:00:00Z`. Confirm this matches the
   actual Brandalf GA date.
2. **Cutoff inclusivity.** Plan treats it as **exclusive** (`createdAt <
   2026-04-01` ⇒ legacy). A site created exactly at midnight UTC on
   2026-04-01 is treated as a v2 customer. Confirm.
3. **Configurability.** Should `LLMO_BRANDALF_GA_DATE` be an env var
   (`LLMO_BRANDALF_GA_DATE`) so we can change it without a deploy? Plan
   defaults to a hard-coded constant for simplicity; happy to switch to env.
4. **Existing inconsistent orgs.** The monitoring script will list them; the
   plan does not auto-remediate. Is that the right call?

## Implementation order

1. Add `LLMO_BRANDALF_GA_DATE` constant + `hasPreBrandalfSites` helper to
   `src/support/llmo-onboarding-mode.js`, and update
   `resolveLlmoOnboardingMode` to use it.
2. Extend `test/support/llmo-onboarding-mode.test.js` with the new cases.
3. Add integration tests in `test/it/` with seed data covering the four
   scenarios above.
4. Add the monitoring script and run it once against stage to confirm output
   format.
5. Open PR with title:
   `feat(LLMO-4176): default legacy LLMO orgs to v1 onboarding by createdAt`,
   linking back to LLMO-4176 and the parent epic LLMO-4054.

## Changes vs the previous version of this plan

The earlier draft of this document proposed two coordinated guards (an
onboarding-time consistency check **and** a flag-flip guard on the
feature-flags controller) plus a new helper module
`llmo-onboarding-consistency.js`. That has been **dropped** in favor of the
single rule above. Reasons:

- Simpler: one function, one branch, no new module, no new error type, no new
  HTTP response codes to document.
- Equivalent in practice for the cases that matter: legacy customers stay on
  v1 by default; new customers go to v2 by default; the explicit `brandalf`
  override still works for both directions.
- Avoids hard-blocking the admin feature-flag endpoints, which keeps the
  operational escape hatch intact.
