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
  buildPromptKey,
  createBrandPresenceWeeksHandler,
  createFilterDimensionsHandler,
  createSentimentOverviewHandler,
  getWeekDateRange,
  resolveSiteIds,
  strCompare,
  toFilterOption,
  toISOWeek,
  validateSiteBelongsToOrg,
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
        topic_id: 't1',
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
      expect(chainMock.limit).to.have.been.calledWith(5000);
    });

    it('returns ok with brands, categories, topics, origins, regions, page_intents', async () => {
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
          {
            brand_id: '0178a3f0-1234-7000-8000-000000000003',
            brand_name: 'Brand B',
            category_name: 'Cat2',
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
      expect(body.origins).to.have.lengthOf(2);
      expect(body.regions).to.have.lengthOf(2);
      expect(body.page_intents).to.have.lengthOf(2);
      expect(body.page_intents[0]).to.have.property('id');
      expect(body.page_intents[0]).to.have.property('label');
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

    it('filters by topicId when provided', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topicId: 'combine pdf' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('topics', 'combine pdf');
    });

    it('accepts topic/topics as fallback for topicId', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = { topic: 'combine pdf' };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createFilterDimensionsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('topics', 'combine pdf');
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
});
