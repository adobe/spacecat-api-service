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

    it('sets pageViewThreshold to 0 when noThreshold parameter is true', async () => {
      mockContext.data.noThreshold = true;
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, PAID_DATA_THRESHOLD: 5000 },
      );
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      const query = mockAthenaQuery.args[0][0];
      // Verify that the threshold is 0, not the env variable value
      expect(query).to.include('HAVING SUM(pageviews) >= 0');
      expect(query).not.to.include('5000');
    });

    it('getPaidTrafficTemporalSeries returns temporal series data with isWeekOverWeek flag', async () => {
      mockAthenaQuery.resolves([
        {
          trf_type: 'paid',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
      ]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeries();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
      // Verify it uses trf_type dimension and temporal series mode
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;
      const query = athenaCall.args[0];
      expect(query).to.be.a('string');
      expect(query).to.include('trf_type');
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
      // Empty results should not be cached
      expect(lastPutObject).to.not.exist;
      // Validate the compressed response body directly
      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());
      expect(body).to.deep.equal([]);
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
      expect(mockLog.debug).to.have.been.calledWithMatch('Successfully verified file existence');
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

        { method: 'getPaidTrafficByTypeDevice', dimensions: 'trf_type, device', defaultFilter: 'none' },
        { method: 'getPaidTrafficByTypeDeviceChannel', dimensions: 'trf_type, device, trf_channel', defaultFilter: 'none' },
        { method: 'getPaidTrafficByChannel', dimensions: 'trf_channel', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByChannelDevice', dimensions: 'trf_channel, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficBySocialPlatform', dimensions: 'trf_channel', defaultFilter: 'paid' },
        { method: 'getPaidTrafficBySocialPlatformDevice', dimensions: 'trf_channel, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficBySearchPlatform', dimensions: 'trf_channel', defaultFilter: 'paid' },
        { method: 'getPaidTrafficBySearchPlatformDevice', dimensions: 'trf_channel, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByDisplayPlatform', dimensions: 'trf_channel', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByDisplayPlatformDevice', dimensions: 'trf_channel, device', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByVideoPlatform', dimensions: 'trf_channel', defaultFilter: 'paid' },
        { method: 'getPaidTrafficByVideoPlatformDevice', dimensions: 'trf_channel, device', defaultFilter: 'paid' },
      ];

      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);

      for (const endpoint of endpointsWithDimensions) {
        mockAthenaQuery.resetHistory();

        switch (endpoint.method) {
          case 'getPaidTrafficBySocialPlatform':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'social' }]);
            break;
          case 'getPaidTrafficBySocialPlatformDevice':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'social', device: 'desktop' }]);
            break;
          case 'getPaidTrafficBySearchPlatform':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'search' }]);
            break;
          case 'getPaidTrafficBySearchPlatformDevice':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'search', device: 'desktop' }]);
            break;
          case 'getPaidTrafficByDisplayPlatform':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'display' }]);
            break;
          case 'getPaidTrafficByDisplayPlatformDevice':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'display', device: 'desktop' }]);
            break;
          case 'getPaidTrafficByVideoPlatform':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'video' }]);
            break;
          case 'getPaidTrafficByVideoPlatformDevice':
            mockAthenaQuery.resolves([{ ...mockResponse[0], trf_channel: 'video', device: 'desktop' }]);
            break;
          default:
            mockAthenaQuery.resolves(mockResponse);
        }

        // Test default behavior
        // eslint-disable-next-line no-await-in-loop
        const res = await controller[endpoint.method]();
        expect(res.status).to.equal(200, `${endpoint.method} should return 200`);
      }
    });

    // Additional endpoint tests for complete coverage
    it('getPaidTrafficByUrl endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrl();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByUrlChannel endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', trf_channel: 'search', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrlChannel();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByUrlChannelDevice endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', trf_channel: 'search', device: 'mobile', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrlChannelDevice();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByUrlChannelPlatformDevice endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', trf_channel: 'search', trf_platform: 'google', device: 'mobile', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrlChannelPlatformDevice();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByCampaignChannelDevice endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test', trf_channel: 'search', device: 'mobile', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByCampaignChannelDevice();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByCampaignChannelPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test', trf_channel: 'search', trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByCampaignChannelPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByCampaignChannelPlatformDevice endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test', trf_channel: 'search', trf_platform: 'google', device: 'mobile', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByCampaignChannelPlatformDevice();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByChannel endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        trf_channel: 'search', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByChannel();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByCampaignChannel endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test', trf_channel: 'search', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByCampaignChannel();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByCampaignPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test', trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByCampaignPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByCampaignChannelPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        utm_campaign: 'test', trf_channel: 'search', trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByCampaignChannelPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByChannelPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        trf_channel: 'search', trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByChannelPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByUrl endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByUrl();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByUrlChannel endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', trf_channel: 'search', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByUrlChannel();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByUrlPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByUrlPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficTemporalSeriesByUrlChannelPlatform endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', trf_channel: 'search', trf_platform: 'google', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficTemporalSeriesByUrlChannelPlatform();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByChannelPlatformDevice endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        trf_channel: 'search', trf_platform: 'google', device: 'mobile', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByChannelPlatformDevice();
      expect(res.status).to.equal(200);
    });

    it('getPaidTrafficByUrlPageType endpoint works correctly', async () => {
      mockAthenaQuery.resolves([{
        path: '/test', page_type: 'homepage', pageviews: 100, pct_pageviews: 0.5, click_rate: 0.1, engagement_rate: 0.2, bounce_rate: 0.3, p70_lcp: 2.5, p70_cls: 0.1, p70_inp: 200,
      }]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByUrlPageType();
      expect(res.status).to.equal(200);
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

  describe('fetchTop3PagesTrafficData (Impact endpoints)', () => {
    let mockS3GetObject;

    beforeEach(() => {
      // Set temporalCondition for these tests
      mockContext.data.temporalCondition = encodeURIComponent('(year = 2024 AND week = 23) OR (year = 2024 AND week = 22) OR (year = 2024 AND week = 21) OR (year = 2024 AND week = 20)');

      // Mock S3 GetObject for Ahrefs CPC data (needed for bounce gap endpoints)
      mockS3GetObject = sandbox.stub();
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'GetObjectCommand') {
          return mockS3GetObject(cmd);
        }
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

      // Default: Ahrefs data not available (will use default CPC)
      mockS3GetObject.rejects(new Error('Not found'));
    });

    it('getImpactByPage returns expected data with limit of 3', async () => {
      const mockResponse = [
        {
          path: '/home',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
        {
          path: '/about',
          pageviews: 800,
          pct_pageviews: 0.3,
          click_rate: 0.15,
          engagement_rate: 0.25,
          bounce_rate: 0.2,
          p70_lcp: 2.0,
          p70_cls: 0.08,
          p70_inp: 150,
        },
        {
          path: '/contact',
          pageviews: 500,
          pct_pageviews: 0.2,
          click_rate: 0.12,
          engagement_rate: 0.18,
          bounce_rate: 0.25,
          p70_lcp: 3.0,
          p70_cls: 0.15,
          p70_inp: 250,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
      const query = mockAthenaQuery.getCall(0).args[0];
      expect(query).to.include('path');
    });

    it('getImpactByPageDevice returns expected data', async () => {
      const mockResponse = [
        {
          path: '/home',
          device: 'mobile',
          pageviews: 600,
          pct_pageviews: 0.3,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
        {
          path: '/home',
          device: 'desktop',
          pageviews: 400,
          pct_pageviews: 0.2,
          click_rate: 0.15,
          engagement_rate: 0.25,
          bounce_rate: 0.2,
          p70_lcp: 2.0,
          p70_cls: 0.08,
          p70_inp: 150,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPageDevice();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
      const query = mockAthenaQuery.getCall(0).args[0];
      expect(query).to.include('path');
      expect(query).to.include('device');
    });

    it('getImpactByPageTrafficTypeDevice returns expected data', async () => {
      const mockResponse = [
        {
          path: '/home',
          trf_type: 'paid',
          device: 'mobile',
          pageviews: 600,
          pct_pageviews: 0.3,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
        {
          path: '/about',
          trf_type: 'earned',
          device: 'desktop',
          pageviews: 400,
          pct_pageviews: 0.2,
          click_rate: 0.15,
          engagement_rate: 0.25,
          bounce_rate: 0.2,
          p70_lcp: 2.0,
          p70_cls: 0.08,
          p70_inp: 150,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPageTrafficTypeDevice();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
      const query = mockAthenaQuery.getCall(0).args[0];
      expect(query).to.include('path');
      expect(query).to.include('device');
    });

    it('returns 404 if site not found for impact endpoints', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(404);
    });

    it('returns 403 if access denied for impact endpoints', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(403);
    });

    it('accepts temporalCondition with single temporal period', async () => {
      mockContext.data.temporalCondition = encodeURIComponent('(year = 2024 AND week = 23)');
      const mockResponse = [
        {
          path: '/home',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('returns 400 if temporalCondition does not contain "week"', async () => {
      mockContext.data.temporalCondition = encodeURIComponent('(year = 2024) OR (year = 2024) OR (year = 2024) OR (year = 2024)');
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Invalid temporal condition');
    });

    it('returns 400 if temporalCondition does not contain "year"', async () => {
      mockContext.data.temporalCondition = encodeURIComponent('(week = 23) OR (week = 22) OR (week = 21) OR (week = 20)');
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Invalid temporal condition');
    });

    it('returns cached result if available for impact endpoints', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('respects noCache flag for impact endpoints', async () => {
      mockContext.data.noCache = true;
      const mockResponse = [
        {
          path: '/home',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(200);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('returns empty array if Athena returns empty for impact endpoints', async () => {
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(200);
      expect(lastPutObject).to.not.exist;
      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());
      expect(body).to.deep.equal([]);
    });

    it('uses custom CWV thresholds for impact endpoints', async () => {
      const customThresholds = {
        LCP_GOOD: 10,
        LCP_NEEDS_IMPROVEMENT: 20,
        INP_GOOD: 10,
        INP_NEEDS_IMPROVEMENT: 20,
        CLS_GOOD: 10,
        CLS_NEEDS_IMPROVEMENT: 20,
      };
      const mockResponse = [
        {
          path: '/home',
          consent: 'show',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 5,
          p70_cls: 5,
          p70_inp: 5,
        },
        {
          path: '/home',
          consent: 'hidden',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.15,
          engagement_rate: 0.25,
          bounce_rate: 0.2,
          p70_lcp: 4,
          p70_cls: 4,
          p70_inp: 4,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, CWV_THRESHOLDS: customThresholds },
      );
      await controller.getImpactByPage();
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString())[0];
      expect(putBody.lcp_score).to.equal('good');
      expect(putBody.inp_score).to.equal('good');
      expect(putBody.cls_score).to.equal('good');
    });

    it('uses custom CWV thresholds from JSON string for impact endpoints', async () => {
      const jsonThresholds = JSON.stringify({
        LCP_GOOD: 10,
        LCP_NEEDS_IMPROVEMENT: 20,
        INP_GOOD: 10,
        INP_NEEDS_IMPROVEMENT: 20,
        CLS_GOOD: 10,
        CLS_NEEDS_IMPROVEMENT: 20,
      });
      const mockResponse = [
        {
          path: '/home',
          consent: 'show',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 5,
          p70_cls: 5,
          p70_inp: 5,
        },
        {
          path: '/home',
          consent: 'hidden',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.15,
          engagement_rate: 0.25,
          bounce_rate: 0.2,
          p70_lcp: 4,
          p70_cls: 4,
          p70_inp: 4,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, CWV_THRESHOLDS: jsonThresholds },
      );
      await controller.getImpactByPage();
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const putBody = JSON.parse(decompressed.toString())[0];
      expect(putBody.lcp_score).to.equal('good');
      expect(putBody.inp_score).to.equal('good');
      expect(putBody.cls_score).to.equal('good');
    });

    it('falls back to default thresholds when CWV_THRESHOLDS is invalid JSON for impact endpoints', async () => {
      const mockResponse = [
        {
          path: '/home',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 5000,
          p70_cls: 0.4,
          p70_inp: 300,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(
        mockContext,
        mockLog,
        { ...mockEnv, CWV_THRESHOLDS: '{not-json}' },
      );
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWith('Invalid CWV_THRESHOLDS JSON. Falling back to defaults.');
    });

    it('returns response directly if caching fails for impact endpoints', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'GetObjectCommand') {
          // Ahrefs data not available
          return mockS3GetObject(cmd);
        }
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
      const mockResponse = [
        {
          path: '/home',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(200);
      const contentEncoding = res.headers.get('content-encoding');
      expect(contentEncoding).to.equal('gzip');
    });

    it('returns signed URL when cache is successfully verified after being created for impact endpoints', async () => {
      let cacheExists = false;
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'GetObjectCommand') {
          // Ahrefs data not available
          return mockS3GetObject(cmd);
        }
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
          if (cacheExists) {
            return Promise.resolve({});
          } else {
            const err = new Error('not found');
            err.name = 'NotFound';
            return Promise.reject(err);
          }
        }
        if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
          lastPutObject = cmd;
          cacheExists = true;
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      const mockResponse = [
        {
          path: '/home',
          consent: 'show',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
        {
          path: '/home',
          consent: 'hidden',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.15,
          engagement_rate: 0.25,
          bounce_rate: 0.2,
          p70_lcp: 2.0,
          p70_cls: 0.08,
          p70_inp: 150,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getImpactByPage();
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      expect(mockLog.debug).to.have.been.calledWithMatch('Successfully verified file existence');
    });

    it('respects trafficType parameter for impact endpoints', async () => {
      mockContext.data.trafficType = 'earned';
      const mockResponse = [
        {
          path: '/home',
          pageviews: 1000,
          pct_pageviews: 0.5,
          click_rate: 0.1,
          engagement_rate: 0.2,
          bounce_rate: 0.3,
          p70_lcp: 2.5,
          p70_cls: 0.1,
          p70_inp: 200,
        },
      ];
      mockAthenaQuery.resolves(mockResponse);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      await controller.getImpactByPage();
      expect(mockAthenaQuery).to.have.been.calledOnce;
      // The query should filter by traffic type
      const query = mockAthenaQuery.getCall(0).args[0];
      expect(query).to.be.a('string');
    });
  });

  describe('Bounce Gap Analysis Endpoints', () => {
    let bounceGapMock;
    let bounceGapWithTrafficTypeMock;
    let mockS3GetObject;

    beforeEach(async () => {
      const bounceGapRaw = await fs.readFile(path.join(FIXTURES_DIR, 'sample-bounce-gap-athena-response.json'), 'utf-8');
      const bounceGapTrafficRaw = await fs.readFile(path.join(FIXTURES_DIR, 'sample-bounce-gap-with-traffic-type.json'), 'utf-8');
      bounceGapMock = JSON.parse(bounceGapRaw);
      bounceGapWithTrafficTypeMock = JSON.parse(bounceGapTrafficRaw);

      // Set temporalCondition for bounce gap tests
      mockContext.data.temporalCondition = encodeURIComponent('(year = 2024 AND week = 23) OR (year = 2024 AND week = 22) OR (year = 2024 AND week = 21) OR (year = 2024 AND week = 20)');
      // Set noCache to get JSON responses instead of gzipped cached responses
      mockContext.data.noCache = true;

      // Mock S3 GetObject for Ahrefs CPC data
      mockS3GetObject = sandbox.stub();
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor && cmd.constructor.name === 'GetObjectCommand') {
          return mockS3GetObject(cmd);
        }
        if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key.includes(`${SITE_ID}/`)) {
          // Simulate cache miss
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

    describe('getTrafficLossByDevices', () => {
      it('returns bounce gap data grouped by device without cost fields', async () => {
        mockAthenaQuery.resolves(bounceGapMock);
        mockS3GetObject.rejects(new Error('Not found')); // Ahrefs data not available

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getTrafficLossByDevices();

        expect(res.status).to.equal(200);

        // Validate the cached data from PutObjectCommand
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        // Should have 3 devices: desktop, mobile, tablet
        expect(body).to.be.an('array');
        expect(body.length).to.equal(3);

        // Check desktop entry
        const desktop = body.find((item) => item.device === 'desktop');
        expect(desktop).to.exist;
        expect(desktop.pageviews).to.equal('50000');
        expect(desktop.bounce_rate).to.equal('0.35');
        expect(desktop.bounceGapLoss).to.be.a('number');
        expect(desktop.bounceGapDelta).to.be.a('number');
        expect(desktop.bounceGapDelta).to.be.closeTo(0.10, 0.001); // 0.35 - 0.25 = 0.10

        // Should NOT have cost fields (no trf_type in data)
        expect(desktop.estimatedCost).to.be.undefined;
        expect(desktop.appliedCPC).to.be.undefined;
        expect(desktop.cpcSource).to.be.undefined;
      });

      it('calculates bounce gap loss correctly', async () => {
        mockAthenaQuery.resolves(bounceGapMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getTrafficLossByDevices();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        const desktop = body.find((item) => item.device === 'desktop');
        // Desktop: 50000 pageviews * 0.10 bounce gap = 5000 lost users
        expect(desktop.bounceGapLoss).to.be.closeTo(5000, 1);

        const mobile = body.find((item) => item.device === 'mobile');
        // Mobile: 30000 pageviews * 0.10 bounce gap = 3000 lost users
        expect(mobile.bounceGapLoss).to.be.closeTo(3000, 1);

        const tablet = body.find((item) => item.device === 'tablet');
        // Tablet: 10000 pageviews * 0.00 bounce gap = 0 lost users (same bounce rate)
        expect(tablet.bounceGapLoss).to.equal(0);
      });
    });

    describe('getImpactByPage', () => {
      it('returns top 3 pages with bounce gap data', async () => {
        mockAthenaQuery.resolves(bounceGapMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPage();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        // Should have 3 pages (limited by top 3)
        expect(body).to.be.an('array');
        expect(body.length).to.be.at.most(3);

        // Check that each page has bounce gap data
        body.forEach((page) => {
          expect(page.path).to.be.a('string');
          expect(page.bounceGapLoss).to.be.a('number');
          expect(page.bounceGapDelta).to.be.a('number');
        });
      });
    });

    describe('getImpactByPageTrafficType', () => {
      it('returns bounce gap data with CPC cost estimates when Ahrefs data available', async () => {
        mockAthenaQuery.resolves(bounceGapWithTrafficTypeMock);

        // Mock successful Ahrefs data fetch
        // Both cost and traffic are already fully converted during import
        // CPC = cost / traffic
        mockS3GetObject.resolves({
          Body: {
            transformToString: async () => JSON.stringify({
              organicTraffic: 100000, // 100,000 actual visitors
              organicCost: 19100, // $19,100
              paidTraffic: 50000, // 50,000 actual visitors
              paidCost: 15615, // $15,615
            }),
          },
        });

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageTrafficType();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        expect(body).to.be.an('array');
        expect(body.length).to.be.greaterThan(0);

        // Find paid traffic entry (DTO transforms trf_type to type)
        const paidEntry = body.find((item) => item.type === 'paid');
        expect(paidEntry).to.exist;

        // Should have cost fields
        expect(paidEntry.estimatedCost).to.be.a('number');
        expect(paidEntry.appliedCPC).to.be.a('number');
        expect(paidEntry.cpcSource).to.equal('ahrefs');

        // Verify CPC calculation: paidCPC = 15615 / 50000 = 0.3123
        expect(paidEntry.appliedCPC).to.be.closeTo(0.3123, 0.0001);

        // Verify cost calculation: bounceGapLoss * CPC
        const expectedCost = paidEntry.bounceGapLoss * paidEntry.appliedCPC;
        expect(paidEntry.estimatedCost).to.be.closeTo(expectedCost, 0.01);
      });

      it('uses default CPC when Ahrefs data unavailable', async () => {
        mockAthenaQuery.resolves(bounceGapWithTrafficTypeMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageTrafficType();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        const paidEntry = body.find((item) => item.type === 'paid');
        expect(paidEntry).to.exist;

        // Should use default CPC
        expect(paidEntry.appliedCPC).to.equal(0.80);
        expect(paidEntry.cpcSource).to.equal('default');
      });

      it('applies correct CPC for different traffic types', async () => {
        mockAthenaQuery.resolves(bounceGapWithTrafficTypeMock);

        // Mock Ahrefs data with different organic and paid CPC
        // Both cost and traffic are already fully converted
        mockS3GetObject.resolves({
          Body: {
            transformToString: async () => JSON.stringify({
              organicTraffic: 100000, // 100,000 actual visitors
              organicCost: 19100, // $19,100 -> organicCPC = 0.191
              paidTraffic: 50000, // 50,000 actual visitors
              paidCost: 15615, // $15,615 -> paidCPC = 0.3123
            }),
          },
        });

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageTrafficType();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        // Paid traffic should use paidCPC
        const paidEntry = body.find((item) => item.type === 'paid');
        expect(paidEntry.appliedCPC).to.be.closeTo(0.3123, 0.0001);

        // Organic traffic should use organicCPC
        const organicEntry = body.find((item) => item.type === 'organic');
        expect(organicEntry.appliedCPC).to.be.closeTo(0.191, 0.001);

        // Earned traffic should also use organicCPC
        const earnedEntry = body.find((item) => item.type === 'earned');
        expect(earnedEntry.appliedCPC).to.be.closeTo(0.191, 0.001);
      });
    });

    describe('getImpactByPageDevice', () => {
      it('returns bounce gap data grouped by page and device', async () => {
        mockAthenaQuery.resolves(bounceGapMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageDevice();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        expect(body).to.be.an('array');

        // Should have entries with both path and device
        body.forEach((entry) => {
          expect(entry.path).to.be.a('string');
          expect(entry.device).to.be.a('string');
          expect(entry.bounceGapLoss).to.be.a('number');
          expect(entry.bounceGapDelta).to.be.a('number');
        });

        // Should NOT have cost fields (no trf_type)
        body.forEach((entry) => {
          expect(entry.estimatedCost).to.be.undefined;
          expect(entry.appliedCPC).to.be.undefined;
          expect(entry.cpcSource).to.be.undefined;
        });
      });
    });

    describe('getImpactByPageTrafficTypeDevice', () => {
      it('returns complete bounce gap data with all dimensions', async () => {
        // Create mock data with path, trf_type, and device
        const multiDimensionMock = [
          {
            path: '/homepage',
            trf_type: 'paid',
            device: 'desktop',
            consent: 'show',
            pageviews: '25000',
            bounce_rate: '0.35',
            pct_pageviews: '0.20',
            click_rate: '0.45',
            engagement_rate: '0.65',
            p70_lcp: '2500',
            p70_cls: '0.05',
            p70_inp: '150',
          },
          {
            path: '/homepage',
            trf_type: 'paid',
            device: 'desktop',
            consent: 'hidden',
            pageviews: '25000',
            bounce_rate: '0.25',
            pct_pageviews: '0.20',
            click_rate: '0.55',
            engagement_rate: '0.75',
            p70_lcp: '2400',
            p70_cls: '0.04',
            p70_inp: '140',
          },
        ];

        mockAthenaQuery.resolves(multiDimensionMock);
        mockS3GetObject.resolves({
          Body: {
            transformToString: async () => JSON.stringify({
              organicTraffic: 100000, // 100,000 actual visitors
              organicCost: 19100, // $19,100
              paidTraffic: 50000, // 50,000 actual visitors
              paidCost: 15615, // $15,615
            }),
          },
        });

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageTrafficTypeDevice();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        expect(body).to.be.an('array');
        expect(body.length).to.be.greaterThan(0);

        const entry = body[0];
        expect(entry.path).to.equal('/homepage');
        expect(entry.type).to.equal('paid'); // DTO transforms trf_type to type
        expect(entry.device).to.equal('desktop');
        expect(entry.bounceGapLoss).to.be.closeTo(2500, 1); // 25000 * 0.10
        expect(entry.bounceGapDelta).to.be.closeTo(0.10, 0.001);

        // Should have cost fields
        expect(entry.estimatedCost).to.be.a('number');
        expect(entry.appliedCPC).to.be.closeTo(0.3123, 0.0001);
        expect(entry.cpcSource).to.equal('ahrefs');
      });
    });

    describe('Bounce Gap Edge Cases', () => {
      it('handles missing hidden consent data gracefully', async () => {
        const missingHiddenMock = [
          {
            path: '/homepage',
            device: 'desktop',
            consent: 'show',
            pageviews: '50000',
            bounce_rate: '0.35',
            pct_pageviews: '0.25',
            click_rate: '0.45',
            engagement_rate: '0.65',
            p70_lcp: '2500',
            p70_cls: '0.05',
            p70_inp: '150',
          },
        ];

        mockAthenaQuery.resolves(missingHiddenMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getTrafficLossByDevices();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        // Should still return data but with 0 bounce gap
        expect(body).to.be.an('array');
        expect(body.length).to.equal(1);
        expect(body[0].bounceGapLoss).to.equal(0);
      });

      it('handles zero pageviews correctly', async () => {
        const zeroPageviewsMock = [
          {
            path: '/homepage',
            device: 'desktop',
            consent: 'show',
            pageviews: '0',
            bounce_rate: '0.35',
            pct_pageviews: '0.00',
            click_rate: '0.45',
            engagement_rate: '0.65',
            p70_lcp: '2500',
            p70_cls: '0.05',
            p70_inp: '150',
          },
          {
            path: '/homepage',
            device: 'desktop',
            consent: 'hidden',
            pageviews: '0',
            bounce_rate: '0.25',
            pct_pageviews: '0.00',
            click_rate: '0.55',
            engagement_rate: '0.75',
            p70_lcp: '2400',
            p70_cls: '0.04',
            p70_inp: '140',
          },
        ];

        mockAthenaQuery.resolves(zeroPageviewsMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getTrafficLossByDevices();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        expect(body[0].bounceGapLoss).to.equal(0);
      });

      it('handles missing treatment data (only control)', async () => {
        const missingTreatmentMock = [
          {
            path: '/test',
            device: 'desktop',
            consent: 'show', // Treatment with data
            pageviews: '10000',
            bounce_rate: '0.30',
            pct_pageviews: '0.10',
            click_rate: '0.50',
            engagement_rate: '0.70',
            p70_lcp: '2400',
            p70_cls: '0.04',
            p70_inp: '140',
          },
          // Missing 'hidden' (control) data - this triggers the missing data path
        ];

        mockAthenaQuery.resolves(missingTreatmentMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getTrafficLossByDevices();

        expect(res.status).to.equal(200);

        // Validate cached data - should have data but with zero bounce gap
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        expect(body).to.be.an('array');
        expect(body.length).to.equal(1);
        // When control is missing, bounce gap should be 0
        expect(body[0].bounceGapLoss).to.equal(0);
        expect(body[0].bounceGapDelta).to.equal(0);
      });

      it('uses default CPC when Ahrefs has zero traffic', async () => {
        mockAthenaQuery.resolves(bounceGapWithTrafficTypeMock);

        // Mock Ahrefs data with zero traffic values
        mockS3GetObject.resolves({
          Body: {
            transformToString: async () => JSON.stringify({
              organicTraffic: 0, // Zero traffic
              organicCost: 19100,
              paidTraffic: 0, // Zero traffic
              paidCost: 15615,
            }),
          },
        });

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageTrafficType();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        // All entries should use default CPC (0.80)
        const paidEntry = body.find((item) => item.type === 'paid');
        expect(paidEntry.appliedCPC).to.equal(0.80);
        expect(paidEntry.cpcSource).to.equal('ahrefs'); // Source is still ahrefs, just using default

        const organicEntry = body.find((item) => item.type === 'organic');
        expect(organicEntry.appliedCPC).to.equal(0.80);
      });

      it('handles missing dimension values with "unknown" fallback', async () => {
        const missingDimensionMock = [
          {
            path: '/page1',
            device: null, // Missing device dimension
            consent: 'show',
            pageviews: '5000',
            bounce_rate: '0.50',
            pct_pageviews: '0.05',
            click_rate: '0.45',
            engagement_rate: '0.65',
            p70_lcp: '2500',
            p70_cls: '0.05',
            p70_inp: '150',
          },
          {
            path: '/page1',
            device: null, // Missing device dimension
            consent: 'hidden',
            pageviews: '5000',
            bounce_rate: '0.40',
            pct_pageviews: '0.05',
            click_rate: '0.55',
            engagement_rate: '0.75',
            p70_lcp: '2400',
            p70_cls: '0.04',
            p70_inp: '140',
          },
        ];

        mockAthenaQuery.resolves(missingDimensionMock);
        mockS3GetObject.rejects(new Error('Not found'));

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getImpactByPageDevice();

        expect(res.status).to.equal(200);

        // Validate cached data
        expect(lastPutObject).to.exist;
        const decompressed = await gunzipAsync(lastPutObject.input.Body);
        const body = JSON.parse(decompressed.toString());

        // Should have data - device will be null but dimension key uses 'unknown'
        expect(body).to.be.an('array');
        expect(body.length).to.equal(1);
        expect(body[0].device).to.be.null; // DTO preserves null value
        expect(body[0].path).to.equal('/page1');
        // Bounce gap calculation still works via 'unknown' key
        expect(body[0].bounceGapLoss).to.be.closeTo(500, 1);
      });

      it('returns signed URL (302) when cache verification succeeds', async () => {
        mockAthenaQuery.resolves(bounceGapMock);
        mockS3GetObject.rejects(new Error('Not found'));

        // Mock successful cache write and verification
        let putKey = null;
        mockS3.send.callsFake((cmd) => {
          if (cmd.constructor && cmd.constructor.name === 'GetObjectCommand') {
            // For Ahrefs CPC data
            if (cmd.input.Key && cmd.input.Key.includes('ahrefs')) {
              return mockS3GetObject(cmd);
            }
            // For signed URL verification - return success
            return Promise.resolve({});
          }
          if (cmd.constructor && cmd.constructor.name === 'HeadObjectCommand') {
            // Simulate successful verification after PUT
            if (putKey && cmd.input.Key === putKey) {
              return Promise.resolve({}); // File exists
            }
            // Initial cache check - miss
            const err = new Error('not found');
            err.name = 'NotFound';
            return Promise.reject(err);
          }
          if (cmd.constructor && cmd.constructor.name === 'PutObjectCommand') {
            putKey = cmd.input.Key;
            lastPutObject = cmd;
            return Promise.resolve({});
          }
          return Promise.resolve({});
        });

        const controller = TrafficController(mockContext, mockLog, mockEnv);
        const res = await controller.getTrafficLossByDevices();

        // Should return 302 redirect to signed URL
        expect(res.status).to.equal(302);
        expect(res.headers.get('location')).to.equal(TEST_PRESIGNED_URL);
      });
    });
  });
});
