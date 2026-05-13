# Configurable Reviewer Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub webhook reviewer login configurable via `GITHUB_REVIEWER_LOGIN` so `aighagent` (plain user) can trigger reviews instead of the `[bot]`-suffixed GitHub App identity.

**Architecture:** Single env var added to `getSkipReason` in the trigger-rules utility. Defaults to `${GITHUB_APP_SLUG}[bot]` when absent — zero behaviour change for existing bot deployments. The controller already validates `GITHUB_APP_SLUG` is set; no change needed there.

**Tech Stack:** Node.js 24.x, Mocha, Chai — no new dependencies.

**Spec:** `docs/specs/2026-05-13-configurable-reviewer-login.md`

---

## File Structure

- Modify: `src/utils/github-trigger-rules.js` — resolve reviewer login from `GITHUB_REVIEWER_LOGIN` env var with `[bot]` fallback
- Modify: `test/utils/github-trigger-rules.test.js` — add tests for `GITHUB_REVIEWER_LOGIN` override path

---

### Task 1: Add failing tests for `GITHUB_REVIEWER_LOGIN` override

**Files:**
- Modify: `test/utils/github-trigger-rules.test.js`

- [ ] **Step 1: Add failing tests**

Open `test/utils/github-trigger-rules.test.js`. After the existing `review_requested trigger` describe block (currently ends around line 58), add a new describe block:

```js
describe('GITHUB_REVIEWER_LOGIN override', () => {
  it('returns null when reviewer matches GITHUB_REVIEWER_LOGIN (plain user)', () => {
    const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev', GITHUB_REVIEWER_LOGIN: 'aighagent' };
    const data = {
      ...baseData,
      action: 'review_requested',
      requested_reviewer: { login: 'aighagent' },
    };
    expect(getSkipReason(data, 'review_requested', env)).to.be.null;
  });

  it('returns skip reason when reviewer does not match GITHUB_REVIEWER_LOGIN', () => {
    const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev', GITHUB_REVIEWER_LOGIN: 'aighagent' };
    const data = {
      ...baseData,
      action: 'review_requested',
      requested_reviewer: { login: 'mysticat-bot-dev[bot]' },
    };
    const reason = getSkipReason(data, 'review_requested', env);
    expect(reason).to.include('mysticat-bot-dev[bot]');
    expect(reason).to.include('aighagent');
  });

  it('falls back to [bot] suffix when GITHUB_REVIEWER_LOGIN is absent', () => {
    const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev' };
    const data = {
      ...baseData,
      action: 'review_requested',
      requested_reviewer: { login: 'mysticat-bot-dev[bot]' },
    };
    expect(getSkipReason(data, 'review_requested', env)).to.be.null;
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx mocha test/utils/github-trigger-rules.test.js
```

Expected: first two new tests fail (the third passes already since it uses the existing `[bot]` path).

---

### Task 2: Update `getSkipReason` to use the configurable login

**Files:**
- Modify: `src/utils/github-trigger-rules.js`

- [ ] **Step 3: Apply the change**

In `src/utils/github-trigger-rules.js`, replace lines 43–48:

```js
  // Invite-based trigger: reviewer must be the app
  if (action === 'review_requested') {
    const reviewer = data.requested_reviewer?.login;
    if (reviewer !== `${appSlug}[bot]`) {
      return `reviewer ${reviewer} is not ${appSlug}`;
    }
  }
```

with:

```js
  // Invite-based trigger: reviewer must be the configured login.
  // GITHUB_REVIEWER_LOGIN overrides the default [bot] suffix — use this
  // when the reviewer is a plain user account (e.g. a shared service account)
  // rather than a GitHub App bot.
  if (action === 'review_requested') {
    const reviewer = data.requested_reviewer?.login;
    const expectedReviewer = env.GITHUB_REVIEWER_LOGIN ?? `${appSlug}[bot]`;
    if (reviewer !== expectedReviewer) {
      return `reviewer ${reviewer} is not ${expectedReviewer}`;
    }
  }
```

- [ ] **Step 4: Run all trigger-rules tests**

```bash
npx mocha test/utils/github-trigger-rules.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass, no regressions.

- [ ] **Step 6: Lint**

```bash
npm run lint
```

Expected: no lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/utils/github-trigger-rules.js test/utils/github-trigger-rules.test.js docs/specs/2026-05-13-configurable-reviewer-login.md docs/plans/2026-05-13-configurable-reviewer-login-impl.md
git commit -m "feat(webhooks): add GITHUB_REVIEWER_LOGIN env var for configurable reviewer identity

Allows the webhook trigger rule to match a plain GitHub user account
(e.g. aighagent) instead of always requiring the [bot]-suffixed GitHub
App identity. Falls back to \`\${GITHUB_APP_SLUG}[bot]\` when the env
var is absent — no behaviour change for existing bot deployments."
```
