# Per-Target Reviewer Login (Web Tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub PR-review trigger gate per-destination by threading a `reviewerLogin` from each `GITHUB_TARGETS` entry through the HMAC auth profile into `getSkipReason`, so a non-`default` (enterprise-matched) target like `ghec` reacts to its own reviewer account instead of the global `MysticatBot`.

**Architecture:** The web tier classifies each signed webhook to a target (`parseTargets`/`classify`) and verifies HMAC in `GitHubWebhookHmacHandler`. This change adds a validated, required-for-non-`default` `reviewerLogin` field to each target, attaches the matched target's value onto the post-verify auth profile as `reviewer_login`, and has `WebhooksController` resolve `profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN` and pass it as a 5th arg to `getSkipReason`. `getSkipReason` gains a 5th param defaulting to `env.GITHUB_REVIEWER_LOGIN`, so existing 3/4-arg callers and the legacy/`default` path are unchanged. The `${appSlug}[bot]` tail is retained as the extension point for a future App-bot destination.

**Tech Stack:** Node.js >=24 (ESM), Mocha 11 (`--parallel`), Chai 6 `expect`, Sinon 22 (sandboxes), `esmock` for module mocks, c8 coverage, ESLint 9 (`@adobe/eslint-config-helix`).

**Spec:** mysticat-architecture/platform/decisions/per-target-reviewer-login.md (ADR; extends support-multiple-github-destinations.md / #94)

**Plan location:** docs/plans/2026-05-29-per-target-reviewer-login.md

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/support/github-targets.js` | modify | `parseTargets` validates a new per-entry `reviewerLogin`: required when the entry is non-`default` (matched by `match.enterpriseSlug`), optional on the `match.default === true` entry; when present must match `^[A-Za-z0-9][A-Za-z0-9-_]*(\[bot\])?$` and be <= 64 chars. |
| `test/support/github-targets.test.js` | modify | Tests: accept `reviewerLogin` on a non-`default` entry; allow omission on the `default` entry; throw when a non-`default` entry omits it; throw on bad charset; throw when too long. |
| `src/support/github-webhook-hmac-handler.js` | modify | Registry path attaches the matched target's `reviewerLogin` to the auth profile as `reviewer_login`; legacy/no-match paths attach nothing (unchanged). |
| `test/support/github-webhook-hmac-handler.test.js` | modify | Tests: profile carries `reviewer_login` on a matched target; legacy path profile has no `reviewer_login`. |
| `src/controllers/webhooks.js` | modify | Resolve `const reviewerLogin = profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN;` and pass as 5th arg to `getSkipReason`. |
| `test/controllers/webhooks.test.js` | modify | Tests: per-target `reviewer_login` from the profile gates the trigger; legacy path falls back to `env.GITHUB_REVIEWER_LOGIN`. |
| `src/utils/github-trigger-rules.js` | modify | `getSkipReason` gains 5th param `reviewerLogin = env.GITHUB_REVIEWER_LOGIN`; expected-reviewer line becomes `reviewerLogin?.trim() || \`${appSlug}[bot]\``. `isMysticatTargetedSkip` unchanged. |
| `test/utils/github-trigger-rules.test.js` | modify | Tests: 5-arg per-target match; 5-arg mismatch skip; back-compat default to env when arg omitted; `${appSlug}[bot]` reachable when both unset. |

---

### Task 1: `parseTargets` validates per-target `reviewerLogin`

Add `reviewerLogin` validation inside the existing `parsed.forEach((t, i) => { ... })` loop in `parseTargets`, reusing its index-based throw style. The `isDefault` boolean already exists in that loop and tells us whether the entry is the `default` catch-all (optional) or an enterprise-matched entry (required).

**Files:**
- `src/support/github-targets.js` (modify `parseTargets`, inside the `forEach` after the existing `isDefault` / `hasSlugs` block, around lines 75-84)
- `test/support/github-targets.test.js` (add a new `describe` block after the existing `parseTargets` describe, around line 130)

Steps:

- [ ] **Step 1: Write failing test — accept `reviewerLogin` on a non-`default` entry.**
  Add to `test/support/github-targets.test.js`, immediately after the existing `describe('github-targets parseTargets', ...)` block closes (before `describe('github-targets extractClassificationMetadata', ...)`):
  ```js
  describe('github-targets parseTargets reviewerLogin', () => {
    const withReviewer = (reviewerLogin) => JSON.stringify([
      {
        id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', reviewerLogin, webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
      },
      {
        id: 'github-public', match: { default: true }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET',
      },
    ]);

    it('parses reviewerLogin on a non-default entry', () => {
      const targets = parseTargets({ GITHUB_TARGETS: withReviewer('emu_reviewer') });
      expect(targets[0].reviewerLogin).to.equal('emu_reviewer');
    });

    it('accepts a slug[bot] reviewerLogin', () => {
      const targets = parseTargets({ GITHUB_TARGETS: withReviewer('some-app[bot]') });
      expect(targets[0].reviewerLogin).to.equal('some-app[bot]');
    });

    it('allows the default entry to omit reviewerLogin', () => {
      const targets = parseTargets({ GITHUB_TARGETS: withReviewer('emu_reviewer') });
      expect(targets[1].reviewerLogin).to.be.undefined;
    });

    it('throws when a non-default entry omits reviewerLogin', () => {
      const noReviewer = JSON.stringify([
        {
          id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 's', webhookSecretEnvVar: 'V',
        },
        {
          id: 'github-public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'W',
        },
      ]);
      expect(() => parseTargets({ GITHUB_TARGETS: noReviewer })).to.throw('reviewerLogin');
    });

    it('throws when reviewerLogin has an invalid charset', () => {
      expect(() => parseTargets({ GITHUB_TARGETS: withReviewer('bad login!') })).to.throw('reviewerLogin');
    });

    it('throws when reviewerLogin exceeds 64 chars', () => {
      expect(() => parseTargets({ GITHUB_TARGETS: withReviewer('a'.repeat(65)) })).to.throw('reviewerLogin');
    });
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/support/github-targets.test.js -g 'reviewerLogin'
  ```
  Expected: failures. `throws when a non-default entry omits reviewerLogin` fails because `parseTargets` does not yet throw (the `ghec` entry parses fine without it); the charset/length tests fail for the same reason (no validation rejects them yet). The first three assertion tests pass already since `reviewerLogin` is preserved by `JSON.parse`, but the suite as a whole is RED.

- [ ] **Step 3: Implement `reviewerLogin` validation in `parseTargets`.**
  In `src/support/github-targets.js`, inside the `parsed.forEach((t, i) => { ... })` loop, locate the `isDefault` declaration and the `match.default`/`enterpriseSlug` block:
  ```js
    const isDefault = t.match?.default === true;
    const hasSlugs = Array.isArray(t.match?.enterpriseSlug)
      && t.match.enterpriseSlug.length > 0
      && t.match.enterpriseSlug.every((s) => typeof s === 'string' && s.length > 0);
    if (!isDefault && !hasSlugs) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] needs match.default:true or a non-empty match.enterpriseSlug[] of strings`);
    }
  ```
  Insert the following immediately after that `if (!isDefault && !hasSlugs)` block (still inside the `forEach`):
  ```js
    // reviewerLogin is the trigger-gate identity (the user we react to as the
    // requested reviewer). REQUIRED on non-default (enterprise-matched) entries
    // so a destination missing its reviewer fails loudly at config-load rather
    // than silently falling back to the global GITHUB_REVIEWER_LOGIN (wrong for
    // that destination). OPTIONAL on the default entry, which keeps the global
    // fallback. When present, accept plain users (MysticatBot), EMU users
    // (handle_shortcode), and App bots (slug[bot]).
    if (!isDefault && (typeof t.reviewerLogin !== 'string' || !t.reviewerLogin.trim())) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] is missing a string "reviewerLogin" (required for non-default targets)`);
    }
    if (t.reviewerLogin !== undefined) {
      if (typeof t.reviewerLogin !== 'string'
        || t.reviewerLogin.length > 64
        || !/^[A-Za-z0-9][A-Za-z0-9-_]*(\[bot\])?$/.test(t.reviewerLogin)) {
        throw new Error(`GITHUB_TARGETS["${t.id}"].reviewerLogin must match ^[A-Za-z0-9][A-Za-z0-9-_]*(\\[bot\\])?$ and be at most 64 chars`);
      }
    }
  ```

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/support/github-targets.test.js -g 'reviewerLogin'
  ```
  Expected: all `reviewerLogin` tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/support/github-targets.test.js
  ```
  Expected: all `github-targets` tests green (existing `VALID_TARGETS` has no `reviewerLogin`, but its non-`default` `ghec` entry now requires one — see note). NOTE: the existing top-level `VALID_TARGETS` fixture has a `ghec` (non-`default`) entry WITHOUT `reviewerLogin`, so the existing `parseTargets`/`classify` tests that consume it would now throw. Before running, update `VALID_TARGETS` (top of file) to add `reviewerLogin` to its `ghec` entry only:
  ```js
  const VALID_TARGETS = JSON.stringify([
    {
      id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', reviewerLogin: 'emu_reviewer', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
    },
    {
      id: 'github-public', match: { default: true }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET',
    },
  ]);
  ```
  Also update the in-file fixtures that build a non-`default` entry and are expected to PARSE SUCCESSFULLY: the `dup`, `defaultFirst`, and `enterpriseSlug contains non-string` fixtures all throw on an EARLIER check (duplicate id / must-be-last / non-string slug) than the new `reviewerLogin` check, so they are unaffected. The `noDefault` fixture (`throws when there is not exactly one`) builds a single non-`default` `ghec` entry and reaches the per-entry loop: it now throws `reviewerLogin` BEFORE the `exactly one` check. Add `reviewerLogin: 'r'` to that fixture's entry so it still reaches and asserts the `exactly one` throw:
  ```js
    const noDefault = JSON.stringify([{
      id: 'ghec', match: { enterpriseSlug: ['a'] }, appSlug: 's', reviewerLogin: 'r', webhookSecretEnvVar: 'V',
    }]);
  ```

- [ ] **Step 6: Commit.**
  ```bash
  git add src/support/github-targets.js test/support/github-targets.test.js && git commit -m "feat(github-targets): validate per-target reviewerLogin (required for non-default)"
  ```

---

### Task 2: HMAC handler attaches `reviewer_login` to the auth profile

In the registry path, the matched `result` target now carries `reviewerLogin`. Attach it to the profile as `reviewer_login`, alongside the existing `target_id` and `app_slug`. The legacy path and skip/error paths are untouched, so they attach nothing — exactly as today.

**Files:**
- `src/support/github-webhook-hmac-handler.js` (modify the registry-path `.withProfile(...)` call, around lines 138-141)
- `test/support/github-webhook-hmac-handler.test.js` (add tests inside the existing `describe('GITHUB_TARGETS registry path', ...)` block, around line 230; add one legacy-path test near line 65)

Steps:

- [ ] **Step 1: Write failing test — matched target attaches `reviewer_login`.**
  In `test/support/github-webhook-hmac-handler.test.js`, the registry-path `TARGETS` fixture's `ghec` entry currently has no `reviewerLogin`. First add `reviewerLogin` to BOTH the `ghec` entry (required) inside that `describe`'s `TARGETS`:
  ```js
      const TARGETS = JSON.stringify([
        {
          id: 'ghec',
          match: { enterpriseSlug: ['adobe-prd'] },
          appSlug: 'mysticat-bot',
          reviewerLogin: 'emu_reviewer',
          webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
        },
        {
          id: 'github-public',
          match: { default: true },
          appSlug: 'mysticat-bot',
          webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET',
        },
      ]);
  ```
  Then add these two tests inside the same `describe('GITHUB_TARGETS registry path', ...)` block (after the existing `attaches target_id ghec` test):
  ```js
      it('attaches reviewer_login from the matched ghec target to the profile', async () => {
        const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghecBody, ghecSecret) }, ghecBody);
        const result = await handler.checkAuth(request, registryContext());
        expect(result.getProfile().reviewer_login).to.equal('emu_reviewer');
      });

      it('attaches no reviewer_login for the default (github-public) target', async () => {
        const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
        const result = await handler.checkAuth(request, registryContext());
        expect(result.getProfile().reviewer_login).to.be.undefined;
      });
  ```
  And add this legacy-path test inside the top-level `describe('GitHubWebhookHmacHandler', ...)`, after the existing `returns AuthInfo with type github_webhook on valid signature` test:
  ```js
  it('attaches no reviewer_login in legacy mode (no GITHUB_TARGETS)', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result.getProfile().reviewer_login).to.be.undefined;
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/support/github-webhook-hmac-handler.test.js -g 'reviewer_login'
  ```
  Expected: `attaches reviewer_login from the matched ghec target to the profile` FAILS with `expected undefined to equal 'emu_reviewer'` — the handler does not yet put `reviewer_login` on the profile. The two "no reviewer_login" tests pass already (the profile never carries it today), but the suite is RED.

- [ ] **Step 3: Implement the profile attachment.**
  In `src/support/github-webhook-hmac-handler.js`, change the registry-path return (the final `return new AuthInfo()...` in `checkAuth`):
  ```js
    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({ user_id: 'github-webhook', target_id: result.id, app_slug: result.appSlug })
      .withType('github_webhook');
  ```
  to:
  ```js
    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({
        user_id: 'github-webhook',
        target_id: result.id,
        app_slug: result.appSlug,
        // Per-target reviewer-gate identity (undefined on the default entry,
        // which falls back to env.GITHUB_REVIEWER_LOGIN in the controller).
        reviewer_login: result.reviewerLogin,
      })
      .withType('github_webhook');
  ```

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/support/github-webhook-hmac-handler.test.js -g 'reviewer_login'
  ```
  Expected: all three `reviewer_login` tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/support/github-webhook-hmac-handler.test.js
  ```
  Expected: all handler tests green (the `TARGETS` fixture now has its required `reviewerLogin`, so `parseTargets` no longer throws inside the handler).

- [ ] **Step 6: Commit.**
  ```bash
  git add src/support/github-webhook-hmac-handler.js test/support/github-webhook-hmac-handler.test.js && git commit -m "feat(github-webhook): attach per-target reviewer_login to auth profile"
  ```

---

### Task 3: `getSkipReason` accepts a 5th `reviewerLogin` param

Add a 5th parameter `reviewerLogin` defaulting to `env.GITHUB_REVIEWER_LOGIN`, and change the expected-reviewer derivation to read from it. Defaulting keeps every existing 3/4-arg caller working: when the param is omitted it resolves to `env.GITHUB_REVIEWER_LOGIN`, which is exactly the value the current code reads inline. `isMysticatTargetedSkip` is not touched.

**Files:**
- `src/utils/github-trigger-rules.js` (modify `getSkipReason` signature at line 32 and the `expectedReviewer` line at line 49; update the JSDoc around lines 22-30)
- `test/utils/github-trigger-rules.test.js` (add a `describe` block for the 5th param inside `describe('getSkipReason', ...)`, after the existing `GITHUB_REVIEWER_LOGIN override` describe, around line 100)

Steps:

- [ ] **Step 1: Write failing test — 5th-arg per-target match, mismatch, back-compat, and `[bot]` tail.**
  Add to `test/utils/github-trigger-rules.test.js`, inside `describe('getSkipReason', ...)`, after the `describe('GITHUB_REVIEWER_LOGIN override', ...)` block:
  ```js
    describe('per-target reviewerLogin (5th arg)', () => {
      const baseReq = {
        pull_request: { draft: false, base: { ref: 'main' } },
        repository: { default_branch: 'main' },
        sender: { type: 'User' },
        action: 'review_requested',
      };

      it('returns null when the requested reviewer equals the 5th-arg reviewerLogin', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot', GITHUB_REVIEWER_LOGIN: 'MysticatBot' };
        const data = { ...baseReq, requested_reviewer: { login: 'emu_reviewer' } };
        expect(getSkipReason(data, 'review_requested', env, 'mysticat-bot', 'emu_reviewer')).to.be.null;
      });

      it('returns the "is not" skip when the requested reviewer differs from the 5th-arg reviewerLogin', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot', GITHUB_REVIEWER_LOGIN: 'MysticatBot' };
        const data = { ...baseReq, requested_reviewer: { login: 'MysticatBot' } };
        const reason = getSkipReason(data, 'review_requested', env, 'mysticat-bot', 'emu_reviewer');
        expect(reason).to.include('MysticatBot');
        expect(reason).to.include('emu_reviewer');
      });

      it('defaults to env.GITHUB_REVIEWER_LOGIN when the 5th arg is omitted (back-compat)', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot', GITHUB_REVIEWER_LOGIN: 'MysticatBot' };
        const data = { ...baseReq, requested_reviewer: { login: 'MysticatBot' } };
        expect(getSkipReason(data, 'review_requested', env)).to.be.null;
      });

      it('falls back to `${appSlug}[bot]` when both the 5th arg and env are unset', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot' };
        const data = { ...baseReq, requested_reviewer: { login: 'mysticat-bot[bot]' } };
        expect(getSkipReason(data, 'review_requested', env, 'mysticat-bot', undefined)).to.be.null;
      });
    });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/utils/github-trigger-rules.test.js -g 'per-target reviewerLogin'
  ```
  Expected: the first two tests FAIL — `returns null when the requested reviewer equals the 5th-arg reviewerLogin` fails because the 5th arg is currently ignored and `expectedReviewer` resolves to `env.GITHUB_REVIEWER_LOGIN` (`MysticatBot`), so `emu_reviewer !== MysticatBot` returns a skip instead of null. The back-compat and `[bot]` tests pass already, but the suite is RED.

- [ ] **Step 3: Implement the 5th param.**
  In `src/utils/github-trigger-rules.js`, change the signature:
  ```js
  export function getSkipReason(data, action, env, appSlug = env.GITHUB_APP_SLUG) {
  ```
  to:
  ```js
  export function getSkipReason(data, action, env, appSlug = env.GITHUB_APP_SLUG, reviewerLogin = env.GITHUB_REVIEWER_LOGIN) {
  ```
  Then change the expected-reviewer line:
  ```js
      const expectedReviewer = env.GITHUB_REVIEWER_LOGIN?.trim() || `${appSlug}[bot]`;
  ```
  to:
  ```js
      const expectedReviewer = reviewerLogin?.trim() || `${appSlug}[bot]`;
  ```
  Update the JSDoc above the function to add the new param (after the `@param {string} [appSlug]` line):
  ```js
   * @param {string} [reviewerLogin] - Per-target reviewer login; defaults to
   *   env.GITHUB_REVIEWER_LOGIN. The requested reviewer must equal this (or
   *   `${appSlug}[bot]` when both are unset) for review_requested to proceed.
  ```

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/utils/github-trigger-rules.test.js -g 'per-target reviewerLogin'
  ```
  Expected: all four 5th-arg tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/utils/github-trigger-rules.test.js
  ```
  Expected: all `github-trigger-rules` tests green — the existing `GITHUB_REVIEWER_LOGIN override`, 4-arg `appSlug` override, and `isMysticatTargetedSkip` drift-guard tests still pass because the omitted 5th arg defaults to `env.GITHUB_REVIEWER_LOGIN` (identical to the old inline read).

- [ ] **Step 6: Commit.**
  ```bash
  git add src/utils/github-trigger-rules.js test/utils/github-trigger-rules.test.js && git commit -m "feat(github-trigger-rules): add per-target reviewerLogin 5th arg to getSkipReason"
  ```

---

### Task 4: Controller resolves and passes `reviewerLogin`

The controller already reads `profile` at `ctx.attributes?.authInfo?.getProfile?.() || {}`. Resolve `reviewerLogin` next to the existing `appSlug` resolution and pass it as the 5th arg to `getSkipReason`. Precedence: `profile.reviewer_login` (set for non-`default` targets) -> `env.GITHUB_REVIEWER_LOGIN` (the `default`/legacy path).

**Files:**
- `src/controllers/webhooks.js` (add the `reviewerLogin` resolution near the `appSlug` line at line 102; change the `getSkipReason` call at line 148)
- `test/controllers/webhooks.test.js` (add tests inside the existing `describe('multi-destination target_id', ...)` block, around line 360)

Steps:

- [ ] **Step 1: Write failing test — per-target `reviewer_login` gates the trigger; legacy falls back to env.**
  In `test/controllers/webhooks.test.js`, add these tests inside the existing `describe('multi-destination target_id', ...)` block (after the `uses the per-target app_slug for the reviewer check` test). They reuse the existing `ghecAuthContext()` helper in that block, which returns a profile of `{ user_id, target_id: 'ghec', app_slug: 'mysticat-bot' }`:
  ```js
    it('uses the per-target reviewer_login from the profile to gate the trigger', async () => {
      // Profile pins reviewer_login=emu_reviewer; requested reviewer matches ->
      // enqueue (not skip), even though env.GITHUB_REVIEWER_LOGIN is unset and
      // app_slug would otherwise expect mysticat-bot[bot].
      const ctx = ghecAuthContext();
      ctx.attributes.authInfo.getProfile = () => ({
        user_id: 'github-webhook', target_id: 'ghec', app_slug: 'mysticat-bot', reviewer_login: 'emu_reviewer',
      });
      ctx.data = { ...ctx.data, requested_reviewer: { login: 'emu_reviewer' } };

      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
    });

    it('skips when the requested reviewer does not match the per-target reviewer_login', async () => {
      const ctx = ghecAuthContext();
      ctx.attributes.authInfo.getProfile = () => ({
        user_id: 'github-webhook', target_id: 'ghec', app_slug: 'mysticat-bot', reviewer_login: 'emu_reviewer',
      });
      ctx.data = { ...ctx.data, requested_reviewer: { login: 'someone-else' } };

      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
    });

    it('falls back to env.GITHUB_REVIEWER_LOGIN when the profile has no reviewer_login (legacy)', async () => {
      controller = buildController({ GITHUB_REVIEWER_LOGIN: 'MysticatBot' });
      const ctx = {
        ...validContext,
        data: { ...validContext.data, requested_reviewer: { login: 'MysticatBot' } },
      };

      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
    });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/controllers/webhooks.test.js -g 'reviewer_login'
  ```
  Expected: `uses the per-target reviewer_login from the profile to gate the trigger` FAILS — the controller does not yet pass `reviewer_login`, so `getSkipReason` defaults to `env.GITHUB_REVIEWER_LOGIN` (unset) and falls to `${appSlug}[bot]` = `mysticat-bot[bot]`, which does not match `emu_reviewer`, returning a 204 skip instead of 202. The mismatch and legacy tests pass already, but the suite is RED.

- [ ] **Step 3: Implement the resolution and pass-through.**
  In `src/controllers/webhooks.js`, locate the `appSlug` resolution:
  ```js
    const profile = ctx.attributes?.authInfo?.getProfile?.() || {};
    const targetId = profile.target_id;
    const appSlug = profile.app_slug || env.GITHUB_APP_SLUG;
  ```
  Add a `reviewerLogin` line directly after `appSlug`:
  ```js
    const profile = ctx.attributes?.authInfo?.getProfile?.() || {};
    const targetId = profile.target_id;
    const appSlug = profile.app_slug || env.GITHUB_APP_SLUG;
    // Per-target reviewer-gate identity. Set for non-default targets by the HMAC
    // handler; the default/legacy path falls back to the global env knob.
    const reviewerLogin = profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN;
  ```
  Then change the `getSkipReason` call:
  ```js
    const skipReason = getSkipReason(data, action, env, appSlug);
  ```
  to:
  ```js
    const skipReason = getSkipReason(data, action, env, appSlug, reviewerLogin);
  ```

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/controllers/webhooks.test.js -g 'reviewer_login'
  ```
  Expected: all three tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/controllers/webhooks.test.js
  ```
  Expected: all `WebhooksController` tests green — the existing `uses the per-target app_slug for the reviewer check` test still passes because its profile has no `reviewer_login`, so `reviewerLogin` is `undefined` and `getSkipReason` falls to `${appSlug}[bot]` = `mysticat-bot[bot]`, matching the test's `mysticat-bot[bot]` requested reviewer.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/controllers/webhooks.js test/controllers/webhooks.test.js && git commit -m "feat(webhooks): resolve per-target reviewer_login and pass to getSkipReason"
  ```

---

## Validation

Final gates — all must pass before the work is considered complete.

- [ ] **Full test suite green.** Run the project's test script (matches `package.json` `"test"`):
  ```bash
  npm test
  ```
  Expected: all suites pass, including the new `reviewerLogin` cases in `github-targets`, `github-webhook-hmac-handler`, `github-trigger-rules`, and `webhooks`. (`npm test` runs `c8 --skip-full mocha --parallel --timeout 10000 -i -g 'Post-Deploy' --spec=test/**/*.test.js --ignore=test/it/**`.)

- [ ] **Lint clean.** Run the project's lint script (matches `package.json` `"lint"`):
  ```bash
  npm run lint
  ```
  Expected: no errors (`eslint .`). Note the `[bot]` literal in the regex is written as `\[bot\]` in source and `\\[bot\\]` inside the throw-message template string; eslint's `no-useless-escape` does not flag the in-regex `\[`/`\]` because they are meaningful inside a character-class-free pattern.

- [ ] **Config example documented.** The `ghec` (non-`default`) `GITHUB_TARGETS` entry MUST include `reviewerLogin`; the `github-public` (`default`) entry omits it and uses the global `env.GITHUB_REVIEWER_LOGIN` fallback. Reference shape (provisioned in Vault `dx_mysticat/{env}/api-service`, per the ADR's Registry/Vault schema):
  ```json
  [
    { "id": "ghec", "match": { "enterpriseSlug": ["<emu-slug>"] }, "appSlug": "<ghec-app-slug>",
      "reviewerLogin": "<emu-reviewer-user>", "webhookSecretEnvVar": "GITHUB_WEBHOOK_SECRET_GHEC" },
    { "id": "github-public", "match": { "default": true }, "appSlug": "mysticat-bot",
      "webhookSecretEnvVar": "GITHUB_WEBHOOK_SECRET" }
  ]
  ```
  The `github-public` entry intentionally has no `reviewerLogin`: at runtime the HMAC handler attaches `reviewer_login: undefined` for it, and the controller resolves `profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN` -> the global `MysticatBot`, preserving today's behaviour. `<emu-reviewer-user>` must match the worker's `targets.ghec.reviewer_login` (cross-tier invariant; enforced operationally, not by the web tier in isolation).
