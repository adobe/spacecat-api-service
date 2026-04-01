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
  addDaysToDate,
  aggregateDetailSources,
  aggregateSentimentByWeek,
  aggregateTopicData,
  aggregateWeeklyDetailStats,
  buildPromptDetails,
  aggregateShareOfVoice,
  buildPromptKey,
  buildTopicPromptKey,
  createBrandPresenceStatsHandler,
  createBrandPresenceWeeksHandler,
  createFilterDimensionsHandler,
  normalizeFilterDimensionsStatsFromRpc,
  createPromptDetailHandler,
  createSentimentOverviewHandler,
  createMarketTrackingTrendsHandler,
  createTopicDetailHandler,
  createTopicsHandler,
  createTopicPromptsHandler,
  createSearchHandler,
  buildSearchPattern,
  createSentimentMoversHandler,
  createShareOfVoiceHandler,
  dateToIsoWeek,
  getWeekDateRange,
  resolveSiteIds,
  splitDateRangeIntoWeeksBackward,
  strCompare,
  toFilterOption,
  toISOWeek,
  validateModel,
  validateSiteBelongsToOrg,
  volumeToPopularity,
  resolveModelFromRequest,
} from '../../../src/controllers/llmo/llmo-brand-presence.js';

use(sinonChai);

function createChainableMock(
  resolveValue = { data: [], error: null },
  resolveSequence = null,
  rpcResolveValue = null,
) {
  const limitStub = resolveSequence
    ? sinon.stub()
      .onFirstCall()
      .resolves(resolveSequence[0] ?? resolveValue)
      .onSecondCall()
      .resolves(resolveSequence[1] ?? { data: [], error: null })
      .onThirdCall()
      .resolves(resolveSequence[2] ?? { data: [], error: null })
    : sinon.stub().resolves(resolveValue);
  const defaultFilterDimsRpc = {
    data: {
      brands: [],
      categories: [],
      topics: [],
      origins: [],
      regions: [],
      stats: {
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      },
    },
    error: null,
  };
  const rpcStub = sinon.stub().resolves(rpcResolveValue ?? defaultFilterDimsRpc);
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
    rpc: rpcStub,
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

/**
 * Creates a mock PostgREST client with rpc() and from() for Brand Presence Stats API.
 * rpcStub can be configured to return different values per call (e.g. main stats + weekly trends).
 * from() is needed for validateSiteBelongsToOrg when siteId is provided.
 */
const defaultStatsRpcData = {
  data: [
    {
      total_executions: 0,
      average_visibility_score: 0,
      total_mentions: 0,
      total_citations: 0,
    },
  ],
  error: null,
};
function createStatsRpcMock(
  rpcResolveValue = defaultStatsRpcData,
  rpcSequence = null,
) {
  const rpcStub = rpcSequence
    ? sinon.stub()
      .onFirstCall()
      .resolves(rpcSequence[0] ?? rpcResolveValue)
      .onSecondCall()
      .resolves(rpcSequence[1] ?? rpcResolveValue)
      .onThirdCall()
      .resolves(rpcSequence[2] ?? rpcResolveValue)
      .onCall(3)
      .resolves(rpcSequence[3] ?? rpcResolveValue)
      .onCall(4)
      .resolves(rpcSequence[4] ?? rpcResolveValue)
      .onCall(5)
      .resolves(rpcSequence[5] ?? rpcResolveValue)
      .onCall(6)
      .resolves(rpcSequence[6] ?? rpcResolveValue)
      .onCall(7)
      .resolves(rpcSequence[7] ?? rpcResolveValue)
      .onCall(8)
      .resolves(rpcSequence[8] ?? rpcResolveValue)
    : sinon.stub().resolves(rpcResolveValue);
  const sitesChain = {
    from: sinon.stub().returnsThis(),
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    limit: sinon.stub().resolves({ data: [{ id: 'x' }], error: null }),
  };
  const fromStub = sinon.stub().returns(sitesChain);
  return { rpc: rpcStub, from: fromStub };
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

  describe('resolveModelFromRequest / validateModel', () => {
    it('defaults missing or empty model to chatgpt-free', () => {
      expect(resolveModelFromRequest(undefined)).to.equal('chatgpt-free');
      expect(resolveModelFromRequest(null)).to.equal('chatgpt-free');
      expect(resolveModelFromRequest('')).to.equal('chatgpt-free');
    });

    it('maps query aliases case-insensitively', () => {
      expect(resolveModelFromRequest('all')).to.equal('chatgpt-paid');
      expect(resolveModelFromRequest('ALL')).to.equal('chatgpt-paid');
      expect(resolveModelFromRequest('chatgpt')).to.equal('chatgpt-free');
      expect(resolveModelFromRequest('ChatGPT')).to.equal('chatgpt-free');
    });

    it('passes through canonical enum values and trims whitespace', () => {
      expect(resolveModelFromRequest('gemini')).to.equal('gemini');
      expect(resolveModelFromRequest('  gemini  ')).to.equal('gemini');
      expect(resolveModelFromRequest('chatgpt-paid')).to.equal('chatgpt-paid');
    });

    it('validateModel accepts defaults, aliases, and enum values', () => {
      expect(validateModel(undefined)).to.deep.equal({ valid: true, model: 'chatgpt-free' });
      expect(validateModel('all')).to.deep.equal({ valid: true, model: 'chatgpt-paid' });
      expect(validateModel('gemini')).to.deep.equal({ valid: true, model: 'gemini' });
    });

    it('validateModel rejects unknown models with error message', () => {
      const r = validateModel('openai');
      expect(r.valid).to.equal(false);
      expect(r.error).to.include('Invalid model');
      expect(r.error).to.include('chatgpt-free');
    });
  });

  describe('addDaysToDate', () => {
    it('adds positive days', () => {
      expect(addDaysToDate('2025-01-15', 7)).to.equal('2025-01-22');
      expect(addDaysToDate('2025-01-31', 1)).to.equal('2025-02-01');
    });

    it('subtracts days with negative argument', () => {
      expect(addDaysToDate('2025-01-15', -7)).to.equal('2025-01-08');
      expect(addDaysToDate('2025-01-21', -6)).to.equal('2025-01-15');
    });

    it('handles zero', () => {
      expect(addDaysToDate('2025-01-15', 0)).to.equal('2025-01-15');
    });
  });

  describe('splitDateRangeIntoWeeksBackward', () => {
    it('returns single week when range is 7 days', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2025-01-15', '2025-01-21');
      expect(weeks).to.have.lengthOf(1);
      expect(weeks[0]).to.deep.equal({ startDate: '2025-01-15', endDate: '2025-01-21' });
    });

    it('returns weeks in chronological order (oldest first) before slice', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2025-01-01', '2025-01-21');
      expect(weeks).to.have.lengthOf(3);
      expect(weeks[0]).to.deep.equal({ startDate: '2025-01-01', endDate: '2025-01-07' });
      expect(weeks[1]).to.deep.equal({ startDate: '2025-01-08', endDate: '2025-01-14' });
      expect(weeks[2]).to.deep.equal({ startDate: '2025-01-15', endDate: '2025-01-21' });
    });

    it('limits to 8 weeks when range spans more', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2025-01-01', '2025-03-19');
      expect(weeks).to.have.lengthOf(8);
      expect(weeks[0].startDate).to.equal('2025-01-23');
      expect(weeks[0].endDate).to.equal('2025-01-29');
      expect(weeks[7].endDate).to.equal('2025-03-19');
    });

    it('handles partial first week when startDate is mid-week', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2025-01-03', '2025-01-21');
      expect(weeks).to.have.lengthOf(3);
      expect(weeks[0]).to.deep.equal({ startDate: '2025-01-03', endDate: '2025-01-07' });
    });

    it('returns empty array when endDate is before startDate', () => {
      const weeks = splitDateRangeIntoWeeksBackward('2025-01-21', '2025-01-15');
      expect(weeks).to.deep.equal([]);
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

  describe('normalizeFilterDimensionsStatsFromRpc', () => {
    it('returns zeros when stats is missing from RPC body', () => {
      expect(normalizeFilterDimensionsStatsFromRpc({ brands: [] })).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('returns zeros when dims is null or undefined', () => {
      expect(normalizeFilterDimensionsStatsFromRpc(null)).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
      expect(normalizeFilterDimensionsStatsFromRpc(undefined)).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('treats stats: null as absent', () => {
      expect(normalizeFilterDimensionsStatsFromRpc({ stats: null })).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('treats stats as array as absent', () => {
      expect(normalizeFilterDimensionsStatsFromRpc({ stats: [] })).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('defaults missing stat fields to zero', () => {
      expect(normalizeFilterDimensionsStatsFromRpc({
        stats: { total_execution_count: 5 },
      })).to.deep.equal({
        total_execution_count: 5,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('passes through valid stats numbers', () => {
      expect(normalizeFilterDimensionsStatsFromRpc({
        stats: {
          total_execution_count: 1200,
          distinct_prompt_count: 80,
          empty_answer_execution_count: 12,
        },
      })).to.deep.equal({
        total_execution_count: 1200,
        distinct_prompt_count: 80,
        empty_answer_execution_count: 12,
      });
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

    it('returns badRequest when filter-dimensions RPC returns error', async () => {
      const queryError = { message: 'function rpc_brand_presence_filter_dimensions does not exist' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        null,
        { data: null, error: queryError },
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('function rpc_brand_presence_filter_dimensions does not exist');
      expect(mockContext.log.error).to.have.been.calledWith(
        'Brand presence filter-dimensions PostgREST error: function rpc_brand_presence_filter_dimensions does not exist',
      );
    });

    it('does not reject unknown model string (uses resolveModelFromRequest like other BP handlers)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;
      mockContext.data = { model: 'openai' };

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.deep.equal([]);
      expect(body.stats).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_model', 'openai'),
      );
    });

    it('maps model query aliases for filter-dimensions (all → paid, chatgpt → free)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);

      mockContext.data = { model: 'ALL' };
      await handler(mockContext);
      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_model', 'chatgpt-paid'),
      );

      chainMock.rpc.resetHistory();
      mockContext.data = { model: 'ChatGPT' };
      await handler(mockContext);
      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_model', 'chatgpt-free'),
      );
    });

    it('handles RPC returning data: null (uses empty dimension fallbacks)', async () => {
      const emptyPageIntents = { data: [], error: null };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        [emptyPageIntents],
        { data: null, error: null },
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.deep.equal([]);
      expect(body.categories).to.deep.equal([]);
      expect(body.page_intents).to.deep.equal([]);
      expect(body.stats).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('defaults stats to zero when RPC omits stats key (older function version)', async () => {
      const rpcDims = {
        brands: [{ id: '0178a3f0-1234-7000-8000-000000000002', label: 'Only Brand' }],
        categories: [],
        topics: [],
        origins: [],
        regions: [],
      };
      const pageIntentsData = { data: [], error: null };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        [pageIntentsData],
        { data: rpcDims, error: null },
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brands).to.have.lengthOf(1);
      expect(body.stats).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('skips filter when categoryId is "all" (SKIP_VALUES)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: 'all' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const rpcPayload = chainMock.rpc.firstCall.args[1];
      expect(rpcPayload.p_category_id).to.be.undefined;
      expect(rpcPayload.p_category_name).to.be.undefined;
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
      const sitesValidation = { data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }], error: null };
      const pageIntentsData = { data: [], error: null };
      const chainMock = createChainableMock(
        { data: [], error: null },
        [sitesValidation, pageIntentsData],
      );
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

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match({
          p_start_date: '2025-01-01',
          p_end_date: '2025-01-31',
          p_model: 'gemini',
          p_site_id: 'cccdac43-1a22-4659-9086-b762f59b9928',
          p_category_id: '0178a3f0-1234-7000-8000-000000000099',
          p_topic_ids: ['0178a3f0-1234-7000-8000-0000000000aa'],
          p_region_code: 'US',
        }),
      );
      expect(chainMock.limit).to.have.been.calledWith(5000);
    });

    it('returns ok with brands, categories, topics, origins, regions, stats, page_intents', async () => {
      const topicId1 = '0178a3f0-1234-7000-8000-0000000000a1';
      const topicId2 = '0178a3f0-1234-7000-8000-0000000000a2';
      const rpcDims = {
        brands: [
          { id: '0178a3f0-1234-7000-8000-000000000002', label: 'Brand A' },
          { id: '0178a3f0-1234-7000-8000-000000000003', label: 'Brand B' },
        ],
        categories: [
          { id: 'Cat1', label: 'Cat1' },
          { id: 'Cat2', label: 'Cat2' },
        ],
        topics: [
          { id: topicId1, label: 't1' },
          { id: topicId2, label: 't2' },
        ],
        origins: [
          { id: 'human', label: 'human' },
          { id: 'ai', label: 'ai' },
        ],
        regions: [
          { id: 'US', label: 'US' },
          { id: 'DE', label: 'DE' },
        ],
        stats: {
          total_execution_count: 1200,
          distinct_prompt_count: 80,
          empty_answer_execution_count: 12,
        },
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }, { page_intent: 'INFORMATIONAL' }],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        [pageIntentsData],
        { data: rpcDims, error: null },
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
      expect(body.stats).to.deep.equal({
        total_execution_count: 1200,
        distinct_prompt_count: 80,
        empty_answer_execution_count: 12,
      });
    });

    it('uses topic_id as label when RPC returns id and label from DB (null topic name)', async () => {
      const topicIdNoLabel = '0178a3f0-1234-7000-8000-0000000000ff';
      const rpcDims = {
        brands: [],
        categories: [],
        topics: [{ id: topicIdNoLabel, label: topicIdNoLabel }],
        origins: [],
        regions: [],
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }],
        error: null,
      };
      mockContext.dataAccess.Site.postgrestService = createChainableMock(
        { data: [], error: null },
        [pageIntentsData],
        { data: rpcDims, error: null },
      );

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topics).to.have.lengthOf(1);
      expect(body.topics[0]).to.deep.include({ id: topicIdNoLabel, label: topicIdNoLabel });
      expect(body.stats).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it('filters by brandId when single brand route', async () => {
      const siteIdRows = {
        data: [{ site_id: 'cccdac43-1a22-4659-9086-b762f59b9928' }],
        error: null,
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }],
        error: null,
      };
      const chainMock = createChainableMock(
        { data: [], error: null },
        [siteIdRows, pageIntentsData],
      );
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_brand_id', '0178a3f0-1234-7000-8000-000000000002'),
      );
    });

    it('filters by category_id when categoryId is a valid UUID', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: '0178a3f0-1234-7000-8000-000000000099' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_category_id', '0178a3f0-1234-7000-8000-000000000099'),
      );
    });

    it('filters by category_name when categoryId is not a UUID (e.g. Acrobat)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { categoryId: 'Acrobat' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_category_name', 'Acrobat'),
      );
    });

    it('filters by topicIds (single UUID) when provided', async () => {
      const topicUuid = '0178a3f0-1234-7000-8000-0000000000aa';
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: topicUuid };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_topic_ids', [topicUuid]),
      );
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

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_topic_ids', topicUuids),
      );
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

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_topic_ids', topicUuids),
      );
    });

    it('ignores non-UUID topicIds values', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: 'combine pdf' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const rpcPayload = chainMock.rpc.firstCall.args[1];
      expect(rpcPayload.p_topic_ids).to.be.undefined;
    });

    it('does not apply topic filter when topicIds is non-string, non-array value that fails UUID validation', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: 12345 };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const rpcPayload = chainMock.rpc.firstCall.args[1];
      expect(rpcPayload.p_topic_ids).to.be.undefined;
    });

    it('filters by regionCode when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { regionCode: 'US' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_region_code', 'US'),
      );
    });

    it('filters by origin when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { origin: 'ai' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_origin', 'ai'),
      );
    });

    it('includes page_intents from page_intents table when siteId is provided', async () => {
      const sitesValidation = {
        data: [{ id: 'cccdac43-1a22-4659-9086-b762f59b9928' }],
        error: null,
      };
      const pageIntentsData = {
        data: [{ page_intent: 'TRANSACTIONAL' }, { page_intent: 'INFORMATIONAL' }],
        error: null,
      };
      const chainMock = createChainableMock(
        { data: [], error: null },
        [sitesValidation, pageIntentsData],
      );
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.page_intents).to.have.lengthOf(2);
      expect(body.stats).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
      expect(chainMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_filter_dimensions',
        sinon.match.has('p_site_id', 'cccdac43-1a22-4659-9086-b762f59b9928'),
      );
    });

    it('returns 403 when siteId does not belong to the organization', async () => {
      const sitesValidation = { data: [], error: null };
      const chainMock = createChainableMock({ data: [], error: null }, [sitesValidation]);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Site does not belong to the organization');
      expect(chainMock.rpc).not.to.have.been.called;
    });

    it('returns normalized origins from RPC (ids human and ai)', async () => {
      const rpcDims = {
        brands: [],
        categories: [],
        topics: [],
        origins: [
          { id: 'human', label: 'Human' },
          { id: 'ai', label: 'ai' },
        ],
        regions: [],
      };
      const pageIntentsData = { data: [{ page_intent: 'TRANSACTIONAL' }], error: null };
      const chainMock = createChainableMock(
        { data: [], error: null },
        [pageIntentsData],
        { data: rpcDims, error: null },
      );
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.origins).to.have.lengthOf(2);
      const originIds = body.origins.map((o) => o.id).sort();
      expect(originIds).to.deep.equal(['ai', 'human']);
      expect(body.stats).to.deep.equal({
        total_execution_count: 0,
        distinct_prompt_count: 0,
        empty_answer_execution_count: 0,
      });
    });

    it(
      'applies regionCode and origin on executions site-id query when brand scope without siteId',
      async () => {
        const siteIdRows = {
          data: [{ site_id: 'cccdac43-1a22-4659-9086-b762f59b9928' }],
          error: null,
        };
        const pageIntentsData = {
          data: [{ page_intent: 'TRANSACTIONAL' }],
          error: null,
        };
        const chainMock = createChainableMock(
          { data: [], error: null },
          [siteIdRows, pageIntentsData],
        );
        mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
        mockContext.data = { regionCode: 'US', origin: 'ai' };
        mockContext.dataAccess.Site.postgrestService = chainMock;

        const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
        const result = await handler(mockContext);

        expect(result.status).to.equal(200);
        expect(chainMock.eq).to.have.been.calledWith('region_code', 'US');
        expect(chainMock.ilike).to.have.been.calledWith('origin', 'ai');
      },
    );

    it(
      'applies category_id and topicIds on executions site-id query when brand scope without siteId',
      async () => {
        const siteIdRows = {
          data: [{ site_id: 'cccdac43-1a22-4659-9086-b762f59b9928' }],
          error: null,
        };
        const pageIntentsData = {
          data: [{ page_intent: 'TRANSACTIONAL' }],
          error: null,
        };
        const chainMock = createChainableMock(
          { data: [], error: null },
          [siteIdRows, pageIntentsData],
        );
        const catUuid = '0178a3f0-1234-7000-8000-000000000099';
        const topicUuid = '0178a3f0-1234-7000-8000-0000000000aa';
        mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
        mockContext.data = {
          categoryId: catUuid,
          topicIds: [topicUuid],
        };
        mockContext.dataAccess.Site.postgrestService = chainMock;

        const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
        const result = await handler(mockContext);

        expect(result.status).to.equal(200);
        expect(chainMock.eq).to.have.been.calledWith('category_id', catUuid);
        expect(chainMock.in).to.have.been.calledWith('topic_id', [topicUuid]);
      },
    );

    it(
      'applies category_name on executions site-id query when brand scope without siteId',
      async () => {
        const siteIdRows = {
          data: [{ site_id: 'cccdac43-1a22-4659-9086-b762f59b9928' }],
          error: null,
        };
        const pageIntentsData = {
          data: [{ page_intent: 'TRANSACTIONAL' }],
          error: null,
        };
        const chainMock = createChainableMock(
          { data: [], error: null },
          [siteIdRows, pageIntentsData],
        );
        mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
        mockContext.data = { categoryId: 'Acrobat' };
        mockContext.dataAccess.Site.postgrestService = chainMock;

        const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
        const result = await handler(mockContext);

        expect(result.status).to.equal(200);
        expect(chainMock.eq).to.have.been.calledWith('category_name', 'Acrobat');
      },
    );
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

    it('defaults model to chatgpt-free when not provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'chatgpt-free');
    });

    it('uses model from query param when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { model: 'gemini' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'gemini');
    });

    it('maps model query alias "all" to chatgpt-paid', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { model: 'all' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'chatgpt-paid');
    });

    it('maps legacy model query "chatgpt" to chatgpt-free', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { model: 'chatgpt' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('model', 'chatgpt-free');
    });

    it('does not reject unknown model string (uses resolveModelFromRequest like other BP handlers)', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;
      mockContext.data = { model: 'invalid-model' };

      const handler = createBrandPresenceWeeksHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.weeks).to.deep.equal([]);
      expect(chainMock.eq).to.have.been.calledWith('model', 'invalid-model');
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

    it('applies optional filters (category, topicIds, region, origin)', async () => {
      const topicUuid = '0178a3f0-1234-7000-8000-000000000099';
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        categoryId: 'Acrobat',
        topicIds: topicUuid,
        region: 'US',
        origin: 'human',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('category_name', 'Acrobat');
      expect(chainMock.in).to.have.been.calledWith('topic_id', [topicUuid]);
      expect(chainMock.eq).to.have.been.calledWith('region_code', 'US');
      expect(chainMock.ilike).to.have.been.calledWith('origin', 'human');
    });

    it('filters by topicIds (comma-separated UUIDs) when provided', async () => {
      const topicUuids = [
        '0178a3f0-1234-7000-8000-000000000091',
        '0178a3f0-1234-7000-8000-000000000092',
      ];
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: topicUuids.join(',') };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.in).to.have.been.calledWith('topic_id', topicUuids);
    });

    it('ignores non-UUID topicIds in sentiment-overview', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicIds: 'pdf editing' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createSentimentOverviewHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const topicInCalls = chainMock.in.getCalls().filter((c) => c.args[0] === 'topic_id');
      expect(topicInCalls).to.have.lengthOf(0);
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

    it('defaults model to chatgpt-free when not provided', async () => {
      const client = createTableAwareMock();
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createMarketTrackingTrendsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('model', 'chatgpt-free');
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

  describe('createSentimentMoversHandler', () => {
    function createRpcMock(rpcResult = { data: [], error: null }) {
      const rpcStub = sinon.stub().resolves(rpcResult);
      const chainMock = createChainableMock();
      chainMock.rpc = rpcStub;
      return chainMock;
    }

    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = createRpcMock();
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view brand presence data'),
      );

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest for invalid type parameter', async () => {
      mockContext.data = { type: 'invalid' };
      mockContext.dataAccess.Site.postgrestService = createRpcMock();

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.text();
      expect(body).to.include('Invalid type parameter');
    });

    it('returns ok with movers for valid data', async () => {
      const rpcData = {
        data: [
          {
            prompt_id: '0178a3f0-1234-7000-8000-000000000011',
            prompt: 'best pdf editor',
            topic_id: '0178a3f0-1234-7000-8000-000000000022',
            topic: 'Acrobat',
            category_id: '0178a3f0-1234-7000-8000-000000000033',
            category: 'PDF',
            region: 'US',
            origin: 'HUMAN',
            popularity: 'High',
            from_sentiment: 'neutral',
            to_sentiment: 'positive',
            from_date: '2026-02-23',
            to_date: '2026-03-09',
            execution_count: 48,
          },
        ],
        error: null,
      };
      mockContext.data = { type: 'top' };
      mockContext.dataAccess.Site.postgrestService = createRpcMock(rpcData);

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.movers).to.be.an('array').with.lengthOf(1);
      expect(body.movers[0]).to.deep.include({
        promptId: '0178a3f0-1234-7000-8000-000000000011',
        prompt: 'best pdf editor',
        topicId: '0178a3f0-1234-7000-8000-000000000022',
        topic: 'Acrobat',
        categoryId: '0178a3f0-1234-7000-8000-000000000033',
        fromSentiment: 'neutral',
        toSentiment: 'positive',
        executionCount: 48,
      });
    });

    it('defaults type to "top" when not provided', async () => {
      const rpcMock = createRpcMock();
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnce;
      const rpcArgs = rpcMock.rpc.firstCall.args;
      expect(rpcArgs[0]).to.equal('rpc_sentiment_movers');
      expect(rpcArgs[1].p_type).to.equal('top');
    });

    it('returns empty movers when no data', async () => {
      mockContext.dataAccess.Site.postgrestService = createRpcMock({ data: [], error: null });

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.movers).to.deep.equal([]);
    });

    it('handles data: null gracefully', async () => {
      mockContext.dataAccess.Site.postgrestService = createRpcMock({ data: null, error: null });

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.movers).to.deep.equal([]);
    });

    it('returns badRequest when RPC returns an error', async () => {
      const rpcError = { message: 'function does not exist' };
      mockContext.dataAccess.Site.postgrestService = createRpcMock({ data: null, error: rpcError });

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.calledWith(
        'Brand presence sentiment-movers PostgREST error: function does not exist',
      );
    });

    it('passes optional filters to RPC', async () => {
      const rpcMock = createRpcMock();
      mockContext.data = {
        type: 'bottom',
        startDate: '2026-02-01',
        endDate: '2026-03-01',
        model: 'gemini',
        categoryId: 'Acrobat',
        topicIds: '0178a3f0-1234-7000-8000-0000000000aa',
        region: 'US',
        origin: 'human',
      };
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnce;
      const rpcArgs = rpcMock.rpc.firstCall.args;
      expect(rpcArgs[1].p_type).to.equal('bottom');
      expect(rpcArgs[1].p_start_date).to.equal('2026-02-01');
      expect(rpcArgs[1].p_end_date).to.equal('2026-03-01');
      expect(rpcArgs[1].p_model).to.equal('gemini');
      expect(rpcArgs[1].p_origin).to.equal('human');
      expect(rpcArgs[1].p_region_code).to.equal('US');
      expect(rpcArgs[1].p_topic_ids).to.deep.equal(['0178a3f0-1234-7000-8000-0000000000aa']);
    });

    it('passes brandId when not "all"', async () => {
      const rpcMock = createRpcMock();
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const rpcArgs = rpcMock.rpc.firstCall.args;
      expect(rpcArgs[1].p_brand_id).to.equal('0178a3f0-1234-7000-8000-000000000002');
    });

    it('returns 403 when siteId does not belong to organization', async () => {
      const rpcMock = createRpcMock();
      const sitesValidation = { data: [], error: null };
      rpcMock.limit = sinon.stub().resolves(sitesValidation);
      mockContext.data = { siteId: 'cccdac43-1a22-4659-9086-b762f59b9928' };
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('defaults type to "top" when ctx.data is null', async () => {
      const rpcMock = createRpcMock();
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnce;
      expect(rpcMock.rpc.firstCall.args[1].p_type).to.equal('top');
    });

    it('passes p_site_id when siteId belongs to org', async () => {
      const siteId = '0178a3f0-1234-7000-8000-0000000000aa';
      const rpcMock = createRpcMock();
      rpcMock.limit = sinon.stub().resolves({ data: [{ id: siteId }], error: null });
      mockContext.data = { siteId };
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnce;
      expect(rpcMock.rpc.firstCall.args[1].p_site_id).to.equal(siteId);
    });

    it('passes p_category_id when categoryId is a valid UUID', async () => {
      const categoryUUID = '0178a3f0-1234-7000-8000-0000000000bb';
      const rpcMock = createRpcMock();
      mockContext.data = { categoryId: categoryUUID };
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createSentimentMoversHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnce;
      expect(rpcMock.rpc.firstCall.args[1].p_category_id).to.equal(categoryUUID);
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

  describe('createBrandPresenceStatsHandler', () => {
    const statsRow = {
      total_executions: 150,
      average_visibility_score: 7.33,
      total_mentions: 11,
      total_citations: 76,
    };

    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view brand presence data'));

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: x'));

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when site does not belong to org', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      const sitesChain = {
        from: sinon.stub().returnsThis(),
        select: sinon.stub().returnsThis(),
        eq: sinon.stub().returnsThis(),
        limit: sinon.stub().resolves({ data: [], error: null }),
      };
      mockContext.dataAccess.Site.postgrestService = {
        ...rpcMock,
        from: sinon.stub().returns(sitesChain),
      };
      mockContext.data = { siteId: '0178a3f0-1234-7000-8000-000000000099' };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when RPC returns error', async () => {
      const rpcMock = createStatsRpcMock({ data: null, error: { message: 'relation does not exist' } });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation does not exist');
    });

    it('returns ok with stats when RPC succeeds (no showTrends)', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-31',
        model: 'chatgpt',
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.stats).to.deep.equal({
        total_executions: 150,
        average_visibility_score: 7.33,
        total_mentions: 11,
        total_citations: 76,
      });
      expect(body.trends).to.be.undefined;
      expect(rpcMock.rpc).to.have.been.calledOnceWith('rpc_brand_presence_stats', sinon.match.object);
    });

    it('handles null ctx.data (uses empty object fallback for showTrends)', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = null;

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.stats).to.deep.equal({
        total_executions: 150,
        average_visibility_score: 7.33,
        total_mentions: 11,
        total_citations: 76,
      });
      expect(body.trends).to.be.undefined;
    });

    it('returns zero stats when RPC returns null row', async () => {
      const rpcMock = createStatsRpcMock({ data: [null], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.stats).to.deep.equal({
        total_executions: 0,
        average_visibility_score: 0,
        total_mentions: 0,
        total_citations: 0,
      });
    });

    it('returns zero stats when RPC returns empty data', async () => {
      const rpcMock = createStatsRpcMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.stats).to.deep.equal({
        total_executions: 0,
        average_visibility_score: 0,
        total_mentions: 0,
        total_citations: 0,
      });
    });

    it('returns trends when showTrends=true', async () => {
      const weekRow = {
        total_executions: 20,
        average_visibility_score: 6.5,
        total_mentions: 2,
        total_citations: 10,
      };
      const rpcMock = createStatsRpcMock(
        { data: [statsRow], error: null },
        [
          { data: [statsRow], error: null },
          { data: [weekRow], error: null },
          { data: [weekRow], error: null },
          { data: [weekRow], error: null },
        ],
      );
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-21',
        model: 'chatgpt',
        showTrends: true,
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.stats).to.deep.equal({
        total_executions: 150,
        average_visibility_score: 7.33,
        total_mentions: 11,
        total_citations: 76,
      });
      expect(body.trends).to.be.an('array');
      expect(body.trends).to.have.lengthOf(3);
      expect(body.trends[0].startDate).to.equal('2025-01-15');
      expect(body.trends[0].endDate).to.equal('2025-01-21');
      expect(body.trends[0].data.stats).to.deep.equal({
        total_executions: 20,
        average_visibility_score: 6.5,
        total_mentions: 2,
        total_citations: 10,
      });
      expect(body.trends[2].startDate).to.equal('2025-01-01');
      expect(body.trends[2].endDate).to.equal('2025-01-07');
      expect(rpcMock.rpc).to.have.been.callCount(4);
    });

    it('returns trends with zero stats when a trend week has empty or null data', async () => {
      const rpcMock = createStatsRpcMock(
        { data: [statsRow], error: null },
        [
          { data: [statsRow], error: null },
          { data: [], error: null },
          { data: null, error: null },
          { data: [statsRow], error: null },
        ],
      );
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-21',
        model: 'chatgpt',
        showTrends: true,
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.trends).to.have.lengthOf(3);
      expect(body.trends[0].data.stats).to.deep.equal({
        total_executions: 150,
        average_visibility_score: 7.33,
        total_mentions: 11,
        total_citations: 76,
      });
      expect(body.trends[1].data.stats).to.deep.equal({
        total_executions: 0,
        average_visibility_score: 0,
        total_mentions: 0,
        total_citations: 0,
      });
      expect(body.trends[2].data.stats).to.deep.equal({
        total_executions: 0,
        average_visibility_score: 0,
        total_mentions: 0,
        total_citations: 0,
      });
    });

    it('parses showTrends from show_trends alias and truthy values', async () => {
      const rpcMock = createStatsRpcMock(
        { data: [statsRow], error: null },
        [
          { data: [statsRow], error: null },
          { data: [statsRow], error: null },
        ],
      );
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-07',
        show_trends: 'true',
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.trends).to.be.an('array');
      expect(body.trends).to.have.lengthOf(1);
    });

    it('parses showTrends from string "1"', async () => {
      const rpcMock = createStatsRpcMock(
        { data: [statsRow], error: null },
        [{ data: [statsRow], error: null }],
      );
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-07',
        showTrends: '1',
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.trends).to.be.an('array');
      expect(body.trends).to.have.lengthOf(1);
    });

    it('returns badRequest when trends RPC fails', async () => {
      const rpcMock = createStatsRpcMock(
        { data: [statsRow], error: null },
        [
          { data: [statsRow], error: null },
          { data: null, error: { message: 'trends RPC failed' } },
        ],
      );
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-14',
        showTrends: true,
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('trends RPC failed');
    });

    it('passes brandId filter when brandId is not all', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      mockContext.params.brandId = '019cb903-1184-7f92-8325-f9d1176af316';
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledWith(
        'rpc_brand_presence_stats',
        sinon.match.has('p_brand_id', '019cb903-1184-7f92-8325-f9d1176af316'),
      );
    });

    it('passes all filter params to RPC', async () => {
      const rpcMock = createStatsRpcMock({ data: [statsRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        startDate: '2025-01-01',
        endDate: '2025-01-31',
        model: 'gemini',
        siteId: '0178a3f0-1234-7000-8000-0000000000aa',
        categoryId: '0178a3f0-1234-7000-8000-0000000000bb',
        topicIds: '0178a3f0-1234-7000-8000-0000000000cc',
        regionCode: 'US',
        origin: 'ai',
      };

      const handler = createBrandPresenceStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const callArgs = rpcMock.rpc.firstCall.args[1];
      expect(callArgs.p_organization_id).to.equal(mockContext.params.spaceCatId);
      expect(callArgs.p_start_date).to.equal('2025-01-01');
      expect(callArgs.p_end_date).to.equal('2025-01-31');
      expect(callArgs.p_model).to.equal('gemini');
      expect(callArgs.p_site_id).to.equal('0178a3f0-1234-7000-8000-0000000000aa');
      expect(callArgs.p_category_id).to.equal('0178a3f0-1234-7000-8000-0000000000bb');
      expect(callArgs.p_topic_ids).to.deep.equal(['0178a3f0-1234-7000-8000-0000000000cc']);
      expect(callArgs.p_region_code).to.equal('US');
      expect(callArgs.p_origin).to.equal('ai');
    });
  });

  // ── buildTopicPromptKey ─────────────────────────────────────────────────────
  describe('buildTopicPromptKey', () => {
    it('builds key from prompt and region_code', () => {
      const key = buildTopicPromptKey({
        prompt: 'Best PDF tool?',
        region_code: 'US',
      });
      expect(key).to.equal('Best PDF tool?|US');
    });

    it('uses defaults for missing fields', () => {
      expect(buildTopicPromptKey({})).to.equal('|Unknown');
    });
  });

  // ── aggregateTopicData ──────────────────────────────────────────────────────
  describe('aggregateTopicData', () => {
    it('returns empty array for empty input', () => {
      expect(aggregateTopicData([])).to.deep.equal([]);
    });

    it('groups rows by topics column', () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 80,
          position: '2',
          sentiment: 'Positive',
          volume: 100,
          origin: 'human',
          category_name: 'Cat1',
          execution_date: '2026-03-01',
          url: 'https://example.com',
          error_code: null,
        },
        {
          topics: 'AI',
          prompt: 'q2',
          region_code: 'DE',
          mentions: false,
          citations: true,
          visibility_score: 60,
          position: '5',
          sentiment: 'Neutral',
          volume: 200,
          origin: 'ai',
          category_name: 'Cat2',
          execution_date: '2026-03-02',
          url: null,
          error_code: null,
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result).to.have.lengthOf(2);
      const pdfTopic = result.find((t) => t.topic === 'PDF');
      const aiTopic = result.find((t) => t.topic === 'AI');
      expect(pdfTopic).to.exist;
      expect(aiTopic).to.exist;
      expect(pdfTopic.promptCount).to.equal(1);
      expect(aiTopic.promptCount).to.equal(1);
    });

    it('deduplicates prompts by prompt|region within a topic', () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 80,
          position: '2',
          sentiment: 'Positive',
          volume: 100,
          execution_date: '2026-03-01',
        },
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 90,
          position: '1',
          sentiment: 'Positive',
          volume: 150,
          execution_date: '2026-03-05',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result).to.have.lengthOf(1);
      expect(result[0].promptCount).to.equal(1);
    });

    it('computes correct topic-level aggregate metrics', () => {
      const rows = [
        {
          id: 'exec-1',
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 80,
          position: '2',
          sentiment: 'Positive',
          volume: 100,
          execution_date: '2026-03-01',
          brand_presence_sources: [{ url_id: 'url-a' }, { url_id: 'url-b' }],
        },
        {
          id: 'exec-2',
          topics: 'PDF',
          prompt: 'q2',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: 60,
          position: '6',
          sentiment: 'Negative',
          volume: 200,
          execution_date: '2026-03-02',
          brand_presence_sources: [{ url_id: 'url-b' }, { url_id: 'url-c' }],
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].promptCount).to.equal(2);
      expect(result[0].brandMentions).to.equal(1);
      expect(result[0].brandCitations).to.equal(1);
      expect(result[0].sourceCount).to.equal(3);
      expect(result[0].averageVisibilityScore).to.equal(70);
      expect(result[0].averagePosition).to.equal(4);
      expect(result[0].averageSentiment).to.equal(50);
      expect(result[0].popularityVolume).to.equal('N/A');
    });

    it('counts mentions across all executions, not just deduplicated', () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: true,
          execution_date: '2026-03-01',
        },
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          execution_date: '2026-03-02',
        },
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: true,
          execution_date: '2026-03-03',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].promptCount).to.equal(1);
      expect(result[0].brandMentions).to.equal(3);
      expect(result[0].brandCitations).to.equal(2);
    });

    it('returns sourceCount 0 when no brand_presence_sources on rows', () => {
      const rows = [
        {
          id: 'exec-1',
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          execution_date: '2026-03-01',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].sourceCount).to.equal(0);
    });

    it('uses "Unknown" for rows with null topics', () => {
      const rows = [
        {
          topics: null,
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-01',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].topic).to.equal('Unknown');
    });

    it('handles null visibility_score and volume gracefully', () => {
      const rows = [
        {
          topics: 'X',
          prompt: 'q1',
          region_code: 'US',
          visibility_score: null,
          volume: null,
          position: null,
          sentiment: null,
          mentions: false,
          citations: false,
          execution_date: '2026-03-01',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].averageVisibilityScore).to.equal(0);
      expect(result[0].averagePosition).to.equal(0);
      expect(result[0].averageSentiment).to.equal(-1);
      expect(result[0].popularityVolume).to.equal('N/A');
    });

    it('skips "Not Mentioned" positions in average calculation', () => {
      const rows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          position: 'Not Mentioned',
          visibility_score: 50,
          execution_date: '2026-03-01',
        },
        {
          topics: 'T',
          prompt: 'q2',
          region_code: 'US',
          position: '4',
          visibility_score: 50,
          execution_date: '2026-03-01',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].averagePosition).to.equal(4);
    });

    it('does not include items array in output', () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          execution_date: '2026-03-01',
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0]).to.not.have.property('items');
      expect(result[0].promptCount).to.equal(1);
    });

    it('uses 0-100 sentiment scale: neutral = 50, positive = 100', () => {
      const neutralRows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          sentiment: 'Neutral',
          execution_date: '2026-03-01',
        },
      ];
      const neutralResult = aggregateTopicData(neutralRows);
      expect(neutralResult[0].averageSentiment).to.equal(50);

      const positiveRows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          sentiment: 'Positive',
          execution_date: '2026-03-01',
        },
      ];
      const positiveResult = aggregateTopicData(positiveRows);
      expect(positiveResult[0].averageSentiment).to.equal(100);

      const negativeRows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          sentiment: 'Negative',
          execution_date: '2026-03-01',
        },
      ];
      const negativeResult = aggregateTopicData(negativeRows);
      expect(negativeResult[0].averageSentiment).to.equal(0);
    });

    it('converts imputed volume values to categorical labels', () => {
      const highRows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          volume: -30,
          execution_date: '2026-03-01',
        },
      ];
      expect(aggregateTopicData(highRows)[0].popularityVolume).to.equal('High');

      const medRows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          volume: -20,
          execution_date: '2026-03-01',
        },
      ];
      expect(aggregateTopicData(medRows)[0].popularityVolume).to.equal('Medium');

      const lowRows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          volume: -10,
          execution_date: '2026-03-01',
        },
      ];
      expect(aggregateTopicData(lowRows)[0].popularityVolume).to.equal('Low');
    });

    it('deduplicates for promptCount but aggregates metrics across all executions', () => {
      const rows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-10',
          sentiment: 'Positive',
          visibility_score: 90,
          mentions: true,
        },
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-01',
          sentiment: 'Negative',
          visibility_score: 50,
          mentions: true,
        },
      ];
      const result = aggregateTopicData(rows);
      expect(result[0].promptCount).to.equal(1);
      expect(result[0].averageVisibilityScore).to.equal(70);
      expect(result[0].averageSentiment).to.equal(50);
      expect(result[0].brandMentions).to.equal(2);
    });
  });

  // ── buildPromptDetails ──────────────────────────────────────────────────────
  describe('buildPromptDetails', () => {
    it('returns empty array for empty input', () => {
      expect(buildPromptDetails([])).to.deep.equal([]);
    });

    it('builds correct PromptDetail items', () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 80,
          position: '3',
          sentiment: 'Positive',
          origin: 'human',
          category_name: 'Docs',
          execution_date: '2026-03-01',
          url: 'https://example.com',
          error_code: null,
        },
      ];
      const result = buildPromptDetails(rows);
      expect(result).to.have.lengthOf(1);
      const item = result[0];
      expect(item.topic).to.equal('PDF');
      expect(item.prompt).to.equal('q1');
      expect(item.region).to.equal('US');
      expect(item.category).to.equal('Docs');
      expect(item.executionDate).to.equal('2026-03-01');
      expect(item.relatedURL).to.equal('https://example.com');
      expect(item.mentionsCount).to.equal(1);
      expect(item.citationsCount).to.equal(0);
      expect(item.isAnswered).to.equal(true);
      expect(item.visibilityScore).to.equal(80);
      expect(item.position).to.equal('3');
      expect(item.sentiment).to.equal('Positive');
      expect(item.origin).to.equal('human');
    });

    it('deduplicates by prompt|region_code keeping latest execution', () => {
      const rows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-10',
          visibility_score: 90,
        },
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-01',
          visibility_score: 50,
        },
      ];
      const result = buildPromptDetails(rows);
      expect(result).to.have.lengthOf(1);
      expect(result[0].executionDate).to.equal('2026-03-10');
      expect(result[0].visibilityScore).to.equal(90);
    });

    it('sets isAnswered to false when error_code is present', () => {
      const rows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-01',
          error_code: 'TIMEOUT',
        },
      ];
      const result = buildPromptDetails(rows);
      expect(result[0].isAnswered).to.equal(false);
      expect(result[0].errorCode).to.equal('TIMEOUT');
    });

    it('uses empty string fallbacks for null fields', () => {
      const rows = [
        {
          topics: 'T',
          prompt: null,
          region_code: null,
          category_name: null,
          execution_date: null,
          url: null,
          sentiment: null,
          error_code: null,
          origin: null,
          mentions: null,
          citations: null,
          visibility_score: null,
          position: null,
        },
      ];
      const result = buildPromptDetails(rows);
      expect(result[0].executionDate).to.equal('');
      expect(result[0].prompt).to.equal('');
      expect(result[0].region).to.equal('');
      expect(result[0].category).to.equal('');
      expect(result[0].relatedURL).to.equal('');
      expect(result[0].sentiment).to.equal('');
      expect(result[0].errorCode).to.equal('');
      expect(result[0].origin).to.equal('');
    });

    it('aggregates mentions and citations across all execution rows per prompt', () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'best pdf editor',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 80,
          execution_date: '2026-03-01',
        },
        {
          topics: 'PDF',
          prompt: 'best pdf editor',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 70,
          execution_date: '2026-03-08',
        },
        {
          topics: 'PDF',
          prompt: 'best pdf editor',
          region_code: 'US',
          mentions: false,
          citations: true,
          visibility_score: 90,
          execution_date: '2026-03-15',
        },
      ];
      const result = buildPromptDetails(rows);
      expect(result).to.have.lengthOf(1);
      expect(result[0].mentionsCount).to.equal(2);
      expect(result[0].citationsCount).to.equal(2);
      // Latest execution's metadata is used
      expect(result[0].executionDate).to.equal('2026-03-15');
      expect(result[0].visibilityScore).to.equal(90);
    });

    it('uses "Unknown" for null topics and counts citations correctly', () => {
      const rows = [
        {
          topics: null,
          prompt: 'q1',
          region_code: 'US',
          mentions: false,
          citations: true,
          visibility_score: 50,
          execution_date: '2026-03-01',
        },
      ];
      const result = buildPromptDetails(rows);
      expect(result[0].topic).to.equal('Unknown');
      expect(result[0].citationsCount).to.equal(1);
      expect(result[0].mentionsCount).to.equal(0);
    });
  });

  // ── createTopicsHandler ─────────────────────────────────────────────────────
  describe('createTopicsHandler', () => {
    const sampleRpcRow = {
      topic: 'PDF',
      prompt_count: 5,
      brand_mentions: 12,
      brand_citations: 8,
      source_count: 3,
      avg_visibility_score: 72.5,
      avg_position: 2.3,
      avg_sentiment: 75,
      popularity_volume: 'High',
      total_count: 42,
    };

    function createTopicsRpcMock(rpcResult = { data: [], error: null }) {
      const rpcStub = sinon.stub().resolves(rpcResult);
      const siteChain = {
        select: sinon.stub().returnsThis(),
        eq: sinon.stub().returnsThis(),
        limit: sinon.stub().resolves({ data: [{ id: 'x' }], error: null }),
      };
      return {
        rpc: rpcStub,
        from: sinon.stub().returns(siteChain),
      };
    }

    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when org access check fails', async () => {
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view brand presence data'),
      );
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock();

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when RPC returns error', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: null,
        error: { message: 'function not found' },
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns ok with topicDetails and totalCount for valid data', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: [sampleRpcRow],
        error: null,
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);
      expect(body.topicDetails[0].topic).to.equal('PDF');
      expect(body.topicDetails[0].promptCount).to.equal(5);
      expect(body.topicDetails[0].brandMentions).to.equal(12);
      expect(body.topicDetails[0].brandCitations).to.equal(8);
      expect(body.topicDetails[0].sourceCount).to.equal(3);
      expect(body.topicDetails[0].averageVisibilityScore).to.equal(72.5);
      expect(body.topicDetails[0].averagePosition).to.equal(2.3);
      expect(body.topicDetails[0].averageSentiment).to.equal(75);
      expect(body.topicDetails[0].popularityVolume).to.equal('High');
      expect(body.totalCount).to.equal(42);
    });

    it('returns ok with empty topicDetails when no data', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: [],
        error: null,
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('returns ok when data is null', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: null,
        error: null,
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
    });

    it('validates site belongs to org when siteId is provided', async () => {
      mockContext.data = { siteId: '0178a3f0-1234-7000-8000-000000000099' };
      const client = createTopicsRpcMock({ data: [], error: null });
      client.from = sinon.stub().returns({
        select: sinon.stub().returnsThis(),
        eq: sinon.stub().returnsThis(),
        limit: sinon.stub().resolves({ data: [], error: null }),
      });
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('calls rpc_brand_presence_topics with correct params', async () => {
      const client = createTopicsRpcMock({ data: [], error: null });
      mockContext.data = {
        startDate: '2026-02-01',
        endDate: '2026-02-28',
        platform: 'gemini',
        categoryId: 'Acrobat',
        topic: 'PDF Tools',
        region: 'US',
        origin: 'ai',
        sortBy: 'mentions',
        sortOrder: 'desc',
        page: '2',
        pageSize: '10',
      };
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.rpc).to.have.been.calledOnce;
      const [fnName, params] = client.rpc.firstCall.args;
      expect(fnName).to.equal('rpc_brand_presence_topics');
      expect(params.p_organization_id).to.equal(mockContext.params.spaceCatId);
      expect(params.p_start_date).to.equal('2026-02-01');
      expect(params.p_end_date).to.equal('2026-02-28');
      expect(params.p_model).to.equal('gemini');
      expect(params.p_brand_id).to.equal('0178a3f0-1234-7000-8000-000000000002');
      expect(params.p_category_name).to.equal('Acrobat');
      expect(params.p_category_id).to.be.null;
      expect(params.p_topic).to.equal('PDF Tools');
      expect(params.p_region_code).to.equal('US');
      expect(params.p_origin).to.equal('ai');
      expect(params.p_sort_by).to.equal('mentions');
      expect(params.p_sort_order).to.equal('desc');
      expect(params.p_page_offset).to.equal(20);
      expect(params.p_page_limit).to.equal(10);
    });

    it('passes category_id when categoryId is a valid UUID', async () => {
      const client = createTopicsRpcMock({ data: [], error: null });
      mockContext.data = {
        categoryId: '0178a3f0-1234-7000-8000-000000000099',
      };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const [, params] = client.rpc.firstCall.args;
      expect(params.p_category_id).to.equal('0178a3f0-1234-7000-8000-000000000099');
      expect(params.p_category_name).to.be.null;
    });

    it('passes topicIds when provided', async () => {
      const client = createTopicsRpcMock({ data: [], error: null });
      mockContext.data = {
        topicIds: '0178a3f0-1234-7000-8000-000000000010,0178a3f0-1234-7000-8000-000000000011',
      };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const [, params] = client.rpc.firstCall.args;
      expect(params.p_topic_ids).to.deep.equal([
        '0178a3f0-1234-7000-8000-000000000010',
        '0178a3f0-1234-7000-8000-000000000011',
      ]);
    });

    it('uses default sort and pagination when context.data is null', async () => {
      const client = createTopicsRpcMock({
        data: [{ ...sampleRpcRow, topic: 'T', total_count: 1 }],
        error: null,
      });
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);

      const [, params] = client.rpc.firstCall.args;
      expect(params.p_sort_by).to.equal('name');
      expect(params.p_sort_order).to.equal('asc');
      expect(params.p_page_offset).to.equal(0);
      expect(params.p_page_limit).to.equal(20);
    });

    it('maps null/missing RPC fields to safe defaults', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: [{
          topic: 'Sparse',
          prompt_count: null,
          brand_mentions: null,
          brand_citations: null,
          source_count: null,
          avg_visibility_score: null,
          avg_position: null,
          avg_sentiment: null,
          popularity_volume: null,
          total_count: 1,
        }],
        error: null,
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      const td = body.topicDetails[0];
      expect(td.promptCount).to.equal(0);
      expect(td.brandMentions).to.equal(0);
      expect(td.brandCitations).to.equal(0);
      expect(td.sourceCount).to.equal(0);
      expect(td.averageVisibilityScore).to.equal(0);
      expect(td.averagePosition).to.equal(0);
      expect(td.averageSentiment).to.equal(-1);
      expect(td.popularityVolume).to.equal('N/A');
    });

    it('handles null total_count in RPC row', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: [{ ...sampleRpcRow, total_count: null }],
        error: null,
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.totalCount).to.equal(0);
    });

    it('passes siteId to RPC when site belongs to org', async () => {
      const validSiteId = '0178a3f0-1234-7000-8000-000000000099';
      mockContext.data = { siteId: validSiteId };
      const client = createTopicsRpcMock({ data: [sampleRpcRow], error: null });
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const [, params] = client.rpc.firstCall.args;
      expect(params.p_site_id).to.equal(validSiteId);
    });

    it('does not include items property in topicDetails', async () => {
      mockContext.dataAccess.Site.postgrestService = createTopicsRpcMock({
        data: [sampleRpcRow],
        error: null,
      });

      const handler = createTopicsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.topicDetails[0]).to.not.have.property('items');
    });
  });

  // ── createTopicPromptsHandler ───────────────────────────────────────────────
  describe('createTopicPromptsHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when org access check fails', async () => {
      getOrgAndValidateAccess.rejects(
        new Error(
          'Only users belonging to the organization can view brand presence data',
        ),
      );
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest for malformed percent-encoded topicId', async () => {
      mockContext.params.topicId = '%GG';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [],
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns ok with items and totalCount for valid data', async () => {
      const rows = [
        {
          topics: 'PDF',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 80,
          position: '2',
          sentiment: 'Positive',
          execution_date: '2026-03-01',
          url: 'https://x.com',
          error_code: null,
          origin: 'human',
          category_name: 'Docs',
        },
      ];
      mockContext.params.topicId = 'PDF';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.have.lengthOf(1);
      expect(body.items[0].prompt).to.equal('q1');
      expect(body.totalCount).to.equal(1);
    });

    it('returns empty items when no data', async () => {
      mockContext.params.topicId = 'None';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [],
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('returns empty items when data is null', async () => {
      mockContext.params.topicId = 'None';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('filters by topics column using topicId param', async () => {
      const client = createChainableMock();
      mockContext.params.topicId = 'AI%20Art';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('topics', 'AI Art');
    });

    it('applies pagination to prompt results', async () => {
      const rows = [];
      for (let i = 0; i < 5; i += 1) {
        rows.push({
          topics: 'T',
          prompt: `q${i}`,
          region_code: 'US',
          execution_date: '2026-03-01',
        });
      }
      mockContext.params.topicId = 'T';
      mockContext.data = { page: '0', pageSize: '2' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.totalCount).to.equal(5);
      expect(body.items).to.have.lengthOf(2);
    });

    it('returns badRequest when query returns error', async () => {
      mockContext.params.topicId = 'T';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: { message: 'query failed' },
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('validates site belongs to org when siteId is provided', async () => {
      mockContext.params.topicId = 'T';
      mockContext.data = { siteId: 'site-123' };

      const client = createChainableMock({
        data: [],
        error: null,
      });
      client.siteValidationResult = { data: [], error: null };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('applies region and origin filters', async () => {
      const client = createChainableMock({
        data: [],
        error: null,
      });
      mockContext.params.topicId = 'T';
      mockContext.data = { region: 'US', origin: 'organic' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('region_code', 'US');
      expect(client.ilike).to.have.been.calledWith('origin', 'organic');
    });

    it('filters prompts by query param when provided', async () => {
      const rows = [
        {
          topics: 'PDF Tools',
          prompt: 'How to edit PDF files',
          region_code: 'US',
          execution_date: '2026-03-01',
        },
        {
          topics: 'PDF Tools',
          prompt: 'Best image converter',
          region_code: 'US',
          execution_date: '2026-03-01',
        },
        {
          topics: 'PDF Tools',
          prompt: 'PDF merge online',
          region_code: 'US',
          execution_date: '2026-03-01',
        },
      ];
      mockContext.params.topicId = 'PDF%20Tools';
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.have.lengthOf(2);
      expect(body.items.map((i) => i.prompt)).to.deep.equal([
        'How to edit PDF files',
        'PDF merge online',
      ]);
      expect(body.totalCount).to.equal(2);
    });

    it('returns all prompts when query param is empty', async () => {
      const rows = [
        {
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          execution_date: '2026-03-01',
        },
        {
          topics: 'T',
          prompt: 'q2',
          region_code: 'US',
          execution_date: '2026-03-01',
        },
      ];
      mockContext.params.topicId = 'T';
      mockContext.data = { query: '' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.items).to.have.lengthOf(2);
      expect(body.totalCount).to.equal(2);
    });

    it('filters by brand_id when brandId is a UUID', async () => {
      const client = createChainableMock({
        data: [],
        error: null,
      });
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000001';
      mockContext.params.topicId = 'T';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicPromptsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith(
        'brand_id',
        '0178a3f0-1234-7000-8000-000000000001',
      );
    });
  });

  describe('createSearchHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      mockContext.data = { query: 'pdf' };

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when org access check fails', async () => {
      getOrgAndValidateAccess.rejects(
        new Error(
          'Only users belonging to the organization can view brand presence data',
        ),
      );
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns empty results when query is empty', async () => {
      mockContext.data = { query: '' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('returns empty results when query is missing', async () => {
      mockContext.data = {};
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('returns empty results when context.data is undefined', async () => {
      mockContext.data = undefined;
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('returns badRequest when query returns error', async () => {
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: { message: 'table not found' },
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns ok with matching topics and matchType=topic', async () => {
      const rows = [
        {
          topics: 'PDF Editing',
          prompt: 'best pdf editor',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 80,
          position: '2',
          sentiment: 'Positive',
          volume: 100,
          origin: 'human',
          category_name: 'Docs',
          execution_date: '2026-03-01',
          url: 'https://x.com',
          error_code: null,
        },
      ];
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);
      expect(body.topicDetails[0].topic).to.equal('PDF Editing');
      expect(body.topicDetails[0].matchType).to.equal('topic');
      expect(body.totalCount).to.equal(1);
    });

    it('returns matchType=prompt when only prompt matches', async () => {
      const rows = [
        {
          topics: 'Image Tools',
          prompt: 'convert pdf to image',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 70,
          position: '3',
          sentiment: 'Neutral',
          volume: 50,
          origin: 'ai',
          category_name: 'Creative',
          execution_date: '2026-03-01',
          url: 'https://y.com',
          error_code: null,
        },
      ];
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);
      expect(body.topicDetails[0].topic).to.equal('Image Tools');
      expect(body.topicDetails[0].matchType).to.equal('prompt');
    });

    it('adjusts promptCount for prompt-matched topics to only count matching prompts', async () => {
      const rows = [
        {
          topics: 'Image Tools',
          prompt: 'convert pdf to image',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 70,
          position: '3',
          sentiment: 'Neutral',
          volume: 50,
          origin: 'ai',
          category_name: 'Creative',
          execution_date: '2026-03-01',
          url: 'https://y.com',
          error_code: null,
          brand_presence_sources: [],
        },
        {
          topics: 'Image Tools',
          prompt: 'best image editor',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: 60,
          position: '5',
          sentiment: 'Positive',
          volume: 40,
          origin: 'ai',
          category_name: 'Creative',
          execution_date: '2026-03-01',
          url: 'https://z.com',
          error_code: null,
          brand_presence_sources: [],
        },
        {
          topics: 'Image Tools',
          prompt: 'pdf merge tool',
          region_code: 'EU',
          mentions: true,
          citations: true,
          visibility_score: 80,
          position: '1',
          sentiment: 'Positive',
          volume: 60,
          origin: 'ai',
          category_name: 'Creative',
          execution_date: '2026-03-01',
          url: 'https://w.com',
          error_code: null,
          brand_presence_sources: [],
        },
      ];
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);
      expect(body.topicDetails[0].matchType).to.equal('prompt');
      // 3 total unique prompts, but only 2 match 'pdf'
      expect(body.topicDetails[0].promptCount).to.equal(2);
    });

    it('keeps full promptCount for topic-matched topics', async () => {
      const rows = [
        {
          topics: 'PDF Editing',
          prompt: 'how to merge files',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 90,
          position: '1',
          sentiment: 'Positive',
          volume: 80,
          origin: 'human',
          category_name: 'Docs',
          execution_date: '2026-03-01',
          url: 'https://a.com',
          error_code: null,
          brand_presence_sources: [],
        },
        {
          topics: 'PDF Editing',
          prompt: 'best editor tool',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: 85,
          position: '2',
          sentiment: 'Neutral',
          volume: 70,
          origin: 'human',
          category_name: 'Docs',
          execution_date: '2026-03-01',
          url: 'https://b.com',
          error_code: null,
          brand_presence_sources: [],
        },
      ];
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);
      expect(body.topicDetails[0].matchType).to.equal('topic');
      // topic name matches, so all prompts are counted
      expect(body.topicDetails[0].promptCount).to.equal(2);
    });

    it('handles rows with null topics and prompt in search matching', async () => {
      const rows = [
        {
          topics: null,
          prompt: null,
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: 50,
          position: '4',
          sentiment: 'Neutral',
          volume: 30,
          origin: 'ai',
          category_name: 'General',
          execution_date: '2026-03-01',
          url: null,
          error_code: null,
          brand_presence_sources: [],
        },
        {
          topics: null,
          prompt: 'unknown topic pdf query',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 60,
          position: '2',
          sentiment: 'Positive',
          volume: 40,
          origin: 'ai',
          category_name: 'General',
          execution_date: '2026-03-01',
          url: null,
          error_code: null,
          brand_presence_sources: [],
        },
      ];
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(1);
      expect(body.topicDetails[0].topic).to.equal('Unknown');
      expect(body.topicDetails[0].matchType).to.equal('prompt');
      expect(body.topicDetails[0].promptCount).to.equal(1);
    });

    it('uses .or() for PostgREST query with escaped pattern', async () => {
      const client = createChainableMock();
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const expected = buildSearchPattern('pdf');
      expect(client.or).to.have.been.calledWith(
        `topics.ilike.${expected},prompt.ilike.${expected}`,
      );
    });

    it('validates site belongs to org when siteId is provided', async () => {
      mockContext.data = {
        query: 'pdf',
        siteId: '0178a3f0-1234-7000-8000-000000000099',
      };
      const client = createChainableMock(
        { data: [], error: null },
        [
          { data: [], error: null },
          { data: [], error: null },
        ],
      );
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('applies optional filters: category, region, origin, topicIds', async () => {
      const client = createChainableMock();
      const topicUuid1 = '0178a3f0-1234-7000-8000-000000000010';
      const topicUuid2 = '0178a3f0-1234-7000-8000-000000000011';
      mockContext.data = {
        query: 'pdf',
        categoryId: 'Acrobat',
        region: 'US',
        origin: 'human',
        topicIds: [topicUuid1, topicUuid2],
      };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('category_name', 'Acrobat');
      expect(client.eq).to.have.been.calledWith('region_code', 'US');
      expect(client.ilike).to.have.been.calledWith('origin', 'human');
      expect(client.in).to.have.been.calledWith('topic_id', [topicUuid1, topicUuid2]);
    });

    it('filters by category_id when categoryId is a valid UUID', async () => {
      const client = createChainableMock();
      const categoryUuid = '0178a3f0-1234-7000-8000-000000000020';
      mockContext.data = {
        query: 'pdf',
        categoryId: categoryUuid,
      };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('category_id', categoryUuid);
    });

    it('handles null data from PostgREST gracefully', async () => {
      const client = createChainableMock({ data: null, error: null });
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('filters by brand_id when brandId is a UUID', async () => {
      const client = createChainableMock({
        data: [],
        error: null,
      });
      mockContext.data = { query: 'pdf' };
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000001';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith(
        'brand_id',
        '0178a3f0-1234-7000-8000-000000000001',
      );
    });

    it('paginates with default pageSize=20', async () => {
      const rows = [];
      for (let i = 0; i < 25; i += 1) {
        rows.push({
          topics: `Topic${i}`,
          prompt: `pdf question ${i}`,
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 50,
          position: '5',
          sentiment: 'Neutral',
          volume: 10,
          origin: 'human',
          category_name: 'Cat',
          execution_date: '2026-03-01',
          url: '',
          error_code: null,
        });
      }
      mockContext.data = { query: 'pdf' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(20);
      expect(body.totalCount).to.equal(25);
    });

    it('returns page 1 with remaining items', async () => {
      const rows = [];
      for (let i = 0; i < 25; i += 1) {
        rows.push({
          topics: `Topic${i}`,
          prompt: `pdf question ${i}`,
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 50,
          position: '5',
          sentiment: 'Neutral',
          volume: 10,
          origin: 'human',
          category_name: 'Cat',
          execution_date: '2026-03-01',
          url: '',
          error_code: null,
        });
      }
      mockContext.data = { query: 'pdf', page: '1' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(5);
      expect(body.totalCount).to.equal(25);
    });

    it('sorts by visibility descending when requested', async () => {
      const rows = [
        {
          topics: 'LowVis',
          prompt: 'pdf low',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 20,
          position: '5',
          sentiment: 'Neutral',
          volume: 10,
          origin: 'human',
          category_name: 'Cat',
          execution_date: '2026-03-01',
          url: '',
          error_code: null,
        },
        {
          topics: 'HighVis',
          prompt: 'pdf high',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 90,
          position: '1',
          sentiment: 'Positive',
          volume: 50,
          origin: 'human',
          category_name: 'Cat',
          execution_date: '2026-03-01',
          url: '',
          error_code: null,
        },
      ];
      mockContext.data = { query: 'pdf', sortBy: 'visibility', sortOrder: 'desc' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(2);
      expect(body.topicDetails[0].topic).to.equal('HighVis');
      expect(body.topicDetails[1].topic).to.equal('LowVis');
    });

    it('returns empty results when query is only whitespace', async () => {
      mockContext.data = { query: '   ' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);
    });

    it('returns badRequest when query is a single character', async () => {
      mockContext.data = { query: 'a' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('escapes ILIKE metacharacters in query', async () => {
      const client = createChainableMock();
      mockContext.data = { query: 'test%_val' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const expected = buildSearchPattern('test%_val');
      expect(client.or).to.have.been.calledWith(
        `topics.ilike.${expected},prompt.ilike.${expected}`,
      );
    });

    it('escapes PostgREST special characters (commas, dots, parens) in query', async () => {
      const client = createChainableMock();
      mockContext.data = { query: 'pdf,prompt.eq.hack(test)' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const expected = buildSearchPattern('pdf,prompt.eq.hack(test)');
      expect(client.or).to.have.been.calledWith(
        `topics.ilike.${expected},prompt.ilike.${expected}`,
      );
    });

    it('does not filter by brand_id when brandId is "all"', async () => {
      const client = createChainableMock({
        data: [],
        error: null,
      });
      mockContext.data = { query: 'pdf' };
      mockContext.params.brandId = 'all';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createSearchHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const brandIdCalls = client.eq.getCalls()
        .filter((call) => call.args[0] === 'brand_id');
      expect(brandIdCalls).to.have.lengthOf(0);
    });

    it('sorts results by a numeric field', async () => {
      const baseRow = {
        region_code: 'US',
        citations: false,
        sentiment: 'Neutral',
        origin: 'ai',
        category_name: 'Cat',
        execution_date: '2026-03-01',
        error_code: null,
        brand_presence_sources: [],
      };
      const rows = [
        {
          ...baseRow, topics: 'Topic A', prompt: 'pdf a', mentions: false, visibility_score: 50, position: '4', volume: 10, url: 'https://a.com',
        },
        {
          ...baseRow, topics: 'Topic B', prompt: 'pdf b', mentions: true, visibility_score: 90, position: '1', volume: 20, url: 'https://b.com',
        },
        {
          ...baseRow, topics: 'Topic C', prompt: 'pdf c', mentions: false, visibility_score: 30, position: '6', volume: 5, url: 'https://c.com',
        },
      ];
      mockContext.data = { query: 'pdf', sortBy: 'mentions', sortOrder: 'desc' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails).to.have.lengthOf(3);
      expect(body.topicDetails[0].topic).to.equal('Topic B');
    });

    it('falls back to sorting by topic when sortBy is unknown', async () => {
      const rows = [
        {
          topics: 'Bravo',
          prompt: 'pdf bravo',
          region_code: 'US',
          mentions: true,
          citations: false,
          visibility_score: 70,
          position: '2',
          sentiment: 'Neutral',
          volume: 10,
          origin: 'ai',
          category_name: 'Cat',
          execution_date: '2026-03-01',
          url: 'https://b.com',
          error_code: null,
          brand_presence_sources: [],
        },
        {
          topics: 'Alpha',
          prompt: 'pdf alpha',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: 60,
          position: '3',
          sentiment: 'Neutral',
          volume: 5,
          origin: 'ai',
          category_name: 'Cat',
          execution_date: '2026-03-01',
          url: 'https://a.com',
          error_code: null,
          brand_presence_sources: [],
        },
      ];
      mockContext.data = { query: 'pdf', sortBy: 'nonexistent' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: rows,
        error: null,
      });

      const handler = createSearchHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topicDetails[0].topic).to.equal('Alpha');
      expect(body.topicDetails[1].topic).to.equal('Bravo');
    });
  });

  describe('buildSearchPattern', () => {
    it('wraps a plain query in ILIKE wildcards and PostgREST double-quotes', () => {
      expect(buildSearchPattern('pdf')).to.equal('"%pdf%"');
    });

    it('escapes percent signs', () => {
      expect(buildSearchPattern('100%')).to.equal('"%100\\\\%%"');
    });

    it('escapes underscores', () => {
      expect(buildSearchPattern('foo_bar')).to.equal('"%foo\\\\_bar%"');
    });

    it('escapes commas (PostgREST condition separator)', () => {
      expect(buildSearchPattern('a,b')).to.equal('"%a,b%"');
    });

    it('escapes double quotes', () => {
      expect(buildSearchPattern('say "hello"')).to.equal('"%say \\"hello\\"%"');
    });

    it('handles combined special characters', () => {
      const result = buildSearchPattern('100%_test,"quoted"');
      expect(result).to.be.a('string');
      expect(result.startsWith('"')).to.be.true;
      expect(result.endsWith('"')).to.be.true;
    });
  });

  // ── aggregateWeeklyDetailStats ──────────────────────────────────────────────
  describe('aggregateWeeklyDetailStats', () => {
    it('returns empty array for empty input', () => {
      expect(aggregateWeeklyDetailStats([])).to.deep.equal([]);
    });

    it('buckets rows by ISO week and sorts chronologically', () => {
      const rows = [
        { execution_date: '2026-03-09', visibility_score: null },
        { execution_date: '2026-03-02', visibility_score: null },
      ];
      const result = aggregateWeeklyDetailStats(rows);
      expect(result).to.have.lengthOf(2);
      expect(result[0].week).to.equal('2026-W10');
      expect(result[1].week).to.equal('2026-W11');
    });

    it('averages visibility score per week', () => {
      const rows = [
        { execution_date: '2026-03-02', visibility_score: 60 },
        { execution_date: '2026-03-03', visibility_score: 40 },
      ];
      const [entry] = aggregateWeeklyDetailStats(rows);
      expect(entry.visibilityScore).to.equal(50);
    });

    it('returns 0 visibilityScore when all scores are null', () => {
      const rows = [{ execution_date: '2026-03-02', visibility_score: null }];
      const [entry] = aggregateWeeklyDetailStats(rows);
      expect(entry.visibilityScore).to.equal(0);
    });

    it('averages numeric position values and excludes "Not Mentioned"', () => {
      const rows = [
        { execution_date: '2026-03-02', position: '2' },
        { execution_date: '2026-03-03', position: 'Not Mentioned' },
        { execution_date: '2026-03-04', position: '4' },
      ];
      const [entry] = aggregateWeeklyDetailStats(rows);
      expect(entry.position).to.equal(3);
    });

    it('counts mentions and citations', () => {
      const rows = [
        { execution_date: '2026-03-02', mentions: true, citations: true },
        { execution_date: '2026-03-03', mentions: 'true', citations: false },
        { execution_date: '2026-03-04', mentions: false, citations: 'true' },
      ];
      const [entry] = aggregateWeeklyDetailStats(rows);
      expect(entry.mentions).to.equal(2);
      expect(entry.citations).to.equal(2);
    });

    it('computes sentiment score (positive=100, neutral=50, negative counted at 0)', () => {
      const rows = [
        { execution_date: '2026-03-02', sentiment: 'Positive' },
        { execution_date: '2026-03-03', sentiment: 'Neutral' },
        { execution_date: '2026-03-04', sentiment: 'Negative' },
      ];
      const [entry] = aggregateWeeklyDetailStats(rows);
      // (100 + 50 + 0) / 3 = 50
      expect(entry.sentiment).to.equal(50);
    });

    it('returns -1 sentiment when no sentiment rows', () => {
      const rows = [{ execution_date: '2026-03-02', sentiment: '' }];
      const [entry] = aggregateWeeklyDetailStats(rows);
      expect(entry.sentiment).to.equal(-1);
    });

    it('accumulates execution count per week', () => {
      const rows = [
        { execution_date: '2026-03-02' },
        { execution_date: '2026-03-03' },
      ];
      // Both in 2026-W10
      const result = aggregateWeeklyDetailStats(rows);
      expect(result).to.have.lengthOf(1);
    });
  });

  // ── aggregateDetailSources ──────────────────────────────────────────────────
  describe('aggregateDetailSources', () => {
    it('returns empty array for empty input', () => {
      expect(aggregateDetailSources([])).to.deep.equal([]);
    });

    it('skips rows with empty URLs', () => {
      const rows = [{ url: '', hostname: 'example.com', content_type: 'web' }];
      expect(aggregateDetailSources(rows)).to.deep.equal([]);
    });

    it('deduplicates rows by URL and counts citations', () => {
      const rows = [
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-02', prompt: 'q1',
        },
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-03', prompt: 'q2',
        },
      ];
      const result = aggregateDetailSources(rows);
      expect(result).to.have.lengthOf(1);
      expect(result[0].citationCount).to.equal(2);
    });

    it('accumulates unique weeks across rows for same URL', () => {
      const rows = [
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-02', prompt: 'q1',
        },
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-09', prompt: 'q1',
        },
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-02', prompt: 'q1',
        },
      ];
      const [entry] = aggregateDetailSources(rows);
      expect(entry.weeks).to.have.lengthOf(2);
    });

    it('accumulates prompts with counts', () => {
      const rows = [
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-02', prompt: 'q1',
        },
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-03', prompt: 'q1',
        },
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-09', prompt: 'q2',
        },
      ];
      const [entry] = aggregateDetailSources(rows);
      expect(entry.prompts).to.deep.include({ prompt: 'q1', count: 2 });
      expect(entry.prompts).to.deep.include({ prompt: 'q2', count: 1 });
    });

    it('returns separate entries for distinct URLs', () => {
      const rows = [
        {
          url: 'https://a.com', hostname: 'a.com', content_type: 'web', execution_date: '2026-03-02', prompt: 'q1',
        },
        {
          url: 'https://b.com', hostname: 'b.com', content_type: 'pdf', execution_date: '2026-03-02', prompt: 'q2',
        },
      ];
      expect(aggregateDetailSources(rows)).to.have.lengthOf(2);
    });
  });

  // ── createTopicDetailHandler ────────────────────────────────────────────────
  describe('createTopicDetailHandler', () => {
    beforeEach(() => {
      mockContext.params.topicId = 'AI%20Overview';
    });

    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when org access check fails', async () => {
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view brand presence data'),
      );
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest for malformed percent-encoded topicId', async () => {
      mockContext.params.topicId = '%GG';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns ok with zeroed stats and empty arrays when no rows', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topic).to.equal('AI Overview');
      expect(body.weeklyStats).to.deep.equal([]);
      expect(body.executions).to.deep.equal([]);
      expect(body.sources).to.deep.equal([]);
      expect(body.stats.averageVisibilityScore).to.equal(0);
    });

    it('returns ok with zeroed stats when data is null', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null, error: null,
      });

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
    });

    it('returns badRequest when query returns error', async () => {
      mockContext.params.topicId = 'T';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: { message: 'db error' },
      });

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('filters by topics column using decoded topicId', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'AI%20Overview';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('topics', 'AI Overview');
    });

    it('filters by brand_id when brandId is a UUID', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000001';
      mockContext.params.topicId = 'T';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('brand_id', '0178a3f0-1234-7000-8000-000000000001');
    });

    it('returns executions sorted newest first and includes all mapped fields', async () => {
      const rows = [
        {
          id: 'exec-1',
          topics: 'AI Overview',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: false,
          // null values exercise the || '' and ternary fallback branches
          visibility_score: null,
          position: null,
          sentiment: null,
          volume: null,
          origin: null,
          category_name: null,
          execution_date: '2026-03-01',
          answer: 'Some answer',
          url: 'https://a.com',
          error_code: null,
        },
        {
          id: 'exec-2',
          topics: 'AI Overview',
          prompt: 'q2',
          region_code: 'US',
          mentions: false,
          citations: true,
          visibility_score: 50,
          position: '5',
          sentiment: 'Neutral',
          volume: '200',
          origin: 'paid',
          category_name: 'Ads',
          execution_date: '2026-03-08',
          answer: 'Another answer',
          url: 'https://b.com',
          error_code: 'E01',
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: rows, error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'AI%20Overview';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      // Sorted newest first
      expect(body.executions[0].executionDate).to.equal('2026-03-08');
      expect(body.executions[1].executionDate).to.equal('2026-03-01');
      expect(body.executions[0].prompt).to.equal('q2');
      expect(body.executions[0].mentions).to.equal(false);
      expect(body.executions[0].citations).to.equal(true);
      expect(body.executions[0].errorCode).to.equal('E01');
      expect(body.executions[1].visibilityScore).to.equal(0);
      expect(body.executions[1].position).to.equal('');
      expect(body.executions[1].sentiment).to.equal('');
      expect(body.executions[1].category).to.equal('');
      expect(body.weeklyStats.length).to.be.greaterThan(0);
    });

    it('aggregates sources from fetchSourcesForExecutions', async () => {
      const execRows = [
        {
          id: 'exec-1',
          topics: 'T',
          prompt: 'q1',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 80,
          position: '1',
          sentiment: 'Positive',
          volume: null,
          origin: 'organic',
          category_name: 'C',
          execution_date: '2026-03-02',
          answer: '',
          url: '',
          error_code: null,
        },
      ];
      const sourceRows = [
        {
          execution_id: 'exec-1',
          execution_date: '2026-03-02',
          content_type: 'web',
          url_id: 'u1',
          source_urls: { url: 'https://example.com', hostname: 'example.com' },
        },
        // null source_urls exercises the || {} fallback in flattenSourceRow
        {
          execution_id: 'exec-1',
          execution_date: null,
          content_type: null,
          url_id: 'u2',
          source_urls: null,
        },
        // unknown execution_id exercises exec?.prompt || '' in flattenSourceRow
        {
          execution_id: 'unknown-exec',
          execution_date: '2026-03-02',
          content_type: null,
          url_id: 'u3',
          source_urls: { url: 'https://other.com', hostname: null },
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: execRows, error: null },
        brand_presence_sources: { data: sourceRows, error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      // null source_urls row is skipped; unknown exec row adds a second entry
      expect(body.sources).to.have.lengthOf(2);
      const exampleSource = body.sources.find((s) => s.url === 'https://example.com');
      expect(exampleSource).to.exist;
      expect(exampleSource.citationCount).to.equal(1);
    });

    it('returns forbidden when siteId is provided but does not belong to org', async () => {
      mockContext.params.topicId = 'T';
      mockContext.data = { siteId: 'site-xyz' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('applies site_id filter when siteId passes org validation', async () => {
      const client = createChainableMock(
        { data: [], error: null },
        [
          { data: [{ id: 'site-123' }], error: null }, // site validation passes
          { data: [], error: null }, // exec rows query
        ],
      );
      mockContext.params.topicId = 'T';
      mockContext.data = { siteId: 'site-123' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(client.eq).to.have.been.calledWith('site_id', 'site-123');
    });

    it('applies regionCode and origin filters from ctx.data', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.data = { region: 'US', origin: 'organic' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('region_code', 'US');
      expect(client.ilike).to.have.been.calledWith('origin', 'organic');
    });

    it('uses empty-string fallback for null execution_date, prompt, region_code in execution map', async () => {
      const rows = [
        {
          id: null,
          topics: 'T',
          prompt: null,
          region_code: null,
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: null,
          volume: null,
          origin: null,
          category_name: null,
          execution_date: null,
          answer: null,
          url: null,
          error_code: null,
        },
        {
          id: null,
          topics: 'T',
          prompt: null,
          region_code: null,
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: null,
          volume: null,
          origin: null,
          category_name: null,
          execution_date: null,
          answer: null,
          url: null,
          error_code: null,
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: rows, error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createTopicDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.executions[0].prompt).to.equal('');
      expect(body.executions[0].region).to.equal('');
      expect(body.executions[0].executionDate).to.equal('');
    });
  });

  // ── createPromptDetailHandler ───────────────────────────────────────────────
  describe('createPromptDetailHandler', () => {
    beforeEach(() => {
      mockContext.params.topicId = 'AI%20Overview';
      mockContext.data = { prompt: 'What is AI?' };
    });

    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when org access check fails', async () => {
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view brand presence data'),
      );
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest for malformed percent-encoded topicId', async () => {
      mockContext.params.topicId = '%GG';
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when prompt parameter is missing', async () => {
      mockContext.data = {};
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest when ctx.data is null (prompt missing)', async () => {
      mockContext.data = null;
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns ok with zeroed stats when no rows', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topic).to.equal('AI Overview');
      expect(body.prompt).to.equal('What is AI?');
      expect(body.weeklyStats).to.deep.equal([]);
      expect(body.executions).to.deep.equal([]);
      expect(body.sources).to.deep.equal([]);
      expect(body.stats.visibilityScore).to.equal(0);
      expect(body.stats.mentions).to.equal(0);
    });

    it('returns ok with zeroed stats when data is null', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null, error: null,
      });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
    });

    it('returns badRequest when query returns error', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: { message: 'db error' },
      });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('filters by topics and prompt columns', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'AI%20Overview';
      mockContext.data = { prompt: 'What is AI?' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('topics', 'AI Overview');
      expect(client.eq).to.have.been.calledWith('prompt', 'What is AI?');
    });

    it('applies region_code filter when promptRegion is provided', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.data = { prompt: 'What is AI?', promptRegion: 'US' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('region_code', 'US');
    });

    it('applies regionCode and origin filters from ctx.data via buildDetailExecQuery', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.data = { prompt: 'What is AI?', region: 'DE', origin: 'paid' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('region_code', 'DE');
      expect(client.ilike).to.have.been.calledWith('origin', 'paid');
    });

    it('also accepts prompt_region (snake_case alias)', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.data = { prompt: 'What is AI?', prompt_region: 'DE' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('region_code', 'DE');
    });

    it('computes averaged stats and returns executions sorted newest first', async () => {
      const rows = [
        {
          id: 'e1',
          topics: 'AI Overview',
          prompt: 'What is AI?',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 80,
          position: '2',
          sentiment: 'Positive',
          volume: '100',
          origin: 'organic',
          category_name: 'Search',
          execution_date: '2026-03-01',
          answer: 'Answer A',
          url: 'https://a.com',
          error_code: null,
        },
        {
          id: 'e2',
          topics: 'AI Overview',
          prompt: 'What is AI?',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: 60,
          position: '4',
          sentiment: 'Neutral',
          volume: '50',
          origin: 'organic',
          category_name: 'Search',
          execution_date: '2026-03-08',
          answer: 'Answer B',
          url: '',
          error_code: null,
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: rows, error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.data = { prompt: 'What is AI?' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      // avg visibility: (80 + 60) / 2 = 70
      expect(body.stats.visibilityScore).to.equal(70);
      // avg position: (2 + 4) / 2 = 3
      expect(body.stats.position).to.equal('3');
      expect(body.stats.mentions).to.equal(1);
      expect(body.stats.citations).to.equal(1);
      // Sorted newest first
      expect(body.executions[0].executionDate).to.equal('2026-03-08');
      expect(body.executions[1].executionDate).to.equal('2026-03-01');
    });

    it('counts negative sentiment rows but scores them at 0', async () => {
      const rows = [
        {
          id: 'e1',
          topics: 'T',
          prompt: 'q',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: 'Negative',
          volume: null,
          origin: '',
          category_name: '',
          execution_date: '2026-03-02',
          answer: '',
          url: '',
          error_code: null,
        },
        {
          id: 'e2',
          topics: 'T',
          prompt: 'q',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: 'Positive',
          volume: null,
          origin: '',
          category_name: '',
          execution_date: '2026-03-02',
          answer: '',
          url: '',
          error_code: null,
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: rows, error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.data = { prompt: 'q' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      // (100 + 0) / 2 = 50
      expect(body.stats.sentiment).to.equal(50);
    });

    it('returns sentiment -1 when no sentiments present', async () => {
      const rows = [
        {
          id: 'e1',
          topics: 'T',
          prompt: 'q',
          region_code: 'US',
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: '',
          volume: null,
          origin: '',
          category_name: '',
          execution_date: '2026-03-02',
          answer: '',
          url: '',
          error_code: null,
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: rows, error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.data = { prompt: 'q' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.stats.sentiment).to.equal(-1);
    });

    it('filters by brand_id when brandId is a UUID', async () => {
      const client = createTableAwareMock({
        brand_presence_executions: { data: [], error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.brandId = '0178a3f0-1234-7000-8000-000000000002';
      mockContext.data = { prompt: 'What is AI?' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(client.eq).to.have.been.calledWith('brand_id', '0178a3f0-1234-7000-8000-000000000002');
    });

    it('returns forbidden when siteId does not belong to org', async () => {
      mockContext.data = { prompt: 'What is AI?', siteId: 'site-xyz' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock({ data: [], error: null });

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('uses empty-string fallback for null execution_date, prompt, region_code', async () => {
      const rows = [
        {
          id: 'e1',
          topics: 'T',
          prompt: null,
          region_code: null,
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: '',
          volume: null,
          origin: '',
          category_name: '',
          execution_date: null,
          answer: '',
          url: '',
          error_code: null,
        },
        {
          id: 'e2',
          topics: 'T',
          prompt: null,
          region_code: null,
          mentions: false,
          citations: false,
          visibility_score: null,
          position: null,
          sentiment: '',
          volume: null,
          origin: '',
          category_name: '',
          execution_date: null,
          answer: '',
          url: '',
          error_code: null,
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: rows, error: null },
        brand_presence_sources: { data: [], error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.data = { prompt: 'q' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.executions[0].prompt).to.equal('');
      expect(body.executions[0].region).to.equal('');
      expect(body.executions[0].executionDate).to.equal('');
    });

    it('includes sources aggregated from fetchSourcesForExecutions', async () => {
      const execRows = [
        {
          id: 'exec-1',
          topics: 'T',
          prompt: 'q',
          region_code: 'US',
          mentions: true,
          citations: true,
          visibility_score: 70,
          position: '2',
          sentiment: 'Positive',
          volume: null,
          origin: '',
          category_name: '',
          execution_date: '2026-03-02',
          answer: '',
          url: '',
          error_code: null,
        },
      ];
      const sourceRows = [
        {
          execution_id: 'exec-1',
          execution_date: '2026-03-02',
          content_type: 'pdf',
          url_id: 'u1',
          source_urls: { url: 'https://docs.example.com/guide', hostname: 'docs.example.com' },
        },
      ];
      const client = createTableAwareMock({
        brand_presence_executions: { data: execRows, error: null },
        brand_presence_sources: { data: sourceRows, error: null },
      });
      mockContext.params.topicId = 'T';
      mockContext.data = { prompt: 'q' };
      mockContext.dataAccess.Site.postgrestService = client;

      const handler = createPromptDetailHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      const body = await result.json();
      expect(body.sources).to.have.lengthOf(1);
      expect(body.sources[0].hostname).to.equal('docs.example.com');
      expect(body.sources[0].contentType).to.equal('pdf');
    });
  });
});
