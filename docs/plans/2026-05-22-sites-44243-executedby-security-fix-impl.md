# SITES-44243 Fix `executedBy` PII Exposure - Implementation Plan

**Spec:** `docs/specs/2026-05-22-sites-44243-executedby-security-fix.md`

**Goal:** Close the PII exfiltration path where a client-supplied `executedBy` value caused the
server to call the admin-only IMS profile API for an arbitrary user ID. Auto-populate `executedBy`
from the authenticated caller's JWT identity on both `createFixes` and `patchFix`.

---

## Completed

### Phase 1 - Core security fix

- [x] **Add `#imsClient` private field** to `FixesController` class, initialized from `ctx.imsClient`.

- [x] **Add `#enrichFixesWithUserNames(fixes)` private method**
  - Deduplicates `executedBy` values across all fixes in the response.
  - Fans out `imsClient.getImsAdminProfile(userId)` calls via `Promise.allSettled` (individual
    failures do not abort the response).
  - Attaches `fix._executedByUser = { firstName, lastName, email }` for resolved profiles.
  - Warns (not errors) on individual resolution failures.
  - No-ops silently when `#imsClient` is not configured.

- [x] **Call `#enrichFixesWithUserNames` in `getAllForOpportunity`** - both the `getByStatus`
  and main fix-list code paths.

- [x] **Modify `patchFix`** - intent-signal pattern:
  - Before: `if (hasText(executedBy)) fix.setExecutedBy(executedBy)` (accepted arbitrary client value).
  - After: client-supplied `executedBy` is an intent signal only. Server resolves the actual
    value from `context.attributes?.authInfo?.getProfile?.()` (`user_id ?? sub`) and calls
    `fix.setExecutedBy(callerUserId)` only when a verified identity is available and the value
    changed.

- [x] **Modify `createFixes`** - override client-supplied value:
  - Extract `callerUserId` once before the batch loop.
  - Spread `...(hasText(callerUserId) && { executedBy: callerUserId })` into each
    `FixEntity.create()` call, overriding any client-supplied value.

- [x] **Update `FixDto.toJSON`** in `src/dto/fix.js`:
  - Conditionally include `executedByUser: { firstName, lastName, email }` when `fix._executedByUser`
    is set (mirrors the existing `_suggestions` transient property pattern).

- [x] **Remove `executedBy` from `FixUpdate` OpenAPI schema** in `docs/openapi/schemas.yaml`.

- [x] **Update unit tests** in `test/controllers/fixes.test.js`:
  - Added `testExternalUserId = 'ABCD1234@AdobeOrg'` constant.
  - Added `authInfo` mock to `patchFix` `beforeEach` (`getProfile: () => ({ user_id: testExternalUserId })`).
  - Updated `patchFix` assertions: client-supplied `executedBy` values replaced with `testExternalUserId`.
  - Added `createFixes` test: attacker-supplied `executedBy: 'attacker@evil.org'` is overridden
    with `testExternalUserId`.
  - Added 3 enrichment tests for `getAllForOpportunity`: happy path, IMS failure, no `imsClient`.

- [x] **Update DTO tests** in `test/dto/fix.test.js`:
  - Added tests: `executedByUser` included when `_executedByUser` is set; excluded when not set;
    placeholder dash values pass through correctly.

- [x] **All 105 unit tests pass** after the above changes.

---

## Remaining work (from PR review)

The following items were flagged in the PR review as Important/Critical and must be addressed
before merging.

### 1. Add `executedByUser` to OpenAPI `Fix` response schema

**File:** `docs/openapi/schemas.yaml`

Find the `Fix` schema and add the `executedByUser` object to its `properties`:

```yaml
executedByUser:
  type: object
  description: Resolved identity of the user who executed the fix, populated server-side from the IMS admin profile API.
  readOnly: true
  properties:
    firstName:
      type: string
      example: Jane
    lastName:
      type: string
      example: Doe
    email:
      type: string
      format: email
      example: jdoe@adobe.com
```

Run `npm run docs:lint` to validate.

### 2. Add `#enrichFixesWithUserNames` to `getByStatus` and `getByID`

**File:** `src/controllers/fixes.js`

`getAllForOpportunity` enriches fixes but `getByStatus` and `getByID` do not. This creates an
inconsistent API surface where the same fix is returned with `executedByUser` on some endpoints
and without it on others.

Locate `getByStatus` and `getByID` in the controller and call
`await this.#enrichFixesWithUserNames([fix])` (or the full list for `getByStatus`) before
constructing the response.

Add tests covering enrichment for both endpoints.

### 3. Return `400` when `executedBy` intent signal cannot be resolved

**File:** `src/controllers/fixes.js` - `patchFix`

Currently, if `executedBy` is present in the request body but no verified identity is available
(e.g., the auth profile has neither `user_id` nor `sub`), the code silently no-ops. The client
receives a `200` but the field was not updated, with no feedback.

Options:
- Return `400 Bad Request` explaining that the executor identity could not be resolved.
- Add `profile?.email` as a third fallback (since the IMS auth handler populates `email`).

The second option (add `email` fallback) is lower risk for IMS-authenticated callers:

```js
const callerUserId = profile?.user_id ?? profile?.sub ?? profile?.email;
```

### 4. Fix stale comment in `src/dto/fix.js:57`

The comment reads "TrialUser store". It should read "IMS admin profile API".

### Validation gate

```bash
npm test            # all unit tests pass
npm run docs:lint   # OpenAPI spec validates cleanly
```

After all four items above are addressed, the PR is ready for merge.
