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
  createDomainDetailsHandler,
  dateToIsoWeek,
  aggregateDomainDetails,
} from '../../../src/controllers/llmo/llmo-url-inspector-domain-details.js';

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

function makeRow(
  url,
  prompt,
  citationCount,
  category,
  region,
  topics,
  week,
  contentType,
  normalizedUrlPath,
) {
  return {
    url,
    prompt,
    citation_count: citationCount,
    category,
    region,
    topics,
    week,
    content_type: contentType || 'competitor',
    normalized_url_path: normalizedUrlPath || null,
  };
}

const baseParams = {
  domain: 'competitor.com',
  urlLimit: 200,
};

describe('llmo-url-inspector-domain-details', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: { spaceCatId: '0178a3f0-1234-7000-8000-000000000001', brandId: 'all' },
      data: {
        siteId: 'site-001',
        domain: 'competitor.com',
      },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: { postgrestService: null },
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
  });

  // ── Aggregation logic ────────────────────────────────────────────────

  describe('aggregateDomainDetails', () => {
    it('returns zeroed response for empty rows', () => {
      const result = aggregateDomainDetails([], baseParams);

      expect(result.domain).to.equal('competitor.com');
      expect(result.totalCitations).to.equal(0);
      expect(result.totalUrls).to.equal(0);
      expect(result.promptsCited).to.equal(0);
      expect(result.contentType).to.equal('unknown');
      expect(result.urls).to.deep.equal([]);
      expect(result.totalUrlCount).to.equal(0);
      expect(result.weeklyTrends).to.deep.equal({
        weeklyDates: [],
        totalCitations: [],
        uniqueUrls: [],
        promptsCited: [],
        citationsPerUrl: [],
      });
      expect(result.urlPaths).to.deep.equal([]);
    });

    it('computes domain summary correctly (happy path)', () => {
      const rows = [
        makeRow('https://competitor.com/a', 'p1', 10, 'Software', 'US', 't1', '2026-W09', 'competitor'),
        makeRow('https://competitor.com/a', 'p2', 5, 'AI', 'UK', 't2', '2026-W09', 'competitor'),
        makeRow('https://competitor.com/b', 'p1', 8, 'Software', 'US', 't1', '2026-W10', 'competitor'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.totalCitations).to.equal(23);
      expect(result.totalUrls).to.equal(2);
      expect(result.promptsCited).to.equal(2);
      expect(result.contentType).to.equal('competitor');
    });

    it('picks most frequent content_type', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 5, 'A', 'US', 't', '2026-W09', 'owned'),
        makeRow('https://d.com/b', 'p2', 3, 'B', 'UK', 't', '2026-W09', 'competitor'),
        makeRow('https://d.com/c', 'p3', 4, 'C', 'DE', 't', '2026-W09', 'competitor'),
      ];
      const result = aggregateDomainDetails(rows, { ...baseParams, domain: 'd.com' });

      expect(result.contentType).to.equal('competitor');
    });

    it('builds per-URL breakdown sorted by citations descending', () => {
      const rows = [
        makeRow('https://d.com/low', 'p1', 2, 'A', 'US', 't', '2026-W09'),
        makeRow('https://d.com/high', 'p2', 10, 'B', 'UK', 't', '2026-W09'),
        makeRow('https://d.com/high', 'p3', 8, 'C', 'DE', 't', '2026-W10'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.urls).to.have.lengthOf(2);
      expect(result.urls[0].url).to.equal('https://d.com/high');
      expect(result.urls[0].citations).to.equal(18);
      expect(result.urls[0].promptsCited).to.equal(2);
      expect(result.urls[0].regions).to.include.members(['UK', 'DE']);
      expect(result.urls[0].categories).to.include.members(['B', 'C']);
      expect(result.urls[1].url).to.equal('https://d.com/low');
      expect(result.urls[1].citations).to.equal(2);
    });

    it('urlLimit caps urls array but totalUrlCount reflects full count', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 10, 'A', 'US', 't', '2026-W09'),
        makeRow('https://d.com/b', 'p2', 5, 'B', 'UK', 't', '2026-W09'),
        makeRow('https://d.com/c', 'p3', 3, 'C', 'DE', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, { ...baseParams, urlLimit: 2 });

      expect(result.totalUrlCount).to.equal(3);
      expect(result.urls).to.have.lengthOf(2);
      expect(result.urls[0].url).to.equal('https://d.com/a');
      expect(result.urls[1].url).to.equal('https://d.com/b');
    });

    it('defaults urlLimit to 200 when not specified', () => {
      const rows = Array.from({ length: 250 }, (_, i) => makeRow(`https://d.com/${i}`, `p${i}`, 250 - i, 'A', 'US', 't', '2026-W09'));
      const result = aggregateDomainDetails(rows, { domain: 'competitor.com' });

      expect(result.totalUrlCount).to.equal(250);
      expect(result.urls).to.have.lengthOf(200);
    });

    it('builds weekly trends as aligned parallel arrays', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 10, 'A', 'US', 't1', '2026-W10'),
        makeRow('https://d.com/b', 'p2', 5, 'B', 'UK', 't2', '2026-W09'),
        makeRow('https://d.com/a', 'p1', 8, 'A', 'US', 't1', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);
      const { weeklyTrends } = result;

      expect(weeklyTrends.weeklyDates).to.deep.equal(['2026-W09', '2026-W10']);
      expect(weeklyTrends.totalCitations).to.deep.equal([13, 10]);
      expect(weeklyTrends.uniqueUrls).to.deep.equal([2, 1]);
      expect(weeklyTrends.promptsCited).to.deep.equal([2, 1]);
      expect(weeklyTrends.citationsPerUrl).to.deep.equal([6.5, 10]);

      expect(weeklyTrends.weeklyDates).to.have.lengthOf(weeklyTrends.totalCitations.length);
      expect(weeklyTrends.totalCitations).to.have.lengthOf(weeklyTrends.uniqueUrls.length);
      expect(weeklyTrends.uniqueUrls).to.have.lengthOf(weeklyTrends.promptsCited.length);
      expect(weeklyTrends.promptsCited).to.have.lengthOf(weeklyTrends.citationsPerUrl.length);
    });

    it('computes citationsPerUrl correctly with rounding', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 7, 'A', 'US', 't', '2026-W09'),
        makeRow('https://d.com/b', 'p2', 3, 'B', 'UK', 't', '2026-W09'),
        makeRow('https://d.com/c', 'p3', 1, 'C', 'DE', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      // 11 citations / 3 urls = 3.666... → 3.7
      expect(result.weeklyTrends.citationsPerUrl[0]).to.equal(3.7);
    });

    it('extracts urlPaths from normalized_url_path when available', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 5, 'A', 'US', 't', '2026-W09', 'competitor', '/product-review'),
        makeRow('https://d.com/b', 'p2', 3, 'B', 'UK', 't', '2026-W09', 'competitor', '/pricing'),
        makeRow('https://d.com/c', 'p3', 1, 'C', 'DE', 't', '2026-W09', 'competitor', '/product-review'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.urlPaths).to.deep.equal(['/pricing', '/product-review']);
    });

    it('derives urlPaths from URL when normalized_url_path is missing', () => {
      const rows = [
        makeRow('https://d.com/product-review', 'p1', 5, 'A', 'US', 't', '2026-W09'),
        makeRow('https://d.com/pricing', 'p2', 3, 'B', 'UK', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.urlPaths).to.include('/product-review');
      expect(result.urlPaths).to.include('/pricing');
    });

    it('applies category filter to narrow results', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 10, 'Software', 'US', 't', '2026-W09'),
        makeRow('https://d.com/b', 'p2', 5, 'AI', 'UK', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, { ...baseParams, category: 'Software' });

      expect(result.totalCitations).to.equal(10);
      expect(result.urls).to.have.lengthOf(1);
      expect(result.urls[0].url).to.equal('https://d.com/a');
    });

    it('applies region filter to narrow results', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 10, 'A', 'US', 't', '2026-W09'),
        makeRow('https://d.com/b', 'p2', 5, 'B', 'UK', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, { ...baseParams, region: 'UK' });

      expect(result.totalCitations).to.equal(5);
      expect(result.urls).to.have.lengthOf(1);
    });

    it('applies channel filter to narrow results', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 10, 'A', 'US', 't', '2026-W09', 'owned'),
        makeRow('https://d.com/b', 'p2', 5, 'B', 'UK', 't', '2026-W09', 'competitor'),
      ];
      const result = aggregateDomainDetails(rows, { ...baseParams, channel: 'owned' });

      expect(result.totalCitations).to.equal(10);
      expect(result.contentType).to.equal('owned');
    });

    it('handles rows with null citation_count gracefully', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', null, 'A', 'US', 't', '2026-W09'),
        makeRow('https://d.com/b', 'p2', 5, 'B', 'UK', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.totalCitations).to.equal(5);
    });

    it('handles rows with null week by excluding from weekly trends', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 5, 'A', 'US', 't', null),
        makeRow('https://d.com/b', 'p2', 3, 'B', 'UK', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.weeklyTrends.weeklyDates).to.have.lengthOf(1);
      expect(result.totalCitations).to.equal(8);
    });

    it('excludes null/empty category and region from per-URL arrays', () => {
      const rows = [
        makeRow('https://d.com/a', 'p1', 5, null, null, 't', '2026-W09'),
        makeRow('https://d.com/a', 'p2', 3, 'Software', 'US', 't', '2026-W09'),
      ];
      const result = aggregateDomainDetails(rows, baseParams);

      expect(result.urls[0].categories).to.deep.equal(['Software']);
      expect(result.urls[0].regions).to.deep.equal(['US']);
    });
  });

  // ── Handler integration ──────────────────────────────────────────────

  describe('createDomainDetailsHandler', () => {
    it('returns 400 when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns 403 when user has no org access', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock();
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view URL Inspector data'),
      );

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns 400 when organization not found', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock();
      getOrgAndValidateAccess.rejects(new Error('Organization not found: x'));

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns 400 when siteId is missing', async () => {
      mockContext.data = { domain: 'competitor.com' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('siteId');
    });

    it('returns 400 when domain is missing', async () => {
      mockContext.data = { siteId: 'site-001' };
      mockContext.dataAccess.Site.postgrestService = createChainableMock();

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('domain');
    });

    it('returns 400 when PostgREST returns an error', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: { message: 'relation does not exist' },
      });

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation does not exist');
      expect(mockContext.log.error).to.have.been.calledOnce;
    });

    it('returns 200 with correct shape on happy path', async () => {
      const sourceRows = [
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://competitor.com/review', hostname: 'competitor.com' },
          brand_presence_executions: {
            prompt: 'best tools', category_name: 'Software', region_code: 'US', topics: 'pm',
          },
        },
        {
          content_type: 'competitor',
          execution_date: '2026-03-09',
          source_urls: { url: 'https://competitor.com/review', hostname: 'competitor.com' },
          brand_presence_executions: {
            prompt: 'best tools', category_name: 'Software', region_code: 'US', topics: 'pm',
          },
        },
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://competitor.com/pricing', hostname: 'competitor.com' },
          brand_presence_executions: {
            prompt: 'pricing compare', category_name: 'AI', region_code: 'UK', topics: 'ai',
          },
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: sourceRows,
        error: null,
      });

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.domain).to.equal('competitor.com');
      expect(body.totalCitations).to.equal(3);
      expect(body.totalUrls).to.equal(2);
      expect(body.promptsCited).to.equal(2);
      expect(body.contentType).to.equal('competitor');
      expect(body.urls).to.have.lengthOf(2);
      expect(body.urls[0].citations).to.be.at.least(body.urls[1].citations);
      expect(body.totalUrlCount).to.equal(2);
      expect(body.weeklyTrends.weeklyDates).to.have.lengthOf(2);
      expect(body.weeklyTrends.totalCitations).to.have.lengthOf(2);
      expect(body.urlPaths).to.include.members(['/review', '/pricing']);
    });

    it('returns 200 with zeroed response for empty result', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: [],
        error: null,
      });

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.totalCitations).to.equal(0);
      expect(body.totalUrls).to.equal(0);
      expect(body.urls).to.deep.equal([]);
      expect(body.totalUrlCount).to.equal(0);
      expect(body.weeklyTrends.weeklyDates).to.deep.equal([]);
      expect(body.urlPaths).to.deep.equal([]);
    });

    it('handles null data from PostgREST gracefully', async () => {
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: null,
        error: null,
      });

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.totalCitations).to.equal(0);
    });

    it('respects urlLimit query parameter', async () => {
      const sourceRows = [
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://d.com/a', hostname: 'd.com' },
          brand_presence_executions: {
            prompt: 'p1', category_name: 'A', region_code: 'US', topics: 't',
          },
        },
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://d.com/b', hostname: 'd.com' },
          brand_presence_executions: {
            prompt: 'p2', category_name: 'B', region_code: 'UK', topics: 't',
          },
        },
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://d.com/c', hostname: 'd.com' },
          brand_presence_executions: {
            prompt: 'p3', category_name: 'C', region_code: 'DE', topics: 't',
          },
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: sourceRows,
        error: null,
      });
      mockContext.data = { siteId: 'site-001', domain: 'competitor.com', urlLimit: '2' };

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.totalUrlCount).to.equal(3);
      expect(body.urls).to.have.lengthOf(2);
    });

    it('falls back to limit param when urlLimit not set', async () => {
      const sourceRows = [
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://d.com/a', hostname: 'd.com' },
          brand_presence_executions: {
            prompt: 'p1', category_name: 'A', region_code: 'US', topics: 't',
          },
        },
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://d.com/b', hostname: 'd.com' },
          brand_presence_executions: {
            prompt: 'p2', category_name: 'B', region_code: 'UK', topics: 't',
          },
        },
        {
          content_type: 'competitor',
          execution_date: '2026-03-02',
          source_urls: { url: 'https://d.com/c', hostname: 'd.com' },
          brand_presence_executions: {
            prompt: 'p3', category_name: 'C', region_code: 'DE', topics: 't',
          },
        },
      ];
      mockContext.dataAccess.Site.postgrestService = createChainableMock({
        data: sourceRows,
        error: null,
      });
      mockContext.data = { siteId: 'site-001', domain: 'competitor.com', limit: '1' };

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.totalUrlCount).to.equal(3);
      expect(body.urls).to.have.lengthOf(1);
    });

    it('queries the correct table and columns', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.from).to.have.been.calledWith('brand_presence_sources');
      expect(chainMock.select).to.have.been.calledWith(
        'content_type,execution_date,source_urls!inner(url,hostname),brand_presence_executions!inner(prompt,category_name,region_code,topics)',
      );
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'site-001');
      expect(chainMock.eq).to.have.been.calledWith('source_urls.hostname', 'competitor.com');
    });

    it('applies date range filters to execution_date', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        siteId: 'site-001',
        domain: 'competitor.com',
        startDate: '2026-03-02',
        endDate: '2026-03-15',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.gte).to.have.been.calledWith('execution_date', '2026-03-02');
      expect(chainMock.lte).to.have.been.calledWith('execution_date', '2026-03-15');
    });

    it('returns 500 when handler throws unexpectedly', async () => {
      const mock = {
        from: sinon.stub().throws(new Error('connection reset')),
      };
      mockContext.dataAccess.Site.postgrestService = mock;

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(500);
      expect(mockContext.log.error).to.have.been.called;
    });

    it('supports snake_case query param aliases', async () => {
      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.data = {
        site_id: 'site-001',
        domain: 'competitor.com',
        start_date: '2026-03-01',
        end_date: '2026-03-31',
      };
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(chainMock.eq).to.have.been.calledWith('site_id', 'site-001');
    });

    it('filters by brandId on the PostgREST query when a specific UUID is provided', async () => {
      const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
      mockContext.params.brandId = brandUuid;

      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(chainMock.eq).to.have.been.calledWith('brand_presence_executions.brand_id', brandUuid);
    });

    it('does not filter by brandId when brandId is "all"', async () => {
      mockContext.params.brandId = 'all';

      const chainMock = createChainableMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = chainMock;

      const handler = createDomainDetailsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      const eqCalls = chainMock.eq.getCalls().map((c) => c.args);
      const brandCall = eqCalls.find(([col]) => col === 'brand_presence_executions.brand_id');
      expect(brandCall).to.be.undefined;
    });
  });
});
