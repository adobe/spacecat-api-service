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
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

use(sinonChai);

const TEST_SITE_ID = 'test-site-id';
const TEST_PRESIGNED_URL = 'https://s3.amazonaws.com/test-bucket/brand_claims/llmo/test-site-id/2026-W17/data.json.gz?X-Amz-Signature=abc123';
const FLAT_KEY = `brand_claims/llmo/${TEST_SITE_ID}/data.json.gz`;

function weekPrefix(week) {
  return { Prefix: `brand_claims/llmo/${TEST_SITE_ID}/${week}/` };
}

describe('handleBrandClaims', () => {
  let handleBrandClaims;
  let mockLog;
  let mockS3Client;
  let mockS3Send;
  let mockGetSignedUrl;
  let baseContext;
  let listResult; // ListObjectsV2 response for the default (latest-week) path
  let headBehavior; // () => Promise, controls HeadObject existence

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

    listResult = { CommonPrefixes: [] }; // no week folders → fall back to flat key
    headBehavior = () => Promise.resolve({}); // object exists

    mockS3Send = sinon.stub().callsFake((command) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve(listResult);
      }
      if (command instanceof HeadObjectCommand) {
        return headBehavior();
      }
      return Promise.resolve({});
    });
    mockS3Client = { send: mockS3Send };
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

  const signedKey = () => mockGetSignedUrl.getCall(0).args[1].params.Key;

  it('serves the latest week folder when several exist', async () => {
    listResult = {
      CommonPrefixes: [weekPrefix('2026-W15'), weekPrefix('2026-W17'), weekPrefix('2026-W16')],
    };

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.model).to.equal('default');
    expect(body.presignedUrl).to.equal(TEST_PRESIGNED_URL);

    // Listed once, then HeadObject + presign on the latest week key.
    const listCmd = mockS3Send.getCall(0).args[0];
    expect(listCmd).to.be.instanceOf(ListObjectsV2Command);
    expect(listCmd.input.Prefix).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/`);
    expect(listCmd.input.Delimiter).to.equal('/');

    const headCmd = mockS3Send.getCall(1).args[0];
    expect(headCmd).to.be.instanceOf(HeadObjectCommand);
    expect(headCmd.input.Key).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.json.gz`);
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.json.gz`);
  });

  it('falls back to the legacy flat key when no week folder exists', async () => {
    listResult = { CommonPrefixes: [] };

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(200);
    const headCmd = mockS3Send.getCall(1).args[0];
    expect(headCmd.input.Key).to.equal(FLAT_KEY);
    expect(signedKey()).to.equal(FLAT_KEY);
  });

  it('ignores non-week folders when resolving the latest run', async () => {
    listResult = { CommonPrefixes: [weekPrefix('archive'), weekPrefix('2026-W09')] };

    await handleBrandClaims(baseContext);

    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W09/data.json.gz`);
  });

  it('serves the week for an explicit date without listing', async () => {
    const context = { ...baseContext, data: { date: '2026-04-22' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    // No list call — the date maps directly to a week key.
    expect(mockS3Send.getCall(0).args[0]).to.be.instanceOf(HeadObjectCommand);
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.json.gz`);
  });

  it('returns 400 for an invalid date', async () => {
    const context = { ...baseContext, data: { date: 'not-a-date' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('Invalid date parameter: not-a-date');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('serves a specific model from the legacy flat key without listing', async () => {
    const context = { ...baseContext, data: { model: 'gpt-4.1' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.model).to.equal('gpt-4.1');

    // Model path is flat: HeadObject only, no ListObjectsV2.
    expect(mockS3Send).to.have.been.calledOnce;
    const headCmd = mockS3Send.getCall(0).args[0];
    expect(headCmd).to.be.instanceOf(HeadObjectCommand);
    expect(headCmd.input.Key).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/gpt-4.1.json.gz`);
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/gpt-4.1.json.gz`);
  });

  it('returns 400 when S3 is not configured', async () => {
    const result = await handleBrandClaims({ ...baseContext, s3: null });
    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('S3 storage is not configured for this environment');
  });

  it('returns 400 when S3 client is not configured', async () => {
    const result = await handleBrandClaims({ ...baseContext, s3: { s3Client: null } });
    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('S3 storage is not configured for this environment');
  });

  it('returns 400 when S3 bucket is not configured', async () => {
    const context = { ...baseContext, s3: { ...baseContext.s3, s3Bucket: null } };
    const result = await handleBrandClaims(context);
    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('S3 bucket is not configured for this environment');
  });

  it('returns 404 when the resolved object does not exist (HeadObject NotFound)', async () => {
    const notFoundError = new Error('Not Found');
    notFoundError.name = 'NotFound';
    headBehavior = () => Promise.reject(notFoundError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(404);
    expect((await result.json()).message).to.equal(`Brand claims data not found for site ${TEST_SITE_ID}`);
    expect(mockGetSignedUrl).not.to.have.been.called;
    expect(mockLog.warn).to.have.been.calledWith(
      `Brand claims file not found for site ${TEST_SITE_ID} at ${FLAT_KEY}`,
    );
  });

  it('returns 404 when HeadObject error carries httpStatusCode 404', async () => {
    const err = new Error('Object not found');
    err.name = 'SomethingElse';
    err.$metadata = { httpStatusCode: 404 };
    headBehavior = () => Promise.reject(err);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(404);
    expect(mockGetSignedUrl).not.to.have.been.called;
  });

  it('returns 400 when bucket not found (NoSuchBucket)', async () => {
    const noSuchBucketError = new Error('The specified bucket does not exist');
    noSuchBucketError.name = 'NoSuchBucket';
    headBehavior = () => Promise.reject(noSuchBucketError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Storage bucket not found: test-bucket');
    expect(mockLog.error).to.have.been.calledWith('S3 bucket test-bucket not found');
  });

  it('returns 400 for generic S3 errors', async () => {
    const accessDeniedError = new Error('Access denied');
    accessDeniedError.name = 'AccessDenied';
    headBehavior = () => Promise.reject(accessDeniedError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Error retrieving brand claims: Access denied');
    expect(mockLog.error).to.have.been.calledWith(
      `S3 error retrieving brand claims for site ${TEST_SITE_ID}: Access denied`,
    );
  });

  it('logs info with model name when model is specified', async () => {
    await handleBrandClaims({ ...baseContext, data: { model: 'gpt-4o-mini' } });
    expect(mockLog.info).to.have.been.calledWith(
      `Getting brand claims for site ${TEST_SITE_ID}, model: gpt-4o-mini`,
    );
  });

  it('logs info with default when no model is specified', async () => {
    await handleBrandClaims(baseContext);
    expect(mockLog.info).to.have.been.calledWith(
      `Getting brand claims for site ${TEST_SITE_ID}, model: default`,
    );
  });

  it('sets expiresAt approximately 1 hour in the future', async () => {
    const before = Date.now();
    const result = await handleBrandClaims(baseContext);
    const after = Date.now();

    const expiresAt = new Date((await result.json()).expiresAt).getTime();
    const oneHourMs = 60 * 60 * 1000;
    expect(expiresAt).to.be.at.least(before + oneHourMs);
    expect(expiresAt).to.be.at.most(after + oneHourMs);
  });
});
