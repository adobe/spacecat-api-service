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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  aggregateSentimentByWeek,
  aggregateShareOfVoice,
  buildPromptKey,
  createBrandPresenceWeeksHandler,
  createFilterDimensionsHandler,
  createSentimentOverviewHandler,
  createMarketTrackingTrendsHandler,
  createShareOfVoiceHandler,
  dateToIsoWeek,
  getWeekDateRange,
  resolveSiteIds,
  strCompare,
  toFilterOption,
  toISOWeek,
  validateSiteBelongsToOrg,
  volumeToPopularity,
} from '../../../src/controllers/llmo/llmo-brand-presence.js';

use(sinonChai);

function createChainableMock(resolveValue = { data: [], error: null }, resolveSequence = null) {
  const limitStub = resolveSequence
    ? sinon.stub()
      .onFirstCall()
      .resolves(resolveSequence[0] ?? resolveValue)
      .onSecondCall()
      .resolves(resolveSequence[1] ?? { data: [], error: null })
      .onThirdCall()
      .resolves(resolveSequence[2] ?? { data: [], error: null })
    : sinon.stub().resolves(resolveValue);
  const c = {
    from: sinon.stub().returnsThis(),
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    in: sinon.stub().returnsThis(),
    ilike: sinon.stub().returnsThis(),
    gte: sinon.stub().returnsThis(),
    lte: sinon.stub().returnsThis(),
    not: sinon.stub().returnsThis(),
    or: sinon.stub().returnsThis(),
    filter: sinon.stub().returnsThis(),
    order: sinon.stub().returnsThis(),
    limit: limitStub,
    then(resolve) { return Promise.resolve(resolveValue).then(resolve); },
  };
  return c;
}

/**
 * Creates a mock PostgREST client that returns different results per table.
 * Each `.from(tableName)` call returns a new independent chain object so that
 * parallel queries (Promise.all) resolve independently with their own result.
 * Shared sinon stubs on the root object accumulate all calls for assertions.
 */
function createTableAwareMock(
  tableResults = {},
  defaultResult = { data: [], error: null },
  rpcResults = {},
) {
  // Declare stubs first so makeChain can close over them
  const stubs = {
    select: sinon.stub(),
    eq: sinon.stub(),
    gte: sinon.stub(),
    lte: sinon.stub(),
    ilike: sinon.stub(),
    in: sinon.stub(),
    order: sinon.stub(),
    limit: sinon.stub(),
    not: sinon.stub(),
    filter: sinon.stub(),
    or: sinon.stub(),
  };

  // Declare fromStub first so makeChain can reference it without a forward-reference lint error.
  const fromStub = sinon.stub();

  const rpcStub = sinon.stub().callsFake((fnName) => {
    const result = rpcResults[fnName] ?? defaultResult;
    return Promise.resolve(result);
  });

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
      ilike(...args) {
        stubs.ilike(...args);
        return chain;
      },
      in(...args) {
        stubs.in(...args);
        return chain;
      },
      order(...args) {
        stubs.order(...args);
        return chain;
      },
      not(...args) {
        stubs.not(...args);
        return chain;
      },
      filter(...args) {
        stubs.filter(...args);
        return chain;
      },
      or(...args) {
        stubs.or(...args);
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
  return { from: fromStub, rpc: rpcStub, ...stubs };
}

describe('llmo-brand-presence', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;
  let mockClient;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: {
        spaceCatId: '0178a3f0-1234-7000-8000-000000000001',
        brandId: 'all',
      },
      data: {},
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: {
          postgrestService: null,
        },
      },
    };
    mockClient = createChainableMock();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('strCompare', () => {
    it('handles null/undefined first arg (uses empty string fallback)', () => {
      expect(strCompare(null, 'b')).to.be.lessThan(0);
      expect(strCompare(undefined, 'b')).to.be.lessThan(0);
      expect(strCompare('', 'b')).to.be.lessThan(0);
    });

    it('handles null/undefined second arg (uses empty string fallback)', () => {
      expect(strCompare('a', null)).to.be.greaterThan(0);
      expect(strCompare('a', undefined)).to.be.greaterThan(0);
      expect(strCompare('a', '')).to.be.greaterThan(0);
    });

    it('handles both null/undefined (both become empty string)', () => {
      expect(strCompare(null, null)).to.equal(0);
      expect(strCompare(undefined, undefined)).to.equal(0);
    });

    it('compares truthy strings normally', () => {
      expect(strCompare('a', 'b')).to.be.lessThan(0);
      expect(strCompare('b', 'a')).to.be.greaterThan(0);
    });
  });

  describe('getWeekDateRange', () => {
    it('returns startDate and endDate for valid ISO week', () => {
      expect(getWeekDateRange('2026-W11')).to.deep.equal({
        startDate: '2026-03-09',
        endDate: '2026-03-15',
      });
    });

    it('handles year where Jan 4 is Sunday (dayOfWeek 0)', () => {
      expect(getWeekDateRange('2026-W01')).to.deep.equal({
        startDate: '2025-12-29',
        endDate: '2026-01-04',
      });
    });

    it('handles year where Jan 4 is Monday (dayOfWeek 1)', () => {
      expect(getWeekDateRange('2021-W01')).to.deep.equal({
        startDate: '2021-01-04',
        endDate: '2021-01-10',
      });
    });

    it('returns null for invalid format', () => {
      expect(getWeekDateRange('invalid')).to.be.null;
      expect(getWeekDateRange('2026-11')).to.be.null;
      expect(getWeekDateRange('W11')).to.be.null;
    });

    it('returns null for week out of range', () => {
      expect(getWeekDateRange('2026-W00')).to.be.null;
      expect(getWeekDateRange('2026-W54')).to.be.null;
    });

    it('returns valid range for ISO week 53 when year has 53 weeks (2020-W53)', () => {
      expect(getWeekDateRange('2020-W53')).to.deep.equal({
        startDate: '2020-12-28',
        endDate: '2021-01-03',
      });
    });

    it('returns range for week 53 when year has 52 weeks (2021-W53 overflow)', () => {
      expect(getWeekDateRange('2021-W53')).to.deep.equal({
        startDate: '2022-01-03',
        endDate: '2022-01-09',
      });
    });
  });

  describe('toFilterOption', () => {
    it('handles null id (uses empty string fallback)', () => {
      expect(toFilterOption(null, 'Label')).to.deep.equal({ id: '', label: 'Label' });
    });

    it('handles null label (uses id fallback)', () => {
      expect(toFilterOption('id-1', null)).to.deep.equal({ id: 'id-1', label: 'id-1' });
    });

    it('handles both null (uses empty string fallbacks)', () => {
      expect(toFilterOption(null, null)).to.deep.equal({ id: '', label: '' });
    });

    it('handles undefined id and label', () => {
      expect(toFilterOption(undefined, undefined)).to.deep.equal({ id: '', label: '' });
    });

    it('returns id and label when both provided', () => {
      expect(toFilterOption('id-1', 'Label')).to.deep.equal({ id: 'id-1', label: 'Label' });
    });
  });

  describe('validateSiteBelongsToOrg', () => {
    it('returns true when siteId is null (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', null);
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is undefined (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', undefined);
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is empty string (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', '');
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is "all" (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', 'all');
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });

    it('returns true when siteId is "*" (skips validation)', async () => {
      const client = createChainableMock();
      const result = await validateSiteBelongsToOrg(client, 'org-1', '*');
      expect(result).to.be.true;
      expect(client.from).not.to.have.been.called;
    });
  });

  describe('resolveSiteIds', () => {
    it('queries sites table and returns site IDs when no siteId and no filterByBrandId', async () => {
      const sitesData = {
        data: [
          { id: 'site-1' },
          { id: 'site-2' },
        ],
        error: null,
      };
      const client = createChainableMock(sitesData);
      const result = await resolveSiteIds(client, 'org-1', null, null, []);

      expect(result).to.deep.equal(['site-1', 'site-2']);
      expect(client.from).to.have.been.calledWith('sites');
      expect(client.eq).to.have.been.calledWith('organization_id', 'org-1');
    });

    it('returns empty array when sites query returns error', async () => {
      const client = createChainableMock({ data: null, error: { message: 'DB error' } });
      const result = await resolveSiteIds(client, 'org-1', null, null, []);

      expect(result).to.deep.equal([]);
    });

    it('returns empty array when sites query returns empty data', async () => {
      const client = createChainableMock({ data: [], error: null });
      const result = await resolveSiteIds(client, 'org-1', null, null, []);

      expect(result).to.deep.equal([]);
    });
  });

  describe('createFilterDimensionsHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: 0178a3f0-1234-7000-8000-000000000001'));

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when generic error is thrown', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Database connection failed'));

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.calledWith('Brand presence filter-dimensions error: Database connection failed');
    });

    it('returns badRequest when executions query returns error', async () => {
      const queryError = { message: 'relation "brand_presence_executions" does not exist' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: queryError },
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation "brand_presence_executions" does not exist');
      expect(mockContext.log.error).to.have.been.calledWith(
        'Brand presence filter-dimensions PostgREST error: relation "brand_presence_executions" does not exist',
      );
    });

    it('handles executions query returning data: null (uses empty rows fallback)', async () => {
      const emptySites = { data: [], error: null };
      const emptyPageIntents = { data: [], error: null };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        [{ data: null, error: null }, emptySites, emptyPageIntents],
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.deep.equal([]);
      expect(body.categories).to.deep.equal([]);
      expect(body.page_intents).to.deep.equal([]);
    });

    it('skips filter when categoryId is "all" (SKIP_VALUES)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: 'all' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).not.to.have.been.calledWith('category_id', sinon.match.any);
      expect(chainMock.eq).not.to.have.been.calledWith('category_name', sinon.match.any);
    });

    it('handles null/undefined context.data (uses empty object fallback)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
    });

    it('accepts snake_case params (start_date, end_date, model, site_id, etc.)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        model: 'gemini',
        site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
        category_id: '0178a3f0-1234-7000-8000-000000000099',
        topicIds: '0178a3f0-1234-7000-8000-0000000000aa',
        region_code: 'US',
        user_intent: 'TRANSACTIONAL',
        prompt_branding: 'true',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.gte).to.have.been.calledWith('execution_date', '2025-01-01');
      expect(chainMock.lte).to.have.been.calledWith('execution_date', '2025-01-31');
      expect(chainMock.eq).to.have.been.calledWith('model', 'gemini');
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'cccdac43-1a22-4659-9086-b762f59b9928');
      expect(chainMock.in).to.have.been.calledWith('topic_id', ['0178a3f0-1234-7000-8000-0000000000aa']);
      expect(chainMock.limit).to.have.been.calledWith(5000);
    });

    it('returns ok with brands, categories, topics, origins, regions, page_intents', async () => {
      const topicId1 = '0178a3f0-1234-7000-8000-0000000000a1';
      const topicId2 = '0178a3f0-1234-7000-8000-0000000000a2';
      const brandData = {
        data: [
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000002',
            brand_name: 'Brand A',
            category_name: 'Cat1',
            topic_id: topicId1,
            topics: 't1',
            region_code: 'US',
            origin: 'human',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000003',
            brand_name: 'Brand B',
            category_name: 'Cat2',
            topic_id: topicId2,
            topics: 't2',
            region_code: 'DE',
            origin: 'ai',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
        ],
        error: null,
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }, { page_intent: 'INFORMATIONAL' }],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        brandData,
        [brandData, pageIntentsData],
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.have.lengthOf(2);
      expect(body.brands[0]).to.have.property('id');
      expect(body.brands[0]).to.have.property('label');
      expect(body.categories).to.have.lengthOf(2);
      expect(body.topics).to.have.lengthOf(2);
      expect(body.topics[0]).to.deep.include({ id: topicId1, label: 't1' });
      expect(body.topics[1]).to.deep.include({ id: topicId2, label: 't2' });
      expect(body.origins).to.have.lengthOf(2);
      expect(body.regions).to.have.lengthOf(2);
      expect(body.page_intents).to.have.lengthOf(2);
      expect(body.page_intents[0]).to.have.property('id');
      expect(body.page_intents[0]).to.have.property('label');
    });

    it('uses topic_id as label when topics is null or empty', async () => {
      const topicIdNoLabel = '0178a3f0-1234-7000-8000-0000000000ff';
      const brandData = {
        data: [
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000002',
            brand_name: 'Brand A',
            category_name: 'Cat1',
            topic_id: topicIdNoLabel,
            topics: null,
            region_code: 'US',
            origin: 'human',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
        ],
        error: null,
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        brandData,
        [brandData, pageIntentsData],
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topics).to.have.lengthOf(1);
      expect(body.topics[0]).to.deep.include({ id: topicIdNoLabel, label: topicIdNoLabel });
    });

    it('filters by brandId when single brand route', async () => {
      const brandData = {
        data: [
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000002',
            brand_name: 'Brand A',
            category_name: 'Cat1',
            topics: 't1',
            region_code: 'US',
            origin: 'human',
            site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          },
        ],
        error: null,
      };
      const pageIntentsData = { data: [{ page_intent: 'TRANSACTIONAL' }], error: null };
      const chainMock = createChainableMock(brandData, [brandData, pageIntentsData]);
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(chainMock.eq).to.have.been.calledWith('brand_id', '0178a3f0-1234-7000-8000-000000000002');
    });

    it('filters by category_id when categoryId is a valid UUID', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: '0178a3f0-1234-7000-8000-000000000099' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('category_id', '0178a3f0-1234-7000-8000-000000000099');
    });

    it('filters by category_name when categoryId is not a UUID (e.g. Acrobat)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: 'Acrobat' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('category_name', 'Acrobat');
    });

    it('filters by topicIds (single UUID) when provided', async () => {
      const topicUuid = '0178a3f0-1234-7000-8000-0000000000aa';
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: topicUuid };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.in).to.have.been.calledWith('topic_id', [topicUuid]);
    });

    it('filters by topicIds (comma-separated UUIDs) when provided', async () => {
      const topicUuids = [
        '0178a3f0-1234-7000-8000-0000000000aa',
        '0178a3f0-1234-7000-8000-0000000000bb',
      ];
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: topicUuids.join(',') };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.in).to.have.been.calledWith('topic_id', topicUuids);
    });

    it('filters by topicIds (array) when provided', async () => {
      const topicUuids = [
        '0178a3f0-1234-7000-8000-0000000000aa',
        '0178a3f0-1234-7000-8000-0000000000bb',
      ];
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: topicUuids };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.in).to.have.been.calledWith('topic_id', topicUuids);
    });

    it('ignores non-UUID topicIds values', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: 'combine pdf' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const topicIdCalls = chainMock.eq.getCalls().filter((c) => c.args[0] === 'topic_id');
      const topicInCalls = chainMock.in.getCalls().filter((c) => c.args[0] === 'topic_id');
      expect(topicIdCalls).to.have.lengthOf(0);
      expect(topicInCalls).to.have.lengthOf(0);
    });

    it('does not apply topic filter when topicIds is non-string, non-array value that fails UUID validation', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: 12345 };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const topicInCalls = chainMock.in.getCalls().filter((c) => c.args[0] === 'topic_id');
      expect(topicInCalls).to.have.lengthOf(0);
    });

    it('filters by regionCode when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { regionCode: 'US' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('region_code', 'US');
    });

    it('filters by origin when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { origin: 'ai' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.ilike).to.have.been.calledWith('origin', 'ai');
    });

    it('includes page_intents from page_intents table when siteId is provided', async () => {
      const brandData = { data: [], error: null };
      const sitesValidation = { data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }], error: null };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }, { page_intent: 'INFORMATIONAL' }],
        error: null,
      };
      const chainMock = createChainableMock(brandData, [
        brandData,
        sitesValidation,
        pageIntentsData,
      ]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.page_intents).to.have.lengthOf(2);
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'cccdac43-1a22-4659-9086-b762f59b9928');
    });

    it('returns 403 when siteId does not belong to the organization', async () => {
      const brandData = { data: [], error: null };
      const sitesValidation = { data: [], error: null };
      const chainMock = createChainableMock(brandData, [brandData, sitesValidation]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Site does not belong to the organization');
    });

    it('dedupes origins after lowercasing (Human and human become one)', async () => {
      const brandData = {
        data: [
          {
            brand_id: 'b1',
            brand_name: 'B1',
            category_name: 'C1',
            topics: 't1',
            region_code: 'US',
            origin: 'Human',
            site_id: 's1',
          },
          {
            brand_id: 'b2',
            brand_name: 'B2',
            category_name: 'C2',
            topics: 't2',
            region_code: 'DE',
            origin: 'human',
            site_id: 's1',
          },
          {
            brand_id: 'b3',
            brand_name: 'B3',
            category_name: 'C3',
            topics: 't3',
            region_code: 'WW',
            origin: 'ai',
            site_id: 's1',
          },
        ],
        error: null,
      };
      const pageIntentsData = { data: [{ page_intent: 'TRANSACTIONAL' }], error: null };
      const chainMock = createChainableMock(brandData, [brandData, pageIntentsData]);
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.origins).to.have.lengthOf(2);
      const originIds = body.origins.map((o) => o.id).sort();
      expect(originIds).to.deep.equal(['ai', 'human']);
    });
  });

  describe('createBrandPresenceWeeksHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: 0178a3f0-1234-7000-8000-000000000001'));

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Organization not found: 0178a3f0-1234-7000-8000-000000000001');
    });

    it('returns badRequest when generic error is thrown', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Database connection failed'));

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Database connection failed');
      expect(mockContext.log.error).to.have.been.calledWith(
        'Brand presence weeks error: Database connection failed',
      );
    });

    it('returns badRequest when brand_metrics_weekly query returns error', async () => {
      const queryError = { message: 'relation "brand_metrics_weekly" does not exist' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: queryError },
      );

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation "brand_metrics_weekly" does not exist');
      expect(mockContext.log.error).to.have.been.calledWith(
        'Brand presence weeks PostgREST error: relation "brand_metrics_weekly" does not exist',
      );
    });

    it('returns empty weeks when no data', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeks).to.deep.equal([]);
    });

    it('handles null/undefined context.data (uses empty object fallback)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeks).to.deep.equal([]);
    });

    it('handles weeks query with data: null (empty rows fallback)', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: null, error: null },
      );

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeks).to.deep.equal([]);
    });

    it('returns distinct weeks sorted descending', async () => {
      const metricsData = {
        data: [
          { week: '2026-W11' },
          { week: '2026-W10' },
          { week: '2026-W11' },
          { week: '2026-W09' },
          { week: '2026-W07' },
        ],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(metricsData);

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeks).to.deep.equal([
        { week: '2026-W11', startDate: '2026-03-09', endDate: '2026-03-15' },
        { week: '2026-W10', startDate: '2026-03-02', endDate: '2026-03-08' },
        { week: '2026-W09', startDate: '2026-02-23', endDate: '2026-03-01' },
        { week: '2026-W07', startDate: '2026-02-09', endDate: '2026-02-15' },
      ]);
    });

    it('returns startDate/endDate null for invalid week strings from DB', async () => {
      const metricsData = {
        data: [
          { week: '2026-W11' },
          { week: '2026-W00' },
          { week: 'invalid' },
        ],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(metricsData);

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeks).to.have.lengthOf(3);
      expect(body.weeks[0]).to.deep.equal({
        week: 'invalid',
        startDate: null,
        endDate: null,
      });
      expect(body.weeks[1]).to.deep.equal({
        week: '2026-W11',
        startDate: '2026-03-09',
        endDate: '2026-03-15',
      });
      expect(body.weeks[2]).to.deep.equal({
        week: '2026-W00',
        startDate: null,
        endDate: null,
      });
    });

    it('defaults model to chatgpt when not provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'chatgpt');
    });

    it('uses model from query param when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { model: 'openai' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'openai');
    });

    it('filters by brandId when single brand route', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('brand_id', '0178a3f0-1234-7000-8000-000000000002');
    });

    it('does not filter by brand when brandId is "all"', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.params.brandId = 'all';
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const brandIdCalls = chainMock.eq.getCalls().filter((c) => c.args[0] === 'brand_id');
      expect(brandIdCalls).to.have.lengthOf(0);
    });

    it('filters by siteId when provided', async () => {
      const siteValidation = { data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }], error: null };
      const execData = { data: [], error: null };
      const chainMock = createChainableMock(execData, [siteValidation, execData]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const siteIdCalls = chainMock.eq.getCalls().filter((c) => c.args[0] === 'site_id');
      expect(siteIdCalls).to.have.lengthOf.at.least(1);
      expect(siteIdCalls.some((c) => c.args[1] === 'cccdac43-1a22-4659-9086-b762f59b9928')).to.be.true;
    });

    it('accepts site_id as alias for siteId', async () => {
      const siteValidation = { data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }], error: null };
      const execData = { data: [], error: null };
      const chainMock = createChainableMock(execData, [siteValidation, execData]);
      mockContext.data = { site_id: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const siteIdCalls = chainMock.eq.getCalls().filter((c) => c.args[0] === 'site_id');
      expect(siteIdCalls).to.have.lengthOf.at.least(1);
      expect(siteIdCalls.some((c) => c.args[1] === 'cccdac43-1a22-4659-9086-b762f59b9928')).to.be.true;
    });

    it('returns 403 when siteId does not belong to the organization', async () => {
      const sitesValidation = { data: [], error: null };
      const chainMock = createChainableMock(sitesValidation);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Site does not belong to the organization');
    });

    it('queries brand_metrics_weekly with select week, order descending, limit 200000', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.from).to.have.been.calledWith('brand_metrics_weekly');
      expect(chainMock.select).to.have.been.calledWith('week');
      expect(chainMock.eq).to.have.been.calledWith('organization_id', mockContext.params.spaceCatId);
      expect(chainMock.order).to.have.been.calledWith('week', { ascending: false });
      expect(chainMock.limit).to.have.been.calledWith(200000);
    });
  });

  describe('toISOWeek', () => {
    it('converts a date string to ISO week', () => {
      const result = toISOWeek('2026-03-11');
      expect(result).to.deep.equal({ week: '2026-W11', weekNumber: 11, year: 2026 });
    });

    it('handles year boundary (Jan 1 can belong to previous year week)', () => {
      const result = toISOWeek('2026-01-01');
      expect(result).to.deep.equal({ week: '2026-W01', weekNumber: 1, year: 2026 });
    });

    it('handles date in the middle of the year', () => {
      const result = toISOWeek('2026-06-15');
      expect(result).to.have.property('week');
      expect(result).to.have.property('weekNumber');
      expect(result.year).to.equal(2026);
    });
  });

  describe('buildPromptKey', () => {
    it('builds key from prompt, region_code, and topics', () => {
      const row = { prompt: 'What is Adobe?', region_code: 'US', topics: 'branding' };
      expect(buildPromptKey(row)).to.equal('What is Adobe?|US|branding');
    });

    it('uses Unknown for missing region_code and topics', () => {
      const row = { prompt: 'test' };
      expect(buildPromptKey(row)).to.equal('test|Unknown|Unknown');
    });

    it('uses empty string for null prompt', () => {
      const row = { prompt: null, region_code: 'DE', topics: 'pdf' };
      expect(buildPromptKey(row)).to.equal('|DE|pdf');
    });
  });

  describe('aggregateSentimentByWeek', () => {
    it('returns empty array for empty input', () => {
      expect(aggregateSentimentByWeek([])).to.deep.equal([]);
    });

    it('aggregates rows into weekly percentages', () => {
      const rows = [
        {
          execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-10', sentiment: 'negative', prompt: 'p2', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-11', sentiment: 'neutral', prompt: 'p3', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-11', sentiment: 'positive', prompt: 'p4', region_code: 'US', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);

      expect(result).to.have.lengthOf(1);
      expect(result[0].totalPrompts).to.equal(4);
      expect(result[0].promptsWithSentiment).to.equal(4);
      const sentimentMap = {};
      result[0].sentiment.forEach((s) => {
        sentimentMap[s.name] = s.value;
      });
      expect(sentimentMap.Positive).to.equal(50);
      expect(sentimentMap.Negative).to.equal(25);
      expect(sentimentMap.Neutral).to.equal(25);
    });

    it('deduplicates rows with same prompt key within a week', () => {
      const rows = [
        {
          execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-10', sentiment: 'negative', prompt: 'p1', region_code: 'US', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);

      expect(result).to.have.lengthOf(1);
      expect(result[0].totalPrompts).to.equal(1);
      expect(result[0].promptsWithSentiment).to.equal(1);
    });

    it('counts same prompt with different region as separate', () => {
      const rows = [
        {
          execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-09', sentiment: 'negative', prompt: 'p1', region_code: 'DE', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);

      expect(result[0].totalPrompts).to.equal(2);
    });

    it('handles rows with null/missing sentiment', () => {
      const rows = [
        {
          execution_date: '2026-03-09', sentiment: null, prompt: 'p1', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p2', region_code: 'US', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);

      expect(result[0].totalPrompts).to.equal(2);
      expect(result[0].promptsWithSentiment).to.equal(1);
    });

    it('sorts results by week ascending', () => {
      const rows = [
        {
          execution_date: '2026-03-16', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-02', sentiment: 'positive', prompt: 'p2', region_code: 'US', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);

      expect(result).to.have.lengthOf(2);
      expect(result[0].weekNumber).to.be.lessThan(result[1].weekNumber);
    });

    it('includes color hex codes in sentiment entries', () => {
      const rows = [
        {
          execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);
      const colors = result[0].sentiment.map((s) => s.color);

      expect(colors).to.include('#047857');
      expect(colors).to.include('#4B5563');
      expect(colors).to.include('#B91C1C');
    });

    it('returns zero percentages when no prompts have sentiment', () => {
      const rows = [
        {
          execution_date: '2026-03-09',
          sentiment: '',
          prompt: 'p1',
          region_code: 'US',
          topics: 't1',
        },
        {
          execution_date: '2026-03-09',
          sentiment: null,
          prompt: 'p2',
          region_code: 'US',
          topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);

      expect(result[0].totalPrompts).to.equal(2);
      expect(result[0].promptsWithSentiment).to.equal(0);
      const total = result[0].sentiment.reduce((sum, s) => sum + s.value, 0);
      expect(total).to.equal(0);
    });

    it('ensures percentages sum to 100', () => {
      const rows = [
        {
          execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-09', sentiment: 'negative', prompt: 'p2', region_code: 'US', topics: 't1',
        },
        {
          execution_date: '2026-03-09', sentiment: 'neutral', prompt: 'p3', region_code: 'US', topics: 't1',
        },
      ];
      const result = aggregateSentimentByWeek(rows);
      const total = result[0].sentiment.reduce((sum, s) => sum + s.value, 0);

      expect(total).to.equal(100);
    });
  });

  describe('createSentimentOverviewHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when query returns error', async () => {
      const queryError = { message: 'relation does not exist' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: queryError },
      );

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.calledWith(
        'Brand presence sentiment-overview PostgREST error: relation does not exist',
      );
    });

    it('returns ok with weeklyTrends for valid data', async () => {
      const execData = {
        data: [
          {
            execution_date: '2026-03-09', sentiment: 'positive', prompt: 'p1', region_code: 'US', topics: 't1',
          },
          {
            execution_date: '2026-03-10', sentiment: 'negative', prompt: 'p2', region_code: 'US', topics: 't1',
          },
        ],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(execData);

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.be.an('array');
      expect(body.weeklyTrends).to.have.lengthOf(1);
      expect(body.weeklyTrends[0]).to.have.property('sentiment');
      expect(body.weeklyTrends[0].totalPrompts).to.equal(2);
    });

    it('returns empty weeklyTrends when no data', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('handles data: null gracefully', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: null,
      });

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('returns 403 when siteId does not belong to organization', async () => {
      const execData = { data: [], error: null };
      const sitesValidation = { data: [], error: null };
      const chainMock = createChainableMock(execData, [execData, sitesValidation]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('applies optional filters (category, topic, region, origin)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        categoryId: 'Acrobat',
        topic: 'pdf editing',
        region: 'US',
        origin: 'human',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('category_name', 'Acrobat');
      expect(chainMock.eq).to.have.been.calledWith('topics', 'pdf editing');
      expect(chainMock.eq).to.have.been.calledWith('region_code', 'US');
      expect(chainMock.ilike).to.have.been.calledWith('origin', 'human');
    });

    it('filters by brandId when single brand route', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith(
        'brand_id',
        '0178a3f0-1234-7000-8000-000000000002',
      );
    });

    it('filters by category_id when categoryId is a valid UUID', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        categoryId: '0178a3f0-1234-7000-8000-000000000099',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith(
        'category_id',
        '0178a3f0-1234-7000-8000-000000000099',
      );
    });

    it('uses WEEKS_QUERY_LIMIT (200000) for the query', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.limit).to.have.been.calledWith(200000);
    });

    it('selects execution_date, sentiment, prompt, region_code, topics', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.select).to.have.been.calledWith('execution_date, sentiment, prompt, region_code, topics');
    });

    it('maps platform param to model filter', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { platform: 'gemini' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'gemini');
    });
  });

  describe('dateToIsoWeek', () => {
    it('converts a Monday to the correct ISO week', () => {
      expect(dateToIsoWeek('2026-03-09')).to.equal('2026-W11');
    });

    it('converts a Sunday (last day of a week) to the correct ISO week', () => {
      expect(dateToIsoWeek('2026-03-15')).to.equal('2026-W11');
    });

    it('converts a Thursday correctly (ISO reference day)', () => {
      expect(dateToIsoWeek('2026-01-01')).to.equal('2026-W01');
    });

    it('handles year boundary where Jan 1 belongs to prior year week 53', () => {
      // 2026-01-01 is Thursday and belongs to 2026-W01
      // 2025-12-29 is a Monday and belongs to 2026-W01 (ISO year 2026)
      expect(dateToIsoWeek('2025-12-29')).to.equal('2026-W01');
    });

    it('is inverse of getWeekDateRange startDate', () => {
      const range = getWeekDateRange('2026-W11');
      expect(dateToIsoWeek(range.startDate)).to.equal('2026-W11');
    });

    it('is inverse of getWeekDateRange endDate', () => {
      const range = getWeekDateRange('2026-W11');
      expect(dateToIsoWeek(range.endDate)).to.equal('2026-W11');
    });
  });

  describe('createMarketTrackingTrendsHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: 0178a3f0-1234-7000-8000-000000000001'));

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when brand executions query returns error', async () => {
      const queryError = { message: 'relation "brand_presence_executions" does not exist' };
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: null, error: queryError },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation "brand_presence_executions" does not exist');
      expect(mockContext.log.error).to.have.been.calledWith(
        'Market-tracking-trends brand query error: relation "brand_presence_executions" does not exist',
      );
    });

    it('returns badRequest when competitor data query returns error', async () => {
      const queryError = { message: 'relation "executions_competitor_data" does not exist' };
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: null, error: queryError },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation "executions_competitor_data" does not exist');
      expect(mockContext.log.error).to.have.been.calledWith(
        'Market-tracking-trends competitor query error: relation "executions_competitor_data" does not exist',
      );
    });

    it('returns ok with empty weeklyTrends when no data', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock();

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.deep.equal([]);
      expect(body.weeklyTrendsForComparison).to.deep.equal([]);
    });

    it('counts distinct prompts with mentions per week (deduplication)', async () => {
      const brandRows = [
        // Two rows with the same composite key in the same week — should count as 1 mention
        {
          execution_date: '2026-03-09',
          prompt: 'What is Acrobat?',
          topics: 'PDF',
          region_code: 'US',
          site_id: 'site-1',
          mentions: true,
          citations: false,
        },
        {
          execution_date: '2026-03-10',
          prompt: 'What is Acrobat?',
          topics: 'PDF',
          region_code: 'US',
          site_id: 'site-1',
          mentions: true,
          citations: false,
        },
        // Different prompt in same week — should add 1 more mention
        {
          execution_date: '2026-03-11',
          prompt: 'Best PDF tool?',
          topics: 'PDF',
          region_code: 'US',
          site_id: 'site-1',
          mentions: true,
          citations: true,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: brandRows, error: null },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.have.lengthOf(1);
      const week = body.weeklyTrends[0];
      expect(week.week).to.equal('2026-W11');
      expect(week.mentions).to.equal(2); // 2 distinct prompts with mentions
      expect(week.citations).to.equal(1); // 1 distinct prompt with citations
    });

    it('does not deduplicate across different regions or topics', async () => {
      const brandRows = [
        {
          execution_date: '2026-03-09',
          prompt: 'What is Acrobat?',
          topics: 'PDF',
          region_code: 'US',
          site_id: 'site-1',
          mentions: true,
          citations: false,
        },
        {
          execution_date: '2026-03-09',
          prompt: 'What is Acrobat?',
          topics: 'PDF',
          region_code: 'DE', // different region — different key
          site_id: 'site-1',
          mentions: true,
          citations: false,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: brandRows, error: null },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends[0].mentions).to.equal(2);
    });

    it('aggregates competitor mentions and citations per week', async () => {
      const competitorRows = [
        {
          execution_date: '2026-03-09', competitor: 'CompA', mentions: 5, citations: 2,
        },
        {
          execution_date: '2026-03-11', competitor: 'CompA', mentions: 3, citations: 1,
        },
        {
          execution_date: '2026-03-09', competitor: 'CompB', mentions: 10, citations: 4,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: competitorRows, error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.have.lengthOf(1);
      const week = body.weeklyTrends[0];
      expect(week.week).to.equal('2026-W11');

      const compA = week.competitors.find((c) => c.name === 'CompA');
      const compB = week.competitors.find((c) => c.name === 'CompB');
      expect(compA).to.deep.equal({ name: 'CompA', mentions: 8, citations: 3 });
      expect(compB).to.deep.equal({ name: 'CompB', mentions: 10, citations: 4 });
    });

    it('sorts competitors by total activity descending', async () => {
      const competitorRows = [
        {
          execution_date: '2026-03-09', competitor: 'LowActivity', mentions: 1, citations: 0,
        },
        {
          execution_date: '2026-03-09', competitor: 'HighActivity', mentions: 10, citations: 5,
        },
        {
          execution_date: '2026-03-09', competitor: 'MidActivity', mentions: 4, citations: 2,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: competitorRows, error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      const names = body.weeklyTrends[0].competitors.map((c) => c.name);
      expect(names).to.deep.equal(['HighActivity', 'MidActivity', 'LowActivity']);
    });

    it('spans multiple weeks correctly', async () => {
      const brandRows = [
        {
          execution_date: '2026-03-02',
          prompt: 'q1',
          topics: 't1',
          region_code: 'US',
          site_id: 's1',
          mentions: true,
          citations: false,
        },
        {
          execution_date: '2026-03-09',
          prompt: 'q2',
          topics: 't1',
          region_code: 'US',
          site_id: 's1',
          mentions: true,
          citations: true,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: brandRows, error: null },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends).to.have.lengthOf(2);
      expect(body.weeklyTrends[0].week).to.equal('2026-W10');
      expect(body.weeklyTrends[1].week).to.equal('2026-W11');
      expect(body.weeklyTrends[0].mentions).to.equal(1);
      expect(body.weeklyTrends[1].citations).to.equal(1);
    });

    it('weeklyTrendsForComparison mirrors weeklyTrends', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock();

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends).to.deep.equal(body.weeklyTrendsForComparison);
    });

    it('queries brand_presence_executions with correct fields', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.from).to.have.been.calledWith('brand_presence_executions');
      expect(client.select).to.have.been.calledWith(
        'execution_date, prompt, topics, region_code, site_id, mentions, citations',
      );
    });

    it('queries executions_competitor_data for competitor rows', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.from).to.have.been.calledWith('executions_competitor_data');
    });

    it('defaults model to chatgpt when not provided', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('model', 'chatgpt');
    });

    it('uses model from query param when provided', async () => {
      const client = createTableAwareMock();
      mockContext.data = { model: 'gemini' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('model', 'gemini');
    });

    it('filters by brandId when single brand route', async () => {
      const client = createTableAwareMock();
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('brand_id', '0178a3f0-1234-7000-8000-000000000002');
    });

    it('does not filter by brand_id when brandId is "all"', async () => {
      const client = createTableAwareMock();
      mockContext.params.brandId = 'all';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const brandIdCalls = client.eq.getCalls().filter((c) => c.args[0] === 'brand_id');
      expect(brandIdCalls).to.have.lengthOf(0);
    });

    it('filters by category_id when categoryId is a valid UUID', async () => {
      const client = createTableAwareMock();
      mockContext.data = { categoryId: '0178a3f0-1234-7000-8000-000000000099' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('category_id', '0178a3f0-1234-7000-8000-000000000099');
    });

    it('filters by category_name when categoryId is not a UUID', async () => {
      const client = createTableAwareMock();
      mockContext.data = { categoryId: 'Acrobat' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('category_name', 'Acrobat');
    });

    it('filters by region_code when region is provided', async () => {
      const client = createTableAwareMock();
      mockContext.data = { region: 'US' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('region_code', 'US');
    });

    it('does not filter by topic or origin (comparison filters stripped)', async () => {
      const client = createTableAwareMock();
      mockContext.data = { topic: 'PDF editing', origin: 'ai' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const topicCalls = client.eq.getCalls().filter((c) => c.args[0] === 'topic' || c.args[0] === 'topics');
      const originCalls = client.eq.getCalls().filter((c) => c.args[0] === 'origin');
      expect(topicCalls).to.have.lengthOf(0);
      expect(originCalls).to.have.lengthOf(0);
    });

    it('returns 403 when siteId does not belong to the organization', async () => {
      const client = createTableAwareMock({
        sites: { data: [], error: null },
      });
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Site does not belong to the organization');
    });

    it('applies site_id filter on both queries when siteId belongs to org', async () => {
      const siteId = 'cccdac43-1a22-4659-9086-b762f59b9928';
      const client = createTableAwareMock({
        sites: { data: [{ id: siteId }], error: null },
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: [], error: null },
      });
      mockContext.data = { siteId };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const siteIdCalls = client.eq.getCalls().filter((c) => c.args[0] === 'site_id' && c.args[1] === siteId);
      // site_id filter applied to brand query AND competitor query (2 calls)
      expect(siteIdCalls).to.have.lengthOf.at.least(2);
    });

    it('accepts snake_case params (start_date, end_date, region_code)', async () => {
      const client = createTableAwareMock();
      mockContext.data = {
        start_date: '2026-03-01',
        end_date: '2026-03-15',
        model: 'gemini',
        region_code: 'DE',
      };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(client.eq).to.have.been.calledWith('model', 'gemini');
      expect(client.eq).to.have.been.calledWith('region_code', 'DE');
    });

    it('handles null context.data gracefully', async () => {
      const client = createTableAwareMock();
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
    });

    it('handles null data from both queries (uses empty array fallback)', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: null, error: null },
        executions_competitor_data: { data: null, error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('skips competitor rows where competitor field is null or missing', async () => {
      const competitorRows = [
        {
          execution_date: '2026-03-09', competitor: null, mentions: 5, citations: 2,
        },
        {
          execution_date: '2026-03-09', competitor: 'ValidComp', mentions: 3, citations: 1,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: competitorRows, error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends[0].competitors).to.have.lengthOf(1);
      expect(body.weeklyTrends[0].competitors[0].name).to.equal('ValidComp');
    });

    it('treats null mentions/citations on competitor rows as 0', async () => {
      const competitorRows = [
        {
          execution_date: '2026-03-09', competitor: 'CompA', mentions: null, citations: null,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: competitorRows, error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends[0].competitors[0]).to.deep.equal({
        name: 'CompA', mentions: 0, citations: 0,
      });
    });

    it('handles mentions as string "true" (coercion from PostgREST text column)', async () => {
      const brandRows = [
        {
          execution_date: '2026-03-09',
          prompt: 'q1',
          topics: 't1',
          region_code: 'US',
          site_id: 's1',
          mentions: 'true',
          citations: 'false',
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: brandRows, error: null },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends[0].mentions).to.equal(1);
      expect(body.weeklyTrends[0].citations).to.equal(0);
    });

    it('skips brand rows where execution_date is null', async () => {
      const brandRows = [
        // Row with null execution_date — should be skipped entirely
        {
          execution_date: null,
          prompt: 'q1',
          topics: 't1',
          region_code: 'US',
          site_id: 's1',
          mentions: true,
          citations: true,
        },
        // Valid row that should be counted
        {
          execution_date: '2026-03-09',
          prompt: 'q2',
          topics: 't1',
          region_code: 'US',
          site_id: 's1',
          mentions: true,
          citations: false,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: brandRows, error: null },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends).to.have.lengthOf(1);
      expect(body.weeklyTrends[0].mentions).to.equal(1);
    });

    it('deduplicates using empty-string fallbacks for null prompt/topics/region/site fields', async () => {
      const brandRows = [
        // Both rows have null prompt/topics/region_code/site_id — same dedup key => count as 1
        {
          execution_date: '2026-03-09',
          prompt: null,
          topics: null,
          region_code: null,
          site_id: null,
          mentions: true,
          citations: true,
        },
        {
          execution_date: '2026-03-10',
          prompt: null,
          topics: null,
          region_code: null,
          site_id: null,
          mentions: true,
          citations: true,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: brandRows, error: null },
        executions_competitor_data: { data: [], error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends[0].mentions).to.equal(1);
      expect(body.weeklyTrends[0].citations).to.equal(1);
    });

    it('produces weekNumber 0 and year 0 when competitor execution_date yields an invalid ISO week', async () => {
      // An invalid date string passes the !execution_date check (it is truthy) but
      // dateToIsoWeek produces 'NaN-WNaN', causing parseIsoWeek to return {weekNumber:0, year:0}
      const competitorRows = [
        {
          execution_date: 'invalid-date', competitor: 'CompA', mentions: 5, citations: 2,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        executions_competitor_data: { data: competitorRows, error: null },
      });

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.weeklyTrends).to.have.lengthOf(1);
      expect(body.weeklyTrends[0].weekNumber).to.equal(0);
      expect(body.weeklyTrends[0].year).to.equal(0);
    });
  });

  // ── volumeToPopularity ─────────────────────────────────────────────────────

  describe('volumeToPopularity', () => {
    it('returns Low for null, undefined, and 0', () => {
      expect(volumeToPopularity(null, 100)).to.equal('Low');
      expect(volumeToPopularity(undefined, 100)).to.equal('Low');
      expect(volumeToPopularity(0, 100)).to.equal('Low');
    });

    it('maps imputed negative sentinel values', () => {
      expect(volumeToPopularity(-30, 0)).to.equal('High');
      expect(volumeToPopularity(-20, 0)).to.equal('Medium');
      expect(volumeToPopularity(-10, 0)).to.equal('Low');
    });

    it('uses legacy percentile bucketing for positive values', () => {
      expect(volumeToPopularity(10, 100)).to.equal('Low');
      expect(volumeToPopularity(50, 100)).to.equal('Medium');
      expect(volumeToPopularity(80, 100)).to.equal('High');
    });

    it('returns Low for positive volume when avgPositiveVolume is 0', () => {
      expect(volumeToPopularity(50, 0)).to.equal('Low');
    });
  });

  // ── aggregateShareOfVoice ──────────────────────────────────────────────────

  describe('aggregateShareOfVoice', () => {
    it('returns empty array for no rows', () => {
      expect(aggregateShareOfVoice([], new Set(), 'BrandX')).to.deep.equal([]);
    });

    it('groups by topic, counts brand mentions and competitors', () => {
      const rows = [
        {
          topic: 'EVs',
          brand_mentions: 2,
          competitor_name: 'Tesla',
          competitor_mentions: 2,
          volume: -30,
        },
        {
          topic: 'EVs',
          brand_mentions: 2,
          competitor_name: 'Ford',
          competitor_mentions: 2,
          volume: -30,
        },
        {
          topic: 'SUVs',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -20,
        },
      ];
      const configured = new Set(['tesla']);
      const result = aggregateShareOfVoice(rows, configured, 'BrandX');

      expect(result).to.have.lengthOf(2);

      const evs = result.find((r) => r.topic === 'EVs');
      expect(evs.brandMentions).to.equal(2);
      expect(evs.popularity).to.equal('High');
      expect(evs.ranking).to.be.a('number');
      expect(evs.topCompetitors).to.be.an('array');
      expect(evs.allCompetitors).to.be.an('array');

      const tesla = evs.allCompetitors.find((c) => c.name === 'tesla');
      expect(tesla.source).to.equal('configured');
      const ford = evs.allCompetitors.find((c) => c.name === 'ford');
      expect(ford.source).to.equal('detected');

      const suvs = result.find((r) => r.topic === 'SUVs');
      expect(suvs.brandMentions).to.equal(1);
      expect(suvs.popularity).to.equal('Medium');
    });

    it('sets shareOfVoice to null when brand has no mentions', () => {
      const rows = [
        {
          topic: 'Topic1',
          brand_mentions: 0,
          competitor_name: 'CompA',
          competitor_mentions: 3,
          volume: -10,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'BrandX');
      expect(result[0].shareOfVoice).to.equal(null);
      expect(result[0].ranking).to.equal(null);
    });

    it('sorts by popularity desc then shareOfVoice desc', () => {
      const rows = [
        {
          topic: 'LowTopic',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -10,
        },
        {
          topic: 'HighTopic',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -30,
        },
        {
          topic: 'MedTopic',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -20,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'BrandX');
      expect(result[0].topic).to.equal('HighTopic');
      expect(result[1].topic).to.equal('MedTopic');
      expect(result[2].topic).to.equal('LowTopic');
    });

    it('limits topCompetitors to 5 entries', () => {
      const rows = Array.from({ length: 8 }, (_, i) => ({
        topic: 'T', brand_mentions: 1, competitor_name: `Comp${i}`, competitor_mentions: 10 - i, volume: -30,
      }));
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result[0].topCompetitors.length).to.be.at.most(5);
      expect(result[0].allCompetitors.length).to.equal(8);
    });

    it('includes brandShareOfVoice when brand has mentions', () => {
      const rows = [
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: 'Comp1',
          competitor_mentions: 2,
          volume: -20,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'MyBrand');
      expect(result[0].brandShareOfVoice).to.deep.include({ name: 'MyBrand', mentions: 1 });
    });

    it('handles Unknown topic for rows without topic field', () => {
      const rows = [
        {
          topic: null,
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -10,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result[0].topic).to.equal('Unknown');
    });

    it('accumulates mentions when same competitor appears in multiple rows', () => {
      const rows = [
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: 'Tesla',
          competitor_mentions: 3,
          volume: -30,
        },
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: 'Tesla',
          competitor_mentions: 2,
          volume: -30,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      const tesla = result[0].allCompetitors.find((c) => c.name === 'tesla');
      expect(tesla.mentions).to.equal(5);
    });

    it('handles positive volume for percentile-based popularity', () => {
      const rows = [
        {
          topic: 'HighVol',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: 900,
        },
        {
          topic: 'LowVol',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: 100,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result).to.have.lengthOf(2);
      const highVol = result.find((r) => r.topic === 'HighVol');
      const lowVol = result.find((r) => r.topic === 'LowVol');
      expect(highVol.popularity).to.equal('High');
      expect(lowVol.popularity).to.equal('Low');
    });

    it('returns 0 sov for competitors when totalMentions is 0', () => {
      const rows = [
        {
          topic: 'Empty',
          brand_mentions: 0,
          competitor_name: 'CompX',
          competitor_mentions: 0,
          volume: -10,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result[0].allCompetitors[0].shareOfVoice).to.equal(0);
    });

    it('falls back to "Our Brand" when brandName is falsy', () => {
      const rows = [
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -20,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), '');
      expect(result[0].brandShareOfVoice.name).to.equal('Our Brand');
    });

    it('sorts brand after competitor when they share the same sov', () => {
      const rows = [
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: 'CompA',
          competitor_mentions: 1,
          volume: -30,
        },
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: 'CompB',
          competitor_mentions: 1,
          volume: -30,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      const entities = [
        ...result[0].allCompetitors,
        result[0].brandShareOfVoice,
      ].filter(Boolean);
      expect(entities).to.have.lengthOf(3);
      expect(result[0].ranking).to.equal(1);
    });

    it('sorts topics with same popularity by shareOfVoice desc', () => {
      const rows = [
        {
          topic: 'LowSov',
          brand_mentions: 1,
          competitor_name: 'C',
          competitor_mentions: 10,
          volume: -30,
        },
        {
          topic: 'HighSov',
          brand_mentions: 10,
          competitor_name: 'C',
          competitor_mentions: 1,
          volume: -30,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result[0].topic).to.equal('HighSov');
      expect(result[1].topic).to.equal('LowSov');
    });

    it('sorts by shareOfVoice when popularity matches and sov is null', () => {
      const rows = [
        {
          topic: 'A',
          brand_mentions: 0,
          competitor_name: 'C1',
          competitor_mentions: 5,
          volume: -30,
        },
        {
          topic: 'B',
          brand_mentions: 0,
          competitor_name: 'C2',
          competitor_mentions: 3,
          volume: -30,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result[0].shareOfVoice).to.equal(null);
      expect(result[1].shareOfVoice).to.equal(null);
    });

    it('sorts Low-popularity topics after High-popularity ones', () => {
      const rows = [
        {
          topic: 'Normal',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -30,
        },
        {
          topic: 'NoVol',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: 0,
        },
      ];
      const result = aggregateShareOfVoice(rows, new Set(), 'Brand');
      expect(result[0].topic).to.equal('Normal');
      expect(result[1].topic).to.equal('NoVol');
      expect(result[1].popularity).to.equal('Low');
    });
  });

  // ── createShareOfVoiceHandler ──────────────────────────────────────────────

  describe('createShareOfVoiceHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = mockClient;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: 0178a3f0-1234-7000-8000-000000000001'));

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when RPC returns error', async () => {
      const rpcError = { message: 'function rpc_share_of_voice does not exist' };
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: null, error: rpcError } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns share-of-voice data for valid request', async () => {
      const rpcRows = [
        {
          topic: 'EVs',
          brand_mentions: 1,
          competitor_name: 'Tesla',
          competitor_mentions: 2,
          volume: -30,
        },
        {
          topic: 'EVs',
          brand_mentions: 1,
          competitor_name: 'Tesla Motors',
          competitor_mentions: 1,
          volume: -30,
        },
        {
          topic: 'EVs',
          brand_mentions: 1,
          competitor_name: 'Ford',
          competitor_mentions: 1,
          volume: -30,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          competitors: {
            data: [{ name: 'Tesla', aliases: ['tesla motors', 'tsla'] }],
            error: null,
          },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: rpcRows, error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.shareOfVoiceData).to.be.an('array').with.lengthOf(1);
      const evs = body.shareOfVoiceData[0];
      expect(evs.topic).to.equal('EVs');
      expect(evs.brandMentions).to.equal(1);
      expect(evs.popularity).to.equal('High');
      expect(evs.topCompetitors).to.be.an('array');

      const teslaMotors = evs.allCompetitors
        .find((c) => c.name === 'tesla motors');
      expect(teslaMotors).to.exist;
      expect(teslaMotors.source).to.equal('configured');
    });

    it('returns empty shareOfVoiceData when RPC returns no rows', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: [], error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.shareOfVoiceData).to.deep.equal([]);
    });

    it('resolves brand name when brandId is specified', async () => {
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000099';
      const rpcRows = [
        {
          topic: 'T1',
          brand_mentions: 1,
          competitor_name: null,
          competitor_mentions: 0,
          volume: -20,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          competitors: { data: [], error: null },
          brands: { data: [{ name: 'Chevrolet' }], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: rpcRows, error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.shareOfVoiceData[0].brandShareOfVoice.name).to.equal('Chevrolet');
    });

    it('returns forbidden when siteId does not belong to org', async () => {
      mockContext.data = { siteId: '0178a3f0-1234-7000-8000-000000000055' };
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          sites: { data: [], error: null },
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: [], error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('passes filter params to RPC when provided', async () => {
      const siteId = 'cccdac43-1a22-4659-9086-b762f59b9928';
      mockContext.data = {
        siteId,
        categoryId: '0178a3f0-1234-7000-8000-000000000099',
        topicIds: '0178a3f0-aaaa-7000-8000-000000000001',
        origin: 'ai',
        regionCode: 'US',
      };
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          sites: {
            data: [{ id: siteId }],
            error: null,
          },
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: [], error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
    });

    it('returns empty configured names when competitors query errors', async () => {
      const rpcRows = [
        {
          topic: 'T',
          brand_mentions: 1,
          competitor_name: 'SomeComp',
          competitor_mentions: 2,
          volume: -20,
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          competitors: { data: null, error: { message: 'query failed' } },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: rpcRows, error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      const comp = body.shareOfVoiceData[0].allCompetitors[0];
      expect(comp.source).to.equal('detected');
    });

    it('passes default p_max_competitors=5 to RPC', async () => {
      const mock = createTableAwareMock(
        {
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: [], error: null } },
      );
      mockContext.dataAccess.Site.postgrestService = mock;

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(mock.rpc).to.have.been.calledWith(
        'rpc_share_of_voice',
        sinon.match({ p_max_competitors: 5 }),
      );
    });

    it('passes custom maxCompetitors to RPC when provided', async () => {
      mockContext.data = { maxCompetitors: '50' };
      const mock = createTableAwareMock(
        {
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: [], error: null } },
      );
      mockContext.dataAccess.Site.postgrestService = mock;

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(mock.rpc).to.have.been.calledWith(
        'rpc_share_of_voice',
        sinon.match({ p_max_competitors: 50 }),
      );
    });

    it('handles null RPC data gracefully', async () => {
      mockContext.dataAccess.Site.postgrestService = createTableAwareMock(
        {
          competitors: { data: [], error: null },
          brands: { data: [], error: null },
        },
        { data: [], error: null },
        { rpc_share_of_voice: { data: null, error: null } },
      );

      const handler = createShareOfVoiceHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.shareOfVoiceData).to.deep.equal([]);
    });
  });
});
