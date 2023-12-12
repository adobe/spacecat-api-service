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

describe('Slack Handler', () => {
  const sandbox = sinon.createSandbox();

  let slackHandler;
  let logStub;
  let slackContext;
  let commandsStub;

  beforeEach(() => {
    logStub = {
      info: sandbox.stub(),
    };

    slackContext = { say: sinon.spy() };

    commandsStub = [
      { accepts: sandbox.stub().returns(false), execute: sandbox.stub(), phrases: ['not-help'] },
      { accepts: sandbox.stub().returns(false), execute: sandbox.stub(), phrases: ['help'] },
    ];

    slackHandler = SlackHandler(commandsStub, logStub);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('executes the correct command when found', async () => {
    const matchingCommand = commandsStub[0];
    matchingCommand.accepts.returns(true);

    await slackHandler.onAppMention({
      event: { text: 'some-command', ts: '12345' },
      say: slackContext.say,
      context: {},
    });

    expect(matchingCommand.execute.calledOnce).to.be.true;
    expect(slackContext.say.called).to.be.false; // No default message should be sent
  });

  it('executes the help command if no command matches', async () => {
    const helpCommand = commandsStub[1];

    await slackHandler.onAppMention({
      event: { text: 'help', ts: '12345' },
      say: slackContext.say,
      context: {},
    });

    expect(helpCommand.execute.calledOnce).to.be.true;
  });

  it('sends a default message if no command matches and no help command found', async () => {
    await SlackHandler([], logStub).onAppMention({
      event: { text: 'unknown-command', ts: '12345' },
      say: slackContext.say,
      context: {},
    });

    expect(slackContext.say.calledOnce).to.be.true;
    expect(slackContext.say.firstCall.args[0]).to.include({
      text: 'Sorry, I am misconfigured, no commands found.',
    });
  });

  it('handles non-string message types correctly', async () => {
    const blockMessage = {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Bold text*',
          },
        },
      ],
    };

    // Mock command that uses the provided say function to send a block message
    const mockCommand = {
      accepts: () => true,
      execute: async (_, ctx) => {
        await ctx.say(blockMessage);
      },
      phrases: ['mock-command'],
    };

    commandsStub.push(mockCommand);

    await slackHandler.onAppMention({
      event: { text: 'mock-command', ts: '12345' },
      say: slackContext.say,
      context: {},
    });

    expect(slackContext.say.calledOnce).to.be.true;
    expect(slackContext.say.firstCall.args[0]).to.deep.equal({
      ...blockMessage,
      thread_ts: '12345',
    });
  });
});
