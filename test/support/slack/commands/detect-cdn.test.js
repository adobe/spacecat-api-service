/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use it except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
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

  beforeEach(async function beforeEachHook() {
    this.timeout(10000);
    extractURLFromSlackInputStub = sinon.stub();
    postErrorMessageStub = sinon.stub().resolves();

    DetectCdnCommand = (await esmock(
      '../../../../src/support/slack/commands/detect-cdn.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
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
    const { env, ...contextWithoutEnv } = context;
    const command = DetectCdnCommand(contextWithoutEnv);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('missing `AUDIT_JOBS_QUEUE_URL`');
  });

  it('notifies when SQS client is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    const command = DetectCdnCommand({
      ...context,
      sqs: null,
    });

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('missing SQS client');
  });

  it('says queued and sends SQS message when URL is valid and no site found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('Queued CDN detection for *https://example.com*');
    expect(sqsStub.sendMessage).to.have.been.calledOnce;
    expect(sqsStub.sendMessage.firstCall.args[0]).to.equal('https://sqs.example.com/queue');
    expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.equal({
      type: 'detect-cdn',
      baseURL: 'https://example.com',
      slackContext: {
        channelId: 'C123',
        threadTs: '1712345678.9012',
      },
    });
  });

  it('includes siteId in SQS payload when site is found for base URL', async () => {
    extractURLFromSlackInputStub.returns('https://mysite.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getId: () => 'site-uuid-123',
    });
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://mysite.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(sqsStub.sendMessage).to.have.been.calledOnce;
    expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({
      type: 'detect-cdn',
      baseURL: 'https://mysite.com',
      siteId: 'site-uuid-123',
      slackContext: {
        channelId: 'C123',
        threadTs: '1712345678.9012',
      },
    });
  });

  it('still queues job without siteId when Site.findByBaseURL throws', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.rejects(new Error('db error'));
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnce;
    expect(slackContext.say.firstCall.args[0]).to.include('Queued CDN detection');
    expect(sqsStub.sendMessage).to.have.been.calledOnce;
    expect(sqsStub.sendMessage.firstCall.args[1]).to.not.have.property('siteId');
    expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({
      type: 'detect-cdn',
      baseURL: 'https://example.com',
      slackContext: {
        channelId: 'C123',
        threadTs: '1712345678.9012',
      },
    });
  });

  it('logs and posts error when an exception occurs in handleExecution', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    sqsStub.sendMessage.rejects(new Error('SQS failure'));
    const command = DetectCdnCommand(context);

    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledTwice; // once "Queued...", then error
    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
    expect(postErrorMessageStub.firstCall.args[0]).to.equal(slackContext.say);
    expect(postErrorMessageStub.firstCall.args[1]).to.be.instanceOf(Error);
  });
});
