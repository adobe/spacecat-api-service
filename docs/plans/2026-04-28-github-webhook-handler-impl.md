# GitHub Webhook Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `POST /webhooks/github` endpoint that receives GitHub App webhook events, validates HMAC signatures, applies trigger rules, and enqueues jobs to SQS.

**Architecture:** Custom `GitHubWebhookHmacHandler` auth handler plugged into the existing `authHandlers` array validates HMAC-SHA256 signatures. A factory-function controller applies trigger rules from the webhook payload (no GitHub API calls) and enqueues accepted events to SQS. Trigger rules and event-to-job-type mapping are extracted to a utility module for testability.

**Tech Stack:** Node.js 24.x, Mocha, Chai, Sinon, esmock, `@adobe/helix-shared-wrap`, `@adobe/spacecat-shared-http-utils` (AbstractHandler, AuthInfo), OpenAPI 3.1.

**Spec:** `docs/specs/2026-04-22-github-webhook-handler.md` (authoritative — all code in this plan is derived from that spec)

---

## File Structure

### Phase 1 (OpenAPI contract)

- Create: `docs/openapi/webhooks-api.yaml` — endpoint definition for `POST /webhooks/github`
- Modify: `docs/openapi/schemas.yaml` — add `WebhookAccepted` and `WebhookUnauthorized` schemas
- Modify: `docs/openapi/api.yaml` — add `/webhooks/github` path reference

### Phase 2 (Implementation)

- Create: `src/support/github-webhook-hmac-handler.js` — HMAC auth handler
- Create: `src/utils/github-trigger-rules.js` — `EVENT_JOB_MAP` constant + `getSkipReason` function
- Create: `src/controllers/webhooks.js` — controller with `processGitHubWebhook`
- Modify: `src/routes/index.js` — add route definition
- Modify: `src/index.js` — register auth handler + controller wiring
- Create: `test/support/github-webhook-hmac-handler.test.js` — auth handler unit tests
- Create: `test/utils/github-trigger-rules.test.js` — trigger rules unit tests
- Create: `test/controllers/webhooks.test.js` — controller unit tests

---

## Cross-repo Contract: Dispatcher `_ALLOWED_KEYS` Alignment

The Dispatcher Lambda (deployed via spacecat-infrastructure PR #469) enforces a strict key whitelist on job payloads:

```python
_ALLOWED_KEYS = frozenset(("job_type", "owner", "repo", "event_ref", "retry_count", "source_task_arn"))
```

The webhook handler's job payload includes 5 additional fields not in this whitelist: `event_type`, `event_action`, `installation_id`, `delivery_id`, `workspace_repos`. Messages with these fields will be **rejected by the Dispatcher** and land in the DLQ.

**Resolution (option A — recommended):** Expand the Dispatcher's `_ALLOWED_KEYS` in a companion PR on `adobe/spacecat-infrastructure` to include:

```python
_ALLOWED_KEYS = frozenset((
    "job_type", "owner", "repo", "event_ref", "retry_count", "source_task_arn",
    "event_type", "event_action", "installation_id", "delivery_id", "workspace_repos",
))
```

Add validation: `workspace_repos` is an array of `namespace/repo` strings, `installation_id` is a numeric string.

**Deployment order:** The Dispatcher whitelist expansion must be deployed **before** the webhook handler goes live. The API Gateway feature flag (`enable_github_webhook_route`) should only be enabled after both the Dispatcher update and the webhook handler are deployed.

---

## Phase 1: OpenAPI Contract

### Task 1: Create feature branch

**Files:**
- None (git operation only)

- [ ] **Step 1: Create and switch to the feature branch**

```bash
git checkout -b feat/github-webhook-handler origin/main
```

- [ ] **Step 2: Verify branch**

Run: `git branch --show-current`
Expected: `feat/github-webhook-handler`

---

### Task 2: Create webhooks-api.yaml

**Files:**
- Create: `docs/openapi/webhooks-api.yaml`

- [ ] **Step 1: Create the OpenAPI path definition**

Create `docs/openapi/webhooks-api.yaml` with the following content (verbatim from spec):

```yaml
github-webhook:
  post:
    tags:
      - hooks
    summary: Receive GitHub App webhook events
    description: |
      HMAC-SHA256 authenticated endpoint for receiving GitHub App webhook events.
      Validates the webhook signature, applies trigger rules, and enqueues
      accepted events to the Mysticat GitHub Service jobs queue.

      Authentication is performed via GitHub's HMAC-SHA256 webhook signature
      in the X-Hub-Signature-256 header, using a custom auth handler that
      plugs into the existing authHandlers array (not the standard JWT/IMS/API key flow).

      Trigger rules are applied from the webhook payload only (no GitHub API
      calls). On-demand triggers (review_requested, labeled) are accepted.
      Auto-trigger events (opened, ready_for_review) return 204 until
      per-repo configuration support is implemented in Phase 3.

      Supported events: pull_request. All other subscribed events (issue_comment)
      return 204 silently.
    operationId: processGitHubWebhook
    parameters:
      - name: X-Hub-Signature-256
        in: header
        required: true
        description: HMAC-SHA256 signature of the request body (format sha256=<hex>)
        schema:
          type: string
      - name: X-GitHub-Event
        in: header
        required: true
        description: GitHub event type (e.g. pull_request)
        schema:
          type: string
      - name: X-GitHub-Delivery
        in: header
        required: false
        description: Unique delivery GUID for tracing
        schema:
          type: string
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            description: GitHub webhook payload (schema owned by GitHub, not validated beyond required fields)
    responses:
      '202':
        description: Event accepted and enqueued for processing
        content:
          application/json:
            schema:
              $ref: './schemas.yaml#/WebhookAccepted'
      '204':
        description: Valid event but skipped (unsupported action, draft PR, bot author, etc.)
      '400':
        $ref: './responses.yaml#/400'
      '401':
        description: Invalid or missing HMAC signature
        content:
          application/json:
            schema:
              $ref: './schemas.yaml#/WebhookUnauthorized'
      '500':
        $ref: './responses.yaml#/500'
    security: []
```

---

### Task 3: Add schemas to schemas.yaml

**Files:**
- Modify: `docs/openapi/schemas.yaml` (append at end of file)

- [ ] **Step 1: Add WebhookAccepted and WebhookUnauthorized schemas**

Append to the end of `docs/openapi/schemas.yaml`:

```yaml
WebhookAccepted:
  type: object
  properties:
    status:
      type: string
      enum: [accepted]
  required: [status]
WebhookUnauthorized:
  type: object
  properties:
    message:
      type: string
  required: [message]
```

---

### Task 4: Add path reference to api.yaml

**Files:**
- Modify: `docs/openapi/api.yaml` (paths section, between `/hooks/` and `/organizations`)

- [ ] **Step 1: Add the /webhooks/github path**

In `docs/openapi/api.yaml`, add the following line in the `paths:` section after the `/hooks/site-integration/analytics/{hookSecret}:` entry (around line 113) and before `/organizations:`:

```yaml
  /webhooks/github:
    $ref: './webhooks-api.yaml#/github-webhook'
```

---

### Task 5: Validate and commit Phase 1

**Files:**
- None (validation + git)

- [ ] **Step 1: Run OpenAPI lint**

Run: `npm run docs:lint`
Expected: No errors. Warnings are acceptable.

- [ ] **Step 2: Run OpenAPI build**

Run: `npm run docs:build`
Expected: Build succeeds.

- [ ] **Step 3: Commit Phase 1**

```bash
git add docs/openapi/webhooks-api.yaml docs/openapi/schemas.yaml docs/openapi/api.yaml
git commit -m "feat: add OpenAPI contract for POST /webhooks/github

Phase 1 of the GitHub webhook handler implementation.
Defines the HMAC-authenticated endpoint contract under the existing
hooks tag. Schemas: WebhookAccepted, WebhookUnauthorized.

Ref: SITES-42733"
```

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin feat/github-webhook-handler
```

Create PR with title: `feat: GitHub webhook handler (POST /webhooks/github)`

Include in the PR body that Phase 1 (OpenAPI contract) is ready for review, Phase 2 (implementation) will follow after approval.

---

## Phase 2: Implementation

> **Do not start Phase 2 until Phase 1 is approved by the team.**

### Task 6: Verify request.text() caching behavior

**Files:**
- None (investigation only)

The spec's Implementation Note requires verifying that `request.text()` returns the cached body after `bodyData` has consumed the stream. This must be confirmed before writing the HMAC handler.

- [ ] **Step 1: Check @adobe/helix-universal Request implementation**

Read the Request class in `node_modules/@adobe/helix-universal/` to confirm body caching. Look for:
- Does the Request constructor store the body buffer?
- Does `.text()` return from cache if the body was already consumed?

Alternatively, confirm via precedent: `src/controllers/llmo/llmo.js` reads `context.request.arrayBuffer()` after `bodyData` has run.

- [ ] **Step 2: Document finding**

If `request.text()` works: proceed as designed.
If it does NOT work: implement option (b) from the spec — add a `rawBodyCapture` wrapper in `src/index.js` between `bodyData` and `authWrapper` in the `.with()` chain.

---

### Task 7: Create github-trigger-rules.js with tests (TDD)

**Files:**
- Create: `src/utils/github-trigger-rules.js`
- Create: `test/utils/github-trigger-rules.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/utils/github-trigger-rules.test.js`:

```javascript
import { expect } from 'chai';
import { getSkipReason, EVENT_JOB_MAP } from '../../src/utils/github-trigger-rules.js';

describe('github-trigger-rules', () => {
  describe('EVENT_JOB_MAP', () => {
    it('maps pull_request to pr-review', () => {
      expect(EVENT_JOB_MAP.pull_request).to.equal('pr-review');
    });

    it('has no mapping for issue_comment', () => {
      expect(EVENT_JOB_MAP.issue_comment).to.be.undefined;
    });
  });

  describe('getSkipReason', () => {
    const defaultEnv = { GITHUB_APP_SLUG: 'mysticat' };

    const baseData = {
      pull_request: {
        draft: false,
        base: { ref: 'main' },
      },
      repository: { default_branch: 'main' },
      sender: { type: 'User' },
    };

    describe('review_requested trigger', () => {
      it('returns null when reviewer is the app', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', defaultEnv)).to.be.null;
      });

      it('returns skip reason when reviewer is not the app', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'some-human' },
        };
        const reason = getSkipReason(data, 'review_requested', defaultEnv);
        expect(reason).to.include('some-human');
        expect(reason).to.include('mysticat');
      });
    });

    describe('labeled trigger', () => {
      it('returns null when label matches', () => {
        const data = {
          ...baseData,
          action: 'labeled',
          label: { name: 'mysticat:review-requested' },
        };
        expect(getSkipReason(data, 'labeled', defaultEnv)).to.be.null;
      });

      it('returns skip reason when label does not match', () => {
        const data = {
          ...baseData,
          action: 'labeled',
          label: { name: 'bug' },
        };
        const reason = getSkipReason(data, 'labeled', defaultEnv);
        expect(reason).to.include('bug');
      });
    });

    describe('unsupported actions', () => {
      it('returns skip reason for opened (auto-trigger deferred)', () => {
        const data = { ...baseData, action: 'opened' };
        expect(getSkipReason(data, 'opened', defaultEnv)).to.include('auto-trigger');
      });

      it('returns skip reason for ready_for_review (auto-trigger deferred)', () => {
        const data = { ...baseData, action: 'ready_for_review' };
        expect(getSkipReason(data, 'ready_for_review', defaultEnv)).to.include('auto-trigger');
      });

      it('returns skip reason for closed', () => {
        const data = { ...baseData, action: 'closed' };
        expect(getSkipReason(data, 'closed', defaultEnv)).to.include('unsupported action');
      });
    });

    describe('skip rules', () => {
      it('returns skip reason for draft PR', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
          pull_request: { ...baseData.pull_request, draft: true },
        };
        expect(getSkipReason(data, 'review_requested', defaultEnv)).to.equal('draft PR');
      });

      it('returns skip reason for bot sender', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
          sender: { type: 'Bot' },
        };
        expect(getSkipReason(data, 'review_requested', defaultEnv)).to.equal('bot sender');
      });

      it('returns skip reason for non-default branch', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
          pull_request: { ...baseData.pull_request, base: { ref: 'release/v2' } },
        };
        const reason = getSkipReason(data, 'review_requested', defaultEnv);
        expect(reason).to.include('non-default branch');
      });
    });

    describe('GITHUB_APP_SLUG default', () => {
      it('defaults to mysticat when env var is not set', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', {})).to.be.null;
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/utils/github-trigger-rules.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/utils/github-trigger-rules.js`:

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
 * Maps GitHub event types to job types for the Mysticat GitHub Service.
 * Today: pull_request -> pr-review.
 * Future: issues -> triage-issue, push -> changelog, etc.
 */
export const EVENT_JOB_MAP = {
  pull_request: 'pr-review',
};

/**
 * Determines whether a GitHub webhook event should be skipped.
 * Returns a human-readable skip reason string, or null if the event should be processed.
 *
 * @param {object} data - Parsed webhook payload
 * @param {string} action - The event action (e.g. 'review_requested', 'labeled')
 * @param {object} env - Environment variables
 * @returns {string|null} Skip reason or null
 */
export function getSkipReason(data, action, env) {
  const pr = data.pull_request;
  const appSlug = env.GITHUB_APP_SLUG || 'mysticat';

  // Unsupported actions (auto-triggers deferred to Phase 3)
  if (action === 'opened' || action === 'ready_for_review') {
    return `auto-trigger not yet supported: ${action}`;
  }

  // Invite-based trigger: reviewer must be the app
  if (action === 'review_requested') {
    const reviewer = data.requested_reviewer?.login;
    if (reviewer !== `${appSlug}[bot]`) {
      return `reviewer ${reviewer} is not ${appSlug}`;
    }
  }

  // Label-based trigger: label must match
  if (action === 'labeled') {
    const label = data.label?.name;
    if (label !== 'mysticat:review-requested') {
      return `label ${label} does not match trigger`;
    }
  }

  // Only review_requested and labeled are supported in Phase 2
  if (action !== 'review_requested' && action !== 'labeled') {
    return `unsupported action: ${action}`;
  }

  // Skip rules (defensive, even for on-demand triggers)
  if (pr?.draft) {
    return 'draft PR';
  }

  if (data.sender?.type === 'Bot') {
    return 'bot sender';
  }

  if (pr?.base?.ref !== data.repository?.default_branch) {
    return `non-default branch: ${pr?.base?.ref}`;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/utils/github-trigger-rules.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/github-trigger-rules.js test/utils/github-trigger-rules.test.js
git commit -m "feat: add trigger rules and event-to-job-type mapping

EVENT_JOB_MAP maps pull_request -> pr-review.
getSkipReason applies payload-only trigger rules:
review_requested (reviewer match), labeled (label match),
skip draft/bot/non-default-branch.

Ref: SITES-42733"
```

---

### Task 8: Create HMAC auth handler with tests (TDD)

**Files:**
- Create: `src/support/github-webhook-hmac-handler.js`
- Create: `test/support/github-webhook-hmac-handler.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/support/github-webhook-hmac-handler.test.js`:

```javascript
import { expect } from 'chai';
import sinon from 'sinon';
import crypto from 'crypto';
import GitHubWebhookHmacHandler from '../../src/support/github-webhook-hmac-handler.js';

describe('GitHubWebhookHmacHandler', () => {
  let handler;
  let sandbox;
  const secret = 'test-webhook-secret';
  const validPayload = JSON.stringify({ action: 'review_requested', installation: { id: 123 } });

  function computeSignature(body, key = secret) {
    return `sha256=${crypto.createHmac('sha256', key).update(body).digest('hex')}`;
  }

  function makeRequest(headers = {}, body = validPayload) {
    return {
      headers: new Map(Object.entries(headers)),
      text: sinon.stub().resolves(body),
    };
  }

  function makeContext(overrides = {}) {
    return {
      pathInfo: { suffix: 'webhooks/github' },
      env: { GITHUB_WEBHOOK_SECRET: secret },
      ...overrides,
    };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const log = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    handler = new GitHubWebhookHmacHandler(log);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns AuthInfo with type github_webhook on valid signature', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.not.be.null;
    expect(result.type).to.equal('github_webhook');
    expect(result.authenticated).to.be.true;
  });

  it('stashes rawBody on context on success', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext();

    await handler.checkAuth(request, context);

    expect(context.rawBody).to.equal(validPayload);
  });

  it('returns null for non-webhook path', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ pathInfo: { suffix: 'sites/123' } });

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(request.text.called).to.be.false;
  });

  it('returns null when signature header is missing', async () => {
    const request = makeRequest({});
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null when GITHUB_WEBHOOK_SECRET is not configured', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ env: {} });

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for malformed signature (missing sha256= prefix)', async () => {
    const request = makeRequest({ 'x-hub-signature-256': 'abc123' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for signature with wrong byte length', async () => {
    const request = makeRequest({ 'x-hub-signature-256': 'sha256=tooshort' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for empty request body', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig }, '');
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for invalid signature (wrong secret)', async () => {
    const wrongSig = computeSignature(validPayload, 'wrong-secret');
    const request = makeRequest({ 'x-hub-signature-256': wrongSig });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('rejects signature computed over JSON.stringify (proves raw body matters)', async () => {
    // Raw body has specific whitespace; JSON.stringify would produce different bytes
    const rawBody = '{"action":  "review_requested"}';
    const reserialized = JSON.stringify(JSON.parse(rawBody));
    expect(rawBody).to.not.equal(reserialized);

    const sigFromRaw = computeSignature(rawBody);
    const sigFromReserialized = computeSignature(reserialized);
    expect(sigFromRaw).to.not.equal(sigFromReserialized);

    // Handler should validate against raw body, not reserialized
    const request = makeRequest({ 'x-hub-signature-256': sigFromRaw }, rawBody);
    const context = makeContext();

    const result = await handler.checkAuth(request, context);
    expect(result).to.not.be.null;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/support/github-webhook-hmac-handler.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/support/github-webhook-hmac-handler.js`:

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

import crypto from 'crypto';
import AbstractHandler from '@adobe/spacecat-shared-http-utils/src/auth/handlers/abstract.js';
import { AuthInfo } from '@adobe/spacecat-shared-http-utils';

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;

class GitHubWebhookHmacHandler extends AbstractHandler {
  constructor(log) {
    super('github-webhook-hmac', log);
  }

  async checkAuth(request, context) {
    // Path-scoped: only handle /webhooks/* routes
    if (!context.pathInfo?.suffix?.startsWith('webhooks/')) {
      return null;
    }

    const signature = request.headers.get('x-hub-signature-256');

    // Not a GitHub webhook request -- let other handlers try
    if (!signature) {
      return null;
    }

    const secret = context.env?.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      this.log.error('GITHUB_WEBHOOK_SECRET not configured');
      return null;
    }

    // Validate signature format before timingSafeEqual (prevents throw on length mismatch)
    if (!SIGNATURE_PATTERN.test(signature)) {
      this.log.warn('Malformed X-Hub-Signature-256 header');
      return null;
    }

    // Read raw body from request. bodyData middleware runs BEFORE authWrapper
    // in the .with() chain (last .with() = outermost = runs first), so bodyData
    // has already consumed the stream and set context.data. request.text()
    // returns the cached body via @adobe/helix-universal's Request implementation.
    const rawBody = await request.text();
    if (!rawBody) {
      this.log.warn('Empty request body for webhook');
      return null;
    }

    // Compute expected HMAC
    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')}`;

    // Timing-safe comparison (both are guaranteed 71 chars: "sha256=" + 64 hex)
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      this.log.warn('HMAC signature mismatch');
      return null;
    }

    // Stash raw body on context for controller use (e.g. logging, debugging).
    // context.data is already set by bodyData middleware; no need to parse again.
    context.rawBody = rawBody;

    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({ user_id: 'github-webhook' })
      .withType('github_webhook');
  }
}

export default GitHubWebhookHmacHandler;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/support/github-webhook-hmac-handler.test.js`
Expected: All tests PASS.

Note: if tests fail because `request.headers` is a Map but the real Request uses a Headers object, adjust the `makeRequest` helper to use `{ get: (name) => headers[name] || null }` instead of `new Map()`. Check how the existing auth handler tests mock the request.

- [ ] **Step 5: Commit**

```bash
git add src/support/github-webhook-hmac-handler.js test/support/github-webhook-hmac-handler.test.js
git commit -m "feat: add GitHubWebhookHmacHandler auth handler

Custom auth handler extending AbstractHandler for HMAC-SHA256
webhook signature verification. Path-scoped to /webhooks/*,
format pre-check before timingSafeEqual, reads cached raw body
via request.text().

Ref: SITES-42733"
```

---

### Task 9: Create webhooks controller with tests (TDD)

**Files:**
- Create: `src/controllers/webhooks.js`
- Create: `test/controllers/webhooks.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/controllers/webhooks.test.js`:

```javascript
import { expect } from 'chai';
import sinon from 'sinon';
import WebhooksController from '../../src/controllers/webhooks.js';

describe('WebhooksController', () => {
  let sandbox;
  let controller;
  let mockSqs;
  let mockLog;
  const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123/mysticat-github-service-jobs';

  const validContext = {
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-uuid-123',
    },
    data: {
      action: 'review_requested',
      requested_reviewer: { login: 'mysticat[bot]' },
      installation: { id: 12345678 },
      pull_request: {
        number: 456,
        draft: false,
        base: { ref: 'main' },
      },
      repository: {
        name: 'spacecat-api-service',
        owner: { login: 'adobe' },
        default_branch: 'main',
      },
      sender: { type: 'User' },
    },
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockSqs = { sendMessage: sandbox.stub().resolves() };
    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };

    const context = {
      sqs: mockSqs,
      log: mockLog,
      env: {
        MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl,
        GITHUB_APP_SLUG: 'mysticat',
      },
    };

    controller = WebhooksController(context);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns 202 and enqueues job for valid review_requested event', async () => {
    const response = await controller.processGitHubWebhook(validContext);

    expect(response.status).to.equal(202);
    expect(mockSqs.sendMessage.calledOnce).to.be.true;

    const [url, payload] = mockSqs.sendMessage.firstCall.args;
    expect(url).to.equal(queueUrl);
    expect(payload.owner).to.equal('adobe');
    expect(payload.repo).to.equal('spacecat-api-service');
    expect(payload.event_type).to.equal('pull_request');
    expect(payload.event_action).to.equal('review_requested');
    expect(payload.event_ref).to.equal('456');
    expect(payload.installation_id).to.equal('12345678');
    expect(payload.delivery_id).to.equal('delivery-uuid-123');
    expect(payload.job_type).to.equal('pr-review');
    expect(payload.workspace_repos).to.deep.equal([
      'adobe/mysticat-architecture',
      'adobe/mysticat-ai-native-guidelines',
      'Adobe-AEM-Sites/aem-sites-architecture',
    ]);
    expect(payload.retry_count).to.equal(0);
  });

  it('returns 204 for non-pull_request event', async () => {
    const context = {
      ...validContext,
      headers: { ...validContext.headers, 'x-github-event': 'issue_comment' },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(204);
    expect(mockSqs.sendMessage.called).to.be.false;
  });

  it('returns 400 with field name when action is missing', async () => {
    const context = {
      ...validContext,
      data: { ...validContext.data, action: undefined },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.include('action');
  });

  it('returns 400 with field name when installation.id is missing', async () => {
    const context = {
      ...validContext,
      data: { ...validContext.data, installation: undefined },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.include('installation.id');
  });

  it('propagates X-GitHub-Delivery to job payload as delivery_id', async () => {
    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.delivery_id).to.equal('delivery-uuid-123');
  });

  it('returns 500 when SQS sendMessage fails', async () => {
    mockSqs.sendMessage.rejects(new Error('SQS timeout'));

    const response = await controller.processGitHubWebhook(validContext);

    expect(response.status).to.equal(500);
  });

  it('returns 204 for skipped events (draft PR)', async () => {
    const context = {
      ...validContext,
      data: {
        ...validContext.data,
        pull_request: { ...validContext.data.pull_request, draft: true },
      },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(204);
    expect(mockSqs.sendMessage.called).to.be.false;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/controllers/webhooks.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/controllers/webhooks.js`:

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

import {
  accepted, noContent, badRequest, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import wrap from '@adobe/helix-shared-wrap';
import { getSkipReason, EVENT_JOB_MAP } from '../utils/github-trigger-rules.js';

function errorHandler(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (e) {
      context.log.error('GitHub webhook handler error', e);
      return internalServerError('Internal error');
    }
  };
}

function WebhooksController(context) {
  const { sqs, log, env } = context;

  const processGitHubWebhook = wrap(async (ctx) => {
    const event = ctx.headers?.['x-github-event'];
    const deliveryId = ctx.headers?.['x-github-delivery'];
    const { data } = ctx;

    // Validate required payload fields
    if (!data?.action) {
      return badRequest('Missing required field: action');
    }
    if (!data?.installation?.id) {
      return badRequest('Missing required field: installation.id');
    }

    // Check event-to-job-type mapping
    const jobType = EVENT_JOB_MAP[event];
    if (!jobType) {
      log.info(`Skipping unmapped event: ${event}`, { deliveryId });
      return noContent();
    }

    const action = data.action;
    const pr = data.pull_request;

    // Apply trigger rules
    const skipReason = getSkipReason(data, action, env);
    if (skipReason) {
      log.info(`Skipping: ${skipReason}`, {
        deliveryId,
        event,
        action,
        owner: data.repository?.owner?.login,
        repo: data.repository?.name,
        prNumber: pr?.number,
      });
      return noContent();
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
      workspace_repos: [
        'adobe/mysticat-architecture',
        'adobe/mysticat-ai-native-guidelines',
        'Adobe-AEM-Sites/aem-sites-architecture',
      ],
      retry_count: 0,
    };

    const queueUrl = env.MYSTICAT_GITHUB_JOBS_QUEUE_URL;
    await sqs.sendMessage(queueUrl, jobPayload);

    log.info(`Enqueued ${jobType} job`, {
      deliveryId,
      event,
      action,
      owner: jobPayload.owner,
      repo: jobPayload.repo,
      prNumber: pr.number,
      installationId: jobPayload.installation_id,
    });

    return accepted({ status: 'accepted' });
  })
    .with(errorHandler);

  return { processGitHubWebhook };
}

export default WebhooksController;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/controllers/webhooks.test.js`
Expected: All tests PASS.

Note: if the `response.json()` call in the 400 tests does not work with the shared HTTP utils' response objects, adjust to read the body via `JSON.parse(response.body)` or whatever pattern the existing controller tests use. Check `test/controllers/hooks.test.js` for the response reading pattern.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/webhooks.js test/controllers/webhooks.test.js
git commit -m "feat: add webhooks controller for GitHub webhook handler

Factory-function controller with processGitHubWebhook method.
Validates payload, checks EVENT_JOB_MAP, applies trigger rules,
enqueues job to SQS. Wrapped with errorHandler for 500 fallback.

Ref: SITES-42733"
```

---

### Task 10: Wire route and auth handler into src/index.js and src/routes/index.js

**Files:**
- Modify: `src/routes/index.js` — add route
- Modify: `src/index.js` — add auth handler registration + controller wiring

- [ ] **Step 1: Add route definition**

In `src/routes/index.js`, add the route in the `routeDefinitions` object. Place it near the existing hooks routes:

```javascript
'POST /webhooks/github': webhooksController.processGitHubWebhook,
```

- [ ] **Step 2: Add auth handler import and registration in src/index.js**

Add the import at the top of `src/index.js` alongside the other auth handler imports:

```javascript
import GitHubWebhookHmacHandler from './support/github-webhook-hmac-handler.js';
```

Add `GitHubWebhookHmacHandler` to the `authHandlers` array in the `wrappedMain` definition, after `SkipAuthHandler`:

```javascript
authHandlers: [
  SkipAuthHandler,
  GitHubWebhookHmacHandler,
  JwtHandler,
  AdobeImsHandler,
  ScopedApiKeyHandler,
  LegacyApiKeyHandler,
],
```

- [ ] **Step 3: Add controller instantiation and wiring**

In `src/index.js`, add `WebhooksController` import:

```javascript
import WebhooksController from './controllers/webhooks.js';
```

In the controller instantiation section (around line 203-252), add:

```javascript
const webhooksController = WebhooksController(context);
```

In the `getRouteHandlers()` call (around line 254-305), include `webhooksController`.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: All tests PASS (including existing tests — no regressions).

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 6: Run docs build**

Run: `npm run docs:build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/index.js src/routes/index.js
git commit -m "feat: wire webhook route and HMAC auth handler

Register GitHubWebhookHmacHandler in authHandlers array.
Add POST /webhooks/github route pointing to WebhooksController.
Wire WebhooksController instantiation in the main handler.

Ref: SITES-42733"
```

---

### Task 11: Final validation and push

**Files:**
- None (validation + git)

- [ ] **Step 1: Run full test suite one more time**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Run lint one more time**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 3: Push Phase 2 commits**

```bash
git push
```

- [ ] **Step 4: Update PR for Phase 2 review**

Update the PR description to note that Phase 2 implementation is now ready for review alongside the Phase 1 OpenAPI contract.
