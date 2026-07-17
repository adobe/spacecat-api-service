# Runbook: Serenity zombie sub-workspace recovery (dynamic AI allocation)

**Last validated:** 2026-07-14 (LLMO-6191 rollout-hardening).

How to recognize and recover a Semrush sub-workspace that is stuck "not ready" after a
partially-applied dynamic-allocation transfer, and how to read the paging signals for the JIT
top-up allocator (`SERENITY_DYNAMIC_ALLOCATION`).

---

## When to use this

- A brand's metered writes (create/publish prompts, add markets, model updates) are returning
  `503 Sub-workspace is provisioning, retry` (`workspaceBusy`) repeatedly for the **same brand**,
  well past a normal settle window.
- `AllocationRejection{Reason=workspaceBusy}` or a `NotReadyRetry` streak (see
  [Observability](#observability--paging-signals) below) is elevated for one workspace and not
  clearing on its own.
- A support ticket reports one brand permanently unable to add prompts/markets while other brands
  are unaffected (scoped to one workspace — not a broad outage; see the release-outage runbook for
  that case instead).

## Prerequisites

- **Access:** an IMS user token with standing on the affected org's Semrush workspace (same
  requirement as any `/serenity/*` call — see `docs/serenity.md`; there is **no service-account
  path** to Semrush in this repo). `mysticat auth token --ims`.
- **The brand's ids:** the SpaceCat brand id and its `semrushSubWorkspaceId` (read via
  `GET /v2/orgs/:org/brands/:brandId`, or directly from the `brands` table).
- Familiarity with `src/support/serenity/resource-manager.js` (`ensureAiHeadroom`,
  `releaseAiSurplus`) and `workspace-lifecycle.js` (`pollUntilCreated`) helps but is not required to
  follow the steps below.

## TL;DR fast path

```bash
export API_BASE=https://spacecat.experiencecloud.live/api/ci
export IMS=$(mysticat auth token --ims)

# 1. Confirm the workspace's live status
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/markets" | jq .

# 2. Retry the metered op that's failing (the transfer is idempotent — a retry after settling
#    finds it already applied and proceeds normally). Most "zombie" cases self-heal on the very
#    next customer-facing retry once the async workspace lock actually clears.

# 3. If it does NOT clear after a few minutes, escalate — this repo has no admin endpoint to force
#    a workspace out of "not ready" (see Step 3 below).
```

---

## Step 1 — Confirm the symptom, not just the alarm

`workspaceBusy` (503) is the allocator's **expected, retryable** signal when a transfer hits the
Semrush async "workspace not ready" lock (`isWorkspaceNotReady`, `src/support/serenity/errors.js`).
A single 503 is normal — the transfer is absolute + idempotent, so the client/UI is expected to
retry. This runbook is for when the SAME workspace keeps returning it well past a normal settle
window (minutes, not seconds), i.e. the async lock itself appears stuck.

Grep Splunk for the specific workspace (see `docs/serenity.md`'s Observability section for the
index/sourcetype):

```spl
index=dx_aem_engineering sourcetype=dx_aem_sites_spacecat_backend_<env> service=api-service
  "SERENITY_ALLOC" "<subWorkspaceId>"
```

Look for a repeated `SERENITY_ALLOC transfer never cleared workspace-not-ready` line
(`resource-manager.js`, `transferAndSettle`) or repeated `SERENITY_ALLOC workspace not ready on
transfer — returning 503` (`transferOnce`, the fail-fast hot path) for the SAME workspace id across
multiple, separated requests.

## Step 2 — Rule out an in-flight partial transfer (the actual "zombie" cause)

A sub-workspace can be left "not ready" when a transfer was applied upstream but the
Adobe/Semrush-side async settle never completed — the write went out, but the workspace's public
status keeps reporting a transitional state. Confirm live status:

```bash
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/markets" | jq '.[].status'
```

If markets report `status` other than the expected live value, or the brand's activation state
(`GET /v2/orgs/:org/brands/:brandId`) shows `pending` when you expect `active`, the workspace is
likely still mid-settle upstream, not a bug in this codebase.

## Step 3 — Attempt recovery

There is **no admin/automation endpoint in this repo** to force a stuck workspace's state — every
`/serenity/*` call is a normal customer-facing operation gated on a live IMS user token (see
`docs/serenity.md`'s "IMS-user only" caveat). Recovery options, in order:

1. **Wait and retry the original failing operation.** The transfer is idempotent
   (`transferOnce`/`transferAndSettle`, `resource-manager.js`) — a retry once the async lock clears
   upstream simply finds the workspace already at the intended total and proceeds. Most cases
   resolve within the `LOCK_TIMEOUT_MS`/poll-attempt windows already built into the allocator
   (`DEFAULT_POLL`, 12 attempts × 1s, plus `NOT_READY_RETRIES` backoff — see `resource-manager.js`).
2. **Re-run `ensureAiHeadroom` for the workspace manually** (e.g. via a one-off invocation in a
   Node REPL against the target env, using `createSerenityTransport` the same way
   `scripts/serenity-rightsizing-sweep.mjs` does) if you need to confirm the transfer settles
   outside of a live customer request. This performs no destructive action — it only re-reads and,
   if still short, re-tops-up.
3. **If the workspace remains stuck for longer than ~30 minutes**, this is very likely an
   upstream (Semrush) issue, not something this codebase can resolve — escalate to the Semrush/
   Project-Engine API owners with the workspace id and the Splunk trace from Step 1. There is no
   decommission-and-recreate path for a sub-workspace short of the destructive
   `POST /serenity/deactivate` (which deletes every project in it — see `docs/serenity.md`'s
   Activate/deactivate caveats) followed by a fresh `activate`; treat that as a last resort, and
   confirm with the brand owner first since it is data-destructive.

## Observability — paging signals

See `src/support/serenity/allocation-metrics.js` for the full metric catalog
(`Mysticat/SerenityAllocation` CloudWatch namespace). The two classes that matter for THIS runbook:

| Metric | Dashboard-only or pager-worthy | Why |
|---|---|---|
| `AllocationRejection{Reason=orgPoolExhausted\|brandAiLimit}` | Dashboard-only | Expected under normal load on a small pool — not a bug. |
| `AllocationRejection{Reason=workspaceBusy}` | **Pager-worthy** | The transfer never cleared the async lock — JIT top-up itself is degraded, not just short on quota. Sustained/repeated for one workspace is this runbook's trigger. |
| `NotReadyRetry` | **Pager-worthy** if a run exhausts all retries (correlate with the `workspaceBusy` counter, which fires exactly when a retry run exhausts) | A rising rate without exhaustion is just gateway latency; exhaustion is the actionable signal. |
| `ReleaseOutcome{Reason=requires-decommission}` | Dashboard-only, but track the trend | A standing pool-leak signal — surplus that can never be reclaimed short of workspace delete. Not urgent per-occurrence, but a rising trend means the rightsizing sweep (`scripts/serenity-rightsizing-sweep.mjs`) or a decommission pass is due. |
| `ReleaseOutcome{Reason=error}` / `AllocationRejection` generally | Dashboard-only | Expected fleet noise on a live allocator. |

**Alerting caveat:** this repo has no alerting-as-code file to declare a CloudWatch/Coralogix alarm
in — the metrics above are emitted (EMF → CloudWatch), but wiring an actual alarm/pager rule for
`AllocationRejection{Reason=workspaceBusy}` and retry-exhaustion is a **manual step** an operator
must still take in the CloudWatch/Coralogix console (or via `mcp__coralogix__manage_alerts` if
you're doing it from an agent session) — this PR does not invent a new alerting pipeline to do it
automatically, per LLMO-6191's scope guidance. Do this before turning `SERENITY_DYNAMIC_ALLOCATION`
on for real traffic.

## Command quick-reference

```bash
# check a brand's live market/status
curl -s -H "Authorization: Bearer ${IMS}" \
  "${API_BASE}/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/markets" | jq .

# Splunk trace for one workspace
index=dx_aem_engineering sourcetype=dx_aem_sites_spacecat_backend_<env> service=api-service
  "SERENITY_ALLOC" "<subWorkspaceId>"

# dry-run the rightsizing sweep against one brand (also a safe way to probe a workspace's state)
POSTGREST_URL=... SEMRUSH_IMS_TOKEN=... node scripts/serenity-rightsizing-sweep.mjs \
  --dry-run --org-ids ${ORG_ID} --brand-ids ${BRAND_ID}
```
