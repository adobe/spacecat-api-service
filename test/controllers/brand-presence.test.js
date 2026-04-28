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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const SITE_ID = '0b4dcf79-fe5f-410b-b11f-641f0bf56da3';

const createValidMetric = (overrides = {}) => ({
  site_id: SITE_ID,
  week: '2025-W38',
  platform: 'google',
  category: 'brand',
  topic: 'product',
  prompt: 'What is your product?',
  visibility_score: 75.0,
  mention_count: 5,
  ...overrides,
});

describe('BrandPresenceController', () => {
  const sandbox = sinon.createSandbox();

  let mockClickhouseInstance;
  let BrandPresenceController;
  let mockDataAccess;
  let mockLog;
  let mockSite;
  let context;

  beforeEach(async () => {
    mockClickhouseInstance = {
      writeBatch: sandbox.stub(),
      query: sandbox.stub(),
      close: sandbox.stub().resolves(),
    };

    const module = await esmock('../../src/controllers/brand-presence.js', {
      '@adobe/spacecat-shared-clickhouse-client': {
        // eslint-disable-next-line no-constructor-return
        default: class MockClickhouseClient { constructor() { return mockClickhouseInstance; } },
        toBrandPresenceCompetitorData: () => [],
      },
    });

    BrandPresenceController = module.default;

    mockSite = { getId: () => SITE_ID };

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves(mockSite),
      },
    };

    mockLog = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    context = {
      dataAccess: mockDataAccess,
      log: mockLog,
    };
  });

  afterEach(async () => {
    sandbox.restore();
    await esmock.purge();
  });

  const buildIngestContext = (overrides = {}) => ({
    params: { siteId: SITE_ID },
    data: { metrics: [createValidMetric()] },
    auth: { checkScopes: sandbox.stub() },
    ...overrides,
  });

  // eslint-disable-next-line no-unused-vars
  const buildQueryContext = (overrides = {}) => ({
    params: { siteId: SITE_ID },
    data: { start_week: '2025-W38', end_week: '2025-W40' },
    ...overrides,
  });

  describe('ingest endpoint', () => {
    it('P-01: returns 201 with total, success, failure and items for a valid batch', async () => {
      const metrics = [
        createValidMetric(),
        createValidMetric({ week: '2025-W39' }),
        createValidMetric({ week: '2025-W40' }),
      ];
      mockClickhouseInstance.writeBatch.resolves({ written: 3, failures: [] });
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext({ data: { metrics } }));
      const body = await response.json();

      expect(response.status).to.equal(201);
      expect(body).to.have.property('metadata');
      expect(body.metadata).to.include({ total: 3, success: 3, failure: 0 });
      expect(body).to.have.property('items').that.is.an('array').with.lengthOf(3);
      expect(body).to.have.property('failures').that.is.an('array');
    });

    it('P-02: returns 400 referencing metrics field when body is null', async () => {
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext({ data: null }));
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.include('metrics');
    });

    it('P-02: returns 400 referencing metrics field when metrics key is absent', async () => {
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext({ data: {} }));
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.include('metrics');
    });

    it('P-02: returns 400 referencing metrics field when metrics is not an array', async () => {
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(
        buildIngestContext({ data: { metrics: 'not-an-array' } }),
      );
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.include('metrics');
    });

    it('P-03: returns 400 referencing visibility_score when value exceeds valid range', async () => {
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(
        buildIngestContext({ data: { metrics: [createValidMetric({ visibility_score: 150.0 })] } }),
      );
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.include('visibility_score');
    });

    it('P-04: returns 401 when auth is missing', async () => {
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext({ auth: undefined }));

      expect(response.status).to.equal(401);
    });

    it('P-05: returns 404 when site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext());

      expect(response.status).to.equal(404);
    });

    it('P-06: returns 201 with partial failure metadata and failures array containing index and cause', async () => {
      const metrics = [
        createValidMetric(),
        createValidMetric({ week: '2025-W39' }),
        createValidMetric({ week: '2025-W40', mention_count: -1 }),
      ];
      mockClickhouseInstance.writeBatch.resolves({
        written: 2,
        failures: [{ index: 2, error: 'mention_count must be non-negative' }],
      });
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext({ data: { metrics } }));
      const body = await response.json();

      expect(response.status).to.equal(201);
      expect(body.metadata).to.include({ total: 3, success: 2, failure: 1 });
      expect(body.failures).to.be.an('array').with.lengthOf(1);
      expect(body.failures[0]).to.have.property('index', 2);
      expect(body.failures[0]).to.have.property('error').that.is.a('string');
    });

    it('P-07: returns 500 with generic message and no internal details when ClickHouse is unreachable', async () => {
      mockClickhouseInstance.writeBatch.rejects(
        new Error('Connection refused: ch-node-1.internal:8123'),
      );
      const controller = BrandPresenceController(context);

      const response = await controller.ingestMetrics(buildIngestContext());
      const body = await response.json();

      expect(response.status).to.equal(500);
      expect(body).to.have.property('message').that.is.a('string');
      expect(body.message).to.not.include('ch-node-1.internal');
      expect(body.message).to.not.include('Connection refused');
    });
  });

  describe('query endpoint', () => {
    beforeEach(() => {
      mockClickhouseInstance.query
        .onFirstCall().resolves([{ total: '10' }])
        .onSecondCall().resolves([]);
    });
  });
});
