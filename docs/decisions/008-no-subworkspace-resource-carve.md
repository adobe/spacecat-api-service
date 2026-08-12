# ADR-008: A brand sub-workspace carries no resource allocation

> **Update (2026-08, SITES-49206).** The **no-carve decision stands and is now unconditional.** Its
> secondary decision — to *retain* the dormant JIT allocator behind `SERENITY_DYNAMIC_ALLOCATION` as
> a fallback — has been **reversed**: the allocator is removed (Semrush no longer enforces AI limits
> for proxy-routed LLMO workspaces). That reversal, which adopts this ADR's own rejected alternative
> ("Delete the JIT allocator alongside the carve"), is recorded in
> [ADR-009](009-remove-dormant-jit-allocator.md). Every reference below to the allocator being
> retained behind a flag, to a flip procedure, or to a reclaim sweep is **historical** — see the
> inline notes and ADR-009 for the current state.

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

> **Reversed (SITES-49206, ADR-009).** The allocator has since been removed, not retained; there is
> no longer any mechanism that can size a child. See [ADR-009](009-remove-dormant-jit-allocator.md).

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
  _(SITES-49206: the `scripts/serenity-rightsizing-sweep.mjs` reclaim tool this line originally
  pointed at has since been deleted with the allocator — see ADR-009. Stranded carves now have no
  in-tree remedy; reclamation would have to be re-built if a pool ever does matter.)_
- The failure mode the carve produced — a capacity refusal surfacing as an opaque `502` — is gone
  from the lifecycle. _(SITES-49206: the JIT path that mapped the same upstream condition to a typed
  `409 orgPoolExhausted` has since been removed with the allocator — see ADR-009. No lifecycle path
  produces that condition today.)_
- **A tenant whose parent enforces limits would get no sizing at all.** _(SITES-49206: this was the
  risk the retained allocator covered. The allocator, and the "when to turn the JIT allocator on"
  flip procedure this line pointed at in `docs/serenity.md`, are both removed — see ADR-009. The
  re-check, for now, is the `scripts/serenity-metered-405-canary.mjs` probe — a **manual**
  per-environment run read by what the publish does at zero headroom (it exits 0 either way): a
  publish that **succeeds** confirms the premise, a disguised **405** means Semrush is enforcing again
  and is the trigger to re-introduce the allocator from history, not to flip a flag. (The script's
  own `expected`/`UNEXPECTED` labels are LLMO-6190 fixture-capture language and read the opposite way
  — see its header.) It is not a standing signal: serenity-docs#72 §10.7 retires it together with the
  §10.6 classifier, so the durable re-check beyond that point is an open question §10.6 must settle —
  see ADR-009 Consequences.)_

## Alternatives considered

**Gate every remaining allocation write on `!isDynamicAllocationEnabled(env)`.** Keeps a one-flip
rollback to the carve. Rejected: the flag was `false` in production, so this would have left the
failing behaviour switched on by default and required a second decision to actually fix the
outage — and it preserves in the tree a mechanism the evidence shows can only do harm.

**Delete the JIT allocator alongside the carve.** Rejected _at the time_: the evidence supported "our
parents are unmetered", not "no tenant is ever metered". Deleting is a one-way door, and re-deriving
block rounding, absolute-set transfer semantics, the `workspaceBusy` retry and the cross-container
lock (ADR-007) is substantial work. It is proven against the post-change starting state — the
integration suite drives the flag-on path end-to-end from a child seeded at `{used: 0, total: 0}`.

> **Subsequently adopted (SITES-49206, ADR-009).** Semrush's confirmation that it no longer enforces
> AI limits for proxy-routed workspaces, plus the soak, resolved the first objection; the one-way-door
> cost is accepted, with the design preserved in git history and the `serenity-metered-405-canary.mjs`
> probe as the interim (manual, per-environment) re-check — itself retired with the §10.6 classifier,
> beyond which the durable re-check is an open question §10.6 must settle. See
> [ADR-009](009-remove-dormant-jit-allocator.md).
