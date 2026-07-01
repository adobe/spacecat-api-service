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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { comparePage } from '../../src/utils/prerender-compare.js';

use(sinonChai);

const TEST_URL = 'https://example.com/';
const TEST_URL_PATH = 'https://example.com/about';

const SIMPLE_HTML = '<html><body><p>Hello world foo bar baz</p></body></html>';

/**
 * Build a fake Response object that mimics the Fetch API Response.
 */
function makeResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

describe('prerender-compare utility', () => {
  const sandbox = sinon.createSandbox();
  let mockLog;
  let mockS3Client;
  let MockGetObjectCommand;
  let fetchStub;

  beforeEach(() => {
    mockLog = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    MockGetObjectCommand = sandbox.stub().callsFake((params) => ({ input: params }));

    mockS3Client = {
      send: sandbox.stub(),
    };

    // Stub globalThis.fetch so comparePage's fetch() call is intercepted
    fetchStub = sandbox.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Lambda 403 → FAILURE_BLOCKED', () => {
    it('returns FAILURE_BLOCKED with lambdaError when lambda returns 403', async () => {
      fetchStub.resolves(makeResponse(403, 'Forbidden'));

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.pageStatus).to.equal('FAILURE_BLOCKED');
      expect(result.lambdaError).to.equal('403 Forbidden');
      expect(result.s3WordCount).to.equal(0);
      expect(result.lambdaWordCount).to.equal(0);
      expect(result.wordCountDiff).to.equal(0);
      expect(result.diffMatchPct).to.equal(0);
      expect(result.s3Error).to.be.null;
      expect(mockS3Client.send).not.to.have.been.called;
    });
  });

  describe('Lambda non-403 error → FAILURE_CONTENT', () => {
    it('returns FAILURE_CONTENT with lambdaError when lambda returns 500', async () => {
      fetchStub.resolves(makeResponse(500, 'Internal Server Error'));

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.pageStatus).to.equal('FAILURE_CONTENT');
      expect(result.lambdaError).to.equal('HTTP 500');
      expect(result.s3Error).to.be.null;
      expect(result.s3WordCount).to.equal(0);
      expect(result.lambdaWordCount).to.equal(0);
    });

    it('returns FAILURE_CONTENT with lambdaError when lambda fetch throws a network error', async () => {
      fetchStub.rejects(new Error('connection refused'));

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.pageStatus).to.equal('FAILURE_CONTENT');
      expect(result.lambdaError).to.include('connection refused');
      expect(result.s3Error).to.be.null;
      expect(result.s3WordCount).to.equal(0);
      expect(result.lambdaWordCount).to.equal(0);
    });
  });

  describe('S3 fetch error → FAILURE_CONTENT', () => {
    it('returns FAILURE_CONTENT with s3Error when S3 fetch fails', async () => {
      fetchStub.resolves(makeResponse(200, SIMPLE_HTML));
      mockS3Client.send.rejects(new Error('NoSuchKey'));

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.pageStatus).to.equal('FAILURE_CONTENT');
      expect(result.s3Error).to.equal('NoSuchKey');
      expect(result.lambdaError).to.be.null;
      expect(result.s3WordCount).to.equal(0);
      expect(result.lambdaWordCount).to.equal(0);
    });
  });

  describe('diffMatchPct >= 90 → SUCCESS', () => {
    it('returns SUCCESS when content is identical', async () => {
      fetchStub.resolves(makeResponse(200, SIMPLE_HTML));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => SIMPLE_HTML },
      });

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.pageStatus).to.equal('SUCCESS');
      expect(result.diffMatchPct).to.be.at.least(90);
      expect(result.s3Error).to.be.null;
      expect(result.lambdaError).to.be.null;
      expect(result.url).to.equal(TEST_URL);
    });

    it('derives correct S3 key for root path (/) → /index.html', async () => {
      fetchStub.resolves(makeResponse(200, SIMPLE_HTML));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => SIMPLE_HTML },
      });

      await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      const commandArg = MockGetObjectCommand.firstCall.args[0];
      expect(commandArg.Key).to.equal('example.com/index.html');
      expect(commandArg.Bucket).to.equal('test-bucket');
    });

    it('derives correct S3 key for non-root path', async () => {
      fetchStub.resolves(makeResponse(200, SIMPLE_HTML));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => SIMPLE_HTML },
      });

      await comparePage(
        TEST_URL_PATH,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      const commandArg = MockGetObjectCommand.firstCall.args[0];
      expect(commandArg.Key).to.equal('example.com/about.html');
    });
  });

  describe('diffMatchPct < 90 → FAILURE_CONTENT', () => {
    it('returns FAILURE_CONTENT when content differs significantly', async () => {
      // S3: short content; Lambda: very different, much longer content
      const s3Html = '<html><body><p>hello world</p></body></html>';
      const lambdaHtml = '<html><body><p>completely different text that has nothing in common with the original content whatsoever and adds many more words</p></body></html>';

      fetchStub.resolves(makeResponse(200, lambdaHtml));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => s3Html },
      });

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.pageStatus).to.equal('FAILURE_CONTENT');
      expect(result.diffMatchPct).to.be.below(90);
      expect(result.lambdaError).to.be.null;
      expect(result.s3Error).to.be.null;
    });
  });

  describe('metric computations', () => {
    it('returns all required metric fields', async () => {
      fetchStub.resolves(makeResponse(200, SIMPLE_HTML));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => SIMPLE_HTML },
      });

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result).to.have.property('s3WordCount');
      expect(result).to.have.property('lambdaWordCount');
      expect(result).to.have.property('wordCountDiff');
      expect(result).to.have.property('wordCountPctDiff');
      expect(result).to.have.property('diffAddCount');
      expect(result).to.have.property('diffDelCount');
      expect(result).to.have.property('diffSameCount');
      expect(result).to.have.property('diffMatchPct');
      expect(result.wordCountDiff).to.equal(result.lambdaWordCount - result.s3WordCount);
    });

    it('sets wordCountPctDiff to 0 when s3WordCount is 0', async () => {
      const emptyS3Html = '<html><body></body></html>';
      const lambdaHtmlWithWords = '<html><body><p>hello world foo</p></body></html>';

      fetchStub.resolves(makeResponse(200, lambdaHtmlWithWords));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => emptyS3Html },
      });

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.wordCountPctDiff).to.equal(0);
    });

    it('returns diffMatchPct of 100 when content is identical', async () => {
      const html = '<html><body><p>hello world</p></body></html>';

      fetchStub.resolves(makeResponse(200, html));
      mockS3Client.send.resolves({
        Body: { transformToString: async () => html },
      });

      const result = await comparePage(
        TEST_URL,
        mockS3Client,
        MockGetObjectCommand,
        'test-bucket',
        mockLog,
      );

      expect(result.diffMatchPct).to.equal(100);
      expect(result.pageStatus).to.equal('SUCCESS');
    });
  });
});
