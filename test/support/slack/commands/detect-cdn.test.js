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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('DetectCdnCommand', () => {
  let DetectCdnCommand;
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let extractURLFromSlackInputStub;
  let postErrorMessageStub;
  let queueDetectCdnAuditStub;

  beforeEach(async function beforeEachHook() {
    this.timeout(10000);
    extractURLFromSlackInputStub = sinon.stub();
    postErrorMessageStub = sinon.stub().callsFake(async (sayFn, err) => {
      await sayFn(`:nuclear-warning: Oops! Something went wrong: ${err.message}`);
    });
    queueDetectCdnAuditStub = sinon.stub().resolves({ ok: true });

    DetectCdnCommand = (await esmock(
      '../../../../src/support/slack/commands/detect-cdn.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
        },
        '../../../../src/support/utils.js': {
          queueDetectCdnAudit: queueDetectCdnAuditStub,
        },
      },
    )).default;

    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub(),
      },
    };

    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };

    context = {
      dataAccess: dataAccessStub,
      env: { AUDIT_JOBS_QUEUE_URL: 'https://sqs.example.com/queue' },
      log: {
        error: sinon.spy(),
      },
      sqs: sqsStub,
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'C123',
      threadTs: '1712345678.9012',
    };
  });

  it('initializes with base command metadata', () => {
    const command = DetectCdnCommand(context);
    expect(command.id).to.equal('detect-cdn');
    expect(command.name).to.equal('Detect CDN');
    expect(command.phrases).to.deep.equal(['detect-cdn']);
    expect(command.usageText).to.equal('detect-cdn {url}');
  });

  it('shows usage when URL is missing/invalid', async () => {
    extractURLFromSlackInputStub.returns(null);
    const command = DetectCdnCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(command.usage());
  });

  it('notifies when AUDIT_JOBS_QUEUE_URL is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    queueDetectCdnAuditStub.resolves({
      ok: false,
      error: ':x: Server misconfiguration: missing `AUDIT_JOBS_QUEUE_URL`.',
    });
    const command = DetectCdnCommand({
      ...context,
      env: {},
    });

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('missing `AUDIT_JOBS_QUEUE_URL`');
  });

  it('notifies when env is undefined', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    queueDetectCdnAuditStub.resolves({
      ok: false,
      error: ':x: Server misconfiguration: missing `AUDIT_JOBS_QUEUE_URL`.',
    });
    const { env: _, ...contextWithoutEnv } = context;
    const command = DetectCdnCommand(contextWithoutEnv);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('missing `AUDIT_JOBS_QUEUE_URL`');
  });

  it('notifies when SQS client is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    queueDetectCdnAuditStub.resolves({
      ok: false,
      error: ':x: Server misconfiguration: missing SQS client.',
    });
    const command = DetectCdnCommand({
      ...context,
      sqs: null,
    });

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('missing SQS client');
  });

  it('delegates to queueDetectCdnAudit when URL is valid and no site found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(queueDetectCdnAuditStub).to.have.been.calledOnce;
    expect(queueDetectCdnAuditStub.firstCall.args[0]).to.deep.include({
      baseURL: 'https://example.com',
      site: null,
      slackContext,
    });
    expect(queueDetectCdnAuditStub.firstCall.args[1]).to.equal(context);
  });

  it('passes site to queueDetectCdnAudit when site is found for base URL', async () => {
    extractURLFromSlackInputStub.returns('https://mysite.com');
    const mockSite = { getId: () => 'site-uuid-123' };
    dataAccessStub.Site.findByBaseURL.resolves(mockSite);
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://mysite.com'], slackContext);

    expect(queueDetectCdnAuditStub).to.have.been.calledOnce;
    expect(queueDetectCdnAuditStub.firstCall.args[0]).to.deep.include({
      baseURL: 'https://mysite.com',
      site: mockSite,
      slackContext,
    });
  });

  it('still queues when Site.findByBaseURL throws (site null)', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.rejects(new Error('db error'));
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(queueDetectCdnAuditStub).to.have.been.calledOnce;
    expect(queueDetectCdnAuditStub.firstCall.args[0]).to.deep.include({
      baseURL: 'https://example.com',
      site: null,
      slackContext,
    });
  });

  it('logs and posts error when queueDetectCdnAudit throws', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    queueDetectCdnAuditStub.rejects(new Error('SQS failure'));
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
    expect(postErrorMessageStub.firstCall.args[0]).to.equal(slackContext.say);
    expect(postErrorMessageStub.firstCall.args[1]).to.be.instanceOf(Error);
  });
});
