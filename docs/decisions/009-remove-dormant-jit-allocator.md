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

Several surfaces are **kept**, none belonging to the allocator any more, and they have *different*
lifetimes — do not batch them:

- the publish-retry injection seam (`wrapPublish`, left at its identity default) — retained for
  serenity-docs#72 **§10.3** (quota-405 handling);
- the disguised-405 quota classification / alerting — retained for **§10.6**;
- the transport's **`transferWorkspaceResources`** — its only remaining caller is the retained §10.7
  metered-405 canary (`scripts/serenity-metered-405-canary.mjs`, which drains a throwaway
  sub-workspace through it), so it is **canary-scoped**: retired *with* the canary under §10.6/§10.7
  "delete last";
- the transport's **`getWorkspaceResources`** — **NOT** canary-scoped: it has a live production
  caller, `elements.js` `checkAccess` (GET `.../brand-presence/access`, LLMO-6747), which the canary
  only additionally borrows as its step-1 read. It outlives the canary and must not be deleted with
  it;
- the IT `__quota` controls (`setUmMockQuota` / `dumpUmMock` in `test/it/postgres/setup.js`) —
  retained for the spacecat-shared **§10.5** metered-write change, consumed by no test today (see
  that file's notes).

Deleting `transferWorkspaceResources` (or the canary) prematurely would break the canary at runtime
— it sits outside `tsconfig`/CI, so no gate catches it (a strict-tier pin in
`test/types/strict/serenity-transport-strict.types.js` now guards renames of both transport methods).
The no-carve behaviour from ADR-008 is now the only behaviour, unconditional.

This adopts the alternative ADR-008 recorded as **"Delete the JIT allocator alongside the carve.
Rejected."** The two grounds for that earlier rejection have resolved:

1. *"The evidence supports 'our parents are unmetered', not 'no tenant is ever metered'."* Semrush's
   confirmation plus the soak now support the stronger claim. It is re-checked, *for now*, by the
   `scripts/serenity-metered-405-canary.mjs` probe (serenity-docs#72 §10) — a **manual** per-env run
   (it needs a live IMS token and a real sub-workspace id, so a human runs it; nothing schedules it),
   **not** a flag to flip back on. §10.7 marks the probe itself *delete-last*, retired together with
   the §10.6 classifier — so the durable re-check beyond that point is an open question §10.6 must
   settle before deleting both (see Consequences).
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
  section and the allocator it armed are both removed. *For now* the `serenity-metered-405-canary.mjs`
  probe is the re-check — a **manual** per-environment run. Read its outcome by what the publish does
  at zero headroom, not by an exit code (it exits 0 either way): a **publish that succeeds** against
  zero headroom **confirms the premise** (Semrush is not enforcing), while the **disguised 405** it
  was originally built to capture now means **Semrush is enforcing again** — the signal to
  re-introduce the allocator from history, not to re-enable a flag. NB the script's on-screen
  `expected` / `UNEXPECTED` labels are LLMO-6190 fixture-capture language and read the opposite way
  round (see its header). It is **not** a standing signal:
  serenity-docs#72 §10.7 retires the probe *together with* the §10.6 classifier ("delete last"), and
  nothing schedules it. The **durable** re-check of the limits-unenforced premise beyond that point is
  an open question that **§10.6 must settle before deleting both** — otherwise every canary pointer
  here (and the matching ADR-008 bullet) becomes a reference to a script that no longer exists, the
  same defect class ADR-008 was repaired for last round.
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
