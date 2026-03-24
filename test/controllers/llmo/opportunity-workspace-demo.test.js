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

const TEST_PRESIGNED_URL = 'https://s3.amazonaws.com/test-bucket/workspace/llmo/opportunity-workspace/demo/summit-demo-brand-presence.json?X-Amz-Signature=abc123';

const mockHttpUtils = {
  ok: (data) => ({ status: 200, json: async () => data }),
  notFound: (message) => ({ status: 404, json: async () => ({ message }) }),
  internalServerError: (message) => ({ status: 500, json: async () => ({ message }) }),
};

describe('demo-fixtures', () => {
  let handleDemoBrandPresence;
  let handleDemoRecommendations;
  let mockLog;
  let mockS3Client;
  let mockGetSignedUrl;
  let baseContext;

  before(async () => {
    const mod = await esmock('../../../src/controllers/llmo/opportunity-workspace-demo.js', {
      '@adobe/spacecat-shared-http-utils': mockHttpUtils,
    });
    handleDemoBrandPresence = mod.handleDemoBrandPresence;
    handleDemoRecommendations = mod.handleDemoRecommendations;
  });

  beforeEach(() => {
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
    };

    mockS3Client = {};
    mockGetSignedUrl = sinon.stub().resolves(TEST_PRESIGNED_URL);

    baseContext = {
      log: mockLog,
      params: { siteId: 'test-site-id' },
      data: {},
      s3: {
        s3Client: mockS3Client,
        s3Bucket: 'test-bucket',
        getSignedUrl: mockGetSignedUrl,
        GetObjectCommand: function MockGetObjectCommand(params) {
          this.params = params;
        },
      },
    };
  });

  describe('handleDemoBrandPresence', () => {
    it('returns a presigned URL for the brand presence fixture', async () => {
      const result = await handleDemoBrandPresence(baseContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.presignedUrl).to.equal(TEST_PRESIGNED_URL);
      expect(body.expiresAt).to.be.a('string');

      const commandArg = mockGetSignedUrl.getCall(0).args[1];
      expect(commandArg.params.Key).to.equal(
        'workspace/llmo/demo/summit-demo-brand-presence.json',
      );
      expect(commandArg.params.Bucket).to.equal('test-bucket');

      const options = mockGetSignedUrl.getCall(0).args[2];
      expect(options.expiresIn).to.equal(3600);
    });

    it('sets expiresAt approximately 1 hour in the future', async () => {
      const before = Date.now();
      const result = await handleDemoBrandPresence(baseContext);
      const after = Date.now();

      const body = await result.json();
      const expiresAt = new Date(body.expiresAt).getTime();
      const oneHourMs = 60 * 60 * 1000;

      expect(expiresAt).to.be.at.least(before + oneHourMs);
      expect(expiresAt).to.be.at.most(after + oneHourMs);
    });

    it('returns 500 when S3 is not configured', async () => {
      const result = await handleDemoBrandPresence({ ...baseContext, s3: null });

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('S3 storage is not configured for this environment');
    });

    it('returns 500 when S3 client is missing', async () => {
      const result = await handleDemoBrandPresence({
        ...baseContext,
        s3: { ...baseContext.s3, s3Client: null },
      });

      expect(result.status).to.equal(500);
    });

    it('returns 500 when S3 bucket is not configured', async () => {
      const result = await handleDemoBrandPresence({
        ...baseContext,
        s3: { ...baseContext.s3, s3Bucket: null },
      });

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('S3 bucket is not configured for this environment');
    });

    it('returns 404 when the fixture file does not exist in S3', async () => {
      const noSuchKey = new Error('key not found');
      noSuchKey.name = 'NoSuchKey';
      mockGetSignedUrl.rejects(noSuchKey);

      const result = await handleDemoBrandPresence(baseContext);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Demo fixture not found: brand-presence');
      expect(mockLog.warn).to.have.been.calledWith(
        'Demo fixture not found at workspace/llmo/demo/summit-demo-brand-presence.json',
      );
    });

    it('returns 500 when the S3 bucket does not exist', async () => {
      const noSuchBucket = new Error('bucket not found');
      noSuchBucket.name = 'NoSuchBucket';
      mockGetSignedUrl.rejects(noSuchBucket);

      const result = await handleDemoBrandPresence(baseContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Failed to retrieve demo fixture');
    });

    it('returns 500 for generic S3 errors without leaking details', async () => {
      const accessDenied = new Error('Access denied');
      accessDenied.name = 'AccessDenied';
      mockGetSignedUrl.rejects(accessDenied);

      const result = await handleDemoBrandPresence(baseContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Failed to retrieve demo fixture');
      expect(mockLog.error).to.have.been.calledWith(
        'S3 error retrieving demo fixture brand-presence: Access denied',
      );
    });
  });

  describe('handleDemoRecommendations', () => {
    it('returns a presigned URL for the recommendations fixture', async () => {
      const result = await handleDemoRecommendations(baseContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.presignedUrl).to.equal(TEST_PRESIGNED_URL);
      expect(body.expiresAt).to.be.a('string');

      const commandArg = mockGetSignedUrl.getCall(0).args[1];
      expect(commandArg.params.Key).to.equal(
        'workspace/llmo/demo/summit-demo-recommendations.json',
      );
    });

    it('returns 404 when the fixture file does not exist in S3', async () => {
      const noSuchKey = new Error('key not found');
      noSuchKey.name = 'NoSuchKey';
      mockGetSignedUrl.rejects(noSuchKey);

      const result = await handleDemoRecommendations(baseContext);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Demo fixture not found: recommendations');
    });

    it('returns 500 for generic S3 errors without leaking details', async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      mockGetSignedUrl.rejects(error);

      const result = await handleDemoRecommendations(baseContext);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('Failed to retrieve demo fixture');
    });
  });
});
