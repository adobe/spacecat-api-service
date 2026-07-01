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
import esmock from 'esmock';

use(sinonChai);

describe('PrerenderValidationController', () => {
  const sandbox = sinon.createSandbox();
  let PrerenderValidationController;
  let comparePageStub;
  let mockContext;

  before(async () => {
    comparePageStub = sandbox.stub();

    PrerenderValidationController = await esmock(
      '../../src/controllers/prerender-validation.js',
      {
        '../../src/utils/prerender-compare.js': {
          comparePage: comparePageStub,
        },
      },
    );
  });

  beforeEach(() => {
    comparePageStub.reset();

    mockContext = {
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub(),
        debug: sandbox.stub(),
      },
      env: {
        S3_SCRAPER_BUCKET: 'test-scraper-bucket',
      },
      s3: {
        s3Client: { send: sandbox.stub() },
        GetObjectCommand: sandbox.stub(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws when context is not provided', () => {
    expect(() => PrerenderValidationController(null)).to.throw('Context required');
  });

  it('throws when s3 is missing from context', () => {
    expect(() => PrerenderValidationController({ env: { S3_SCRAPER_BUCKET: 'bucket' } })).to.throw('S3 client required');
  });

  it('throws when env is missing from context', () => {
    expect(() => PrerenderValidationController({
      s3: { s3Client: {}, GetObjectCommand: sinon.stub() },
    })).to.throw('Environment object required');
  });

  describe('compare', () => {
    let controller;

    beforeEach(() => {
      controller = PrerenderValidationController(mockContext);
    });

    it('returns 400 when url is missing from body', async () => {
      const response = await controller.compare({ data: {} });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when body itself is missing', async () => {
      const response = await controller.compare({ data: null });
      expect(response.status).to.equal(400);
    });

    it('returns 400 when url is not a valid URL', async () => {
      const response = await controller.compare({ data: { url: 'not-a-url' } });
      expect(response.status).to.equal(400);
    });

    it('returns 200 with FAILURE_BLOCKED result when comparePage returns FAILURE_BLOCKED', async () => {
      const mockResult = {
        url: 'https://example.com/',
        pageStatus: 'FAILURE_BLOCKED',
        lambdaError: '403 Forbidden',
        s3WordCount: 0,
        lambdaWordCount: 0,
        wordCountDiff: 0,
        wordCountPctDiff: 0,
        diffAddCount: 0,
        diffDelCount: 0,
        diffSameCount: 0,
        diffMatchPct: 0,
        s3Error: null,
      };
      comparePageStub.resolves(mockResult);

      const response = await controller.compare({ data: { url: 'https://example.com/' } });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.pageStatus).to.equal('FAILURE_BLOCKED');
      expect(body.lambdaError).to.equal('403 Forbidden');
      expect(comparePageStub).to.have.been.calledOnce;
    });

    it('returns 200 with FAILURE_CONTENT result when S3 fetch fails', async () => {
      const mockResult = {
        url: 'https://example.com/page',
        pageStatus: 'FAILURE_CONTENT',
        s3Error: 'NoSuchKey',
        lambdaError: null,
        s3WordCount: 0,
        lambdaWordCount: 0,
        wordCountDiff: 0,
        wordCountPctDiff: 0,
        diffAddCount: 0,
        diffDelCount: 0,
        diffSameCount: 0,
        diffMatchPct: 0,
      };
      comparePageStub.resolves(mockResult);

      const response = await controller.compare({ data: { url: 'https://example.com/page' } });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.pageStatus).to.equal('FAILURE_CONTENT');
      expect(body.s3Error).to.equal('NoSuchKey');
    });

    it('returns 200 with SUCCESS result when diffMatchPct >= 90', async () => {
      const mockResult = {
        url: 'https://example.com/',
        pageStatus: 'SUCCESS',
        s3WordCount: 100,
        lambdaWordCount: 105,
        wordCountDiff: 5,
        wordCountPctDiff: 0.05,
        diffAddCount: 5,
        diffDelCount: 2,
        diffSameCount: 98,
        diffMatchPct: 98.0,
        s3Error: null,
        lambdaError: null,
      };
      comparePageStub.resolves(mockResult);

      const response = await controller.compare({ data: { url: 'https://example.com/' } });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.pageStatus).to.equal('SUCCESS');
      expect(body.diffMatchPct).to.equal(98.0);
    });

    it('returns 200 with FAILURE_CONTENT result when diffMatchPct < 90', async () => {
      const mockResult = {
        url: 'https://example.com/heavy-changes',
        pageStatus: 'FAILURE_CONTENT',
        s3WordCount: 200,
        lambdaWordCount: 50,
        wordCountDiff: -150,
        wordCountPctDiff: 0.75,
        diffAddCount: 10,
        diffDelCount: 150,
        diffSameCount: 50,
        diffMatchPct: 25.0,
        s3Error: null,
        lambdaError: null,
      };
      comparePageStub.resolves(mockResult);

      const response = await controller.compare({ data: { url: 'https://example.com/heavy-changes' } });
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body.pageStatus).to.equal('FAILURE_CONTENT');
      expect(body.diffMatchPct).to.equal(25.0);
    });

    it('passes correct arguments to comparePage', async () => {
      comparePageStub.resolves({
        url: 'https://example.com/',
        pageStatus: 'SUCCESS',
        s3Error: null,
        lambdaError: null,
      });

      await controller.compare({ data: { url: 'https://example.com/' } });

      const [
        passedUrl, passedS3Client, passedGetObjectCommand, passedBucket, passedLog,
      ] = comparePageStub.firstCall.args;
      expect(passedUrl).to.equal('https://example.com/');
      expect(passedS3Client).to.equal(mockContext.s3.s3Client);
      expect(passedGetObjectCommand).to.equal(mockContext.s3.GetObjectCommand);
      expect(passedBucket).to.equal('test-scraper-bucket');
      expect(passedLog).to.equal(mockContext.log);
    });
  });
});
