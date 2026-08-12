# ADR-009: Remove the dormant JIT Semrush AI allocator

> **Supersedes** the allocator-retention decision in [ADR-008](008-no-subworkspace-resource-carve.md)
> ("the JIT allocator is retained, dormant, behind `SERENITY_DYNAMIC_ALLOCATION`") and the mitigation
> recorded in [ADR-007](007-cross-container-resource-lock.md). Both ADRs' no-carve / lock findings
> remain valid as history; the mechanism they retained is now deleted. Driver: serenity-docs#72
> §10.1/§10.2, SITES-49206 (2026-08).

## Context

[ADR-008](008-no-subworkspace-resource-carve.md) decided that a brand sub-workspace carries no AI
resource allocation, but **retained** the just-in-time allocator (`resource-manager.js`,
`dynamic-allocation-active.js`) dormant behind `SERENITY_DYNAMIC_ALLOCATION` as a fallback for a
hypothetical tenant whose parent still enforces AI limits. [ADR-007](007-cross-container-resource-lock.md)
recorded the cross-container lock (`resource-lock.js`) that protected that allocator's absolute-set
transfer race.

The flag was `false` in every deployed environment and was never turned on. Two facts have since
made the retained fallback pure carrying cost rather than insurance:

- **Semrush no longer enforces AI limits for proxy-routed LLMO workspaces.** The premise the
  allocator covered — a parent that rejects metered writes for lack of units — has no live instance.
  The single metered observation on record (the GM migration) is consistent with this, and the soak
  requirement in serenity-docs#72 §10 ("not the same week") is met.
- **A dormant, flag-off mechanism is not free.** It is unexercised code sitting on the write path's
  type surface, it anchors ADR-007's lock and a body of allocation / metrics / pool-alerting
  machinery, and every reader of the sub-workspace lifecycle must reason about a branch that never
  runs.

## Decision

Delete the JIT allocator and everything that exists only to serve it:

- `src/support/serenity/resource-manager.js` (`ensureAiHeadroom` / `releaseAiSurplus`, the headroom
  guard);
- `src/support/serenity/dynamic-allocation-active.js` (the `SERENITY_DYNAMIC_ALLOCATION` flag gate);
- `src/support/serenity/resource-lock.js` (the cross-container lock — ADR-007);
- `scripts/serenity-rightsizing-sweep.mjs` (the offline reclaim tool, which hard-imports
  `releaseAiSurplus` and cannot compile without the allocator);
- the org-pool early-warning alert (`alertPoolFreeThreshold`) and the `countPublishedPrompts`
  re-meter sizing, both of which had the allocator as their only caller;
- the flag-ON integration path.

The publish-retry injection seam (`wrapPublish`) and the disguised-405 quota classification /
alerting are **kept** — they belong to the metered-write boundary that serenity-docs#72 §10.6
governs, not to the allocator. The no-carve behaviour from ADR-008 is now the only behaviour,
unconditional.

This adopts the alternative ADR-008 recorded as **"Delete the JIT allocator alongside the carve.
Rejected."** The two grounds for that earlier rejection have resolved:

1. *"The evidence supports 'our parents are unmetered', not 'no tenant is ever metered'."* Semrush's
   confirmation plus the soak now support the stronger claim. The standing check that it still holds
   is the `scripts/serenity-metered-405-canary.mjs` probe (serenity-docs#72 §10), run per
   environment — **not** a flag to flip back on.
2. *"Deleting is a one-way door and re-deriving the allocator is substantial work."* Accepted. The
   design is preserved in git history and in ADR-007 / ADR-008 as records; if a metered tenant ever
   appears, the allocator is re-introduced from history rather than re-enabled by a dead flag.

## Consequences

- **Stranded pre-change carves now have no in-tree remedy.** Children provisioned before ADR-008 keep
  their existing carve, and with both the release transfers (ADR-008) and the rightsizing sweep (this
  ADR) gone, nothing reclaims those units. Accepted for the same reason ADR-008 gave: the pools are
  unmetered and effectively unbounded, so stranded units cost nothing. The difference from ADR-008 is
  that the reclaim tool it pointed at no longer exists — reclamation would have to be re-built.
- **A tenant whose parent enforces limits would get no sizing, and there is no longer a flip
  procedure.** ADR-008 pointed operators at a "when to turn the JIT allocator on" runbook; that
  section and the allocator it armed are both removed. The `serenity-metered-405-canary.mjs` probe is
  the replacement signal — it verifies the no-carve premise per environment; a failure is the trigger
  to re-introduce the allocator from history, not to re-enable a flag.
- **The cross-container race in ADR-007 no longer exists in the tree.** Its lock is deleted; the
  sub-workspace lifecycle transfers no resources, so there is nothing to serialize.

## Alternatives considered

**Keep the header-note approach on ADR-008 and leave the allocator dormant.** Rejected: the flag was
never on and the premise it covered has no live instance, so the mechanism was cost without cover
(see Context). Leaving it also leaves ADR-008's rejected alternative silently inverted in the tree
rather than recorded as a decision.

**Delete the allocator but keep the rightsizing sweep** for stranded-carve reclamation. Rejected: the
sweep hard-imports `releaseAiSurplus` and the block constants from `resource-manager.js`, so it
cannot compile once the allocator is gone (serenity-docs#72 §10.7 sequences it *with* §10.1 for this
reason). Reclamation, if it is ever needed, is re-built against whatever the store looks like then.
