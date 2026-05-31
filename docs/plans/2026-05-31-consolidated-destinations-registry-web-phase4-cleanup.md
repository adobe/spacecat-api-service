# Consolidated Destinations Registry (Web Tier, Phase 4 — Cleanup) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Each task is TDD-ordered and leaves the **full** suite green before the next task starts.

**Goal:** Make the consolidated `GITHUB_DESTINATIONS` registry the single GitHub-webhook routing path on the web tier. Delete every legacy-reading code path: `parseTargets`/`classify`, the `GITHUB_TARGETS` registry + single-`GITHUB_WEBHOOK_SECRET` branches in the HMAC handler, the `webhookSecretEnvVar` indirection, the `GITHUB_REVIEWER_LOGIN`/`GITHUB_APP_SLUG` globals, the `${appSlug}[bot]` fallback, and the controller's app-slug requirement. Fail closed when the registry or a reviewer identity is absent, and pay down the two deferred-coverage lines from #2522.

**Architecture:** The web tier classifies each signed webhook to a destination in `GitHubWebhookHmacHandler.checkAuth`, selects that destination's inline `webhook_secret`, verifies HMAC once, and attaches `{ user_id, target_id, reviewer_login }` to the auth profile, which `WebhooksController` reads to gate the trigger (`getSkipReason`) and emit `target_id` on the SQS payload. After this PR there is exactly one path: `GITHUB_DESTINATIONS` present → classify/verify; absent or malformed → fail closed (null → 401). `reviewer_login` is required on every entry (no global fallback), so the controller treats a missing reviewer identity as a 5xx, replacing the old app-slug fail-closed gate.

**Tech Stack:** Node.js >=24 (ESM), Mocha 11 (`--parallel`), Chai 6 `expect`, Sinon 22, `esmock`, c8 coverage, ESLint 9 (`@adobe/eslint-config-helix`). `npm test` runs `c8 --skip-full mocha --parallel --timeout 10000 -i -g 'Post-Deploy' --spec=test/**/*.test.js --ignore=test/it/**`.

**Spec:** `mysticat-architecture/platform/decisions/consolidated-destinations-registry.md` — **Phase 4 — Cleanup + regression** (Migration step 4 "Cleanup PR (both repos + Vault)"; Validation Phase 4). The worker tier already shipped its Phase 4 cleanup (`adobe/mysticat-github-service#38` → v0.11.1, deployed dev + prod). Both envs are verified on `GITHUB_DESTINATIONS` (dev `GITHUB_DESTINATIONS` v82, prod v56), so removing the legacy path is safe.

**Explicitly out of scope** (per ADR):
- **`api_host`** per-entry field — deliberately deferred (YAGNI; both destinations on `api.github.com`).
- **Legacy Vault-key deletion** (`GITHUB_TARGETS`, `GITHUB_WEBHOOK_SECRET*`, `GITHUB_REVIEWER_LOGIN`, `GITHUB_APP_SLUG`) — a **post-deploy ops step**, done only after this code (which stops reading them) is live. Deleting them before deploy would break the running dual-read code. They become vestigial/harmless after this PR deploys.
- **"GITHUB_DESTINATIONS not logged"** — a Validation gate, not new code: the handler already logs only the parser's value-free message (`e.message` names keys/fields, never the secret), and never interpolates the raw env value. Confirmed in the final validation.

**Plan location:** `docs/plans/2026-05-31-consolidated-destinations-registry-web-phase4-cleanup.md`

---

## File Structure

| File | Status | Responsibility after cleanup |
|------|--------|------------------------------|
| `src/support/github-targets.js` | modify | Keep `parseDestinations`, `classifyDestination`, `extractClassificationMetadata`, `hostOf`. **Delete** `parseTargets` and `classify`. Update the module header to describe only the consolidated registry. |
| `src/support/github-webhook-hmac-handler.js` | modify | One path: require `GITHUB_DESTINATIONS` (else error log + null), parse, classify, verify HMAC, attach `{ user_id, target_id, reviewer_login }`. **Delete** the `GITHUB_TARGETS` registry branch and the single-`GITHUB_WEBHOOK_SECRET` legacy branch, and the `parseTargets`/`classify` import. |
| `src/utils/github-trigger-rules.js` | modify | `getSkipReason(data, action, reviewerLogin)` — drop `env`, `appSlug`, the `${appSlug}[bot]` fallback, and the env defaults. The reviewer gate is `reviewer === reviewerLogin`. |
| `src/controllers/webhooks.js` | modify | Drop `appSlug` resolution + the `if (!appSlug)` 500. `reviewerLogin = profile.reviewer_login` (no env fallback). Add a fail-closed `if (!reviewerLogin)` 500. Call `getSkipReason(data, action, reviewerLogin)`. Drop the `'legacy'` label from the enqueue log. |
| `test/support/github-targets.test.js` | modify | Drop `parseTargets`/`classify` import, `VALID_TARGETS`, and the `parseTargets`/`parseTargets reviewerLogin`/`classify` describes. **Add** the two deferred-coverage tests (entry-not-object; classifyDestination no-default backstop). |
| `test/support/github-webhook-hmac-handler.test.js` | modify | `makeContext()` defaults to a `GITHUB_DESTINATIONS` registry. Drop the legacy-mode test, the whole `GITHUB_TARGETS registry path` describe, and the dual-read precedence test. Re-point the "not configured" test at `GITHUB_DESTINATIONS`. |
| `test/utils/github-trigger-rules.test.js` | modify | Rewrite `getSkipReason` + lockstep describes for the 3-arg form; remove env/appSlug/`[bot]`-fallback tests. |
| `test/controllers/webhooks.test.js` | modify | `validContext` carries a default profile (`target_id` + `reviewer_login`); drop `GITHUB_APP_SLUG` from helpers. Remove the app-slug-500, env-fallback, per-target-app_slug, and no-profile-legacy tests; add a reviewer-login-500 fail-closed test. |

---

### Task 1: Deferred-coverage tests (additive; no source change)

Pays down the two #2522 codecov/patch lines, which both live in the kept code, so they are pure test additions that pass immediately.

**Files:**
- `test/support/github-targets.test.js`

- [ ] **Step 1: Add the two tests.**
  In the `describe('github-targets parseDestinations', ...)` block (after the `accepts a slug[bot] reviewer_login` test), add:
  ```js
  it('throws when an entry is not an object', () => {
    const bad = JSON.stringify({ 'github-public': 'not-an-object' });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('must be an object');
  });
  ```
  In the `describe('github-targets classifyDestination', ...)` block (after the last test), add:
  ```js
  it('returns { skip: true } when no default entry exists (defensive backstop for an unvalidated registry)', () => {
    // parseDestinations guarantees exactly one default, so this only happens
    // when classifyDestination is handed a hand-built registry. A github.com
    // host with no enterprise match and no default must skip, not throw.
    const noDefault = { ghec: { match: { enterprise_slug: ['adobe-prd'] }, webhook_secret: 's', reviewer_login: 'r' } };
    expect(classifyDestination({ host: 'github.com', enterpriseSlug: null }, noDefault))
      .to.deep.equal({ skip: true });
  });
  ```

- [ ] **Step 2: Run, expect PASS.** `npx mocha test/support/github-targets.test.js` → all green.
- [ ] **Step 3: Commit.** `test(github-targets): cover entry-not-object guard + classifyDestination no-default backstop`

---

### Task 2: HMAC handler — `GITHUB_DESTINATIONS` is the only path

**Files:**
- `src/support/github-webhook-hmac-handler.js`
- `test/support/github-webhook-hmac-handler.test.js`

- [ ] **Step 1: Update the handler tests first (RED).**
  - Change `makeContext()`'s default `env` to a consolidated registry:
    ```js
    const DEFAULT_DESTINATIONS = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: secret, reviewer_login: 'MysticatBot' },
    });
    function makeContext(overrides = {}) {
      return { pathInfo: { suffix: '/webhooks/github' }, env: { GITHUB_DESTINATIONS: DEFAULT_DESTINATIONS }, ...overrides };
    }
    ```
  - Delete the test `attaches no reviewer_login in legacy mode (no GITHUB_TARGETS)` (the consolidated path always attaches it).
  - Re-point `returns null and logs error when GITHUB_WEBHOOK_SECRET is not configured` → rename to `... when GITHUB_DESTINATIONS is not configured`; keep `env: {}`; keep the `misconfigured=true` assertion.
  - Delete the whole `describe('GITHUB_TARGETS registry path', ...)` block.
  - In `describe('GITHUB_DESTINATIONS registry path (consolidated)', ...)`, delete the `prefers GITHUB_DESTINATIONS over GITHUB_TARGETS when BOTH are set` test.
  - Run: `npx mocha test/support/github-webhook-hmac-handler.test.js` → expect FAILures (handler still has legacy branches; the renamed "not configured" test still passes via the old `GITHUB_WEBHOOK_SECRET` error, but the malformed-config message + structural expectations differ once the source changes — confirm RED on the renamed assertion after Step 2 if not before).

- [ ] **Step 2: Rewrite the handler.**
  Replace the import (line 16-18):
  ```js
  import { extractClassificationMetadata, parseDestinations, classifyDestination } from './github-targets.js';
  ```
  Replace everything from `// ---- Consolidated path: ...` (line 82) through the end of `checkAuth` (line 212, the closing of the legacy registry-path `return`) with:
  ```js
      // Consolidated registry is the only routing path. GITHUB_DESTINATIONS is a
      // keyed object (target_id -> { match, webhook_secret, reviewer_login })
      // loaded at runtime from Vault. Classify from the SIGNED body, select the
      // matched destination's inline webhook_secret, verify HMAC once. Parsing
      // before verifying is safe: a forged body just selects a candidate whose
      // secret it cannot forge.
      if (!context.env?.GITHUB_DESTINATIONS) {
        this.log('GITHUB_DESTINATIONS not configured (misconfigured=true)', 'error');
        return null;
      }
      let destinations;
      try {
        destinations = parseDestinations(context.env);
      } catch (e) {
        // Malformed registry is a misconfiguration; null -> 401 (visible failed
        // delivery). Do NOT interpolate the value (it is secret-bearing); the
        // parser's message names only keys/fields, never secrets.
        this.log(`Invalid GITHUB_DESTINATIONS config (misconfigured=true): ${e.message}`, 'error');
        return null;
      }
      const rawBody = await this.readBodyWithLimits(request);
      if (rawBody === null) {
        return null;
      }
      const meta = extractClassificationMetadata(rawBody);
      if (meta === null) {
        this.log('Webhook body is not valid JSON', 'warn');
        return null;
      }
      const result = classifyDestination(meta, destinations);
      // host not an in-scope GitHub destination (e.g. a GHES host): skip + log,
      // NO HMAC. The body is untrusted, so do not interpolate meta.host.
      if (result.skip) {
        this.log('Skipping webhook: host is not an in-scope GitHub destination', 'warn');
        return null;
      }
      // webhook_secret is inline + validated non-empty at parse, so it is present
      // on a validated registry; verify HMAC once.
      if (!verifySignature(signature, rawBody, result.webhook_secret)) {
        this.log('HMAC signature mismatch', 'warn');
        return null;
      }
      return new AuthInfo()
        .withAuthenticated(true)
        .withProfile({
          user_id: 'github-webhook',
          target_id: result.target_id,
          // reviewer_login is required on every destination entry (no global
          // fallback), so it is always set here.
          reviewer_login: result.reviewer_login,
        })
        .withType('github_webhook');
    }
  ```

- [ ] **Step 3: Run, expect PASS.** `npx mocha test/support/github-webhook-hmac-handler.test.js` → all green.
- [ ] **Step 4: Run the full suite** (`parseTargets`/`classify` are still exported, used only by `github-targets.test.js`): `npm test` → green.
- [ ] **Step 5: Commit.** `refactor(github-webhook): drop legacy GITHUB_TARGETS/single-secret paths, GITHUB_DESTINATIONS only`

---

### Task 3: Remove `parseTargets` + `classify` from `github-targets.js`

**Files:**
- `src/support/github-targets.js`
- `test/support/github-targets.test.js`

- [ ] **Step 1: Delete the legacy functions + update the header.**
  - Replace the module header (lines 13-19) with:
    ```js
    // GitHub destination registry + classifier. The web tier classifies each
    // inbound webhook to a destination ("target") from the SIGNED body, so the
    // worker can select per-destination credentials by a non-secret target_id.
    // The GITHUB_DESTINATIONS registry carries webhook_secret INLINE in each
    // entry (loaded at runtime from Vault into context.env; secret-bearing - do
    // not log the value).
    ```
  - Delete `parseTargets` (the JSDoc + function, the `export function parseTargets(env) { ... }` block).
  - Delete `classify` (the JSDoc + `export function classify(meta, targets) { ... }` block).
  - In `parseDestinations`'s JSDoc, change the `@returns` line that says `... or null when GITHUB_DESTINATIONS is unset (legacy GITHUB_TARGETS mode).` to `... or null when GITHUB_DESTINATIONS is unset (the handler treats unset as a misconfiguration and fails closed).`

- [ ] **Step 2: Update the tests.**
  - Change the import to: `import { extractClassificationMetadata, parseDestinations, classifyDestination } from '../../src/support/github-targets.js';`
  - Delete the `VALID_TARGETS` fixture.
  - Delete the `describe('github-targets parseTargets', ...)`, `describe('github-targets parseTargets reviewerLogin', ...)`, and `describe('github-targets classify', ...)` blocks.
  - Keep `parseDestinations`, `extractClassificationMetadata`, `classifyDestination` describes (incl. the Task 1 additions).

- [ ] **Step 3: Run, expect PASS.** `npx mocha test/support/github-targets.test.js` → green.
- [ ] **Step 4: Run the full suite.** `npm test` → green (nothing imports `parseTargets`/`classify` anymore).
- [ ] **Step 5: Commit.** `refactor(github-targets): remove legacy parseTargets/classify (GITHUB_TARGETS path)`

---

### Task 4: `getSkipReason` signature + controller (drop globals + app-slug gate, fail closed on reviewer)

These four edits are one coupled unit (the `getSkipReason` signature ripples controller → both test files); keep them in one commit so the suite never goes red mid-task.

**Files:**
- `src/utils/github-trigger-rules.js`
- `src/controllers/webhooks.js`
- `test/utils/github-trigger-rules.test.js`
- `test/controllers/webhooks.test.js`

- [ ] **Step 1: `getSkipReason(data, action, reviewerLogin)`.**
  - Signature → `export function getSkipReason(data, action, reviewerLogin) {`.
  - Delete the appSlug-resolution comment and the `const expectedReviewer = reviewerLogin?.trim() || \`${appSlug}[bot]\`;` line; the reviewer check becomes:
    ```js
    if (action === 'review_requested') {
      const reviewer = data.requested_reviewer?.login;
      if (reviewer !== reviewerLogin) {
        return `reviewer ${reviewer} is not ${reviewerLogin}`;
      }
    }
    ```
  - Update the JSDoc: drop `@param env`/`@param appSlug`; document `reviewerLogin` as the destination's reviewer login (attached by the HMAC handler from `GITHUB_DESTINATIONS`), required, validated by the controller. Keep the disabled-label comment block (it documents why labels are off).

- [ ] **Step 2: Controller.**
  - Replace the `profile`/`targetId`/`appSlug`/`reviewerLogin` block + the `if (!appSlug)` 500 (lines 97-113) with:
    ```js
    // Destination + reviewer identity resolved by the HMAC handler from the
    // consolidated GITHUB_DESTINATIONS registry (every authenticated webhook
    // carries target_id + reviewer_login).
    const profile = ctx.attributes?.authInfo?.getProfile?.() || {};
    const targetId = profile.target_id;
    const reviewerLogin = profile.reviewer_login;

    // Security-relevant: which login may trigger automated runs. reviewer_login
    // is required on every destination entry, so a missing value means a
    // misconfigured registry or a request that bypassed the handler. Fail closed
    // with a 5xx (GitHub retries; visible failed delivery), not a 204 (lost).
    if (!reviewerLogin) {
      log.error('No reviewer login resolved (auth profile missing reviewer_login)', { deliveryId });
      return internalServerError('reviewer login not configured');
    }
    ```
  - Line 151 → `const skipReason = getSkipReason(data, action, reviewerLogin);`
  - Enqueue log (lines 241-244) → replace the comment + `targetId: targetId || 'legacy',` with:
    ```js
        // Resolved destination id, for traffic-distribution observability (per
        // the PR #2503 review recommendation).
        targetId,
    ```
  - Leave the payload spread `...(targetId ? { target_id: targetId } : {})` unchanged (defensive; target_id is paired with the now-guarded reviewer_login on the success path).

- [ ] **Step 3: Rewrite `test/utils/github-trigger-rules.test.js`.**
  Convert all `getSkipReason(data, action, env[, appSlug, reviewerLogin])` calls to `getSkipReason(data, action, reviewerLogin)`:
  - `review_requested trigger`: reviewer matches the passed `reviewerLogin` → null; differs → `'is not'` skip.
  - Delete `describe('GITHUB_REVIEWER_LOGIN override', ...)` and `describe('per-target reviewerLogin (5th arg)', ...)`; fold their surviving intent into two tests: "returns null when the requested reviewer equals reviewerLogin" and "returns the 'is not' skip when it differs".
  - Delete the `uses the explicit appSlug arg over env.GITHUB_APP_SLUG` test.
  - `labeled` / `unsupported actions` / `skip rules`: pass a `reviewerLogin` that matches `requested_reviewer.login` (e.g. `'MysticatBot'`) so the draft/bot/non-default cases reach their checks.
  - `isMysticatTargetedSkip` lockstep: same 3-arg conversion (pass a matching `reviewerLogin`).

- [ ] **Step 4: Update `test/controllers/webhooks.test.js`.**
  - `validContext`: add a default profile and align the requested reviewer:
    ```js
    attributes: {
      authInfo: {
        getProfile: () => ({ user_id: 'github-webhook', target_id: 'github-public', reviewer_login: 'MysticatBot' }),
      },
    },
    ```
    and set `data.requested_reviewer = { login: 'MysticatBot' }`.
  - `buildController` and `buildObsController`: drop the `GITHUB_APP_SLUG: 'mysticat'` env default; also drop it from the side-effect-free-construction test's inline env (line ~278).
  - Delete `returns 500 and logs error when GITHUB_APP_SLUG is not configured`; add two tests:
    ```js
    it('enqueues without GITHUB_APP_SLUG configured (app-slug requirement removed)', async () => {
      controller = buildController(); // env has no GITHUB_APP_SLUG
      const response = await controller.processGitHubWebhook(validContext);
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
    });

    it('returns 500 and logs error when the auth profile has no reviewer_login (fail closed)', async () => {
      const ctx = {
        ...validContext,
        attributes: { authInfo: { getProfile: () => ({ user_id: 'github-webhook', target_id: 'github-public' }) } },
      };
      const response = await controller.processGitHubWebhook(ctx);
      expect(response.status).to.equal(500);
      const errorCall = mockLog.error.getCalls().find((c) => c.args[0].includes('No reviewer login resolved'));
      expect(errorCall).to.not.be.undefined;
      expect(mockSqs.sendMessage.called).to.be.false;
    });
    ```
  - `multi-destination target_id` block: rewrite `ghecAuthContext` to carry `reviewer_login` (drop `app_slug`) with a matching requested reviewer:
    ```js
    function ghecAuthContext() {
      return {
        ...validContext,
        attributes: { authInfo: { getProfile: () => ({ user_id: 'github-webhook', target_id: 'ghec', reviewer_login: 'emu_reviewer' }) } },
        data: { ...validContext.data, requested_reviewer: { login: 'emu_reviewer' } },
      };
    }
    ```
    Delete: `uses the per-target app_slug for the reviewer check (mysticat-bot[bot])`, `falls back to env.GITHUB_REVIEWER_LOGIN when the profile has no reviewer_login (legacy)`, `omits target_id when no auth profile target_id is present (legacy)`, and `logs targetId "legacy" on the enqueue log when no target_id is present`. (The remaining `adds target_id...`, `logs the resolved target id`, the two per-target reviewer_login tests minus their `app_slug` field, and the two consolidated tests stay.)

- [ ] **Step 5: Run the affected files, then the full suite.**
  ```bash
  npx mocha test/utils/github-trigger-rules.test.js test/controllers/webhooks.test.js test/support/github-webhook-hmac-handler.test.js test/support/github-targets.test.js
  npm test
  ```
  Expected: all green.
- [ ] **Step 6: Commit.** `refactor(webhooks): drop GITHUB_REVIEWER_LOGIN/GITHUB_APP_SLUG globals + ${appSlug}[bot] fallback; fail closed on reviewer_login`

---

## Validation

All gates must pass before the PR is opened (ADR Validation Phase 4 — Web).

- [ ] **Full suite green.** `npm test` — all suites pass.
- [ ] **Lint clean.** `npm run lint` — no errors.
- [ ] **Bundle builds.** `npm run build` — the `helix-deploy` bundle loads (catches module-load regressions; per repo CLAUDE.md, the bundle gate is the only check source-only lint/test miss).
- [ ] **No remaining legacy-key reads.** A code search over `src/` finds zero reads of `GITHUB_TARGETS`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_REVIEWER_LOGIN`, `GITHUB_APP_SLUG`, `webhookSecretEnvVar`, `parseTargets`, `classify(` (legacy), `app_slug`/`appSlug`:
  ```bash
  grep -rnE "GITHUB_TARGETS|GITHUB_WEBHOOK_SECRET|GITHUB_REVIEWER_LOGIN|GITHUB_APP_SLUG|webhookSecretEnvVar|parseTargets|app_slug|appSlug" src/
  ```
  Expected: no matches.
- [ ] **Secrets not logged.** Confirm by review that the handler's only `GITHUB_DESTINATIONS`-related log is the `Invalid GITHUB_DESTINATIONS config ... ${e.message}` error (value-free parser message) — the raw env value is never interpolated into any log. (ADR Phase 4: "confirm it is not logged".)
- [ ] **Single path proven.** The handler suite confirms: `GITHUB_DESTINATIONS` set → classify/verify/AuthInfo with `target_id`+`reviewer_login`; absent → null + `GITHUB_DESTINATIONS not configured` error; malformed → null + `Invalid GITHUB_DESTINATIONS` error; non-github.com host → null + skip (no HMAC); wrong inline secret → null + mismatch.
- [ ] **Fail-closed reviewer gate.** The controller suite confirms a profile without `reviewer_login` → 500 (not 204), and that no `GITHUB_APP_SLUG` env is required to enqueue.

### Post-deploy follow-ups (NOT this PR)
- Ops: delete the now-vestigial legacy Vault keys (`GITHUB_TARGETS`, `GITHUB_WEBHOOK_SECRET*`, `GITHUB_REVIEWER_LOGIN`, `GITHUB_APP_SLUG`) from `dx_mysticat/{dev,prod}/api-service` **after** this release is deployed to both envs.
- Regression: confirm a live `github-public` review still triggers + posts in dev after deploy (ADR Phase 4 acceptance).

### Critical Files for Implementation
- /Users/dj/work/github/adobe/spacecat-api-service/src/support/github-targets.js
- /Users/dj/work/github/adobe/spacecat-api-service/src/support/github-webhook-hmac-handler.js
- /Users/dj/work/github/adobe/spacecat-api-service/src/utils/github-trigger-rules.js
- /Users/dj/work/github/adobe/spacecat-api-service/src/controllers/webhooks.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/support/github-targets.test.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/support/github-webhook-hmac-handler.test.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/utils/github-trigger-rules.test.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/controllers/webhooks.test.js
