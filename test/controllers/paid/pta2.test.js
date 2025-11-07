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
let lastPutObject;

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

    lastPutObject = undefined;
    mockS3.send.callsFake((cmd) => {
      if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key.includes(`${SITE_ID}/`)) {
        // Default: Simulate cache miss
        const err = new Error('not found');
        err.name = 'NotFound';
        return Promise.reject(err);
      }
      if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
        lastPutObject = cmd;
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

    it('returns 302 with cached result if cache exists', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          // Simulate cache exists
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('queries Athena and returns 200 with fresh data on cache miss', async () => {
      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
          sessions: 800,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
      expect(lastPutObject).to.exist;
    });

    it('bypasses cache when noCache is true', async () => {
      mockContext.data.noCache = true;
      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('bypasses cache when noCache is string "true"', async () => {
      mockContext.data.noCache = 'true';
      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('returns 200 with empty array if Athena returns no results', async () => {
      mockAthenaQuery.resolves([]);
      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      // Empty results should not be cached
      expect(lastPutObject).to.not.exist;
      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());
      expect(body).to.deep.equal([]);
    });

    it('returns 302 when cache is successfully verified after being created', async () => {
      let cacheExists = false;
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          if (cacheExists) {
            return Promise.resolve({});
          }
          const err = new Error('not found');
          err.name = 'NotFound';
          return Promise.reject(err);
        }
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          lastPutObject = cmd;
          cacheExists = true;
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      expect(mockLog.debug).to.have.been.calledWithMatch('Successfully verified file existence');
    });

    it('returns response directly if cache write fails', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          throw new Error('S3 put failed');
        }
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key.includes(`${SITE_ID}/`)) {
          const err = new Error('not found');
          err.name = 'NotFound';
          return Promise.reject(err);
        }
        return Promise.resolve({});
      });

      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      const contentEncoding = res.headers.get('content-encoding');
      expect(contentEncoding).to.equal('gzip');
    });

    it('uses month parameter when week is not provided', async () => {
      delete mockContext.data.week;
      mockContext.data.month = 12;

      const mockAthenaResults = [
        {
          year: 2024,
          month: 12,
          pageviews: 1000,
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
          year: 2024,
          week: 23,
          month: 6,
          pageviews: 1000,
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
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('handles cache verification failure by returning response directly', async () => {
      let putCalled = false;
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          putCalled = true;
          lastPutObject = cmd;
          return Promise.resolve({});
        }
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          if (putCalled) {
            // Simulate verification failure
            const err = new Error('not found');
            err.name = 'NotFound';
            return Promise.reject(err);
          }
          const err = new Error('not found');
          err.name = 'NotFound';
          return Promise.reject(err);
        }
        return Promise.resolve({});
      });

      // Also stub getSignedUrl to return null
      mockContext.s3.getSignedUrl.resolves(null);

      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      const res = await controller.getPTAWeeklySummary();
      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch('Failed to return cache key');
      const contentEncoding = res.headers.get('content-encoding');
      expect(contentEncoding).to.equal('gzip');
    });

    it('uses correct database and table names from env', async () => {
      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
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

    it('logs appropriate messages throughout the flow', async () => {
      const mockAthenaResults = [
        {
          year: 2024,
          week: 23,
          pageviews: 1000,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = PTA2Controller(mockContext, mockLog, mockEnv);
      await controller.getPTAWeeklySummary();

      expect(mockLog.info).to.have.been.calledWithMatch('Cached result for file:');
      expect(mockLog.info).to.have.been.calledWithMatch('Athena result JSON to S3 cache');
    });
  });
});
