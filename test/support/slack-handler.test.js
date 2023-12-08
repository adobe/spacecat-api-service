/*
 * Copyright 2023 Adobe. All rights reserved.
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

import chai from 'chai';
import sinon from 'sinon';

import SlackHandler from '../../src/support/slack/slack-handler.js';

const { expect } = chai;

describe('Slack Handler', async () => {
  const sandbox = sinon.createSandbox();

  let slackHandler;
  let logStub;
  let sayStub;

  beforeEach(() => {
    logStub = {
      debug: sandbox.stub(),
      error: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
    };

    sayStub = sandbox.stub().resolves();

    slackHandler = SlackHandler(logStub);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('has expected properties', async () => {
    expect(slackHandler).to.have.property('onAppMention');
  });

  it('responds via app_mention in thread', async () => {
    await slackHandler.onAppMention({
      event: { user: 'test-user', thread_ts: 1609459200.0002 },
      say: sayStub,
      context: {},
    });

    expect(sayStub.calledOnce).to.be.true;
    expect(sayStub.firstCall.firstArg).to.deep.equal({
      text: 'Hello, <@test-user>!',
      thread_ts: 1609459200.0002,
    });
    expect(logStub.info.calledOnce).to.be.true;
  });

  it('responds via app_mention outside of thread', async () => {
    await slackHandler.onAppMention({
      event: { user: 'test-user', ts: 1609459200.0002 },
      say: sayStub,
      context: {},
    });

    expect(sayStub.calledOnce).to.be.true;
    expect(sayStub.firstCall.firstArg).to.deep.equal({
      text: 'Hello, <@test-user>!',
      thread_ts: 1609459200.0002,
    });
    expect(logStub.info.calledOnce).to.be.true;
  });
});
