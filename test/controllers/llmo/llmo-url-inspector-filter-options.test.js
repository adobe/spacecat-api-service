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
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  createFilterOptionsHandler,
  extractDistinct,
  extractDistinctChannels,
} from '../../../src/controllers/llmo/llmo-url-inspector-filter-options.js';

use(sinonChai);

const SITE_ID = '0178a3f0-1234-7000-8000-000000000001';
const ORG_ID = '0178a3f0-aaaa-7000-8000-000000000001';

/**
 * Creates a mock PostgREST client that returns different results per table.
 * Each .from(tableName) call returns a new independent chain so that
 * parallel queries (Promise.all) resolve independently.
 */
function createTableAwareMock(tableResults = {}, defaultResult = { data: [], error: null }) {
  const stubs = {
    select: sinon.stub(),
    eq: sinon.stub(),
    gte: sinon.stub(),
    lte: sinon.stub(),
    limit: sinon.stub(),
  };

  const fromStub = sinon.stub();

  function makeChain(table) {
    const result = tableResults[table] ?? defaultResult;
    const chain = {
      from: fromStub,
      select(...args) {
        stubs.select(...args);
        return chain;
      },
      eq(...args) {
        stubs.eq(...args);
        return chain;
      },
      gte(...args) {
        stubs.gte(...args);
        return chain;
      },
      lte(...args) {
        stubs.lte(...args);
        return chain;
      },
      limit(...args) {
        stubs.limit(...args);
        return Promise.resolve(result);
      },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  fromStub.callsFake((t) => makeChain(t));
  return { from: fromStub, ...stubs };
}

describe('llmo-url-inspector-filter-options', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: { spaceCatId: ORG_ID, brandId: 'all' },
      data: { siteId: SITE_ID },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: { postgrestService: null },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('extractDistinct', () => {
    it('returns sorted unique values', () => {
      const rows = [
        { region_code: 'US' },
        { region_code: 'DE' },
        { region_code: 'US' },
        { region_code: 'JP' },
      ];
      expect(extractDistinct(rows, 'region_code')).to.deep.equal(['DE', 'JP', 'US']);
    });

    it('splits comma-separated values', () => {
      const rows = [
        { category_name: 'AI Tools,Analytics' },
        { category_name: 'Security' },
        { category_name: 'Analytics,Marketing' },
      ];
      expect(extractDistinct(rows, 'category_name'))
        .to.deep.equal(['AI Tools', 'Analytics', 'Marketing', 'Security']);
    });

    it('excludes null and empty values', () => {
      const rows = [
        { region_code: null },
        { region_code: '' },
        { region_code: 'US' },
        { region_code: undefined },
      ];
      expect(extractDistinct(rows, 'region_code')).to.deep.equal(['US']);
    });

    it('returns empty array for empty rows', () => {
      expect(extractDistinct([], 'region_code')).to.deep.equal([]);
    });

    it('trims whitespace around comma-separated values', () => {
      const rows = [{ category_name: ' AI Tools , Analytics ' }];
      expect(extractDistinct(rows, 'category_name'))
        .to.deep.equal(['AI Tools', 'Analytics']);
    });
  });

  describe('extractDistinctChannels', () => {
    it('maps competitor to others', () => {
      const rows = [
        { content_type: 'owned' },
        { content_type: 'competitor' },
        { content_type: 'earned' },
      ];
      expect(extractDistinctChannels(rows)).to.deep.equal(['earned', 'others', 'owned']);
    });

    it('excludes null and empty values', () => {
      const rows = [
        { content_type: null },
        { content_type: '' },
        { content_type: 'social' },
      ];
      expect(extractDistinctChannels(rows)).to.deep.equal(['social']);
    });

    it('returns empty array for empty rows', () => {
      expect(extractDistinctChannels([])).to.deep.equal([]);
    });

    it('deduplicates mapped values', () => {
      const rows = [
        { content_type: 'competitor' },
        { content_type: 'competitor' },
        { content_type: 'owned' },
      ];
      expect(extractDistinctChannels(rows)).to.deep.equal(['others', 'owned']);
    });
  });

  describe('createFilterOptionsHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock();
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view URL Inspector data'),
      );

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock();
      getOrgAndValidateAccess.rejects(new Error('Organization not found: x'));

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when siteId is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock();
      mockContext.data = {};

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('siteId');
    });

    it('returns ok with distinct filter values (happy path)', async () => {
      const execRows = [
        { category_name: 'Software', region_code: 'US' },
        { category_name: 'Marketing', region_code: 'DE' },
        { category_name: 'Software', region_code: 'US' },
        { category_name: 'AI Tools', region_code: 'JP' },
      ];
      const srcRows = [
        { content_type: 'owned' },
        { content_type: 'competitor' },
        { content_type: 'earned' },
        { content_type: 'owned' },
        { content_type: 'social' },
      ];

      const client = createTableAwareMock({
        brand_presence_executions: { data: execRows, error: null },
        brand_presence_sources: { data: srcRows, error: null },
      });
      mockContext.dataAccess.Site.postgrestService = client;
      mockContext.data = {
        siteId: SITE_ID,
        startDate: '2026-03-01',
        endDate: '2026-03-15',
      };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.regions).to.deep.equal(['DE', 'JP', 'US']);
      expect(body.categories).to.deep.equal(['AI Tools', 'Marketing', 'Software']);
      expect(body.channels).to.deep.equal(['earned', 'others', 'owned', 'social']);
    });

    it('returns empty arrays when no data exists', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock();

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.regions).to.deep.equal([]);
      expect(body.categories).to.deep.equal([]);
      expect(body.channels).to.deep.equal([]);
    });

    it('returns empty arrays when data is null', async () => {
      const client = createTableAwareMock({}, { data: null, error: null });
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.regions).to.deep.equal([]);
      expect(body.categories).to.deep.equal([]);
      expect(body.channels).to.deep.equal([]);
    });

    it('applies platform filter to both queries', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;
      mockContext.data = {
        siteId: SITE_ID,
        platform: 'chatgpt',
      };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.from).to.have.been.calledWith('brand_presence_executions');
      expect(client.from).to.have.been.calledWith('brand_presence_sources');

      const modelCalls = client.eq.getCalls().filter((c) => c.args[0] === 'model');
      expect(modelCalls).to.have.lengthOf(2);
      expect(modelCalls[0].args[1]).to.equal('chatgpt');
      expect(modelCalls[1].args[1]).to.equal('chatgpt');
    });

    it('applies date range filters to both queries', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;
      mockContext.data = {
        siteId: SITE_ID,
        startDate: '2026-01-01',
        endDate: '2026-03-31',
      };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const gteCalls = client.gte.getCalls().filter((c) => c.args[0] === 'execution_date');
      const lteCalls = client.lte.getCalls().filter((c) => c.args[0] === 'execution_date');

      expect(gteCalls).to.have.lengthOf(2);
      expect(lteCalls).to.have.lengthOf(2);
      expect(gteCalls[0].args[1]).to.equal('2026-01-01');
      expect(lteCalls[0].args[1]).to.equal('2026-03-31');
    });

    it('returns badRequest when executions query fails', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: null, error: { message: 'relation does not exist' } },
      });
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation does not exist');
      expect(mockContext.log.error).to.have.been.calledOnce;
    });

    it('returns badRequest when sources query fails', async () => {
      const client = createTableAwareMock({
        brand_presence_sources: { data: null, error: { message: 'permission denied' } },
      });
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('permission denied');
      expect(mockContext.log.error).to.have.been.calledOnce;
    });

    it('returns 500 when handler throws unexpectedly', async () => {
      mockContext.dataAccess.Site.postgrestService = {
        from: sinon.stub().throws(new Error('connection reset')),
      };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(500);
      expect(mockContext.log.error).to.have.been.called;
    });

    it('handles comma-separated categories and regions', async () => {
      const execRows = [
        { category_name: 'AI Tools,Analytics', region_code: 'US,DE' },
        { category_name: 'Security', region_code: 'JP' },
      ];

      const client = createTableAwareMock({
        brand_presence_executions: { data: execRows, error: null },
      });
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.categories).to.deep.equal(['AI Tools', 'Analytics', 'Security']);
      expect(body.regions).to.deep.equal(['DE', 'JP', 'US']);
    });

    it('skips platform filter when set to "all"', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;
      mockContext.data = {
        siteId: SITE_ID,
        platform: 'all',
      };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const modelCalls = client.eq.getCalls().filter((c) => c.args[0] === 'model');
      expect(modelCalls).to.have.lengthOf(0);
    });

    it('supports snake_case query param aliases', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;
      mockContext.data = {
        site_id: SITE_ID,
        start_date: '2026-01-01',
        end_date: '2026-03-31',
      };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(client.eq).to.have.been.calledWith('site_id', SITE_ID);
    });

    it('does not apply date filters when dates are not provided', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;
      mockContext.data = { siteId: SITE_ID };

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.gte).not.to.have.been.called;
      expect(client.lte).not.to.have.been.called;
    });

    it('filters executions by brandId when a specific UUID is provided', async () => {
      const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
      mockContext.params.brandId = brandUuid;

      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('brand_id', brandUuid);
    });

    it('does not filter by brandId when brandId is "all"', async () => {
      mockContext.params.brandId = 'all';

      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createFilterOptionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const eqCalls = client.eq.getCalls().map((c) => c.args);
      const brandCall = eqCalls.find(([col]) => col === 'brand_id');
      expect(brandCall).to.be.undefined;
    });
  });
});
