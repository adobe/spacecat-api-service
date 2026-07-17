# ADR-007: Cross-container serialization for the dynamic-allocation absolute-set race

## Context

The dynamic (JIT) Semrush AI resource allocator (PR #2764, `SERENITY_DYNAMIC_ALLOCATION`, default
OFF) does an **absolute set** of a sub-workspace's resource `total` — it reads the child's current
totals, computes a new one, and transfers it (`ensureAiHeadroom` and `releaseAiSurplus`, both in
`src/support/serenity/resource-manager.js`). Two operations that read the same child concurrently
and then each write an absolute value can clobber one another: the later write wins with a value
computed from a now-stale read.

`src/support/serenity/resource-lock.js` (`withResourceLock`) serializes same-child mutations via an
in-process promise chain with a `LOCK_TIMEOUT_MS` (10s) safety valve. This PR (LLMO-6191) also wraps
`releaseAiSurplus`'s one production call site (`markets-subworkspace.js`, the model-update seam) in
the same lock, so **both** `ensureAiHeadroom` and `releaseAiSurplus` now serialize against each other
for the same child, within one warm Lambda container. That closes the same-container half of the
race. Across separate warm containers — the normal case for a Lambda-per-request API service — there
is **no serialization at all**, so the race is fully open cross-container. This ADR is about closing
that remaining gap (or deciding, explicitly, not to yet).

Constraints on the options below: no new cloud infrastructure may be provisioned unilaterally by this
PR (no new DynamoDB table, no new Redis/ElastiCache instance — see the LLMO-6191 scope guidance).
This repo has **zero existing DynamoDB usage** (no `@aws-sdk/client-dynamodb` dependency) and no
distributed-lock/conditional-write primitive was found in `@adobe/spacecat-shared` either.

### Corrected failure-mode analysis (staff-engineer review)

The absolute-set mechanic that CAUSES the race is also what BOUNDS it — this matters for how risky
"do nothing yet" actually is:

- **ensure-vs-ensure** (two concurrent top-ups on the same child): each call computes its own
  `target = roundUpToBlock(...)`, ceiling-clamped (`resource-manager.js`, `ensureAiHeadroom`). The
  last writer wins with **its own legitimate, ceiling-bounded target** — the final total is never
  higher than `max(target_a, target_b)`. No ceiling breach, no unbounded over-write, no double-charge
  of the parent pool. Worst case: the loser's top-up is silently absorbed and the next metered op
  that finds itself still short just re-triggers `ensureAiHeadroom` — self-healing.
- **ensure-vs-release** (an `ensureAiHeadroom` topping up a child racing a `releaseAiSurplus` lowering
  the same child — now closed IN-PROCESS by this PR's lock wrap, but still open cross-container): a
  stale `release` writing last can set `total` below the now-real `used` (a transient
  **oversubscribed child**, rejecting the in-flight metered write until the next `ensure` heals it —
  not silent data loss, but not "just re-tops-up" either). A stale `ensure` writing last after a
  `release` already lowered the child can draw more from the master than its own advisory pool check
  computed (bounded only by the master's terminal `422`, not by the advisory read).

Neither interleaving causes data loss or a permanent ceiling breach. The corrected framing: **worst
case is a transient oversubscription/over-draw window, self-healing on the next `ensureAiHeadroom`,
never corruption or a stuck permanent state.**

## Decision

**Adopt Option C (accept the current risk band, observe, revisit on signal) for the initial ON
rollout — conditional on the LLMO-6191 item-2 observability landing first**, not as an independent
decision made in isolation. `TopUpLatencyMs`, `PoolFreeRatio`, and the `AllocationRejection`/
`ReleaseOutcome` metrics (`src/support/serenity/allocation-metrics.js`) are the concrete signal this
ADR's "revisit if it manifests" promise depends on — this status is NOT "Accepted, ship and forget."

Options considered:

**A — DynamoDB conditional write (new infra).** A lock-holder row per child workspace id, written
with a `ConditionExpression` (only succeeds if unheld or the holder's TTL expired), TTL as the
auto-expiry safety valve mirroring `LOCK_TIMEOUT_MS`. Correct, well-understood pattern. Cost: a new
table, IAM policy, and an operational surface (TTL tuning, hot-partition risk on a busy child) this
repo does not have today. Requires provisioning review — out of scope for this PR per the ticket's
scope guidance.

**B — Push the fix upstream (Semrush optimistic concurrency).** If the Semrush transfer API accepted
an `expected_total` (compare-and-swap) parameter, a stale writer would get a rejection instead of
silently clobbering, and no distributed lock would be needed at all — the upstream call becomes
self-serializing. **Unverified**: whether the live gateway supports this is an open question, not
confirmed against the tenant. If it does, this is the strongest option (no new infra, and it fixes
the root cause rather than working around it). Action item: check with the Semrush/Project-Engine
API owners before ruling this out permanently.

**C — Accept + observe (recommended for now).** Ship with the current risk band: same-container race
closed (this PR), cross-container race open but bounded to a transient, self-healing oversubscription
window (never corruption, never a permanent ceiling breach — see the analysis above). Watch the
item-2 telemetry (`TopUpLatencyMs`, `PoolFreeRatio`, `AllocationRejection`, `ReleaseOutcome`) for
repeated-oversubscription symptoms (e.g. a `workspaceBusy` spike shortly after a top-up, or a
`ReleaseOutcome` pattern suggesting a release clobbered a subsequent ensure) as the live signal of
whether this actually manifests at current traffic. Revisit with Option A, B, or D if it does.

**D — SQS FIFO with `MessageGroupId = childWorkspaceId` (SRE review addition).** This repo already
speaks SQS (`src/support/sqs.js`); a FIFO queue's per-group ordering IS a cross-container
serialization primitive without provisioning new infrastructure CLASS (an existing AWS primitive,
not a new one). It would reframe the hot path from synchronous-locked to enqueue-and-settle, which
also retires the fail-fast/504 tension `ensureAiHeadroom`'s hot path currently has to work around.
Real costs: async top-up latency (the request would have to wait for a queue round-trip, or the
metered write would have to happen optimistically before the top-up is confirmed — a different
correctness contract than today's), a new consumer worker, and reordering the synchronous gate
contract every metered handler currently relies on (`createHeadroomGuard.ensure` is awaited
in-request today). Worth a real look if Option C's telemetry shows the race manifesting, but a bigger
shape change than A or B.

**E — Single-flight coalescing (SRE review addition, NOT cross-container).** Not a serialization
primitive on its own — de-duplicating concurrent identical top-up requests within a container reduces
contention but does not touch the cross-container case. Cheap, but only a partial mitigation; already
effectively achieved in-container by `withResourceLock`.

## Status

Accepted, contingent on the item-2 observability metrics being live and watched (see LLMO-6191 PR).
In-PR mitigation shipped now: `releaseAiSurplus`'s one production call site is wrapped in
`withResourceLock` alongside `ensureAiHeadroom`, closing the same-container ensure/release race —
see `src/support/serenity/handlers/markets-subworkspace.js`. The cross-container gap remains open,
by design, per Option C above. Revisit this ADR (promote to Option A, B, or D) if the item-2 signals
show the race manifesting at real traffic, or if the Semrush API owners confirm Option B is
available — check that before committing engineering time to Option A's new infrastructure.
