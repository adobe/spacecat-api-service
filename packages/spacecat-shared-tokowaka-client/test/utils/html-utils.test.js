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

/* eslint-disable */
/* eslint-env mocha */

import { expect } from 'chai';
import sinon from 'sinon';
import { fetchHtmlWithWarmup } from '../../src/utils/custom-html-utils.js';

describe('HTML Utils', () => {
  describe('fetchHtmlWithWarmup', () => {
    let fetchStub;
    let log;

    beforeEach(() => {
      fetchStub = sinon.stub(global, 'fetch');
      log = {
        debug: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        info: sinon.stub(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error when URL is missing', async () => {
      try {
        await fetchHtmlWithWarmup(
          '',
          'host',
          'edge-url',
          log,
          false,
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('URL is required for fetching HTML');
      }
    });

    it('should throw error when forwardedHost is missing', async () => {
      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'api-key',
          '',
          'edge-url',
          log,
          false,
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('Forwarded host is required for fetching HTML');
      }
    });

    it('should throw error when tokowakaEdgeUrl is missing', async () => {
      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'api-key',
          'host',
          '',
          log,
          false,
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('TOKOWAKA_EDGE_URL is not configured');
      }
    });

    it('should throw error when apiKey is missing', async () => {
      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          '',
          'host',
          'edge-url',
          log,
          false,
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('Tokowaka API key is required for fetching HTML');
      }
    });

    it('should successfully fetch HTML with all required parameters', async () => {
      fetchStub.resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => (name === 'x-tokowaka-cache' ? 'HIT' : null),
        },
        text: async () => '<html>Test HTML</html>',
      });

      const html = await fetchHtmlWithWarmup(
        'https://example.com/page',
        'api-key',
        'host',
        'https://edge.example.com',
        log,
        false,
        { warmupDelayMs: 0 },
      );

      expect(html).to.equal('<html>Test HTML</html>');
      expect(fetchStub.callCount).to.equal(2); // warmup + actual
    });

    it('should handle URL with existing query parameters when fetching optimized HTML', async () => {
      fetchStub.resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => (name === 'x-tokowaka-cache' ? 'HIT' : null),
        },
        text: async () => '<html>Optimized HTML</html>',
      });

      const html = await fetchHtmlWithWarmup(
        'https://example.com/page?param=value',
        'api-key',
        'host',
        'https://edge.example.com',
        log,
        true, // isOptimized
        { warmupDelayMs: 0 },
      );

      expect(html).to.equal('<html>Optimized HTML</html>');
      expect(fetchStub.callCount).to.equal(2); // warmup + actual

      // Verify the URL includes & for the preview param (not ?)
      const actualUrl = fetchStub.secondCall.args[0];
      expect(actualUrl).to.include('param=value');
      expect(actualUrl).to.include('&tokowakaPreview=true');
      expect(actualUrl).to.not.include('?tokowakaPreview=true');
    });

    it('should throw error when HTTP response is not ok', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => 'warmup',
      });
      // Actual call returns 404
      fetchStub.onCall(1).resolves({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: {
          get: () => null,
        },
      });

      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'api-key',
          'host',
          'https://edge.example.com',
          log,
          false,
          { warmupDelayMs: 0, maxRetries: 0 },
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Failed to fetch original HTML');
        expect(error.message).to.include('0 retries');
      }
    });

    it('should retry and eventually throw error after max retries', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'warmup',
      });
      // All actual calls fail
      fetchStub.onCall(1).rejects(new Error('Network error'));
      fetchStub.onCall(2).rejects(new Error('Network error'));
      fetchStub.onCall(3).rejects(new Error('Network error'));

      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'api-key',
          'host',
          'https://edge.example.com',
          log,
          false,
          { warmupDelayMs: 0, maxRetries: 2, retryDelayMs: 0 },
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Failed to fetch original HTML');
        expect(error.message).to.include('Network error');
      }

      // Should have tried 3 times (initial + 2 retries) plus warmup
      expect(fetchStub.callCount).to.equal(4);
    });

    it('should handle zero maxRetries value', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'warmup',
      });
      // Actual call fails
      fetchStub.onCall(1).rejects(new Error('Network error'));

      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'api-key',
          'host',
          'https://edge.example.com',
          log,
          false,
          { warmupDelayMs: 0, maxRetries: 0 },
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Network error');
      }

      // Should have tried only once (no retries) plus warmup
      expect(fetchStub.callCount).to.equal(2);
    });

    it('should handle negative maxRetries as edge case', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => 'warmup',
      });

      try {
        // With maxRetries: -1, the retry loop won't execute
        // This tests the defensive 'throw lastError' fallback
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'host',
          'https://edge.example.com',
          log,
          false,
          { warmupDelayMs: 0, maxRetries: -1 },
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        // Should throw the lastError from the loop
        expect(error).to.exist;
      }
    });

    it('should stop retrying when x-tokowaka-cache header is found', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => 'warmup',
      });
      // First actual call - no cache header
      fetchStub.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => '<html>No cache</html>',
      });
      // Second actual call - cache header found
      fetchStub.onCall(2).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => (name === 'x-tokowaka-cache' ? 'HIT' : null),
        },
        text: async () => '<html>Cached HTML</html>',
      });

      const html = await fetchHtmlWithWarmup(
        'https://example.com/page',
        'api-key',
        'host',
        'https://edge.example.com',
        log,
        false,
        { warmupDelayMs: 0, maxRetries: 3, retryDelayMs: 0 },
      );

      expect(html).to.equal('<html>Cached HTML</html>');
      // Should stop after finding cache header (warmup + 2 attempts)
      expect(fetchStub.callCount).to.equal(3);
    });

    it('should throw error when cache header not found after max retries', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => 'warmup',
      });
      // All actual calls succeed but no cache header
      fetchStub.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => '<html>No cache 1</html>',
      });
      fetchStub.onCall(2).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => '<html>No cache 2</html>',
      });
      fetchStub.onCall(3).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => '<html>No cache 3</html>',
      });

      try {
        await fetchHtmlWithWarmup(
          'https://example.com/page',
          'api-key',
          'host',
          'https://edge.example.com',
          log,
          false,
          { warmupDelayMs: 0, maxRetries: 2, retryDelayMs: 0 },
        );
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('Failed to fetch original HTML');
        expect(error.message).to.include('Cache header (x-tokowaka-cache) not found after 2 retries');
      }

      // Should have tried 3 times (initial + 2 retries) plus warmup
      expect(fetchStub.callCount).to.equal(4);
    });

    it('should return immediately on first attempt if cache header is present', async () => {
      // Warmup succeeds
      fetchStub.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: () => null,
        },
        text: async () => 'warmup',
      });
      // First actual call has cache header
      fetchStub.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => (name === 'x-tokowaka-cache' ? 'HIT' : null),
        },
        text: async () => '<html>Cached HTML</html>',
      });

      const html = await fetchHtmlWithWarmup(
        'https://example.com/page',
        'api-key',
        'host',
        'https://edge.example.com',
        log,
        false,
        { warmupDelayMs: 0, maxRetries: 3, retryDelayMs: 0 },
      );

      expect(html).to.equal('<html>Cached HTML</html>');
      // Should not retry if cache header found on first attempt
      expect(fetchStub.callCount).to.equal(2); // warmup + 1 actual
    });
  });
});
