# LLMO v1 / v2 (Brandalf) Onboarding Mode Resolution

**Jira:** [LLMO-4176](https://jira.corp.adobe.com/browse/LLMO-4176)
**Epic:** [LLMO-4054 — Brandalf GA (Brandalf v1 fast follows)](https://jira.corp.adobe.com/browse/LLMO-4054)
**Status:** Proposal / implementation plan
**Lifetime:** **Temporary.** This rule is a stop-gap to keep new and legacy
customers from drifting into a mixed v1/v2 state. It should be **removed once
all v1 customers have been migrated to v2**, at which point
`resolveLlmoOnboardingMode` collapses to "always v2" and both
`LLMO_ONBOARDING_DEFAULT_VERSION` and `LLMO_BRANDALF_GA_CUTOFF_MS` can be
deleted.

## Problem

We currently have no safeguard preventing customers from being onboarded into both
v1 and v2 (Brandalf) flows within the same organization. Today the v1 vs v2
decision is made purely from the org-level `brandalf` feature flag — so a
pre-existing v1 customer that later gets `brandalf=true` (or a new site
onboarded after the flag is flipped) ends up with a mix of v1 and v2 sites in
one org, which is hard to recover from.

We want a **simple, deterministic rule** that decides v1 vs v2 at onboarding
time based purely on whether the customer existed before Brandalf GA.

## The rule

At onboarding time, when `performLlmoOnboarding` resolves the mode for an org:

```
defaultMode = normalize(env.LLMO_ONBOARDING_DEFAULT_VERSION) || v2

if defaultMode == v1:
    → v1                                        # global override: everyone on v1
else:
    if org has any sites onboarded before LLMO_BRANDALF_GA_CUTOFF_MS:
        → v1                                    # legacy customer — keep them on v1
    else:
        → v2                                    # new customer — default to v2
```

In words:

- The **environment-level default** (`LLMO_ONBOARDING_DEFAULT_VERSION`) is
  still honored. If it is set to `v1`, every onboarding goes to v1 regardless
  of the org's history (this is the "kill switch" if v2 has to be disabled
  globally).
- If the default is `v2` (the normal state), we still **protect legacy
  customers**: any org that already has at least one site onboarded before
  `LLMO_BRANDALF_GA_CUTOFF_MS` is forced onto **v1**, so onboarding a new
  site for an existing v1 customer never silently switches them to v2.
- **Brand-new customers** (no sites in the org predate the cutoff, including
  orgs with no sites at all) go to **v2**.

The cutoff is a **Unix epoch timestamp in milliseconds**, supplied via the
environment variable `LLMO_BRANDALF_GA_CUTOFF_MS`, so it can be tweaked
without a code change or full redeployment (Lambda env-var update is enough).
A reasonable default — e.g. `1743465600000` (`2026-04-01T00:00:00Z`) — is
hard-coded as a fallback in case the env var is missing or unparseable, so
the function never fails closed.

### Why this works

- It is a single check inside `resolveLlmoOnboardingMode`, with no second
  endpoint to guard.
- It is **idempotent**: re-running onboarding for the same org always picks
  the same mode.
- It does not depend on per-site markers — `Site.allByOrganizationId` plus
  `site.getCreatedAt()` is enough.
- It is **automatically consistent** for an org's lifetime: once the org has
  at least one pre-cutoff site, every subsequent onboarding for that org
  returns v1, so the org can never drift into a mixed state via the
  onboarding flow.
- Existing v2 customers (onboarded after the cutoff) are unaffected — they
  have no pre-cutoff sites, so the new branch is a no-op for them.

### What it does **not** do

- It does **not** retroactively migrate v1 sites to v2.
- It does **not** read or write the `brandalf` feature flag during mode
  resolution. The flag is no longer an input to `resolveLlmoOnboardingMode`.
  `performLlmoOnboarding` will still **set** `brandalf=true` after a
  successful v2 onboarding (so downstream consumers like the DRS scheduler
  continue to work), but it is no longer used to **decide** the mode.
- It does **not** add a flag-flip guard on
  `PUT/DELETE /organizations/:id/feature-flags/LLMO/brandalf`.

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

The change in this plan replaces that input entirely with the `createdAt`
timestamps of the org's existing sites.

## Design

### Helper — `hasPreBrandalfSites`

New helper, exported from `src/support/llmo-onboarding-mode.js`:

```js
// Default fallback: 2026-04-01T00:00:00Z, used if the env var is missing or
// unparseable. Kept as epoch ms (not a Date) so it round-trips cleanly with
// the env var.
export const LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT = 1743465600000;

/**
 * Resolves the GA cutoff (epoch ms) from the environment, falling back to
 * LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT if the env var is missing or invalid.
 */
export function resolveBrandalfCutoffMs(context) {
  const raw = context?.env?.LLMO_BRANDALF_GA_CUTOFF_MS;
  if (raw === undefined || raw === null || raw === '') {
    return LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    context?.log?.warn?.(
      `Invalid LLMO_BRANDALF_GA_CUTOFF_MS "${raw}", falling back to default ${LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT}`,
    );
    return LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT;
  }
  return parsed;
}

/**
 * Returns true if the organization has any site whose createdAt is strictly
 * before the resolved cutoff. Treats missing/invalid createdAt as "not
 * pre-cutoff" to avoid false positives.
 */
export async function hasPreBrandalfSites(organizationId, context) {
  const cutoffMs = resolveBrandalfCutoffMs(context);
  const { Site } = context.dataAccess;
  const sites = await Site.allByOrganizationId(organizationId);
  return sites.some((s) => {
    const createdAt = s.getCreatedAt?.();
    if (!createdAt) return false;
    const ts = createdAt instanceof Date
      ? createdAt.getTime()
      : new Date(createdAt).getTime();
    return Number.isFinite(ts) && ts < cutoffMs;
  });
}
```

### Updated `resolveLlmoOnboardingMode`

```js
export async function resolveLlmoOnboardingMode(organizationId, context) {
  const { log = console } = context || {};

  // 1. Resolve the environment-level default. v2 if unset, v1 only if
  //    explicitly configured (kill switch).
  const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;
  const defaultMode = normalizeLlmoOnboardingMode(configuredDefault)
    || LLMO_ONBOARDING_MODE_V2;
  if (configuredDefault && configuredDefault !== defaultMode) {
    log.warn(
      `Invalid LLMO_ONBOARDING_DEFAULT_VERSION "${configuredDefault}", falling back to ${defaultMode}`,
    );
  }

  // 2. If the global default is v1, that wins — no per-org check needed.
  if (defaultMode === LLMO_ONBOARDING_MODE_V1) {
    return LLMO_ONBOARDING_MODE_V1;
  }

  // 3. Default is v2. Protect legacy customers: an org that already has at
  //    least one site created before the GA cutoff stays on v1.
  try {
    if (await hasPreBrandalfSites(organizationId, context)) {
      return LLMO_ONBOARDING_MODE_V1;
    }
  } catch (error) {
    log.warn(
      `Failed to check pre-Brandalf sites for organization ${organizationId}: ${error.message}`,
    );
    // On lookup failure we fall through to the configured default (v2). This
    // is the safer choice for brand-new orgs; the only risk is that a
    // legacy org with a transient DB error gets v2 — acceptable because the
    // monitoring script will surface it.
  }

  return LLMO_ONBOARDING_MODE_V2;
}
```

The existing `readBrandalfFlagOverride` helper is no longer called from
`resolveLlmoOnboardingMode`. It can stay in the file (still used by the
feature-flags controller and any other readers) but is removed from the mode
resolution path.

No changes to `performLlmoOnboarding` itself, no changes to the
feature-flags controller, no new error type — the rule is entirely contained
in mode resolution.

### Flow diagram

```
performLlmoOnboarding
        │
        ▼
resolveLlmoOnboardingMode
        │
        ▼
┌──────────────────────────────────┐
│ LLMO_ONBOARDING_DEFAULT_VERSION  │
│ === 'v1' ?                       │
└──────────────────────────────────┘
   │ yes        │ no (default → v2)
   ▼            ▼
   v1     ┌──────────────────────────────────┐
          │ org has any site created before  │
          │ LLMO_BRANDALF_GA_CUTOFF_MS?      │
          │ (default 2026-04-01T00:00:00Z)   │
          └──────────────────────────────────┘
             │ yes        │ no
             ▼            ▼
             v1           v2
```

## Tests

### Unit tests — `test/support/llmo-onboarding-mode.test.js`

The existing tests in this file are based on `brandalf` flag values driving
the mode. Those tests need to be **rewritten** because the flag is no longer
an input to `resolveLlmoOnboardingMode`.

Unless otherwise stated, tests run with:

- `context.env.LLMO_BRANDALF_GA_CUTOFF_MS = 1743465600000`
  (`2026-04-01T00:00:00Z`)
- `context.env.LLMO_ONBOARDING_DEFAULT_VERSION` **unset** (so the default
  resolves to `v2`)

New cases for `resolveLlmoOnboardingMode`:

**Default v2 (the normal state)**

- Org has a site with `createdAt = 2026-03-31T00:00:00Z` → `v1`.
- Org has a site with `createdAt = 2026-04-01T00:00:00Z` → `v2` (cutoff is
  exclusive — `<`, not `<=`).
- Org has a site with `createdAt = 2026-05-01T00:00:00Z` → `v2`.
- Org has no sites → `v2`.
- Org has multiple sites, one of which is pre-cutoff → `v1`.
- Org has a `brandalf=true` flag row but no pre-cutoff sites → `v2` (the flag
  is ignored, but the answer happens to match).
- Org has a `brandalf=true` flag row **and** a pre-cutoff site → `v1` (the
  flag is ignored — this is the behavior change vs today, document it
  explicitly in the test name).
- Site with missing/invalid `createdAt` does not trip the legacy branch.
- `Site.allByOrganizationId` throws → falls back to `v2` (the default), logs
  warning, does not throw out of `resolveLlmoOnboardingMode`.
- Env override: with `LLMO_BRANDALF_GA_CUTOFF_MS` shifted to a future
  timestamp, an org whose sites would otherwise count as v2 is reclassified
  as `v1` (proves the cutoff env var is honored end-to-end).

**Default v1 (kill switch)**

- `LLMO_ONBOARDING_DEFAULT_VERSION = 'v1'`, org with no sites → `v1`.
- `LLMO_ONBOARDING_DEFAULT_VERSION = 'v1'`, org with a post-cutoff site →
  `v1` (kill switch wins over the per-org check).
- `LLMO_ONBOARDING_DEFAULT_VERSION = 'v1'`, `Site.allByOrganizationId` is
  **never called** (assert via spy) — the kill-switch path short-circuits
  before the DB lookup.

**Invalid default**

- `LLMO_ONBOARDING_DEFAULT_VERSION = 'banana'` → falls back to `v2`, logs a
  warning, then runs the per-org check.

Focused tests for `resolveBrandalfCutoffMs`:

- env var unset → returns the default constant.
- env var set to a valid numeric string (e.g. `'1743465600000'`) → returns
  `1743465600000`.
- env var set to `0`, a negative number, `'abc'`, or empty string → returns
  the default and logs a warning.

Focused tests for `hasPreBrandalfSites`:

- returns `false` for an org with no sites.
- returns `true` when at least one site predates the cutoff.
- returns `false` when all sites are at or after the cutoff.
- returns `false` for sites with `null`/`undefined`/invalid `createdAt`.
- honors a custom `LLMO_BRANDALF_GA_CUTOFF_MS` from `context.env`.

### Integration tests — `test/it/`

Run with `LLMO_BRANDALF_GA_CUTOFF_MS=1743465600000`
(`2026-04-01T00:00:00Z`).

Add to `test/it/shared/tests/llmo-onboarding.js` /
`test/it/postgres/llmo-onboarding.test.js`:

- Seed an org with one site `created_at = 2026-03-15T00:00:00Z`. `POST
  /llmo/onboard` for a new site → site is created via the **v1** branch
  (assert no v2 customer-config row was written, no Brandalf job triggered).
- Seed an org with one site `created_at = 2026-05-15T00:00:00Z`. `POST
  /llmo/onboard` → **v2** branch (assert v2 customer-config row exists,
  `brandalf=true` is set on the org by the onboarding flow as today).
- Seed an org with one site `created_at = 2026-03-15T00:00:00Z` **and**
  `brandalf=true` flag row → onboarding still goes through **v1** (the flag
  is no longer consulted by mode resolution).
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

## Temporary nature & removal plan

This rule is **a temporary stop-gap, not the long-term design.** It exists
because we still have v1 customers in production and we need to keep them
on the v1 onboarding path while new customers default to v2. Once **all v1
customers have been migrated to v2** (tracked separately under the Brandalf
GA epic), this entire mechanism should be removed.

**When we remove it:**

1. Delete `hasPreBrandalfSites`, `resolveBrandalfCutoffMs`, and the
   `LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT` constant from
   `src/support/llmo-onboarding-mode.js`.
2. Delete the `LLMO_BRANDALF_GA_CUTOFF_MS` env var from dev / stage / prod
   Lambda configs and from `.env.example`.
3. Decide whether `LLMO_ONBOARDING_DEFAULT_VERSION` is still useful as a
   global kill switch; if not, delete it and `normalizeLlmoOnboardingMode`
   too, and inline `resolveLlmoOnboardingMode` to `() => 'v2'` (or remove
   the function entirely and have `performLlmoOnboarding` skip the
   branching).
4. Drop the unit tests added in this PR (search for
   `LLMO_BRANDALF_GA_CUTOFF_MS` and `hasPreBrandalfSites`) and the IT
   scenarios that depend on pre-/post-cutoff `created_at` seed data.
5. Drop the monitoring script if it is no longer needed.

The point is: **none of the new code added in this PR should outlive the
v1→v2 migration.** Leaving any of it in place after the migration is
finished would be dead code that future readers would have to reverse-engineer.

## Open questions

1. **Default cutoff.** Plan uses a hard-coded fallback of `1743465600000`
   (`2026-04-01T00:00:00Z`). The real cutoff will be set per-environment via
   `LLMO_BRANDALF_GA_CUTOFF_MS`. Confirm the default is acceptable for any
   env where the var is missing.
2. **Cutoff inclusivity.** Plan treats it as **exclusive** (`createdAt <
   cutoff` ⇒ legacy). A site whose `createdAt` is exactly equal to the
   cutoff is treated as a v2 customer. Confirm.
3. **Env var rollout.** `LLMO_BRANDALF_GA_CUTOFF_MS` needs to be added to
   the Lambda env in dev / stage / prod (and to `.env.example` if one
   exists). Confirm the deploy mechanism — Lambda env-var update without a
   full redeploy is sufficient since `resolveBrandalfCutoffMs` reads from
   `context.env` on every request.
4. **Existing inconsistent orgs.** The monitoring script will list them;
   the plan does not auto-remediate. Is that the right call?

## Implementation order

1. Add `LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT` constant +
   `resolveBrandalfCutoffMs` + `hasPreBrandalfSites` helpers to
   `src/support/llmo-onboarding-mode.js`, and update
   `resolveLlmoOnboardingMode` to use them. Keep `normalizeLlmoOnboardingMode`
   and the `LLMO_ONBOARDING_DEFAULT_VERSION` env var as-is — they still drive
   the global default and the v1 kill switch.
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
