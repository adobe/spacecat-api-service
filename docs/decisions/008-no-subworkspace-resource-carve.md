# ADR-008: A brand sub-workspace carries no resource allocation

## Context

A brand's Semrush sub-workspace was provisioned with an AI resource allocation carved out of the
organization's parent pool: a fixed `{projects: 1, prompts: 500}` at create, a
`{projects: marketCount + 2}` re-grant on every activation, and a transfer back down to a
`{projects: 1, prompts: 1}` floor on deactivate and on provisioning-failure cleanup.

The carve existed on the premise that a child with zero metered quota rejects metered writes — a
prompt write or a live publish would come back as a disguised `405`. That premise was recorded in
the source and in `docs/serenity.md`, but it was never probed against a parent with metering
disabled.

Two properties of the upstream make the carve a liability:

- **Product metering and unit accounting are separate systems.** `limits_enabled: false` on a
  parent's `ai` product disables metering of project creates and prompt writes. It does *not* stop
  `POST .../resources/transfer` from validating requested totals against the subscription's units,
  which it does strictly, returning a terminal `422 insufficient available units in subscription`.
- **The transfer sets absolute totals, not deltas.** A brand's *first* market therefore demanded
  the child's project total be raised to 3, requiring free units in the parent for a workspace that
  needed one project.

So the carve could never grant a child a capability it lacked; it could only fail a request that
would otherwise have succeeded. On 2026-07-28 it did exactly that in production: a brand could not
add its first market, dying at the allocation step with a generic `502 serenityUpstreamError`
before the request ever reached project creation, against a parent pool of 2 project units.

## Decision

A brand's sub-workspace carries **no AI resource allocation of its own**. It is created with no
`resources` payload, and no lifecycle path transfers units onto or off it. `resourceAllocation`,
`CREATE_ALLOCATION`, `DEFAULT_RELEASE_FLOOR` and `releaseFullAllocation` are gone; decommission and
every failure-cleanup path empty the workspace's projects and leave the shell in place.

The just-in-time allocator (`resource-manager.js`, `dynamic-allocation-active.js`, ADR-007) is
**retained, dormant**, behind `SERENITY_DYNAMIC_ALLOCATION`. It becomes the only mechanism that can
ever size a child.

### Evidence

Live probe against the LLMO-Dev-2 parent on `adobe-hackathon.semrush.com`, 2026-07-28. A child
created with no `resources` body:

- settled to `created` and reported `projects 0/0  prompts 0/0`;
- accepted `createProject`, a two-prompt draft, and `publishProject`, all without error;
- finished at `projects.used: 1` against `total: 0` — the upstream permitted it to exceed a zero
  total outright;
- returned both prompts from the LIVE (published) prompt view, confirming the publish landed rather
  than succeeding as a silent no-op.

Every real customer parent read that day carried `limits_enabled: false` with a pool on the order of
200 projects against zero used.

## Consequences

- A market create no longer performs a mandatory upstream write before doing its actual work, and
  can no longer fail for a capacity reason that does not apply. Two upstream round trips leave the
  bound-workspace activation path and one leaves the create path.
- **Children provisioned before this change keep their existing carve.** Nothing reclaims it: with
  the release transfers gone, a deactivate no longer returns those units to the parent pool. This is
  accepted — the pools are unmetered and effectively unbounded, so stranded units cost nothing.
  `scripts/serenity-rightsizing-sweep.mjs` can reclaim them if a pool ever does matter.
- The failure mode the carve produced — a capacity refusal surfacing as an opaque `502` — is gone
  from the lifecycle. The JIT path, which maps the same upstream condition to a typed
  `409 orgPoolExhausted`, is the only remaining producer of it.
- **A tenant whose parent enforces limits would get no sizing at all.** This is the risk the
  retained allocator covers. Nothing detects such a tenant automatically; the operator signal and
  the flip procedure are documented in `docs/serenity.md` § When to turn the JIT allocator on.

## Alternatives considered

**Gate every remaining allocation write on `!isDynamicAllocationEnabled(env)`.** Keeps a one-flip
rollback to the carve. Rejected: the flag was `false` in production, so this would have left the
failing behaviour switched on by default and required a second decision to actually fix the
outage — and it preserves in the tree a mechanism the evidence shows can only do harm.

**Delete the JIT allocator alongside the carve.** Rejected: the evidence supports "our parents are
unmetered", not "no tenant is ever metered". Deleting is a one-way door, and re-deriving block
rounding, absolute-set transfer semantics, the `workspaceBusy` retry and the cross-container lock
(ADR-007) is substantial work. It is proven against the post-change starting state — the
integration suite drives the flag-on path end-to-end from a child seeded at `{used: 0, total: 0}`.
