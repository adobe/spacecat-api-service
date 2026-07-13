# Semrush Onboarding Notification Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v2/orgs/:spaceCatId/onboarding` for IMS users that resolves the caller's email (from the trusted auth identity) and the org's Semrush workspace ID, then sends a Slack incoming-webhook notification.

**Architecture:** A thin per-request controller factory (`OnboardingController`) orchestrates access control + data resolution, and delegates the outbound Slack call to an isolated support module (`slack-notifier.js`). The notifier is the seam where a future Styx-authenticated SR API call will slot in. No new data-access model; no persistence.

**Tech Stack:** Node.js (ESM), `@adobe/spacecat-shared-http-utils` (`createResponse`, `forbidden`, `notFound`, `badRequest`, `ok`, `internalServerError`), `@adobe/spacecat-shared-utils` (`tracingFetch`, `hasText`, `isValidUUID`), `AccessControlUtil`, `resolveWorkspaceId` (serenity workspace-resolver). Tests: Mocha + Chai + Sinon + esmock; IT via PostgreSQL harness.

## Global Constraints

- Every source file starts with the standard Adobe Apache-2.0 license header (copy verbatim from any existing `src/**/*.js`, `Copyright 2026 Adobe`).
- Controllers are instantiated **per request** inside `src/index.js`; no shared/module state.
- Register every route in **both** `src/routes/index.js` (route→handler map) and the `getRouteHandlers(...)` parameter list in `src/index.js`.
- `:spaceCatId` is already validated (`isValidUUID`) in `src/index.js:378` and already classified in `FACS_NON_RESOURCE_PARAMS` — **do not** edit `src/routes/facs-capabilities.js`.
- Never expose the webhook URL, secrets, or stack traces to clients; sanitize outbound error text.
- Email must come from `context.attributes.authInfo.getProfile()?.email` (trusted identity), never from the request body.
- Workspace ID comes from `resolveWorkspaceId(context, spaceCatId)`; `null` is valid → notify without it.
- HTTP status contract: `200` success, `400` no email, `403` no access, `404` org missing, `500` webhook not configured, `502` webhook non-2xx/failure.

---

### Task 1: Slack notifier support module

**Files:**
- Create: `src/support/onboarding/slack-notifier.js`
- Test: `test/support/onboarding/slack-notifier.test.js`

**Interfaces:**
- Consumes: `tracingFetch` from `@adobe/spacecat-shared-utils`; `ErrorWithStatusCode` from `../utils.js`.
- Produces: `export async function notifyOnboarding(env, { email, workspaceId, spaceCatId }): Promise<void>` — throws `ErrorWithStatusCode(msg, 500)` when `env.SLACK_ONBOARDING_WEBHOOK_URL` is missing, throws `ErrorWithStatusCode(msg, 502)` on non-2xx / network failure, resolves `void` on success.

- [ ] **Step 1: Write the failing test**

Create `test/support/onboarding/slack-notifier.test.js`:

```javascript
/*
 * Copyright 2026 Adobe. All rights reserved.
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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);

const WEBHOOK_URL = 'https://hooks.slack.test/services/T000/B000/xxxx';

describe('notifyOnboarding', () => {
  let sandbox;
  let fetchStub;
  let notifyOnboarding;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    fetchStub = sandbox.stub();
    ({ notifyOnboarding } = await esmock('../../../src/support/onboarding/slack-notifier.js', {
      '@adobe/spacecat-shared-utils': { tracingFetch: fetchStub },
    }));
  });

  afterEach(() => sandbox.restore());

  const payload = {
    email: 'jane@example.com',
    workspaceId: 'ws-123',
    spaceCatId: '11111111-1111-4111-b111-111111111111',
  };

  it('POSTs a JSON message to the configured webhook URL and resolves on 2xx', async () => {
    fetchStub.resolves({ ok: true, status: 200, text: async () => 'ok' });

    await expect(notifyOnboarding({ SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL }, payload))
      .to.be.fulfilled;

    expect(fetchStub.calledOnce).to.equal(true);
    const [url, opts] = fetchStub.firstCall.args;
    expect(url).to.equal(WEBHOOK_URL);
    expect(opts.method).to.equal('POST');
    expect(opts.headers['content-type']).to.equal('application/json');
    const body = JSON.parse(opts.body);
    expect(body.text).to.contain('jane@example.com');
    expect(body.text).to.contain('ws-123');
  });

  it('includes the org id and marks workspace unavailable when workspaceId is null', async () => {
    fetchStub.resolves({ ok: true, status: 200, text: async () => 'ok' });

    await notifyOnboarding(
      { SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL },
      { ...payload, workspaceId: null },
    );

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.text).to.contain('11111111-1111-4111-b111-111111111111');
    expect(body.text.toLowerCase()).to.contain('not available');
  });

  it('throws a 500 error when the webhook URL is not configured', async () => {
    await expect(notifyOnboarding({}, payload))
      .to.be.rejectedWith(/not configured/i)
      .and.eventually.have.property('status', 500);
    expect(fetchStub.called).to.equal(false);
  });

  it('throws a 502 error when the webhook responds non-2xx', async () => {
    fetchStub.resolves({ ok: false, status: 500, text: async () => 'boom' });

    await expect(notifyOnboarding({ SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL }, payload))
      .to.be.rejected
      .and.eventually.have.property('status', 502);
  });

  it('throws a 502 error when the webhook call rejects (network failure)', async () => {
    fetchStub.rejects(new Error('ECONNREFUSED'));

    await expect(notifyOnboarding({ SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL }, payload))
      .to.be.rejected
      .and.eventually.have.property('status', 502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/support/onboarding/slack-notifier.test.js`
Expected: FAIL — cannot resolve `src/support/onboarding/slack-notifier.js` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/support/onboarding/slack-notifier.js`:

```javascript
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// @ts-check

import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../utils.js';

/**
 * Builds the Slack incoming-webhook message body for an onboarding request.
 *
 * @param {{ email: string, workspaceId: string|null, spaceCatId: string }} params
 * @returns {{ text: string }}
 */
function buildMessage({ email, workspaceId, spaceCatId }) {
  const workspace = hasText(workspaceId) ? workspaceId : 'not available';
  return {
    text: [
      ':wave: *New Semrush onboarding request*',
      `• Customer email: ${email}`,
      `• Workspace ID: ${workspace}`,
      `• Organization: ${spaceCatId}`,
    ].join('\n'),
  };
}

/**
 * Sends an onboarding notification to the Semrush Slack workspace via an
 * incoming webhook. This is the seam where a future Styx-authenticated Semrush
 * (SR) API call will be added.
 *
 * @param {Record<string, string|undefined>} env - Runtime env (context.env).
 * @param {{ email: string, workspaceId: string|null, spaceCatId: string }} payload
 * @returns {Promise<void>}
 * @throws {ErrorWithStatusCode} 500 if the webhook URL is unset; 502 on failure.
 */
export async function notifyOnboarding(env, payload) {
  const webhookUrl = env?.SLACK_ONBOARDING_WEBHOOK_URL;
  if (!hasText(webhookUrl)) {
    throw new ErrorWithStatusCode('onboarding notifications not configured', 500);
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildMessage(payload)),
    });
  } catch (e) {
    throw new ErrorWithStatusCode(`onboarding notification failed: ${e.message}`, 502);
  }

  if (!response.ok) {
    throw new ErrorWithStatusCode(
      `onboarding notification rejected with status ${response.status}`,
      502,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/support/onboarding/slack-notifier.test.js`
Expected: PASS (5 passing).

- [ ] **Step 5: Lint**

Run: `npx eslint src/support/onboarding/slack-notifier.js test/support/onboarding/slack-notifier.test.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/support/onboarding/slack-notifier.js test/support/onboarding/slack-notifier.test.js
git commit -m "feat(onboarding): add Slack webhook notifier module"
```

---

### Task 2: Onboarding controller

**Files:**
- Create: `src/controllers/onboarding.js`
- Test: `test/controllers/onboarding.test.js`

**Interfaces:**
- Consumes: `notifyOnboarding` (Task 1); `resolveWorkspaceId` from `../support/serenity/workspace-resolver.js`; `AccessControlUtil` from `../support/access-control-util.js`; `ErrorWithStatusCode` from `../support/utils.js`.
- Produces: `export default function OnboardingController(context, log, env)` returning `{ triggerOnboarding }`, where `triggerOnboarding(context): Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Create `test/controllers/onboarding.test.js`:

```javascript
/*
 * Copyright 2026 Adobe. All rights reserved.
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

const ORG_ID = '11111111-1111-4111-b111-111111111111';

describe('OnboardingController', () => {
  let sandbox;
  let notifyStub;
  let resolveWorkspaceStub;
  let hasAccessStub;
  let OnboardingController;
  let mockOrg;

  const buildContext = (overrides = {}) => ({
    params: { spaceCatId: ORG_ID },
    dataAccess: { Organization: { findById: sandbox.stub().resolves(mockOrg) } },
    attributes: { authInfo: { getProfile: () => ({ email: 'jane@example.com' }) } },
    env: { SLACK_ONBOARDING_WEBHOOK_URL: 'https://hooks.slack.test/x' },
    log: { info: sandbox.stub(), error: sandbox.stub() },
    ...overrides,
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockOrg = { getId: () => ORG_ID };
    notifyStub = sandbox.stub().resolves();
    resolveWorkspaceStub = sandbox.stub().resolves('ws-123');
    hasAccessStub = sandbox.stub().resolves(true);

    OnboardingController = await esmock('../../src/controllers/onboarding.js', {
      '../../src/support/onboarding/slack-notifier.js': { notifyOnboarding: notifyStub },
      '../../src/support/serenity/workspace-resolver.js': { resolveWorkspaceId: resolveWorkspaceStub },
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
      },
    });
  });

  afterEach(() => sandbox.restore());

  it('returns 200 with { notified, workspaceId } on success', async () => {
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({ notified: true, workspaceId: 'ws-123' });
    expect(notifyStub.calledOnce).to.equal(true);
    expect(notifyStub.firstCall.args[1]).to.include({
      email: 'jane@example.com',
      workspaceId: 'ws-123',
      spaceCatId: ORG_ID,
    });
  });

  it('returns 200 with workspaceId null when the org has no workspace', async () => {
    resolveWorkspaceStub.resolves(null);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({ notified: true, workspaceId: null });
  });

  it('returns 404 when the organization does not exist', async () => {
    const ctx = buildContext();
    ctx.dataAccess.Organization.findById.resolves(null);
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(404);
    expect(notifyStub.called).to.equal(false);
  });

  it('returns 403 when the caller lacks access to the org', async () => {
    hasAccessStub.resolves(false);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(403);
    expect(notifyStub.called).to.equal(false);
  });

  it('returns 400 when no email can be determined from the identity', async () => {
    const ctx = buildContext({
      attributes: { authInfo: { getProfile: () => ({}) } },
    });
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(400);
    expect(notifyStub.called).to.equal(false);
  });

  it('maps a 500 notifier error (webhook not configured) to 500', async () => {
    const err = new Error('onboarding notifications not configured');
    err.status = 500;
    notifyStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(500);
  });

  it('maps a 502 notifier error (webhook failure) to 502', async () => {
    const err = new Error('onboarding notification rejected with status 500');
    err.status = 502;
    notifyStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/controllers/onboarding.test.js`
Expected: FAIL — cannot resolve `src/controllers/onboarding.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/controllers/onboarding.js`:

```javascript
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// @ts-check

import {
  badRequest, createResponse, forbidden, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { resolveWorkspaceId } from '../support/serenity/workspace-resolver.js';
import { notifyOnboarding } from '../support/onboarding/slack-notifier.js';

/**
 * Controller for the Semrush onboarding notification endpoint.
 *
 * @param {object} context - Request context (dataAccess, attributes, env, log).
 * @param {object} log - Logger.
 * @param {object} env - Runtime env.
 * @returns {{ triggerOnboarding: (ctx: object) => Promise<Response> }}
 */
export default function OnboardingController(context, log, env) {
  /**
   * POST /v2/orgs/:spaceCatId/onboarding
   * @param {object} ctx - Request context.
   * @returns {Promise<Response>}
   */
  const triggerOnboarding = async (ctx) => {
    const { spaceCatId } = ctx.params;

    const org = await ctx.dataAccess.Organization.findById(spaceCatId);
    if (!org) {
      return notFound('Organization not found');
    }

    const accessControlUtil = AccessControlUtil.fromContext(ctx);
    if (!await accessControlUtil.hasAccess(org)) {
      return forbidden('User does not have access to this organization');
    }

    const email = ctx.attributes?.authInfo?.getProfile?.()?.email;
    if (!hasText(email)) {
      return badRequest('Unable to determine customer email from the request identity');
    }

    const workspaceId = await resolveWorkspaceId(ctx, spaceCatId);

    try {
      await notifyOnboarding(env, { email, workspaceId, spaceCatId });
    } catch (e) {
      const status = e.status === 500 ? 500 : 502;
      log.error(`[onboarding] notification failed for org=${spaceCatId} status=${status}: ${e.message}`);
      return createResponse({ message: 'Failed to send onboarding notification' }, status);
    }

    return ok({ notified: true, workspaceId: workspaceId ?? null });
  };

  return { triggerOnboarding };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/controllers/onboarding.test.js`
Expected: PASS (7 passing).

- [ ] **Step 5: Lint**

Run: `npx eslint src/controllers/onboarding.js test/controllers/onboarding.test.js`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/onboarding.js test/controllers/onboarding.test.js
git commit -m "feat(onboarding): add onboarding controller"
```

---

### Task 3: Wire the route

**Files:**
- Modify: `src/index.js` (import, per-request instantiation, `getRouteHandlers(...)` call args)
- Modify: `src/routes/index.js` (`getRouteHandlers` param list, route→handler map)

**Interfaces:**
- Consumes: `OnboardingController` default export (Task 2).
- Produces: live route `POST /v2/orgs/:spaceCatId/onboarding` → `onboardingController.triggerOnboarding`.

- [ ] **Step 1: Add the import in `src/index.js`**

Near the other controller imports (e.g. next to `import SerenityController from './controllers/serenity.js';` at line ~115), add:

```javascript
import OnboardingController from './controllers/onboarding.js';
```

- [ ] **Step 2: Instantiate per request in `src/index.js`**

In the block where controllers are created per request (near `const serenityController = SerenityController(context, log, context.env);`, line ~295), add:

```javascript
    const onboardingController = OnboardingController(context, log, context.env);
```

- [ ] **Step 3: Pass it into `getRouteHandlers(...)` in `src/index.js`**

In the `getRouteHandlers(` call args list (the block starting around line ~300 that passes `serenityController, elementsController, proxyController, ...`), add `onboardingController` to the argument list. Add it at the **end of the list, immediately before `redirectsController`** (the last argument), to match the param order change in Step 4:

```javascript
      serenityController,
      elementsController,
      proxyController,
      onboardingController,
      redirectsController,
    );
```

- [ ] **Step 4: Add the parameter in `src/routes/index.js`**

In `export default function getRouteHandlers(` (line ~115), add `onboardingController` as the **second-to-last** parameter, immediately before `redirectsController`:

```javascript
  proxyController,
  onboardingController,
  redirectsController,
) {
```

- [ ] **Step 5: Register the route in `src/routes/index.js`**

Inside `routeDefinitions`, next to the serenity org-scoped routes (e.g. after the `POST /v2/orgs/:spaceCatId/brands/:brandId/serenity/deactivate` line), add:

```javascript
    'POST /v2/orgs/:spaceCatId/onboarding': onboardingController.triggerOnboarding,
```

- [ ] **Step 6: Verify route wiring with the existing route test suite**

Run: `npx mocha test/routes/index.test.js`
Expected: PASS. (If the suite asserts a handler count or arg order, this confirms `onboardingController` is threaded correctly.)

- [ ] **Step 7: Verify FACS param classification test still passes (no change expected)**

Run: `npx mocha test/routes/facs-capabilities.test.js`
Expected: PASS — `:spaceCatId` is already in `FACS_NON_RESOURCE_PARAMS`; the new route needs no classification change.

- [ ] **Step 8: Lint**

Run: `npx eslint src/index.js src/routes/index.js`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/index.js src/routes/index.js
git commit -m "feat(onboarding): wire POST /v2/orgs/:spaceCatId/onboarding route"
```

---

### Task 4: Integration test

**Files:**
- Create: `test/it/shared/tests/onboarding.js`
- Create: `test/it/postgres/onboarding.test.js`

**Interfaces:**
- Consumes: existing seed IDs `ORG_1_ID`, `ORG_3_ID`, `NON_EXISTENT_ORG_ID` from `test/it/shared/seed-ids.js`; harness `ctx.httpClient` + `resetPostgres`.
- Produces: an IT suite covering the pre-notification auth gate (org lookup + membership). The webhook success path is intentionally out of scope (external HTTP), exactly like `onboard-site-only`.

- [ ] **Step 1: Write the shared test factory**

Create `test/it/shared/tests/onboarding.js`:

```javascript
/*
 * Copyright 2026 Adobe. All rights reserved.
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
  ORG_3_ID, // user persona is NOT a member of ORG_3
  NON_EXISTENT_ORG_ID,
} from '../seed-ids.js';

/**
 * Shared integration tests for POST /v2/orgs/:spaceCatId/onboarding.
 *
 * Scope is the auth gate that resolves against the real DB *before* the endpoint
 * calls the external Slack webhook: org existence and membership. The webhook
 * success path (200) depends on an external service and is covered by the unit
 * suites (test/controllers/onboarding.test.js, test/support/onboarding).
 *
 * @param {() => object} getHttpClient - Getter returning the initialized HTTP client
 * @param {() => Promise<void>} resetData - Truncates all data and re-seeds baseline
 */
export default function onboardingTests(getHttpClient, resetData) {
  describe('POST /v2/orgs/:spaceCatId/onboarding', () => {
    before(() => resetData());

    const onboardingPath = (orgId) => `/v2/orgs/${orgId}/onboarding`;

    it('returns 404 when the organization does not exist', async () => {
      const http = getHttpClient();
      const res = await http.admin.post(onboardingPath(NON_EXISTENT_ORG_ID), {});
      expect(res.status).to.equal(404);
    });

    it('returns 403 for a non-member (user persona on an org they do not belong to)', async () => {
      const http = getHttpClient();
      const res = await http.user.post(onboardingPath(ORG_3_ID), {});
      expect(res.status).to.equal(403);
    });
  });
}
```

- [ ] **Step 2: Write the postgres wiring file**

Create `test/it/postgres/onboarding.test.js`:

```javascript
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ctx } from './harness.js';
import { resetPostgres } from './seed.js';
import onboardingTests from '../shared/tests/onboarding.js';

onboardingTests(() => ctx.httpClient, resetPostgres);
```

- [ ] **Step 3: Run the IT suite**

Run: `npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/onboarding.test.js`
Expected: PASS (2 passing). Requires Docker + ECR access per `test/it/README.md`.

- [ ] **Step 4: Lint**

Run: `npx eslint test/it/shared/tests/onboarding.js test/it/postgres/onboarding.test.js`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add test/it/shared/tests/onboarding.js test/it/postgres/onboarding.test.js
git commit -m "test(onboarding): add integration tests for onboarding endpoint"
```

---

### Task 5: OpenAPI spec + docs

**Files:**
- Create: `docs/openapi/paths/onboarding.yaml` (or add to the existing org-scoped paths file — follow the layout used by other `/v2/orgs/{spaceCatId}/...` paths)
- Modify: `docs/openapi/schemas.yaml` (add `OnboardingNotificationResponse`)
- Modify: the root OpenAPI file that `$ref`s path files (follow existing pattern for registering a new path)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: documented `POST /v2/orgs/{spaceCatId}/onboarding` matching the implemented contract.

- [ ] **Step 1: Inspect the existing OpenAPI layout for an org-scoped POST**

Run: `ls docs/openapi/paths | head; grep -rn "onboard-site\|/v2/orgs/{spaceCatId}" docs/openapi --include="*.yaml" | head`
Purpose: find the exact file + `$ref` registration pattern to mirror (e.g. the `llmo/onboard-site` path). Follow that structure exactly.

- [ ] **Step 2: Add the response schema to `docs/openapi/schemas.yaml`**

```yaml
    OnboardingNotificationResponse:
      type: object
      required:
        - notified
        - workspaceId
      properties:
        notified:
          type: boolean
          example: true
        workspaceId:
          type: string
          nullable: true
          description: The org-level Semrush workspace ID, or null if the org has none.
          example: "ws-123"
```

- [ ] **Step 3: Add the path definition**

Mirror the existing org-scoped POST path found in Step 1. The operation must document:
- `POST /v2/orgs/{spaceCatId}/onboarding`
- `spaceCatId` path param (UUID)
- security: IMS user (reuse the security scheme other `/v2/orgs` routes use)
- responses: `200` → `$ref` `OnboardingNotificationResponse`; `400`, `403`, `404`, `500`, `502` referencing the shared error responses used elsewhere.

```yaml
  /v2/orgs/{spaceCatId}/onboarding:
    post:
      tags:
        - Onboarding
      summary: Trigger a Semrush onboarding notification
      description: >-
        Sends a Slack notification announcing an onboarding request for the
        organization. The customer email is taken from the authenticated
        identity and the Semrush workspace ID is resolved from the organization.
      operationId: triggerOnboarding
      parameters:
        - $ref: './parameters.yaml#/spaceCatId'
      responses:
        '200':
          description: Notification sent.
          content:
            application/json:
              schema:
                $ref: './schemas.yaml#/OnboardingNotificationResponse'
        '400':
          $ref: './responses.yaml#/400'
        '403':
          $ref: './responses.yaml#/403'
        '404':
          $ref: './responses.yaml#/404'
        '500':
          $ref: './responses.yaml#/500'
        '502':
          $ref: './responses.yaml#/500'
```

Note: adjust every `$ref` path to match the actual filenames/anchors discovered in Step 1 (e.g. the real parameter name for `spaceCatId`, and whether a `502` response component exists — if not, reuse the generic error response).

- [ ] **Step 4: Lint the OpenAPI specs**

Run: `npm run docs:lint`
Expected: no validation errors.

- [ ] **Step 5: Build the docs**

Run: `npm run docs:build`
Expected: build succeeds; the new path appears in generated output.

- [ ] **Step 6: Commit**

```bash
git add docs/openapi
git commit -m "docs(onboarding): document POST /v2/orgs/:spaceCatId/onboarding"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS (including the two new unit suites).

- [ ] **Step 2: Lint the whole change**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Build the Lambda bundle (bundle-layer safety)**

Run: `npm run build`
Expected: build succeeds. (New modules are plain JS imports — no `hlx.static` / `readFileSync(import.meta.url)` involved, so this should pass, but confirm because a route/controller was added.)

- [ ] **Step 4: Note the required deployment config**

`SLACK_ONBOARDING_WEBHOOK_URL` must be provisioned as an environment variable / secret for dev, stage, and prod before this endpoint works. Record this in the PR description (it is a deploy-time action, not a code change).

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Route & contract → Task 3 (route) + Task 2 (status codes) + Task 5 (OpenAPI).
- Access control (org lookup, `hasAccess`, UUID guard) → Task 2; UUID guard pre-exists (`src/index.js:378`).
- Data resolution (email from identity, workspace via `resolveWorkspaceId`) → Task 2.
- Components (controller + notifier module) → Task 2 + Task 1.
- Config (`SLACK_ONBOARDING_WEBHOOK_URL`, 500 when unset) → Task 1 (throw) + Task 2 (map to 500) + Task 6 (deploy note).
- Error handling (sanitize, no secret leak, log) → Task 2 (generic client message + `log.error`) + Task 1 (typed errors).
- Testing (unit + IT) → Tasks 1, 2, 4.
- OpenAPI → Task 5.
- Future Styx/SR API seam → documented in Task 1's notifier module.

**2. Placeholder scan** — no TBD/TODO/"handle edge cases"; all code steps contain full code. Task 5 contains explicit `$ref` guidance to reconcile with real filenames (a genuine discovery step, not a placeholder — the concrete YAML is provided).

**3. Type consistency** — `notifyOnboarding(env, { email, workspaceId, spaceCatId })` is defined identically in Task 1 and called identically in Task 2. `OnboardingController(context, log, env)` returning `{ triggerOnboarding }` is consistent across Tasks 2 and 3. `resolveWorkspaceId(ctx, spaceCatId)` matches the real signature in `src/support/serenity/workspace-resolver.js`. `ErrorWithStatusCode(message, status)` matches `src/support/utils.js:578`.
