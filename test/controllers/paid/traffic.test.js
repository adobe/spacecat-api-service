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
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe } from 'mocha';
import TrafficController from '../../../src/controllers/paid/traffic.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../controllers/fixtures');
const SITE_ID = 'site-id';
const TEST_RESIGNED_URL = 'https://expected-url.com';
let lastPutObject;

describe('Paid TrafficController', async () => {
  let sandbox;
  let mockS3;
  let mockAthena;
  let mockAthenaQuery;
  let mockLog;
  let mockEnv;
  let mockContext;
  let mockSite;
  let mockAccessControlUtil;
  let trafficTypeMock;
  let trafficTypeExpected;

  beforeEach(async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, 'sample-athena-type-response.json'), 'utf-8');
    trafficTypeMock = JSON.parse(raw);
    trafficTypeExpected = trafficTypeMock.map(({
    // eslint-disable-next-line no-unused-vars, camelcase
      p70_cls, p70_inp, p70_lcp, trf_type, ...rest
    }) => ({
      // eslint-disable-next-line camelcase
      type: trf_type, // rename `trf_type` → `type`
      ...rest,
    }));
    sandbox = sinon.createSandbox();
    mockS3 = { s3Client: sandbox.stub(), send: sandbox.stub() };
    mockAthenaQuery = sandbox.stub();
    mockAthena = { query: mockAthenaQuery };
    mockLog = {
      info: sandbox.stub(), debug: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(),
    };
    mockEnv = {
      PAID_TRAFFIC_DATABASE: 'db',
      PAID_TRAFFIC_TABLE_NAME: 'table',
      PAID_TRAFFIC_S3_OUTPUT_URI: 's3://output',
      PAID_TRAFFIC_S3_CACHE_BUCKET_URI: 's3://cache',
    };
    mockSite = { id: SITE_ID };
    mockAccessControlUtil = { hasAccess: sandbox.stub().resolves(true) };
    mockContext = {
      params: { siteId: SITE_ID },
      data: {
        siteKey: 'site-key', year: 2024, month: 6, week: 23,
      },
      dataAccess: { Site: { findById: sandbox.stub().resolves(mockSite) } },
      s3: { s3Client: mockS3, getSignedUrl: sandbox.stub().resolves(TEST_RESIGNED_URL) },
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

  describe('FetchPaidTrafficData', () => {
    it('getPaidTrafficByTypeChannel fresh returns expected', async () => {
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_RESIGNED_URL);
      // Validate the object put to S3
      expect(lastPutObject).to.exist;
      const putBody = JSON.parse(lastPutObject.input.Body);
      expect(putBody).to.deep.equal(trafficTypeExpected);
    });

    it('getPaidTrafficByTypeChannel cached returns expected', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          // Simulate cache exists
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      mockAthenaQuery.resolves(trafficTypeMock);

      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_RESIGNED_URL);
      // Validate no query was made
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('does not log error if cache file is missing (known exception)', async () => {
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_RESIGNED_URL);
      // Validate the object put to S3
      expect(lastPutObject).to.exist;
      const putBody = JSON.parse(lastPutObject.input.Body);
      expect(putBody).to.deep.equal(trafficTypeExpected);
      expect(mockLog.error).not.to.have.been.called;
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('getPaidTrafficByTypeChannelCampaign with cache disabled returns expected', async () => {
      // Disable cache bucket
      const envNoCache = { ...mockEnv, PAID_TRAFFIC_S3_CACHE_BUCKET_URI: undefined };
      const mockAthenaOutput = [
        {
          trf_type: 'search', trf_channel: 'google', utm_campaign: 'summer', unrelated: 1000,
        },
        {
          trf_type: 'display', trf_channel: 'facebook', utm_campaign: 'fall', unrelated: 500,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaOutput);

      const controller = TrafficController(mockContext, mockLog, envNoCache);
      const res = await controller.getPaidTrafficByTypeChannelCampaign();
      expect(res.status).to.equal(302);
      const putBody = JSON.parse(lastPutObject.input.Body);

      const expetedOutput = [
        {
          type: 'search', channel: 'google', campaign: 'summer',
        },
        {
          type: 'display', channel: 'facebook', campaign: 'fall',
        },
      ];
      expect(putBody).to.deep.equal(expetedOutput);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('returns 404 if site not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(404);
    });

    it('returns 403 if access denied', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(403);
    });

    it('returns 400 with msg if siteKey, year, month, or week is missing', async () => {
      const requiredFields = ['year', 'week'];
      for (const field of requiredFields) {
        const badData = { ...mockContext.data };
        delete badData[field];
        const badContext = { ...mockContext, data: badData };
        const controller = TrafficController(badContext, mockLog, mockEnv);
        // eslint-disable-next-line no-await-in-loop
        const rest = await controller.getPaidTrafficByTypeChannelCampaign();
        expect(rest.status).to.equal(400);
        // eslint-disable-next-line no-await-in-loop
        const body = await rest.json();
        expect(body.message).to.equal('year and week are required parameters');
      }
    });

    it('getPaidTrafficByTypeChannel returns empty array if Athena returns empty', async () => {
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_RESIGNED_URL);
      // Validate the object put to S3
      expect(lastPutObject).to.exist;
      const putBody = JSON.parse(lastPutObject.input.Body);
      expect(putBody).to.deep.equal([]);
    });

    it('uses default db, table, and S3 paths if env vars are missing', async () => {
      const envNoDbTableS3 = { ...mockEnv };
      delete envNoDbTableS3.PAID_TRAFFIC_DATABASE;
      delete envNoDbTableS3.PAID_TRAFFIC_TABLE_NAME;
      delete envNoDbTableS3.PAID_TRAFFIC_S3_OUTPUT_URI;
      delete envNoDbTableS3.PAID_TRAFFIC_S3_CACHE_BUCKET_URI;
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, envNoDbTableS3);
      await controller.getPaidTrafficByTypeChannel();

      // Validate cache URL was used in S3 calls
      const s3Calls = mockS3.send.getCalls();
      const cacheUsed = s3Calls.some((call) => {
        const input = call.args[0]?.input || call.args[0];
        return input
          && input.Bucket
          && input.Bucket.includes('spacecat-dev-segments')
          && input.Key
          && input.Key.includes('cache');
      });
      expect(cacheUsed).to.be.true;
    });

    it('getPaidTrafficByCampaignUrlDevice uses custom threshold config if provided', async () => {
      // Custom thresholds: make LCP_GOOD very high so all values are 'good',
      const customGood = {
        LCP_GOOD: 10,
        LCP_NEEDS_IMPROVEMENT: 20,
        INP_GOOD: 10,
        INP_NEEDS_IMPROVEMENT: 20,
        CLS_GOOD: 10,
        CLS_NEEDS_IMPROVEMENT: 20,
      };
      mockAthenaQuery.resolves([
        {
          utm_campaign: 'spring',
          path: '/home',
          device: 'mobile',
          pageviews: 100,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 5,
          p70_cls: 5,
          p70_inp: 5,
        },
      ]);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, CWV_THRESHOLDS: customGood },
      );
      await controller.getPaidTrafficByCampaignUrlDevice();
      const putBody = JSON.parse(lastPutObject.input.Body)[0];
      expect(putBody.lcp_score).to.equal('good');
      expect(putBody.inp_score).to.equal('good');
      expect(putBody.cls_score).to.equal('good');
    });

    it('getPaidTrafficByCampaignDevice returns expected and uses correct dimensions and DTO', async () => {
      mockAthenaQuery.resolves([
        {
          utm_campaign: 'fall', device: 'desktop', pageviews: 302, pct_pageviews: 0.7, click_rate: 0.2, engagement_rate: 0.3, bounce_rate: 0.4, p70_lcp: 2.6, p70_cls: 0.11, p70_inp: 0.3,
        },
        {
          utm_campaign: 'fall', device: 'tablet', pageviews: 100, pct_pageviews: 0.3, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.0, p70_cls: 0.09, p70_inp: 600,
        },
      ]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByCampaignDevice();
      expect(res.status).to.equal(302);
      const putBody = JSON.parse(lastPutObject.input.Body);
      expect(putBody[0].overall_cwv_score).to.equal('needs improvement');
      expect(putBody[1].overall_cwv_score).to.equal('poor');
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;
      expect(athenaCall.args[0]).to.include('utm_campaign, device');
    });

    it('getPaidTrafficByCampaignUrl returns expected and uses correct dimensions and DTO', async () => {
      mockAthenaQuery.resolves([
        {
          utm_campaign: 'winter', path: '/about', pageviews: 300, pct_pageviews: 0.8, click_rate: 0.3, engagement_rate: 0.4, bounce_rate: 0.5, p70_lcp: 2.0, p70_cls: 0.09, p70_inp: 150, // good
        },
        {
          utm_campaign: 'winter', path: '/contact', pageviews: 100, pct_pageviews: 0.2, click_rate: 0.05, engagement_rate: 0.1, bounce_rate: 0.2, p70_lcp: 3.0, p70_cls: 0.2, p70_inp: 250, // needs improvement
        },
        {
          utm_campaign: 'spring', path: '/home', pageviews: 302, pct_pageviews: 0.5, click_rate: 0.2, engagement_rate: 0.3, bounce_rate: 0.4, p70_lcp: 1.5, p70_cls: 0.05, p70_inp: 100, // good
        },
        {
          utm_campaign: 'fall', path: '/landing', pageviews: 150, pct_pageviews: 0.3, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 4.5, p70_cls: 0.3, p70_inp: 600, // poor
        },
        {
          utm_campaign: 'summer', path: '/promo', pageviews: 120, pct_pageviews: 0.1, click_rate: 0.07, engagement_rate: 0.15, bounce_rate: 0.25, p70_lcp: 2.2, p70_cls: 0.08, p70_inp: 180, // good
        },
      ]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByCampaignUrl();
      expect(res.status).to.equal(302);
      const putBody = JSON.parse(lastPutObject.input.Body);
      expect(putBody.length).to.equal(5);
      // Check that each item in the result matches the input campaign/url
      const expectedCombos = [
        ['winter', '/about', 'good'],
        ['winter', '/contact', 'needs improvement'],
        ['spring', '/home', 'good'],
        ['fall', '/landing', 'poor'],
        ['summer', '/promo', 'good'],
      ];
      for (let i = 0; i < expectedCombos.length; i += 1) {
        expect(putBody[i].campaign).to.equal(expectedCombos[i][0]);
        expect(putBody[i].url).to.equal(expectedCombos[i][1]);
        expect(putBody[i].overall_cwv_score).to.equal(expectedCombos[i][2]);
      }
      // Check that the correct dimensions were used in the query
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;
      expect(athenaCall.args[0]).to.include('utm_campaign, path');
    });

    it('getPaidTrafficByCampaign returns expected and uses correct dimensions and DTO', async () => {
      mockAthenaQuery.resolves([
        {
          campaign: 'summer', pageviews: 400, pct_pageviews: 0.9, click_rate: 0.4, engagement_rate: 0.5, bounce_rate: 0.6, p70_lcp: 3020, p70_cls: 0.09, p70_inp: 150,
        },
        {
          campaign: 'summer', pageviews: 100, pct_pageviews: 0.1, click_rate: 0.01, engagement_rate: 0.02, bounce_rate: 0.03, p70_lcp: 5000, p70_cls: 0.09, p70_inp: 150,
        },
      ]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByCampaign();
      expect(res.status).to.equal(302);
      const putBody = JSON.parse(lastPutObject.input.Body);
      expect(putBody[0].overall_cwv_score).to.equal('needs improvement');
      expect(putBody[1].overall_cwv_score).to.equal('poor');
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;
      expect(athenaCall.args[0]).to.include('campaign');
    });

    it('getPaidTrafficByTypeChannel respects noCache flag and skips cache', async () => {
      // Set noCache flag
      mockContext.data.noCache = true;
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_RESIGNED_URL);
      // Ensure Athena was queried
      expect(mockAthenaQuery).to.have.been.calledOnce;
      // Ensure S3 HeadObjectCommand (cache check) was not called
      const s3Calls = mockS3.send.getCalls();
      const headObjectCalled = s3Calls.some((call) => call.args[0]?.constructor?.name === 'HeadObjectCommand');
      expect(headObjectCalled).to.be.false;
    });

    it('getPaidTrafficByTypeChannel query includes both months and years when week spans two months/years', async () => {
      mockContext.data.year = 2024;
      mockContext.data.week = 53; // Last week of 2024, spans into Jan 2025
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      await controller.getPaidTrafficByTypeChannel();
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;

      expect(athenaCall.args[0]).to.match(/(12, 1|1, 12)/); // months
      expect(athenaCall.args[0]).to.match(/(2025, 2024|2024, 2025)/); // years
    });

    it('getPaidTrafficByTypeChannel query handles friday start date (ISO week edge case)', async () => {
      // Week 1 of 2025 starts in December 2024 and ends in January 2025 (ISO week edge case)
      mockContext.data.year = 2021;
      mockContext.data.week = 51;
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      await controller.getPaidTrafficByTypeChannel();
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;
      expect(athenaCall.args[0]).to.match(/(51)/); // months
      expect(athenaCall.args[0]).to.match(/(2021)/); // years
    });

    it('returns response directly if caching fails due to S3 PutObjectCommand error (covers src/controllers/paid/traffic.js lines 163-164)', async () => {
      // Simulate S3 PutObjectCommand throwing an error (cache write fails)
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          throw new Error('S3 put failed');
        }
        // Default: simulate cache miss for HeadObjectCommand
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key.includes(`${SITE_ID}/`)) {
          const err = new Error('not found');
          err.name = 'NotFound';
          return Promise.reject(err);
        }
        return Promise.resolve({});
      });
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(trafficTypeExpected);
    });
  });
});
