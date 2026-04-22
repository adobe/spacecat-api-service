# Categories POST Returns 409 on Duplicate Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `POST /v2/orgs/:spaceCatId/categories` from returning 500 when the category name already exists for the organization. Return 409 Conflict with a clear message instead. Fixing this eliminates the retry-amplification loop that is driving SKYSI-76262.

**Architecture:** `createCategory` in `src/support/categories-storage.js` issues a PostgREST upsert with `onConflict: 'organization_id,category_id'`. The underlying DB has a second unique constraint on `(organization_id, name)` (`uq_category_name_per_org`) which is not covered by the upsert. When a client POSTs a new `id` with an existing `name`, the upsert falls back to INSERT and the DB rejects it (Postgres error code `23505`). The fix: detect `23505` on that specific constraint in `createCategory`, throw a typed error carrying `.status = 409`, which `brands.js` `createErrorResponse` already surfaces as a 409 response.

**Tech Stack:** Node.js 22+, Mocha, Chai, Sinon, chai-as-promised. PostgREST via `@supabase/postgrest-js`. Deployed via Helix Deploy → AWS Lambda.

---

## File Structure

- Modify: `src/support/categories-storage.js` — add 23505/uq_category_name_per_org detection to `createCategory`
- Modify: `test/support/categories-storage.test.js` — add unit test covering the duplicate-name 409 path
- Modify: `test/controllers/brands.test.js` — add controller-level test verifying `createCategoryForOrg` surfaces the typed 409

---

## Task 1: Confirm actual PostgREST error shape for the duplicate constraint

**Files:**
- Read: `src/support/categories-storage.js:75-106`
- Read: `node_modules/@supabase/postgrest-js/dist/cjs/PostgrestError.d.ts` (or the published type)

- [ ] **Step 1: Reproduce the failure locally (dev or stage)**

Run against dev (replace API base URL if dev uses a different host):

```bash
TOKEN=$(mysticat auth token --ims)
ORG=<an-org-id-you-can-write-to-in-dev>
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"DupTest"}' \
  "https://spacecat.experiencecloud.live/api/ci/v2/orgs/$ORG/categories"
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"id":"dup-test-uuid","name":"DupTest"}' \
  "https://spacecat.experiencecloud.live/api/ci/v2/orgs/$ORG/categories"
```

Expected: first call 201 Created. Second call currently returns 500.

- [ ] **Step 2: Capture the exact PostgREST error object**

Tail dev Lambda logs (or add a temporary `log.error('raw pg error: %o', error)` to `categories-storage.js` line 103) and run the reproducer again. Record:

- `error.code` — expected `"23505"`
- `error.message` — expected `'duplicate key value violates unique constraint "uq_category_name_per_org"'`
- `error.details` — may contain the conflicting `name`
- `error.hint` — may be empty

Save the exact shape in this plan as a comment before writing the fix, so the match logic is precise. Remove any temporary `log.error` before committing.

- [ ] **Step 3: Validation gate**

Confirm the reproducer produces 500 on dev and you have captured the exact error object. If the error does not carry `code: '23505'`, STOP and revise the detection strategy (match on the constraint name substring instead).

---

## Task 2: Add a failing unit test for the duplicate-name path (storage)

**Files:**
- Modify: `test/support/categories-storage.test.js`

- [ ] **Step 1: Add the test case inside `describe('createCategory', ...)`**

Insert after existing `createCategory` tests:

```javascript
it('throws a 409-typed error when the DB returns uq_category_name_per_org violation', async () => {
  const postgrestClient = {
    from: sinon.stub().returns(createChainableQuery({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_category_name_per_org"',
        details: 'Key (organization_id, name)=(00000000-..., DupTest) already exists.',
        hint: '',
      },
    })),
  };

  try {
    await createCategory({
      organizationId: ORG_ID,
      category: { name: 'DupTest' },
      postgrestClient,
      updatedBy: 'test',
    });
    expect.fail('expected createCategory to throw');
  } catch (err) {
    expect(err.status).to.equal(409);
    expect(err.message).to.match(/already exists/i);
    expect(err.message).to.include('DupTest');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx mocha test/support/categories-storage.test.js -g 'uq_category_name_per_org' --reporter spec
```

Expected: FAIL with message similar to `expected createCategory to throw` or `AssertionError: expected undefined to equal 409`.

- [ ] **Step 3: Validation gate**

The test MUST fail before implementing the fix. If it passes, the test is not exercising the code path — rework the stub before moving on.

---

## Task 3: Implement the 409 detection in `createCategory`

**Files:**
- Modify: `src/support/categories-storage.js:96-105`

- [ ] **Step 1: Replace the error block**

Replace lines 102-104 (the current `if (error) { throw ... }`) with:

```javascript
if (error) {
  if (error.code === '23505' && /uq_category_name_per_org/.test(error.message || '')) {
    const conflict = new Error(`Category with name '${category.name}' already exists for this organization`);
    conflict.status = 409;
    throw conflict;
  }
  throw new Error(`Failed to create category: ${error.message}`);
}
```

Rationale: the existing controller (`src/controllers/brands.js:141 createErrorResponse`) already checks `error.status` and emits the matching HTTP status with a header-safe body, so attaching `.status = 409` is sufficient — no new plumbing needed.

- [ ] **Step 2: Run the new test and verify it passes**

Run:

```bash
npx mocha test/support/categories-storage.test.js -g 'uq_category_name_per_org' --reporter spec
```

Expected: PASS.

- [ ] **Step 3: Run the full storage test file**

Run:

```bash
npx mocha test/support/categories-storage.test.js --reporter spec
```

Expected: all tests PASS. If any prior test now fails, revisit the error-branch logic — the non-matching error path must still throw the generic `Failed to create category` error.

- [ ] **Step 4: Validation gate**

```bash
npm run lint -- src/support/categories-storage.js test/support/categories-storage.test.js
```

Expected: zero warnings/errors.

---

## Task 4: Add a controller-level test for the 409 surface

**Files:**
- Modify: `test/controllers/brands.test.js` (inside `describe('createCategoryForOrg', ...)` at ~line 2168)

- [ ] **Step 1: Add the test case**

```javascript
it('returns 409 when the storage layer throws a duplicate-name error', async () => {
  createCategoryStub.rejects(Object.assign(new Error("Category with name 'DupTest' already exists for this organization"), { status: 409 }));

  const response = await brandsController.createCategoryForOrg({
    params: { spaceCatId: ORG_ID },
    data: { name: 'DupTest' },
    dataAccess: { services: { postgrestClient: {} } },
    attributes: { authInfo: { profile: { email: 'tester@adobe.com' } } },
  });

  expect(response.status).to.equal(409);
  const body = await response.json();
  expect(body.message).to.match(/already exists/i);
});
```

Note: match the stub injection pattern already used in this test file — reuse existing `createCategoryStub` if one already exists; otherwise wire it the same way as the other storage stubs.

- [ ] **Step 2: Run the test**

```bash
npx mocha test/controllers/brands.test.js -g 'returns 409' --reporter spec
```

Expected: PASS.

- [ ] **Step 3: Run the entire brands controller test file**

```bash
npx mocha test/controllers/brands.test.js --reporter spec
```

Expected: all tests PASS.

---

## Task 5: Full repo verification

- [ ] **Step 1: Run the full unit test suite**

```bash
npm test
```

Expected: all tests PASS. Coverage for the modified file MUST remain at or above the current level (branch coverage for the new 23505 branch is required).

- [ ] **Step 2: Run lint across the repo**

```bash
npm run lint
```

Expected: zero errors.

- [ ] **Step 3: Verify no unrelated files changed**

```bash
git status
git diff --stat
```

Expected: only `src/support/categories-storage.js`, `test/support/categories-storage.test.js`, and `test/controllers/brands.test.js` should appear.

---

## Task 6: Commit and open PR

- [ ] **Step 1: Stage only the intended files**

```bash
git add src/support/categories-storage.js test/support/categories-storage.test.js test/controllers/brands.test.js docs/plans/2026-04-17-categories-409-on-duplicate.md
```

- [ ] **Step 2: Create the commit**

```bash
git commit -m "$(cat <<'EOF'
fix(categories): return 409 on duplicate name instead of 500

Detect PostgREST error 23505 on uq_category_name_per_org in createCategory
and throw a typed 409 so createErrorResponse emits the correct status.
Eliminates the retry-amplification loop driving SKYSI-76262.

Refs: SKYSI-76262
EOF
)"
```

- [ ] **Step 3: Push and open PR**

Branch from `origin/main`:

```bash
git fetch origin main
git checkout -b fix/categories-409-on-duplicate origin/main
git cherry-pick <commit-sha>  # or commit on the new branch directly
git push -u origin fix/categories-409-on-duplicate
```

Then open a PR via the MCP github tool targeting `main` with the following description:

```
## Summary
- POST /v2/orgs/:id/categories now returns 409 Conflict (not 500) when the
  name already exists for the organization.
- Fixes the retry-amplification loop behind SKYSI-76262.

## Test plan
- [x] Unit test: categories-storage.js catches 23505/uq_category_name_per_org
      and throws a `.status=409` error.
- [x] Controller test: createCategoryForOrg returns 409 with the expected
      message when storage throws.
- [x] npm test passes.
- [x] npm run lint passes.
- [ ] Post-merge: verify on prod with curl that a duplicate POST to
      /v2/orgs/296fefc8-1e54-46dd-aee4-a0f94621deaf/categories returns 409,
      not 500.
```

---

## Task 7: Post-deploy validation on prod

- [ ] **Step 1: Wait for release to reach prod**

Watch `gh release list -R adobe/spacecat-api-service` (or the release workflow) until the next version is published to prod.

- [ ] **Step 2: Reproduce with a known-duplicate name**

```bash
TOKEN=$(mysticat auth token --ims)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"id":"post-fix-test","name":"Comparison"}' \
  "https://spacecat.experiencecloud.live/api/v1/v2/orgs/296fefc8-1e54-46dd-aee4-a0f94621deaf/categories" \
  -o /tmp/post-fix-resp.json -w "status=%{http_code}\n"
cat /tmp/post-fix-resp.json
```

Expected: `status=409` with a body like `{"message":"Category with name 'Comparison' already exists for this organization"}`.

- [ ] **Step 3: Confirm the SKYSI-76262 5xx rate drops**

Query the Fastly logs in Coralogix for `POST /v2/orgs/296fefc8.../categories` 5xx over the 30 minutes after deploy:

```
source logs
| filter $l.applicationname == 'fastly' && $d.request.url ~ '/v2/orgs/296fefc8-1e54-46dd-aee4-a0f94621deaf/categories' && $d.request.method == 'POST'
| groupby $d.response.status agg count() as cnt
```

Expected: most responses are now 409 (or 201), with 500 count near zero.

- [ ] **Step 4: Validation gate**

If 500 count does NOT fall to near-zero after the DRS caller has retried for at least 5 minutes, roll back and re-investigate. The fix is only considered successful when the error rate on this path drops below 0.1% and SKYSI-76262 stops firing on the categories endpoint.
