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
  let listBehavior; // () => Promise, controls the ListObjectsV2 call
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
    listBehavior = () => Promise.resolve(listResult);
    headBehavior = () => Promise.resolve({}); // object exists

    mockS3Send = sinon.stub().callsFake((command) => {
      if (command instanceof ListObjectsV2Command) {
        return listBehavior();
      }
      if (command instanceof HeadObjectCommand) {
        return headBehavior(command);
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

  it('serves an explicit week without listing', async () => {
    const context = { ...baseContext, data: { week: '2026-W17' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    // No list call — the week keys its folder directly.
    expect(mockS3Send.getCall(0).args[0]).to.be.instanceOf(HeadObjectCommand);
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.json.gz`);
  });

  it('prefers week over date when both are supplied', async () => {
    const context = { ...baseContext, data: { week: '2026-W17', date: '2026-01-05' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.json.gz`);
  });

  it('returns 400 for a malformed week', async () => {
    const context = { ...baseContext, data: { week: '2026-17' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid week parameter: expected YYYY-Www format');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('returns 400 for a week with a path separator (no key probing)', async () => {
    const context = { ...baseContext, data: { week: '../secrets' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid week parameter: expected YYYY-Www format');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('returns 400 for an invalid date', async () => {
    const context = { ...baseContext, data: { date: 'not-a-date' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('Invalid date parameter: expected YYYY-MM-DD format');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('returns 400 for a partial date that is not YYYY-MM-DD', async () => {
    const context = { ...baseContext, data: { date: '2026' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid date parameter: expected YYYY-MM-DD format');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('returns 400 for a calendar-invalid date that would roll over', async () => {
    // 2026-02-30 parses (JS rolls it to Mar 2); reject rather than key the wrong week.
    const context = { ...baseContext, data: { date: '2026-02-30' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid date parameter: expected YYYY-MM-DD format');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('resolves the latest week and warns when the listing is truncated', async () => {
    listResult = { IsTruncated: true, CommonPrefixes: [weekPrefix('2026-W17')] };

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(200);
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.json.gz`);
    expect(mockLog.warn).to.have.been.calledWithMatch(/listing truncated/);
  });

  it('falls back to the legacy flat key when listing fails', async () => {
    listBehavior = () => Promise.reject(new Error('boom'));

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(200);
    const headCmd = mockS3Send.getCall(1).args[0];
    expect(headCmd.input.Key).to.equal(FLAT_KEY);
    expect(signedKey()).to.equal(FLAT_KEY);
    expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to list brand claims weeks/);
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

  it('returns 400 for a model containing a path separator (no key probing)', async () => {
    const context = { ...baseContext, data: { model: 'foo/bar' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid model parameter');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('ignores a malformed date when model is supplied (model takes precedence)', async () => {
    const context = { ...baseContext, data: { model: 'gpt-4.1', date: 'garbage' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const headCmd = mockS3Send.getCall(0).args[0];
    expect(headCmd.input.Key).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/gpt-4.1.json.gz`);
  });

  const headCalls = () => mockS3Send.getCalls()
    .filter((c) => c.args[0] instanceof HeadObjectCommand);

  it('serves English with default locale fields when no locale is requested', async () => {
    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.requestedLocale).to.equal(null);
    expect(body.servedLocale).to.equal('default');
    expect(signedKey()).to.equal(FLAT_KEY);
    // Only the existence HEAD — no extra localized probe when locale is absent.
    expect(headCalls()).to.have.length(1);
  });

  it('serves the localized sibling when it exists (single HEAD, no English probe)', async () => {
    listResult = { CommonPrefixes: [weekPrefix('2026-W17')] };
    const context = { ...baseContext, data: { locale: 'ja_jp' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.requestedLocale).to.equal('ja_jp');
    expect(body.servedLocale).to.equal('ja_jp');
    const localizedKey = `brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.ja_jp.json.gz`;
    expect(signedKey()).to.equal(localizedKey);
    // The localized HEAD confirmed existence, so there is no redundant English HEAD.
    const heads = headCalls();
    expect(heads).to.have.length(1);
    expect(heads[0].args[0].input.Key).to.equal(localizedKey);
  });

  it('applies locale to an explicit week folder', async () => {
    const context = { ...baseContext, data: { week: '2026-W17', locale: 'fr_fr' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.servedLocale).to.equal('fr_fr');
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/2026-W17/data.fr_fr.json.gz`);
  });

  it('falls back to English when the localized sibling is missing (HEAD 404)', async () => {
    const notFoundError = new Error('Not Found');
    notFoundError.name = 'NotFound';
    // Localized HEAD 404s; the English existence HEAD succeeds.
    headBehavior = (command) => (command.input.Key.endsWith('data.ja_jp.json.gz')
      ? Promise.reject(notFoundError)
      : Promise.resolve({}));
    const context = { ...baseContext, data: { locale: 'ja_jp' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.requestedLocale).to.equal('ja_jp');
    expect(body.servedLocale).to.equal('default'); // fell back to English
    expect(signedKey()).to.equal(FLAT_KEY);
    // Two HEADs: localized (404) then the English existence check.
    const heads = headCalls();
    expect(heads).to.have.length(2);
    expect(heads[0].args[0].input.Key).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/data.ja_jp.json.gz`);
    expect(heads[1].args[0].input.Key).to.equal(FLAT_KEY);
    expect(mockLog.info).to.have.been.calledWithMatch(/falling back to English/);
  });

  it('falls back to English when the localized HEAD 404s via $metadata (no error name)', async () => {
    // Some S3 clients surface a missing object as an httpStatusCode, not a `NotFound`
    // name — that branch must fall back to English just the same.
    const statusError = new Error('Not Found');
    statusError.$metadata = { httpStatusCode: 404 };
    headBehavior = (command) => (command.input.Key.endsWith('data.ja_jp.json.gz')
      ? Promise.reject(statusError)
      : Promise.resolve({}));
    const context = { ...baseContext, data: { locale: 'ja_jp' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.servedLocale).to.equal('default'); // fell back to English
    expect(signedKey()).to.equal(FLAT_KEY);
    expect(mockLog.info).to.have.been.calledWithMatch(/falling back to English/);
  });

  it('rethrows a non-404 error from the localized HEAD (no silent English fallback)', async () => {
    // A NoSuchBucket/transient fault on the localized HEAD must NOT be swallowed as a
    // "missing localized file" — it rethrows into the shared handler so the real
    // failure surfaces instead of masquerading as an English fallback.
    const bucketError = new Error('bucket gone');
    bucketError.name = 'NoSuchBucket';
    headBehavior = (command) => (command.input.Key.endsWith('data.ja_jp.json.gz')
      ? Promise.reject(bucketError)
      : Promise.resolve({}));
    const context = { ...baseContext, data: { locale: 'ja_jp' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.match(/Storage bucket not found/);
    expect(mockGetSignedUrl).not.to.have.been.called;
  });

  it('returns 404 when both the localized and English objects are missing', async () => {
    const notFoundError = new Error('Not Found');
    notFoundError.name = 'NotFound';
    headBehavior = () => Promise.reject(notFoundError); // every HEAD 404s
    const context = { ...baseContext, data: { locale: 'ja_jp' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(404);
    expect(mockGetSignedUrl).not.to.have.been.called;
  });

  it('ignores locale when model is supplied (model files are not localized)', async () => {
    const context = { ...baseContext, data: { model: 'gpt-4.1', locale: 'ja_jp' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.requestedLocale).to.equal(null);
    expect(body.servedLocale).to.equal('default');
    expect(signedKey()).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/gpt-4.1.json.gz`);
    // Flat model path: exactly one HEAD, no localized probe and no listing.
    expect(mockS3Send).to.have.been.calledOnce;
    expect(mockS3Send.getCall(0).args[0]).to.be.instanceOf(HeadObjectCommand);
  });

  it('returns 400 for an invalid locale string', async () => {
    const context = { ...baseContext, data: { locale: 'japanese' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid locale parameter: expected e.g. ja_jp');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('returns 400 for a locale with a path separator (no key probing)', async () => {
    const context = { ...baseContext, data: { locale: '../secret' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Invalid locale parameter: expected e.g. ja_jp');
    expect(mockS3Send).not.to.have.been.called;
  });

  it('returns 400 when locale has uppercase letters (strict lowercase only)', async () => {
    const context = { ...baseContext, data: { locale: 'JA_JP' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(400);
    expect(mockS3Send).not.to.have.been.called;
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

describe('handleBrandClaimsWeeks', () => {
  let handleBrandClaimsWeeks;
  let mockLog;
  let mockS3Send;
  let baseContext;
  let listBehavior; // () => Promise, controls the ListObjectsV2 call

  const mockHttpUtils = {
    ok: (data) => ({ status: 200, json: async () => data }),
    badRequest: (message) => ({ status: 400, json: async () => ({ message }) }),
    notFound: (message) => ({ status: 404, json: async () => ({ message }) }),
    internalServerError: (message) => ({ status: 500, json: async () => ({ message }) }),
  };

  before(async () => {
    const mod = await esmock('../../../src/controllers/llmo/brand-claims.js', {
      '@adobe/spacecat-shared-http-utils': mockHttpUtils,
    });
    handleBrandClaimsWeeks = mod.handleBrandClaimsWeeks;
  });

  beforeEach(() => {
    mockLog = { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() };
    listBehavior = () => Promise.resolve({ CommonPrefixes: [] });

    mockS3Send = sinon.stub().callsFake((command) => {
      if (command instanceof ListObjectsV2Command) {
        return listBehavior();
      }
      return Promise.resolve({});
    });

    baseContext = {
      log: mockLog,
      params: { siteId: TEST_SITE_ID },
      data: {},
      env: { ENV: 'dev' },
      s3: { s3Client: { send: mockS3Send }, s3Bucket: 'test-bucket' },
    };
  });

  it('lists available weeks newest first', async () => {
    listBehavior = () => Promise.resolve({
      CommonPrefixes: [weekPrefix('2026-W15'), weekPrefix('2026-W17'), weekPrefix('2026-W16')],
    });

    const result = await handleBrandClaimsWeeks(baseContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.siteId).to.equal(TEST_SITE_ID);
    expect(body.weeks).to.deep.equal(['2026-W17', '2026-W16', '2026-W15']);
    expect(body.count).to.equal(3);

    const listCmd = mockS3Send.getCall(0).args[0];
    expect(listCmd).to.be.instanceOf(ListObjectsV2Command);
    expect(listCmd.input.Prefix).to.equal(`brand_claims/llmo/${TEST_SITE_ID}/`);
    expect(listCmd.input.Delimiter).to.equal('/');
  });

  it('ignores non-week folders', async () => {
    listBehavior = () => Promise.resolve({
      CommonPrefixes: [weekPrefix('archive'), weekPrefix('2026-W09'), weekPrefix('latest')],
    });

    const body = await (await handleBrandClaimsWeeks(baseContext)).json();
    expect(body.weeks).to.deep.equal(['2026-W09']);
    expect(body.count).to.equal(1);
  });

  it('returns an empty list (200) when no week folders exist', async () => {
    const result = await handleBrandClaimsWeeks(baseContext);
    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.weeks).to.deep.equal([]);
    expect(body.count).to.equal(0);
  });

  it('defaults to 15 weeks when no limit is supplied', async () => {
    listBehavior = () => Promise.resolve({
      CommonPrefixes: Array.from({ length: 30 }, (_, i) => weekPrefix(`2026-W${String(i + 1).padStart(2, '0')}`)),
    });

    const body = await (await handleBrandClaimsWeeks(baseContext)).json();
    expect(body.weeks).to.have.length(15);
    expect(body.weeks[0]).to.equal('2026-W30'); // newest
    expect(body.count).to.equal(15);
  });

  it('honors an explicit limit, clamped to the [1, 52] range', async () => {
    listBehavior = () => Promise.resolve({
      CommonPrefixes: Array.from({ length: 10 }, (_, i) => weekPrefix(`2026-W${String(i + 1).padStart(2, '0')}`)),
    });

    const body = await (await handleBrandClaimsWeeks({ ...baseContext, data: { limit: '3' } })).json();
    expect(body.weeks).to.deep.equal(['2026-W10', '2026-W09', '2026-W08']);
    expect(body.count).to.equal(3);
  });

  it('clamps a limit above the max to 52', async () => {
    listBehavior = () => Promise.resolve({
      CommonPrefixes: Array.from({ length: 60 }, (_, i) => weekPrefix(`2026-W${String(i + 1).padStart(2, '0')}`)),
    });

    const body = await (await handleBrandClaimsWeeks({ ...baseContext, data: { limit: '999' } })).json();
    expect(body.weeks).to.have.length(52);
  });

  it('falls back to the default limit for a non-numeric limit', async () => {
    listBehavior = () => Promise.resolve({
      CommonPrefixes: Array.from({ length: 20 }, (_, i) => weekPrefix(`2026-W${String(i + 1).padStart(2, '0')}`)),
    });

    const body = await (await handleBrandClaimsWeeks({ ...baseContext, data: { limit: 'abc' } })).json();
    expect(body.weeks).to.have.length(15);
  });

  it('warns when the listing is truncated', async () => {
    listBehavior = () => Promise.resolve({ IsTruncated: true, CommonPrefixes: [weekPrefix('2026-W17')] });

    const result = await handleBrandClaimsWeeks(baseContext);
    expect(result.status).to.equal(200);
    expect(mockLog.warn).to.have.been.calledWithMatch(/listing truncated/);
  });

  it('returns 400 when S3 is not configured', async () => {
    const result = await handleBrandClaimsWeeks({ ...baseContext, s3: null });
    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('S3 storage is not configured for this environment');
  });

  it('returns 400 when S3 bucket is not configured', async () => {
    const ctx = { ...baseContext, s3: { ...baseContext.s3, s3Bucket: null } };
    const result = await handleBrandClaimsWeeks(ctx);
    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('S3 bucket is not configured for this environment');
  });

  it('returns 400 without leaking the bucket name when the bucket is missing', async () => {
    const err = new Error('The specified bucket does not exist');
    err.name = 'NoSuchBucket';
    listBehavior = () => Promise.reject(err);

    const result = await handleBrandClaimsWeeks(baseContext);
    expect(result.status).to.equal(400);
    const { message } = await result.json();
    expect(message).to.equal('S3 storage is not properly configured for this environment');
    expect(message).to.not.contain('test-bucket');
  });

  it('returns 500 (not 400) without leaking details for a server-side S3 error', async () => {
    const err = new Error('Access denied for arn:aws:iam::123:role/secret');
    err.name = 'AccessDenied';
    listBehavior = () => Promise.reject(err);

    const result = await handleBrandClaimsWeeks(baseContext);
    expect(result.status).to.equal(500);
    const { message } = await result.json();
    expect(message).to.equal('Unable to list brand claims weeks');
    expect(message).to.not.contain('Access denied');
    // The real error is still logged for operators.
    expect(mockLog.error).to.have.been.calledWithMatch(/S3 error listing brand claims weeks/);
  });
});

describe('handleRequestBrandClaims (on-demand, LLMO-7263)', () => {
  let handleRequestBrandClaims;
  let sandbox;
  let sqsSend;
  let postSlackMessage;
  let site;
  let context;

  let getLatestAudit;

  const httpUtils = {
    accepted: (body) => ({ status: 202, json: async () => body }),
    badRequest: (message) => ({ status: 400, json: async () => ({ message }) }),
    notFound: (message) => ({ status: 404, json: async () => ({ message }) }),
    internalServerError: (message) => ({ status: 500, json: async () => ({ message }) }),
    createResponse: (body, status, headers) => ({ status, headers, json: async () => body }),
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    sqsSend = sandbox.stub().resolves();
    postSlackMessage = sandbox.stub().resolves();
    // Default: no prior brand-claims audit → not in cooldown.
    getLatestAudit = sandbox.stub().resolves(null);

    const mod = await esmock('../../../src/controllers/llmo/brand-claims.js', {
      '@adobe/spacecat-shared-http-utils': httpUtils,
      '../../../src/utils/slack/base.js': { postSlackMessage },
    });
    handleRequestBrandClaims = mod.handleRequestBrandClaims;

    site = {
      getId: () => 'site-1',
      getBaseURL: () => 'https://acme.example',
      getLatestAuditByAuditType: (...args) => getLatestAudit(...args),
    };
    context = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      sqs: { sendMessage: sqsSend },
      env: {
        AUDIT_JOBS_QUEUE_URL: 'audit-q',
        SLACK_BRAND_CLAIMS_REQUEST_CHANNEL_ID: 'C123',
        SLACK_BOT_TOKEN: 'xoxb-1',
      },
      attributes: {
        authInfo: {
          getProfile: () => ({ trial_email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' }),
        },
      },
    };
  });

  afterEach(() => sandbox.restore());

  it('triggers the brand-claims audit with onDemand and notifies Slack (202)', async () => {
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledOnce;
    const [queueUrl, msg] = sqsSend.getCall(0).args;
    expect(queueUrl).to.equal('audit-q');
    expect(msg.type).to.equal('brand-claims');
    expect(msg.siteId).to.equal('site-1');
    expect(msg.onDemand).to.equal(true);
    expect(msg.auditContext).to.deep.equal({ trigger: 'on-demand-brand-claims' });
    expect(postSlackMessage).to.have.been.calledOnce;
    // The alert names who triggered it (name + human-readable email).
    expect(postSlackMessage.getCall(0).args[1]).to.include('by Ada Lovelace (ada@example.com)');
  });

  it('uses preferred_username (RFC-5322) over the profile.email GUID when there is no name', async () => {
    context.attributes.authInfo.getProfile = () => ({ preferred_username: 'grace@example.com' });
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1]).to.include('by grace@example.com');
  });

  it('uses the name alone when the profile has no email', async () => {
    context.attributes.authInfo.getProfile = () => ({ first_name: 'Ada', last_name: 'Lovelace' });
    await handleRequestBrandClaims(context, site);
    // Ends with "by Ada Lovelace." — the name only, no "(email)" appended.
    expect(postSlackMessage.getCall(0).args[1]).to.include('by Ada Lovelace.');
  });

  it('omits the "by" clause when no identity is available', async () => {
    delete context.attributes;
    await handleRequestBrandClaims(context, site);
    const text = postSlackMessage.getCall(0).args[1];
    expect(text).to.not.include(' by ');
    expect(text).to.include('(site-1).');
  });

  it('omits the "by" clause when the profile lookup throws (fail-safe)', async () => {
    context.attributes.authInfo.getProfile = () => {
      throw new Error('boom');
    };
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1]).to.not.include(' by ');
  });

  it('strips Slack mrkdwn control characters from the requester label', async () => {
    context.attributes.authInfo.getProfile = () => ({ first_name: '<@here>', last_name: '`Ada`' });
    await handleRequestBrandClaims(context, site);
    const text = postSlackMessage.getCall(0).args[1];
    expect(text).to.include('by @here Ada');
    expect(text).to.not.match(/[<>`|]/);
  });

  it('returns 500 when AUDIT_JOBS_QUEUE_URL is not configured', async () => {
    context.env.AUDIT_JOBS_QUEUE_URL = undefined;
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(500);
    expect(sqsSend).to.not.have.been.called;
  });

  it('returns 500 (not 400) when the SQS enqueue fails', async () => {
    sqsSend.rejects(new Error('sqs down'));
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(500);
    expect(postSlackMessage).to.not.have.been.called;
  });

  it('still succeeds when the Slack notification fails (best-effort)', async () => {
    postSlackMessage.rejects(new Error('slack down'));
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledOnce;
  });

  it('skips Slack when not configured but still triggers the audit', async () => {
    context.env.SLACK_BOT_TOKEN = undefined;
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledOnce;
    expect(postSlackMessage).to.not.have.been.called;
  });

  it('returns 429 and does not enqueue when the last run is within 7 days', async () => {
    const ranAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    getLatestAudit.resolves({ getAuditedAt: () => ranAt });
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(429);
    expect(getLatestAudit).to.have.been.calledWith('brand-claims');
    expect(result.headers).to.have.property('Retry-After');
    const body = await result.json();
    expect(body.siteId).to.equal('site-1');
    expect(body).to.have.property('availableAt');
    expect(sqsSend).to.not.have.been.called;
    expect(postSlackMessage).to.not.have.been.called;
  });

  it('proceeds (202) when the last run is older than 7 days', async () => {
    const ranAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    getLatestAudit.resolves({ getAuditedAt: () => ranAt });
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledOnce;
  });

  it('proceeds (202) at the 7-day boundary (cooldown uses strict <)', async () => {
    // Exactly 7 days ago: elapsed is >= COOLDOWN_MS (never < it), so strict `<`
    // lets the request through rather than blocking on the boundary.
    const ranAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    getLatestAudit.resolves({ getAuditedAt: () => ranAt });
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledOnce;
  });

  it('fails open (202) when the cooldown lookup throws', async () => {
    getLatestAudit.rejects(new Error('db down'));
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledOnce;
    expect(context.log.warn).to.have.been.called;
  });
});
