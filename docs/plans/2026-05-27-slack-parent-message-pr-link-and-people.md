# Web Tier Slack: Linked PR Ref + Requester/Author in the Parent Message - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The enqueued "Review enqueued" parent Slack message links the PR reference (clickable) and names the review requester and PR author.

**Architecture:** The parent message text is built by the pure formatter `enqueuedParentText()` in `src/support/slack/observability-messages.js` and posted by `processGitHubWebhook` in `src/controllers/webhooks.js`. The formatter gains a linked PR ref plus an optional requester/author line; the controller passes the two names from the webhook payload it already holds (`data.sender.login`, `data.pull_request.user.login`). No job-payload contract change.

**Tech Stack:** Node ESM, Mocha + Chai + Sinon + esmock. Spec: `mysticat-architecture/platform/ops/review-orchestrator-slack-observability.md`.

---

## File Structure

- `src/support/slack/observability-messages.js` - Modify: `enqueuedParentText()` - link the PR ref, add an optional requester/author line.
- `src/controllers/webhooks.js:186-194` - Modify: pass `requestedBy`/`author` into `enqueuedParentText(...)`.
- `test/support/slack/observability-messages.test.js` - Modify: update the equality test for the new format; add requester/author tests.
- `test/controllers/webhooks.test.js` - Modify: add a test asserting the posted parent text includes the PR link + requester/author.

Run a single test file with: `npx mocha test/support/slack/observability-messages.test.js`
Run the unit suite with: `npm test`

---

## Task 1: `enqueuedParentText` - linked PR ref + requester/author line

**Files:**
- Modify: `src/support/slack/observability-messages.js`
- Test: `test/support/slack/observability-messages.test.js`

- [ ] **Step 1: Update the existing test and add new ones (failing)**

In `test/support/slack/observability-messages.test.js`, replace the existing `it('formats the enqueued parent message')` body with the new expected format (PR ref is now a link; no requester/author when those args are absent):

```javascript
    it('formats the enqueued parent message with a linked PR ref', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'spacecat-api-service',
        prNumber: 456,
        action: 'review_requested',
        jobType: 'pr-review',
      });
      expect(text).to.equal(
        ':inbox_tray: *Review enqueued* '
        + '<https://github.com/adobe/spacecat-api-service/pull/456|adobe/spacecat-api-service #456>'
        + '\nreview_requested → pr-review',
      );
    });

    it('adds a requester/author line when both are known', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'spacecat-api-service',
        prNumber: 456,
        action: 'review_requested',
        jobType: 'pr-review',
        requestedBy: 'alice',
        author: 'bob',
      });
      expect(text).to.include(
        '<https://github.com/adobe/spacecat-api-service/pull/456|adobe/spacecat-api-service #456>',
      );
      expect(text).to.include('requested by <https://github.com/alice|alice>');
      expect(text).to.include('author <https://github.com/bob|bob>');
    });

    it('omits the people line when neither requester nor author is known', () => {
      const text = enqueuedParentText({
        owner: 'adobe', repo: 'foo', prNumber: 1, action: 'review_requested', jobType: 'pr-review',
      });
      expect(text).to.not.include('requested by');
      expect(text).to.not.include('author');
    });

    it('escapes Slack-special characters in a login', () => {
      const text = enqueuedParentText({
        owner: 'adobe', repo: 'foo', prNumber: 1, action: 'review_requested', jobType: 'pr-review',
        requestedBy: 'a<b>c', author: 'bob',
      });
      expect(text).to.include('a&lt;b&gt;c');   // label escaped
      expect(text).to.not.include('|a<b>c>');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha test/support/slack/observability-messages.test.js`
Expected: FAIL - the existing assertion now expects the link form, which the current code does not produce.

- [ ] **Step 3: Implement the new formatter**

In `src/support/slack/observability-messages.js`, replace the `enqueuedParentText` function (keep `escapeSlack` as-is above it) with:

```javascript
/**
 * Thread-root message for an enqueued review.
 * @param {object} p
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {number|string} p.prNumber
 * @param {string} p.action - GitHub event action (e.g. review_requested)
 * @param {string} p.jobType - mapped job type (e.g. pr-review)
 * @param {string} [p.requestedBy] - GitHub login that requested the review (sender)
 * @param {string} [p.author] - GitHub login of the PR author
 * @returns {string} mrkdwn text
 */
export function enqueuedParentText({
  owner, repo, prNumber, action, jobType, requestedBy, author,
}) {
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const lines = [
    `:inbox_tray: *Review enqueued* <${prUrl}|${escapeSlack(owner)}/${escapeSlack(repo)} #${prNumber}>`,
    `${escapeSlack(action)} → ${escapeSlack(jobType)}`,
  ];
  const people = [];
  if (requestedBy) {
    people.push(`requested by <https://github.com/${encodeURIComponent(requestedBy)}|${escapeSlack(requestedBy)}>`);
  }
  if (author) {
    people.push(`author <https://github.com/${encodeURIComponent(author)}|${escapeSlack(author)}>`);
  }
  if (people.length > 0) {
    lines.push(people.join(' · '));
  }
  return lines.join('\n');
}
```

(The link label is `escapeSlack`d defensively; the URL path segments are GitHub-constrained and URL-safe. Logins are `encodeURIComponent`d for the URL and `escapeSlack`d for the label, so a stray `<`/`>`/`&` cannot break the `<url|label>` markup or inject a mention.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha test/support/slack/observability-messages.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/support/slack/observability-messages.js test/support/slack/observability-messages.test.js
git commit -m "feat(webhooks): link the PR ref and name requester/author in the enqueued Slack parent"
```

---

## Task 2: Pass requester + author from the webhook payload

**Files:**
- Modify: `src/controllers/webhooks.js` (the `enqueuedParentText(...)` call, lines 186-194)
- Test: `test/controllers/webhooks.test.js`

- [ ] **Step 1: Write the failing test**

In `test/controllers/webhooks.test.js`, inside the `describe('Slack observability', ...)` block (the one with `buildObsController`/`postMessage`, around lines 340-403), add:

```javascript
    it('parent links the PR and names the requester and author', async () => {
      const obsController = buildObsController();
      const ctx = {
        ...validContext,
        data: {
          ...validContext.data,
          sender: { ...validContext.data.sender, login: 'alice' },
          pull_request: { ...validContext.data.pull_request, user: { login: 'bob' } },
        },
      };
      const response = await obsController.processGitHubWebhook(ctx);

      expect(response.status).to.equal(202);
      const { text } = postMessage.firstCall.args[0];
      expect(text).to.include('<https://github.com/adobe/spacecat-api-service/pull/');
      expect(text).to.include('requested by <https://github.com/alice|alice>');
      expect(text).to.include('author <https://github.com/bob|bob>');
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx mocha test/controllers/webhooks.test.js -g "names the requester and author"`
Expected: FAIL - the controller does not yet pass `requestedBy`/`author`, so the people line is absent.

- [ ] **Step 3: Implement the call-site change**

In `src/controllers/webhooks.js`, update the `enqueuedParentText({...})` call inside `processGitHubWebhook` (the `slack.postMessage` block around lines 186-194) to pass the two names. `pr` is `data.pull_request` (destructured at line 128):

```javascript
      const threadTs = await slack.postMessage({
        text: enqueuedParentText({
          owner: data.repository.owner.login,
          repo: data.repository.name,
          prNumber: pr.number,
          action,
          jobType,
          requestedBy: data.sender?.login,
          author: pr.user?.login,
        }),
      });
```

(`?.` keeps this defensive: a payload missing `sender`/`pull_request.user` simply omits that part of the line - the formatter drops an absent name.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx mocha test/controllers/webhooks.test.js -g "names the requester and author"`
Expected: PASS. Then run the whole file to confirm the existing parent-post test (which asserts `:inbox_tray:` and `adobe/spacecat-api-service`) still passes: `npx mocha test/controllers/webhooks.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/controllers/webhooks.js test/controllers/webhooks.test.js
git commit -m "feat(webhooks): pass review requester and PR author into the enqueued Slack parent"
```

---

## Task 3: Lint + full unit suite

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: no errors. (Both changed source files keep their existing Apache license header; only function bodies/call args changed.)

- [ ] **Step 2: Full unit suite**

Run: `npm test`
Expected: all green.

---

## Self-Review Notes

- **Spec coverage:** linked PR ref (#1) - Task 1; requester + author (#2) - Tasks 1+2. Reactions and the terminal split are the worker's responsibility and live in the github-service plan, not here.
- **No payload contract change:** `requestedBy`/`author` are read from the webhook `data` the controller already has; nothing new travels through SQS, so no dispatcher (`_ALLOWED_KEYS`) change is required.
- **Backward-compatible formatter:** `enqueuedParentText` still works with the original five args (people line omitted), so any other caller is unaffected; only the message format string changes (covered by the updated equality test).
- **Naming consistency:** the controller passes `requestedBy`/`author`; the formatter's destructured params match exactly.
