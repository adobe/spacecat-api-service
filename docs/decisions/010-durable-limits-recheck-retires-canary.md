# ADR-010: Production traffic is the durable limits-recheck; retire the manual canary

> **Resolves** the "durable re-check of the limits-unenforced premise" question
> [ADR-009](009-remove-dormant-jit-allocator.md) left open, and completes serenity-docs#72 §10.6/§10.7
> ("delete last", SITES-49206, 2026-08). **Narrows** §10.6 as originally scoped: `isMeteredQuota`,
> `toQuotaExceededError`, `quota-alerts.js`, and the two retained `allocation-metrics.js` recorders
> are **kept**, not deleted — see Decision. Driver: SITES-49206 follow-up checklist on
> [PR #2995](https://github.com/adobe/spacecat-api-service/pull/2995).

## Context

ADR-009 removed the dormant JIT allocator on the premise that Semrush no longer enforces AI
project/prompt limits for proxy-routed LLMO workspaces, and retained `scripts/serenity-metered-405-canary.mjs`
as the **interim** per-environment re-check of that premise — explicitly a manual, human-run,
unscheduled probe, not a durable one. ADR-009 flagged the durable replacement as an open question
that §10.6 ("quota-exhaustion handling — delete LAST") had to settle before the canary, the
classifier (`isMeteredQuota` / `toQuotaExceededError`, `errors.js`), the alerting
(`quota-alerts.js`), and the two allocator-adjacent `allocation-metrics.js` recorders
(`recordRejection`, `recordMeteredQuotaClassifier`) could all be deleted together.

Two things resolved since ADR-009:

- **The interim canary ran.** SITES-49206 §10.7: dev, stage, and prod, 2026-08-17, against a real
  throwaway Semrush sub-workspace. Publish succeeded at zero prompt headroom in all three — the
  premise holds, recorded on PR #2995 and in a
  [Jira SITES-49206 comment](https://jira.corp.adobe.com/browse/SITES-49206?focusedCommentId=57061238).
- **§10.3 closed a gap that made the classifier load-bearing on every publish, not just the
  canary's synthetic one.** Before §10.3, several write paths (`republishBestEffort` and its
  competitor/alias/brand-URL/tag callers) *swallowed* a disguised quota 405 instead of classifying
  it — meaning a real re-enforcement on those specific paths would have gone completely silent,
  with no error, no metric, no alert. §10.3 removed that swallow: every publish call site in the
  codebase now runs through `isMeteredQuota` → `toQuotaExceededError()` on a 405, unconditionally.

That second point is what makes a durable re-check possible without a scheduled synthetic probe:
the classifier is no longer bypassable by any live code path.

Independently, `project-elmo-ui` has a live, customer-facing "allocation exceeded" dialog
(`isSerenityAllocationExceededError`, wired into CSV prompt import and market/region-add) driven by
the exact same `quotaExceeded`/`orgPoolExhausted`/`brandAiLimit` error codes `toQuotaExceededError()`
produces. Deleting the classifier/alerting per §10.6's original literal scope would have silently
broken that dialog's only trigger, in a repo this decision's author does not own review context for.

## Decision

**Real production traffic, continuously observed by the retained classifier and alerting, IS the
durable re-check — no scheduled synthetic canary is built or needed.** Concretely:

- **Delete** (truly dead, no other caller): `scripts/serenity-metered-405-canary.mjs` and its
  `serenity-metered-405-canary-resources.mjs` helper module, and the transport's
  `transferWorkspaceResources` (`rest-transport.js`) — its only caller was the canary.
  `getWorkspaceResources` is **not** touched here: it has a live production caller
  (`elements.js` `checkAccess`, LLMO-6747) unrelated to the canary or the allocator.
- **Keep, indefinitely, as ongoing production monitoring** — this is the narrowing from §10.6's
  original text: `isMeteredQuota` / `toQuotaExceededError` (`errors.js`), `quota-alerts.js`, and the
  two retained `allocation-metrics.js` recorders (`recordRejection`, `recordMeteredQuotaClassifier`).
  Every real publish already runs through this path (post-§10.3); if Semrush ever silently
  re-enables limits enforcement, the next real customer publish that hits it gets classified,
  metered (CloudWatch `Mysticat/SerenityAllocation`), and alerted — automatically, with no manual
  run required. The `project-elmo-ui` allocation-exceeded dialog keeps working off the same signal.

## Consequences

- **No scheduled/synthetic canary exists or is planned.** If this passive detection is ever judged
  insufficient (e.g. traffic to some write paths is too low-volume to catch a regression promptly),
  that is a new decision to make with fresh data — not something this ADR defers or half-commits to.
- **The manual, human-run canary is gone.** Re-confirming the premise from scratch in the future
  (e.g. after a long gap, or if the passive alerting ever fires) requires writing a new probe;
  nothing here is a template to resurrect verbatim, since the deleted script encoded assumptions
  (a flat `prompts.{used,total}` resource shape) that had already drifted once during its short
  lifetime — see its git history for the shape-drift fix, itself since removed.
- **`getWorkspaceResources` and `elements.js` `checkAccess` are fully decoupled from this ADR's
  scope.** Their lifetime was never tied to the canary or the allocator; nothing here changes them.

## Alternatives considered

**Delete everything per §10.6's literal original text** (classifier, alerting, recorders included).
Rejected: this removes the only thing that would ever notice a live re-enforcement, and silently
breaks the `project-elmo-ui` allocation-exceeded dialog's trigger. The literal scope was written
before it was established (via §10.3) that these code paths are load-bearing for every real
publish, not allocator-only leftovers.

**Build a scheduled synthetic canary** (a cron'd version of the retired manual script) as the
durable replacement. Rejected as unnecessary: real production traffic already exercises every
publish path continuously post-§10.3, at far higher frequency and fidelity than any synthetic
schedule could — a synthetic probe would be strictly worse signal for strictly more code to
maintain (plus it would reintroduce exactly the resource-shape-drift fragility the retired script
already hit once).
