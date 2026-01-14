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
import TrafficToolsController from '../../../src/controllers/paid/traffic-tools.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);
const gunzipAsync = promisify(gunzip);

const SITE_ID = 'test-site-id';

describe('TrafficToolsController', () => {
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
        urls: ['https://example.com/page1', 'https://example.com/page2'],
      },
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(mockSite) },
      },
      s3: mockS3,
      athenaClient: mockAthena,
    };
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getPredominantTraffic', () => {
    it('returns 400 if request body is missing', async () => {
      mockContext.data = undefined;
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Request body is required');
    });

    it('returns 400 if urls is not an array', async () => {
      mockContext.data.urls = 'not-an-array';
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('urls must be an array');
    });

    it('returns 400 if urls array is empty', async () => {
      mockContext.data.urls = [];
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('urls array cannot be empty');
    });

    it('returns 400 if URL is not a string', async () => {
      mockContext.data.urls = [123, 'https://example.com'];
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Invalid URL at index 0');
    });

    it('returns 400 if URL is empty string', async () => {
      mockContext.data.urls = ['', 'https://example.com'];
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('Invalid URL at index 0');
    });

    it('returns 400 if predominantTrafficPct is negative', async () => {
      mockContext.data.predominantTrafficPct = -10;
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('predominantTrafficPct must be a number between 0 and 100');
    });

    it('returns 400 if predominantTrafficPct is greater than 100', async () => {
      mockContext.data.predominantTrafficPct = 150;
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('predominantTrafficPct must be a number between 0 and 100');
    });

    it('returns 400 if predominantTrafficPct is not a number', async () => {
      mockContext.data.predominantTrafficPct = 'invalid';
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.equal('predominantTrafficPct must be a number between 0 and 100');
    });

    it('returns 404 if site not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(404);
      const body = await res.json();
      expect(body.message).to.equal('Site not found');
    });

    it('returns 403 if access denied', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(403);
      const body = await res.json();
      expect(body.message).to.equal('Only users belonging to the organization can view paid traffic metrics');
    });

    it('returns 200 with predominant traffic data when paid >= 80%', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '850' },
        { path: '/page1', trf_type: 'earned', pageviews: '100' },
        { path: '/page1', trf_type: 'owned', pageviews: '50' },
        { path: '/page2', trf_type: 'paid', pageviews: '400' },
        { path: '/page2', trf_type: 'earned', pageviews: '400' },
        { path: '/page2', trf_type: 'owned', pageviews: '200' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body).to.be.an('array').with.lengthOf(2);
      expect(body[0].url).to.equal('https://example.com/page1');
      expect(body[0].predominantTraffic).to.equal('paid');
      expect(body[0].details.paid).to.equal(85);
      expect(body[0].details.earned).to.equal(10);
      expect(body[0].details.owned).to.equal(5);

      expect(body[1].url).to.equal('https://example.com/page2');
      expect(body[1].predominantTraffic).to.equal('mixed');
      expect(body[1].details.paid).to.equal(40);
      expect(body[1].details.earned).to.equal(40);
      expect(body[1].details.owned).to.equal(20);
    });

    it('returns "mixed" when no traffic type >= threshold', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '400' },
        { path: '/page1', trf_type: 'earned', pageviews: '350' },
        { path: '/page1', trf_type: 'owned', pageviews: '250' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[0].predominantTraffic).to.equal('mixed');
    });

    it('returns "earned" when earned >= threshold', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '100' },
        { path: '/page1', trf_type: 'earned', pageviews: '850' },
        { path: '/page1', trf_type: 'owned', pageviews: '50' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[0].predominantTraffic).to.equal('earned');
    });

    it('returns "owned" when owned >= threshold', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '50' },
        { path: '/page1', trf_type: 'earned', pageviews: '100' },
        { path: '/page1', trf_type: 'owned', pageviews: '850' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[0].predominantTraffic).to.equal('owned');
    });

    it('returns "no traffic" for URLs with no data', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '850' },
        { path: '/page1', trf_type: 'earned', pageviews: '100' },
        { path: '/page1', trf_type: 'owned', pageviews: '50' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[1].url).to.equal('https://example.com/page2');
      expect(body[1].predominantTraffic).to.equal('no traffic');
      expect(body[1].details.paid).to.equal(0);
      expect(body[1].details.earned).to.equal(0);
      expect(body[1].details.owned).to.equal(0);
    });

    it('handles custom predominantTrafficPct threshold', async () => {
      mockContext.data.predominantTrafficPct = 50;
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '600' },
        { path: '/page1', trf_type: 'earned', pageviews: '300' },
        { path: '/page1', trf_type: 'owned', pageviews: '100' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[0].predominantTraffic).to.equal('paid');
      expect(body[0].details.paid).to.equal(60);
    });

    it('handles malformed URLs as paths', async () => {
      mockContext.data.urls = ['/just-a-path', 'not-a-url'];
      const mockAthenaResults = [
        { path: '/just-a-path', trf_type: 'paid', pageviews: '850' },
        { path: '/just-a-path', trf_type: 'earned', pageviews: '100' },
        { path: '/just-a-path', trf_type: 'owned', pageviews: '50' },
        { path: '/not-a-url', trf_type: 'paid', pageviews: '900' },
        { path: '/not-a-url', trf_type: 'earned', pageviews: '50' },
        { path: '/not-a-url', trf_type: 'owned', pageviews: '50' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body).to.be.an('array').with.lengthOf(2);
      expect(body[0].url).to.equal('/just-a-path');
      expect(body[0].predominantTraffic).to.equal('paid');
    });

    it('uses correct database and table names from env', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '850' },
        { path: '/page1', trf_type: 'earned', pageviews: '100' },
        { path: '/page1', trf_type: 'owned', pageviews: '50' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      await controller.getPredominantTraffic();

      const query = mockAthenaQuery.args[0][0];
      expect(query).to.include('test-db.test-table');

      const database = mockAthenaQuery.args[0][1];
      expect(database).to.equal('test-db');

      const description = mockAthenaQuery.args[0][2];
      expect(description).to.include('predominant traffic');
      expect(description).to.include(SITE_ID);
    });

    it('generates temporal condition for last 4 weeks', async () => {
      const mockAthenaResults = [];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      await controller.getPredominantTraffic();

      const query = mockAthenaQuery.args[0][0];
      // The query should contain week and year conditions
      expect(query).to.match(/week=\d+/);
      expect(query).to.match(/year=\d{4}/);
      // Should have 4 weeks, each with week= and year= conditions (8 total)
      expect((query.match(/week=/g) || []).length).to.be.at.least(4);
      expect((query.match(/year=/g) || []).length).to.be.at.least(4);
    });

    it('logs appropriate messages', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '850' },
        { path: '/page1', trf_type: 'earned', pageviews: '100' },
        { path: '/page1', trf_type: 'owned', pageviews: '50' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      await controller.getPredominantTraffic();

      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Determining predominant traffic for 2 URLs/));
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Athena query returned/));
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Predominant traffic analysis complete/));
    });

    it('handles Athena errors gracefully', async () => {
      mockAthenaQuery.rejects(new Error('Athena query failed'));

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);

      await expect(controller.getPredominantTraffic()).to.be.rejectedWith('Athena query failed');
      expect(mockLog.error).to.have.been.calledWith(sinon.match(/Error processing predominant traffic request/));
    });

    it('handles Athena rows with missing pageviews field', async () => {
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '800' },
        { path: '/page1', trf_type: 'earned' }, // Missing pageviews
        { path: '/page1', trf_type: 'owned', pageviews: '200' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      // Should still calculate correctly, treating missing pageviews as 0
      expect(body[0].predominantTraffic).to.equal('paid');
      expect(body[0].details.paid).to.equal(80); // 800 / 1000
      expect(body[0].details.earned).to.equal(0); // 0 / 1000
      expect(body[0].details.owned).to.equal(20); // 200 / 1000
    });

    it('accepts predominantTrafficPct as 0', async () => {
      mockContext.data.predominantTrafficPct = 0;
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '1' },
        { path: '/page1', trf_type: 'earned', pageviews: '0' },
        { path: '/page1', trf_type: 'owned', pageviews: '0' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[0].predominantTraffic).to.equal('paid');
    });

    it('accepts predominantTrafficPct as 100', async () => {
      mockContext.data.predominantTrafficPct = 100;
      const mockAthenaResults = [
        { path: '/page1', trf_type: 'paid', pageviews: '1000' },
        { path: '/page1', trf_type: 'earned', pageviews: '0' },
        { path: '/page1', trf_type: 'owned', pageviews: '0' },
      ];
      mockAthenaQuery.resolves(mockAthenaResults);

      const controller = TrafficToolsController(mockContext, mockLog, mockEnv);
      const res = await controller.getPredominantTraffic();
      expect(res.status).to.equal(200);

      const gzippedBuffer = Buffer.from(await res.arrayBuffer());
      const decompressed = await gunzipAsync(gzippedBuffer);
      const body = JSON.parse(decompressed.toString());

      expect(body[0].predominantTraffic).to.equal('paid');
      expect(body[0].details.paid).to.equal(100);
    });
  });
});
