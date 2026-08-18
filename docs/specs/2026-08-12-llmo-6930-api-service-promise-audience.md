# LLMO-6930 — audience-driven IMS promise pair in api-service

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Author** | Char |
| **Created** | 2026-08-12 |
| **Updated** | 2026-08-12 |
| **Decided** | N/A |
| **Approvers** | N/A |
| **Jira** | LLMO-6930 (parent LLMO-6623) |

## Summary

Let a request choose the dedicated Semrush IMS promise-token pair, via an
optional `x-promise-audience: semrush` header, for both the synchronous
serenity/elements/brands surfaces and the asynchronous Path-B classify-prompts
job. Absent the header, everything uses today's default pair — no behavior
change. Consumes the `opts.pair` selector shipped in
`@adobe/spacecat-shared-ims-client@1.16.0` (LLMO-6928).

This spec covers api-service only. The header is minted UI-side and accepted by
auth-service (LLMO-6929); the cross-repo design and rollout live in LLMO-6623.

## Problem Statement

### Current State

Every promise-token mint and exchange in api-service uses the single default
pair, because `ImsPromiseClient.createFrom(context, type)` reads one fixed set
of env vars. Three selection sites exist:

- **Sync serenity/elements/brands:** all funnel through
  `resolveSemrushImsToken` (`src/support/utils.js:929`), which reads
  `x-promise-token` and exchanges it via `exchangePromiseToken` (CONSUMER).
- **Path-B mint:** `createAndEnqueueJob` (`async-job-runner.js:94`) mints via
  `getIMSPromiseToken` (EMITTER) and stores the token on job metadata.
- **Path-B exchange/invalidate:** `exchangeAndPersistPromiseToken` and
  `invalidateJobPromiseToken` build a CONSUMER client from job metadata.

None can select the Semrush pair.

### Desired State

- A request carrying `x-promise-audience: semrush` uses the Semrush pair end to
  end (mint + exchange + invalidate); the exchanged token then carries the
  `semrush` scope (proven at the IMS level for both stage and prod pairs).
- No header → default pair, byte-identical to today.
- An unknown audience value → 400 (fail closed), matching auth-service.
- The five stay-behind `getIMSPromiseToken` callers (`edge-routing-auth`,
  `fixes`, `page-relationships`, `scrapeJob`, `suggestions`) are untouched and
  stay on the default pair.

## Goals and Non-Goals

### Goals

- One helper, `resolvePromisePair(context)`, that maps the header to a pair
  selector (`'SEMRUSH'` | undefined) or throws 400.
- Thread an optional `pair` through `getIMSPromiseToken` / `exchangePromiseToken`
  and into `resolveSemrushImsToken`, so all sync Semrush surfaces get audience
  support with no per-call-site change.
- Persist the pair on Path-B job metadata at enqueue; read it back at
  exchange/invalidate. Absent metadata → default pair (old queued jobs keep
  working).
- Bump `@adobe/spacecat-shared-ims-client` 1.14.0 → 1.16.0; fix the stale
  "pinned at 1.12.7" comment in `async-job-runner.js`.

### Non-Goals

- No UI change, no auth-service change (their own sub-tasks).
- No Vault change and NO flip of `SEMRUSH_PROJECTS_BASE_URL` (separate step,
  after Path A+B proofs).
- The header path stays dormant until the UI sends it — this PR is inert in prod.

## Proposed Solution

### The audience → pair mapping (one place)

`resolvePromisePair(context)` in `src/support/utils.js`, keyed on a new
`X_PROMISE_AUDIENCE_HEADER = 'x-promise-audience'` constant:

- header absent/empty → `undefined` (default pair)
- `'semrush'` → `ImsPromiseClient.PROMISE_PAIR.SEMRUSH`
- any other value → throw `ErrorWithStatusCode(400)`

### Sync path (no call-site changes)

- `getIMSPromiseToken(context, pair)` and `exchangePromiseToken(context, token, pair)`
  gain an optional trailing `pair`, forwarded as `createFrom(context, TYPE, { pair })`.
  `pair === undefined` resolves the default pair (the ims-client selector treats
  absent as default).
- `resolveSemrushImsToken` computes `pair = resolvePromisePair(context)` and
  passes it to `exchangePromiseToken`. Every sync Semrush surface
  (serenity ×~17, elements, brands, brand-provisioning, url-inspector) inherits
  audience support unchanged, because they already call this helper.

### Async path (Path B)

- `createAndEnqueueJob(context, { jobType, metadata, promiseToken, promisePair })`:
  `pair = promisePair ?? resolvePromisePair(context)`; mint via
  `getIMSPromiseToken(context, pair)`; persist `metadata.promisePair = pair`.
  The `promisePair` param mirrors the existing `promiseToken` param for the
  worker self-requeue path (the worker has no request headers).
- `exchangeAndPersistPromiseToken` / `invalidateJobPromiseToken`: read
  `job.getMetadata().promisePair` and pass it to `createFrom(CONSUMER, { pair })`.
- The worker self-requeue (`handlers/classify-prompts-job.js`) forwards the
  processing job's `promisePair` into its `createAndEnqueueJob` call.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| Read the header once in `resolveSemrushImsToken` + `resolvePromisePair` helper | ~25 call sites unchanged; one source of the mapping | none material | Selected |
| Add an `audience` argument to every serenity/elements/brands call site | explicit at each site | ~25 edits, easy to miss one → silent default-pair | Rejected |
| Persist the whole audience string on job metadata | flexible | leaks the header contract into stored data; pair enum is enough | Rejected |

## Success Criteria

### Functional Requirements

- [ ] No header anywhere → identical mint/exchange/invalidate behavior to today.
- [ ] `x-promise-audience: semrush` → Semrush pair on the sync path (via
      `resolveSemrushImsToken` → `exchangePromiseToken`).
- [ ] `x-promise-audience: semrush` → Semrush pair minted at enqueue, persisted,
      and used at exchange + invalidate for Path B.
- [ ] Unknown audience value → 400.
- [ ] A queued job with no `promisePair` in metadata exchanges on the default
      pair (backward compatible).
- [ ] The five stay-behind `getIMSPromiseToken` callers are unmodified.

### Validation Plan

- [ ] Unit: `test/support/utils.test.js` (resolvePromisePair cases; pair
      pass-through on the two helpers; resolveSemrushImsToken audience) and
      `test/support/serenity/async-job-runner.test.js` (pair persisted at
      enqueue; read at exchange/invalidate; absent → default). Bar 90/90/90.
- [ ] `npm run type-check` — the `// @ts-check` typedef for `createFrom` in
      `async-job-runner.js` must gain the optional `opts` arg.
- [ ] `npm run build` — bundle healthcheck (per repo CI gate).
- [ ] End-to-end proof of the Semrush pair is done in LLMO-6623's Path A/B runs,
      not here.

## Dependencies

- `@adobe/spacecat-shared-ims-client@1.16.0` (LLMO-6928, published) — provides
  `createFrom(context, type, { pair })` and `PROMISE_PAIR`.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A sync surface silently stays on the default pair | Low | Med | Selection lives in the shared `resolveSemrushImsToken`, not per-site |
| Old in-flight Path-B jobs break at exchange | Low | High | Missing `promisePair` → default pair; explicit test |
| `// @ts-check` breaks on the new arg | Med | Low | Update the local `TypedImsPromiseClient.createFrom` typedef |
| Unknown audience silently defaults | Low | Med | `resolvePromisePair` throws 400 on unknown |

## References

- Parent: LLMO-6623; ims-client selector: LLMO-6928 (published 1.16.0).
- `src/support/utils.js` (`resolveSemrushImsToken`, `getIMSPromiseToken`, `exchangePromiseToken`).
- `src/support/serenity/async-job-runner.js` (Path B).

---

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-08-12 | Char | Initial draft |
