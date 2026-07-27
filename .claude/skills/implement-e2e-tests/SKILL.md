---
name: implement-e2e-tests
description: >-
  Use when writing end-to-end/e2e tests for a new spacecat-api-service
  endpoint, or extending an existing e2e suite after an endpoint enhancement.
---

# Implement E2E Tests

An e2e test earns its place only if it proves something no lower layer can.
`test/controllers/` mocks everything and can assert any branch cheaply;
`test/it/` runs the real DB/PostgREST stack with seeded, controllable personas.
Both are cheaper and faster than e2e. If a scenario is provable at either
layer, it belongs there, not here — repeating it in e2e just builds an
**ice-cream cone** (top-heavy on the slow, flaky layer) instead of a pyramid.

## Step 1: Map the feature and its existing coverage

Identify the endpoint set from the OpenAPI paths, `src/routes/index.js`, and
the controller file(s) touched. Then locate what already tests them:

- `test/controllers/<feature>.test.js` — unit, mocked
- `test/it/shared/tests/<feature>.js` — integration, real Postgres/PostgREST
- `test/e2e/<feature>.e2e.js` — e2e, if this is an enhancement to an existing
  feature. **Read it in full before writing anything** — supplement it, don't
  fork a parallel file.

Completion: you can point at the covering file (or "none exists yet") for
every candidate scenario before triaging.

## Step 2: Triage — keep only what only e2e can prove

| Keep | Why unit/IT can't prove it |
|---|---|
| This route's own auth wiring: one request without a session token, asserting the real deployed middleware rejects it | Unit mocks auth; IT pre-mints valid tokens (`test/it/shared/auth.js`) and never calls a route unauthenticated |
| Real infra wiring: entitlement/product-access from live config, `facsWrapper` routing, CDN/Fastly behavior, cold start | Mocked, or stood in for by the IT harness, everywhere else |
| One assembled consumer workflow per primary intent: the call sequence a UI feature or an AI agent would actually issue, asserting the end state a user cares about | Neither layer chains calls the way a real consumer does |

| Discard | Where it already lives |
|---|---|
| Per-field/branch 400s (missing param, wrong type, bad UUID, cap/limit boundaries) | unit — cheap to enumerate exhaustively |
| Authorization matrix across roles/orgs (403 variants) | IT — has multiple seeded personas; a live dev site usually gives you only one credential |
| Version-bump / optimistic-lock / set-difference arithmetic | IT — proven against a real DB |
| Anything a `sinon` stub or `esmock`'d dependency already proves | unit |

Note on auth: keep-row 1 is *this route's* wiring only. Don't re-prove the
IMS-to-session-token *login* mechanism itself in every suite — that exchange
is a shared utility (`session-auth.js`), not feature behavior; it earns its
own e2e coverage only when the feature under test is auth itself. For
example, `import.e2e.js`'s `should fail to create a new Import Job when the
API key is invalid` sends a genuinely bad key through the deployed auth
path — proving real rejection, which `import.test.js`'s mocked `should
reject when auth scopes are invalid` (a stubbed throw) can't.

See Common Mistakes below for the discard side of this table in practice.

If nothing survives triage, stop here — do not create
`test/e2e/<feature>.e2e.js`. An endpoint fully covered by unit + IT needs no
e2e file.

Completion: a short list of kept scenarios (possibly empty), each with a
one-line reason from the left table, and every discarded case named
alongside the unit/IT test that already covers it.

## Step 3: Author or supplement

- Enhancement: extend `test/e2e/<feature>.e2e.js`. New feature: create it.
  Nothing kept: skip this step and Step 4 — you're done.
- Auth: reuse `session-auth.js`'s `getSessionToken()` — don't hand-roll a
  second login helper.
- Base URL: reuse `apiBaseUrl` from `spacecat-utils.js` (dev `/api/ci` vs.
  prod `/api/v1`, switched on `process.env.ENVIRONMENT`).
- Header: `x-client-type: api-e2e-tests` on every request — how e2e traffic
  is distinguished from real usage in Splunk.
- Mutations: namespace test data (e.g. `__e2e-<feature>-test__`) and make
  teardown idempotent — it doubles as pre-test cleanup for an aborted run.
- Skip, don't fail, in `before()` when `IMS_ACCESS_TOKEN` is unset
  (`this.skip()`), and also when `process.env.ENVIRONMENT === 'prod'` if the
  feature only exists on a fixed dev site. The scheduled
  `.github/workflows/e2e-tests.yaml` cron is prod-only and doesn't set
  `IMS_ACCESS_TOKEN` — session-token suites stay dev-only/manual by default.

Completion: every new/changed `it()` traces back to a kept item from Step
2's list, and none of the discarded validation/branch cases reappear.

## Step 4: Verify

- `npx mocha --timeout 30s test/e2e/<feature>.e2e.js` with no
  `IMS_ACCESS_TOKEN` set — must skip, not fail or error.
- If a credential is available (`mysticat auth token --ims -e dev`), run it
  for real against dev once. If the `mysticat` CLI is installed but not
  logged in (or the token has expired), ask the engineer to run
  `! mysticat login` themselves — it opens a browser, so it must run
  interactively, not on your behalf — then retry.
- `npm run lint` on the new/changed file.
- Re-read every new `it()` title against Step 2's keep list once more — the
  last chance to catch one that drifted back toward pure validation coverage.

Completion: lint is clean, the file runs (skip or full pass) with no
unexpected failure, and every surviving `it()` still maps to a Step 2 reason.

## Common Mistakes

| Mistake | Fix |
|---|---|
| New `it()` duplicates a unit-covered case (e.g. `import.e2e.js`'s "job not found" 404, already in `test/controllers/import.test.js`'s `should return 404 when the jobID cannot be found`) | Drop it — a mock proves the same fact in milliseconds |
| A second hand-rolled login/fetch helper instead of `session-auth.js` | Reuse `getSessionToken()`; two auth paths drift when the login flow changes |
| Suite throws when `IMS_ACCESS_TOKEN` is unset | `this.skip()` in `before()` instead — must never fail CI for lack of a credential |
| Mutating shared/dev-site data without a namespaced, idempotent teardown | Prefix test values (`__e2e-<feature>-test__`) and make removal safe to call unconditionally |
