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
import WebhooksController from '../../src/controllers/webhooks.js';

describe('WebhooksController', () => {
  let sandbox;
  let controller;
  let mockSqs;
  let mockLog;
  const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123/mysticat-github-service-jobs';

  const validContext = {
    pathInfo: {
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-uuid-123',
      },
    },
    // The HMAC handler attaches the resolved destination + reviewer identity to
    // the auth profile; every authenticated webhook carries target_id +
    // reviewer_login (the consolidated GITHUB_DESTINATIONS path).
    attributes: {
      authInfo: {
        getProfile: () => ({ user_id: 'github-webhook', target_id: 'github-public', reviewer_login: 'MysticatBot' }),
      },
    },
    data: {
      action: 'review_requested',
      requested_reviewer: { login: 'MysticatBot' },
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

  function buildController(envOverrides = {}) {
    const context = {
      sqs: mockSqs,
      log: mockLog,
      env: {
        MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl,
        ...envOverrides,
      },
    };
    return WebhooksController(context);
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockSqs = { sendMessage: sandbox.stub().resolves() };
    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };
    controller = buildController();
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
    // Every authenticated webhook now carries the resolved destination id.
    expect(payload.target_id).to.equal('github-public');
  });

  it('returns 204 for non-pull_request event', async () => {
    const context = {
      ...validContext,
      pathInfo: {
        headers: { ...validContext.pathInfo.headers, 'x-github-event': 'issue_comment' },
      },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(204);
    expect(mockSqs.sendMessage.called).to.be.false;
  });

  it('returns 204 for GitHub install ping (no action, no installation)', async () => {
    // Real GitHub `ping` payloads carry neither `action` nor `installation.id`.
    // Verifies the controller short-circuits on event type before payload
    // validation, so install pings do not appear as failed deliveries in the
    // App's "Recent Deliveries" UI.
    const context = {
      pathInfo: {
        headers: {
          'x-github-event': 'ping',
          'x-github-delivery': 'delivery-uuid-ping',
        },
      },
      data: {
        zen: 'Anything added dilutes everything else.',
        hook_id: 12345,
        hook: { type: 'App', id: 12345, events: ['pull_request'] },
      },
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

  it('returns 400 with field name when pull_request.number is missing', async () => {
    const context = {
      ...validContext,
      data: {
        ...validContext.data,
        pull_request: { ...validContext.data.pull_request, number: undefined },
      },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.include('pull_request.number');
  });

  it('returns 400 with field name when repository.owner.login is missing', async () => {
    const context = {
      ...validContext,
      data: {
        ...validContext.data,
        repository: {
          ...validContext.data.repository,
          owner: {},
        },
      },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.include('repository.owner.login');
  });

  it('returns 400 with field name when repository.name is missing', async () => {
    const context = {
      ...validContext,
      data: {
        ...validContext.data,
        repository: {
          ...validContext.data.repository,
          name: undefined,
        },
      },
    };

    const response = await controller.processGitHubWebhook(context);

    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.message).to.include('repository.name');
  });

  it('propagates X-GitHub-Delivery to job payload as delivery_id', async () => {
    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.delivery_id).to.equal('delivery-uuid-123');
  });

  it('returns 500 and logs error when SQS sendMessage fails', async () => {
    mockSqs.sendMessage.rejects(new Error('SQS timeout'));

    const response = await controller.processGitHubWebhook(validContext);

    expect(response.status).to.equal(500);
    expect(mockLog.error.calledOnce).to.be.true;
    expect(mockLog.error.firstCall.args[0]).to.include('GitHub webhook handler error');
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

  it('uses MYSTICAT_WORKSPACE_REPOS env var when set', async () => {
    controller = buildController({
      MYSTICAT_WORKSPACE_REPOS: 'adobe/custom-repo-a, adobe/custom-repo-b',
    });

    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.workspace_repos).to.deep.equal([
      'adobe/custom-repo-a',
      'adobe/custom-repo-b',
    ]);
  });

  it('does not warn or debug at construction (constructor is side-effect-free)', () => {
    const freshLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };
    WebhooksController({
      sqs: mockSqs,
      log: freshLog,
      env: { MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl },
    });
    expect(freshLog.warn.called).to.be.false;
    expect(freshLog.debug.called).to.be.false;
  });

  it('uses defaults at debug (not warn) when MYSTICAT_WORKSPACE_REPOS is not set', async () => {
    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.workspace_repos).to.deep.equal([
      'adobe/mysticat-architecture',
      'adobe/mysticat-ai-native-guidelines',
      'Adobe-AEM-Sites/aem-sites-architecture',
    ]);
    const notSetWarn = mockLog.warn.getCalls()
      .find((c) => c.args[0].includes('MYSTICAT_WORKSPACE_REPOS not set'));
    expect(notSetWarn, 'unset path must not warn').to.be.undefined;
    const notSetDebug = mockLog.debug.getCalls()
      .find((c) => c.args[0].includes('MYSTICAT_WORKSPACE_REPOS not set'));
    expect(notSetDebug, 'unset path should debug-log').to.not.be.undefined;
  });

  it('filters invalid entries from MYSTICAT_WORKSPACE_REPOS and logs warning', async () => {
    controller = buildController({
      MYSTICAT_WORKSPACE_REPOS: 'adobe/valid, not-a-valid-repo, other/valid',
    });

    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.workspace_repos).to.deep.equal(['adobe/valid', 'other/valid']);

    const invalidWarn = mockLog.warn.getCalls()
      .find((c) => c.args[0].includes('invalid entries'));
    expect(invalidWarn).to.not.be.undefined;
    expect(invalidWarn.args[1].invalid).to.deep.equal(['not-a-valid-repo']);
  });

  it('falls back to defaults when MYSTICAT_WORKSPACE_REPOS has only invalid entries', async () => {
    controller = buildController({
      MYSTICAT_WORKSPACE_REPOS: 'not-a-valid-repo, another-bad-one',
    });

    await controller.processGitHubWebhook(validContext);

    const [, payload] = mockSqs.sendMessage.firstCall.args;
    expect(payload.workspace_repos).to.deep.equal([
      'adobe/mysticat-architecture',
      'adobe/mysticat-ai-native-guidelines',
      'Adobe-AEM-Sites/aem-sites-architecture',
    ]);
    const fallbackWarn = mockLog.warn.getCalls()
      .find((c) => c.args[0].includes('no valid entries'));
    expect(fallbackWarn).to.not.be.undefined;
  });

  it('enqueues without GITHUB_APP_SLUG configured (app-slug requirement removed)', async () => {
    controller = buildController(); // env carries no GITHUB_APP_SLUG

    const response = await controller.processGitHubWebhook(validContext);

    expect(response.status).to.equal(202);
    expect(mockSqs.sendMessage.calledOnce).to.be.true;
  });

  it('returns 500 and logs error when the auth profile has no reviewer_login (fail closed)', async () => {
    const ctx = {
      ...validContext,
      attributes: {
        authInfo: { getProfile: () => ({ user_id: 'github-webhook', target_id: 'github-public' }) },
      },
    };

    const response = await controller.processGitHubWebhook(ctx);

    expect(response.status).to.equal(500);
    const errorCall = mockLog.error.getCalls()
      .find((c) => c.args[0].includes('No reviewer login resolved'));
    expect(errorCall).to.not.be.undefined;
    expect(errorCall.args[1]).to.deep.include({ deliveryId: 'delivery-uuid-123' });
    expect(mockSqs.sendMessage.called).to.be.false;
  });

  it('logs structured skip reason (not interpolated) for untrusted event header', async () => {
    const context = {
      ...validContext,
      pathInfo: {
        headers: { ...validContext.pathInfo.headers, 'x-github-event': 'evil\ninjected' },
      },
    };

    await controller.processGitHubWebhook(context);

    expect(mockLog.info.calledOnce).to.be.true;
    // Message text must NOT contain the injected value
    expect(mockLog.info.firstCall.args[0]).to.equal('Skipping unmapped event');
    // Injected value goes to structured context, not message
    expect(mockLog.info.firstCall.args[1]).to.deep.include({ event: 'evil\ninjected' });
  });

  describe('multi-destination target_id', () => {
    function ghecAuthContext() {
      // Mirrors what the HMAC handler attaches: target_id + reviewer_login.
      return {
        ...validContext,
        attributes: {
          authInfo: { getProfile: () => ({ user_id: 'github-webhook', target_id: 'ghec', reviewer_login: 'emu_reviewer' }) },
        },
        data: {
          ...validContext.data,
          requested_reviewer: { login: 'emu_reviewer' },
        },
      };
    }

    it('adds target_id from the auth profile to the SQS payload', async () => {
      const response = await controller.processGitHubWebhook(ghecAuthContext());
      expect(response.status).to.equal(202);
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.target_id).to.equal('ghec');
    });

    it('enqueues a non-default destination when the requested reviewer matches its reviewer_login', async () => {
      // Positive per-destination gate: the profile reviewer_login (emu_reviewer)
      // matches the requested reviewer, so the trigger fires (202). This is the
      // successor to the removed global/app-slug reviewer resolution.
      const response = await controller.processGitHubWebhook(ghecAuthContext());
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
    });

    it('logs the resolved target id on the enqueue log', async () => {
      await controller.processGitHubWebhook(ghecAuthContext());
      const enqueueLog = mockLog.info.getCalls().find((c) => c.args[0] === 'Enqueued webhook job');
      expect(enqueueLog, 'expected an "Enqueued webhook job" info log').to.exist;
      expect(enqueueLog.args[1]).to.include({ targetId: 'ghec' });
    });

    it('skips when the requested reviewer does not match the profile reviewer_login', async () => {
      const ctx = {
        ...validContext,
        attributes: {
          authInfo: {
            getProfile: () => ({
              user_id: 'github-webhook', target_id: 'ghec', reviewer_login: 'emu_reviewer',
            }),
          },
        },
        data: { ...validContext.data, requested_reviewer: { login: 'someone-else' } },
      };

      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
    });
  });

  describe('Slack observability', () => {
    const channel = 'C0123ABCDEF';
    // Module-scoped: the mocked client factory's postMessage delegates to this,
    // and each test reassigns it (default success in beforeEach) before posting.
    let postMessage;
    // Module-scoped: the mocked rate limiter returns this; tests flip it.
    let rateLimited;
    let MockedController;

    before(async () => {
      const mod = await esmock('../../src/controllers/webhooks.js', {
        '../../src/support/slack/observability-client.js': {
          createObservabilitySlackClient: ({ token, channel: ch }) => ({
            enabled: Boolean(token && ch),
            postMessage: (...args) => postMessage(...args),
          }),
        },
        '../../src/support/slack/observability-rate-limit.js': {
          shouldRateLimitSlackPost: () => rateLimited,
        },
      });
      // esmock returns the module namespace; the controller is the default export.
      MockedController = mod.default;
    });

    beforeEach(() => {
      // Default: a successful parent post returning a thread ts (string).
      postMessage = sandbox.stub().resolves('1716200000.000300');
      rateLimited = false;
    });

    function buildObsController(envOverrides = {}) {
      const context = {
        sqs: mockSqs,
        log: mockLog,
        env: {
          MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl,
          MYSTICAT_OBSERVABILITY_SLACK_TOKEN: 'xoxb-test',
          MYSTICAT_OBSERVABILITY_SLACK_CHANNEL: channel,
          ...envOverrides,
        },
      };
      return MockedController(context);
    }

    it('posts the parent and includes observability with thread_ts on enqueue', async () => {
      const obsController = buildObsController();
      const response = await obsController.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);
      // parent posted before enqueue
      expect(postMessage.calledOnce).to.be.true;
      expect(postMessage.calledBefore(mockSqs.sendMessage)).to.be.true;
      const postArg = postMessage.firstCall.args[0];
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
      const obsController = buildObsController();
      const response = await obsController.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.observability).to.deep.equal({ slack_channel: channel });
      expect(payload.observability.slack_thread_ts).to.be.undefined;
    });

    it('posts a standalone note for a Mysticat-targeted skip (draft PR), no enqueue', async () => {
      const obsController = buildObsController();
      const ctx = {
        ...validContext,
        data: {
          ...validContext.data,
          pull_request: { ...validContext.data.pull_request, draft: true },
        },
      };
      const response = await obsController.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
      expect(postMessage.calledOnce).to.be.true;
      expect(postMessage.firstCall.args[0].text).to.include(':fast_forward:');
      expect(postMessage.firstCall.args[0].text).to.include('draft PR');
    });

    it('does NOT post for a foreign-reviewer skip', async () => {
      const obsController = buildObsController();
      const ctx = {
        ...validContext,
        data: {
          ...validContext.data,
          requested_reviewer: { login: 'some-human' },
        },
      };
      const response = await obsController.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
      expect(postMessage.called).to.be.false;
    });

    it('omits observability entirely when Slack channel is not configured', async () => {
      const obsController = buildObsController({ MYSTICAT_OBSERVABILITY_SLACK_CHANNEL: undefined });
      const response = await obsController.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);
      expect(postMessage.called).to.be.false;
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.observability).to.be.undefined;
    });

    it('does not post or attach observability when rate-limited', async () => {
      rateLimited = true;
      const obsController = buildObsController();
      const response = await obsController.processGitHubWebhook(validContext);
      expect(response.status).to.equal(202);
      expect(postMessage.called).to.be.false;
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.observability).to.be.undefined;
    });

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
  });

  describe('EMF metrics', () => {
    let emitMetricStub;
    let MockedEmfController;

    before(async () => {
      emitMetricStub = sinon.stub();
      const mod = await esmock('../../src/controllers/webhooks.js', {
        '../../src/support/metrics-emf.js': {
          emitMetric: emitMetricStub,
          resolveEnvironment: () => 'dev',
        },
      });
      MockedEmfController = mod.default;
    });

    beforeEach(() => {
      emitMetricStub.reset();
    });

    function buildEmfController(envOverrides = {}) {
      return MockedEmfController({
        sqs: mockSqs,
        log: mockLog,
        env: {
          MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl,
          ...envOverrides,
        },
      });
    }

    it('success path emits WebhookReceived, WebhookEnqueued, and WebhookProcessingMillis', async () => {
      const emfController = buildEmfController();
      const response = await emfController.processGitHubWebhook(validContext);

      expect(response.status).to.equal(202);

      const names = emitMetricStub.getCalls().map((c) => c.args[0].name);
      expect(names).to.include('WebhookReceived');
      expect(names).to.include('WebhookEnqueued');
      expect(names).to.include('WebhookProcessingMillis');

      const enqueued = emitMetricStub.getCalls().find((c) => c.args[0].name === 'WebhookEnqueued');
      expect(enqueued.args[0].dimensions).to.deep.include({
        JobType: 'pr-review',
        TargetId: 'github-public',
      });

      const millis = emitMetricStub.getCalls().find((c) => c.args[0].name === 'WebhookProcessingMillis');
      expect(millis.args[0].dimensions).to.deep.include({ Outcome: 'enqueued' });
      expect(millis.args[0].unit).to.equal('Milliseconds');
    });

    it('draft PR skip emits WebhookSkipped with SkipReason draft_pr', async () => {
      const emfController = buildEmfController();
      const ctx = {
        ...validContext,
        data: {
          ...validContext.data,
          pull_request: { ...validContext.data.pull_request, draft: true },
        },
      };
      const response = await emfController.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      const skipped = emitMetricStub.getCalls().find((c) => c.args[0].name === 'WebhookSkipped');
      expect(skipped).to.exist;
      expect(skipped.args[0].dimensions).to.deep.include({ SkipReason: 'draft_pr' });
    });

    it('SQS failure emits WebhookEnqueueFailure and returns 500', async () => {
      mockSqs.sendMessage.rejects(new Error('SQS timeout'));
      const emfController = buildEmfController();
      const response = await emfController.processGitHubWebhook(validContext);

      expect(response.status).to.equal(500);
      const failure = emitMetricStub.getCalls().find((c) => c.args[0].name === 'WebhookEnqueueFailure');
      expect(failure).to.exist;
    });

    it('missing action field emits WebhookBadRequest with MissingField action', async () => {
      const emfController = buildEmfController();
      const ctx = {
        ...validContext,
        data: { ...validContext.data, action: undefined },
      };
      const response = await emfController.processGitHubWebhook(ctx);

      expect(response.status).to.equal(400);
      const bad = emitMetricStub.getCalls().find((c) => c.args[0].name === 'WebhookBadRequest');
      expect(bad).to.exist;
      expect(bad.args[0].dimensions).to.deep.include({ MissingField: 'action' });
    });
  });
});
