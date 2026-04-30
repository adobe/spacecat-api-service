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

  function buildController(envOverrides = {}) {
    const context = {
      sqs: mockSqs,
      log: mockLog,
      env: {
        MYSTICAT_GITHUB_JOBS_QUEUE_URL: queueUrl,
        GITHUB_APP_SLUG: 'mysticat',
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

  it('logs structured skip reason (not interpolated) for untrusted event header', async () => {
    const context = {
      ...validContext,
      headers: { ...validContext.headers, 'x-github-event': 'evil\ninjected' },
    };

    await controller.processGitHubWebhook(context);

    expect(mockLog.info.calledOnce).to.be.true;
    // Message text must NOT contain the injected value
    expect(mockLog.info.firstCall.args[0]).to.equal('Skipping unmapped event');
    // Injected value goes to structured context, not message
    expect(mockLog.info.firstCall.args[1]).to.deep.include({ event: 'evil\ninjected' });
  });
});
