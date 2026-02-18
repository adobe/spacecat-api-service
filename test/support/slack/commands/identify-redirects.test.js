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

describe('IdentifyRedirectsCommand', () => {
  const SiteModelStub = {
    AUTHORING_TYPES: {
      CS: 'CS',
      CS_CW: 'CS_CW',
    },
  };

  let IdentifyRedirectsCommand;
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

    IdentifyRedirectsCommand = (await esmock(
      '../../../../src/support/slack/commands/identify-redirects.js',
      {
        '@adobe/spacecat-shared-data-access': { Site: SiteModelStub },
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
      env: { AUDIT_JOBS_QUEUE_URL: 'testQueueUrl' },
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
    const command = IdentifyRedirectsCommand(context);
    expect(command.id).to.equal('identify-redirects');
    expect(command.name).to.equal('Identify Redirects');
    expect(command.phrases).to.deep.equal(['identify-redirects']);
  });

  it('shows usage when baseURL is missing/invalid', async () => {
    extractURLFromSlackInputStub.returns(null);
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(command.usage());
  });

  it('notifies when site is not found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ":x: No site found with base URL 'https://example.com'.",
    );
  });

  it('rejects non CS/CW authoring types', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => 'AMS',
      getDeliveryConfig: () => ({ programId: 'p', environmentId: 'e' }),
      getId: () => 'site-1',
    });
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(
      'identify-redirects currently supports AEM CS/CW only',
    );
    expect(slackContext.say).to.have.been.calledWithMatch('`AMS`');
  });

  it('warns when deliveryConfig is missing programId/environmentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => SiteModelStub.AUTHORING_TYPES.CS,
      getDeliveryConfig: () => ({ programId: '', environmentId: 'e' }),
      getId: () => 'site-1',
    });
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(
      'missing `deliveryConfig.programId` and/or `deliveryConfig.environmentId`',
    );
  });

  it('warns when getDeliveryConfig is not available on the site', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => SiteModelStub.AUTHORING_TYPES.CS,
      getId: () => 'site-1',
    });
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(
      'missing `deliveryConfig.programId` and/or `deliveryConfig.environmentId`',
    );
  });

  it('fails when AUDIT_JOBS_QUEUE_URL is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => SiteModelStub.AUTHORING_TYPES.CS_CW,
      getDeliveryConfig: () => ({ programId: 'p', environmentId: 'e' }),
      getId: () => 'site-1',
    });

    const command = IdentifyRedirectsCommand({
      ...context,
      env: {},
    });

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(
      'missing `AUDIT_JOBS_QUEUE_URL`',
    );
  });

  it('fails when SQS client is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => SiteModelStub.AUTHORING_TYPES.CS_CW,
      getDeliveryConfig: () => ({ programId: 'p', environmentId: 'e' }),
      getId: () => 'site-1',
    });

    const command = IdentifyRedirectsCommand({
      ...context,
      sqs: null,
    });

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(
      'missing SQS client',
    );
  });

  it('enqueues a job with default minutes when minutes is omitted', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => SiteModelStub.AUTHORING_TYPES.CS,
      getDeliveryConfig: () => ({ programId: 'p', environmentId: 'e' }),
      getId: () => 'site-1',
    });
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Queued redirect pattern detection');
    expect(sqsStub.sendMessage).to.have.been.calledOnce;
    expect(sqsStub.sendMessage.firstCall.args[0]).to.equal('testQueueUrl');
    expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({
      type: 'identify-redirects',
      siteId: 'site-1',
      baseURL: 'https://example.com',
      programId: 'p',
      environmentId: 'e',
      minutes: 60,
    });
    expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({
      slackContext: {
        channelId: 'C123',
        threadTs: '1712345678.9012',
      },
    });
  });

  it('parses minutes and enqueues a job', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({
      getAuthoringType: () => SiteModelStub.AUTHORING_TYPES.CS_CW,
      getDeliveryConfig: () => ({ programId: 'p', environmentId: 'e' }),
      getId: () => 'site-1',
    });
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com', '15'], slackContext);

    expect(sqsStub.sendMessage).to.have.been.calledOnce;
    expect(sqsStub.sendMessage.firstCall.args[1]).to.deep.include({
      minutes: 15,
    });
  });

  it('logs and posts an error message when an exception occurs', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.rejects(new Error('boom'));
    const command = IdentifyRedirectsCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
    expect(postErrorMessageStub.firstCall.args[0]).to.equal(slackContext.say);
    expect(postErrorMessageStub.firstCall.args[1]).to.be.instanceOf(Error);
  });
});
