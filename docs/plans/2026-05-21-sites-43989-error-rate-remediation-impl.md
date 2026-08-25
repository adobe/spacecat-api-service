# SITES-43989 Error-Rate Remediation - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three inline `spacecat-api-service` fixes from the SITES-43989 spec so the API Gateway error-rate alert stops counting two avoidable 4xx/log-noise sources, without changing the (already-correct) scrape API.

**Architecture:** Centralize the four duplicated LLMO source-fetch blocks into one shared `llmo-source.js` helper that maps upstream HTTP semantics to a typed result (`{data}` / `{noData}` / tagged throw); each LLMO endpoint interprets `noData` (upstream 404) as an empty `200` carrying a `x-llmo-data-status: not-provisioned` discriminator header, and maps genuine upstream failures to honest status codes (5xx->502, timeout->504, non-404 4xx passthrough). Separately, hoist the per-request `MYSTICAT_WORKSPACE_REPOS` warning out of the eagerly-instantiated `WebhooksController` constructor and downgrade the unset-using-defaults case to `debug`.

**Tech Stack:** Node.js ESM, `@adobe/spacecat-shared-http-utils` (`createResponse`/`ok`/`badRequest`/`internalServerError`), `@adobe/spacecat-shared-utils` (`tracingFetch`), Mocha + Chai + Sinon + `sinon-chai` + `chai-as-promised`, `esmock` 2.7.4 for module mocking, `c8` coverage, ESLint, Coralogix `events2metrics`.

**Spec:** `docs/specs/2026-05-20-sites-43989-error-rate-remediation.md` (merged, PR #2452).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/controllers/llmo/llmo-source.js` | **Create** | The one place that fetches the elmo-ui-data source: owns the 15s timeout, `LLMO_HLX_API_KEY` presence check, request headers, and HTTP-status branching. Backend-agnostic: returns `{status,data,headers}` / `{status:404,noData:true}` / throws a tagged error. Also exports the shared caller-side error->Response mapper, the discriminator-header constants, the captured empty payload, and the structured not-provisioned logger. |
| `test/controllers/llmo/llmo-source.test.js` | **Create** | Unit tests for every `fetchLlmoSource` branch and `llmoSourceErrorResponse` mapping (esmock `tracingFetch`). |
| `test/fixtures/llmo/empty-sheet.json` | **Create** | Phase 0 byte-match contract: a real empty-but-provisioned single-sheet response captured live. The synthesized empty `200` must deep-equal this. |
| `src/controllers/llmo/llmo-query-handler.js` | **Modify** | `fetchAndProcessSingleFile` delegates fetch to `fetchLlmoSource` and propagates `{noData:true}`; `fetchAndProcessMultipleFiles` maps upstream-404 to per-file `status:'no_data'` (distinct from `'error'`). |
| `src/controllers/llmo/llmo.js` | **Modify** | `getLlmoSheetData`, `queryLlmoSheetData`, `getLlmoGlobalSheetData`, `queryFiles` call the helper, return the empty-200+header on `noData`, and map source errors via `llmoSourceErrorResponse` in their catch. |
| `src/controllers/webhooks.js` | **Modify** | Move `getWorkspaceRepos(env, log)` from the `WebhooksController` constructor into `processGitHubWebhook`; downgrade the unset->defaults branch from `warn` to `debug`. |
| `test/controllers/llmo/llmo.test.js` | **Modify** | Add the 3rd-arg global esmock mock for `tracingFetch` so the transitively-imported helper is stubbed; update the handful of behavior-changed assertions (404, missing-key, exact-header match) and add the new not-provisioned / 502 / 504 / passthrough tests. |
| `test/controllers/llmo/llmo-query-handler.test.js` | **Modify** | Move the `tracingFetch` mock to the 3rd-arg global slot; add the multi-file `no_data` test. |
| `test/controllers/webhooks.test.js` | **Modify** | Add `debug` to the mock logger; assert the constructor emits no warn and unset->defaults no longer warns; keep present-but-invalid warning. |
| `docs/openapi/**` (LLMO paths) | **Modify** | Document the `x-llmo-data-status` response header and the new status codes (200-empty, 502, 504) for the four LLMO read endpoints. |

---

## Phasing and ordering

The spec splits the work into **Phase 0 (pin contracts)** and **Phase 1 (implement)**. Fix 1 (webhooks) is fully independent of Phase 0 and goes first as a warm-up. Phase 0 (Tasks 2-4) must complete before the Fix-2 implementation tasks (5-8) because the empty-200 byte-match contract and the timeout go/no-go decision are inputs to that code and its tests.

```
Task 1  (Fix 1, independent)
Task 2  (Phase 0: capture fixtures)        ─┐
Task 3  (Phase 0: 15s payload audit)        │ all three precede Tasks 5-8
Task 4  (Phase 0: events2metrics + log lvl) ─┘
Task 5  (Fix 2: helper)         -> Task 6 (query-handler) -> Task 7 (queryFiles) -> Task 8 (3 sheet endpoints)
Task 9  (docs)
Task 10 (full verification + PR)
```

**Error-mapping policy implemented by `llmoSourceErrorResponse` (the plan's concrete reading of the spec matrix - confirm in PR):**

| Upstream condition | Tag on thrown error | Response |
|--------------------|---------------------|----------|
| 404 (not provisioned) | (not thrown; `{noData:true}` returned) | `200` empty + `x-llmo-data-status: not-provisioned` |
| 5xx | `upstreamStatus >= 500` | `502` |
| timeout / abort | `isTimeout` | `504` |
| non-404 4xx (incl 401/403) | `400 <= upstreamStatus < 500` | passthrough (same 4xx) |
| missing `LLMO_HLX_API_KEY` | `isConfigError` | `500` (server misconfig) |
| network / parse / other | (untagged) | `400` (existing fallback, unchanged) |

---

## Task 1: Fix 1 - hoist + reclassify the `MYSTICAT_WORKSPACE_REPOS` warning

**Files:**
- Modify: `src/controllers/webhooks.js:68-70` (constructor) and `:200-213` (`processGitHubWebhook` payload build) and `:38-42` (`getWorkspaceRepos` unset branch)
- Test: `test/controllers/webhooks.test.js:63-72` (logger), `:253-308` (env-var tests)

- [ ] **Step 1: Add a `debug` stub to the mock logger**

In `test/controllers/webhooks.test.js`, the `beforeEach` builds `mockLog` with only `info`/`warn`/`error`. Add `debug`:

```js
    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };
```

- [ ] **Step 2: Rewrite the two unset-path tests + add a constructor-purity test (failing)**

Replace the existing `it('logs warning and uses defaults when MYSTICAT_WORKSPACE_REPOS is not set', ...)` (currently at `:267-274`) with these three tests:

```js
  it('does not warn at construction (constructor is side-effect-free)', () => {
    // beforeEach already built a controller without the env var set.
    const constructWarn = mockLog.warn.getCalls()
      .find((c) => c.args[0].includes('MYSTICAT_WORKSPACE_REPOS'));
    expect(constructWarn).to.be.undefined;
  });

  it('uses defaults at debug (not warn) when MYSTICAT_WORKSPACE_REPOS is not set', async () => {
    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.workspace_repos).to.deep.equal([
      'adobe/mysticat-architecture',
      'adobe/mysticat-ai-native-guidelines',
      'Adobe-AEM-Sites/aem-sites-architecture',
    ]);
    const notSetWarn = mockLog.warn.getCalls()
      .find((c) => c.args[0].includes('not set'));
    expect(notSetWarn, 'unset path must not warn').to.be.undefined;
    const notSetDebug = mockLog.debug.getCalls()
      .find((c) => c.args[0].includes('MYSTICAT_WORKSPACE_REPOS not set'));
    expect(notSetDebug, 'unset path should debug-log').to.not.be.undefined;
  });
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx mocha test/controllers/webhooks.test.js -g "construction|debug"`
Expected: FAIL - `mockLog.debug` is currently never called for the unset branch (still `warn`), and the constructor still warns.

- [ ] **Step 4: Move the call out of the constructor (implementation)**

In `src/controllers/webhooks.js`, delete the constructor call at `:70`:

```js
function WebhooksController(context) {
  const { sqs, log, env } = context;
  const slackChannel = env.MYSTICAT_OBSERVABILITY_SLACK_CHANNEL;
```

(remove the line `const workspaceRepos = getWorkspaceRepos(env, log);`). Then, inside `processGitHubWebhook`, compute it once per request right before the job payload is built (immediately above the `const jobPayload = {` block at `:201`):

```js
    // Computed per webhook request (not per controller construction) so the
    // env-var validation log fires only on genuine deliveries, not all traffic.
    const workspaceRepos = getWorkspaceRepos(env, log);

    // Build and enqueue job payload
    const jobPayload = {
```

- [ ] **Step 5: Downgrade the unset->defaults branch to `debug`**

In `getWorkspaceRepos` (`src/controllers/webhooks.js:38-43`), change the unset branch from `log.warn` to `log.debug`. Leave the present-but-invalid branches (`:54-58` invalid entries, `:59-64` no-valid-entries fallback) as `log.warn` - those are the genuinely actionable cases.

```js
  const raw = env.MYSTICAT_WORKSPACE_REPOS;
  if (!raw) {
    log.debug('MYSTICAT_WORKSPACE_REPOS not set, using built-in defaults', {
      defaults: DEFAULT_WORKSPACE_REPOS,
    });
    return DEFAULT_WORKSPACE_REPOS;
  }
```

- [ ] **Step 6: Run the full webhooks suite + lint**

Run: `npx mocha test/controllers/webhooks.test.js`
Expected: PASS (all, including the still-valid `:276` invalid-entries and `:292` only-invalid warning tests - they call `processGitHubWebhook`, which now computes `getWorkspaceRepos`).
Run: `npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/webhooks.js test/controllers/webhooks.test.js
git commit -m "fix: emit MYSTICAT_WORKSPACE_REPOS warning per-request, not per-controller (SITES-43989)"
```

---

## Task 2: Phase 0 - capture the empty-response byte-match fixture

> **Requires** a real `LLMO_HLX_API_KEY` (Vault `dx_mysticat/{dev}/api-service`) and network egress to `main--project-elmo-ui-data--adobe.aem.live`. If running as an unauthenticated agent, **stop and hand this task to a human / a session with the key** - it cannot be faked, and it is the contract the Fix-2 tests assert against.

**Files:**
- Create: `test/fixtures/llmo/empty-sheet.json`

- [ ] **Step 1: Identify a provisioned-but-empty single sheet**

Find a `dataFolder` whose query-index is published but whose sheet has zero rows (e.g. a freshly-onboarded LLMO site, or a known-empty sheet). Record the folder + sheet used in the PR description. If none exists, capture the smallest real sheet and empty its `data` array by hand, noting the deviation in the PR.

- [ ] **Step 2: Capture the empty single-sheet envelope**

```bash
curl -sS -H "Authorization: token $LLMO_HLX_API_KEY" \
  "https://main--project-elmo-ui-data--adobe.aem.live/<known-empty-folder>/<sheet>.json" \
  | tee test/fixtures/llmo/empty-sheet.json
```

Expected: a 200 JSON envelope shaped like (confirm exact keys/order from the live capture - **use the captured bytes verbatim**, do not hand-write):

```json
{ "total": 0, "offset": 0, "limit": 0, "data": [], ":type": "sheet" }
```

- [ ] **Step 3: Record the multi-sheet and not-provisioned shapes (documentation only)**

For the PR description (not committed as load-bearing fixtures), also capture:
- a multi-sheet empty envelope (`:type: multi-sheet`), to confirm the single-sheet shape is the right default to synthesize, and
- the literal 404 body for a non-provisioned folder, to confirm the helper's `status === 404` branch is the correct trigger.

Paste both into the PR. **Decision recorded in this plan:** single-file `noData` synthesizes the single-sheet empty shape (`empty-sheet.json`) regardless of whether the eventual sheet would have been multi-sheet, because a 404 folder gives no shape hint and the `x-llmo-data-status` header - not the body - is the machine discriminator. Flag this for reviewer confirmation.

- [ ] **Step 4: Commit the fixture**

```bash
git add test/fixtures/llmo/empty-sheet.json
git commit -m "test: pin empty LLMO sheet envelope fixture for SITES-43989 not-provisioned contract"
```

---

## Task 3: Phase 0 - validate the 15s timeout against real payloads

> The three sheet endpoints have **no** timeout today; the helper adds the query-handler's 15s `AbortController` to all four. This task confirms no legitimate sheet read exceeds 15s before that becomes a hard abort.

**Files:** none (investigation; record findings in the PR).

- [ ] **Step 1: Enumerate the largest known sheet reads in dev**

Pick the largest `dataFolder`/sheet combinations in use (e.g. agentic-traffic, referral-traffic, brand-presence weekly). Use the SpaceCat dev base URL with an admin key, or curl the source directly with `LLMO_HLX_API_KEY`.

- [ ] **Step 2: Time them**

```bash
for u in "<folder-a>/<sheet>.json?limit=1000000" "<folder-b>/<sheet>.json?limit=1000000"; do
  curl -sS -o /dev/null -w "%{time_total}s  %{http_code}  $u\n" \
    -H "Authorization: token $LLMO_HLX_API_KEY" \
    "https://main--project-elmo-ui-data--adobe.aem.live/$u"
done
```

Expected: all well under `15.000s`.

- [ ] **Step 3: Go/no-go**

If any legitimate read approaches 15s, **stop and discuss** before adopting the timeout on the sheet endpoints (raise the constant, or scope the timeout to the cached-query path only). Record the max observed time and the go/no-go in the PR. Default assumption: GO (proceed with 15s).

---

## Task 4: Phase 0 - events2metrics rule + confirm log-level ingestion

**Files:** none in this repo (Coralogix config via MCP/UI; record the rule definition in the PR).

- [ ] **Step 1: Confirm whether `debug` logs reach Coralogix ingestion**

Run a known-good control query for a recent `debug` line from `spacecat-services-dev` api-service (filter by `$l.applicationname`, `$l.subsystemname`, `$d.inv.functionName`). If `debug` is dropped at ingestion, the structured not-provisioned line must be emitted at `info` instead. Record the decision; it sets the log level used in Task 5 Step 7 / Tasks 7-8.

- [ ] **Step 2: Author the `events2metrics` rule**

Create a Coralogix `events2metrics` rule keyed on `event == 'llmo_data_not_provisioned'` producing a per-site counter (label: `siteId`). This is the durable signal for post-merge verification, independent of raw-log retention. Record the rule JSON in the PR.

- [ ] **Step 3: Validation**

Confirm the rule validates (dry-run/preview) and that the metric name is documented in the PR for the post-merge verification queries.

---

## Task 5: Fix 2 - create `llmo-source.js` + unit tests

**Files:**
- Create: `src/controllers/llmo/llmo-source.js`
- Create: `test/controllers/llmo/llmo-source.test.js`

- [ ] **Step 1: Write the helper unit tests first (failing)**

Create `test/controllers/llmo/llmo-source.test.js`. Mirror `llmo-query-handler.test.js`'s esmock-of-`tracingFetch` pattern:

```js
/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

use(sinonChai);
use(chaiAsPromised);

const TEST_URL = 'https://main--project-elmo-ui-data--adobe.aem.live/folder/sheet.json';

const mockResponse = (data, ok = true, status = 200, statusText = 'OK') => ({
  ok,
  status,
  statusText,
  json: sinon.stub().resolves(data),
  headers: new Map([['content-type', 'application/json']]),
});

describe('llmo-source', () => {
  let fetchLlmoSource;
  let llmoSourceErrorResponse;
  let tracingFetchStub;
  let context;

  beforeEach(async () => {
    tracingFetchStub = sinon.stub();
    context = {
      log: {
        info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub(),
      },
      env: { LLMO_HLX_API_KEY: 'test-key' },
    };
    const mod = await esmock('../../../src/controllers/llmo/llmo-source.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: 'test-ua',
        tracingFetch: tracingFetchStub,
      },
    });
    fetchLlmoSource = mod.fetchLlmoSource;
    llmoSourceErrorResponse = mod.llmoSourceErrorResponse;
  });

  afterEach(() => sinon.restore());

  it('returns parsed data + headers on 2xx', async () => {
    tracingFetchStub.resolves(mockResponse({ rows: [1, 2] }));
    const result = await fetchLlmoSource(context, TEST_URL);
    expect(result.status).to.equal(200);
    expect(result.data).to.deep.equal({ rows: [1, 2] });
    expect(result.headers).to.be.an('object');
    expect(result.noData).to.be.undefined;
  });

  it('returns {status:404, noData:true} on upstream 404 (no throw)', async () => {
    tracingFetchStub.resolves(mockResponse(null, false, 404, 'Not Found'));
    const result = await fetchLlmoSource(context, TEST_URL);
    expect(result).to.deep.equal({ status: 404, noData: true });
  });

  it('sends the Authorization/User-Agent/Accept-Encoding headers and an abort signal', async () => {
    tracingFetchStub.resolves(mockResponse({}));
    await fetchLlmoSource(context, TEST_URL);
    const [url, opts] = tracingFetchStub.getCall(0).args;
    expect(url).to.equal(TEST_URL);
    expect(opts.headers.Authorization).to.equal('token test-key');
    expect(opts.headers['User-Agent']).to.equal('test-ua');
    expect(opts.headers['Accept-Encoding']).to.equal('br');
    expect(opts.signal).to.exist;
  });

  it('throws with upstreamStatus on non-404 non-OK (5xx)', async () => {
    tracingFetchStub.resolves(mockResponse(null, false, 500, 'Internal Server Error'));
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.upstreamStatus).to.equal(500);
      expect(err.message).to.include('External API returned 500');
    }
  });

  it('throws with upstreamStatus on non-404 4xx (e.g. 401)', async () => {
    tracingFetchStub.resolves(mockResponse(null, false, 401, 'Unauthorized'));
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.upstreamStatus).to.equal(401);
    }
  });

  it('throws isTimeout on AbortError', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    tracingFetchStub.rejects(abort);
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.isTimeout).to.equal(true);
      expect(err.message).to.include('Request timeout');
    }
  });

  it('throws isConfigError when LLMO_HLX_API_KEY is missing (no fetch)', async () => {
    context.env.LLMO_HLX_API_KEY = undefined;
    try {
      await fetchLlmoSource(context, TEST_URL);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.isConfigError).to.equal(true);
      expect(tracingFetchStub).to.not.have.been.called;
    }
  });

  describe('llmoSourceErrorResponse', () => {
    it('maps isTimeout -> 504', () => {
      const e = new Error('Request timeout after 15000ms'); e.isTimeout = true;
      expect(llmoSourceErrorResponse(e).status).to.equal(504);
    });
    it('maps 5xx -> 502', () => {
      const e = new Error('External API returned 503'); e.upstreamStatus = 503;
      expect(llmoSourceErrorResponse(e).status).to.equal(502);
    });
    it('passes through non-404 4xx', () => {
      const e = new Error('External API returned 401'); e.upstreamStatus = 401;
      expect(llmoSourceErrorResponse(e).status).to.equal(401);
    });
    it('maps isConfigError -> 500', () => {
      const e = new Error('LLMO_HLX_API_KEY environment variable is not configured'); e.isConfigError = true;
      expect(llmoSourceErrorResponse(e).status).to.equal(500);
    });
    it('returns null for untagged errors (caller keeps its 400 fallback)', () => {
      expect(llmoSourceErrorResponse(new Error('Network error'))).to.equal(null);
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx mocha test/controllers/llmo/llmo-source.test.js`
Expected: FAIL - module `llmo-source.js` does not exist.

- [ ] **Step 3: Implement `llmo-source.js`**

Create `src/controllers/llmo/llmo-source.js`. The empty payload constant is the Phase 0 (Task 2) capture - **replace the body below with the verbatim contents of `test/fixtures/llmo/empty-sheet.json`** before committing:

```js
/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { SPACECAT_USER_AGENT, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { createResponse, internalServerError } from '@adobe/spacecat-shared-http-utils';

const TIMEOUT_MS = 15000;

// Discriminator header so clients can tell "provisioned-but-empty" (absent)
// from "not provisioned yet" (present), while the body stays byte-identical
// to a genuinely-empty sheet for backwards compatibility.
export const NOT_PROVISIONED_HEADER = 'x-llmo-data-status';
export const NOT_PROVISIONED_VALUE = 'not-provisioned';

// Captured live from elmo-ui-data (SITES-43989 Phase 0, Task 2).
// MUST byte-match test/fixtures/llmo/empty-sheet.json.
export const EMPTY_SHEET_PAYLOAD = {
  total: 0, offset: 0, limit: 0, data: [], ':type': 'sheet',
};

/**
 * Fetch a single elmo-ui-data source URL with a 15s timeout and the LLMO key.
 * Backend-agnostic about meaning: it reports HTTP semantics only.
 *  - 2xx          -> { status, data: <parsed json>, headers }
 *  - 404          -> { status: 404, noData: true }            (no throw)
 *  - other non-OK -> throws Error with `upstreamStatus`
 *  - abort/timeout-> throws Error with `isTimeout = true`
 *  - missing key  -> throws Error with `isConfigError = true` (before any fetch)
 */
export const fetchLlmoSource = async (context, url) => {
  const { log, env } = context;

  if (!env.LLMO_HLX_API_KEY) {
    const err = new Error('LLMO_HLX_API_KEY environment variable is not configured');
    err.isConfigError = true;
    throw err;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${env.LLMO_HLX_API_KEY}`,
        'User-Agent': SPACECAT_USER_AGENT,
        'Accept-Encoding': 'br',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 404) {
      return { status: 404, noData: true };
    }

    if (!response.ok) {
      log.debug(`Failed to fetch data from external endpoint: ${response.status} ${response.statusText}`);
      const err = new Error(`External API returned ${response.status}: ${response.statusText}`);
      err.upstreamStatus = response.status;
      throw err;
    }

    const data = await response.json();
    return {
      status: response.status,
      data,
      headers: response.headers ? Object.fromEntries(response.headers.entries()) : {},
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      const timeoutErr = new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw error;
  }
};

/**
 * Maps a fetchLlmoSource error to an honest HTTP response, or null if the
 * error is not a recognized source failure (caller keeps its own 400 fallback).
 */
export const llmoSourceErrorResponse = (error) => {
  if (error.isConfigError) {
    return internalServerError(error.message);
  }
  if (error.isTimeout) {
    return createResponse({ message: error.message }, 504);
  }
  if (typeof error.upstreamStatus === 'number') {
    if (error.upstreamStatus >= 500) {
      return createResponse({ message: error.message }, 502);
    }
    return createResponse({ message: error.message }, error.upstreamStatus);
  }
  return null;
};

/** Structured, queryable not-provisioned signal (events2metrics key). */
export const logNotProvisioned = (log, siteId, dataFolder) => {
  // Level decided in Phase 0 Task 4 (debug if it reaches ingestion, else info).
  log.debug('llmo_data_not_provisioned', { event: 'llmo_data_not_provisioned', siteId, dataFolder });
};
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx mocha test/controllers/llmo/llmo-source.test.js`
Expected: PASS (all branch + mapper tests).

- [ ] **Step 5: Assert the constant byte-matches the fixture (add one test)**

Append to `test/controllers/llmo/llmo-source.test.js` (top-level `describe`):

```js
  it('EMPTY_SHEET_PAYLOAD byte-matches the captured fixture', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(readFileSync(
      join(here, '../../fixtures/llmo/empty-sheet.json'), 'utf-8',
    ));
    const mod = await esmock('../../../src/controllers/llmo/llmo-source.js', {});
    expect(mod.EMPTY_SHEET_PAYLOAD).to.deep.equal(fixture);
  });
```

Run: `npx mocha test/controllers/llmo/llmo-source.test.js`
Expected: PASS. If it fails, the constant in Step 3 does not match the Task 2 capture - fix the constant to the captured bytes.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/llmo/llmo-source.js test/controllers/llmo/llmo-source.test.js
git commit -m "feat: add shared llmo-source fetch helper with 404->noData semantics (SITES-43989)"
```

---

## Task 6: Fix 2 - refactor `llmo-query-handler.js` onto the helper

**Files:**
- Modify: `src/controllers/llmo/llmo-query-handler.js:77-155` (`fetchAndProcessSingleFile`), `:186-224` (`fetchAndProcessMultipleFiles`)
- Test: `test/controllers/llmo/llmo-query-handler.test.js:90-94` (esmock slot), add multi-file `no_data` test near `:661`

- [ ] **Step 1: Move the `tracingFetch` mock to the global esmock slot (so it reaches the helper)**

In `test/controllers/llmo/llmo-query-handler.test.js`, the current `esmock(path, { '@adobe/spacecat-shared-utils': {...} })` (`:90-94`) mocks the handler's direct import. After the refactor, the fetch happens inside `llmo-source.js` (a separate module), so move that mock to the **3rd** (global) argument:

```js
    const module = await esmock(
      '../../../src/controllers/llmo/llmo-query-handler.js',
      {},
      {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
        },
      },
    );
```

- [ ] **Step 2: Add the multi-file `no_data` test (failing) and run**

Next to the existing `it('should handle file fetch errors in multi-file mode', ...)` (`:661`), add:

```js
    it('reports status no_data for an upstream-404 file in multi-file mode', async () => {
      tracingFetchStub.onFirstCall().resolves(createMockResponse({ ':type': 'sheet', data: [] }));
      tracingFetchStub.onSecondCall().resolves(createMockResponse(null, false, 404));
      mockContext.data = { file: ['a.json', 'b.json'] };
      delete mockContext.params.dataSource;

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data[0].status).to.equal('success');
      expect(result.data[1].status).to.equal('no_data');
      expect(result.data[1].error).to.be.undefined;
    });
```

Run: `npx mocha test/controllers/llmo/llmo-query-handler.test.js -g "no_data"`
Expected: FAIL - today a 404 throws -> caught as `status:'error'`.

- [ ] **Step 3: Refactor `fetchAndProcessSingleFile` to use the helper**

Replace the body of `fetchAndProcessSingleFile` (`:77-155`) below the URL construction. Remove the local `AbortController`, the `LLMO_HLX_API_KEY` check, the `fetch(...)`, the `!response.ok` throw, and the `AbortError` mapping (all now inside `fetchLlmoSource`). Keep the URL building and `processData`:

```js
import { fetchLlmoSource } from './llmo-source.js';
// ... (keep existing imports; SPACECAT_USER_AGENT / tracingFetch no longer needed here
//      unless used elsewhere in the file - remove if now unused to satisfy lint)

const fetchAndProcessSingleFile = async (context, llmoConfig, filePath, queryParams) => {
  const { log } = context;
  const { sheet } = context.data;

  const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${llmoConfig.dataFolder}/${filePath}`);
  const limit = queryParams.limit ? parseInt(queryParams.limit, 10) : 10000000;
  const offset = queryParams.offset ? parseInt(queryParams.offset, 10) : 0;
  url.searchParams.set('limit', limit.toString());
  url.searchParams.set('offset', offset.toString());
  if (sheet) {
    url.searchParams.set('sheet', sheet);
  }

  const urlAsString = url.toString();
  log.info(`Fetching single file with path: ${urlAsString}`);

  const result = await fetchLlmoSource(context, urlAsString);
  if (result.noData) {
    return { noData: true };
  }

  const processedData = processData(result.data, queryParams);
  return { data: processedData, headers: result.headers };
};
```

- [ ] **Step 4: Map `noData` to `status:'no_data'` in `fetchAndProcessMultipleFiles`**

In the per-file callback (`:198-218`):

```js
    async (filePath) => {
      try {
        const single = await fetchAndProcessSingleFile(context, llmoConfig, filePath, queryParams);
        if (single.noData) {
          return { path: filePath, status: 'no_data' };
        }
        return { path: filePath, status: 'success', data: single.data };
      } catch (error) {
        log.debug(`Error fetching and processing file ${filePath}: ${error.message}`);
        return { path: filePath, status: 'error', error: error.message };
      }
    },
```

- [ ] **Step 5: Run the query-handler suite**

Run: `npx mocha test/controllers/llmo/llmo-query-handler.test.js`
Expected: PASS, including the pre-existing 500/timeout/missing-key tests (`:183`, `:194`, `:215`) - their thrown messages are unchanged - and the new `no_data` test. The single-file "should return files data" test still sees `{ data, headers }` for a 200.

- [ ] **Step 6: Lint + commit**

Run: `npm run lint`

```bash
git add src/controllers/llmo/llmo-query-handler.js test/controllers/llmo/llmo-query-handler.test.js
git commit -m "refactor: route llmo-query-handler single-file fetch through llmo-source; 404->no_data (SITES-43989)"
```

---

## Task 7: Fix 2 - wire the `queryFiles` controller's `noData` -> empty 200

**Files:**
- Modify: `src/controllers/llmo/llmo.js:1129-1148` (`queryFiles`)
- Test: `test/controllers/llmo/llmo.test.js:3650-3748` (`queryFiles` describe)

- [ ] **Step 1: Add the not-provisioned test (failing)**

In the `queryFiles` describe (`:3650`), the existing `createControllerWithCacheStub` stubs `queryLlmoFiles`. Add a test that stubs it to the new single-file `noData` shape:

```js
    it('returns empty 200 with not-provisioned header when single-file query reports noData', async () => {
      const queryLlmoFilesStub = sinon.stub().resolves({ noData: true });
      const LlmoControllerWithCache = await esmock('../../../src/controllers/llmo/llmo.js', {
        '../../../src/controllers/llmo/llmo-query-handler.js': {
          queryLlmoFiles: queryLlmoFilesStub,
        },
        '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
        ...getCommonMocks(),
      });
      const cacheController = LlmoControllerWithCache(mockContext);

      const result = await cacheController.queryFiles(mockContext);

      expect(result.status).to.equal(200);
      expect(result.headers.get('x-llmo-data-status')).to.equal('not-provisioned');
      const body = await result.json();
      expect(body).to.deep.equal({
        total: 0, offset: 0, limit: 0, data: [], ':type': 'sheet',
      });
    });
```

Run: `npx mocha test/controllers/llmo/llmo.test.js -g "queryFiles.*not-provisioned"`
Expected: FAIL - `queryFiles` currently destructures `{ data, headers }` and returns `cachedOk(undefined, undefined)`.

- [ ] **Step 2: Implement the `noData` branch**

Edit `queryFiles` (`:1142-1143`):

```js
      const { llmoConfig } = siteValidation;
      const queryResult = await queryLlmoFiles(context, llmoConfig);
      if (queryResult.noData) {
        logNotProvisioned(log, siteId, llmoConfig.dataFolder);
        return cachedOk(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      return cachedOk(queryResult.data, queryResult.headers);
```

Add the import at the top of `llmo.js` (with the other `./llmo-*` imports):

```js
import {
  fetchLlmoSource,
  llmoSourceErrorResponse,
  logNotProvisioned,
  EMPTY_SHEET_PAYLOAD,
  NOT_PROVISIONED_HEADER,
  NOT_PROVISIONED_VALUE,
} from './llmo-source.js';
```

(Note: `fetchLlmoSource` and `llmoSourceErrorResponse` are used in Task 8; importing them now is fine but will trip `no-unused-vars` until Task 8 - if running tasks strictly one-at-a-time, import only `logNotProvisioned`, `EMPTY_SHEET_PAYLOAD`, `NOT_PROVISIONED_HEADER`, `NOT_PROVISIONED_VALUE` here and add the other two in Task 8.)

- [ ] **Step 3: Run + confirm existing queryFiles tests still pass**

Run: `npx mocha test/controllers/llmo/llmo.test.js -g "queryFiles"`
Expected: PASS - new test green; existing success/error/403/404 tests unchanged (`queryLlmoFiles` returning `{data,headers}` still hits the `cachedOk(queryResult.data, queryResult.headers)` path).

- [ ] **Step 4: Lint + commit**

Run: `npm run lint`

```bash
git add src/controllers/llmo/llmo.js test/controllers/llmo/llmo.test.js
git commit -m "feat: queryFiles returns empty 200 + not-provisioned header on upstream 404 (SITES-43989)"
```

---

## Task 8: Fix 2 - migrate the three sheet endpoints onto the helper

**Files:**
- Modify: `src/controllers/llmo/llmo.js` - `getLlmoSheetData` (`:188-253`), `queryLlmoSheetData` (`:257-427`), `getLlmoGlobalSheetData` (`:430-485`)
- Test: `test/controllers/llmo/llmo.test.js:222` (shared esmock - add global slot), `:710-1015` (`getLlmoSheetData`), `:1016-1083` (`getLlmoGlobalSheetData`), `:1084+` (`queryLlmoSheetData`)

- [ ] **Step 1: Add the global `tracingFetch` mock to the shared esmock call**

The main controller is esmocked once at `:222`. Add the **3rd** argument so the transitively-imported `llmo-source.js` gets the same `tracingFetchStub`, and keep `SPACECAT_USER_AGENT` aligned so header assertions still match:

```js
    LlmoController = await esmock('../../../src/controllers/llmo/llmo.js', {
      // ... existing 2nd-arg mocks unchanged ...
    }, {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: TEST_USER_AGENT,
        tracingFetch: (...args) => tracingFetchStub(...args),
      },
    });
```

(The existing 2nd-arg `@adobe/spacecat-shared-utils` mock stays; it still serves `llmo.js`'s own non-sheet `tracingFetch` callers. esmock partial-merges, so the other real exports are preserved - verified: probe + `suggestions.test.js:5581` precedent.)

- [ ] **Step 2: Relax the two exact-object header assertions (they gain a `signal`)**

`getLlmoSheetData` "should proxy data ... successfully" (`:722`) asserts an exact options object. The helper now also passes `signal`. Change to a partial match:

```js
      expect(tracingFetchStub).to.have.been.calledWith(testUrl, sinon.match({
        headers: {
          Authorization: `token ${TEST_API_KEY}`,
          'User-Agent': TEST_USER_AGENT,
          'Accept-Encoding': 'br',
        },
      }));
```

- [ ] **Step 3: Replace the missing-key + 404 behavior tests (failing)**

Replace "should use fallback API key when env.LLMO_HLX_API_KEY is undefined" (`:782-796`) - the helper no longer forwards a bogus token; a missing key throws `isConfigError` -> 500, and fetch is not called:

```js
    it('returns 500 and does not call the source when LLMO_HLX_API_KEY is undefined', async () => {
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(500);
      expect(tracingFetchStub).to.not.have.been.called;
    });
```

Replace "should handle external API errors" (`:798-807`, which stubbed a 404 -> 400) with the not-provisioned behavior plus the genuine-failure mappings:

```js
    it('returns empty 200 + not-provisioned header on upstream 404', async () => {
      tracingFetchStub.resolves(createMockResponse(null, false, 404));

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(result.headers.get('x-llmo-data-status')).to.equal('not-provisioned');
      const body = await result.json();
      expect(body).to.deep.equal({
        total: 0, offset: 0, limit: 0, data: [], ':type': 'sheet',
      });
      expect(mockLog.error).to.not.have.been.called;
    });

    it('maps upstream 5xx to 502', async () => {
      tracingFetchStub.resolves(createMockResponse(null, false, 503, 'Service Unavailable'));
      const result = await controller.getLlmoSheetData(mockContext);
      expect(result.status).to.equal(502);
    });

    it('maps timeout/abort to 504', async () => {
      const abort = new Error('aborted'); abort.name = 'AbortError';
      tracingFetchStub.rejects(abort);
      const result = await controller.getLlmoSheetData(mockContext);
      expect(result.status).to.equal(504);
    });

    it('passes through a non-404 4xx (e.g. 401)', async () => {
      tracingFetchStub.resolves(createMockResponse(null, false, 401, 'Unauthorized'));
      const result = await controller.getLlmoSheetData(mockContext);
      expect(result.status).to.equal(401);
    });
```

The "should handle network errors" test (`:809`) stays as-is: an untagged `Error('Network error')` -> `llmoSourceErrorResponse` returns `null` -> existing `badRequest(400)` fallback.

Run: `npx mocha test/controllers/llmo/llmo.test.js -g "getLlmoSheetData"`
Expected: FAIL on the new not-provisioned/502/504/401/500 tests (endpoint not yet refactored).

- [ ] **Step 4: Refactor `getLlmoSheetData`**

Replace the fetch/throw block (`:228-252`) - from `const response = await fetch(...)` through the `catch`:

```js
      // Fetch via the shared helper (owns timeout, key check, headers, status branching)
      const result = await fetchLlmoSource(context, url.toString());
      if (result.noData) {
        logNotProvisioned(log, siteId, llmoConfig.dataFolder);
        return cachedOk(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      return cachedOk(result.data, { ...result.headers });
    } catch (error) {
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message}`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
```

(Remove the now-dead URL `Authorization`/`fetch`/`!response.ok`/`response.json()` lines that the helper replaces. `llmoConfig` is already in scope from `siteValidation`.)

- [ ] **Step 5: Refactor `queryLlmoSheetData` and `getLlmoGlobalSheetData` identically**

`queryLlmoSheetData` (`:330-426`): replace the `const response = await fetch(...)` + `!response.ok` throw (`:332-343`) with `const result = await fetchLlmoSource(context, url.toString());` then a `noData` guard returning the empty-200+header **before** the post-processing block, and let `let data = result.data;` feed the existing sheets/mapping/inclusion/filter/exclusion/group pipeline. Pass `result.headers` to the final `ok(...)`. In the `catch` (`:422-425`), insert the `llmoSourceErrorResponse(error)` mapping before the `badRequest` fallback:

```js
      const result = await fetchLlmoSource(context, url.toString());
      if (result.noData) {
        logNotProvisioned(log, siteId, llmoConfig.dataFolder);
        return ok(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      let data = result.data;
      const responseHeaders = result.headers;
      // ... existing sheets/mapping/inclusion/filter/exclusion/group pipeline unchanged ...
      return ok(data, { ...responseHeaders });
    } catch (error) {
      const errorTime = Date.now();
      log.error(`Error proxying data for siteId: ${siteId}, error: ${error.message} - elapsed: ${errorTime - methodStartTime}ms`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
```

`getLlmoGlobalSheetData` (`:459-484`): same shape as `getLlmoSheetData` (it uses `cachedOk`). On `noData`, log with the `llmo-global` folder context (use the `sheetURL`/`configName` for the log; `dataFolder` is not site-specific here - pass `'llmo-global'`):

```js
      const result = await fetchLlmoSource(context, url.toString());
      if (result.noData) {
        logNotProvisioned(log, siteId, 'llmo-global');
        return cachedOk(EMPTY_SHEET_PAYLOAD, { [NOT_PROVISIONED_HEADER]: NOT_PROVISIONED_VALUE });
      }
      log.info(`Successfully proxied global data for siteId: ${siteId}, sheetURL: ${sheetURL}`);
      return cachedOk(result.data, { ...result.headers });
    } catch (error) {
      log.error(`Error proxying global data for siteId: ${siteId}, error: ${error.message}`);
      const mapped = llmoSourceErrorResponse(error);
      if (mapped) {
        return mapped;
      }
      return badRequest(cleanupHeaderValue(error.message));
    }
```

- [ ] **Step 6: Mirror the behavior tests for the other two endpoints**

In the `getLlmoGlobalSheetData` (`:1016`) and `queryLlmoSheetData` (`:1084`) describes, find each block's equivalent of the "external API errors" (404->400) test and replace it with the not-provisioned 200+header assertion (use `EXTERNAL_API_BASE_URL/llmo-global/...` for the global testUrl). Add a 5xx->502 and an abort->504 test to each, copying the `getLlmoSheetData` versions from Step 3 with the endpoint's own controller method. For `queryLlmoSheetData`, the empty-200 body assertion is the same `EMPTY_SHEET_PAYLOAD` deep-equal. Show the full test bodies (do not abbreviate) so each describe is self-contained.

- [ ] **Step 7: Run the full LLMO controller suite**

Run: `npx mocha test/controllers/llmo/llmo.test.js`
Expected: PASS. The bulk of URL-construction tests are unchanged (the controller still builds the same URL and `tracingFetchStub` is still called with it via the global mock). If any URL test fails because it asserted an exact options object, relax it to `sinon.match.object` (same fix as Step 2).

- [ ] **Step 8: Lint + commit**

Run: `npm run lint`

```bash
git add src/controllers/llmo/llmo.js test/controllers/llmo/llmo.test.js
git commit -m "feat: LLMO sheet endpoints return empty 200 on not-provisioned, map upstream failures honestly (SITES-43989)"
```

---

## Task 9: Documentation - OpenAPI for the four LLMO read endpoints

**Files:**
- Modify: the LLMO path definitions under `docs/openapi/` (the sheet-data, global-sheet-data, and cached-query operations).

- [ ] **Step 1: Locate the LLMO endpoint definitions**

Run: `grep -rln "sheet-data\|global-sheet-data\|llmo/data" docs/openapi/`

- [ ] **Step 2: Document the new response contract**

For each of the four read operations, add/adjust:
- a `200` response that may carry the optional response header `x-llmo-data-status` with enum value `not-provisioned` (description: "present when the site's LLMO data is not yet provisioned; body is an empty sheet envelope"),
- `502` (upstream source failure) and `504` (upstream timeout) responses,
- note that a non-404 upstream 4xx is passed through.

Follow the existing header/response YAML style in the file (match an existing `headers:`/`responses:` block).

- [ ] **Step 3: Validate docs**

Run: `npm run docs:lint`
Expected: clean. (If the repo also builds the bundled spec, run that build and confirm no errors.)

- [ ] **Step 4: Commit**

```bash
git add docs/openapi
git commit -m "docs: document x-llmo-data-status header and 200-empty/502/504 for LLMO read endpoints (SITES-43989)"
```

---

## Task 10: Final verification + PR

- [ ] **Step 1: Full test suite + coverage + lint**

Run: `npm test`
Expected: PASS with coverage gates met. If coverage drops on `llmo-source.js`, add the missing branch test to `llmo-source.test.js`.

- [ ] **Step 2: Confirm Fix 3 is intentionally untouched**

Run: `git diff --stat origin/main -- src/controllers/scrapeJob.js`
Expected: **empty** (no change). The spec deliberately leaves the scrape API as-is; if a diff appears, revert it.

- [ ] **Step 3: Sanity-grep the behavior changes are isolated to LLMO + webhooks**

Run: `git diff --stat origin/main -- src/`
Expected: only `src/controllers/llmo/llmo.js`, `src/controllers/llmo/llmo-source.js`, `src/controllers/llmo/llmo-query-handler.js`, `src/controllers/webhooks.js`.

- [ ] **Step 4: Open the PR**

Push the branch and open a PR titled `fix: SITES-43989 inline error-rate remediation (LLMO not-provisioned + webhook log noise)`. In the body: link the spec and SITES-43989; paste the Phase 0 captures (empty fixture provenance, the 15s payload timings, the events2metrics rule JSON, and the debug-vs-info log-level decision); call out the two flagged decisions for reviewer confirmation (missing-key -> 500; single-sheet empty shape synthesized for all single-file noData). Use a Conventional Commit title so semantic-release picks it up.

- [ ] **Step 5: Post-merge verification (after deploy, ~24h)**

Re-run the SITES-43989 Coralogix queries: `MYSTICAT_WORKSPACE_REPOS not set` warn rate -> ~0; LLMO not-provisioned 400s gone (confirm via the new `llmo_data_not_provisioned` events2metrics counter); overall API Gateway 4xx+5xx below the SKYSI-76262 threshold with margin.

---

## Self-Review

**Spec coverage:**
- Fix 1 (hoist + reclassify warn) -> Task 1. ✓
- Phase 0 (fixtures, 15s audit, events2metrics + log level) -> Tasks 2-4. ✓
- Fix 2 shared helper + 4 endpoints, 404->empty200+header, 5xx->502, timeout->504, 4xx passthrough, multi-file `no_data` -> Tasks 5-8. ✓
- Fetch unification (15s + key check applied to the 3 sheet endpoints) -> helper in Task 5, adopted in Tasks 6/8; go/no-go in Task 3. ✓
- Discriminator header + structured log + events2metrics -> constants/logger in Task 5, emitted in Tasks 7/8, rule in Task 4. ✓
- Fix 3 (no change) -> asserted in Task 10 Step 2. ✓
- Docs (response headers/examples change) -> Task 9. ✓
- Rollback -> revert the helper's 404 branch (covered by isolating HTTP semantics in `llmo-source.js`). ✓
- Post-merge verification -> Task 10 Step 5. ✓

**Placeholder scan:** The only deferred value is `EMPTY_SHEET_PAYLOAD` / `empty-sheet.json`, which is a genuine live-capture output of Task 2 (not a placeholder); the expected Helix shape is shown and a byte-match test (Task 5 Step 5) enforces it. OpenAPI file paths are resolved by a `grep` step rather than hard-coded because the exact path layout is unverified. Task 8 Step 6 says "show full test bodies" rather than repeating three near-identical blocks inline - the executor must write them out, not abbreviate.

**Type/name consistency:** `fetchLlmoSource(context, url)`, `llmoSourceErrorResponse(error)`, `logNotProvisioned(log, siteId, dataFolder)`, `EMPTY_SHEET_PAYLOAD`, `NOT_PROVISIONED_HEADER`/`NOT_PROVISIONED_VALUE` are defined once in Task 5 and used with the same signatures in Tasks 6-8. The single-file `noData` contract is `{ noData: true }` (Task 5/6) and consumed identically in Tasks 6/7. Multi-file uses `status: 'no_data'` (Task 6) and is asserted with that exact string (Task 6 Step 2).

**Open confirmations (carry into the PR):** (1) missing-key -> 500 vs 400; (2) synthesizing the single-sheet empty shape for all single-file `noData`; (3) Phase 0 Task 3 go/no-go on the 15s timeout for the sheet endpoints.
