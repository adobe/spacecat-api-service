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
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

use(sinonChai);

const SPACE_CAT_ID = '5d4e5082-b030-433d-9dbd-7007116f701f';
const BRAND_ID = '3e3556f0-6494-4e8f-858f-01f2c358861a';
const S3_BUCKET = 'spacecat-prod-importer';
const EXPECTED_S3_KEY = `fanout/llmo/${SPACE_CAT_ID}/${BRAND_ID}/data.json.gz`;
const PRESIGNED_URL = 'https://s3.amazonaws.com/spacecat-prod-importer/fanout/llmo/5d4e5082-b030-433d-9dbd-7007116f701f/3e3556f0-6494-4e8f-858f-01f2c358861a/data.json.gz?X-Amz-Signature=abc';

describe('FanoutReportController', () => {
  let sandbox;
  let mockContext;
  let mockOrganization;
  let mockAccessControlUtil;
  let mockS3Send;
  let mockGetSignedUrl;
  let mockCurate;
  let mockGetGrpcClients;
  let FanoutReportController;
  const FAKE_REPORT = {
    schemaVersion: 1,
    generatedAt: '2026-05-13T10:00:00Z',
    isoDate: '2026-05-08',
    orgId: SPACE_CAT_ID,
    brandId: BRAND_ID,
    brandName: 'Acme',
    brandDomains: ['acme.com'],
    country: 'US',
    llm: 'chatgpt',
    windowDays: 7,
    topics: [],
  };

  before(async () => {
    // Single esmock cold-start; reused across all tests.
    mockCurate = sinon.stub().resolves({
      report: FAKE_REPORT,
      stats: {
        dbTopics: 0, semrushReturned: 0, similarityPassed: 0, topicsPicked: 0, tDb: 1, tSem: 1,
      },
    });
    mockGetGrpcClients = sinon.stub().returns({
      fanoutClient: { resolveTopicMetrics: sinon.stub() },
    });

    const mod = await esmock('../../../src/controllers/llmo/fanout-report.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
      '../../../src/support/ai-visibility/grpc-transport.js': {
        getGrpcClients: (...args) => mockGetGrpcClients(...args),
      },
      '../../../src/support/fanout/curate.js': {
        curateFanoutReport: (...args) => mockCurate(...args),
        // Real gzip implementation is fine here — output is just a buffer.
        gzipReport: (report) => Buffer.from(JSON.stringify(report)),
      },
    });
    FanoutReportController = mod.default;
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockOrganization = { getId: sandbox.stub().returns(SPACE_CAT_ID) };

    mockS3Send = sandbox.stub().resolves({ /* HeadObject / PutObject 200 */ });
    mockGetSignedUrl = sandbox.stub().resolves(PRESIGNED_URL);

    mockContext = {
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
      params: { spaceCatId: SPACE_CAT_ID, brandId: BRAND_ID },
      env: {},
      dataAccess: {
        Organization: {
          findById: sandbox.stub().resolves(mockOrganization),
        },
        services: {
          postgrestClient: { rpc: sandbox.stub() },
        },
      },
      s3: {
        s3Client: { send: mockS3Send },
        s3Bucket: S3_BUCKET,
        getSignedUrl: mockGetSignedUrl,
        GetObjectCommand: function MockGetObjectCommand(params) {
          this.params = params;
        },
      },
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(false),
    };

    // Full reset so behaviors don't leak across tests; then re-apply defaults.
    mockCurate.reset();
    mockCurate.resolves({
      report: FAKE_REPORT,
      stats: {
        dbTopics: 0, semrushReturned: 0, similarityPassed: 0, topicsPicked: 0, tDb: 1, tSem: 1,
      },
    });
    mockGetGrpcClients.reset();
    mockGetGrpcClients.returns({ fanoutClient: { resolveTopicMetrics: sinon.stub() } });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getFanoutReport', () => {
    it('returns 302 with presigned URL when the report exists', async () => {
      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(302);
      expect(result.headers.get('Location')).to.equal(PRESIGNED_URL);

      // HeadObject called with the expected bucket/key
      expect(mockS3Send).to.have.been.calledOnce;
      const headCommand = mockS3Send.firstCall.args[0];
      expect(headCommand).to.be.instanceOf(HeadObjectCommand);
      expect(headCommand.input.Bucket).to.equal(S3_BUCKET);
      expect(headCommand.input.Key).to.equal(EXPECTED_S3_KEY);

      // Presigned URL generated for the same key with 1h TTL
      const signedArgs = mockGetSignedUrl.firstCall.args;
      expect(signedArgs[1].params.Bucket).to.equal(S3_BUCKET);
      expect(signedArgs[1].params.Key).to.equal(EXPECTED_S3_KEY);
      expect(signedArgs[2].expiresIn).to.equal(3600);
    });

    it('returns 404 when HeadObject throws NotFound', async () => {
      const err = new Error('Not Found');
      err.name = 'NotFound';
      mockS3Send.rejects(err);

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(404);
      expect(mockGetSignedUrl).not.to.have.been.called;
    });

    it('returns 404 when HeadObject error carries httpStatusCode 404', async () => {
      const err = new Error('Object not found');
      err.name = 'SomethingElse';
      err.$metadata = { httpStatusCode: 404 };
      mockS3Send.rejects(err);

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(404);
    });

    it('returns 404 when the organization is not found', async () => {
      mockContext.dataAccess.Organization.findById.resolves(null);

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(404);
      // Did not even touch S3
      expect(mockS3Send).not.to.have.been.called;
      expect(mockGetSignedUrl).not.to.have.been.called;
    });

    it('returns 404 (not 403) when the caller lacks LLMO access — does not leak org existence', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(404);
      expect(mockS3Send).not.to.have.been.called;
      // Confirm access check used the LLMO product code
      expect(mockAccessControlUtil.hasAccess).to.have.been.calledWith(mockOrganization, '', 'LLMO');
    });

    it('returns 400 when S3 is not configured at all', async () => {
      mockContext.s3 = null;

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns 400 when the S3 bucket is missing', async () => {
      mockContext.s3.s3Bucket = null;

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns 400 when HeadObject throws an unexpected error', async () => {
      const err = new Error('boom');
      err.name = 'AccessDenied';
      mockS3Send.rejects(err);

      const controller = FanoutReportController(mockContext);
      const result = await controller.getFanoutReport(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.called;
    });
  });

  describe('triggerFanoutReport', () => {
    it('returns 201 and writes a gzipped report to S3', async () => {
      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(201);

      // Curation called with the hardcoded country/llm + window
      const curateArgs = mockCurate.firstCall.args[0];
      expect(curateArgs.organizationId).to.equal(SPACE_CAT_ID);
      expect(curateArgs.brandId).to.equal(BRAND_ID);
      expect(curateArgs.countryName).to.equal('US');
      expect(curateArgs.llmName).to.equal('chatgpt');
      expect(curateArgs.windowDays).to.equal(7);
      expect(curateArgs.concurrency).to.equal(5); // default
      expect(curateArgs.batchSize).to.equal(100); // default

      // PutObject called with the expected key + gzip encoding
      expect(mockS3Send).to.have.been.calledOnce;
      const putCommand = mockS3Send.firstCall.args[0];
      expect(putCommand).to.be.instanceOf(PutObjectCommand);
      expect(putCommand.input.Bucket).to.equal(S3_BUCKET);
      expect(putCommand.input.Key).to.equal(EXPECTED_S3_KEY);
      expect(putCommand.input.ContentEncoding).to.equal('gzip');
      expect(putCommand.input.ContentType).to.equal('application/json');
      expect(putCommand.input.Body).to.be.instanceOf(Buffer);
    });

    it('honours SEMRUSH_FANOUT_CONCURRENCY and SEMRUSH_FANOUT_BATCH_SIZE env vars', async () => {
      mockContext.env = {
        SEMRUSH_FANOUT_CONCURRENCY: '3',
        SEMRUSH_FANOUT_BATCH_SIZE: '50',
      };

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(201);
      const curateArgs = mockCurate.firstCall.args[0];
      expect(curateArgs.concurrency).to.equal(3);
      expect(curateArgs.batchSize).to.equal(50);
    });

    it('returns 400 when S3 is not configured', async () => {
      mockContext.s3 = null;

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(400);
      expect(mockCurate).not.to.have.been.called;
    });

    it('returns 404 when the organization is not found', async () => {
      mockContext.dataAccess.Organization.findById.resolves(null);

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(404);
      expect(mockCurate).not.to.have.been.called;
      expect(mockS3Send).not.to.have.been.called;
    });

    it('returns 404 when the caller lacks LLMO access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(404);
      expect(mockCurate).not.to.have.been.called;
    });

    it('returns 400 when PostgREST is not configured', async () => {
      mockContext.dataAccess.services = {};

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(400);
      expect(mockCurate).not.to.have.been.called;
    });

    it('returns 400 when gRPC client init fails', async () => {
      mockGetGrpcClients.throws(new Error('missing creds'));

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(400);
      expect(mockCurate).not.to.have.been.called;
    });

    it('returns 500 when curation throws', async () => {
      mockCurate.rejects(new Error('semrush exploded'));

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(500);
      expect(mockContext.log.error).to.have.been.called;
    });

    it('returns 500 when S3 PutObject throws', async () => {
      mockS3Send.rejects(new Error('S3 down'));

      const controller = FanoutReportController(mockContext);
      const result = await controller.triggerFanoutReport(mockContext);

      expect(result.status).to.equal(500);
    });
  });
});
