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
/* eslint-disable no-unused-vars */

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

  const buildQueryContext = (overrides = {}) => ({
    params: { siteId: SITE_ID },
    data: { start_week: '2025-W38', end_week: '2025-W40' },
    ...overrides,
  });

  describe('ingestMetrics', () => {});

  describe('queryData', () => {
    beforeEach(() => {
      mockClickhouseInstance.query
        .onFirstCall().resolves([{ total: '10' }])
        .onSecondCall().resolves([]);
    });
  });
});
