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
import { HeadObjectCommand } from '@aws-sdk/client-s3';

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
  let FanoutReportController;

  before(async () => {
    // Single esmock cold-start; reused across all tests.
    const mod = await esmock('../../../src/controllers/llmo/fanout-report.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => mockAccessControlUtil,
        },
      },
    });
    FanoutReportController = mod.default;
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockOrganization = { getId: sandbox.stub().returns(SPACE_CAT_ID) };

    mockS3Send = sandbox.stub().resolves({ /* HeadObject 200 */ });
    mockGetSignedUrl = sandbox.stub().resolves(PRESIGNED_URL);

    mockContext = {
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
      params: { spaceCatId: SPACE_CAT_ID, brandId: BRAND_ID },
      dataAccess: {
        Organization: {
          findById: sandbox.stub().resolves(mockOrganization),
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
});
