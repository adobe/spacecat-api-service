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
import { Readable } from 'stream';
import TrafficController from '../../../src/controllers/paid/traffic.js';
import AccessControlUtil from '../../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../controllers/fixtures');
const SITE_ID = 'site-id';

// Helper to round all float values to 9 decimal places in an object
function roundFloats(obj) {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      if (typeof value === 'number') {
        return [key, Math.round(value * 1e9) / 1e9];
      }
      // Try to parse as float if it's a string that looks like a number
      if (typeof value === 'string' && value.trim() !== '') {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          return [key, Math.round(num * 1e9) / 1e9];
        }
      }
      return [key, value];
    }),
  );
}

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
      p70_cls, p70_inp, p70_lcp, ...rest
    }) => rest);
    sandbox = sinon.createSandbox();
    mockS3 = { send: sandbox.stub() };
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
      s3: { s3Client: mockS3 },
      athenaClientFactory: sinon.stub().callsFake(() => mockAthena),
    };
    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    mockS3.send.callsFake((cmd) => {
      if (cmd.constructor.name === 'CopyObjectCommand') {
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
      expect(res.status).to.equal(200);
      const body = await res.json();

      expect(body).to.deep.equal(trafficTypeExpected);
    });

    it('getPaidTrafficByTypeChannel cached returns expected', async () => {
      const mockCacheResponse = await fs.readFile(path.join(FIXTURES_DIR, 'sample-athena-type-cache.csv'), 'utf-8');
      mockAthenaQuery.resolves(trafficTypeMock);

      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return Promise.resolve({ Body: Readable.from([Buffer.from(mockCacheResponse)]) });
        }
        return Promise.resolve({});
      });

      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      const body = await res.json();
      // cached result appear to have up to 9 decimal precision only
      const roundedExpected = trafficTypeExpected.map(roundFloats);
      const roundedActual = body.map(roundFloats);
      expect(roundedActual).to.deep.equal(roundedExpected);
      expect(mockAthenaQuery).not.to.have.been.called;
    });

    it('getPaidTrafficByTypeChannel picks the latest result to store in cache', async () => {
      // Prepare two files: one older, one newer
      const oldDate = new Date(Date.now() - 100000);
      const newDate = new Date();
      const oldKey = `${SITE_ID}/old-file.csv`;
      const newKey = `${SITE_ID}/new-file.csv`;
      const newContent = await fs.readFile(path.join(FIXTURES_DIR, 'sample-athena-type-cache.csv'), 'utf-8');

      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return Promise.resolve({
            Contents: [
              { Key: oldKey, LastModified: oldDate },
              { Key: newKey, LastModified: newDate },
            ],
          });
        }
        if (cmd.constructor.name === 'GetObjectCommand') {
          if (cmd.input && cmd.input.Key === newKey) {
            return Promise.resolve({ Body: Readable.from([Buffer.from(newContent)]) });
          }
        }
        if (cmd.constructor.name === 'CopyObjectCommand') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      mockAthenaQuery.resolves(trafficTypeMock);

      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      // Validate that CopyObjectCommand was called with the newKey as the source
      const copyCalls = mockS3.send.getCalls().filter((call) => call.args[0].constructor.name === 'CopyObjectCommand');
      expect(copyCalls.length).to.be.greaterThan(0);
      const copyInput = copyCalls[0].args[0].input;
      expect(copyInput.CopySource).to.include(newKey);
    });

    it('does not log error if cache file is missing (known exception)', async () => {
      mockS3.send.callsFake((cmd) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          // Simulate finding file output file forsite
          return Promise.resolve({
            Contents: [
              { Key: `${SITE_ID}/cache-file.csv`, LastModified: new Date() },
            ],
          });
        }
        if (cmd.constructor.name === 'GetObjectCommand') {
          // If the Key contains the site cache path, throw the known error
          if (cmd.input && cmd.input.Key && cmd.input.Key.includes(`${SITE_ID}/`)) {
            const err = new Error('The specified key does not exist.');
            err.name = 'NoSuchKey';
            return Promise.reject(err);
          }
          return Promise.resolve({ Body: Readable.from([Buffer.from('')]) });
        }
        return Promise.resolve({});
      });

      mockAthenaQuery.resolves(trafficTypeMock);

      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal(trafficTypeExpected);
      expect(mockLog.error).not.to.have.been.called;
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('getPaidTrafficByTypeChannelCampaign with cache disabled returns expected', async () => {
      // Disable cache bucket
      const envNoCache = { ...mockEnv, PAID_TRAFFIC_S3_CACHE_BUCKET_URI: undefined };
      const mockAthenaOutput = [
        {
          type: 'search', channel: 'google', campaign: 'summer', unrelated: 1000,
        },
        {
          type: 'display', channel: 'facebook', campaign: 'fall', unrelated: 500,
        },
      ];
      mockAthenaQuery.resolves(mockAthenaOutput);

      const controller = TrafficController(mockContext, mockLog, envNoCache);
      const res = await controller.getPaidTrafficByTypeChannelCampaign();
      expect(res.status).to.equal(200);
      const body = await res.json();

      const expetedOutput = mockAthenaOutput.map(({
        // eslint-disable-next-line camelcase,  no-unused-vars
        unrelated, ...rest
      }) => rest);
      expect(body).to.deep.equal(expetedOutput);
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
      const requiredFields = ['siteKey', 'year', 'month', 'week'];
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
        expect(body.message).to.equal('siteKey, year, month and week are required parameters');
      }
    });

    it('getPaidTrafficByTypeChannel returns empty array if Athena returns empty', async () => {
      mockAthenaQuery.resolves([]);
      const controller = TrafficController(mockContext, mockLog, mockEnv);
      const res = await controller.getPaidTrafficByTypeChannel();
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([]);
    });

    it('uses default db, table, and S3 urls if env vars are missing', async () => {
      const envNoDbTableS3 = { ...mockEnv };
      delete envNoDbTableS3.PAID_TRAFFIC_DATABASE;
      delete envNoDbTableS3.PAID_TRAFFIC_TABLE_NAME;
      delete envNoDbTableS3.PAID_TRAFFIC_S3_OUTPUT_URI;
      delete envNoDbTableS3.PAID_TRAFFIC_S3_CACHE_BUCKET_URI;
      mockAthenaQuery.resolves(trafficTypeMock);
      const controller = TrafficController(mockContext, mockLog, envNoDbTableS3);
      await controller.getPaidTrafficByTypeChannel();
      // Validate the query passed to Athena uses the default db and table
      const athenaCall = mockAthenaQuery.getCall(0);
      expect(athenaCall).to.exist;
      const queryArg = athenaCall.args[0];
      expect(queryArg).to.include('cdn_logs_wknd_site.rum_segments_data');
      // Validate S3 output and cache URLs were used in S3 calls
      const s3Calls = mockS3.send.getCalls();
      const outputUsed = s3Calls.some((call) => {
        const input = call.args[0]?.input || call.args[0];
        return input
    && input.Bucket
    && input.Bucket.includes('spacecat-dev-segments')
    && input.Prefix
    && input.Prefix.includes('temp/out');
      });

      const cacheUsed = s3Calls.some((call) => {
        const input = call.args[0]?.input || call.args[0];
        return input
    && input.Bucket
    && input.Bucket.includes('spacecat-dev-segments')
    && input.Key
    && input.Key.includes('cache');
      });

      expect(outputUsed).to.be.true;
      expect(cacheUsed).to.be.true;
    });
  });
});
