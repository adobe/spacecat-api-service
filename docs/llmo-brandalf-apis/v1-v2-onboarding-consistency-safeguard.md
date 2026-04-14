# LLMO v1 / v2 (Brandalf) Onboarding Mode Resolution

**Jira:** [LLMO-4176](https://jira.corp.adobe.com/browse/LLMO-4176)
**Epic:** [LLMO-4054 — Brandalf GA (Brandalf v1 fast follows)](https://jira.corp.adobe.com/browse/LLMO-4054)
**Status:** Implemented and tested on dev
**PRs:**
- api-service: [adobe/spacecat-api-service#2171](https://github.com/adobe/spacecat-api-service/pull/2171)
- audit-worker: [adobe/spacecat-audit-worker#2380](https://github.com/adobe/spacecat-audit-worker/pull/2380) *(companion fix — required for v1 onboarding to complete successfully)*
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
time based on three inputs: the org-level `brandalf` feature flag, whether the
customer existed before Brandalf GA, and a global environment-level default.

## The rule

At onboarding time, when `performLlmoOnboarding` resolves the mode for an org:

```
defaultMode = normalize(env.LLMO_ONBOARDING_DEFAULT_VERSION) || v2

if brandalf flag === true on org:
    if org has any sites onboarded before LLMO_BRANDALF_GA_CUTOFF_MS
       AND defaultMode == v1:
        SET brandalf flag = false                # mixed state + kill switch → revert
        LOG WARNING "org has pre-cutoff sites requiring migration"
        → v1                                    # force v1 — org is not ready for v2
    else:
        → v2                                    # explicit migration — never go backwards
else if defaultMode == v1:
    → v1                                        # global kill switch: everyone (not yet migrated) on v1
else:
    if org has any sites onboarded before LLMO_BRANDALF_GA_CUTOFF_MS:
        → v1                                    # legacy customer — keep them on v1
    else:
        → v2                                    # new customer — default to v2
```

In words:

- The **`brandalf` feature flag** on the org is checked first. If
  `brandalf=true`, the org has been previously set up for v2. In most cases
  this means v2 — **except** when the kill switch is active (`v1`) **and**
  the org has pre-cutoff sites. That combination indicates an org that was
  prematurely or incorrectly migrated to v2 while still having legacy sites.
  In that case, the safeguard **reverts the brandalf flag to `false`** and
  forces v1, logging a warning that the org has sites requiring migration.
  This is the only scenario where the flag is programmatically reverted.
- The **environment-level default** (`LLMO_ONBOARDING_DEFAULT_VERSION`) is
  honored next. If it is set to `v1`, every **non-migrated** org goes to v1
  regardless of site history (this is the "kill switch" if v2 has to be
  disabled globally for orgs that haven't been set up yet).
- If the default is `v2` (the normal state), we still **protect legacy
  customers**: any org that already has at least one site onboarded before
  `LLMO_BRANDALF_GA_CUTOFF_MS` is forced onto **v1**, so onboarding a new
  site for an existing v1 customer never silently switches them to v2.
- **Brand-new customers** (no sites in the org predate the cutoff, including
  orgs with no sites at all) go to **v2**.

### Environment variables

| Variable | Purpose | Values | Default |
|---|---|---|---|
| `LLMO_ONBOARDING_DEFAULT_VERSION` | Global default / kill switch for non-migrated orgs | `'v1'` (kill switch), `'v2'`, or unset | `'v2'` |
| `LLMO_BRANDALF_GA_CUTOFF_MS` | Unix epoch ms cutoff — sites created before this are "legacy" | Any positive integer | `1775001600000` (`2026-04-01T00:00:00Z`) |

Both are set per-environment via HashiCorp Vault (`dx_mysticat/<env>/api-service`).
Lambda reads them on startup; a cold start is sufficient to pick up changes.

### Decision matrix

The full cross-product of the three inputs (`LLMO_ONBOARDING_DEFAULT_VERSION`,
pre-cutoff sites via `LLMO_BRANDALF_GA_CUTOFF_MS`, and the `brandalf` feature
flag on the org) and the expected outcome across all system components:

| # | Default version (`LLMO_ONBOARDING_DEFAULT_VERSION`) | Pre-cutoff sites (`LLMO_BRANDALF_GA_CUTOFF_MS`) | Brandalf flag on org | Onboarding version | API service | Audit-worker | DRS prompts | DRS schedulers | Side effects |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `v1` | yes | yes | **v1** | v1 | v1 | v1 | v1 | **Reverts brandalf flag to `false`** + logs warning |
| 2 | `v1` | yes | no  | **v1** | v1 | v1 | v1 | v1 | — |
| 3 | `v1` | no  | yes | **v2** | v2 | v2 | v2 | v2 | — |
| 4 | `v1` | no  | no  | **v1** | v1 | v1 | v1 | v1 | — |
| 5 | `v2` | yes | yes | **v2** | v2 | v2 | v2 | v2 | — |
| 6 | `v2` | yes | no  | **v1** | v1 | v1 | v1 | v1 | — |
| 7 | `v2` | no  | yes | **v2** | v2 | v2 | v2 | v2 | — |
| 8 | `v2` | no  | no  | **v2** | v2 | v2 | v2 | v2 | **Sets brandalf flag to `true`** (v2 onboarding) |

**Key observations:**

- **Row 1 is the remediation scenario.** When the kill switch is active
  (`v1`), the org has pre-cutoff sites, and `brandalf=true` — this is an
  org that was prematurely or incorrectly migrated to v2 while still having
  legacy sites. The safeguard **reverts the brandalf flag to `false`** and
  logs a warning that the org has sites requiring migration, then forces v1.
  This is the only scenario where the flag is programmatically reverted.
- **Brandalf flag = yes means v2 in all other cases** (rows 3, 5, 7). The
  flag represents an explicit decision that this org has been migrated to v2.
  When there are no pre-cutoff sites (rows 3, 7) or the kill switch is off
  (row 5), the migration is valid and v2 is honored.
- **Kill switch (`v1` default) only affects non-migrated orgs** (rows 2, 4)
  and triggers cleanup for incorrectly-migrated orgs (row 1).
- **Legacy check only applies when default is `v2` and no brandalf flag**
  (row 6). Pre-cutoff sites without a brandalf flag means a legacy v1
  customer that hasn't been migrated.
- **All downstream components (api-service, audit-worker, DRS prompts, DRS
  schedulers) follow the resolved onboarding version.** The `onboardingMode`
  is propagated via `buildOnboardingMetadata` (`onboarding_mode` field in
  the audit context) so all services see a consistent value.

The cutoff is a **Unix epoch timestamp in milliseconds**, supplied via the
environment variable `LLMO_BRANDALF_GA_CUTOFF_MS`, so it can be tweaked
without a code change or full redeployment (Lambda env-var update is enough).
A reasonable default — `1775001600000` (`2026-04-01T00:00:00Z`) — is
hard-coded as a fallback in case the env var is missing or unparseable, so
the function never fails closed.

### Why this works

- It is a single check inside `resolveLlmoOnboardingMode`, with no second
  endpoint to guard.
- It is **idempotent**: re-running onboarding for the same org always picks
  the same mode. After the row 1 remediation reverts the brandalf flag, the
  next call hits row 2 (same result, no further side effects).
- The `brandalf` flag override ensures **validly migrated orgs stay on v2**
  (rows 3, 5, 7). Orgs with no pre-cutoff sites, or where the kill switch
  is off, keep their v2 status.
- The **row 1 remediation** catches orgs that were incorrectly migrated
  (brandalf=true but still has legacy sites while the kill switch is on).
  By reverting the flag to `false`, it brings the org into a clean v1 state
  and prevents downstream services from seeing conflicting signals.
- The legacy check via `Site.allByOrganizationId` plus
  `site.getCreatedAt()` keeps non-migrated legacy customers on v1 without
  requiring per-site markers.
- Existing v2 customers (onboarded after the cutoff) are unaffected — they
  have no pre-cutoff sites, so the row 1 condition never triggers.

### What it does **not** do

- It does **not** retroactively migrate v1 sites to v2.
- It does **not** add a flag-flip guard on
  `PUT/DELETE /organizations/:id/feature-flags/LLMO/brandalf`.
  The `brandalf` flag is an **input** to mode resolution (highest-priority
  override), and `performLlmoOnboarding` still **sets** `brandalf=true` after
  a successful v2 onboarding. But the flag endpoints remain unguarded — this
  is intentional to keep the operational escape hatch intact.

## Companion fix — audit-worker (`spacecat-audit-worker#2380`)

Discovered during end-to-end testing on dev (2026-04-13) under v2 logic (before
the brandalf flag override was added). The safeguard in api-service routed a
mixed-state org (brandalf=true flag + pre-Brandalf sites) to v1 onboarding.
However, the `llmo-customer-analysis` handler in the audit-worker independently
re-checked the `brandalf` flag via `isBrandalfEnabled`, found no v2
customer-config brand (none is created during v1 onboarding), then called DRS
without `brand_id`. DRS returns **422** for brandalf-enabled orgs without a
`brand_id`.

> **Note (v3 update):** Under the current logic, row 1 (kill switch + pre-cutoff
> sites + brandalf=true) reverts the brandalf flag to `false` before returning
> v1. However, there may be in-flight audit messages dispatched while the flag
> was still `true`. The audit-worker fix is retained as a safety net for those
> edge cases and for manual flag manipulation.

### Root cause

`llmo-customer-analysis` was not consuming the `onboardingMode` field that the
`drs-prompt-generation` handler already propagated in the audit context. The
`onboardingMode` field is set by api-service (`onboarding_mode: onboardingMode` in
`buildOnboardingMetadata`), picked up by `index.js`, and forwarded through
`drs-prompt-generation` → `llmo-customer-analysis`.

### Fix (one line)

```js
// Before — always checked isBrandalfEnabled regardless of onboarding path:
const isV2 = await isBrandalfEnabled(orgId, env, log);

// After — short-circuits when onboardingMode is explicitly 'v1':
const isV2 = onboardingMode !== 'v1' && await isBrandalfEnabled(orgId, env, log);
```

When `onboardingMode === 'v1'`, `isBrandalfEnabled` is never called and the BP
schedule is created without `brand_id` — matching v1 DRS expectations.

### Decision table

| `onboardingMode` in auditContext | `brandalf` flag | Outcome |
|---|---|---|
| `'v2'` | true | Resolve brand from DB, include `brand_id` in schedule |
| `'v1'` (explicit) | false | Create schedule without `brand_id` (v1 path) |
| `'v1'` (explicit) | true | **Cannot happen under v3 logic** — brandalf=true always resolves to v2. Kept in audit-worker as a safety net: skip brandalf check, create schedule without `brand_id` |
| not set | true | Fall back to `isBrandalfEnabled` (backward compat for old messages) |
| not set | false | No brand resolution, schedule without `brand_id` |

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

The change in this plan keeps the `brandalf` flag as a **high-priority input**
(if `brandalf=true`, v2 in most cases) with one exception: when the kill
switch is active and the org has pre-cutoff sites, the flag is reverted to
`false` and v1 is forced (row 1 remediation). For non-migrated orgs, a
secondary check based on `createdAt` timestamps of the org's existing sites
determines v1 vs v2.

## Design

### Helper — `hasPreBrandalfSites`

New helper, exported from `src/support/llmo-onboarding-mode.js`:

```js
// Default fallback: 2026-04-01T00:00:00Z, used if the env var is missing or
// unparseable. Kept as epoch ms (not a Date) so it round-trips cleanly with
// the env var.
export const LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT = 1775001600000;

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
import { upsertFeatureFlag } from './feature-flags-storage.js';

export async function resolveLlmoOnboardingMode(organizationId, context) {
  const { log = console } = context || {};
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;

  // 1. Brandalf flag check: if the org already has brandalf=true, it has
  //    been explicitly migrated to v2.
  //    Exception: if the kill switch is active AND the org has pre-cutoff
  //    sites, this is an incorrectly migrated org — revert the flag and
  //    force v1 (row 1 in the decision matrix).
  let brandalfEnabled = false;
  try {
    brandalfEnabled = await readBrandalfFlagOverride(organizationId, postgrestClient) === true;
  } catch (flagError) {
    log.warn(
      `Failed to read brandalf flag for org ${organizationId}: ${flagError.message} — proceeding with default resolution`,
    );
  }

  if (brandalfEnabled) {
    const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;

    // Row 1: kill switch active + pre-cutoff sites + brandalf=true
    // → revert the flag and force v1
    if (configuredDefault === LLMO_ONBOARDING_MODE_V1) {
      try {
        if (await hasPreBrandalfSites(organizationId, context)) {
          // Revert brandalf flag to false — this org is not ready for v2
          try {
            await upsertFeatureFlag({
              organizationId,
              product: LLMO_FEATURE_FLAG_PRODUCT,
              flagName: LLMO_BRANDALF_FLAG,
              value: false,
              updatedBy: 'llmo-onboarding-mode-resolution',
              postgrestClient,
            });
          } catch (revertError) {
            log.error(
              `Failed to revert brandalf flag for org ${organizationId}: ${revertError.message}`,
            );
          }
          log.warn(
            `LLMO mode resolution: organization ${organizationId} has brandalf=true but also has `
            + 'pre-cutoff sites while kill switch is active. Reverted brandalf flag to false. '
            + 'This org has sites that require migration before it can use v2.',
          );
          return LLMO_ONBOARDING_MODE_V1;
        }
      } catch (error) {
        log.warn(
          `Failed to check pre-Brandalf sites for org ${organizationId}: ${error.message}`,
        );
        // Cannot confirm pre-cutoff sites — fall through to v2 (brandalf=true
        // is still set, so honor the migration).
      }
    }

    // Rows 3, 5, 7: brandalf=true without the row-1 condition → v2
    log.info(
      `LLMO mode resolution: organization ${organizationId} has brandalf=true — using v2 (explicit migration override)`,
    );
    return LLMO_ONBOARDING_MODE_V2;
  }

  // 2. Environment-level default (brandalf is false/missing from here on).
  //    'v1' is the global kill switch; anything else defaults to v2.
  const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;
  if (configuredDefault === LLMO_ONBOARDING_MODE_V1) {
    return LLMO_ONBOARDING_MODE_V1;
  }
  if (configuredDefault && configuredDefault !== LLMO_ONBOARDING_MODE_V2) {
    log.warn(
      `Invalid LLMO_ONBOARDING_DEFAULT_VERSION "${configuredDefault}", falling back to ${LLMO_ONBOARDING_MODE_V2}`,
    );
  }

  // 3. Protect legacy customers: any org with a pre-cutoff site stays on v1.
  try {
    if (await hasPreBrandalfSites(organizationId, context)) {
      return LLMO_ONBOARDING_MODE_V1;
    }
  } catch (error) {
    log.warn(
      `Failed to check pre-Brandalf sites for organization ${organizationId}: ${error.message}`,
    );
  }

  return LLMO_ONBOARDING_MODE_V2;
}
```

`readBrandalfFlagOverride` is now the **first check**. If `brandalf=true`:

- **Row 1** (kill switch active + pre-cutoff sites): the flag is **reverted
  to `false`** via `upsertFeatureFlag`, a warning is logged identifying the
  org as needing migration, and v1 is returned. This cleans up the
  inconsistent state so downstream services (DRS schedulers, audit-worker)
  see a consistent v1 signal.
- **Rows 3, 5, 7** (all other brandalf=true cases): v2 is returned
  immediately — the migration is valid and honored.

`performLlmoOnboarding` calls `resolveLlmoOnboardingMode` **after**
`createOrFindSite`, and `createOrFindSite` persists any cross-org re-parent
immediately (`await site.save()` in the `setOrganizationId` branch). This
ordering matters: a legacy site re-parented into a brand-new org must be
visible to the `Site.allByOrganizationId` query in `hasPreBrandalfSites`,
otherwise the new org would be classified v2 and instantly enter the mixed
state this safeguard is meant to prevent. (LLMO-4176)

No changes to the feature-flags controller, no new error type — the rule is
contained in mode resolution + the controller call ordering.

### Flow diagram

```
performLlmoOnboarding
        │
        ▼
resolveLlmoOnboardingMode
        │
        ▼
┌──────────────────────────────────┐
│ brandalf flag === true on org?   │
│ (read via readBrandalfFlag-      │
│  Override from feature_flags)    │
└──────────────────────────────────┘
   │ yes                          │ no / missing / error
   ▼                              ▼
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ LLMO_ONBOARDING_DEFAULT_     │  │ LLMO_ONBOARDING_DEFAULT_VERSION  │
│ VERSION === 'v1' AND         │  │ === 'v1' ?                       │
│ hasPreBrandalfSites?         │  └──────────────────────────────────┘
└──────────────────────────────┘     │ yes        │ no (default → v2)
   │ yes (row 1)  │ no              ▼            ▼
   ▼               ▼               v1     ┌──────────────────────────────────┐
  revert flag      v2                     │ org has any site created before  │
  to false   (rows 3,5,7)                │ LLMO_BRANDALF_GA_CUTOFF_MS?      │
  + log warn                              │ (default 2026-04-01T00:00:00Z)   │
   │                                      └──────────────────────────────────┘
   ▼                                         │ yes        │ no
   v1                                        ▼            ▼
                                             v1           v2
```

## Tests

### Unit tests — `test/support/llmo-onboarding-mode.test.js`

The existing tests in this file are based on `brandalf` flag values as the
sole driver of mode resolution. Those tests need to be **rewritten** to
cover the three-input decision matrix (brandalf flag, default version,
pre-cutoff sites) including the row 1 remediation scenario.

Unless otherwise stated, tests run with:

- `context.env.LLMO_BRANDALF_GA_CUTOFF_MS = 1775001600000`
  (`2026-04-01T00:00:00Z`)
- `context.env.LLMO_ONBOARDING_DEFAULT_VERSION` **unset** (so the default
  resolves to `v2`)

New cases for `resolveLlmoOnboardingMode` — structured to match the decision
matrix (see [Decision matrix](#decision-matrix) above):

**Brandalf flag override (highest priority)**

- Org has `brandalf=true`, default=`v1`, pre-cutoff sites=yes → `v1`,
  **brandalf flag reverted to `false`**, warning logged mentioning the org
  has sites requiring migration (matrix row 1 — remediation scenario).
  Assert `upsertFeatureFlag` was called with `value: false`.
- Org has `brandalf=true`, default=`v1`, pre-cutoff sites=yes, but
  `upsertFeatureFlag` throws → still returns `v1` (revert is best-effort),
  error logged.
- Org has `brandalf=true`, default=`v1`, pre-cutoff sites=no → `v2`
  (matrix row 3 — flag override beats kill switch, no legacy conflict).
- Org has `brandalf=true`, default=`v2`, pre-cutoff sites=yes → `v2`
  (matrix row 5 — flag override beats legacy check when kill switch is off).
- Org has `brandalf=true`, default=`v2`, pre-cutoff sites=no → `v2`
  (matrix row 7 — flag matches default, no conflict).
- Org has `brandalf=true`, default=`v2`, `hasPreBrandalfSites` is called
  only when default=`v1` (assert via spy — rows 5, 7 skip the legacy check
  entirely since the kill switch is off).
- `readBrandalfFlagOverride` throws → falls through to kill switch / legacy
  check (does not block onboarding).

**Default v2 — no brandalf flag (the normal state for non-migrated orgs)**

- Org has a site with `createdAt = 2026-03-31T00:00:00Z` → `v1`
  (matrix row 6).
- Org has a site with `createdAt = 2026-04-01T00:00:00Z` → `v2` (cutoff is
  exclusive — `<`, not `<=`).
- Org has a site with `createdAt = 2026-05-01T00:00:00Z` → `v2`.
- Org has no sites → `v2` (matrix row 8).
- Org has multiple sites, one of which is pre-cutoff → `v1`.
- Site with missing/invalid `createdAt` does not trip the legacy branch.
- `Site.allByOrganizationId` throws → falls back to `v2` (the default), logs
  warning, does not throw out of `resolveLlmoOnboardingMode`.
- Env override: with `LLMO_BRANDALF_GA_CUTOFF_MS` shifted to a future
  timestamp, an org whose sites would otherwise count as v2 is reclassified
  as `v1` (proves the cutoff env var is honored end-to-end).

**Default v1 (kill switch) — no brandalf flag**

- `LLMO_ONBOARDING_DEFAULT_VERSION = 'v1'`, org with pre-cutoff sites → `v1`
  (matrix row 2).
- `LLMO_ONBOARDING_DEFAULT_VERSION = 'v1'`, org with no sites → `v1`
  (matrix row 4).
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
- env var set to a valid numeric string (e.g. `'1775001600000'`) → returns
  `1775001600000`.
- env var set to `0`, a negative number, `'abc'`, or empty string → returns
  the default and logs a warning.

Focused tests for `hasPreBrandalfSites`:

- returns `false` for an org with no sites.
- returns `true` when at least one site predates the cutoff.
- returns `false` when all sites are at or after the cutoff.
- returns `false` for sites with `null`/`undefined`/invalid `createdAt`.
- honors a custom `LLMO_BRANDALF_GA_CUTOFF_MS` from `context.env`.

### Integration tests — `test/it/`

Run with `LLMO_BRANDALF_GA_CUTOFF_MS=1775001600000`
(`2026-04-01T00:00:00Z`).

Add to `test/it/shared/tests/llmo-onboarding.js` /
`test/it/postgres/llmo-onboarding.test.js`:

- Seed an org with one site `created_at = 2026-03-15T00:00:00Z`, no
  brandalf flag. `POST /llmo/onboard` for a new site → site is created via
  the **v1** branch (assert no v2 customer-config row was written, no
  Brandalf job triggered). *(matrix row 6)*
- Seed an org with one site `created_at = 2026-05-15T00:00:00Z`, no
  brandalf flag. `POST /llmo/onboard` → **v2** branch (assert v2
  customer-config row exists, `brandalf=true` is set on the org by the
  onboarding flow). *(matrix row 8)*
- Seed an org with one site `created_at = 2026-03-15T00:00:00Z` **and**
  `brandalf=true` flag row → onboarding goes through **v2** (the flag
  override takes priority over the legacy-site check). *(matrix row 5)*
- Seed an org with no sites and `brandalf=true` flag row → onboarding goes
  through **v2** (flag override). *(matrix row 7)*
- Seed a brand-new org with no sites, no brandalf flag → onboarding goes
  through **v2** (default). *(matrix row 8)*
- With `LLMO_ONBOARDING_DEFAULT_VERSION=v1`: seed an org with no sites,
  `brandalf=true` → onboarding goes through **v2** (flag override beats
  kill switch). *(matrix row 3)*
- With `LLMO_ONBOARDING_DEFAULT_VERSION=v1`: seed an org with no sites,
  no brandalf flag → onboarding goes through **v1** (kill switch).
  *(matrix row 4)*

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
   global kill switch; if not, delete it and inline `resolveLlmoOnboardingMode`
   to `() => 'v2'` (or remove the function entirely and have
   `performLlmoOnboarding` skip the branching).
4. Drop the unit tests added in this PR (search for
   `LLMO_BRANDALF_GA_CUTOFF_MS` and `hasPreBrandalfSites`) and the IT
   scenarios that depend on pre-/post-cutoff `created_at` seed data.
5. Drop the monitoring script if it is no longer needed.

The point is: **none of the new code added in this PR should outlive the
v1→v2 migration.** Leaving any of it in place after the migration is
finished would be dead code that future readers would have to reverse-engineer.

## Open questions

1. ~~**Default cutoff.**~~ ✅ Resolved — `1775001600000` (`2026-04-01T00:00:00Z`)
   is the hard-coded fallback. `LLMO_BRANDALF_GA_CUTOFF_MS` is set per-environment
   via HashiCorp Vault (`dx_mysticat/<env>/api-service`). If the var is absent, the
   default applies (any site onboarded before 2026-04-01 is treated as legacy).
2. ~~**Cutoff inclusivity.**~~ ✅ Resolved — exclusive (`<`, not `<=`). A site
   created exactly at the cutoff instant is a v2 customer.
3. ~~**Env var rollout.**~~ ✅ Resolved — `LLMO_BRANDALF_GA_CUTOFF_MS` is set in
   Vault. Lambda reads it on startup; a cold start (or alias update to a new
   published version) is sufficient to pick up changes — no full redeploy needed.
4. **Existing inconsistent orgs.** The monitoring script will list them;
   the plan does not auto-remediate. Is that the right call?

## Implementation order

1. ✅ Add `LLMO_BRANDALF_GA_CUTOFF_MS_DEFAULT` constant +
   `resolveBrandalfCutoffMs` + `hasPreBrandalfSites` helpers to
   `src/support/llmo-onboarding-mode.js`.
2. Update `resolveLlmoOnboardingMode` to add the brandalf flag override as
   the **first check** (step 1 in the rule), before the kill switch and
   legacy-site check. The `readBrandalfFlagOverride` call moves from a
   diagnostic-only position to a decision-driving position. Keep the
   `LLMO_ONBOARDING_DEFAULT_VERSION` env var as-is — it still drives the v1
   kill switch for non-migrated orgs.
3. ✅ Extend `test/support/llmo-onboarding-mode.test.js` with the new cases.
   Update tests to cover all 8 matrix rows, especially rows 1, 3, 5
   (brandalf=true overriding kill switch and legacy check).
4. Add integration tests in `test/it/` with seed data covering the matrix
   scenarios above (7 IT cases).
5. Add the monitoring script and run it once against stage to confirm output
   format.
6. ✅ Open PR [adobe/spacecat-api-service#2171](https://github.com/adobe/spacecat-api-service/pull/2171).
7. ✅ Open companion PR [adobe/spacecat-audit-worker#2380](https://github.com/adobe/spacecat-audit-worker/pull/2380)
   to fix `llmo-customer-analysis` skipping brandalf check for `onboardingMode=v1`.
   **Both PRs must be merged and deployed together** — the api-service fix
   routes correctly but the brand-presence schedule will still fail with DRS 422
   if the audit-worker is not patched.

## Changes vs the previous versions of this plan

### v3 (current) — brandalf flag as high-priority override with row 1 remediation

The v2 implementation removed the `brandalf` flag entirely from mode
resolution and relied only on `LLMO_ONBOARDING_DEFAULT_VERSION` + the
legacy-site cutoff check. This created two incorrect scenarios (see decision
matrix rows 3 and 5):

- **Row 3**: Default=v1 (kill switch), no pre-cutoff sites, brandalf=true →
  the code returned v1, but should return v2. A v2-migrated org was being
  forced back to v1 by the kill switch, creating the exact mixed state the
  safeguard exists to prevent.
- **Row 5**: Default=v2, pre-cutoff sites exist, brandalf=true → the code
  returned v1, but should return v2. A legacy org that had already been
  explicitly migrated to v2 was being forced back to v1 by the legacy check.

**Fix**: The `brandalf` flag is now the **first** check in
`resolveLlmoOnboardingMode`. If `brandalf=true`, the function returns v2 in
most cases — with one exception:

- **Row 1** (kill switch=v1 + pre-cutoff sites + brandalf=true): This
  indicates an org that was prematurely or incorrectly migrated to v2 while
  still having legacy sites, and the kill switch is active. The safeguard
  **reverts the brandalf flag to `false`** and forces v1, logging a warning
  that the org has sites requiring migration. This ensures downstream
  services see a consistent v1 signal.

### v2 — single rule with cutoff check (dropped)

Removed the `brandalf` flag from mode resolution entirely. Replaced with
`createdAt`-based cutoff only. Simpler but missed the override case.

### v1 — two coordinated guards (dropped)

The earliest draft proposed two coordinated guards (an onboarding-time
consistency check **and** a flag-flip guard on the feature-flags controller)
plus a new helper module `llmo-onboarding-consistency.js`. Dropped in favor
of the single-function approach. Reasons:

- Simpler: one function, no new module, no new error type, no new HTTP
  response codes to document.
- Equivalent in practice for the cases that matter.
- Avoids hard-blocking the admin feature-flag endpoints, which keeps the
  operational escape hatch intact.
