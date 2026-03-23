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
  assembleResponse,
  createTrendingUrlsHandler,
} from '../../../src/controllers/llmo/llmo-url-inspector-trending-urls.js';

use(sinonChai);

function createRpcMock(rpcResolveValue = { data: [], error: null }) {
  const rpcStub = sinon.stub().resolves(rpcResolveValue);
  return { rpc: rpcStub };
}

function makeContext(overrides = {}) {
  return {
    params: { spaceCatId: '0178a3f0-1234-7000-8000-000000000001', brandId: 'all' },
    data: {
      siteId: 'site-001',
      startDate: '2026-01-01',
      endDate: '2026-03-01',
      ...overrides,
    },
    log: {
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
    },
    dataAccess: {
      Site: { postgrestService: null },
    },
  };
}

function makeRows({
  total = 2, urlA = 'https://competitor.com/page', urlB = 'https://other.com/page',
} = {}) {
  return [
    {
      total_non_owned_urls: total,
      url: urlA,
      content_type: 'competitor',
      prompt: 'best tools 2026',
      category: 'Software',
      region: 'US',
      topics: 'Software',
      citation_count: 5,
      execution_count: 2,
    },
    {
      total_non_owned_urls: total,
      url: urlA,
      content_type: 'competitor',
      prompt: 'top security software',
      category: 'Security',
      region: 'DE',
      topics: 'Security',
      citation_count: 3,
      execution_count: 1,
    },
    {
      total_non_owned_urls: total,
      url: urlB,
      content_type: 'earned',
      prompt: 'best tools 2026',
      category: 'Software',
      region: 'US',
      topics: 'Software',
      citation_count: 2,
      execution_count: 1,
    },
  ];
}

describe('llmo-url-inspector-trending-urls', () => {
  let sandbox;
  let getOrgAndValidateAccess;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('assembleResponse', () => {
    it('returns empty structure for null/empty input', () => {
      expect(assembleResponse(null)).to.deep.equal({ totalNonOwnedUrls: 0, urls: [] });
      expect(assembleResponse([])).to.deep.equal({ totalNonOwnedUrls: 0, urls: [] });
    });

    it('groups rows by URL with correct aggregation', () => {
      const rows = makeRows({ total: 50 });
      const result = assembleResponse(rows);

      expect(result.totalNonOwnedUrls).to.equal(50);
      expect(result.urls).to.have.lengthOf(2);

      const first = result.urls[0];
      expect(first.url).to.equal('https://competitor.com/page');
      expect(first.citations).to.equal(8);
      expect(first.promptsCited).to.equal(2);
      expect(first.products).to.include('Software');
      expect(first.products).to.include('Security');
      expect(first.regions).to.include('US');
      expect(first.regions).to.include('DE');
      expect(first.promptCitations).to.have.lengthOf(2);
    });

    it('sorts URLs by citations descending', () => {
      const rows = makeRows();
      const result = assembleResponse(rows);

      expect(result.urls[0].citations).to.be.greaterThanOrEqual(result.urls[1].citations);
    });

    it('maps competitor content type to others', () => {
      const rows = makeRows();
      const result = assembleResponse(rows);

      const competitorUrl = result.urls.find((u) => u.url === 'https://competitor.com/page');
      expect(competitorUrl.contentType).to.equal('others');
    });

    it('preserves earned content type', () => {
      const rows = makeRows();
      const result = assembleResponse(rows);

      const earnedUrl = result.urls.find((u) => u.url === 'https://other.com/page');
      expect(earnedUrl.contentType).to.equal('earned');
    });

    it('builds promptCitations with correct shape', () => {
      const rows = makeRows();
      const result = assembleResponse(rows);

      const { promptCitations } = result.urls[0];
      const firstPrompt = promptCitations[0];
      expect(firstPrompt).to.have.all.keys('prompt', 'count', 'id', 'products', 'topics', 'region', 'executionCount');
      expect(firstPrompt.prompt).to.equal('best tools 2026');
      expect(firstPrompt.count).to.equal(5);
      expect(firstPrompt.id).to.equal('Software_best tools 2026_US');
      expect(firstPrompt.products).to.deep.equal(['Software']);
      expect(firstPrompt.topics).to.equal('Software');
      expect(firstPrompt.region).to.equal('US');
      expect(firstPrompt.executionCount).to.equal(2);
    });

    it('handles rows with null category/region/topics', () => {
      const rows = [
        {
          total_non_owned_urls: 1,
          url: 'https://example.com',
          content_type: 'social',
          prompt: 'some prompt',
          category: null,
          region: null,
          topics: null,
          citation_count: 3,
          execution_count: 1,
        },
      ];
      const result = assembleResponse(rows);

      expect(result.urls).to.have.lengthOf(1);
      expect(result.urls[0].products).to.deep.equal([]);
      expect(result.urls[0].regions).to.deep.equal([]);
      expect(result.urls[0].promptCitations[0].id).to.equal('_some prompt_');
      expect(result.urls[0].promptCitations[0].topics).to.equal('');
      expect(result.urls[0].promptCitations[0].region).to.equal('');
    });

    it('handles rows with null/NaN numeric fields and null prompt', () => {
      const rows = [
        {
          total_non_owned_urls: null,
          url: 'https://example.com',
          content_type: 'earned',
          prompt: null,
          category: null,
          region: null,
          topics: null,
          citation_count: null,
          execution_count: null,
        },
      ];
      const result = assembleResponse(rows);

      expect(result.totalNonOwnedUrls).to.equal(0);
      expect(result.urls[0].citations).to.equal(0);
      expect(result.urls[0].promptCitations[0].count).to.equal(0);
      expect(result.urls[0].promptCitations[0].executionCount).to.equal(0);
      expect(result.urls[0].promptCitations[0].id).to.equal('__');
    });
  });

  describe('createTrendingUrlsHandler', () => {
    let mockContext;

    beforeEach(() => {
      mockContext = makeContext();
    });

    it('returns badRequest when postgrestService is missing', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = null;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(400);
    });

    it('returns forbidden when user has no org access', async () => {
      const rpcMock = createRpcMock();
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = rpcMock;
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view URL Inspector data'),
      );

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when siteId is missing', async () => {
      const rpcMock = createRpcMock();
      const ctx = makeContext();
      ctx.data = { startDate: '2026-01-01', endDate: '2026-03-01' };
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(400);
    });

    it('returns ok with empty structure when RPC returns no rows', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({ totalNonOwnedUrls: 0, urls: [] });
    });

    it('returns ok with grouped trending URLs on happy path', async () => {
      const rows = makeRows({ total: 100 });
      const rpcMock = createRpcMock({ data: rows, error: null });
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.totalNonOwnedUrls).to.equal(100);
      expect(body.urls).to.have.lengthOf(2);
      expect(body.urls[0].citations).to.equal(8);
      expect(body.urls[0].contentType).to.equal('others');
      expect(body.urls[1].contentType).to.equal('earned');

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_trending_urls',
        sinon.match.object,
      );
    });

    it('passes default limit of 2000 when not specified', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(ctx);

      const rpcArgs = rpcMock.rpc.firstCall.args[1];
      expect(rpcArgs.p_limit).to.equal(2000);
    });

    it('passes custom limit when specified', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      const ctx = makeContext({ limit: '500' });
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(ctx);

      const rpcArgs = rpcMock.rpc.firstCall.args[1];
      expect(rpcArgs.p_limit).to.equal(500);
    });

    it('maps channel filter "others" to "competitor" for DB query', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      const ctx = makeContext({ channel: 'others' });
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(ctx);

      const rpcArgs = rpcMock.rpc.firstCall.args[1];
      expect(rpcArgs.p_channel).to.equal('competitor');
    });

    it('passes null for skip-value filters', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      const ctx = makeContext({ category: 'all', region: '*', channel: '' });
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(ctx);

      const rpcArgs = rpcMock.rpc.firstCall.args[1];
      expect(rpcArgs.p_category).to.be.null;
      expect(rpcArgs.p_region).to.be.null;
      expect(rpcArgs.p_channel).to.be.null;
    });

    it('returns badRequest when RPC returns an error', async () => {
      const rpcMock = createRpcMock({
        data: null,
        error: { message: 'relation "brand_presence_sources" does not exist' },
      });
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('does not exist');
    });

    it('returns internalServerError when handler throws unexpectedly', async () => {
      const rpcMock = {
        rpc: sinon.stub().rejects(new Error('connection reset')),
      };
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      const result = await handler(ctx);

      expect(result.status).to.equal(500);
    });

    it('passes filter params correctly to RPC', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      const ctx = makeContext({
        category: 'Security',
        region: 'US',
        channel: 'earned',
        platform: 'chatgpt',
      });
      ctx.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(ctx);

      const rpcArgs = rpcMock.rpc.firstCall.args[1];
      expect(rpcArgs.p_site_id).to.equal('site-001');
      expect(rpcArgs.p_start_date).to.equal('2026-01-01');
      expect(rpcArgs.p_end_date).to.equal('2026-03-01');
      expect(rpcArgs.p_category).to.equal('Security');
      expect(rpcArgs.p_region).to.equal('US');
      expect(rpcArgs.p_channel).to.equal('earned');
      expect(rpcArgs.p_platform).to.equal('chatgpt');
    });

    it('passes brandId to RPC when a specific brand UUID is provided', async () => {
      const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
      const rpcMock = createRpcMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.params.brandId = brandUuid;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_trending_urls',
        sinon.match({ p_brand_id: brandUuid }),
      );
    });

    it('passes null p_brand_id when brandId is "all"', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createTrendingUrlsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_trending_urls',
        sinon.match({ p_brand_id: null }),
      );
    });
  });
});
