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
  createUrlDetailsHandler,
  dateToIsoWeek,
  parseIsoWeek,
  aggregateUrlDetails,
} from '../../../src/controllers/llmo/llmo-url-inspector-url-details.js';

use(sinonChai);

function createChainableMock(resolveValue = { data: [], error: null }) {
  const c = {
    from: sinon.stub().returnsThis(),
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    gte: sinon.stub().returnsThis(),
    lte: sinon.stub().returnsThis(),
    limit: sinon.stub().resolves(resolveValue),
    then(resolve) { return Promise.resolve(resolveValue).then(resolve); },
  };
  return c;
}

describe('llmo-url-inspector-url-details', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: {
        spaceCatId: '0178a3f0-1234-7000-8000-000000000001',
        brandId: 'all',
      },
      data: {
        siteId: 'site-001',
        url: 'https://example.com/product/page',
      },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: {
          postgrestService: null,
        },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  // ── Pure helpers ──────────────────────────────────────────────────────

  describe('dateToIsoWeek', () => {
    it('converts a Monday to the correct ISO week', () => {
      expect(dateToIsoWeek('2026-03-02')).to.equal('2026-W10');
    });

    it('converts a Sunday to the same week as its Monday', () => {
      expect(dateToIsoWeek('2026-03-08')).to.equal('2026-W10');
    });

    it('handles year boundary (Jan 1 2026 is W01)', () => {
      expect(dateToIsoWeek('2026-01-01')).to.equal('2026-W01');
    });

    it('handles late December that falls in week 1 of next year', () => {
      expect(dateToIsoWeek('2025-12-29')).to.equal('2026-W01');
    });
  });

  describe('parseIsoWeek', () => {
    it('extracts year and weekNumber from valid week string', () => {
      expect(parseIsoWeek('2026-W09')).to.deep.equal({ year: 2026, weekNumber: 9 });
    });

    it('returns zeroes for invalid format', () => {
      expect(parseIsoWeek('invalid')).to.deep.equal({ year: 0, weekNumber: 0 });
    });

    it('returns zeroes for null', () => {
      expect(parseIsoWeek(null)).to.deep.equal({ year: 0, weekNumber: 0 });
    });
  });

  // ── Aggregation logic ────────────────────────────────────────────────

  describe('aggregateUrlDetails', () => {
    const baseParams = {
      url: 'https://example.com/page',
      category: undefined,
      region: undefined,
      channel: undefined,
    };

    it('returns zeroed response for empty rows', () => {
      const result = aggregateUrlDetails([], baseParams);

      expect(result.url).to.equal('https://example.com/page');
      expect(result.isOwned).to.equal(false);
      expect(result.totalCitations).to.equal(0);
      expect(result.promptsCited).to.equal(0);
      expect(result.products).to.deep.equal([]);
      expect(result.regions).to.deep.equal([]);
      expect(result.promptCitations).to.deep.equal([]);
      expect(result.weeklyTrends).to.deep.equal([]);
    });

    it('determines isOwned=true when any row has content_type owned', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'Software', region: 'US', topics: 't1', week: '2026-W09',
        },
        {
          content_type: 'earned', prompt: 'p2', citation_count: 3, category: 'AI', region: 'UK', topics: 't2', week: '2026-W10',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.isOwned).to.equal(true);
    });

    it('determines isOwned=false when no row has content_type owned', () => {
      const rows = [
        {
          content_type: 'earned', prompt: 'p1', citation_count: 5, category: 'Software', region: 'US', topics: 't1', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.isOwned).to.equal(false);
    });

    it('computes totalCitations as sum of citation_count', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 10, category: 'A', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 15, category: 'B', region: 'UK', topics: 't', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.totalCitations).to.equal(25);
    });

    it('counts distinct prompt|region|topics combos for promptsCited', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'A', region: 'US', topics: 't1', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p1', citation_count: 3, category: 'A', region: 'US', topics: 't1', week: '2026-W10',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 7, category: 'B', region: 'UK', topics: 't2', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.promptsCited).to.equal(2);
    });

    it('collects unique products and regions', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 1, category: 'Software', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 1, category: 'AI Tools', region: 'UK', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p3', citation_count: 1, category: 'Software', region: 'US', topics: 't', week: '2026-W10',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.products).to.include.members(['Software', 'AI Tools']);
      expect(result.products).to.have.lengthOf(2);
      expect(result.regions).to.include.members(['US', 'UK']);
      expect(result.regions).to.have.lengthOf(2);
    });

    it('groups prompt citations and sorts by count descending', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'low prompt', citation_count: 2, category: 'A', region: 'US', topics: 'topic1', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'high prompt', citation_count: 10, category: 'B', region: 'UK', topics: 'topic2', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'high prompt', citation_count: 8, category: 'B', region: 'UK', topics: 'topic2', week: '2026-W10',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);

      expect(result.promptCitations).to.have.lengthOf(2);
      expect(result.promptCitations[0].prompt).to.equal('high prompt');
      expect(result.promptCitations[0].count).to.equal(18);
      expect(result.promptCitations[0].id).to.equal('topic2_high prompt_UK');
      expect(result.promptCitations[0].products).to.deep.equal(['B']);
      expect(result.promptCitations[0].topics).to.equal('topic2');
      expect(result.promptCitations[0].region).to.equal('UK');
      expect(result.promptCitations[1].prompt).to.equal('low prompt');
      expect(result.promptCitations[1].count).to.equal(2);
    });

    it('computes executionCount as number of distinct weeks per prompt group', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'A', region: 'US', topics: 't1', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p1', citation_count: 3, category: 'A', region: 'US', topics: 't1', week: '2026-W10',
        },
        {
          content_type: 'owned', prompt: 'p1', citation_count: 4, category: 'A', region: 'US', topics: 't1', week: '2026-W11',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);

      expect(result.promptCitations).to.have.lengthOf(1);
      expect(result.promptCitations[0].executionCount).to.equal(3);
      expect(result.promptCitations[0].count).to.equal(12);
    });

    it('builds weekly trends sorted chronologically with weekNumber and year', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 10, category: 'A', region: 'US', topics: 't1', week: '2026-W11',
        },
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'A', region: 'US', topics: 't1', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 7, category: 'B', region: 'UK', topics: 't2', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p1', citation_count: 8, category: 'A', region: 'US', topics: 't1', week: '2026-W10',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);

      expect(result.weeklyTrends).to.have.lengthOf(3);
      expect(result.weeklyTrends[0].week).to.equal('2026-W09');
      expect(result.weeklyTrends[0].totalCitations).to.equal(12);
      expect(result.weeklyTrends[0].totalPromptsCited).to.equal(2);
      expect(result.weeklyTrends[0].uniqueUrls).to.equal(1);
      expect(result.weeklyTrends[0].weekNumber).to.equal(9);
      expect(result.weeklyTrends[0].year).to.equal(2026);

      expect(result.weeklyTrends[1].week).to.equal('2026-W10');
      expect(result.weeklyTrends[1].totalCitations).to.equal(8);

      expect(result.weeklyTrends[2].week).to.equal('2026-W11');
      expect(result.weeklyTrends[2].totalCitations).to.equal(10);
    });

    it('sets uniqueUrls to 1 for all weekly trend entries', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'A', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p1', citation_count: 3, category: 'A', region: 'US', topics: 't', week: '2026-W10',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      result.weeklyTrends.forEach((w) => {
        expect(w.uniqueUrls).to.equal(1);
      });
    });

    it('applies channel filter but still determines isOwned from unfiltered data', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 10, category: 'A', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'earned', prompt: 'p2', citation_count: 5, category: 'B', region: 'UK', topics: 't', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, { ...baseParams, channel: 'earned' });

      expect(result.isOwned).to.equal(true);
      expect(result.totalCitations).to.equal(5);
      expect(result.promptCitations).to.have.lengthOf(1);
      expect(result.promptCitations[0].prompt).to.equal('p2');
    });

    it('applies category filter to narrow prompt citations', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 10, category: 'Software', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 5, category: 'AI Tools', region: 'UK', topics: 't', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, { ...baseParams, category: 'Software' });

      expect(result.totalCitations).to.equal(10);
      expect(result.promptCitations).to.have.lengthOf(1);
      expect(result.promptCitations[0].prompt).to.equal('p1');
    });

    it('applies region filter to narrow prompt citations', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 10, category: 'A', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 5, category: 'B', region: 'UK', topics: 't', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, { ...baseParams, region: 'UK' });

      expect(result.totalCitations).to.equal(5);
      expect(result.regions).to.deep.equal(['UK']);
    });

    it('handles rows with null citation_count gracefully', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: null, category: 'A', region: 'US', topics: 't', week: '2026-W09',
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 5, category: 'B', region: 'UK', topics: 't', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.totalCitations).to.equal(5);
    });

    it('defaults topics and region to empty string when null', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'A', region: null, topics: null, week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);

      expect(result.promptCitations).to.have.lengthOf(1);
      expect(result.promptCitations[0].topics).to.equal('');
      expect(result.promptCitations[0].region).to.equal('');
      expect(result.promptCitations[0].id).to.equal('null_p1_null');
    });

    it('handles rows with null week by excluding from weekly trends', () => {
      const rows = [
        {
          content_type: 'owned', prompt: 'p1', citation_count: 5, category: 'A', region: 'US', topics: 't', week: null,
        },
        {
          content_type: 'owned', prompt: 'p2', citation_count: 3, category: 'B', region: 'UK', topics: 't', week: '2026-W09',
        },
      ];
      const result = aggregateUrlDetails(rows, baseParams);
      expect(result.weeklyTrends).to.have.lengthOf(1);
      expect(result.totalCitations).to.equal(8);
    });
  });

  // ── Handler integration ──────────────────────────────────────────────

  describe('createUrlDetailsHandler', () => {
    it('returns 400 when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns 403 when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock();
      getOrgAndValidateAccess.rejects(new Error('Only users belonging to the organization can view URL Inspector data'));

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns 400 when siteId is missing', async () => {
      mockContext.data = { url: 'https://example.com/page' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('siteId');
    });

    it('returns 400 when url is missing', async () => {
      mockContext.data = { siteId: 'site-001' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('url');
    });

    it('returns 200 with correct shape for owned URL', async () => {
      const sourceRows = [
        {
          content_type: 'owned',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://example.com/product/page', hostname: 'example.com' },
          brand_presence_executions: {
            prompt: 'best tools', category_name: 'Software', region_code: 'US', topics: 'project management',
          },
        },
        {
          content_type: 'owned',
          execution_date: '2026-03-09',
          source_urls: { url: 'https://example.com/product/page', hostname: 'example.com' },
          brand_presence_executions: {
            prompt: 'best tools', category_name: 'Software', region_code: 'US', topics: 'project management',
          },
        },
        {
          content_type: 'owned',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://example.com/product/page', hostname: 'example.com' },
          brand_presence_executions: {
            prompt: 'top software', category_name: 'AI Tools', region_code: 'UK', topics: 'ai',
          },
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: sourceRows,
        error: null,
      });

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.url).to.equal('https://example.com/product/page');
      expect(body.isOwned).to.equal(true);
      expect(body.totalCitations).to.equal(3);
      expect(body.promptsCited).to.equal(2);
      expect(body.products).to.include.members(['Software', 'AI Tools']);
      expect(body.regions).to.include.members(['US', 'UK']);
      expect(body.promptCitations).to.have.lengthOf(2);
      expect(body.promptCitations[0].count).to.be.at.least(body.promptCitations[1].count);
      expect(body.weeklyTrends).to.have.lengthOf(2);
    });

    it('returns 200 with isOwned=false for non-owned URL', async () => {
      const sourceRows = [
        {
          content_type: 'earned',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://example.com/product/page', hostname: 'example.com' },
          brand_presence_executions: {
            prompt: 'p1', category_name: 'A', region_code: 'US', topics: 't',
          },
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: sourceRows,
        error: null,
      });

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.isOwned).to.equal(false);
    });

    it('returns 200 with zeroed response for empty result', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [],
        error: null,
      });

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.isOwned).to.equal(false);
      expect(body.totalCitations).to.equal(0);
      expect(body.promptsCited).to.equal(0);
      expect(body.promptCitations).to.deep.equal([]);
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('returns 400 when PostgREST returns an error', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: { message: 'relation does not exist' },
      });

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('applies date range filters to execution_date', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        siteId: 'site-001',
        url: 'https://example.com/page',
        startDate: '2026-03-02',
        endDate: '2026-03-15',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.gte).to.have.been.calledWith('execution_date', '2026-03-02');
      expect(chainMock.lte).to.have.been.calledWith('execution_date', '2026-03-15');
    });

    it('queries the correct table and columns', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.from).to.have.been.calledWith('brand_presence_sources');
      expect(chainMock.select).to.have.been.calledWith(
        'content_type,execution_date,source_urls!inner(url,hostname),brand_presence_executions!inner(prompt,category_name,region_code,topics)',
      );
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'site-001');
      expect(chainMock.eq).to.have.been.calledWith('source_urls.url', 'https://example.com/product/page');
    });

    it('filters by brandId on the PostgREST query when a specific UUID is provided', async () => {
      const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
      mockContext.params.brandId = brandUuid;

      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('brand_presence_executions.brand_id', brandUuid);
    });

    it('does not filter by brandId when brandId is "all"', async () => {
      mockContext.params.brandId = 'all';

      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const eqCalls = chainMock.eq.getCalls().map((c) => c.args);
      const brandCall = eqCalls.find(([col]) => col === 'brand_presence_executions.brand_id');
      expect(brandCall).to.be.undefined;
    });

    it('handles null data from PostgREST gracefully', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: null,
      });

      const handler = createUrlDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.totalCitations).to.equal(0);
    });
  });
});
