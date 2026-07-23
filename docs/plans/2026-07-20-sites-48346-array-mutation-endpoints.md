# Audit Policy Array-Mutation Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ticket:** [SITES-48346](https://jira.corp.adobe.com/browse/SITES-48346) — `[Spec + Impl] Audit Policy API — exclusion vs manual-URL endpoint granularity (Q1)`
**Spec (source of truth):** `adobe/mysticat-architecture` → `platform/design-audit-policy-array-mutation-endpoints.md` (PR #204). Read it before starting; this plan implements its §1–§7.
**Epic:** [SITES-44768](https://jira.corp.adobe.com/browse/SITES-44768)
**Repo / branch:** `spacecat-api-service` on `feat/sites-47306-api-contract` (the branch backing PR #2723 — this plan amends that PR in place, it does not open a new one).

**Goal:** In the still-open `spacecat-api-service` PR #2723 (branch `feat/sites-47306-api-contract`), remove the full-replace `PUT /sites/{siteId}/audit-policy` endpoint (E2) and replace it with four granular array-mutation endpoints (`exclusions`/`inclusions` add + delete), per `mysticat-architecture/platform/design-audit-policy-array-mutation-endpoints.md`.

**Architecture:** A single shared `mutateArray(context, resourceKey, mode)` controller function (resourceKey ∈ `exclusions`/`inclusions`, mode ∈ `add`/`remove`) does: authz → validate body → read current row (or E1's synthetic default) → compute new array (set-union or set-difference) → cap check → call the existing `wrpc_upsert_audit_policy` RPC with every other field echoed unchanged → on version conflict, recursively retry (re-read + reapply) up to 3 attempts total → `409` if exhausted. Four thin exported wrappers (`addExclusions`, `removeExclusions`, `addInclusions`, `removeInclusions`) each call it with fixed arguments. No data-service change — same RPC, same DTO, same access-control pattern E2 already used.

**Tech Stack:** Node.js, Mocha + Chai + Sinon + esmock (existing repo test stack), `@adobe/spacecat-shared-http-utils`, PostgREST client.

---

## Task 0: Orient in the worktree

**Files:** none changed — read-only verification.

- [ ] **Step 1: Confirm you're on the right branch with a clean tree**

Run: `cd /Users/grumaz/repos/mysticat-workspace/.worktrees/spacecat-api-service--feat-sites-47306-api-contract && git status --short && git branch --show-current`
Expected: no output from `git status --short` (clean), branch is `feat/sites-47306-api-contract`.

- [ ] **Step 2: Run the existing suite once to get a known-green baseline**

Run: `npx mocha test/controllers/audit-policy.test.js test/dto/audit-policy.test.js -R dot`
Expected: all passing (this file currently has 4 `describe` blocks: E1 getPolicy, E2 putPolicy, E3 listRevisions, E4-E6 stubs).

---

## Task 1: Remove E2 (`putPolicy`) — controller, routes, capabilities

**Files:**
- Modify: `src/controllers/audit-policy.js`
- Modify: `src/routes/index.js`
- Modify: `src/routes/facs-capabilities.js`
- Modify: `src/routes/required-capabilities.js`
- Modify: `test/controllers/audit-policy.test.js`

This is a removal, not new behavior — there's no "write a failing test first" here. Instead: remove the code and its tests together, then confirm the *remaining* suite is still green (the safety net is "nothing else broke").

- [ ] **Step 1: Remove `putPolicy` and its now-unused helpers/constants from the controller**

In `src/controllers/audit-policy.js`:

Delete the `MAX_BUDGET`, `MAX_JSON_FIELD_BYTES`, and `STRATEGIES` constants (lines 30–32) — they exist only for `validatePolicyBody`, which is being deleted, and `budget`/`strategyName` are never touched by the granular endpoints (only echoed unchanged).

Delete the entire `validatePolicyBody` function (lines 59–117).

Delete the entire `putPolicy` function (lines 183–238).

Remove `putPolicy` from the final return statement:
```javascript
  return {
    getPolicy, listRevisions, getScopePages, getScopeSummary, getScopeSections,
  };
```

Keep everything else unchanged: `POLICY_TABLE`, `REVISION_TABLE`, `UPSERT_RPC`, `MAX_EXCLUSION_GLOBS`/`MAX_MANUAL_URLS`/`MAX_ELEMENT_LEN`/`MAX_NOTE_LEN`/`MAX_REASON_LEN` (all reused by Task 2), `SQLSTATE_VERSION_CONFLICT`, `DEFAULT_PAGE`/`MAX_PAGE`/`MAX_CURSOR_VERSION`, `hasProductAccess`, `decodeCursor`/`encodeCursor`, `getAuthor`, `authorizeRead`, `getPolicy`, `listRevisions`, `notImplemented`/`getScopePages`/`getScopeSummary`/`getScopeSections`.

- [ ] **Step 2: Remove the E2 unit test block**

In `test/controllers/audit-policy.test.js`, delete the entire `describe('AuditPolicyController — E2 putPolicy', ...)` block (starts at the line with `const UPSERT_RPC = 'wrpc_upsert_audit_policy';` immediately before it — keep that constant, Task 2's tests reuse it — through the matching closing `});` before `describe('AuditPolicyController — E3 listRevisions', ...)`).

- [ ] **Step 3: Remove the PUT route**

In `src/routes/index.js`, delete this line:
```javascript
    'PUT /sites/:siteId/audit-policy': auditPolicyController.putPolicy,
```
(between the `GET /sites/:siteId/audit-policy` and `GET /sites/:siteId/audit-policy/revisions` lines).

- [ ] **Step 4: Remove the PUT capability entries**

In `src/routes/facs-capabilities.js`, delete this line from the "Configure" bucket:
```javascript
      'PUT /sites/:siteId/audit-policy': 'aso/can_configure',
```

In `src/routes/required-capabilities.js`, delete this line:
```javascript
  'PUT /sites/:siteId/audit-policy': 'site:write',
```
Leave the `// Audit Policy contract (SITES-47306)` comment and the remaining `GET` lines in both files untouched — Task 3 adds the new routes' entries right after them.

- [ ] **Step 5: Run the full relevant test suite to confirm nothing else broke**

Run: `npx mocha test/controllers/audit-policy.test.js test/dto/audit-policy.test.js test/routes/facs-capabilities.test.js test/routes/required-capabilities.test.js -R dot`
Expected: all passing. If `facs-capabilities.test.js` or `required-capabilities.test.js` fail with a "stale route" error, you missed a deletion in Step 3/4.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/audit-policy.js src/routes/index.js src/routes/facs-capabilities.js src/routes/required-capabilities.js test/controllers/audit-policy.test.js
git commit -m "refactor(audit-policy): remove full-replace PUT (E2), superseded by granular array-mutation endpoints"
```

---

## Task 2: Shared mutate engine + `exclusions` endpoints (TDD)

**Files:**
- Modify: `src/controllers/audit-policy.js`
- Modify: `test/controllers/audit-policy.test.js`

- [ ] **Step 1: Write the failing tests**

Add this near the top of `test/controllers/audit-policy.test.js`, after the existing `buildClient`/`buildContext` helpers (they're reused as-is) — a new stub builder that supports a *sequence* of `maybeSingle`/`rpc` results, needed for the conflict-retry tests:

```javascript
// Like buildClient, but `.maybeSingle()` and `.rpc()` each return the next
// entry in a queue on every call (needed to simulate: read v5 -> RPC 409 ->
// re-read v6 -> RPC succeeds). Each queue entry is `{ data, error }`.
function buildSequencedClient({ selectQueue, rpcQueue }) {
  let selectCall = 0;
  let rpcCall = 0;
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => {
      const next = selectQueue[Math.min(selectCall, selectQueue.length - 1)];
      selectCall += 1;
      return Promise.resolve(next);
    },
  };
  return {
    from: () => chain,
    rpc: sinon.stub().callsFake(() => {
      const next = rpcQueue[Math.min(rpcCall, rpcQueue.length - 1)];
      rpcCall += 1;
      return Promise.resolve(next);
    }),
  };
}

const ROW_V5 = {
  site_id: SITE_ID,
  version: 5,
  budget: 4000,
  strategy_name: 'tiered',
  exclusion_globs: ['/checkout/*'],
  manual_urls: [],
  scope_config: {},
  lifecycle_overrides: {},
  created_by: 'a',
  updated_by: 'a',
  reason: 'r',
  note: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('AuditPolicyController — exclusions add/remove', () => {
  afterEach(() => sinon.restore());

  it('add: unions a new glob into exclusionGlobs and calls the RPC with expectedVersion = current version', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6, exclusion_globs: ['/checkout/*', '/account/*'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'add account exclusion' },
    }));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.exclusionGlobs).to.deep.equal(['/checkout/*', '/account/*']);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*', '/account/*'],
      p_manual_urls: [],
      p_expected_version: 5,
      p_reason: 'add account exclusion',
    }));
  });

  it('add: adding an already-present glob is a no-op for that element (still 200, array unchanged)', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    await controller.addExclusions(buildContext({
      client, data: { values: ['/checkout/*'], reason: 'no-op add' },
    }));
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*'],
    }));
  });

  it('add: bulk values are all unioned in one call, one revision', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    await controller.addExclusions(buildContext({
      client, data: { values: ['/a/*', '/b/*', '/c/*'], reason: 'bulk add' },
    }));
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*', '/a/*', '/b/*', '/c/*'],
    }));
    expect(client.rpc).to.have.been.calledOnce;
  });

  it('remove: set-difference drops the given glob', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: { ...ROW_V5, exclusion_globs: ['/checkout/*', '/account/*'] }, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6, exclusion_globs: ['/account/*'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.removeExclusions(buildContext({
      client, data: { values: ['/checkout/*'], reason: 'remove checkout' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/account/*'],
    }));
  });

  it('remove: removing an absent value is a no-op (still 200, array unchanged)', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: ROW_V5, error: null }],
      rpcQueue: [{ data: { ...ROW_V5, version: 6 }, error: null }],
    });
    const controller = loadController();
    await controller.removeExclusions(buildContext({
      client, data: { values: ['/never-there/*'], reason: 'no-op remove' },
    }));
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_exclusion_globs: ['/checkout/*'],
    }));
  });

  it('cap exceeded after computing the new array -> 400 before calling the RPC', async () => {
    const bigRow = { ...ROW_V5, exclusion_globs: Array.from({ length: 200 }, (_, i) => `/g${i}/*`) };
    const client = buildSequencedClient({
      selectQueue: [{ data: bigRow, error: null }],
      rpcQueue: [],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/one-too-many/*'], reason: 'over cap' },
    }));
    expect(res.status).to.equal(400);
    expect(client.rpc).to.not.have.been.called;
  });

  it('missing reason -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: ['/a/*'] },
    }));
    expect(res.status).to.equal(400);
  });

  it('empty values array -> 400', async () => {
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      data: { values: [], reason: 'nothing to add' },
    }));
    expect(res.status).to.equal(400);
  });

  it('conflict then retry succeeds: re-reads fresh version and reapplies', async () => {
    const client = buildSequencedClient({
      selectQueue: [
        { data: ROW_V5, error: null },
        { data: { ...ROW_V5, version: 6 }, error: null },
      ],
      rpcQueue: [
        { data: null, error: { code: '40000', details: '6' } },
        { data: { ...ROW_V5, version: 7, exclusion_globs: ['/checkout/*', '/account/*'] }, error: null },
      ],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'retry add' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledTwice;
    expect(client.rpc.secondCall).to.have.been.calledWith(UPSERT_RPC, sinon.match({ p_expected_version: 6 }));
  });

  it('conflict on every attempt exhausts retries -> 409 with currentVersion', async () => {
    const conflict = { data: null, error: { code: '40000', details: '9' } };
    const client = buildSequencedClient({
      selectQueue: [
        { data: ROW_V5, error: null },
        { data: { ...ROW_V5, version: 6 }, error: null },
        { data: { ...ROW_V5, version: 7 }, error: null },
      ],
      rpcQueue: [conflict, conflict, conflict],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/account/*'], reason: 'always conflicts' },
    }));
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.currentVersion).to.equal(9);
    expect(client.rpc).to.have.been.calledThrice;
  });

  it('first-write bootstrap: no existing row -> uses synthetic defaults and expectedVersion 0', async () => {
    const client = buildSequencedClient({
      selectQueue: [{ data: null, error: null }],
      rpcQueue: [{
        data: {
          site_id: SITE_ID,
          version: 1,
          budget: 5000,
          strategy_name: 'tiered',
          exclusion_globs: ['/checkout/*'],
          manual_urls: [],
          scope_config: {},
          lifecycle_overrides: {},
          created_by: 'u@x.com',
          updated_by: 'u@x.com',
          reason: 'first policy',
          note: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      }],
    });
    const controller = loadController();
    const res = await controller.addExclusions(buildContext({
      client, data: { values: ['/checkout/*'], reason: 'first policy' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_budget: 5000,
      p_strategy_name: 'tiered',
      p_expected_version: 0,
    }));
  });

  it('returns 403 when caller lacks both ASO and LLMO entitlement', async () => {
    // Same idiom as the (removed) E2 putPolicy test: hasAccess(site) -> true (org member);
    // hasAccess(site,'','ASO') and (...,'LLMO') -> false.
    const hasAccess = sinon.stub();
    hasAccess.withArgs(sinon.match.any).resolves(true);
    hasAccess.withArgs(sinon.match.any, '', 'ASO').resolves(false);
    hasAccess.withArgs(sinon.match.any, '', 'LLMO').resolves(false);
    const controller = loadController(hasAccess);
    const res = await controller.addExclusions(buildContext({ data: { values: ['/a/*'], reason: 'r' } }));
    expect(res.status).to.equal(403);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx mocha test/controllers/audit-policy.test.js -g "exclusions add/remove"`
Expected: FAIL — `controller.addExclusions is not a function` (and similarly for `removeExclusions`).

- [ ] **Step 3: Implement the shared engine and the exclusions endpoints**

In `src/controllers/audit-policy.js`, change the caps and add a new constant, replacing this block:
```javascript
const MAX_EXCLUSION_GLOBS = 1000;
const MAX_MANUAL_URLS = 50000;
const MAX_ELEMENT_LEN = 2048;
```
with:
```javascript
const MAX_EXCLUSION_GLOBS = 200;
const MAX_MANUAL_URLS = 2000;
const MAX_ELEMENT_LEN = 2048;
const MAX_RETRY_ATTEMPTS = 3;
```
(200/2000, not the original 1000/50000 — see `design-audit-policy-array-mutation-endpoints.md` §7 item 3: the original pair's worst-case body size exceeds this service's ~6MB Lambda synchronous-invocation payload ceiling.)

Then, where `putPolicy` used to be (removed in Task 1), add:

```javascript
const RESOURCE_CONFIG = {
  exclusions: { field: 'exclusionGlobs', max: MAX_EXCLUSION_GLOBS },
  inclusions: { field: 'manualUrls', max: MAX_MANUAL_URLS },
};

// returns a string error message, or null when valid
function validateMutateBody(b) {
  if (!isObject(b)) {
    return 'request body must be a JSON object';
  }
  if (!Array.isArray(b.values) || b.values.length === 0) {
    return 'values must be a non-empty array';
  }
  if (b.values.some((s) => typeof s !== 'string' || s.length > MAX_ELEMENT_LEN)) {
    return `values entries must be strings <= ${MAX_ELEMENT_LEN} chars`;
  }
  if (!hasText(b.reason) || b.reason.length > MAX_REASON_LEN) {
    return `reason is required and must be <= ${MAX_REASON_LEN} chars`;
  }
  if (b.note !== undefined && b.note !== null
    && (typeof b.note !== 'string' || b.note.length > MAX_NOTE_LEN)) {
    return `note must be a string <= ${MAX_NOTE_LEN} chars`;
  }
  return null;
}

// add = set-union (preserves existing order, appends new values in call order);
// remove = set-difference. Both are no-ops for elements already in the target state,
// which is what makes retrying this operation safe (§3.2 of the design doc).
function computeNewArray(currentArray, values, mode) {
  if (mode === 'add') {
    return [...new Set([...currentArray, ...values])];
  }
  const removeSet = new Set(values);
  return currentArray.filter((v) => !removeSet.has(v));
}

async function mutateArray(context, resourceKey, mode) {
  const config = RESOURCE_CONFIG[resourceKey];
  const auth = await authorizeRead(context);
  if (auth.error) {
    return auth.error;
  }
  const {
    site, siteId, client, ac,
  } = auth;

  const aso = await hasProductAccess(ac, site, 'ASO');
  const llmo = aso ? true : await hasProductAccess(ac, site, 'LLMO');
  if (!aso && !llmo) {
    return forbidden('Editing the audit policy requires ASO or LLMO entitlement for this site');
  }

  const body = context.data || {};
  const invalid = validateMutateBody(body);
  if (invalid) {
    return badRequest(invalid);
  }

  const attempt = async (remainingAttempts) => {
    const { data: row, error: selectError } = await client
      .from(POLICY_TABLE).select('*').eq('site_id', siteId).maybeSingle();
    if (selectError) {
      context.log?.error?.(`audit-policy ${resourceKey} select failed: ${selectError.code} ${selectError.message}`);
      return internalServerError('Failed to read audit policy');
    }
    const current = row ? AuditPolicyDto.toJSON(row) : AuditPolicyDto.defaultDocument(siteId);
    const newArray = computeNewArray(current[config.field], body.values, mode);
    if (newArray.length > config.max) {
      return badRequest(`${config.field} would exceed the maximum of ${config.max}`);
    }

    const { data, error } = await client.rpc(UPSERT_RPC, {
      p_site_id: siteId,
      p_budget: current.budget,
      p_strategy_name: current.strategyName,
      p_exclusion_globs: config.field === 'exclusionGlobs' ? newArray : current.exclusionGlobs,
      p_manual_urls: config.field === 'manualUrls' ? newArray : current.manualUrls,
      p_scope_config: current.scopeConfig,
      p_lifecycle_overrides: current.lifecycleOverrides,
      p_author: getAuthor(context),
      p_reason: body.reason,
      p_note: body.note ?? null,
      p_expected_version: current.version,
    });

    if (!error) {
      return ok(AuditPolicyDto.toJSON(data));
    }
    if (SQLSTATE_VERSION_CONFLICT.includes(error.code)) {
      if (remainingAttempts > 1) {
        return attempt(remainingAttempts - 1);
      }
      const currentVersion = Number.parseInt(error.details, 10);
      return createResponse(
        {
          message: 'policy was modified; retried and failed, reload and retry',
          ...(Number.isInteger(currentVersion) ? { currentVersion } : {}),
        },
        409,
      );
    }
    if (error.code === 'P0001') {
      context.log?.warn?.(`audit-policy ${resourceKey} rejected by RPC validation (P0001): ${error.message}`);
      return badRequest('audit policy rejected by validation');
    }
    context.log?.error?.(`audit-policy ${resourceKey} failed: ${error.code} ${error.message}`);
    return internalServerError('Failed to write audit policy');
  };

  return attempt(MAX_RETRY_ATTEMPTS);
}

const addExclusions = (context) => mutateArray(context, 'exclusions', 'add');
const removeExclusions = (context) => mutateArray(context, 'exclusions', 'remove');
const addInclusions = (context) => mutateArray(context, 'inclusions', 'add');
const removeInclusions = (context) => mutateArray(context, 'inclusions', 'remove');
```

Update the final return statement to:
```javascript
  return {
    getPolicy,
    listRevisions,
    addExclusions,
    removeExclusions,
    addInclusions,
    removeInclusions,
    getScopePages,
    getScopeSummary,
    getScopeSections,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha test/controllers/audit-policy.test.js -g "exclusions add/remove"`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/audit-policy.js test/controllers/audit-policy.test.js
git commit -m "feat(audit-policy): add exclusions add/remove endpoints (server-side retry-bounded, no client-visible expectedVersion)"
```

---

## Task 3: `inclusions` endpoints (TDD — thin, reuses Task 2's engine)

**Files:**
- Modify: `test/controllers/audit-policy.test.js`

Since `mutateArray` and `RESOURCE_CONFIG` already cover `inclusions`, this task is mostly a wiring-correctness check: confirm the `manualUrls` field and cap are used, not `exclusionGlobs`'s.

- [ ] **Step 1: Write the failing tests**

Add to `test/controllers/audit-policy.test.js`:

```javascript
describe('AuditPolicyController — inclusions add/remove', () => {
  afterEach(() => sinon.restore());

  it('add: unions a new URL into manualUrls and calls the RPC against manual_urls, not exclusion_globs', async () => {
    const row = { ...ROW_V5, manual_urls: ['https://example.com/a'] };
    const client = buildSequencedClient({
      selectQueue: [{ data: row, error: null }],
      rpcQueue: [{ data: { ...row, version: 6, manual_urls: ['https://example.com/a', 'https://example.com/b'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.addInclusions(buildContext({
      client, data: { values: ['https://example.com/b'], reason: 'add partner page' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_manual_urls: ['https://example.com/a', 'https://example.com/b'],
      p_exclusion_globs: ['/checkout/*'],
    }));
  });

  it('remove: set-difference drops the given URL from manualUrls', async () => {
    const row = { ...ROW_V5, manual_urls: ['https://example.com/a', 'https://example.com/b'] };
    const client = buildSequencedClient({
      selectQueue: [{ data: row, error: null }],
      rpcQueue: [{ data: { ...row, version: 6, manual_urls: ['https://example.com/a'] }, error: null }],
    });
    const controller = loadController();
    const res = await controller.removeInclusions(buildContext({
      client, data: { values: ['https://example.com/b'], reason: 'remove partner page' },
    }));
    expect(res.status).to.equal(200);
    expect(client.rpc).to.have.been.calledWith(UPSERT_RPC, sinon.match({
      p_manual_urls: ['https://example.com/a'],
    }));
  });

  it('cap exceeded uses the manualUrls cap (2000), not exclusionGlobs\' (200)', async () => {
    const bigRow = { ...ROW_V5, manual_urls: Array.from({ length: 2000 }, (_, i) => `https://example.com/p${i}`) };
    const client = buildSequencedClient({
      selectQueue: [{ data: bigRow, error: null }],
      rpcQueue: [],
    });
    const controller = loadController();
    const res = await controller.addInclusions(buildContext({
      client, data: { values: ['https://example.com/one-too-many'], reason: 'over cap' },
    }));
    expect(res.status).to.equal(400);
    expect(client.rpc).to.not.have.been.called;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha test/controllers/audit-policy.test.js -g "inclusions add/remove"`
Expected: FAIL — `controller.addInclusions is not a function` (it already exists from Task 2's implementation of `mutateArray`/`RESOURCE_CONFIG.inclusions`/the exported wrappers — if Task 2 was implemented as written, these should actually already pass; this task is verifying that, not writing new production code).

- [ ] **Step 3: Verify — no production code change expected**

If Step 2 already passes, there is no Step 3 implementation — Task 2 built the shared engine to cover both resources. If it fails for a reason *other than* "not a function" (e.g. wrong field mapped), fix the bug in `RESOURCE_CONFIG` or `mutateArray` from Task 2, don't add resource-specific branches.

- [ ] **Step 4: Run to verify passing**

Run: `npx mocha test/controllers/audit-policy.test.js -g "inclusions add/remove"`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add test/controllers/audit-policy.test.js
git commit -m "test(audit-policy): verify inclusions add/remove reuse the shared mutate engine correctly"
```

---

## Task 4: Routes, capabilities, OpenAPI for the four new endpoints

**Files:**
- Modify: `src/routes/index.js`
- Modify: `src/routes/facs-capabilities.js`
- Modify: `src/routes/required-capabilities.js`
- Modify: `docs/openapi/audit-policy-api.yaml`
- Modify: `docs/openapi/api.yaml`

- [ ] **Step 1: Add the four routes**

In `src/routes/index.js`, in place of the deleted `PUT` line (Task 1, Step 3), add:
```javascript
    'POST /sites/:siteId/audit-policy/exclusions': auditPolicyController.addExclusions,
    'POST /sites/:siteId/audit-policy/exclusions/delete': auditPolicyController.removeExclusions,
    'POST /sites/:siteId/audit-policy/inclusions': auditPolicyController.addInclusions,
    'POST /sites/:siteId/audit-policy/inclusions/delete': auditPolicyController.removeInclusions,
```
so the block reads:
```javascript
    'GET /sites/:siteId/audit-policy': auditPolicyController.getPolicy,
    'POST /sites/:siteId/audit-policy/exclusions': auditPolicyController.addExclusions,
    'POST /sites/:siteId/audit-policy/exclusions/delete': auditPolicyController.removeExclusions,
    'POST /sites/:siteId/audit-policy/inclusions': auditPolicyController.addInclusions,
    'POST /sites/:siteId/audit-policy/inclusions/delete': auditPolicyController.removeInclusions,
    'GET /sites/:siteId/audit-policy/revisions': auditPolicyController.listRevisions,
```
No new dynamic `:param` is introduced (`exclusions`/`inclusions`/`delete` are static path segments), so no new `facs-capabilities.js` **param alias** classification is needed — only the route-capability entries below.

- [ ] **Step 2: Add capability entries**

In `src/routes/facs-capabilities.js`, in place of the deleted `PUT` line (Task 1, Step 4), add to the same "Configure" bucket:
```javascript
      'POST /sites/:siteId/audit-policy/exclusions': 'aso/can_configure',
      'POST /sites/:siteId/audit-policy/exclusions/delete': 'aso/can_configure',
      'POST /sites/:siteId/audit-policy/inclusions': 'aso/can_configure',
      'POST /sites/:siteId/audit-policy/inclusions/delete': 'aso/can_configure',
```

In `src/routes/required-capabilities.js`, in place of the deleted `PUT` line, add:
```javascript
  'POST /sites/:siteId/audit-policy/exclusions': 'site:write',
  'POST /sites/:siteId/audit-policy/exclusions/delete': 'site:write',
  'POST /sites/:siteId/audit-policy/inclusions': 'site:write',
  'POST /sites/:siteId/audit-policy/inclusions/delete': 'site:write',
```

- [ ] **Step 3: Run the route-coverage tests**

Run: `npx mocha test/routes/facs-capabilities.test.js test/routes/required-capabilities.test.js -R dot`
Expected: all passing (these are the tests that fail the build on unclassified/stale routes — see `routeFacsCapabilities` "invariant" describe block and `routeRequiredCapabilities` "route coverage" describe block).

- [ ] **Step 4: Replace the OpenAPI `put:` operation with four new operations**

In `docs/openapi/audit-policy-api.yaml`, delete the `put:` block under `audit-policy:` (from `  put:` through the `- scoped_api_key: [ ]` line right before `audit-policy-revisions:`).

In its place — still before `audit-policy-revisions:` — add four new top-level path keys:

```yaml
audit-policy-exclusions:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  post:
    tags:
      - site
      - audit policy
    summary: Add one or more exclusion globs (set-union; already-present values are a no-op)
    operationId: addAuditPolicyExclusions
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/AuditPolicyMutateRequest'
    responses:
      '200':
        description: Updated audit policy
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicy'
      '400': { $ref: './responses.yaml#/400' }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '409':
        description: Version conflict after exhausting internal retries
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicyConflict'
      '500': { $ref: './responses.yaml#/500' }
    security:
      - ims_key: [ ]
      - scoped_api_key: [ ]

audit-policy-exclusions-delete:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  post:
    tags:
      - site
      - audit policy
    summary: >-
      Remove one or more exclusion globs (set-difference; absent values are a no-op). POST, not
      DELETE with a body — this repo's body-parsing middleware does not parse DELETE bodies
      (ADR-001).
    operationId: removeAuditPolicyExclusions
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/AuditPolicyMutateRequest'
    responses:
      '200':
        description: Updated audit policy
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicy'
      '400': { $ref: './responses.yaml#/400' }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '409':
        description: Version conflict after exhausting internal retries
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicyConflict'
      '500': { $ref: './responses.yaml#/500' }
    security:
      - ims_key: [ ]
      - scoped_api_key: [ ]

audit-policy-inclusions:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  post:
    tags:
      - site
      - audit policy
    summary: Add one or more manually-declared URLs (set-union; already-present values are a no-op)
    operationId: addAuditPolicyInclusions
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/AuditPolicyMutateRequest'
    responses:
      '200':
        description: Updated audit policy
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicy'
      '400': { $ref: './responses.yaml#/400' }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '409':
        description: Version conflict after exhausting internal retries
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicyConflict'
      '500': { $ref: './responses.yaml#/500' }
    security:
      - ims_key: [ ]
      - scoped_api_key: [ ]

audit-policy-inclusions-delete:
  parameters:
    - $ref: './parameters.yaml#/siteId'
  post:
    tags:
      - site
      - audit policy
    summary: >-
      Remove one or more manually-declared URLs (set-difference; absent values are a no-op). POST,
      not DELETE with a body (ADR-001).
    operationId: removeAuditPolicyInclusions
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '#/AuditPolicyMutateRequest'
    responses:
      '200':
        description: Updated audit policy
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicy'
      '400': { $ref: './responses.yaml#/400' }
      '401': { $ref: './responses.yaml#/401' }
      '403': { $ref: './responses.yaml#/403' }
      '404': { $ref: './responses.yaml#/404-site-not-found-with-id' }
      '409':
        description: Version conflict after exhausting internal retries
        content:
          application/json:
            schema:
              $ref: '#/AuditPolicyConflict'
      '500': { $ref: './responses.yaml#/500' }
    security:
      - ims_key: [ ]
      - scoped_api_key: [ ]
```

- [ ] **Step 5: Replace `AuditPolicyUpsertRequest` with the shared mutate-request schema, and correct the array caps**

In the same file's schemas section, delete the `AuditPolicyUpsertRequest` schema entirely, and replace it with:

```yaml
AuditPolicyMutateRequest:
  type: object
  required: [values, reason]
  properties:
    values:
      type: array
      minItems: 1
      items: { type: string, maxLength: 2048 }
      description: Exclusion globs or manually-declared URLs to add or remove, one call may carry many.
    reason: { type: string, minLength: 1, maxLength: 2000 }
    note: { type: [string, 'null'], maxLength: 2000 }
```

In the `AuditPolicy` schema, correct the caps to match the controller (Task 2):
```yaml
    exclusionGlobs: { type: array, items: { type: string, maxLength: 2048 }, maxItems: 200 }
    manualUrls: { type: array, items: { type: string, maxLength: 2048 }, maxItems: 2000 }
```
(was `maxItems: 1000` / `maxItems: 50000`).

- [ ] **Step 6: Wire the four new paths into `docs/openapi/api.yaml`**

In place of the removed reliance on the old `put`, add four new top-level path entries alongside the existing `audit-policy`/`audit-policy-revisions` ones:
```yaml
  /sites/{siteId}/audit-policy/exclusions:
    $ref: './audit-policy-api.yaml#/audit-policy-exclusions'
  /sites/{siteId}/audit-policy/exclusions/delete:
    $ref: './audit-policy-api.yaml#/audit-policy-exclusions-delete'
  /sites/{siteId}/audit-policy/inclusions:
    $ref: './audit-policy-api.yaml#/audit-policy-inclusions'
  /sites/{siteId}/audit-policy/inclusions/delete:
    $ref: './audit-policy-api.yaml#/audit-policy-inclusions-delete'
```
so the full block reads:
```yaml
  /sites/{siteId}/audit-policy:
    $ref: './audit-policy-api.yaml#/audit-policy'
  /sites/{siteId}/audit-policy/exclusions:
    $ref: './audit-policy-api.yaml#/audit-policy-exclusions'
  /sites/{siteId}/audit-policy/exclusions/delete:
    $ref: './audit-policy-api.yaml#/audit-policy-exclusions-delete'
  /sites/{siteId}/audit-policy/inclusions:
    $ref: './audit-policy-api.yaml#/audit-policy-inclusions'
  /sites/{siteId}/audit-policy/inclusions/delete:
    $ref: './audit-policy-api.yaml#/audit-policy-inclusions-delete'
  /sites/{siteId}/audit-policy/revisions:
    $ref: './audit-policy-api.yaml#/audit-policy-revisions'
  /sites/{siteId}/audit-scope/pages:
    $ref: './audit-policy-api.yaml#/audit-scope-pages'
  /sites/{siteId}/audit-scope/summary:
    $ref: './audit-policy-api.yaml#/audit-scope-summary'
  /sites/{siteId}/audit-scope/sections:
    $ref: './audit-policy-api.yaml#/audit-scope-sections'
```

- [ ] **Step 7: Lint and build the docs**

Run: `npm run docs:lint`
Expected: clean (no schema-ref errors, no orphaned `AuditPolicyUpsertRequest` references).

Run: `npm run docs:build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/routes/index.js src/routes/facs-capabilities.js src/routes/required-capabilities.js docs/openapi/audit-policy-api.yaml docs/openapi/api.yaml
git commit -m "docs(audit-policy): wire routes, capabilities and OpenAPI for the four array-mutation endpoints"
```

---

## Task 5: Integration tests

**Files:**
- Modify: `test/it/shared/tests/audit-policy.js`

The existing gated suite (`describe.skip`) tests E2's `PUT` directly (API-3/API-5). Replace those two cases with equivalent granular-endpoint cases; leave the gating comment and `describe.skip` as-is (unrelated to this change — it's gated on a data-service image pin, not on E2 vs. the new endpoints).

- [ ] **Step 1: Replace the PUT-specific cases**

In `test/it/shared/tests/audit-policy.js`, replace:
```javascript
    it('API-3/API-5: first PUT with expectedVersion 0 creates version 1', async () => {
      const http = getHttpClient();
      const res = await http.admin.put(`/sites/${SITE_1_ID}/audit-policy`, {
        budget: 4000,
        strategyName: 'tiered',
        exclusionGlobs: [],
        manualUrls: [],
        scopeConfig: {},
        lifecycleOverrides: {},
        reason: 'init',
        expectedVersion: 0,
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(1);
    });

    it('API-5: stale expectedVersion yields 409 with currentVersion', async () => {
      const http = getHttpClient();
      const res = await http.admin.put(`/sites/${SITE_1_ID}/audit-policy`, {
        budget: 4000,
        strategyName: 'tiered',
        exclusionGlobs: [],
        manualUrls: [],
        scopeConfig: {},
        lifecycleOverrides: {},
        reason: 'stale',
        expectedVersion: 0,
      });
      expect(res.status).to.equal(409);
      expect(res.body.currentVersion).to.equal(1);
    });
```
with:
```javascript
    it('first-write via exclusions add creates version 1 with no client-supplied version', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${SITE_1_ID}/audit-policy/exclusions`, {
        values: ['/checkout/*'],
        reason: 'init',
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(1);
      expect(res.body.exclusionGlobs).to.deep.equal(['/checkout/*']);
    });

    it('inclusions add unions into manualUrls and bumps the version', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${SITE_1_ID}/audit-policy/inclusions`, {
        values: ['https://example.com/campaign-a'],
        reason: 'add campaign page',
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(2);
      expect(res.body.manualUrls).to.deep.equal(['https://example.com/campaign-a']);
    });

    it('exclusions/delete removes a glob via set-difference', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(`/sites/${SITE_1_ID}/audit-policy/exclusions/delete`, {
        values: ['/checkout/*'],
        reason: 'remove checkout exclusion',
      });
      expect(res.status).to.equal(200);
      expect(res.body.version).to.equal(3);
      expect(res.body.exclusionGlobs).to.deep.equal([]);
    });
```

- [ ] **Step 2: Confirm the file still loads/reports correctly as skipped (can't run for real yet — same gating as before)**

Run: `npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/audit-policy.test.js --dry-run 2>&1 || npx mocha test/it/postgres/audit-policy.test.js -R dot`
Expected: the suite loads without syntax errors and reports as skipped/pending, same as before this change (it's still gated on the data-service image, unrelated to this task).

- [ ] **Step 3: Commit**

```bash
git add test/it/shared/tests/audit-policy.js
git commit -m "test(audit-policy): update gated integration tests for the granular endpoints, drop PUT-specific cases"
```

---

## Task 6: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all passing, no new failures relative to the Task 0 baseline.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Docs build (repeat, now that all route files changed)**

Run: `npm run docs:lint && npm run docs:build`
Expected: clean.

- [ ] **Step 4: Push**

```bash
git push
```
(Pushes to the existing `feat/sites-47306-api-contract` branch backing PR #2723 — confirm `gh auth status` and the SSH identity match `adobe/spacecat-api-service` before pushing, per this workspace's git-identity convention.)

- [ ] **Step 5: Update the PR description**

`#2723`'s description currently documents E2 (`PUT`, full-replace, `p_expected_version`). Update it to describe the four granular endpoints instead, and drop the "gated integration tests... pending enablement on a companion data-service change" framing for the removed PUT-specific cases (the remaining gating reason — the data-service image pin — is unchanged and still applies).

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** endpoint shapes (§3.1), concurrency/no-`expectedVersion` (§3.2), error mapping (§3.3, reused verbatim), corrected caps (§7 item 3), `POST .../delete` per ADR-001 (§7 item 1), fixed-3-attempts-no-backoff (§7 item 2), first-write bootstrap (§1) are all covered by Tasks 1-5.
- **Not in this plan, by design:** the mysticat-data-service follow-up migration to tighten the DB-side `CHECK` constraint/RPC caps to 200/2000 (spec §7 item 3) — that's a separate repo, separate PR, explicitly called out as needing a *new* migration since #755 already merged. The API-layer's 200/2000 is strictly tighter than the DB's current 1000/50000, so this is safe (not a regression) but leaves that correction outstanding.
- **Not in this plan:** revising the UI v1 design material that assumed E2's client-visible `expectedVersion`/`409`-retry flow (spec §7 item 5) — that lives in a different, also-unmerged PR.
