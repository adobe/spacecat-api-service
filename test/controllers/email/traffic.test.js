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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import { describe } from 'mocha';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import EmailTrafficController from '../../../src/controllers/email/traffic.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);
const gunzipAsync = promisify(gunzip);

const SITE_ID = 'test-site-id';
const TEST_PRESIGNED_URL = 'https://test-presigned-url.com';
let lastPutObject;

describe('EmailTrafficController', () => {
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
      getPageTypes: sandbox.stub().resolves(null),
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

  describe('fetchEmailTrafficData', () => {
    const emailAthenaResults = [
      {
        utm_campaign: 'spring-sale',
        utm_medium: 'email',
        pageviews: '500',
        visits: '300',
        bounce_rate: '0.25',
        engagement_rate: '0.75',
        click_rate: '0.45',
      },
      {
        utm_campaign: 'newsletter',
        utm_medium: 'social',
        pageviews: '100',
        visits: '50',
        bounce_rate: '0.50',
        engagement_rate: '0.50',
        click_rate: '0.20',
      },
    ];

    it('returns 404 if site not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(404);
      const body = await res.json();
      expect(body.message).to.equal('Site not found');
    });

    it('returns 403 if access denied', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(403);
      const body = await res.json();
      expect(body.message).to.equal('Only users belonging to the organization can view email traffic metrics');
    });

    it('returns 400 if year is missing', async () => {
      delete mockContext.data.year;
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year is a required parameter');
    });

    it('returns 400 if both week and month are missing', async () => {
      delete mockContext.data.week;
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Either week or month must be provided');
    });

    it('returns 400 if both week and month are zero', async () => {
      mockContext.data.week = 0;
      mockContext.data.month = 0;
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Either week or month must be non-zero');
    });

    it('returns 400 for invalid year parameter', async () => {
      mockContext.data.year = 'invalid';
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year must be a valid number');
    });

    it('returns 400 for invalid week parameter', async () => {
      mockContext.data.week = 'invalid';
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Week must be a valid number');
    });

    it('returns 400 for invalid month parameter', async () => {
      mockContext.data.month = 'invalid';
      delete mockContext.data.week;
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Month must be a valid number');
    });

    it('filters results by utm_medium=email and returns 200', async () => {
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      // Returns 200 when cache write fails to return signed URL
      expect(res.status).to.equal(200);
      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      // Only the email row should be included
      expect(putBody).to.have.length(1);
      expect(putBody[0].campaign).to.equal('spring-sale');
    });

    it('returns cached result when available', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(302);
      expect(mockAthenaQuery).to.not.have.been.called;
    });

    it('skips cache when noCache is true', async () => {
      mockContext.data.noCache = true;
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('handles empty results', async () => {
      mockAthenaQuery.resolves([]);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(200);
      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());
      expect(body).to.deep.equal([]);
    });

    it('uses EMAIL_DATA_THRESHOLD from env', async () => {
      mockEnv.EMAIL_DATA_THRESHOLD = 100;
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficByCampaign();
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('disables threshold when noThreshold is true', async () => {
      mockContext.data.noThreshold = true;
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficByCampaign();
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('handles CWV_THRESHOLDS as string', async () => {
      mockEnv.CWV_THRESHOLDS = '{"lcp": 2500}';
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficByCampaign();
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('handles CWV_THRESHOLDS as object', async () => {
      mockEnv.CWV_THRESHOLDS = { lcp: 2500 };
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficByCampaign();
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('handles invalid CWV_THRESHOLDS JSON string', async () => {
      mockEnv.CWV_THRESHOLDS = 'not-json';
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficByCampaign();
      expect(mockLog.warn).to.have.been.called;
    });

    it('uses month parameter when week is not provided', async () => {
      delete mockContext.data.week;
      mockContext.data.month = 12;
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(200);
    });

    it('handles null year parameter', async () => {
      mockContext.data.year = null;
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(400);
    });

    it('resolves page types when page_type dimension is used', async () => {
      mockSite.getPageTypes.resolves([{ name: 'homepage', pattern: '^/$' }]);
      mockAthenaQuery.resolves(emailAthenaResults);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficByCampaignPageType();
      expect(mockSite.getPageTypes).to.have.been.calledOnce;
    });
  });

  describe('all controller methods exist', () => {
    it('exposes all campaign-centric methods', () => {
      mockAthenaQuery.resolves([]);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      expect(controller.getEmailTrafficByCampaign).to.be.a('function');
      expect(controller.getEmailTrafficByCampaignDevice).to.be.a('function');
      expect(controller.getEmailTrafficByCampaignPath).to.be.a('function');
      expect(controller.getEmailTrafficByCampaignPathDevice).to.be.a('function');
      expect(controller.getEmailTrafficByCampaignPageType).to.be.a('function');
      expect(controller.getEmailTrafficByCampaignPageTypeDevice).to.be.a('function');
    });

    it('exposes all source-centric methods', () => {
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      expect(controller.getEmailTrafficBySource).to.be.a('function');
      expect(controller.getEmailTrafficBySourceCampaign).to.be.a('function');
    });

    it('exposes all landing page methods', () => {
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      expect(controller.getEmailTrafficByUrl).to.be.a('function');
      expect(controller.getEmailTrafficByUrlDevice).to.be.a('function');
      expect(controller.getEmailTrafficByUrlPageType).to.be.a('function');
      expect(controller.getEmailTrafficByUrlPageTypeDevice).to.be.a('function');
    });

    it('exposes page type, device, and temporal methods', () => {
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      expect(controller.getEmailTrafficByPageType).to.be.a('function');
      expect(controller.getEmailTrafficByPageTypeDevice).to.be.a('function');
      expect(controller.getEmailTrafficByDevice).to.be.a('function');
      expect(controller.getEmailTrafficTemporalSeriesByCampaign).to.be.a('function');
      expect(controller.getEmailTrafficTemporalSeriesByCampaignDevice).to.be.a('function');
      expect(controller.getEmailTrafficTemporalSeriesByUrl).to.be.a('function');
      expect(controller.getEmailTrafficTemporalSeriesByUrlDevice).to.be.a('function');
      expect(controller.getEmailTrafficTemporalSeriesBySource).to.be.a('function');
      expect(controller.getEmailTrafficTemporalSeriesByDevice).to.be.a('function');
    });
  });

  describe('temporal series (week-over-week)', () => {
    it('fetches temporal series data for campaign', async () => {
      mockAthenaQuery.resolves([]);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficTemporalSeriesByCampaign();
      expect(res.status).to.equal(200);
    });

    it('logs week-over-week parameters', async () => {
      mockAthenaQuery.resolves([]);
      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      await controller.getEmailTrafficTemporalSeriesByCampaign();
      expect(mockLog.info).to.have.been.called;
    });
  });

  describe('cache verification', () => {
    it('returns signed URL when cache write succeeds and is verified', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test',
        utm_medium: 'email',
        pageviews: '100',
        visits: '50',
        bounce_rate: '0.2',
        engagement_rate: '0.8',
        click_rate: '0.4',
      }]);

      let headCallCount = 0;
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          headCallCount += 1;
          if (headCallCount === 1) {
            // First call: cache miss
            const err = new Error('not found');
            err.name = 'NotFound';
            return Promise.reject(err);
          }
          // Subsequent calls: cache hit (verification)
          return Promise.resolve({});
        }
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          lastPutObject = cmd;
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      const controller = EmailTrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getEmailTrafficByCampaign();
      expect(res.status).to.equal(302);
    });
  });
});
