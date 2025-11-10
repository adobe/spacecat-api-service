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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { describe } from 'mocha';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import PTA2Controller from '../../../src/controllers/paid/pta2.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);
const gunzipAsync = promisify(gunzip);

const SITE_ID = 'test-site-id';
const TEST_PRESIGNED_URL = 'https://test-presigned-url.com';

describe('PTA2Controller', () => {
  let sandbox;
  let mockS3;
  let mockAthena;
  let mockAthenaQuery;
  let mockLog;
  let mockEnv;
  let mockContext;
  let mockSite;
  let mockAccessControlUtil;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockS3 = { s3Client: sandbox.stub(), send: sandbox.stub() };
    mockAthenaQuery = sandbox.stub();
    mockAthena = { query: mockAthenaQuery };
    mockLog = {
      info: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    mockEnv = {
      RUM_METRICS_DATABASE: 'test-db',
      RUM_METRICS_COMPACT_TABLE: 'test-table',
      S3_BUCKET_NAME: 'test-bucket',
    };
    mockSite = {
      id: SITE_ID,
      getBaseURL: sandbox.stub().resolves('https://www.test.com'),
    };
    mockAccessControlUtil = { hasAccess: sandbox.stub().resolves(true) };
    mockContext = {
      invocation: { requestId: 'test-request-id' },
      params: { siteId: SITE_ID },
      data: {
        year: 2024,
        week: 23,
      },
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(mockSite) },
      },
      s3: {
        s3Client: mockS3,
        getSignedUrl: sandbox.stub().resolves(TEST_PRESIGNED_URL),
      },
      athenaClient: mockAthena,
    };
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    mockS3.send.callsFake((cmd) => {
      if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key.includes(`${SITE_ID}/`)) {
        const err = new Error('not found');
        err.name = 'NotFound';
        return Promise.reject(err);
      }
      if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getPTAWeeklySummary', () => {
    it('returns 404 if site not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(404);
      const body = await res.json();
      expect(body.message).to.equal('Site not found');
    });

    it('returns 403 if access denied', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(403);
      const body = await res.json();
      expect(body.message).to.equal('Only users belonging to the organization can view paid traffic metrics');
    });

    it('returns 400 if year is missing', async () => {
      delete mockContext.data.year;
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year is a required parameter');
    });

    it('returns 400 if both week and month are missing', async () => {
      delete mockContext.data.week;
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Either week or month must be provided');
    });

    it('returns 400 if both week and month are zero', async () => {
      mockContext.data.week = 0;
      mockContext.data.month = 0;
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Either week or month must be non-zero');
    });

    it('returns 400 for invalid year parameter', async () => {
      mockContext.data.year = 'invalid';
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year must be a valid number');
    });

    it('returns 400 for invalid week parameter', async () => {
      mockContext.data.week = 'invalid';
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Week must be a valid number');
    });

    it('returns 400 for invalid month parameter', async () => {
      mockContext.data.month = 'invalid';
      delete mockContext.data.week;
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Month must be a valid number');
    });

    it('queries Athena and returns 200 with requested data', async () => {
      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
        {
          period: 'previous',
          total_pageviews: 950,
          click_rate: 0.44,
          engagement_rate: 0.74,
          bounce_rate: 0.26,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('uses month parameter when week is not provided', async () => {
      delete mockContext.data.week;
      mockContext.data.month = 12;

      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
        {
          period: 'previous',
          total_pageviews: 950,
          click_rate: 0.44,
          engagement_rate: 0.74,
          bounce_rate: 0.26,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;

      // Verify the query includes the month
      const query = mockAthenaQuery.args[0][0];
      expect(query).to.include('12');
    });

    it('uses both week and month if both are provided', async () => {
      mockContext.data.week = 23;
      mockContext.data.month = 6;

      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
        {
          period: 'previous',
          total_pageviews: 950,
          click_rate: 0.44,
          engagement_rate: 0.74,
          bounce_rate: 0.26,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('handles null year parameter', async () => {
      mockContext.data.year = null;
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year is a required parameter');
    });

    it('handles undefined year parameter', async () => {
      mockContext.data.year = undefined;
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year is a required parameter');
    });

    it('accepts numeric string for year parameter', async () => {
      mockContext.data.year = '2024';
      mockContext.data.week = '23';

      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
        {
          period: 'previous',
          total_pageviews: 950,
          click_rate: 0.44,
          engagement_rate: 0.74,
          bounce_rate: 0.26,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('uses correct database and table names from env', async () => {
      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
        {
          period: 'previous',
          total_pageviews: 950,
          click_rate: 0.44,
          engagement_rate: 0.74,
          bounce_rate: 0.26,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      await controller.getPTAWeeklySummary();

      const query = mockAthenaQuery.args[0][0];
      expect(query).to.include('test-db.test-table');

      const database = mockAthenaQuery.args[0][1];
      expect(database).to.equal('test-db');

      const description = mockAthenaQuery.args[0][2];
      expect(description).to.include('test-db');
      expect(description).to.include(SITE_ID);
    });

    it('returns 200 with data when trends are null (only one period)', async () => {
      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body).to.have.property('pageviews', 1000);
      expect(body).to.have.property('click_rate', 0.45);
      expect(body).to.have.property('engagement_rate', 0.75);
      expect(body).to.have.property('bounce_rate', 0.25);
      expect(body).to.have.property('trends');
      expect(body.trends).to.be.null;
    });

    it('returns 200 with complete data including trends', async () => {
      const mockAthenaResults = [
        {
          period: 'current',
          total_pageviews: 1000,
          click_rate: 0.45,
          engagement_rate: 0.75,
          bounce_rate: 0.25,
        },
        {
          period: 'previous',
          total_pageviews: 950,
          click_rate: 0.44,
          engagement_rate: 0.74,
          bounce_rate: 0.26,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body).to.have.property('pageviews', 1000);
      expect(body).to.have.property('click_rate', 0.45);
      expect(body).to.have.property('engagement_rate', 0.75);
      expect(body).to.have.property('bounce_rate', 0.25);
      expect(body).to.have.property('trends');
      expect(body.trends).to.not.be.null;
      expect(body.trends).to.have.property('pageviews');
      expect(body.trends).to.have.property('click_rate');
      expect(body.trends).to.have.property('engagement_rate');
      expect(body.trends).to.have.property('bounce_rate');
    });
  });
});
