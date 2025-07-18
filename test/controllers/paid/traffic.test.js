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

/* eslint-disable camelcase */
/* eslint-env mocha */
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  describe, it, beforeEach, afterEach,
} from 'mocha';
import { gunzip, gzip } from 'zlib';
import { promisify } from 'util';
import { Readable } from 'stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import TrafficController from '../../../src/controllers/paid/traffic.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../controllers/fixtures',
);
const SITE_ID = 'site-id';
let lastPutObject;

describe('Paid TrafficController (updated for streaming cache)', () => {
  let sandbox;
  let mockS3;
  let mockAthenaQuery;
  let mockLog;
  let mockEnv;
  let mockContext;
  let mockSite;
  let mockAccessControlUtil;
  let trafficTypeMock;
  let trafficTypeExpected;
  let gzippedFixture;

  beforeEach(async () => {
    // Load sample Athena response fixture
    const raw = await fs.readFile(
      path.join(FIXTURES_DIR, 'sample-athena-type-response.json'),
      'utf-8',
    );
    trafficTypeMock = JSON.parse(raw);
    trafficTypeExpected = trafficTypeMock.map(
      ({
        // eslint-disable-next-line no-unused-vars
        p70_cls, p70_inp, p70_lcp, trf_type, ...rest
      }) => ({
        type: trf_type,
        ...rest,
      }),
    );
    // Pre-gzip the expected JSON for streaming tests
    gzippedFixture = await gzipAsync(JSON.stringify(trafficTypeExpected));

    sandbox = sinon.createSandbox();

    // Stub S3 client
    mockS3 = { send: sandbox.stub() };

    // Stub Athena query
    mockAthenaQuery = sandbox.stub();

    // Stub logging
    mockLog = {
      info: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };

    // New env variable names
    mockEnv = {
      RUM_METRICS_DATABASE: 'db',
      RUM_METRICS_COMPACT_TABLE: 'table',
      S3_BUCKET_NAME: 'cache-bucket',
    };

    mockSite = { id: SITE_ID };
    mockAccessControlUtil = { hasAccess: sandbox.stub().resolves(true) };

    // Context tailored for new code
    mockContext = {
      params: { siteId: SITE_ID },
      data: { year: 2024, week: 23 },
      dataAccess: { Site: { findById: sandbox.stub().resolves(mockSite) } },
      s3: {
        s3Client: mockS3,
        GetObjectCommand,
      },
    };

    // Access control util stub
    sandbox
      .stub(AccessControlUtil, 'fromContext')
      .returns(mockAccessControlUtil);

    // Default: simulate cache miss on HeadObjectCommand, capture PutObjectCommand
    mockS3.send.callsFake((cmd) => {
      if (cmd instanceof HeadObjectCommand) {
        const err = new Error('Not Found');
        err.name = 'NotFound';
        return Promise.reject(err);
      }
      if (cmd instanceof PutObjectCommand) {
        lastPutObject = cmd;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    sandbox.restore();
    lastPutObject = undefined;
  });

  describe('getPaidTrafficByTypeChannel (no cache)', () => {
    it('returns 200 and writes gzipped JSON to cache', async () => {
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(
        { ...mockContext, athenaClient: { query: mockAthenaQuery } },
        mockLog,
        mockEnv,
      );
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      // Verify cache write
      expect(lastPutObject).to.exist;
      const decompressed = await gunzipAsync(lastPutObject.input.Body);
      const body = JSON.parse(decompressed.toString());
      expect(body).to.deep.equal(trafficTypeExpected);
      // Since caching succeeded, no warning
      expect(mockLog.warn).to.not.have.been.called;
    });
  });

  describe('getPaidTrafficByTypeChannel (cached)', () => {
    it('streams cached gzipped JSON from S3 without hitting Athena', async () => {
      // stub cache hit + streaming body
      mockS3.send.callsFake((cmd) => {
        if (cmd instanceof HeadObjectCommand) {
          return Promise.resolve({}); // cache exists
        }
        if (cmd instanceof GetObjectCommand) {
          return Promise.resolve({ Body: Readable.from([gzippedFixture]) });
        }
        return Promise.resolve({});
      });
      mockAthenaQuery.resetHistory();

      const controller = TrafficController(
        { ...mockContext, athenaClient: { query: mockAthenaQuery } },
        mockLog,
        mockEnv,
      );
      const res = await controller.getPaidTrafficByTypeChannel();

      expect(res.status).to.equal(200);
      expect(res.headers.get('content-encoding')).to.equal('gzip');

      // first decompress: yields JSON text of the Buffer-object wrapper
      const gz1 = Buffer.from(await res.arrayBuffer());
      const wrapperJson = (await gunzipAsync(gz1)).toString('utf8');
      const wrapper = JSON.parse(wrapperJson);

      // reconstruct the inner gzipped Buffer and decompress it
      const innerBuf = Buffer.from(wrapper.data);
      const payloadJson = (await gunzipAsync(innerBuf)).toString('utf8');
      const data = JSON.parse(payloadJson);

      expect(data).to.deep.equal(trafficTypeExpected);
      expect(mockAthenaQuery).not.to.have.been.called;
      expect(lastPutObject).to.be.undefined;
    });
  });

  it('returns 404 if site not found', async () => {
    mockContext.dataAccess.Site.findById.resolves(null);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByTypeChannel();
    expect(res.status).to.equal(404);
  });

  it('returns 403 if access denied', async () => {
    mockAccessControlUtil.hasAccess.resolves(false);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByTypeChannel();
    expect(res.status).to.equal(403);
  });

  it('returns 400 if year or week is missing', async () => {
    const fields = ['year', 'week'];
    for (const field of fields) {
      const badData = { ...mockContext.data };
      delete badData[field];
      const ctx = { ...mockContext, data: badData };
      const controller = TrafficController(
        { ...ctx, athenaClient: { query: mockAthenaQuery } },
        mockLog,
        mockEnv,
      );
      // eslint-disable-next-line no-await-in-loop
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(400);
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json();
      expect(body.message).to.equal('Year and week are required parameters');
    }
  });

  it('caches and returns empty array when Athena returns no rows', async () => {
    mockAthenaQuery.resolves([]);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByTypeChannel();
    expect(res.status).to.equal(200);
    expect(lastPutObject).to.exist;
    const decompressed = await gunzipAsync(lastPutObject.input.Body);
    const body = JSON.parse(decompressed.toString());
    expect(body).to.deep.equal([]);
  });

  it('applies custom CWV thresholds in DTO mapping', async () => {
    const customThresholds = {
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
    const envWithThresholds = {
      ...mockEnv,
      CWV_THRESHOLDS: customThresholds,
    };
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      envWithThresholds,
    );
    await controller.getPaidTrafficByCampaignUrlDevice();
    const decompressed = await gunzipAsync(lastPutObject.input.Body);
    const item = JSON.parse(decompressed.toString())[0];
    expect(item.lcp_score).to.equal('good');
    expect(item.inp_score).to.equal('good');
    expect(item.cls_score).to.equal('good');
  });

  it('getPaidTrafficByCampaignDevice uses correct dimensions and DTO', async () => {
    mockAthenaQuery.resolves([
      {
        utm_campaign: 'fall',
        device: 'desktop',
        pageviews: 302,
        pct_pageviews: 0.7,
        click_rate: 0.2,
        engagement_rate: 0.3,
        bounce_rate: 0.4,
        p70_lcp: 2.6,
        p70_cls: 0.11,
        p70_inp: 0.3,
      },
      {
        utm_campaign: 'fall',
        device: 'tablet',
        pageviews: 100,
        pct_pageviews: 0.3,
        click_rate: 0.1,
        engagement_rate: 0.2,
        bounce_rate: 0.3,
        p70_lcp: 2.0,
        p70_cls: 0.09,
        p70_inp: 600,
      },
    ]);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByCampaignDevice();
    expect(res.status).to.equal(200);
    const decompressed = await gunzipAsync(lastPutObject.input.Body);
    const body = JSON.parse(decompressed.toString());
    expect(body[0].overall_cwv_score).to.equal('needs improvement');
    expect(body[1].overall_cwv_score).to.equal('poor');
    const queryStr = mockAthenaQuery.firstCall.args[0];
    expect(queryStr).to.include('utm_campaign, device');
  });

  it('getPaidTrafficByCampaignUrl uses correct dimensions and DTO', async () => {
    mockAthenaQuery.resolves([
      {
        utm_campaign: 'winter',
        path: '/about',
        pageviews: 300,
        pct_pageviews: 0.8,
        click_rate: 0.3,
        engagement_rate: 0.4,
        bounce_rate: 0.5,
        p70_lcp: 2.0,
        p70_cls: 0.09,
        p70_inp: 150,
      },
      {
        utm_campaign: 'winter',
        path: '/contact',
        pageviews: 100,
        pct_pageviews: 0.2,
        click_rate: 0.05,
        engagement_rate: 0.1,
        bounce_rate: 0.2,
        p70_lcp: 3.0,
        p70_cls: 0.2,
        p70_inp: 250,
      },
      {
        utm_campaign: 'spring',
        path: '/home',
        pageviews: 302,
        pct_pageviews: 0.5,
        click_rate: 0.2,
        engagement_rate: 0.3,
        bounce_rate: 0.4,
        p70_lcp: 1.5,
        p70_cls: 0.05,
        p70_inp: 100,
      },
      {
        utm_campaign: 'fall',
        path: '/landing',
        pageviews: 150,
        pct_pageviews: 0.3,
        click_rate: 0.1,
        engagement_rate: 0.2,
        bounce_rate: 0.3,
        p70_lcp: 4.5,
        p70_cls: 0.3,
        p70_inp: 600,
      },
      {
        utm_campaign: 'summer',
        path: '/promo',
        pageviews: 120,
        pct_pageviews: 0.1,
        click_rate: 0.07,
        engagement_rate: 0.15,
        bounce_rate: 0.25,
        p70_lcp: 2.2,
        p70_cls: 0.08,
        p70_inp: 180,
      },
    ]);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByCampaignUrl();
    expect(res.status).to.equal(200);
    const decompressed = await gunzipAsync(lastPutObject.input.Body);
    const body = JSON.parse(decompressed.toString());
    expect(body).to.have.lengthOf(5);
    const combos = [
      ['winter', '/about', 'good'],
      ['winter', '/contact', 'needs improvement'],
      ['spring', '/home', 'good'],
      ['fall', '/landing', 'poor'],
      ['summer', '/promo', 'good'],
    ];
    combos.forEach(([camp, url, score], i) => {
      expect(body[i].campaign).to.equal(camp);
      expect(body[i].url).to.equal(url);
      expect(body[i].overall_cwv_score).to.equal(score);
    });
    const queryStr = mockAthenaQuery.firstCall.args[0];
    expect(queryStr).to.include('utm_campaign, path');
  });

  it('getPaidTrafficByCampaign uses correct dimensions and DTO', async () => {
    mockAthenaQuery.resolves([
      {
        campaign: 'summer',
        pageviews: 400,
        pct_pageviews: 0.9,
        click_rate: 0.4,
        engagement_rate: 0.5,
        bounce_rate: 0.6,
        p70_lcp: 3020,
        p70_cls: 0.09,
        p70_inp: 150,
      },
      {
        campaign: 'summer',
        pageviews: 100,
        pct_pageviews: 0.1,
        click_rate: 0.01,
        engagement_rate: 0.02,
        bounce_rate: 0.03,
        p70_lcp: 5000,
        p70_cls: 0.09,
        p70_inp: 150,
      },
    ]);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByCampaign();
    expect(res.status).to.equal(200);
    const decompressed = await gunzipAsync(lastPutObject.input.Body);
    const body = JSON.parse(decompressed.toString());
    expect(body[0].overall_cwv_score).to.equal('needs improvement');
    expect(body[1].overall_cwv_score).to.equal('poor');
    const queryStr = mockAthenaQuery.firstCall.args[0];
    expect(queryStr).to.include('utm_campaign');
  });

  it('correctly includes months and years when week spans two months/years', async () => {
    mockContext.data.year = 2024;
    mockContext.data.week = 53;
    mockAthenaQuery.resolves([]);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    await controller.getPaidTrafficByTypeChannel();
    const q = mockAthenaQuery.firstCall.args[0];
    expect(q).to.match(/(12, 1|1, 12)/);
    expect(q).to.match(/(2024, 2025|2025, 2024)/);
  });

  it('handles ISO week edge case (Friday start)', async () => {
    mockContext.data.year = 2021;
    mockContext.data.week = 51;
    mockAthenaQuery.resolves([]);
    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    await controller.getPaidTrafficByTypeChannel();
    const q = mockAthenaQuery.firstCall.args[0];
    expect(q).to.match(/51/);
    expect(q).to.match(/2021/);
  });

  it('logs warning and returns fresh data if S3 PutObjectCommand fails', async () => {
    // Simulate S3 PutObjectCommand throwing an error
    mockS3.send.callsFake((cmd) => {
      if (cmd instanceof HeadObjectCommand) {
        const err = new Error('NotFound');
        err.name = 'NotFound';
        return Promise.reject(err);
      }
      if (cmd instanceof PutObjectCommand) {
        throw new Error('S3 put failed');
      }
      return Promise.resolve({});
    });
    mockAthenaQuery.resolves(trafficTypeMock);

    const controller = TrafficController(
      { ...mockContext, athenaClient: { query: mockAthenaQuery } },
      mockLog,
      mockEnv,
    );
    const res = await controller.getPaidTrafficByTypeChannel();
    expect(res.status).to.equal(200);
    // should have logged a warning about cache failure
    expect(mockLog.warn).to.have.been.calledWithMatch(
      /Failed to cache result to S3 at/,
    );

    // decompress returned gzipped body
    const buf = Buffer.from(await res.arrayBuffer());
    const decompressed = await gunzipAsync(buf);
    const body = JSON.parse(decompressed.toString());
    expect(body).to.deep.equal(trafficTypeExpected);
  });
});
