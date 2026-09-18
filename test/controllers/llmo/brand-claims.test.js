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

import { createHmac } from 'node:crypto';
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
    expect((await result.json()).message).to.equal('S3 storage is not properly configured for this environment');
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

  it('treats an empty locale as absent and serves English (no extra HEAD)', async () => {
    // `?locale=` -> hasText false -> useLocale false -> unchanged English behavior.
    const context = { ...baseContext, data: { locale: '' } };

    const result = await handleBrandClaims(context);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.requestedLocale).to.equal(null);
    expect(body.servedLocale).to.equal('default');
    expect(headCalls()).to.have.length(1); // only the English existence HEAD
  });

  it('returns 400 for a whitespace-only locale (present but invalid)', async () => {
    // `?locale=%20%20` -> hasText true (not trimmed) -> validated -> rejected.
    const context = { ...baseContext, data: { locale: '  ' } };

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
    // Generic client message — the bucket name stays in the log, not the response.
    expect((await result.json()).message).to.equal('S3 storage is not properly configured for this environment');
    expect(mockLog.error).to.have.been.calledWith('S3 bucket test-bucket not found');
  });

  it('returns 500 with a generic message for other S3 errors (no raw detail leaked)', async () => {
    const accessDeniedError = new Error('Access denied');
    accessDeniedError.name = 'AccessDenied';
    headBehavior = () => Promise.reject(accessDeniedError);

    const result = await handleBrandClaims(baseContext);

    expect(result.status).to.equal(500);
    // The raw AWS message (recon primitive) is logged, never returned to the caller.
    expect((await result.json()).message).to.equal('Unable to retrieve brand claims');
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

  it('triggers the prerequisite audits then the brand-claims audit (onDemand) and notifies Slack (202)', async () => {
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    // offsite-brand-presence + wikipedia-analysis fire before brand-claims.
    expect(sqsSend).to.have.been.calledThrice;
    const types = sqsSend.getCalls().map((c) => c.args[1].type);
    expect(types).to.deep.equal(['offsite-brand-presence', 'wikipedia-analysis', 'brand-claims']);
    sqsSend.getCalls().forEach((c) => {
      expect(c.args[0]).to.equal('audit-q');
      expect(c.args[1].siteId).to.equal('site-1');
      expect(c.args[1].auditContext).to.deep.equal({ trigger: 'on-demand-brand-claims' });
    });
    // Only the claims trigger carries onDemand; the prerequisite audits are plain triggers.
    expect(sqsSend.getCall(0).args[1].onDemand).to.equal(undefined);
    expect(sqsSend.getCall(1).args[1].onDemand).to.equal(undefined);
    expect(sqsSend.getCall(2).args[1].onDemand).to.equal(true);
    expect(postSlackMessage).to.have.been.calledOnce;
    // The alert carries only the coarse internal/external signal, not the requester's
    // name or email. Default profile is a non-Adobe trial address, so: external.
    const text = postSlackMessage.getCall(0).args[1];
    expect(text).to.include('by an external user');
    expect(text).to.not.include('Ada');
    expect(text).to.not.include('ada@example.com');
  });

  it('labels an adobe.com requester as internal', async () => {
    context.attributes.authInfo.getProfile = () => ({ trial_email: 'ada@adobe.com', first_name: 'Ada', last_name: 'Lovelace' });
    await handleRequestBrandClaims(context, site);
    const text = postSlackMessage.getCall(0).args[1];
    expect(text).to.include('by an internal user');
    expect(text).to.not.include('Ada');
  });

  it('labels an adobetest.com requester as internal', async () => {
    context.attributes.authInfo.getProfile = () => ({ trial_email: 'exc-locuser-en+t2e@adobetest.com' });
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1]).to.include('by an internal user');
  });

  it('labels an Adobe subdomain requester as internal', async () => {
    context.attributes.authInfo.getProfile = () => ({ preferred_username: 'ops@geo.adobe.com' });
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1]).to.include('by an internal user');
  });

  it('classifies via preferred_username when trial_email is absent', async () => {
    context.attributes.authInfo.getProfile = () => ({ preferred_username: 'grace@example.com' });
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1]).to.include('by an external user');
  });

  it('omits the "by" clause when the profile has no email (only a name)', async () => {
    context.attributes.authInfo.getProfile = () => ({ first_name: 'Ada', last_name: 'Lovelace' });
    await handleRequestBrandClaims(context, site);
    const text = postSlackMessage.getCall(0).args[1];
    expect(text).to.not.include(' by ');
    expect(text).to.not.include('Ada');
  });

  it('omits the "by" clause when the only email-like value has no domain (bare IMS GUID)', async () => {
    context.attributes.authInfo.getProfile = () => ({ email: '6E3D1F2A0B9C4D5E7F8A9B0C' });
    await handleRequestBrandClaims(context, site);
    // A bare GUID has no '@', so there is no domain to classify — the alert stays
    // unlabelled rather than guessing internal/external.
    expect(postSlackMessage.getCall(0).args[1]).to.not.include(' by ');
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
    expect(sqsSend).to.have.been.calledThrice;
  });

  it('skips Slack when not configured but still triggers the audit', async () => {
    context.env.SLACK_BOT_TOKEN = undefined;
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledThrice;
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
    expect(sqsSend).to.have.been.calledThrice;
  });

  it('does not tag the Slack alert "(re-run)" on a first-ever run (no prior audit)', async () => {
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1]).to.not.include('(re-run)');
  });

  it('tags the Slack alert "(re-run)" when a prior (cooldown-cleared) audit exists', async () => {
    const ranAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    getLatestAudit.resolves({ getAuditedAt: () => ranAt });
    await handleRequestBrandClaims(context, site);
    expect(postSlackMessage.getCall(0).args[1])
      .to.include('On-demand Brand Claims requested (re-run) for');
  });

  it('proceeds (202) at the 7-day boundary (cooldown uses strict <)', async () => {
    // Exactly 7 days ago: elapsed is >= COOLDOWN_MS (never < it), so strict `<`
    // lets the request through rather than blocking on the boundary.
    const ranAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    getLatestAudit.resolves({ getAuditedAt: () => ranAt });
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledThrice;
  });

  it('fails open (202) when the cooldown lookup throws', async () => {
    getLatestAudit.rejects(new Error('db down'));
    const result = await handleRequestBrandClaims(context, site);
    expect(result.status).to.equal(202);
    expect(sqsSend).to.have.been.calledThrice;
    expect(context.log.warn).to.have.been.called;
  });
});

describe('handleBrandClaimsFeedback', () => {
  const EVENT_ID = '11111111-1111-4111-8111-111111111111';
  const BRAND_ID = '22222222-2222-4222-8222-222222222222';
  const ORG_ID = '33333333-3333-4333-8333-333333333333';
  const SITE_ID = '44444444-4444-4444-8444-444444444444';

  let handleBrandClaimsFeedback;
  let sandbox;
  let s3Send;
  let getBrandById;
  let context;
  let site;
  let MockPutObjectCommand;
  let MockGetObjectCommand;

  const httpUtils = {
    accepted: (body) => ({ status: 202, json: async () => body }),
    badRequest: (message) => ({ status: 400, json: async () => ({ message }) }),
    notFound: (message) => ({ status: 404, json: async () => ({ message }) }),
    internalServerError: (message) => ({ status: 500, json: async () => ({ message }) }),
    createResponse: (body, status) => ({ status, json: async () => body }),
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    s3Send = sandbox.stub().resolves({});
    getBrandById = sandbox.stub().resolves({
      id: BRAND_ID,
      name: 'Acme',
      baseSiteId: SITE_ID,
      siteIds: [SITE_ID],
    });

    const mod = await esmock('../../../src/controllers/llmo/brand-claims.js', {
      '@adobe/spacecat-shared-http-utils': httpUtils,
      '../../../src/support/brands-storage.js': { getBrandById },
    });
    handleBrandClaimsFeedback = mod.handleBrandClaimsFeedback;
    MockPutObjectCommand = function PutObjectCommand(input) {
      this.input = input;
      this.type = 'put';
    };
    MockGetObjectCommand = function GetObjectCommand(input) {
      this.input = input;
      this.type = 'get';
    };

    site = {
      getId: () => SITE_ID,
      getOrganizationId: () => ORG_ID,
    };
    context = {
      data: {
        eventId: EVENT_ID,
        brandId: BRAND_ID,
        rating: 'down',
        comment: 'The recommendations need more context.',
      },
      dataAccess: {
        Organization: {
          findById: sandbox.stub().resolves({
            getName: () => 'Acme Corp',
            getImsOrgId: () => 'ABC@AdobeOrg',
          }),
        },
        Entitlement: {
          findByOrganizationIdAndProductCode: sandbox.stub().resolves({
            getTier: () => 'PAID',
          }),
        },
        services: {
          postgrestClient: { from: sandbox.stub() },
        },
      },
      attributes: {
        authInfo: {
          getProfile: () => ({
            user_id: 'user-123@AdobeID',
            email: 'user-123@AdobeID',
            sub: 'user-123@AdobeID',
          }),
        },
      },
      env: {
        ABV_LEARNING_DATA_BUCKET: 'learning-bucket',
        ABV_ID_HASH_SALT: 'shared-secret',
      },
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
      s3: {
        s3Client: { send: s3Send },
        PutObjectCommand: MockPutObjectCommand,
        GetObjectCommand: MockGetObjectCommand,
      },
    };
  });

  afterEach(() => sandbox.restore());

  it('writes an encrypted, contextual product-feedback record and returns 202', async () => {
    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(202);
    expect(s3Send).to.have.been.calledTwice;
    const markerCommand = s3Send.firstCall.args[0];
    expect(markerCommand.input.Key).to.equal(
      `product_feedback/brand_claims/idempotency/${EVENT_ID}.json`,
    );
    const command = s3Send.secondCall.args[0];
    expect(command.input).to.include({
      Bucket: 'learning-bucket',
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*',
    });
    expect(command.input.Key).to.match(
      new RegExp(`^product_feedback/brand_claims/down/paid/\\d{4}-\\d{2}-\\d{2}/\\d{17}_${EVENT_ID}\\.json$`),
    );
    const record = JSON.parse(command.input.Body);
    expect(record).to.include({
      schemaVersion: 1,
      recordType: 'product_feedback',
      surface: 'brand_claims',
      id: EVENT_ID,
      rating: 'down',
      note: 'The recommendations need more context.',
      organizationId: ORG_ID,
      customerName: 'Acme Corp',
      imsOrgId: 'ABC@AdobeOrg',
      siteId: SITE_ID,
      brandId: BRAND_ID,
      brand: 'Acme',
      tier: 'paid',
    });
    const expectedAbvId = `abv_${createHmac('sha256', 'shared-secret')
      .update('user-123@AdobeID')
      .digest('hex')
      .slice(0, 12)}`;
    expect(record.abv_id).to.equal(expectedAbvId);
  });

  it('omits the explicit encryption header for a local S3 emulator', async () => {
    const result = await handleBrandClaimsFeedback({
      ...context,
      env: {
        ...context.env,
        AWS_ENDPOINT_URL_S3: 'http://localhost:9100',
      },
    }, site);

    expect(result.status).to.equal(202);
    expect(s3Send.firstCall.args[0].input).not.to.have.property('ServerSideEncryption');
    expect(s3Send.secondCall.args[0].input).not.to.have.property('ServerSideEncryption');
  });

  it('rejects invalid ids, rating, and comment shape before writing', async () => {
    const results = await Promise.all([
      { ...context.data, eventId: 'bad' },
      { ...context.data, eventId: '00000000-0000-0000-0000-000000000000' },
      { ...context.data, eventId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' },
      { ...context.data, brandId: 'bad' },
      { ...context.data, rating: 'neutral' },
      { ...context.data, comment: 42 },
    ].map((data) => handleBrandClaimsFeedback({ ...context, data }, site)));
    expect(results.map((result) => result.status)).to.deep.equal([400, 400, 400, 400, 400, 400]);
    expect(s3Send).not.to.have.been.called;
  });

  it('rejects comments over 4000 characters', async () => {
    const result = await handleBrandClaimsFeedback({
      ...context,
      data: { ...context.data, comment: 'x'.repeat(4001) },
    }, site);

    expect(result.status).to.equal(413);
    expect(s3Send).not.to.have.been.called;
  });

  it('returns 404 when the brand does not belong to the site organization', async () => {
    getBrandById.resolves(null);
    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(404);
    expect(s3Send).not.to.have.been.called;
  });

  it('rejects a brand that is not linked to the report site', async () => {
    getBrandById.resolves({
      id: BRAND_ID,
      name: 'Acme',
      baseSiteId: '55555555-5555-4555-8555-555555555555',
      siteIds: [],
    });

    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(400);
    expect((await result.json()).message).to.equal('Brand does not belong to this site');
    expect(s3Send).not.to.have.been.called;
  });

  it('fails closed when the shared bucket or hash salt is not configured', async () => {
    const result = await handleBrandClaimsFeedback({
      ...context,
      env: { ...context.env, ABV_ID_HASH_SALT: undefined },
    }, site);

    expect(result.status).to.equal(500);
    expect(s3Send).not.to.have.been.called;
  });

  it('fails closed when the caller has no stable identity', async () => {
    context.attributes.authInfo.getProfile = () => ({});

    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(500);
    expect(s3Send).not.to.have.been.called;
  });

  it('treats a duplicate event id as an idempotent success', async () => {
    const markerRecord = {
      schemaVersion: 1,
      recordType: 'product_feedback',
      surface: 'brand_claims',
      id: EVENT_ID,
      timestamp: '2026-09-15T23:59:59.000Z',
      rating: 'up',
      abv_id: `abv_${createHmac('sha256', 'shared-secret')
        .update('user-123@AdobeID')
        .digest('hex')
        .slice(0, 12)}`,
      organizationId: ORG_ID,
      customerName: 'Acme Corp',
      imsOrgId: 'ABC@AdobeOrg',
      siteId: SITE_ID,
      brandId: BRAND_ID,
      brand: 'Acme',
      tier: 'paid',
    };
    s3Send.callsFake((command) => {
      if (command.type === 'put' && command.input.Key.includes('/idempotency/')) {
        const error = new Error('already exists');
        error.name = 'PreconditionFailed';
        return Promise.reject(error);
      }
      if (command.type === 'get') {
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify(markerRecord)),
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(202);
    expect((await result.json()).id).to.equal(EVENT_ID);
    const recordCommand = s3Send.thirdCall.args[0];
    expect(recordCommand.input.Key).to.equal(
      `product_feedback/brand_claims/up/paid/2026-09-15/20260915235959000_${EVENT_ID}.json`,
    );
    expect(JSON.parse(recordCommand.input.Body)).to.deep.equal(markerRecord);
  });

  it('rejects an idempotency marker owned by another tenant', async () => {
    const markerRecord = {
      schemaVersion: 1,
      recordType: 'product_feedback',
      surface: 'brand_claims',
      id: EVENT_ID,
      timestamp: '2026-09-15T23:59:59.000Z',
      rating: 'up',
      abv_id: 'abv_other',
      organizationId: '99999999-9999-4999-8999-999999999999',
      customerName: 'Other',
      imsOrgId: null,
      siteId: '88888888-8888-4888-8888-888888888888',
      brandId: '77777777-7777-4777-8777-777777777777',
      brand: 'Other',
      tier: 'paid',
    };
    s3Send.callsFake((command) => {
      if (command.type === 'put' && command.input.Key.includes('/idempotency/')) {
        const error = new Error('already exists');
        error.name = 'PreconditionFailed';
        return Promise.reject(error);
      }
      if (command.type === 'get') {
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify(markerRecord)),
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(500);
    expect(s3Send).to.have.been.calledTwice;
  });

  it('returns a generic 500 when the S3 write fails', async () => {
    s3Send.rejects(new Error('secret bucket detail'));

    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(500);
    expect((await result.json()).message).to.equal('Unable to submit Brand Claims feedback');
  });

  it('does not write a false free tier when entitlement lookup fails', async () => {
    context.dataAccess.Entitlement.findByOrganizationIdAndProductCode
      .rejects(new Error('entitlement unavailable'));

    const result = await handleBrandClaimsFeedback(context, site);

    expect(result.status).to.equal(500);
    expect(s3Send).not.to.have.been.called;
  });
});
