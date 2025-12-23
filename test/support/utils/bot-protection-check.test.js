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
      warn: sinon.stub(),
      debug: sinon.stub(),
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

      fetchStub.callsFake((url) => {
        // Homepage returns challenge
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({
              'content-type': 'text/html',
              server: 'cloudflare',
              'cf-ray': '12345',
            }),
            text: sinon.stub().resolves(challengeHtml),
          });
        }
        // Other URLs return 404
        return Promise.resolve({
          status: 404,
          headers: new Headers({}),
          text: sinon.stub().resolves('Not Found'),
        });
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

      fetchStub.callsFake((_) => Promise.resolve({
        status: 200,
        headers: new Headers({
          'content-type': 'text/html',
        }),
        text: sinon.stub().resolves(normalHtml),
      }));

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

    it('treats 403 fetch errors as bot protection', async () => {
      const baseUrl = 'https://zepbound.lilly.com';
      const error = new Error('fetch failed with status 403');
      error.status = 403;

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http-error');
      expect(result.confidence).to.equal(0.7);
      expect(result.reason).to.include('HTTP error suggests bot protection');
      expect(log.error).to.have.been.calledOnce;
    });

    it('treats 401 fetch errors as bot protection', async () => {
      const baseUrl = 'https://example.com';
      const error = new Error('401 Unauthorized');

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http-error');
      expect(result.confidence).to.equal(0.7);
      expect(result.reason).to.include('HTTP error suggests bot protection');
    });

    it('treats Forbidden errors as bot protection', async () => {
      const baseUrl = 'https://example.com';
      const error = new Error('Forbidden');

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http-error');
      expect(result.confidence).to.equal(0.7);
      expect(result.reason).to.include('HTTP error suggests bot protection');
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

    it('handles errors with undefined message', async () => {
      const baseUrl = 'https://example.com';
      const error = new Error();
      delete error.message; // Make message undefined

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.false;
      expect(result.type).to.equal('unknown');
      expect(result.confidence).to.equal(0);
      expect(result.error).to.equal('');
    });

    it('handles errors with null message', async () => {
      const baseUrl = 'https://example.com';
      const error = new Error();
      error.message = null;

      fetchStub.rejects(error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.false;
      expect(result.type).to.equal('unknown');
      expect(result.confidence).to.equal(0);
      expect(result.error).to.equal('');
    });

    it('detects HTTP/2 error (NGHTTP2_INTERNAL_ERROR) on homepage', async () => {
      const baseUrl = 'https://bmw.fr';
      const http2Error = new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR');
      http2Error.code = 'NGHTTP2_INTERNAL_ERROR';

      fetchStub.rejects(http2Error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
      expect(result.details.failedRequests).to.be.an('array');
      expect(result.details.failedRequests[0].code).to.equal('NGHTTP2_INTERNAL_ERROR');
      expect(log.warn).to.have.been.calledWith(
        `HTTP/2 errors detected for ${baseUrl} - likely bot protection`,
      );
    });

    it('detects HTTP/2 error (ERR_HTTP2_STREAM_ERROR) on homepage', async () => {
      const baseUrl = 'https://example.com';
      const http2Error = new Error('HTTP/2 stream error');
      http2Error.code = 'ERR_HTTP2_STREAM_ERROR';

      fetchStub.rejects(http2Error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
    });

    it('detects HTTP/2 error on subsequent requests (robots.txt)', async () => {
      const baseUrl = 'https://bmw.fr';
      const normalHtml = '<html><head><title>Welcome</title></head><body><h1>BMW</h1></body></html>';

      fetchStub.callsFake((url) => {
        // Homepage succeeds
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
            text: sinon.stub().resolves(normalHtml),
          });
        }
        // robots.txt fails with HTTP/2 error
        const http2Error = new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR');
        http2Error.code = 'NGHTTP2_INTERNAL_ERROR';
        return Promise.reject(http2Error);
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
      expect(result.details.failedRequests).to.be.an('array');
      expect(result.details.failedRequests.length).to.be.greaterThan(0);
      expect(log.warn).to.have.been.calledWith(
        `HTTP/2 errors detected for ${baseUrl} - likely bot protection`,
      );
    });

    it('detects HTTP/2 error in error message (without code)', async () => {
      const baseUrl = 'https://example.com';
      const http2Error = new Error('Fetch failed: NGHTTP2_INTERNAL_ERROR stream closed');

      fetchStub.rejects(http2Error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
    });

    it('detects multiple HTTP/2 errors across requests', async () => {
      const baseUrl = 'https://example.com';
      const http2Error = new Error('HTTP2_STREAM_ERROR');
      http2Error.code = 'ERR_HTTP2_STREAM_ERROR';

      fetchStub.rejects(http2Error);

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
    });

    it('continues normally if only non-critical requests fail', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><head><title>Welcome</title></head><body><h1>Normal Site</h1><p>With plenty of content</p></body></html>';

      fetchStub.callsFake((url) => {
        // Homepage succeeds
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
            text: sinon.stub().resolves(normalHtml),
          });
        }
        // robots.txt and sitemap.xml fail with 404 (normal error, not HTTP/2)
        return Promise.resolve({
          status: 404,
          headers: new Headers({}),
          text: sinon.stub().resolves('Not Found'),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.false;
      expect(result.type).to.equal('none');
    });

    it('detects HTTP/2 error after Promise.allSettled completes', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><head><title>Welcome</title></head><body><h1>Normal Site</h1></body></html>';
      const http2Error = new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR');
      http2Error.code = 'NGHTTP2_INTERNAL_ERROR';

      fetchStub.callsFake((url) => {
        // Homepage fails with HTTP/2 error in text()
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
            text: sinon.stub().rejects(http2Error),
          });
        }
        // Other URLs succeed
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
      expect(result.details.failedRequests).to.be.an('array');
      expect(result.details.failedRequests[0].code).to.equal('NGHTTP2_INTERNAL_ERROR');
      expect(log.warn).to.have.been.calledWith(
        `HTTP/2 errors detected for ${baseUrl} - likely bot protection`,
      );
    });

    it('detects HTTP error (403) in outer catch block', async () => {
      const baseUrl = 'https://example.com';
      const error403 = new Error('Request failed with status 403');
      error403.status = 403;

      fetchStub.callsFake((url) => {
        // Homepage returns response but text() throws 403 error
        if (url === baseUrl) {
          return Promise.resolve({
            status: 403,
            headers: new Headers({}),
            text: sinon.stub().rejects(error403),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves('OK'),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http-error');
      expect(result.confidence).to.equal(0.7);
      expect(result.reason).to.include('HTTP error suggests bot protection');
      expect(log.warn).to.have.been.calledWith(
        `HTTP error suggests bot protection for ${baseUrl}`,
      );
    });

    it('detects HTTP error (401) message in outer catch block', async () => {
      const baseUrl = 'https://example.com';
      const error401 = new Error('401 Unauthorized');

      fetchStub.callsFake((url) => {
        // Homepage returns response but text() throws 401 error
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({}),
            text: sinon.stub().rejects(error401),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves('OK'),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http-error');
      expect(result.confidence).to.equal(0.7);
      expect(result.reason).to.include('HTTP error suggests bot protection');
    });

    it('detects Forbidden error in outer catch block', async () => {
      const baseUrl = 'https://example.com';
      const forbiddenError = new Error('Forbidden');

      fetchStub.callsFake((url) => {
        // Homepage returns response but text() throws Forbidden error
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({}),
            text: sinon.stub().rejects(forbiddenError),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves('OK'),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http-error');
      expect(result.confidence).to.equal(0.7);
      expect(result.reason).to.include('HTTP error suggests bot protection');
    });

    it('detects HTTP/2 error with ERR_HTTP2_STREAM_CANCEL code in outer catch', async () => {
      const baseUrl = 'https://example.com';
      const http2Error = new Error('HTTP/2 stream cancelled');
      http2Error.code = 'ERR_HTTP2_STREAM_CANCEL';

      fetchStub.callsFake((url) => {
        // Homepage returns response but text() throws HTTP/2 error
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({}),
            text: sinon.stub().rejects(http2Error),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves('OK'),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
    });

    it('detects HTTP/2 error when analyzeBotProtection accesses response properties that throw', async () => {
      const baseUrl = 'https://example.com';
      const http2Error = new Error('ERR_HTTP2_STREAM_ERROR accessing response');
      http2Error.code = 'ERR_HTTP2_STREAM_ERROR';
      const normalHtml = '<html><body>Normal content</body></html>';

      fetchStub.callsFake((url) => {
        if (url === baseUrl) {
          // Create response with getter that throws when analyzeBotProtection accesses .status
          return Promise.resolve({
            get status() { throw http2Error; },
            headers: new Headers({}),
            text: sinon.stub().resolves(normalHtml),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
      expect(log.warn).to.have.been.calledWith(
        `HTTP/2 error detected for ${baseUrl} - likely bot protection`,
      );
    });

    it('detects HTTP/2 error with NGHTTP2 in message during analysis', async () => {
      const baseUrl = 'https://example.com';
      const http2Error = new Error('Stream error: NGHTTP2_INTERNAL_ERROR');
      const normalHtml = '<html><body>Content</body></html>';

      fetchStub.callsFake((url) => {
        if (url === baseUrl) {
          // Response succeeds but accessing headers throws
          return Promise.resolve({
            status: 200,
            get headers() { throw http2Error; },
            text: sinon.stub().resolves(normalHtml),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
      expect(result.reason).to.include('NGHTTP2_INTERNAL_ERROR');
    });

    it('detects HTTP/2 error in homepage check when first filter misses it', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><body>Content</body></html>';

      // Create an error that will initially appear as non-HTTP/2
      // but will be detected by the second check
      const subtleError = new Error('Request failed');
      // Don't set error.code initially

      let firstCall = true;
      fetchStub.callsFake((url) => {
        if (url === baseUrl) {
          if (firstCall) {
            firstCall = false;
            // Return a promise that will be "rejected" status in allSettled
            // but with an error that doesn't have HTTP/2 patterns initially
            return Promise.resolve({
              status: 200,
              headers: new Headers({}),
              text: sinon.stub().rejects(subtleError),
            });
          }
        }
        // Other requests succeed
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      // Now modify the error to have HTTP/2 code after the stub is set up
      // This simulates an error object that gets modified or has different properties
      // when checked the second time
      subtleError.code = 'ERR_HTTP2_STREAM_CANCEL';

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP/2 connection error');
      // When caught by first filter, code is in failedRequests array
      expect(result.details.failedRequests).to.be.an('array');
      expect(result.details.failedRequests[0].code).to.equal('ERR_HTTP2_STREAM_CANCEL');
      expect(log.warn).to.have.been.calledWith(
        `HTTP/2 errors detected for ${baseUrl} - likely bot protection`,
      );
    });

    it('detects HTTP/2 error in homepage check via message pattern only', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><body>Content</body></html>';

      // Create error with HTTP/2 in message but no code (initially)
      // The first filter might miss this if the message isn't checked properly
      const messageError = new Error('Connection terminated: HTTP2_STREAM_ERROR detected');
      // NO error.code set

      fetchStub.callsFake((url) => {
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({}),
            text: sinon.stub().rejects(messageError),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('HTTP2_STREAM_ERROR');
    });

    it('uses fallback reason when error message is undefined', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><body>Content</body></html>';

      // Create error with HTTP/2 code but NO message
      const noMessageError = new Error();
      delete noMessageError.message; // Remove message
      noMessageError.code = 'NGHTTP2_INTERNAL_ERROR';

      fetchStub.callsFake((url) => {
        if (url === baseUrl) {
          return Promise.resolve({
            status: 200,
            headers: new Headers({}),
            text: sinon.stub().rejects(noMessageError),
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9);
      expect(result.reason).to.include('bot blocking detected');
    });

    it('detects HTTP/2 errors on locale paths with lower confidence', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><body>Content</body></html>';
      const http2Error = new Error('Stream closed');
      http2Error.code = 'ERR_HTTP2_STREAM_CANCEL';

      fetchStub.callsFake((url) => {
        if (url.includes('/fr/') || url.includes('/en/')) {
          // Locale paths fail with HTTP/2 error
          return Promise.reject(http2Error);
        }
        // Homepage and other paths succeed
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.7); // Lower confidence since only optional paths fail
      expect(result.reason).to.include('HTTP/2 errors on locale paths');
    });

    it('prioritizes critical path failures over optional path failures', async () => {
      const baseUrl = 'https://example.com';
      const normalHtml = '<html><body>Content</body></html>';
      const http2Error = new Error('Stream closed');
      http2Error.code = 'NGHTTP2_INTERNAL_ERROR';

      fetchStub.callsFake((url) => {
        if (url.includes('/robots.txt') || url.includes('/fr/')) {
          // Critical path (robots.txt) and optional path (locale) fail
          return Promise.reject(http2Error);
        }
        // Homepage succeeds
        return Promise.resolve({
          status: 200,
          headers: new Headers({}),
          text: sinon.stub().resolves(normalHtml),
        });
      });

      const result = await checkBotProtectionDuringOnboarding(baseUrl, log);

      expect(result.blocked).to.be.true;
      expect(result.type).to.equal('http2-block');
      expect(result.confidence).to.equal(0.9); // Higher confidence due to critical path failure
      expect(result.reason).not.to.include('only optional'); // Should not say "only optional"
    });
  });
});
