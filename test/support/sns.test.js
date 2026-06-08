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

import wrap from '@adobe/helix-shared-wrap';
import sinon from 'sinon';
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import snsWrapper, { SNS } from '../../src/support/sns.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('sns', () => {
  let context;
  const AWS_REGION = 'us-east-1';
  const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:spacecat-autofix-jobs';

  beforeEach('setup', () => {
    context = {
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      },
      runtime: {
        region: AWS_REGION,
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('does not initialize a new sns if already initialized', async () => {
    const instance = {
      publish: sandbox.stub().resolves(),
    };
    context.sns = instance;

    await wrap(async (req, ctx) => {
      await ctx.sns.publish(TOPIC_ARN, { key: 'value' });
    }).with(snsWrapper)({}, context);

    expect(instance.publish).to.have.been.calledOnce;
  });

  it('publishes message successfully', async () => {
    const sns = new SNS(AWS_REGION, context.log);
    const sendStub = sandbox.stub(sns.snsClient, 'send').resolves({ MessageId: 'msg-1' });

    await sns.publish(TOPIC_ARN, { siteId: 'site-1' });

    expect(sendStub).to.have.been.calledOnce;
    expect(sendStub.firstCall.args[0].constructor.name).to.equal('PublishCommand');
    expect(sendStub.firstCall.args[0].input.TopicArn).to.equal(TOPIC_ARN);
    expect(JSON.parse(sendStub.firstCall.args[0].input.Message)).to.deep.equal({ siteId: 'site-1' });
  });

  it('throws for invalid topic ARN', async () => {
    const sns = new SNS(AWS_REGION, context.log);

    await expect(sns.publish('spacecat-autofix-jobs', { a: 1 }))
      .to.be.rejectedWith('topicArn must be a valid SNS topic ARN');
  });

  it('logs and rethrows publish failures', async () => {
    const sns = new SNS(AWS_REGION, context.log);
    const err = new Error('denied');
    err.name = 'AuthorizationError';
    err.$metadata = { httpStatusCode: 403 };
    sandbox.stub(sns.snsClient, 'send').rejects(err);

    await expect(sns.publish(TOPIC_ARN, { key: 'value' })).to.be.rejectedWith('denied');
    expect(context.log.error).to.have.been.calledWith(
      'Publish failed. Type: AuthorizationError, HTTP: 403, Message: denied',
    );
  });
});
