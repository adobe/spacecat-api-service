# Runbook: Release-Caused Outage (diagnose → verify → revert)

**Last validated:** 2026-05-21 (v1.508.0 incident).

How to respond when `spacecat-api-service` starts failing broadly shortly after a
deploy. The goal is to **confirm the release is the cause before reverting**, then
mitigate safely and hand off a real fix.

This runbook was written from the 2026-05-21 incident (commit
[`882dbab5`](https://github.com/adobe/spacecat-api-service/commit/882dbab5),
released as v1.508.0) where every Lambda invocation failed with
`TypeError: main2 is not a function`. That incident is used as the worked example
throughout. See [§ The `main is not a function` signature](#appendix-a-the-main-is-not-a-function-signature)
for that specific failure mode.

---

## When to use this

- The API is returning broad `500`s (not a single endpoint, not a single tenant).
- It started **shortly after a release/deploy**.
- Error looks like a startup/handler-load failure rather than business logic
  (e.g. `is not a function`, `Cannot find module`, `ENOENT … at module load`).

If the failure is scoped to one endpoint or one customer, this is probably *not* a
release-wide outage — diagnose that endpoint instead.

---

## Prerequisites

Check these *before* you need them — discovering missing access at the revert
(Step 5) is the expensive failure mode.

**Tooling.** `nvm` + node `>=24 <25` (`.nvmrc` pins `24.15.0`) and npm `>=10.9.0`;
run `nvm use` in the repo to match.

**Access** (read-only is enough for diagnosis):

- **AWS** — an authenticated session for the spacecat **prod** account, region
  `us-east-1` (your normal `aws sso login` / `AWS_PROFILE` / exported keys). Needs
  CloudWatch Logs read (`npm run logs`) and `lambda:GetFunction` (deploy-time and
  artifact checks). The `aws` commands authenticate via your shell's ambient
  credentials — **nothing is baked into the npm scripts** — so with no active
  session `npm run logs` just fails with a credentials error.
- **Coralogix** — account access (Adobe SSO) for the error-stream queries; separate
  from AWS.
- **GitHub** — push to `main` with admin/bypass rights (branch protection) for the
  Step 5 revert. Without bypass, open the revert as a PR and admin-merge (or ask
  someone who can).

**Build env vars (Step 3 local verify only).** `npm run build` resolves the `hlx`
block in `package.json`, which interpolates four vars. **Dummy values are fine** —
`--test-bundle` only builds and loads the artifact; real values matter only for an
actual deploy (run by CI):

| Env var | Feeds (`package.json` → `hlx`) |
|---|---|
| `VPC_SUBNET_1`, `VPC_SUBNET_2` | `awsVpcSubnetIds` |
| `VPC_SG_ID` | `awsVpcSecurityGroupIds` |
| `AWS_ACCOUNT_ID` | `awsRole!important` (role ARN) |

You do **not** need a populated `.env` or `secrets/dev-secrets.json` — those are for
the local dev server (`npm start`), which this flow never runs.

---

## TL;DR fast path

```bash
cd spacecat-api-service

# 1. Find the most recent release + the feature commit it shipped
git fetch origin && git log --oneline -10 origin/main

# 2. VERIFY locally that the suspect build is broken (don't skip — see Step 3)
git checkout <release-sha>
nvm use 24 && npm ci
VPC_SUBNET_1=x VPC_SUBNET_2=x VPC_SG_ID=x AWS_ACCOUNT_ID=0 npm run build   # --test-bundle loads the artifact
unzip -l dist/spacecat-services/api-service@<version>.zip                  # is the expected asset present?

# 3. Revert the FEATURE commit (not the release commit) and push
git checkout main && git pull --ff-only origin main
git revert --no-commit <feature-sha>
git commit            # write a message documenting the cause (see Step 5)
git push origin main

# 4. Watch recovery in Coralogix / CloudWatch (Step 6)
```

---

## Step 1 — Confirm the outage and its scope

Pull the live error stream and confirm it's broad:

```bash
npm run logs        # aws logs tail /aws/lambda/spacecat-services--api-service
```

In Coralogix, scope to the function and look at the error rate and first
occurrence:

```
inv.functionName:/spacecat-services/api-service/latest AND level:error
```

Capture two facts: **what the error is** and **when it first occurred**. You need
the first-occurrence timestamp for Step 2.

You can also confirm the outage black-box, with **no credentials** — a load-time
failure takes down even the unauthenticated health check (`helixStatus` runs before
auth):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://spacecat.experiencecloud.live/_status_check/healthcheck.json
# broad outage: 5xx / error  ·  healthy: 200
```

---

## Step 2 — Correlate with the most recent release

```bash
git fetch origin
git log --oneline --format='%h %ci %s' -15 origin/main
```

Releases on this repo are cut by `semantic-release`, so `main` has two kinds of
commit:

- **Release commits** — `chore(release): X.Y.Z [skip ci]`, authored by
  `semantic-release-bot`. These only bump `package.json`, `package-lock.json`, and
  `CHANGELOG.md`. **They contain no application code.**
- **Feature/fix commits** — the actual PR merges. This is what can break prod.

Find the release that lines up with the outage, then identify the **feature
commit(s) between it and the previous release**:

```bash
git log --oneline <previous-release-sha>..<suspect-release-sha>
```

> ⚠️ **Timeline caveat.** The release-commit timestamp is **not** the deploy time.
> In the 2026-05-21 incident the feature merge was at 16:07 ET, the first error at
> 16:08 ET, and the `chore(release)` commit at 16:23 ET — i.e. errors started
> *before* the release commit existed. Deploy is driven by the shared
> `adobe/mysticat-ci` workflow, not by the release commit you see in `git log`, and
> log timestamps may be in a different timezone than you assume. **Correlate on the
> feature commit and the deploy, not on the release-commit timestamp.** When in
> doubt, check the Lambda's actual deploy time:
>
> ```bash
> aws lambda get-function --function-name spacecat-services--api-service \
>   --query 'Configuration.LastModified'
> ```

The thing you revert is the **feature commit**, because that's where the code is.
The release commit on its own is harmless.

---

## Step 3 — Verify before you revert

A revert during an outage is low-risk, but a *wrong* revert wastes the one cheap
mitigation you have. Spend 2–3 minutes proving the suspect build is actually
broken. Any one of these is good evidence; together they're conclusive.

### 3a. Build the suspect commit locally

```bash
git checkout <suspect-release-sha>
nvm use 24                 # repo requires node >=24 <25 — see gotchas
npm ci
# build needs VPC params that only exist in the deploy env; dummy values are fine
VPC_SUBNET_1=subnet-dummy VPC_SUBNET_2=subnet-dummy VPC_SG_ID=sg-dummy \
  AWS_ACCOUNT_ID=000000000000 npm run build
```

`npm run build` runs `hedy -v --test-bundle`, which **loads and invokes the bundled
artifact** as part of validation. If the bundle is broken at module-load time, the
build itself fails here with the same error prod is throwing — that's your
confirmation. (This is also the check that *would have caught the bug in CI* if the
build step weren't being skipped/passed; note it for the follow-up.)

### 3b. Inspect the deploy artifact

The zip in `dist/` is exactly what gets uploaded to Lambda:

```bash
unzip -l dist/spacecat-services/api-service@<version>.zip
```

Confirm the artifact contains what the failing code expects (a static asset, a
module, etc.). In the worked example the zip had 5 files and the
`locations.json` the handler read at load time was simply not among them.

### 3c. (Optional) inspect the deployed Lambda directly

```bash
aws lambda get-function --function-name spacecat-services--api-service \
  --query 'Code.Location' --output text | xargs curl -s -o /tmp/lambda.zip
unzip -l /tmp/lambda.zip | grep -i <expected-file>
```

---

## Step 4 — Decide: revert vs roll-forward

| Situation | Action |
|---|---|
| Active outage, cause confirmed | **Revert.** Fastest restore to known-good. |
| Cause confirmed, fix is trivial *and* the PR owner is online | Roll-forward is acceptable, but only if it lands as fast as a revert. |
| Cause not confirmed | Stay in diagnosis. Do **not** revert speculatively. |

Default during an outage is **revert**. Roll-forward later, in a normal PR, with the
real fix and a regression test.

---

## Step 5 — Revert and push

> **Communicate first.** Post in
> [`#aem-sites-optimizer-engineering`](https://adobe.enterprise.slack.com/archives/C05A45JBP9N)
> that you're mitigating with a revert of `<sha>`, so responders aren't duplicating
> work.

Revert the **feature commit**, not the release commit:

```bash
git checkout main && git pull --ff-only origin main
git revert --no-commit <feature-sha>
```

Write a commit message that documents the cause so the next person isn't
re-diagnosing from scratch. Include: the symptom, the root cause, and the
re-land options. Example from the worked incident:

```
Revert "feat(...): ... (#NNNN)"

This reverts commit <sha>.

Reverting due to production outage. After the vX.Y.Z deploy, every Lambda
invocation failed with `TypeError: main2 is not a function at lambdaAdapter`.

Root cause: <one paragraph>.

Re-land options:
- <option 1>
- <option 2>
```

```bash
git commit          # paste the message above
git push origin main
```

### Gotchas you will hit (all real, from the worked incident)

- **Node version.** The repo requires node `>=24 <25`. If your shell is on an older
  node, `npm ci` fails with `EBADENGINE`. Fix: `nvm use 24` (install with
  `nvm install 24` if missing). The pre-commit hook also runs under your active
  node, so keep 24 active for the commit too.
- **Pre-commit hook needs deps installed.** `husky` + `lint-staged` run `eslint` on
  commit. If `node_modules` is stale you'll see `Cannot find package
  '@eslint/config-helpers'` or similar. Fix: `npm ci`. **Do not** reach for
  `--no-verify` — the hook failure is an environment problem, not a code problem,
  and bypassing it skips the lint that protects main.
- **Which commit.** Reverting the `chore(release)` commit does nothing useful — it
  only un-bumps the version. Revert the feature commit.
- **Branch protection.** `main` requires PRs + status checks. A direct push from an
  account with admin will go through but report `Bypassed rule violations`. That's
  expected for an emergency revert; CI still runs on the pushed commit. If you don't
  have bypass rights, open the revert as a PR and use admin-merge / ask someone who
  does.

After the push, `semantic-release` treats the revert as a release-worthy change,
cuts a new patch version, and the shared CI deploys it.

---

## Step 6 — Confirm recovery

- **Coralogix:** `inv.functionName:/spacecat-services/api-service/latest AND level:error`
  — error rate should fall to zero a couple of minutes after the new deploy lands.
- **GitHub Actions:** watch the CI run on your revert commit, then the release/deploy
  job — https://github.com/adobe/spacecat-api-service/actions
- **Lambda deploy time:** `aws lambda get-function --function-name
  spacecat-services--api-service --query 'Configuration.LastModified'` should update.
- **Health check:** `curl -sS -o /dev/null -w '%{http_code}\n' https://spacecat.experiencecloud.live/_status_check/healthcheck.json`
  returns `200` — the unauthenticated `helixStatus` endpoint fails too during a
  load-time outage, so a `200` on the new deploy is a real recovery signal.

Don't declare the incident over until you've seen the error rate drop on the *new*
deploy, not just the revert merge.

---

## Step 7 — Follow-up & post-incident

Once recovery is confirmed (Step 6):

- **Close the loop** in
  [`#aem-sites-optimizer-engineering`](https://adobe.enterprise.slack.com/archives/C05A45JBP9N)
  — post that the revert deployed and the error rate is back to baseline, with the
  recovered-deploy timestamp. (No status page to update.)
- **File the post-mortem.** Track it with a JIRA in project **SITES** (component
  **ASO** or **LLMO**, as applicable); write the post-mortem itself as a wiki page
  under [AEM Sites Optimizer Post Mortems](https://wiki.corp.adobe.com/spaces/AEMSites/pages/3484809541/AEM+Sites+Optimizer+Post+Mortems)
  (no fixed template — follow the existing pages there). Capture the timeline, the
  root cause, and the **detection gap** — this class of failure is invisible until a
  cold-start invocation, so note how the regression guard below would have caught it.
- **File the real-fix ticket** in JIRA project **SITES** (component **ASO** or
  **LLMO**) to re-land the reverted change correctly: symptom, root cause, chosen
  fix; link the revert commit and the original PR. Priority `Critical` for a full
  outage; type `Bug`.
- **Add a regression guard.** The repo already ships a bundle test —
  `npm run test:bundle` resolves the artifact path from `npm pkg get version`
  dynamically (no hard-coded version) and runs `test/index.test.js` against the
  built bundle. Ensure that test asserts the handler is callable
  (`typeof main === 'function'`) and that it runs as a **blocking** CI gate, not
  advisory. `npm run build`'s `--test-bundle` step also loads the artifact at build
  time and would catch this pre-merge — confirm it fails the build rather than
  warning.

---

## Appendix A — The `main is not a function` signature

```
TypeError: main2 is not a function
    at lambdaAdapter (file:///var/task/index.js:NNNNNN:NN)
```

**What it means.** `helix-deploy` wraps your exported `main` from `src/index.js` in
a generated `lambdaAdapter`. The bundler often renames the import (`main` → `main2`).
If `main` is `undefined` at invocation time, the adapter throws this `TypeError`.

**Why `main` would be undefined.** `src/index.js` exports `main` as the *last*
statement (a `wrap(run).with(...)` chain). If **anything throws while the module is
loading** — a failed `import`, a top-level `readFileSync` that ENOENTs, a circular
import resolving to `undefined` — execution never reaches the `export const main`,
so `main` is never defined. Every invocation then fails identically, because it's a
load-time failure, not a per-request one.

**Why tests can pass while prod burns.** Unit tests import modules from **source**,
where `import.meta.url` resolves to the real source path and sibling files (JSON,
data) exist on disk. The **bundle** is a different layout: only code reachable through
`import` is included, plus whatever is declared in `hlx.static`. A module that does
`readFileSync(<path relative to import.meta.url>)` at load time works from source and
fails in the bundle.

**The worked-example cause (2026-05-21).**
`src/support/semrush/handlers/projects.js` did, at module top level:

```js
const LOCATIONS_JSON_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)),
  '..', 'data', 'locations.json');
const locationsData = JSON.parse(readFileSync(LOCATIONS_JSON_PATH, 'utf8'));  // ENOENT in the bundle
```

`locations.json` was not in `package.json`'s `hlx.static`, so the bundler never
shipped it. Load-time ENOENT → `main` undefined → `main2 is not a function`.

**Fix — recommended:** inline the data as a JS module (`export const LOCATIONS =
[...]`) and `import` it. This removes the runtime `readFileSync` entirely, so the
bundler includes the data via normal import resolution and **this failure mode
cannot recur**. Prefer this for the re-land.

Alternatives (they work, but keep the fragile read):

- Add the file to `hlx.static` in `package.json`. Matches the existing allow-list
  pattern, but preserves the load-time `readFileSync` — the next data file that
  forgets the allow-list hits the same trap.
- Use a JSON import attribute: `import x from './data/x.json' with { type: 'json' }`
  (requires relaxing the eslint parser config that currently rejects it).

---

## Appendix B — helix-deploy bundling reference

- **Build:** `npm run build` → `hedy -v --test-bundle`. Produces
  `dist/spacecat-services/api-service@<version>-bundle.mjs` and a `.zip`. The
  `--test-bundle` step loads + invokes the artifact, so a load-time break fails the
  build.
- **Bundle test:** `npm run test:bundle` runs `test/index.test.js` against an
  already-built bundle, resolving the artifact path from `npm pkg get version` (so it
  never hard-codes a version). Distinct role from `build`: `build` produces +
  validates the bundle; `test:bundle` runs the test suite against an existing one.
  Use it as the CI regression gate (Step 7).
- **Deploy (prod):** `npm run deploy` → `hedy -v --deploy
  --aws-deploy-bucket=spacecat-prod-deploy --pkgVersion=latest`. Run by CI, not by
  hand, in normal operation.
- **Static assets:** `hlx.static` is an allow-list of non-JS files copied into the
  bundle. It lives in `package.json` under the `hlx` key (not a separate
  `helix-deploy.yaml`). **Anything read from disk at runtime must be listed here**
  (or, better, imported so the bundler includes it automatically). Concrete shape:

  ```jsonc
  // package.json
  "hlx": {
    "static": ["static/onboard/profiles.json"]
  }
  ```
- **Lambda function name:** `spacecat-services--api-service` (CloudWatch) /
  `/spacecat-services/api-service/latest` (Coralogix `inv.functionName`).
- **Node:** `engines` pins `>=24 <25`. Match it locally with `nvm use 24`.

---

## Command quick-reference

```bash
# logs / live errors
npm run logs
aws logs tail /aws/lambda/spacecat-services--api-service --follow

# correlate release with outage
git fetch origin && git log --oneline --format='%h %ci %s' -15 origin/main
git log --oneline <prev-release>..<suspect-release>

# verify a suspect build locally
git checkout <sha> && nvm use 24 && npm ci
VPC_SUBNET_1=x VPC_SUBNET_2=x VPC_SG_ID=x AWS_ACCOUNT_ID=0 npm run build
unzip -l dist/spacecat-services/api-service@<version>.zip

# inspect the deployed artifact
aws lambda get-function --function-name spacecat-services--api-service \
  --query 'Code.Location' --output text | xargs curl -s -o /tmp/lambda.zip
unzip -l /tmp/lambda.zip

# revert + push
git checkout main && git pull --ff-only origin main
git revert --no-commit <feature-sha>
git commit && git push origin main

# confirm deploy landed
aws lambda get-function --function-name spacecat-services--api-service \
  --query 'Configuration.LastModified'
```
