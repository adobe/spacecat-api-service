# LLMO v1 / v2 (Brandalf) Onboarding Consistency Safeguard

**Jira:** [LLMO-4176](https://jira.corp.adobe.com/browse/LLMO-4176)
**Epic:** [LLMO-4054 — Brandalf GA (Brandalf v1 fast follows)](https://jira.corp.adobe.com/browse/LLMO-4054)
**Status:** Proposal / implementation plan

## Problem

We currently have no safeguard preventing customers from being onboarded into both
v1 and v2 (Brandalf) flows within the same organization. This can lead to an
inconsistent state where an org has some sites onboarded with v1 and others with
v2, which is hard to recover from.

The risk arises because:

1. An org is onboarded with `brandalf` unset → all its sites are v1, each with an
   `llmoConfig`.
2. Someone flips `brandalf=true` on the org via the admin feature-flag endpoint.
3. The next site onboarded for that org goes through the v2 branch in
   `performLlmoOnboarding` → mixed v1/v2 in one org.

The same can happen in reverse if `brandalf` is later set back to `false`/`null`.

This document captures the temporary safeguard agreed in the Slack discussion
between Iryna Lagno and Igor Grubic, and lays out the implementation plan.

## Goals

- **Block** any action that would create or extend a mixed v1/v2 organization.
- **Detect** organizations that are already in a mixed state, so they can be
  remediated manually.
- **Reuse** the existing data model — no new per-site marker, no migration.

## Non-goals

- Automatically migrating v1 sites to v2 (or vice versa).
- Removing the `brandalf` feature flag — it remains the source of truth for which
  flow an org uses.
- Any UI changes.

## Background — how the flows work today

There is **only one onboarding entry point**:
[`performLlmoOnboarding`](../../src/controllers/llmo/llmo-onboarding.js) is called
from both `POST /llmo/onboard` and the Slack `/onboard-llmo` flow. The v1 vs v2
decision is made early in that function by
[`resolveLlmoOnboardingMode`](../../src/support/llmo-onboarding-mode.js), which
reads the `brandalf` row in the `feature_flags` table:

- `brandalf = true`  → mode `v2`
- `brandalf = false` → mode `v1`
- row missing       → mode falls back to `LLMO_ONBOARDING_DEFAULT_VERSION` (v1)

The `brandalf` flag itself is written from two places today:

1. `performLlmoOnboarding` itself, after a successful v2 onboarding
   ([llmo-onboarding.js](../../src/controllers/llmo/llmo-onboarding.js)) — this
   path is internally consistent.
2. The admin endpoints
   [`PUT /organizations/:organizationId/feature-flags/:product/:flagName`](../../src/controllers/feature-flags.js)
   and the corresponding `DELETE` (which sets the value to `false`). Both go
   through `persistFlag` and are admin-only. **This is the path that can create
   inconsistency**, because it is decoupled from any check on the org's existing
   sites.

### Identifying v1 vs v2 sites

We do **not** need a per-site marker. The rule we will enforce is:

> All onboarded sites within an org must agree with the org-level `brandalf` flag.

A site is considered "LLMO-onboarded" iff
`site.getConfig().getLlmoConfig()` is present (this matches existing usage in
[`llmo.js`](../../src/controllers/llmo/llmo.js)). The current value of the
org-level `brandalf` flag tells us which flow those sites belong to.

## Design — two coordinated guards

We add **two guards** that share a single helper module, plus a read-only
monitoring script.

```
┌────────────────────────────────┐        ┌──────────────────────────────────┐
│ POST /llmo/onboard             │        │ PUT/DELETE /organizations/:id/   │
│ (HTTP + Slack)                 │        │   feature-flags/LLMO/brandalf    │
│                                │        │                                  │
│ performLlmoOnboarding()        │        │ persistFlag()                    │
│   ├── resolveLlmoOnboardingMode│        │   ├── parseWriteTarget           │
│   ├── assertLlmoOnboarding-    │◀──┐  ┌▶│   ├── checkBrandalfFlagFlip-     │
│   │   Consistency()  ★ NEW     │   │  │ │   │   Safety() ★ NEW            │
│   └── createOrFindSite ...     │   │  │ │   └── upsertFeatureFlag         │
└────────────────────────────────┘   │  │ └──────────────────────────────────┘
                                     │  │
                              ┌──────┴──┴──────┐
                              │ src/support/   │
                              │   llmo-onboard │
                              │   ing-         │
                              │   consistency  │
                              │   .js  ★ NEW   │
                              └────────────────┘
```

### Helper module — `src/support/llmo-onboarding-consistency.js` (new)

```js
import { readBrandalfFlagOverride, LLMO_ONBOARDING_MODE_V1, LLMO_ONBOARDING_MODE_V2 } from './llmo-onboarding-mode.js';

export class LlmoOnboardingConsistencyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmoOnboardingConsistencyError';
  }
}

/**
 * Returns the set of sites in the org that have already been LLMO-onboarded
 * (i.e. carry an llmoConfig on their site config).
 */
export async function getLlmoOnboardedSites(organizationId, context) { /* ... */ }

/**
 * Throws LlmoOnboardingConsistencyError if onboarding `mode` would create or
 * extend a mixed v1/v2 organization.
 *
 * - mode === 'v2' and org has v1-onboarded sites → throw
 * - mode === 'v1' and brandalf=true and org has v2-onboarded sites → throw
 * - otherwise no-op
 */
export async function assertLlmoOnboardingConsistency({
  organizationId, mode, context,
}) { /* ... */ }

/**
 * Returns null if it is safe to set the LLMO/brandalf flag to `nextValue` for
 * `organizationId`, or { message } describing the conflict otherwise.
 *
 * Safe cases:
 *   - org has no LLMO-onboarded sites (any value is fine)
 *   - currentMode === nextMode (no-op flip)
 */
export async function checkBrandalfFlagFlipSafety({
  organizationId, nextValue, context,
}) { /* ... */ }
```

### Guard 1 — onboarding-time consistency

In [`src/controllers/llmo/llmo-onboarding.js`](../../src/controllers/llmo/llmo-onboarding.js),
inside `performLlmoOnboarding`, immediately after `resolveLlmoOnboardingMode`
and **before** any side effects (site creation, entitlement, SharePoint copy,
etc.):

```js
const onboardingMode = await resolveLlmoOnboardingMode(organization.getId(), context);

await assertLlmoOnboardingConsistency({
  organizationId: organization.getId(),
  mode: onboardingMode,
  context,
});

// Create site
site = await createOrFindSite(...);
```

In [`src/controllers/llmo/llmo.js`](../../src/controllers/llmo/llmo.js)
`onboardCustomer` wraps `performLlmoOnboarding`. Map
`LlmoOnboardingConsistencyError` to a `409 Conflict` with a sanitized message
(via the existing `cleanupHeaderValue` pattern). The Slack handler in
[`src/support/slack/commands/llmo-onboard.js`](../../src/support/slack/commands/llmo-onboard.js)
should `say(...)` the same error text rather than crashing.

### Guard 2 — flag-flip consistency

In [`src/controllers/feature-flags.js`](../../src/controllers/feature-flags.js)
`persistFlag`, after the org lookup and **before** `upsertFeatureFlag`:

```js
import { LLMO_BRANDALF_FLAG, LLMO_FEATURE_FLAG_PRODUCT } from '../support/llmo-onboarding-mode.js';
import { checkBrandalfFlagFlipSafety } from '../support/llmo-onboarding-consistency.js';

// LLMO/brandalf has special semantics: flipping it must not create
// orgs that contain a mix of v1 and v2 LLMO sites.
if (
  pathProductNorm === LLMO_FEATURE_FLAG_PRODUCT
  && flagName === LLMO_BRANDALF_FLAG
) {
  const conflict = await checkBrandalfFlagFlipSafety({
    organizationId,
    nextValue: value,            // true for PUT, false for DELETE
    context,
  });
  if (conflict) {
    return createResponse({ message: conflict.message }, 409);
  }
}
```

This makes `performLlmoOnboarding` the only writer that can create a v2 org from
scratch, and ensures any later flip is rejected when it would cause drift.

### Monitoring / discovery script

Goal from the Slack thread: *"need to do monitoring to check if there is orgs
which have sites onboarded with v1 and v2"*.

Add a one-shot script (under `src/scripts/` or `test/it/test_script/`) that:

1. Lists all organizations.
2. For each, reads the current `brandalf` flag via `readBrandalfFlagOverride`.
3. Lists sites via `Site.allByOrganizationId(orgId)`.
4. Cross-references with the v2 customer-config table populated by
   `ensureInitialCustomerConfigV2`. A site that has an `llmoConfig` but **no**
   corresponding v2 customer-config row is treated as v1.
5. Reports orgs where the set is mixed, plus orgs whose `brandalf` flag
   disagrees with the majority of their sites.

Output is a CSV/JSON file for manual remediation. The script is **read-only** —
no automatic fixes.

## Tests

### Unit tests

`test/support/llmo-onboarding-consistency.test.js` (new):

- `assertLlmoOnboardingConsistency`
  - v2 mode, org with no sites → no throw.
  - v2 mode, org with a site that has `llmoConfig` → throws.
  - v2 mode, org with a site that has no `llmoConfig` → no throw.
  - v1 mode, `brandalf=true`, org has sites with `llmoConfig` → throws.
  - v1 mode, `brandalf=null`, org has sites with `llmoConfig` → no throw
    (steady-state v1).
- `checkBrandalfFlagFlipSafety`
  - org with no onboarded sites → returns `null` for both `true` and `false`.
  - no-op flip (current === next) → returns `null`.
  - `nextValue=true` on org with v1 sites → returns conflict.
  - `nextValue=false` on org with v2 sites → returns conflict.

`test/controllers/llmo/llmo-onboarding.test.js`:

- `performLlmoOnboarding` rejects with `LlmoOnboardingConsistencyError` before
  any side effects when guard fires (assert `Site.create`, `enableAudits`,
  SharePoint copy, etc. were never called via sinon spies).
- Existing happy-path tests continue to pass.

`test/controllers/feature-flags.test.js`:

- `PUT .../LLMO/brandalf` on org with no sites → 200.
- `PUT .../LLMO/brandalf` on org with onboarded v1 sites → 409,
  `upsertFeatureFlag` never called.
- `DELETE .../LLMO/brandalf` on org currently `brandalf=true` with onboarded v2
  sites → 409.
- `PUT .../LLMO/brandalf` on org already `brandalf=true` (no-op flip) → 200
  even if it has sites.
- `PUT .../ASO/some_flag` is unaffected by the new guard.
- `PUT .../LLMO/some_other_flag` is unaffected (only `brandalf` is special).

### Integration tests

- `test/it/shared/tests/llmo-onboarding.js` /
  `test/it/postgres/llmo-onboarding.test.js`:
  - Seed an org with one v1-onboarded site, attempt v2 onboarding via
    `POST /llmo/onboard` → expect 409.
  - Seed an org with `brandalf=true` and a v2-onboarded site, attempt
    onboarding while temporarily clearing the flag → expect 409.
  - Seed a clean org → onboarding succeeds (regression).

- `test/it/shared/tests/feature-flags.js` (add if missing):
  - Seed org with one v1 site, `PUT .../LLMO/brandalf` → expect 409.
  - Seed clean org, `PUT .../LLMO/brandalf` → expect 200, then
    `POST /llmo/onboard` → expect v2 flow.

Add seed data under `test/it/postgres/seed-data/` and register in
`postgres/seed.js` per the project conventions.

## OpenAPI

Update `docs/openapi/paths/` for the affected endpoints to document the new
`409` response:

- `POST /llmo/onboard`
- `PUT /organizations/{organizationId}/feature-flags/{product}/{flagName}`
- `DELETE /organizations/{organizationId}/feature-flags/{product}/{flagName}`

Run `npm run docs:lint && npm run docs:build` before opening the PR.

## Summary of guards

| Guard | Location | Triggers when |
|---|---|---|
| Onboarding-time consistency | `performLlmoOnboarding` (after `resolveLlmoOnboardingMode`, before any side effects) | `mode === v2` and org has v1 sites; or `mode === v1` and org has v2 sites with `brandalf=true` |
| Flag-flip consistency | `persistFlag` (only for `LLMO/brandalf`) | Flipping the flag would change the org's "current mode" while it has onboarded sites |
| Monitoring script | new, read-only | Detects existing inconsistent orgs for manual remediation |

## Open questions

1. **Status code preference**: `409 Conflict` (semantically correct) vs
   `400 Bad Request` (matches existing `badRequest()` usage in
   `llmo.js`). Plan defaults to `409`.
2. **Should the guard ever be bypassable?** E.g. an admin override header for
   operators who *intentionally* want to migrate an org. Plan defaults to
   "no bypass" — operators have to off-board sites first.
3. **Rollout**: feature-flag the guard itself? Probably not necessary — the
   only effect is rejecting requests that would corrupt state, which is what
   we want.

## Implementation order

1. Add `src/support/llmo-onboarding-consistency.js` with helpers + unit tests.
2. Wire `assertLlmoOnboardingConsistency` into `performLlmoOnboarding`,
   propagate the error through `onboardCustomer` and the Slack handler, and
   add unit + integration tests.
3. Wire `checkBrandalfFlagFlipSafety` into `persistFlag`, add controller-level
   and integration tests.
4. Add monitoring script and run it once against stage to confirm the format.
5. Update OpenAPI specs and run `npm run docs:lint && npm run docs:build`.
6. Open PR with title:
   `feat(LLMO-4176): block onboarding when it would mix v1 and v2 LLMO sites in one org`,
   linking back to LLMO-4176 and the parent epic LLMO-4054, explicitly calling
   out that this is a **temporary safeguard** until a longer-term migration
   story is in place.
