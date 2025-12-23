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
  let checkBotProtectionStub;
  let postErrorMessageStub;
  let extractURLFromSlackInputStub;
  let context;
  let slackContext;

  const loadModule = async () => {
    checkBotProtectionStub = sinon.stub();
    postErrorMessageStub = sinon.stub().resolves();
    extractURLFromSlackInputStub = sinon.stub().callsFake((value) => value);

    ({ default: DetectBotBlockerCommand } = await esmock(
      '../../../../src/support/slack/commands/detect-bot-blocker.js',
      {
        '@adobe/spacecat-shared-utils': {
          isValidUrl: (url) => url.startsWith('http'),
        },
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
        },
        '../../../../src/support/utils/bot-protection-check.js': {
          checkBotProtectionDuringOnboarding: checkBotProtectionStub,
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
    expect(checkBotProtectionStub).to.not.have.been.called;
  });

  it('displays usage when the provided URL is invalid', async () => {
    extractURLFromSlackInputStub.returns('not-a-url');
    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['not-a-url'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch('valid URL');
    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(checkBotProtectionStub).to.not.have.been.called;
  });

  it('detects Cloudflare bot blocker', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'cloudflare',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(checkBotProtectionStub).to.have.been.calledWith('https://example.com', context.log);
    expect(slackContext.say).to.have.been.calledWithMatch(':mag: Checking bot blocker');
    expect(slackContext.say).to.have.been.calledWithMatch('Cloudflare');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
    expect(slackContext.say).to.have.been.calledWithMatch(':no_entry:');
  });

  it('detects Imperva bot blocker', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'imperva',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Imperva/Incapsula');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
  });

  it('detects HTTP/2 blocking', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'http2-block',
      confidence: 0.95,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('HTTP/2 Stream Error');
    expect(slackContext.say).to.have.been.calledWithMatch('95%');
  });

  it('reports no blocker detected', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
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
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'unknown',
      confidence: 0.5,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Unknown');
    expect(slackContext.say).to.have.been.calledWithMatch('50%');
  });

  it('handles errors from checkBotProtectionDuringOnboarding', async () => {
    const error = new Error('Network error');
    checkBotProtectionStub.rejects(error);

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'detect-bot-blocker command: failed for URL https://example.com',
      error,
    );
    expect(postErrorMessageStub).to.have.been.calledWith(slackContext.say, error);
  });

  it('uses correct confidence emoji for high confidence', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'cloudflare',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(':muscle:');
  });

  it('uses correct confidence emoji for medium confidence', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'unknown',
      confidence: 0.5,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(':thinking_face:');
  });

  it('uses correct confidence emoji for low confidence', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'unknown',
      confidence: 0.3,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch(':question:');
  });

  it('detects Akamai bot blocker', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'akamai',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Akamai');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
    expect(slackContext.say).to.have.been.calledWithMatch(':no_entry:');
  });

  it('detects Fastly bot blocker', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'fastly',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Fastly');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
    expect(slackContext.say).to.have.been.calledWithMatch(':no_entry:');
  });

  it('detects CloudFront bot blocker', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'cloudfront',
      confidence: 0.99,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('AWS CloudFront');
    expect(slackContext.say).to.have.been.calledWithMatch('99%');
    expect(slackContext.say).to.have.been.calledWithMatch(':no_entry:');
  });

  it('detects Cloudflare infrastructure (allowed)', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'cloudflare-allowed',
      confidence: 1.0,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Cloudflare (Allowed)');
    expect(slackContext.say).to.have.been.calledWithMatch('100%');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('detects Imperva infrastructure (allowed)', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'imperva-allowed',
      confidence: 1.0,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Imperva (Allowed)');
    expect(slackContext.say).to.have.been.calledWithMatch('100%');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('detects Akamai infrastructure (allowed)', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'akamai-allowed',
      confidence: 1.0,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Akamai (Allowed)');
    expect(slackContext.say).to.have.been.calledWithMatch('100%');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('detects Fastly infrastructure (allowed)', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'fastly-allowed',
      confidence: 1.0,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Fastly (Allowed)');
    expect(slackContext.say).to.have.been.calledWithMatch('100%');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('detects CloudFront infrastructure (allowed)', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'cloudfront-allowed',
      confidence: 1.0,
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('AWS CloudFront (Allowed)');
    expect(slackContext.say).to.have.been.calledWithMatch('100%');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('displays reason when provided', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'cloudflare',
      confidence: 0.9,
      reason: 'Challenge page detected despite 200 status',
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Challenge page detected despite 200 status');
    expect(slackContext.say).to.have.been.calledWithMatch(':information_source:');
  });

  it('displays details when provided', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'cloudflare-allowed',
      confidence: 1.0,
      details: {
        httpStatus: 200,
        htmlSize: 15000,
      },
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('*Details:*');
    expect(slackContext.say).to.have.been.calledWithMatch('HTTP Status: 200');
    expect(slackContext.say).to.have.been.calledWithMatch('HTML Size: 15000 bytes');
  });

  it('displays both reason and details when both provided', async () => {
    checkBotProtectionStub.resolves({
      blocked: true,
      type: 'http-error',
      confidence: 0.7,
      reason: 'HTTP error suggests bot protection: 403 Forbidden',
      details: {
        httpStatus: 403,
        error: '403 Forbidden',
      },
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('HTTP error suggests bot protection');
    expect(slackContext.say).to.have.been.calledWithMatch('*Details:*');
    expect(slackContext.say).to.have.been.calledWithMatch('HTTP Status: 403');
  });

  it('handles missing httpStatus in details', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'cloudflare-allowed',
      confidence: 1.0,
      details: {
        htmlSize: 15000,
      },
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('*Details:*');
    expect(slackContext.say).to.have.been.calledWithMatch('HTML Size: 15000 bytes');
    expect(slackContext.say).to.not.have.been.calledWithMatch('HTTP Status:');
  });

  it('handles missing htmlSize in details', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'cloudflare-allowed',
      confidence: 1.0,
      details: {
        httpStatus: 200,
      },
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('*Details:*');
    expect(slackContext.say).to.have.been.calledWithMatch('HTTP Status: 200');
    expect(slackContext.say).to.not.have.been.calledWithMatch('HTML Size:');
  });

  it('handles confidence of 0 (falsy but valid)', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'unknown',
      confidence: 0,
      error: 'Network error',
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('N/A%');
    expect(slackContext.say).to.have.been.calledWithMatch('Unknown');
    expect(slackContext.say).to.have.been.calledWithMatch(':white_check_mark:');
  });

  it('handles undefined confidence', async () => {
    checkBotProtectionStub.resolves({
      blocked: false,
      type: 'unknown',
    });

    const command = DetectBotBlockerCommand(context);
    await command.handleExecution(['https://example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('N/A%');
  });
});
