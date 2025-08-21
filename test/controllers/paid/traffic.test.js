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
import { gunzip } from 'zlib';
import { promisify } from 'util';
import TrafficController from '../../../src/controllers/paid/traffic.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);
const gunzipAsync = promisify(gunzip);

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../controllers/fixtures');
const SITE_ID = 'site-id';
const TEST_PRESIGNED_URL = 'https://expected-url.com';
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
  let pageTypesMock;
  let mockAccessControlUtil;
  let trafficTypeMock;
  let urlPageTypeCampaignDeviceMock;
  let trafficTypeExpected;
  let urlPageTypeCampaignDeviceExp;
  const siteId = SITE_ID;

  beforeEach(async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, 'sample-athena-type-response.json'), 'utf-8');
    const rawUrl = await fs.readFile(path.join(FIXTURES_DIR, 'sample-athena-url-page-type-campaign-device.json'), 'utf-8');
    const rawUrlExp = await fs.readFile(path.join(FIXTURES_DIR, 'sample-url-page-type-campaign-device-expected.json'), 'utf-8');
    trafficTypeMock = JSON.parse(raw);
    urlPageTypeCampaignDeviceMock = JSON.parse(rawUrl);
    urlPageTypeCampaignDeviceExp = JSON.parse(rawUrlExp);
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
      RUM_METRICS_DATABASE: 'db',
      RUM_METRICS_COMPACT_TABLE: 'table',
      S3_BUCKET_NAME: 's3://sample-bucket',
    };
    mockSite = { id: siteId, getBaseURL: sandbox.stub().resolves('https://www.sample.com'), getPageTypes: sandbox.stub().resolves(pageTypesMock) };
    mockAccessControlUtil = { hasAccess: sandbox.stub().resolves(true) };
    mockContext = {
      params: { siteId },
      data: {
        year: 2024, week: 23,
      },
      dataAccess: { Site: { findById: sandbox.stub().resolves(mockSite) } },
      s3: { s3Client: mockS3, getSignedUrl: sandbox.stub().resolves(TEST_PRESIGNED_URL) },
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
      expect(res.status).to.equal(200); // <-- CHANGED FROM 302 to 200
      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      expect(putBody).to.deep.equal(trafficTypeExpected);
    });

    it('getPaidTrafficByUrlPageTypeCampaignDevice fresh returns expected', async () => {
      pageTypesMock = null;
      mockAthenaQuery.resolves(urlPageTypeCampaignDeviceMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrlPageTypeCampaignDevice();
      expect(res.status).to.equal(200);
      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      expect(putBody).to.deep.equal(urlPageTypeCampaignDeviceExp);
    });

    it('getPaidTrafficByUrlPageTypeCampaignDevice with pageTypes fresh returns expected', async () => {
      pageTypesMock = [
        { name: 'homepage | Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/?$' },
        { name: 'productdetail | Product Detail Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/product/[a-z0-9\\-]+$' },
        { name: 'productlistpage | Category Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(tennis|baseball|softball|golf|basketball|custom|sportswear|accessories|gloves|footwear|sale|apparel|bags|protective|equipment|deals|football|volleyball|pickleball|padel|fastpitch|shoes|specialty-shops|official-partnerships)(/|$)' },
        { name: 'search | Search Results', pattern: '^(/([a-z]{2}-[a-z]{2}))?/search(\\?.*)?$' },
        { name: 'checkout | Checkout Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/checkout(/|$)' },
        { name: 'accountandorders | Login / Account / Wishlist / Order Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(login|account|register|customer|wishlist|d2x|sales)(/|$|/.*)' },
        { name: 'blog | Blog Articles', pattern: '^(/([a-z]{2}-[a-z]{2}))?/blog/.+$' },
        { name: 'blog | Blog Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/blog(/|$)' },
        { name: 'support | Support / Help / Warranty', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(support|warranty|contact|returns|faqs|size-guide|explore/help(/.*)?)(/|$)' },
        { name: 'legal | Legal / Terms / Privacy', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(terms|privacy|cookie-policy|accessibility|legal-notices|explore/terms-and-conditions|explore/legal)(/|$)' },
        { name: 'about | About / Brand / Company Info', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(about|careers|store-locator|explore/(about-us|careers|sportswear/our-stores|first-responders-discount|healthcare-worker-discount|tennis/wilson-athletes|football/ada-ohio-factory))(/|$)' },
        { name: 'landingpage | Promo / Campaign / Landing Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(customize|custom-builder|landing/[a-z0-9\\-]+|explore/basketball/airless-prototype|explore/forms/.*|explore/shoes/.*|explore/sportswear/lookbook)(/|$)' },
        { name: 'contentpage | Content Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(technology|team-dealers|partnerships|ambassadors|history|giftcard/balance)(/|$)' },
        { name: '404 | 404 Not Found', pattern: '^(/([a-z]{2}-[a-z]{2}))?/404(/|$)' },
        { name: 'other | Other Pages', pattern: '.*' },
      ];

      // Set noCache to true to bypass cache check and force re-generation
      mockContext.data.noCache = true;
      mockSite.getPageTypes = sandbox.stub().resolves(pageTypesMock);
      mockAthenaQuery.resolves(urlPageTypeCampaignDeviceMock);

      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrlPageTypeCampaignDevice();
      expect(res.status).to.equal(200);

      // Verify Athena was called, proving we didn't hit a pre-existing cache
      const athenaCall = mockAthenaQuery?.getCall(0);
      expect(athenaCall).to.exist;

      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      expect(putBody).to.deep.equal(urlPageTypeCampaignDeviceExp);
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
      expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('includes data threshold in query when PAID_DATA_THRESHOLD is set', async () => {
      const threshold = 4321;
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, PAID_DATA_THRESHOLD: threshold },
      );
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      const query = mockAthenaQuery.args[0][0];
      expect(query).to.include(String(threshold));
    });

    it('does not log error if cache file is missing (known exception)', async () => {
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      // Validate the object put to S3
      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      expect(putBody).to.deep.equal(trafficTypeExpected);
      expect(mockLog.error).not.to.have.been.called;
      expect(mockLog.warn).to.have.been;
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
      expect(res.status).to.equal(200);
      const expectedOutput = [
        {
          type: 'search', channel: 'google', campaign: 'summer',
        },
        {
          type: 'display', channel: 'facebook', campaign: 'fall',
        },
      ];
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      expect(putBody).to.deep.equal(expectedOutput);
      expect(mockAthenaQuery).to.have.been.calledOnce;
      const query = mockAthenaQuery.args[0][0];

      // by default dont filter on traffic type for typeChannel query
      expect(query).to.include('AND TRUE');
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

    it('returns 400 with msg if year is missing', async () => {
      const badData = { ...mockContext.data };
      delete badData.year;
      const badContext = { ...mockContext, data: badData };
      const controller = TrafficController(badContext, mockLog, mockEnv);
      const rest = await controller.getPaidTrafficByTypeChannelCampaign();
      expect(rest.status).to.equal(400);
      const body = await rest.json();
      expect(body.message).to.equal('Year is a required parameter');
    });

    it('returns 400 with msg if both week and month are missing', async () => {
      const badData = { ...mockContext.data };
      delete badData.week;
      const badContext = { ...mockContext, data: badData };
      const controller = TrafficController(badContext, mockLog, mockEnv);
      const rest = await controller.getPaidTrafficByTypeChannelCampaign();
      expect(rest.status).to.equal(400);
      const body = await rest.json();
      expect(body.message).to.equal('Either week or month must be provided');
    });

    it('returns 400 if both week and month are zero', async () => {
      const badData = { ...mockContext.data, week: '0', month: '0' };
      const badContext = { ...mockContext, data: badData };
      const controller = TrafficController(badContext, mockLog, mockEnv);
      const rest = await controller.getPaidTrafficByTypeChannelCampaign();
      expect(rest.status).to.equal(400);
      const body = await rest.json();
      expect(body.message).to.equal('Either week or month must be non-zero');
    });

    it('getPaidTrafficByTypeChannel returns empty array if Athena returns empty', async () => {
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      // Validate the object put to S3
      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
      expect(putBody).to.deep.equal([]);
    });

    it('getPaidTrafficByCampaignUrlDevice uses custom threshold config if provided', async () => {
      // Custom thresholds: make LCP_GOOD very high so all values are 'good',
      const customGood = {
        // eslint-disable-next-line quote-props
        'LCP_GOOD': 10,
        // eslint-disable-next-line quote-props
        'LCP_NEEDS_IMPROVEMENT': 20,
        // eslint-disable-next-line quote-props
        'INP_GOOD': 10,
        // eslint-disable-next-line quote-props
        'INP_NEEDS_IMPROVEMENT': 20,
        // eslint-disable-next-line quote-props
        'CLS_GOOD': 10,
        // eslint-disable-next-line quote-props
        'CLS_NEEDS_IMPROVEMENT': 20,
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
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString())[0];
      expect(putBody.lcp_score).to.equal('good');
      expect(putBody.inp_score).to.equal('good');
      expect(putBody.cls_score).to.equal('good');
    });

    it('uses custom threshold config from JSON string', async () => {
      const jsonThresholds = {
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
        { ...mockEnv, CWV_THRESHOLDS: JSON.stringify(jsonThresholds) },
      );
      await controller.getPaidTrafficByCampaignUrlDevice();
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString())[0];
      expect(putBody.lcp_score).to.equal('good');
      expect(putBody.inp_score).to.equal('good');
      expect(putBody.cls_score).to.equal('good');
    });

    it('falls back to default thresholds when CWV_THRESHOLDS is invalid JSON', async () => {
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
          p70_lcp: 5000,
          p70_cls: 0.4,
          p70_inp: 300,
        },
      ]);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, CWV_THRESHOLDS: '{not-json}' },
      );
      const res = await controller.getPaidTrafficByCampaignUrlDevice();
      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWith('Invalid CWV_THRESHOLDS JSON. Falling back to defaults.');
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
      expect(res.status).to.equal(200);
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
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
      expect(res.status).to.equal(200);
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
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
        expect(putBody[i].path).to.equal(expectedCombos[i][1]);
        expect(putBody[i].url).to.equal(`https://www.sample.com${expectedCombos[i][1]}`);
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
      expect(res.status).to.equal(200);
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString());
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
      expect(res.status).to.equal(200);
      // Ensure Athena was queried
      expect(mockAthenaQuery).to.have.been.calledOnce;
      // Ensure S3 HeadObjectCommand (cache check)
      // is still called to verify returning file existance is checked
      const s3Calls = mockS3.send.getCalls();
      const headObjectCalled = s3Calls.some((call) => call.args[0]?.constructor?.name === 'HeadObjectCommand');
      expect(headObjectCalled).to.be.true;
    });

    it('returns response directly if caching fails due to S3 PutObjectCommand error', async () => {
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
      const contentEncoding = res.headers.get('content-encoding');
      let body;
      if (contentEncoding === 'gzip') {
        const gzippedBuffer = Buffer.from(await res.arrayBuffer());
        const decompressed = await gunzipAsync(gzippedBuffer);
        body = JSON.parse(decompressed.toString());
      } else {
        body = await res.json();
      }
      expect(body).to.deep.equal(trafficTypeExpected);
    });

    it('returns signed URL when cache is successfully verified after being created', async () => {
      // Mock scenario where cache is created and then successfully verified
      let cacheExists = false;
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          if (cacheExists) {
            return Promise.resolve({}); // File exists
          } else {
            const err = new Error('not found');
            err.name = 'NotFound';
            return Promise.reject(err);
          }
        }
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          lastPutObject = cmd;
          cacheExists = true; // Simulate file being created
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      // Should return 302 (redirect) because cache verification succeeded
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      expect(mockLog.info).to.have.been.calledWithMatch('Succesfully verified file existance');
    });

    // Systematic test for all endpoint functions to ensure coverage
    it('All endpoint functions have correct dimensions and traffic filtering in query', async () => {
      const mockResponse = [{
        utm_campaign: 'test',
        path: '/test',
        device: 'desktop',
        pageviews: 100,
        pct_pageviews: 0.5,
        click_rate: 0.1,
        engagement_rate: 0.2,
        bounce_rate: 0.3,
        p70_lcp: 2.5,
        p70_cls: 0.1,
        p70_inp: 200,
        trf_type: 'paid',
        trf_channel: 'search',
        trf_platform: 'google',
        page_type: 'homepage',
      }];

      const endpointsWithDimensions = [
        { method: 'getPaidTrafficByCampaignUrlDevice', dimensions: 'utm_campaign, path, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByCampaignDevice', dimensions: 'utm_campaign, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByCampaignUrl', dimensions: 'utm_campaign, path', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByCampaign', dimensions: 'utm_campaign', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageType', dimensions: 'page_type', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByTypeChannelCampaign', dimensions: 'trf_type, trf_channel, utm_campaign', defaultFilter: 'none' },
        { method: 'getPaidTrafficByTypeChannel', dimensions: 'trf_type, trf_channel', defaultFilter: 'none' },
        { method: 'getPaidTrafficByTypeCampaign', dimensions: 'trf_type, utm_campaign', defaultFilter: 'none' },
        { method: 'getPaidTrafficByType', dimensions: 'trf_type', defaultFilter: 'none' },
        { method: 'getPaidTrafficByUrlPageTypePlatformCampaignDevice', dimensions: 'path, page_type, trf_platform, utm_campaign, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypePlatformCampaignDevice', dimensions: 'page_type, trf_platform, utm_campaign, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByUrlPageTypeCampaignDevice', dimensions: 'path, page_type, utm_campaign, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByUrlPageTypeDevice', dimensions: 'path, page_type, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByUrlPageTypeCampaign', dimensions: 'path, page_type, utm_campaign', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByUrlPageTypePlatform', dimensions: 'path, page_type, trf_platform', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByUrlPageTypeCampaignPlatform', dimensions: 'path, page_type, utm_campaign, trf_platform', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByUrlPageTypePlatformDevice', dimensions: 'path, page_type, trf_platform, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypeCampaignDevice', dimensions: 'page_type, utm_campaign, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypeDevice', dimensions: 'page_type, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypeCampaign', dimensions: 'page_type, utm_campaign', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypePlatform', dimensions: 'page_type, trf_platform', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypePlatformDevice', dimensions: 'page_type, trf_platform, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByPageTypePlatformCampaign', dimensions: 'page_type, trf_platform, utm_campaign', defaultFilter: 'paid' },
      ];

      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);

      for (const endpoint of endpointsWithDimensions) {
        mockAthenaQuery.resetHistory();

        // Test default behavior
        // eslint-disable-next-line no-await-in-loop
        const res = await controller[endpoint.method]();
        expect(res.status).to.equal(200, `${endpoint.method} should return 200`);

        const query = mockAthenaQuery.getCall(0).args[0];
        expect(query).to.include(endpoint.dimensions, `${endpoint.method} should include dimensions: ${endpoint.dimensions}`);

        // Check traffic type filtering
        if (endpoint.defaultFilter === 'paid') {
          expect(query).to.include('AND trf_type IN (\'paid\')', `${endpoint.method} should default to paid filter`);
        } else {
          expect(query).to.include('AND TRUE', `${endpoint.method} should not filter by traffic type by default`);
        }
      }
    });
    it('TrafficType parameter if passed is respected', async () => {
      const mockResponse = [{ utm_campaign: 'test', pageviews: 100 }];
      const controller = TrafficController(mockContext, mockLog, mockEnv);

      // Test valid traffic types
      const validTypes = [
        { value: 'owned', expectedFilter: 'AND trf_type IN (\'owned\')' },
        { value: 'earned', expectedFilter: 'AND trf_type IN (\'earned\')' },
        { value: 'paid', expectedFilter: 'AND trf_type IN (\'paid\')' },
        { value: 'all', expectedFilter: 'AND TRUE' },
      ];

      for (const test of validTypes) {
        mockAthenaQuery.resetHistory();
        mockAthenaQuery.resolves(mockResponse);
        mockContext.data.trafficType = test.value;

        // eslint-disable-next-line no-await-in-loop
        await controller.getPaidTrafficByCampaign();
        const query = mockAthenaQuery.getCall(0).args[0];
        expect(query).to.include(test.expectedFilter, `trafficType=${test.value} should apply correct filter`);
      }
    });

    it('returns 400 error for invalid week parameter', async () => {
      const contextWithInvalidWeek = {
        ...mockContext,
        data: {
          year: '2024',
          week: 'invalid-text', // This should cause parseInt to return NaN, triggering validation error
        },
      };

      const controller = TrafficController(contextWithInvalidWeek, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Week must be a valid number');
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('returns 400 error for invalid year parameter', async () => {
      const contextWithInvalidYear = {
        ...mockContext,
        data: {
          year: 'not-a-number', // This should cause parseInt to return NaN, triggering validation error
          week: '30',
        },
      };

      const controller = TrafficController(contextWithInvalidYear, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year must be a valid number');
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('returns 400 error for invalid month parameter', async () => {
      const contextWithInvalidMonth = {
        ...mockContext,
        data: {
          year: '2024',
          month: 'invalid-month-text', // This should cause parseInt to return NaN, triggering validation error
        },
      };

      const controller = TrafficController(contextWithInvalidMonth, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Month must be a valid number');
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('returns 400 error for multiple invalid parameters', async () => {
      const contextWithInvalidParams = {
        ...mockContext,
        data: {
          year: 'invalid-year-text',
          week: 'invalid-week-text',
        },
      };

      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(contextWithInvalidParams, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Year must be a valid number'); // Year validation comes first
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('accepts valid numeric strings for parameters', async () => {
      const contextWithValidStrings = {
        ...mockContext,
        data: {
          year: '2024', // Valid numeric string
          week: '30', // Valid numeric string
        },
      };

      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(contextWithValidStrings, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('accepts null or undefined for optional week/month parameters', async () => {
      const contextWithNullWeek = {
        ...mockContext,
        data: {
          year: '2024',
          week: null, // null should be allowed
          month: '12', // Valid month instead
        },
      };

      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(contextWithNullWeek, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });
  });
});
