---
name: release-outage-response
description: >-
  Orchestrates incident response when the spacecat-api-service Lambda is failing
  broadly after a deploy. Drives a diagnose-first workflow — confirm the outage,
  correlate it with the most recent release, and verify the suspect build locally
  — then gates a revert+push to prod main behind explicit human confirmation,
  and finally confirms recovery and files follow-up. Use when spacecat-api-service
  is returning widespread 500s shortly after a release; when a Lambda invocation
  error such as `TypeError: main2 is not a function`, `Cannot find module`, or a
  module-load `ENOENT` appears; when asked whether a release caused an outage; or
  when asked to revert / roll back a bad spacecat-api-service release. The manual
  step-by-step lives in docs/runbooks/release-caused-outage.md.
---

# Release-Caused Outage Response

LLM-led companion to `docs/runbooks/release-caused-outage.md`. The runbook holds
the exact commands and the worked example; this skill enforces the **sequence**,
the **diagnosis discipline**, and the **one hard safety gate**.

**Before starting, read `docs/runbooks/release-caused-outage.md`** — work from its
commands rather than reconstructing them. This skill tells you *what to do and in
what order*; the runbook tells you *how*.

## Operating rules

- **Diagnose before reverting.** Do not propose a revert until evidence supports
  it. Hold at least two hypotheses until one is confirmed (see Phase 2–3).
- **One hard gate:** never run the revert **or** the push to prod `main` without
  explicit human confirmation (Phase 4). This is the only irreversible, shared-state
  action in the flow — treat it as such.
- **Verify locally first.** A revert is cheap, but a *wrong* revert wastes the one
  cheap mitigation you have. Prove the suspect build is broken before you touch
  `main` (Phase 3).
- **Narrate for an operator under pressure.** State what you found and what you're
  about to do in plain, skimmable terms — someone is watching this incident.

## Workflow

### Phase 1 — Confirm and frame the outage

- Pull live errors (`npm run logs` / Coralogix `inv.functionName:/spacecat-services/api-service/latest`).
- Establish: is it **broad** (all/most requests) or scoped to one endpoint/tenant?
  If scoped, **stop** — this skill is for release-wide outages; diagnose that
  endpoint instead.
- Capture the **exact error** and the **first-occurrence timestamp**.

### Phase 2 — Correlate with the most recent release

- `git fetch origin && git log --oneline --format='%h %ci %s' -15 origin/main`.
- Identify the suspect **feature commit** (the PR merge), not the
  `chore(release)` commit — the release commit carries no application code.
- Apply the **timeline caveat** from the runbook: the release-commit timestamp is
  not the deploy time, and log timezones may mislead. Correlate on the feature
  commit and the actual Lambda deploy time
  (`aws lambda get-function … --query 'Configuration.LastModified'`), not on the
  `chore(release)` timestamp.

### Phase 3 — Verify before reverting (do NOT skip)

Follow runbook Step 3. Any one of these is good evidence; together they're
conclusive:

- Build the suspect commit locally (`nvm use 24`, `npm ci`, then `npm run build`
  with the dummy VPC env vars). The `--test-bundle` step loads the artifact, so a
  load-time break reproduces here.
- Inspect the deploy zip (`unzip -l dist/…@<version>.zip`) and confirm whether the
  failing code's expected asset/module is present.
- Optionally pull and inspect the deployed artifact directly.

State the result explicitly: "confirmed — <cause>" or "not confirmed — staying in
diagnosis." Do not advance to Phase 4 on an unconfirmed hypothesis.

### Phase 4 — CONFIRMATION GATE (required)

**Stop here and get explicit human sign-off before any `git revert` or
`git push`.** Present, concisely:

1. The confirmed root cause and the evidence for it.
2. The exact mitigation: which **feature commit** will be reverted, and that it
   pushes to prod `main`.
3. The alternative (roll-forward) and why revert is the call right now.

Then ask plainly, e.g. *"Revert `<sha>` and push to main?"* — and **wait**. Do not
run the revert or the push until the human answers yes. If they redirect, follow
that instead. A prior approval does not authorize re-running on a later/different
commit — re-confirm each time.

### Phase 5 — Revert and push (only after Phase 4 approval)

Follow runbook Step 5 exactly. Key points the runbook details:

- Revert the **feature** commit, not the `chore(release)` commit.
- Write a commit message documenting symptom + root cause + re-land options.
- Expect and handle the real gotchas: node 24 via `nvm`, `npm ci` so the
  pre-commit hook's eslint resolves, **do not** reach for `--no-verify`, and the
  branch-protection `Bypassed rule violations` notice on push is expected for an
  admin emergency revert.

### Phase 6 — Confirm recovery

- Watch the Coralogix error rate fall to zero **on the new deploy**, not just on
  the revert merge.
- Confirm CI ran on the revert commit and the deploy job completed; check the
  Lambda `LastModified` updated.
- Do not declare the incident resolved until errors stop on the redeployed code.

### Phase 7 — Follow-up

- File a ticket for the **real fix** (re-land the reverted change correctly):
  symptom, root cause, chosen fix; link the revert commit and the original PR;
  `Critical` priority for a full outage, type `Bug`.
- Recommend the durable regression guard: a CI bundle-smoke test that imports the
  built artifact.

## Anti-patterns

- Reverting on a hunch without local verification (Phase 3).
- Reverting or pushing without the Phase 4 human gate.
- Reverting the `chore(release)` commit (no code) instead of the feature commit.
- Using `--no-verify` to get past a failing pre-commit hook — that hook failure is
  an environment problem (node version / stale deps), not a code problem.
- Declaring victory on the revert *merge* rather than on the recovered *deploy*.
