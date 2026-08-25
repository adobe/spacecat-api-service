# Slack Observability - Web Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `processGitHubWebhook` post a Slack thread root for every enqueued review (and a standalone note for Mysticat-targeted skips), and carry the resulting `observability` object (`slack_channel` + `slack_thread_ts`) on the SQS job payload so the worker can reply in-thread.

**Architecture:** A dedicated, `chat:write`-only observability bot (separate from the existing broad `elevatedSlackClient`) posts via `@slack/web-api`. A thin best-effort client wrapper never throws - a Slack failure logs a warning and the job still enqueues. The web tier owns the thread root because it is the only component that sees every inbound webhook. Errors/rejections (400/401/500, unmapped events, "not-for-us" skips) are NOT posted to Slack - they stay in CloudWatch/Coralogix.

**Tech Stack:** Node.js >=24, Mocha, Chai, Sinon, esmock, `@slack/web-api@7.15.2` (already a direct dependency), `@adobe/helix-shared-wrap`, `@adobe/spacecat-shared-http-utils`.

**This is repo 2 of 3.** It MUST NOT deploy to an environment until the `spacecat-infrastructure` dispatcher allow-list change (repo 1) is live there - otherwise every dispatched job carries an `observability` key the dispatcher rejects, and reviews DLQ. See `mysticat-architecture/platform/ops/review-orchestrator-slack-observability.md` ("Rollout").

**Source spec:** `mysticat-architecture/platform/ops/review-orchestrator-slack-observability.md` (PR #80, merged). Jira: SITES-42733.

**Predecessor:** `docs/plans/2026-04-28-github-webhook-handler-impl.md` (built the controller this plan extends).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/support/slack/observability-messages.js` | Pure mrkdwn formatters for the parent + standalone messages | **Create** |
| `src/support/slack/observability-client.js` | Best-effort `@slack/web-api` `WebClient` wrapper (`postMessage` never throws) | **Create** |
| `src/utils/github-trigger-rules.js` | Add `isMysticatTargetedSkip(reason)` classifier next to `getSkipReason` | **Modify** |
| `src/controllers/webhooks.js` | Post parent/standalone, attach `observability` to the job payload | **Modify** |
| `test/support/slack/observability-messages.test.js` | Formatter unit tests | **Create** |
| `test/support/slack/observability-client.test.js` | Client wrapper unit tests (mock `@slack/web-api`) | **Create** |
| `test/utils/github-trigger-rules.test.js` | Append classifier + drift-consistency tests | **Modify** |
| `test/controllers/webhooks.test.js` | Append an `observability` describe block (esmock the client) | **Modify** |

**No `src/index.js` change.** `WebhooksController` is already instantiated with `context` at `src/index.js:262`, and `context.env` already flows in. The two new env vars (`MYSTICAT_OBSERVABILITY_SLACK_TOKEN`, `MYSTICAT_OBSERVABILITY_SLACK_CHANNEL`) are read straight from `env`, exactly like `MYSTICAT_GITHUB_JOBS_QUEUE_URL`.

**No OpenAPI change.** Response codes are unchanged (202/204/400/401/500). Slack posting is a side effect, not an API contract change.

**Why two new modules, not one:** the formatters are pure (used real in every test); the client is side-effectful (stubbed in controller tests via esmock). Separating them keeps the esmock boundary clean - the controller test stubs only `observability-client.js` and exercises the real formatters.

**Em-dash note:** the merged spec's message catalog uses an em-dash separator (` — `). This plan uses a plain hyphen (` - `) in the literal message strings to comply with the workspace no-em-dash rule. The Unicode arrow (`→`) in the parent message is kept as specced (it is not an em-dash).

---

## Task 1: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Verify clean state and branch from origin/main**

```bash
cd /Users/dj/adobe/github/adobe/spacecat-api-service
git fetch origin main
git status            # working tree must be clean
git checkout -b feat/slack-observability origin/main
```

- [ ] **Step 2: Confirm branch**

Run: `git branch --show-current`
Expected: `feat/slack-observability`

---

## Task 2: Add `isMysticatTargetedSkip` classifier (TDD)

**Files:**
- Modify: `src/utils/github-trigger-rules.js`
- Modify: `test/utils/github-trigger-rules.test.js`

**Why:** `getSkipReason` returns a flat string for several distinct cases. Only skips where Mysticat *was* the requested reviewer (`draft PR`, `bot sender`, `non-default branch: <ref>`) should post a standalone Slack note. Foreign-reviewer / unsupported-action / auto-trigger skips stay silent (they flood otherwise). This classifier encodes that distinction, co-located with `getSkipReason` so the two cannot drift unnoticed.

- [ ] **Step 1: Write the failing tests**

Append to `test/utils/github-trigger-rules.test.js`. First add the import - change the existing import line:

```javascript
import { getSkipReason, EVENT_JOB_MAP } from '../../src/utils/github-trigger-rules.js';
```
to:
```javascript
import { getSkipReason, EVENT_JOB_MAP, isMysticatTargetedSkip } from '../../src/utils/github-trigger-rules.js';
```

Then append this `describe` block inside the top-level `describe('github-trigger-rules', ...)` (before its closing `});`):

```javascript
  describe('isMysticatTargetedSkip', () => {
    it('returns true for draft PR', () => {
      expect(isMysticatTargetedSkip('draft PR')).to.be.true;
    });

    it('returns true for bot sender', () => {
      expect(isMysticatTargetedSkip('bot sender')).to.be.true;
    });

    it('returns true for non-default branch (with ref suffix)', () => {
      expect(isMysticatTargetedSkip('non-default branch: release/v2')).to.be.true;
    });

    it('returns false for foreign reviewer', () => {
      expect(isMysticatTargetedSkip('reviewer some-human is not mysticat[bot]')).to.be.false;
    });

    it('returns false for unsupported action', () => {
      expect(isMysticatTargetedSkip('unsupported action: closed')).to.be.false;
    });

    it('returns false for auto-trigger', () => {
      expect(isMysticatTargetedSkip('auto-trigger not yet supported: opened')).to.be.false;
    });

    // Drift guard: the classifier must agree with what getSkipReason actually emits.
    describe('stays in lockstep with getSkipReason', () => {
      const env = { GITHUB_APP_SLUG: 'mysticat' };
      const base = {
        action: 'review_requested',
        requested_reviewer: { login: 'mysticat[bot]' },
        repository: { default_branch: 'main' },
        sender: { type: 'User' },
        pull_request: { draft: false, base: { ref: 'main' } },
      };

      it('classifies the draft-PR reason as postable', () => {
        const data = { ...base, pull_request: { draft: true, base: { ref: 'main' } } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the bot-sender reason as postable', () => {
        const data = { ...base, sender: { type: 'Bot' } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the non-default-branch reason as postable', () => {
        const data = { ...base, pull_request: { draft: false, base: { ref: 'release/v2' } } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the foreign-reviewer reason as silent', () => {
        const data = { ...base, requested_reviewer: { login: 'some-human' } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx mocha test/utils/github-trigger-rules.test.js
```
Expected: FAIL - `isMysticatTargetedSkip is not a function`.

- [ ] **Step 3: Implement the classifier**

In `src/utils/github-trigger-rules.js`, append after `getSkipReason` (before end of file):

```javascript
/**
 * Classifies a skip reason from getSkipReason as one that should post a
 * standalone Slack observability note. Only skips where Mysticat WAS the
 * requested reviewer (draft PR / bot sender / non-default branch) are
 * interesting; foreign-reviewer, unsupported-action, and auto-trigger skips
 * stay silent to avoid flooding the channel.
 *
 * Keep in lockstep with getSkipReason: these literals/prefix mirror the strings
 * it returns AFTER the reviewer check passes. The drift-guard tests in
 * test/utils/github-trigger-rules.test.js fail if the two diverge.
 *
 * @param {string} reason - The skip reason string returned by getSkipReason
 * @returns {boolean} true if a standalone Slack note should be posted
 */
export function isMysticatTargetedSkip(reason) {
  return reason === 'draft PR'
    || reason === 'bot sender'
    || reason.startsWith('non-default branch:');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx mocha test/utils/github-trigger-rules.test.js
```
Expected: all tests pass (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/utils/github-trigger-rules.js test/utils/github-trigger-rules.test.js
git commit -m "feat: classify Mysticat-targeted skips for Slack observability

isMysticatTargetedSkip(reason) marks draft/bot/non-default-branch skips
as postable; foreign-reviewer/unsupported-action skips stay silent.
Drift-guard tests assert it agrees with getSkipReason.

Ref: SITES-42733"
```

---

## Task 3: Create the message formatters (TDD)

**Files:**
- Create: `src/support/slack/observability-messages.js`
- Create: `test/support/slack/observability-messages.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/support/slack/observability-messages.test.js`:

```javascript
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

import { expect } from 'chai';
import {
  enqueuedParentText,
  skippedStandaloneText,
} from '../../../src/support/slack/observability-messages.js';

describe('observability-messages', () => {
  describe('enqueuedParentText', () => {
    it('formats the enqueued parent message', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'spacecat-api-service',
        prNumber: 456,
        action: 'review_requested',
        jobType: 'pr-review',
      });
      expect(text).to.equal(
        ':inbox_tray: *Review enqueued*  `adobe/spacecat-api-service` #456\nreview_requested → pr-review',
      );
    });
  });

  describe('skippedStandaloneText', () => {
    it('formats the standalone skip message with reason', () => {
      const text = skippedStandaloneText({
        owner: 'adobe',
        repo: 'foo',
        prNumber: 12,
        reason: 'draft PR',
      });
      expect(text).to.equal(':fast_forward: *Skipped*  `adobe/foo` #12 - draft PR');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx mocha test/support/slack/observability-messages.test.js
```
Expected: FAIL - module not found.

- [ ] **Step 3: Write the implementation**

Create `src/support/slack/observability-messages.js`:

```javascript
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

/**
 * Pure mrkdwn formatters for the web tier's Slack observability messages.
 * The web tier only ever posts top-level messages (thread roots + standalones);
 * the worker formats and posts the threaded replies in mysticat-github-service.
 */

/**
 * Thread-root message for an enqueued review.
 * @param {object} p
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {number|string} p.prNumber
 * @param {string} p.action - GitHub event action (e.g. review_requested)
 * @param {string} p.jobType - mapped job type (e.g. pr-review)
 * @returns {string} mrkdwn text
 */
export function enqueuedParentText({
  owner, repo, prNumber, action, jobType,
}) {
  return `:inbox_tray: *Review enqueued*  \`${owner}/${repo}\` #${prNumber}\n${action} → ${jobType}`;
}

/**
 * Standalone message for a Mysticat-targeted skip (draft / bot / non-default branch).
 * @param {object} p
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {number|string} p.prNumber
 * @param {string} p.reason - skip reason from getSkipReason
 * @returns {string} mrkdwn text
 */
export function skippedStandaloneText({
  owner, repo, prNumber, reason,
}) {
  return `:fast_forward: *Skipped*  \`${owner}/${repo}\` #${prNumber} - ${reason}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx mocha test/support/slack/observability-messages.test.js
```
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/support/slack/observability-messages.js test/support/slack/observability-messages.test.js
git commit -m "feat: add Slack observability message formatters

Pure mrkdwn formatters for the enqueued thread-root and the standalone
skip note. Hyphen separator (workspace no-em-dash rule).

Ref: SITES-42733"
```

---

## Task 4: Create the best-effort Slack client wrapper (TDD)

**Files:**
- Create: `src/support/slack/observability-client.js`
- Create: `test/support/slack/observability-client.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/support/slack/observability-client.test.js`:

```javascript
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

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('observability-client', () => {
  let sandbox;
  let log;
  let postMessageStub;
  let createObservabilitySlackClient;

  async function load() {
    return esmock('../../../src/support/slack/observability-client.js', {
      '@slack/web-api': {
        WebClient: class {
          constructor() {
            this.chat = { postMessage: postMessageStub };
          }
        },
      },
    });
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    log = { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() };
    postMessageStub = sandbox.stub().resolves({ ok: true, ts: '1716200000.000300' });
    ({ createObservabilitySlackClient } = await load());
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('is disabled when no token is provided', () => {
    const client = createObservabilitySlackClient({ token: undefined, log });
    expect(client.enabled).to.be.false;
  });

  it('is enabled when a token is provided', () => {
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    expect(client.enabled).to.be.true;
  });

  it('returns the message ts on a successful post', async () => {
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.equal('1716200000.000300');
    expect(postMessageStub.calledOnceWithExactly({ channel: 'C123', text: 'hello', attachments: undefined })).to.be.true;
  });

  it('returns null and logs a warning when the post throws (never raises)', async () => {
    postMessageStub.rejects(new Error('slack down'));
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.be.null;
    expect(log.warn.calledOnce).to.be.true;
  });

  it('returns null without calling Slack when channel is missing', async () => {
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: undefined, text: 'hello' });
    expect(ts).to.be.null;
    expect(postMessageStub.called).to.be.false;
  });

  it('returns null without calling Slack when disabled (no token)', async () => {
    const client = createObservabilitySlackClient({ token: undefined, log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.be.null;
    expect(postMessageStub.called).to.be.false;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx mocha test/support/slack/observability-client.test.js
```
Expected: FAIL - module not found.

- [ ] **Step 3: Write the implementation**

Create `src/support/slack/observability-client.js`:

```javascript
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

import { WebClient } from '@slack/web-api';

/**
 * Creates a best-effort Slack client for review observability.
 *
 * Uses a dedicated chat:write-only bot token (NOT the broad elevatedSlackClient).
 * postMessage NEVER throws: a Slack failure must not block or fail a webhook.
 * It returns the posted message `ts` (string) on success, or null on any failure,
 * when unconfigured, or when no channel is given.
 *
 * @param {object} p
 * @param {string|undefined} p.token - bot token; absent => Slack disabled
 * @param {object} p.log - logger with .warn
 * @returns {{ postMessage: function, enabled: boolean }}
 */
export function createObservabilitySlackClient({ token, log }) {
  const client = token ? new WebClient(token) : null;

  async function postMessage({ channel, text, attachments }) {
    if (!client || !channel) {
      return null;
    }
    try {
      const result = await client.chat.postMessage({ channel, text, attachments });
      return result?.ts ?? null;
    } catch (e) {
      log.warn('Observability Slack post failed (non-fatal)', { error: e.message });
      return null;
    }
  }

  return { postMessage, enabled: Boolean(client) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx mocha test/support/slack/observability-client.test.js
```
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/support/slack/observability-client.js test/support/slack/observability-client.test.js
git commit -m "feat: add best-effort observability Slack client

Dedicated chat:write-only WebClient wrapper. postMessage never throws;
returns the message ts on success, null otherwise. Disabled when no token.

Ref: SITES-42733"
```

---

## Task 5: Wire posting + `observability` payload into the controller (TDD)

**Files:**
- Modify: `src/controllers/webhooks.js`
- Modify: `test/controllers/webhooks.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/controllers/webhooks.test.js`, add esmock to the imports. Change the top imports:

```javascript
import { expect } from 'chai';
import sinon from 'sinon';
import WebhooksController from '../../src/controllers/webhooks.js';
```
to:
```javascript
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import WebhooksController from '../../src/controllers/webhooks.js';
```

Then append this `describe` block inside the top-level `describe('WebhooksController', ...)` (before its closing `});`). It builds an esmock'd controller whose Slack client is a stub, and uses the channel env var to enable posting:

```javascript
  describe('Slack observability', () => {
    const channel = 'C0123ABCDEF';
    // Module-scoped: the mocked client factory's postMessage delegates to this,
    // and each test reassigns it (default success in beforeEach) before posting.
    let postMessage;
    let MockedController;

    before(async () => {
      const mod = await esmock('../../src/controllers/webhooks.js', {
        '../../src/support/slack/observability-client.js': {
          createObservabilitySlackClient: ({ token }) => ({
            enabled: Boolean(token),
            postMessage: (...args) => postMessage(...args),
          }),
        },
      });
      // esmock returns the module namespace; the controller is the default export.
      MockedController = mod.default;
    });

    beforeEach(() => {
      // Default: a successful parent post returning a thread ts (string).
      postMessage = sandbox.stub().resolves('1716200000.000300');
    });

    function buildObsController(envOverrides = {}) {
      const context = {
        sqs: mockSqs,
        log: mockLog,
        env: {
          MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl,
          GITHUB_APP_SLUG: 'mysticat',
          MYSTICAT_OBSERVABILITY_SLACK_TOKEN: 'xoxb-test',
          MYSTICAT_OBSERVABILITY_SLACK_CHANNEL: channel,
          ...envOverrides,
        },
      };
      return MockedController(context);
    }

    it('posts the parent and includes observability with thread_ts on enqueue', async () => {
      const controller = buildObsController();
      const response = await controller.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);
      // parent posted before enqueue
      expect(postMessage.calledOnce).to.be.true;
      const postArg = postMessage.firstCall.args[0];
      expect(postArg.channel).to.equal(channel);
      expect(postArg.text).to.include(':inbox_tray:');
      expect(postArg.text).to.include('adobe/spacecat-api-service');

      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.observability).to.deep.equal({
        slack_channel: channel,
        slack_thread_ts: '1716200000.000300',
      });
    });

    it('still enqueues with channel-only observability when the parent post fails', async () => {
      postMessage = sandbox.stub().resolves(null); // parent post failed (no ts)
      const controller = buildObsController();
      const response = await controller.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.observability).to.deep.equal({ slack_channel: channel });
      expect(payload.observability.slack_thread_ts).to.be.undefined;
    });

    it('posts a standalone note for a Mysticat-targeted skip (draft PR), no enqueue', async () => {
      const controller = buildObsController();
      const ctx = {
        ...validContext,
        data: {
          ...validContext.data,
          pull_request: { ...validContext.data.pull_request, draft: true },
        },
      };
      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
      expect(postMessage.calledOnce).to.be.true;
      expect(postMessage.firstCall.args[0].text).to.include(':fast_forward:');
      expect(postMessage.firstCall.args[0].text).to.include('draft PR');
    });

    it('does NOT post for a foreign-reviewer skip', async () => {
      const controller = buildObsController();
      const ctx = {
        ...validContext,
        data: {
          ...validContext.data,
          requested_reviewer: { login: 'some-human' },
        },
      };
      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
      expect(postMessage.called).to.be.false;
    });

    it('omits observability entirely when Slack channel is not configured', async () => {
      const controller = buildObsController({ MYSTICAT_OBSERVABILITY_SLACK_CHANNEL: undefined });
      const response = await controller.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);
      expect(postMessage.called).to.be.false;
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.observability).to.be.undefined;
    });
  });
```

> **Implementation note for the executor:** the esmock wiring above stubs `createObservabilitySlackClient` so the controller receives a fake `postMessage`. Keep the controller's call sites (Step 3) exactly as written so `postMessage` is invoked with a single `{ channel, text, attachments }` object - the assertions read `firstCall.args[0]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx mocha test/controllers/webhooks.test.js
```
Expected: the new `Slack observability` tests FAIL (controller does not yet post or attach `observability`); the existing tests still PASS.

- [ ] **Step 3: Modify the controller**

In `src/controllers/webhooks.js`, update the imports. Change:

```javascript
import {
  accepted, noContent, badRequest, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import wrap from '@adobe/helix-shared-wrap';
import { getSkipReason, EVENT_JOB_MAP } from '../utils/github-trigger-rules.js';
```
to:
```javascript
import {
  accepted, noContent, badRequest, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import wrap from '@adobe/helix-shared-wrap';
import { getSkipReason, EVENT_JOB_MAP, isMysticatTargetedSkip } from '../utils/github-trigger-rules.js';
import { createObservabilitySlackClient } from '../support/slack/observability-client.js';
import { enqueuedParentText, skippedStandaloneText } from '../support/slack/observability-messages.js';
```

In the `WebhooksController` factory, after `const workspaceRepos = getWorkspaceRepos(env, log);`, add the Slack client + channel:

```javascript
function WebhooksController(context) {
  const { sqs, log, env } = context;
  const workspaceRepos = getWorkspaceRepos(env, log);
  const slackChannel = env.MYSTICAT_OBSERVABILITY_SLACK_CHANNEL;
  const slack = createObservabilitySlackClient({
    token: env.MYSTICAT_OBSERVABILITY_SLACK_TOKEN,
    log,
  });
```

In the skip branch, post a standalone note for Mysticat-targeted skips. Change:

```javascript
    const skipReason = getSkipReason(data, action, env);
    if (skipReason) {
      log.info('Skipping webhook', {
        skipReason,
        deliveryId,
        event,
        action,
        owner: data.repository.owner.login,
        repo: data.repository.name,
        prNumber: pr.number,
      });
      return noContent();
    }
```
to:
```javascript
    const skipReason = getSkipReason(data, action, env);
    if (skipReason) {
      log.info('Skipping webhook', {
        skipReason,
        deliveryId,
        event,
        action,
        owner: data.repository.owner.login,
        repo: data.repository.name,
        prNumber: pr.number,
      });
      // Post a standalone Slack note only when Mysticat WAS the requested
      // reviewer (draft / bot / non-default branch). Foreign-reviewer and
      // unsupported-action skips stay silent to avoid channel flooding.
      // Best-effort: postMessage never throws.
      if (slack.enabled && slackChannel && isMysticatTargetedSkip(skipReason)) {
        await slack.postMessage({
          channel: slackChannel,
          text: skippedStandaloneText({
            owner: data.repository.owner.login,
            repo: data.repository.name,
            prNumber: pr.number,
            reason: skipReason,
          }),
        });
      }
      return noContent();
    }
```

In the enqueue branch, post the parent BEFORE building/sending the payload, and attach `observability`. Change:

```javascript
    // Build and enqueue job payload
    const jobPayload = {
      owner: data.repository.owner.login,
      repo: data.repository.name,
      event_type: event,
      event_action: action,
      event_ref: String(pr.number),
      installation_id: String(data.installation.id),
      delivery_id: deliveryId,
      job_type: jobType,
      workspace_repos: workspaceRepos,
      retry_count: 0,
    };

    const queueUrl = env.MYSTICAT_GITHUB_JOBS_QUEUE_URL;
    await sqs.sendMessage(queueUrl, jobPayload);
```
to:
```javascript
    // Post the Slack thread root BEFORE enqueue (ordering invariant: parent
    // before enqueue, never after). Best-effort - a Slack failure must never
    // block the review, so we still enqueue. When the post fails we send
    // slack_channel only (no thread_ts); the worker then degrades to a
    // standalone message. When Slack is unconfigured we omit observability.
    let observability;
    if (slack.enabled && slackChannel) {
      const threadTs = await slack.postMessage({
        channel: slackChannel,
        text: enqueuedParentText({
          owner: data.repository.owner.login,
          repo: data.repository.name,
          prNumber: pr.number,
          action,
          jobType,
        }),
      });
      observability = threadTs
        ? { slack_channel: slackChannel, slack_thread_ts: threadTs }
        : { slack_channel: slackChannel };
    }

    // Build and enqueue job payload
    const jobPayload = {
      owner: data.repository.owner.login,
      repo: data.repository.name,
      event_type: event,
      event_action: action,
      event_ref: String(pr.number),
      installation_id: String(data.installation.id),
      delivery_id: deliveryId,
      job_type: jobType,
      workspace_repos: workspaceRepos,
      retry_count: 0,
      ...(observability ? { observability } : {}),
    };

    const queueUrl = env.MYSTICAT_GITHUB_JOBS_QUEUE_URL;
    await sqs.sendMessage(queueUrl, jobPayload);
```

- [ ] **Step 4: Run the controller tests to verify they pass**

Run:
```bash
npx mocha test/controllers/webhooks.test.js
```
Expected: all tests pass (existing + new `Slack observability` block).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/webhooks.js test/controllers/webhooks.test.js
git commit -m "feat: post Slack thread root and carry observability on webhook enqueue

The web tier posts a thread-root message on enqueue and a standalone note
for Mysticat-targeted skips, then attaches observability { slack_channel,
slack_thread_ts } to the SQS job payload. Best-effort: a Slack failure
still enqueues (channel-only observability). Errors/foreign skips stay
out of Slack (CloudWatch/Coralogix).

Ref: SITES-42733"
```

---

## Task 6: Full suite, lint, and docs

**Files:** none (validation + git)

- [ ] **Step 1: Run the full unit suite**

Run:
```bash
npm test
```
Expected: all tests pass, no regressions.

- [ ] **Step 2: Run lint**

Run:
```bash
npm run lint
```
Expected: no errors. (Common pitfalls: missing copyright header on new `src/` files, missing `.js` import extensions, import ordering. Fix any reported.)

- [ ] **Step 3: Confirm docs still build (no contract change, but verify nothing broke)**

Run:
```bash
npm run docs:build
```
Expected: build succeeds.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/slack-observability
```
Open the PR titled `feat: GitHub review Slack observability (web tier)`. In the body, note:
- Depends on the spacecat-infrastructure dispatcher allow-list change (repo 1) being deployed first in each environment.
- Followed by mysticat-github-service worker replies (repo 3).

---

## Provisioning (operational - per environment)

These steps configure the dedicated bot and env vars. They are operational (the `secrets/` dir is gitignored), not code commits. Do them before deploying to each environment.

- [ ] **Step 1: Create the Slack app (shared with the worker - do once)**

Create a Slack app "Mysticat Observability" from an app manifest with a single bot scope `chat:write` (explicitly NOT `chat:write.public`). Install to the workspace and capture the bot token (`xoxb-...`). The same token is used by both the web tier and the worker.

- [ ] **Step 2: Create/choose the per-env channel and invite the bot**

| Environment | Channel |
|-------------|---------|
| prod | `#mysticat-reviews` |
| stage | `#mysticat-stage` |
| dev | `#mysticat-dev` |

Invite the bot to the channel and capture each channel's ID (`C...`).

- [ ] **Step 3: Add the two env vars to the api-service deploy-secret store**

Add to the api-service secret mechanism used by `npm run deploy-secrets` (`hedy --aws-update-secrets`, the same store that provides `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_SLUG`), per environment:
- `MYSTICAT_OBSERVABILITY_SLACK_TOKEN` = the `xoxb-...` bot token (secret)
- `MYSTICAT_OBSERVABILITY_SLACK_CHANNEL` = the per-env channel ID

> Confirm the exact per-environment secret file in this repo before editing (e.g. the file referenced by `npm run deploy-secrets`); do not commit it - `secrets/` is gitignored.

- [ ] **Step 4: Deploy and verify**

After the dispatcher change (repo 1) is live in the target env, deploy the api-service (`npm run deploy-dev` / `deploy-stage` / `deploy`). Trigger a `review_requested` for Mysticat on a test PR and confirm a thread-root message appears in the channel and the worker (repo 3) replies in-thread.

---

## Final validation gate (before merge)

- [ ] `npm test` green; `npm run lint` clean; `npm run docs:build` succeeds.
- [ ] Existing webhooks tests unchanged in behavior (no token configured => no Slack, no `observability` key).
- [ ] PR CI green. Do not merge with any red check without asking.
- [ ] **Deploy ordering confirmed:** dispatcher allow-list (repo 1) is live in the target environment before this web tier deploy emits `observability`.

## Spec coverage check

| Spec requirement (Web Tier / Data Contract / Security / Testing) | Task |
|---|---|
| Post parent (thread root) on enqueue, before SQS send | Task 5 |
| Attach `observability = { slack_channel, slack_thread_ts }` to job payload | Task 5 |
| Parent-post failure still enqueues (channel-only, no thread_ts) | Task 5 |
| Standalone post for Mysticat-targeted skips (draft/bot/non-default) only | Tasks 2, 5 |
| Foreign-reviewer / unsupported-action / 400 / 401 / 500 / unmapped => no Slack | Task 5 (+ unchanged control flow) |
| Dedicated `chat:write`-only bot, separate from `elevatedSlackClient` | Tasks 4, Provisioning |
| Best-effort: Slack never blocks/fails the webhook (`postMessage` never throws) | Task 4 |
| `thread_ts` stays a string end to end | Tasks 4, 5 (stub returns string; passed through verbatim) |
| New env vars via the deploy-secret store | Provisioning |
| Unit tests: parent posted then enqueue; parent-fail still enqueues; standalone skip posts; foreign skip / errors post nothing | Task 5 |
