/*
 * Copyright 2013 Adobe. All rights reserved.
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
/* eslint-disable no-use-before-define */

import wrap from '@adobe/helix-shared-wrap';
import sinon from 'sinon';
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import crypto from 'crypto';
import { SendMessageCommand, GetQueueUrlCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import sqsWrapper, { SQS } from '../../src/support/sqs.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('sqs', () => {
  let context;
  const AWS_REGION = 'us-east-1';
  const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue';

  beforeEach('setup', () => {
    context = {
      log: console,
      runtime: {
        region: AWS_REGION,
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('do not initialize a new sqs if already initialized', async () => {
    const instance = {
      sendMessage: sandbox.stub().resolves(),
    };
    context.sqs = instance;

    await wrap(async (req, ctx) => {
      await ctx.sqs.sendMessage(QUEUE_URL, 'message');
    }).with(sqsWrapper)({}, context);

    expect(instance.sendMessage).to.have.been.calledOnce;
  });

  it('message sending fails', async () => {
    const errorResponse = {
      type: 'Sender',
      code: 'InvalidParameterValue',
      message: 'invalid param',
    };
    const errorSpy = sandbox.spy(context.log, 'error');

    nock('https://sqs.us-east-1.amazonaws.com')
      .post('/')
      .reply(400, errorResponse);

    const action = wrap(async (req, ctx) => {
      await ctx.sqs.sendMessage(QUEUE_URL, { key: 'value' });
    }).with(sqsWrapper);

    await expect(action({}, context)).to.be.rejectedWith(errorResponse.message);

    const errorMessage = `Message sent failed. Type: ${errorResponse.type}, Code: ${errorResponse.code}, Message: ${errorResponse.message}`;
    expect(errorSpy).to.have.been.calledWith(errorMessage);
  });

  it('purging queue fails', async () => {
    const errorResponse = {
      type: 'Sender',
      code: 'InvalidParameterValue',
      message: 'invalid param',
    };
    const errorSpy = sandbox.spy(context.log, 'error');

    nock('https://sqs.us-east-1.amazonaws.com')
      .post('/')
      .reply(400, errorResponse);

    const action = wrap(async (req, ctx) => {
      await ctx.sqs.purgeQueue('https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue');
    }).with(sqsWrapper);

    await expect(action({}, context)).to.be.rejectedWith(errorResponse.message);

    const errorMessage = `Queue purge failed. Type: ${errorResponse.type}, Code: ${errorResponse.code}, Message: ${errorResponse.message}`;
    expect(errorSpy).to.have.been.calledWith(errorMessage);
  });

  it('purging queue is successful', async () => {
    const logSpy = sandbox.spy(context.log, 'info');

    nock('https://sqs.us-east-1.amazonaws.com')
      .post('/')
      .reply(200, {});

    await wrap(async (req, ctx) => {
      await ctx.sqs.purgeQueue(QUEUE_URL);
    }).with(sqsWrapper)({}, context);

    expect(logSpy).to.have.been.calledWith(`Success, queue purged. QueueUrl: ${QUEUE_URL}`);
  });

  it('initialize and use a new sqs if not initialized before', async () => {
    const messageId = 'message-id';
    const message = { key: 'value' };
    const logSpy = sandbox.spy(context.log, 'info');

    nock('https://sqs.us-east-1.amazonaws.com')
      .post('/')
      .reply(200, (_, body) => {
        const { MessageBody, QueueUrl } = JSON.parse(body);
        expect(QueueUrl).to.equal(QUEUE_URL);
        expect(JSON.parse(MessageBody).key).to.equal(message.key);
        return {
          MessageId: 'message-id',
          MD5OfMessageBody: crypto.createHash('md5').update(MessageBody, 'utf-8').digest('hex'),
        };
      });

    await wrap(async (req, ctx) => {
      await ctx.sqs.sendMessage(QUEUE_URL, message);
    }).with(sqsWrapper)({}, context);

    expect(logSpy).to.have.been.calledWith(`Success, message sent. MessageID:  ${messageId}`);
  });

  describe('Named queues', () => {
    let sqs;
    let sendStub;

    beforeEach(() => {
      sqs = new SQS(AWS_REGION, console);
      sendStub = sinon.stub(sqs.sqsClient, 'send')
        .callsFake(console.warn.bind(null, 'Unexpected Command')) // eslint-disable-line no-console -- useful for debugging tests
        .withArgs(matchCmd(new GetQueueUrlCommand({ QueueName: 'the-queue-name' })))
        .resolves({ QueueUrl: QUEUE_URL });
    });

    it('supports sending to named queues', async () => {
      // @ts-ignore
      const expectedCmd = matchCmd(new SendMessageCommand({ QueueUrl: QUEUE_URL }));
      sendStub
        .withArgs(expectedCmd)
        .resolves({ MessageId: 'arbitrary' });
      await sqs.sendMessage('the-queue-name', { value: 1234 });
      expect(sqs.sqsClient.send).to.have.been.calledWith(expectedCmd);
    });

    it('supports purging named queues', async () => {
      const expectedCmd = matchCmd(new PurgeQueueCommand({ QueueUrl: QUEUE_URL }));
      sendStub
        .withArgs(expectedCmd)
        .resolves();
      await sqs.purgeQueue('the-queue-name');
      expect(sqs.sqsClient.send).to.have.been.calledWith(expectedCmd);
    });

    it('errors if AWS does not return a queue URL', async () => {
      sendStub
        .withArgs(matchCmd(new GetQueueUrlCommand({ QueueName: 'queue-that-does-not-exist' })))
        .resolves({ QueueUrl: undefined });

      await expect(sqs.sendMessage('queue-that-does-not-exist', { value: 1234 }))
        .to.be.rejectedWith('Unknown queue name: queue-that-does-not-exist');
    });
  });
});

/**
 * @param {{input: any}} cmd
 */
function matchCmd({ constructor, input }) {
  return sinon.match.instanceOf(constructor).and(sinon.match({ input: sinon.match(input) }));
}
