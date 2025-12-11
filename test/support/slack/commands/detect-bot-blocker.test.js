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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('DetectBotBlockerCommand', () => {
  let DetectBotBlockerCommand;
  let detectBotBlockerStub;
  let postErrorMessageStub;
  let extractURLFromSlackInputStub;
  let context;
  let slackContext;

  const loadModule = async () => {
    detectBotBlockerStub = sinon.stub();
    postErrorMessageStub = sinon.stub().resolves();
    extractURLFromSlackInputStub = sinon.stub().callsFake((value) => value);

    ({ default: DetectBotBlockerCommand } = await esmock(
      '../../../../src/support/slack/commands/detect-bot-blocker.js',
      {
        '@adobe/spacecat-shared-utils': {
          detectBotBlocker: detectBotBlockerStub,
          isValidUrl: (url) => url.startsWith('http'),
        },
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
        },
      },
    ));
  };

  beforeEach(async function () {
    this.timeout(5000);
    await loadModule();

    context = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'C123',
      threadTs: '123.456',
    };
  });

  it('displays usage when no arguments are provided', async () => {
    const command = DetectBotBlockerCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(detectBotBlockerStub).to.not.have.been.called;
  });

  it('displays usage when the provided URL is invalid', async () => {
    extractURLFromSlackInputStub.returns('not-a-url');
    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['not-a-url'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch('valid URL');
    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(detectBotBlockerStub).to.not.have.been.called;
  });

  it('detects Cloudflare bot blocker', async () => {
    detectBotBlockerStub.resolves({
      crawlable: false,
      type: 'cloudflare',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(detectBotBlockerStub).to.have.been.calledWith({ baseUrl: 'https://example.com' });
    expect(slackContext.say).to.have.been.calledWithMatch(':mag: Checking bot blocker');
    expect(slackContext.say).to.have.been.calledWithMatch('Cloudflare');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
    expect(slackContext.say).to.have.been.calledWithMatch(':no_entry:');
  });

  it('detects Imperva bot blocker', async () => {
    detectBotBlockerStub.resolves({
      crawlable: false,
      type: 'imperva',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Imperva/Incapsula');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
  });

  it('detects HTTP/2 blocking', async () => {
    detectBotBlockerStub.resolves({
      crawlable: false,
      type: 'http2-block',
      confidence: 0.95,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('HTTP/2 Stream Error');
    expect(slackContext.say).to.have.been.calledWithMatch('95%');
  });

  it('reports no blocker detected', async () => {
    detectBotBlockerStub.resolves({
      crawlable: true,
      type: 'none',
      confidence: 1.0,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('No Blocker Detected');
    expect(slackContext.say).to.have.been.calledWithMatch('100%');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('reports unknown status', async () => {
    detectBotBlockerStub.resolves({
      crawlable: true,
      type: 'unknown',
      confidence: 0.5,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Unknown');
    expect(slackContext.say).to.have.been.calledWithMatch('50%');
  });

  it('handles errors from detectBotBlocker', async () => {
    const error = new Error('Network error');
    detectBotBlockerStub.rejects(error);

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'detect-bot-blocker command: failed for URL https://example.com',
      error,
    );
    expect(postErrorMessageStub).to.have.been.calledWith(slackContext.say, error);
  });

  it('uses correct confidence emoji for high confidence', async () => {
    detectBotBlockerStub.resolves({
      crawlable: false,
      type: 'cloudflare',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(':muscle:');
  });

  it('uses correct confidence emoji for medium confidence', async () => {
    detectBotBlockerStub.resolves({
      crawlable: true,
      type: 'unknown',
      confidence: 0.5,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(':thinking_face:');
  });

  it('uses correct confidence emoji for low confidence', async () => {
    detectBotBlockerStub.resolves({
      crawlable: true,
      type: 'unknown',
      confidence: 0.3,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(':question:');
  });
});
