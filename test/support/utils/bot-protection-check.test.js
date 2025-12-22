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
import { checkBotProtectionDuringOnboarding } from '../../../src/support/utils/bot-protection-check.js';

use(sinonChai);

describe('Bot Protection Check', () => {
  let log;
  let fetchStub;
  let originalFetch;

  before(() => {
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    global.fetch = originalFetch;

    log = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    fetchStub = sinon.stub();
    global.fetch = fetchStub;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkBotProtectionDuringOnboarding', () => {
    it('detects bot protection when challenge page is returned', async () => {
      const baseUrl = 'https://example.com';
      const challengeHtml = '<html><head><title>Just a moment...</title></head><body><div class="cf-challenge-running"></div></body></html>';

      fetchStub.resolves({
        status: 200,
        headers: new Headers({
          'content-type': 'text/html',
          server: 'cloudflare',
          'cf-ray': '12345',
        }),
        text: sinon.stub().resolves(challengeHtml),
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('cloudflare');
      expect(result.confidence).to.be.greaterThan(0.8);
      expect(result.details.httpStatus).to.equal(200);
      expect(result.details.htmlSize).to.equal(challengeHtml.length);
      expect(log.info).to.have.been.calledWith(
        `Performing lightweight bot protection check for ${baseUrl}`,
      );
    });

    it('detects no bot protection when site returns normal content', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><head><title>Welcome</title></head><body><h1>Hello World</h1><p>This is normal content with plenty of text to avoid being flagged as suspiciously short.</p></body></html>';

      fetchStub.resolves({
        status: 200,
        headers: new Headers({
          'content-type': 'text/html',
        }),
        text: sinon.stub().resolves(normalHtml),
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.false;
      expect(result.type).to.equal('none');
      expect(result.details.httpStatus).to.equal(200);
      expect(log.info).to.have.been.calledWith(
        `Bot protection check complete for ${baseUrl}`,
        sinon.match({
          crawlable: true,
          type: 'none',
          confidence: 1,
        }),
      );
    });

    it('detects bot protection with 403 status', async () => {
      const baseUrl = 'https://example.com';

      fetchStub.resolves({
        status: 403,
        headers: new Headers({
          server: 'cloudflare',
          'cf-ray': '12345',
        }),
        text: sinon.stub().resolves('Forbidden'),
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('cloudflare');
      expect(result.details.httpStatus).to.equal(403);
    });

    it('handles fetch errors gracefully (fail open)', async () => {
      const baseUrl = 'https://example.com';
      const error = new Error('Network error');

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.false;
      expect(result.type).to.equal('unknown');
      expect(result.confidence).to.equal(0);
      expect(result.error).to.equal('Network error');
      expect(log.error).to.have.been.calledWith(
        `Bot protection check failed for ${baseUrl}:`,
        error,
      );
    });

    it('handles timeout errors gracefully', async () => {
      const baseUrl = 'https://example.com';
      const error = new Error('The operation was aborted');

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.false;
      expect(result.type).to.equal('unknown');
      expect(result.error).to.equal('The operation was aborted');
    });

    it('includes reason when provided by analyzeBotProtection', async () => {
      const baseUrl = 'https://example.com';
      const challengeHtml = '<html><head><title>Just a moment...</title></head><body>Challenge page</body></html>';

      fetchStub.resolves({
        status: 200,
        headers: new Headers({
          server: 'cloudflare',
        }),
        text: sinon.stub().resolves(challengeHtml),
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.reason).to.exist;
    });
  });
});
