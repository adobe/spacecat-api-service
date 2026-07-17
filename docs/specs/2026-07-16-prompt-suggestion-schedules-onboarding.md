# Prompt-Suggestion Schedules at Onboarding — spacecat-api-service

**Date:** 2026-07-16
**Related:** spacecat-shared `createSchedule` (spec: `docs/specs/prompt-suggestion-schedules/spec.md` in spacecat-shared) · DRS PR #2714 (server authority) · DRS PR #2719 (cross-run SR merge)

## Overview

Registers three **recurring** DRS prompt-suggestion schedules during V2 LLMO
onboarding, each with an immediate first run:

| Pipeline | Provider id | Cadence |
|---|---|---|
| SEMrush suggestions | `prompt_generation_semrush` | twice-monthly |
| Citation Attempts | `prompt_generation_agentic_traffic` | twice-monthly |
| Synthetic Personas | `prompt_generation_synthetic_personas` | quarterly |

This is the onboarding-trigger slice of the cross-repo prompt-suggestion
schedules feature. The durable outcome is the recurring schedule row created in
DRS; the immediate run is best-effort.

## Change

**File:** `src/controllers/llmo/llmo-onboarding.js` (+ tests)

- A data-driven `PROMPT_SUGGESTION_PIPELINES` table (`{ name, providerId, cadence }`)
  is the single source of truth; `registerPromptSuggestionSchedules(...)` iterates
  it and calls `drsClient.createSchedule({ siteId, providerIds: [providerId],
  cadence, description, enableBrandPresence: false, triggerImmediately: true })`
  per pipeline. Adding a fourth pipeline is a one-line table edit.
- Invoked from `activateBrandAndGeneratePrompts` (V2 block), **after** the
  Brandalf trigger.

## Design decisions

- **Best-effort, never abort onboarding.** `DrsClient.createFrom(context)` is
  wrapped in its own try/catch; if it throws, both the Brandalf trigger and
  schedule registration are skipped (logged at ERROR + Slack `:warning:`) and
  onboarding still succeeds. Each pipeline's `createSchedule` is wrapped in a
  per-item try/catch so one provider failing does not block the others; a
  registration failure is logged at ERROR with `provider_id` + `site_id` +
  `status` (never silently swallowed).
- **Latency bound.** The whole registration is wrapped in
  `settleWithin(..., 8000ms)` so a slow/hung DRS cannot stall the synchronous
  onboarding response. This is safe because `createSchedule` is idempotent — the
  schedule row is created server-side even if the client times out waiting.
- **Sequencing (honest).** The immediate run fires right after Brandalf is
  *submitted* (async), so for a genuinely new site it typically no-ops (no base
  prompts yet) and self-heals on the next scheduled run. For Synthetic Personas
  (quarterly) this means a cold-start site may wait up to a quarter for first
  output. Chaining the first run off base-prompt-gen completion is a tracked
  cross-repo follow-up (LLMO-4258), not done here.
- **`enable_brand_presence: false`** — these are prompt-only; not fed into the
  brand-presence post-processing / SNS allowlist.
- **Tenant identity.** Only `siteId` crosses the boundary. No `imsOrgId`/`orgId`
  is threaded — DRS derives the isolation key from `siteId` server-side.

## Dependency / deployment order

`createSchedule` ships in `@adobe/spacecat-shared-drs-client@1.14.0` (spacecat-shared PR #1816), which is not yet published. Therefore:

1. Merge spacecat-shared PR #1816 → semantic-release publishes `1.14.0`.
2. Bump `@adobe/spacecat-shared-drs-client` to `1.14.0` here and regenerate
   `package-lock.json` → this PR's CI (`npm ci` / build / type-check) goes green.
   Until then those checks fail with `ETARGET No matching version ... @1.14.0` —
   expected, not a code defect.

## Out of scope (tracked elsewhere)

- Provider enablement (per-provider Fargate whitelists) + VPC-quota sign-off.
- The agentic-traffic 0-prompt health fix must land before Citation Attempts is
  scheduled recurringly.
- Backfilling schedules for already-onboarded sites (DRS multi-site script).
