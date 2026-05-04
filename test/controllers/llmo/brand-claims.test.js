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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

const TEST_SITE_ID = 'test-site-id';
const TEST_PRESIGNED_URL = 'https://s3.amazonaws.com/test-bucket/brand_claims/llmo/test-site-id/data.json.gz?X-Amz-Signature=abc123';

describe('handleBrandClaims', () => {
  let handleBrandClaims;
  let mockLog;
  let mockS3Client;
  let mockGetSignedUrl;
  let baseContext;

  const mockHttpUtils = {
    ok: (data) => ({
      status: 200,
      json: async () => data,
    }),
    badRequest: (message) => ({
      status: 400,
      json: async () => ({ message }),
    }),
    notFound: (message) => ({
      status: 404,
      json: async () => ({ message }),
    }),
  };

  before(async () => {
    const mod = await esmock('../../../src/controllers/llmo/brand-claims.js', {
      '@adobe/spacecat-shared-http-utils': mockHttpUtils,
    });
    handleBrandClaims = mod.handleBrandClaims;
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
      params: { siteId: TEST_SITE_ID },
      data: {},
      env: { ENV: 'dev' },
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

  it('should return presigned URL for default model when no model specified', async () => {
    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.siteId).to.equal(TEST_SITE_ID);
    expect(body.model).to.equal('default');
    expect(body.presignedUrl).to.equal(TEST_PRESIGNED_URL);
    expect(body.expiresAt).to.be.a('string');

    // Verify S3 key uses default path
    const commandArg = mockGetSignedUrl.getCall(0).args[1];
    expect(commandArg.params.Bucket).to.equal('test-bucket');
    expect(commandArg.params.Key).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/data.json.gz`);

    // Verify expiresIn is 1 hour
    const options = mockGetSignedUrl.getCall(0).args[2];
    expect(options.expiresIn).to.equal(3600);
  });

  it('should return presigned URL for specific model', async () => {
    const context = {
      ...baseContext,
      data: { model: 'gpt-4.1' },
    };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.siteId).to.equal(TEST_SITE_ID);
    expect(body.model).to.equal('gpt-4.1');
    expect(body.presignedUrl).to.equal(TEST_PRESIGNED_URL);

    // Verify S3 key uses model-specific path
    const commandArg = mockGetSignedUrl.getCall(0).args[1];
    expect(commandArg.params.Key).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/gpt-4.1.json.gz`);
  });

  it('should return 400 when S3 is not configured', async () => {
    const context = {
      ...baseContext,
      s3: null,
    };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('S3 storage is not configured for this environment');
  });

  it('should return 400 when S3 client is not configured', async () => {
    const context = {
      ...baseContext,
      s3: { s3Client: null },
    };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('S3 storage is not configured for this environment');
  });

  it('should return 400 when S3 bucket is not configured', async () => {
    const context = {
      ...baseContext,
      s3: {
        ...baseContext.s3,
        s3Bucket: null,
      },
    };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('S3 bucket is not configured for this environment');
  });

  it('should return 404 when S3 key not found (NoSuchKey)', async () => {
    const noSuchKeyError = new Error('The specified key does not exist');
    noSuchKeyError.name = 'NoSuchKey';
    mockGetSignedUrl.rejects(noSuchKeyError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(404);
    const body = await result.json();
    expect(body.message).to.equal(`Brand claims data not found for site ${TEST_SITE_ID}`);

    expect(mockLog.warn).to.have.been.calledWith(
      `Brand claims file not found for site ${TEST_SITE_ID} at brand_claims/llmo/${TEST_SITE_ID}/data.json.gz`,
    );
  });

  it('should return 400 when bucket not found (NoSuchBucket)', async () => {
    const noSuchBucketError = new Error('The specified bucket does not exist');
    noSuchBucketError.name = 'NoSuchBucket';
    mockGetSignedUrl.rejects(noSuchBucketError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('Storage bucket not found: test-bucket');

    expect(mockLog.error).to.have.been.calledWith(
      'S3 bucket test-bucket not found',
    );
  });

  it('should return 400 for generic S3 errors', async () => {
    const accessDeniedError = new Error('Access denied');
    accessDeniedError.name = 'AccessDenied';
    mockGetSignedUrl.rejects(accessDeniedError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('Error retrieving brand claims: Access denied');

    expect(mockLog.error).to.have.been.calledWith(
      `S3 error retrieving brand claims for site ${TEST_SITE_ID}: Access denied`,
    );
  });

  it('should log info with model name when model is specified', async () => {
    const context = {
      ...baseContext,
      data: { model: 'gpt-4o-mini' },
    };

    await handleBrandClaims(context);

    expect(mockLog.info).to.have.been.calledWith(
      `Getting brand claims for site ${TEST_SITE_ID}, model: gpt-4o-mini`,
    );
  });

  it('should log info with default when no model is specified', async () => {
    await handleBrandClaims(baseContext);

    expect(mockLog.info).to.have.been.calledWith(
      `Getting brand claims for site ${TEST_SITE_ID}, model: default`,
    );
  });

  it('should set expiresAt approximately 1 hour in the future', async () => {
    const before = Date.now();
    const result = await handleBrandClaims(baseContext);
    const after = Date.now();

    const body = await result.json();
    const expiresAt = new Date(body.expiresAt).getTime();
    const oneHourMs = 60 * 60 * 1000;

    expect(expiresAt).to.be.at.least(before + oneHourMs);
    expect(expiresAt).to.be.at.most(after + oneHourMs);
  });
});
