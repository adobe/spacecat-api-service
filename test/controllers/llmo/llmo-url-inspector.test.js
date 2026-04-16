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
  createUrlInspectorStatsHandler,
  createUrlInspectorOwnedUrlsHandler,
  createUrlInspectorTrendingUrlsHandler,
  createUrlInspectorCitedDomainsHandler,
  createUrlInspectorDomainUrlsHandler,
  createUrlInspectorUrlPromptsHandler,
} from '../../../src/controllers/llmo/llmo-url-inspector.js';

use(sinonChai);

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ID = '22222222-2222-2222-2222-222222222222';
const BRAND_ID = '33333333-3333-3333-3333-333333333333';

function createRpcMock(rpcResults = {}, defaultResult = { data: [], error: null }) {
  const rpcStub = sinon.stub().callsFake((fnName, params) => {
    const result = typeof rpcResults[fnName] === 'function'
      ? rpcResults[fnName](params)
      : (rpcResults[fnName] ?? defaultResult);
    return Promise.resolve(result);
  });

  // validateSiteBelongsToOrg uses .from().select().eq().eq().limit()
  const limitStub = sinon.stub().resolves({ data: [{ id: SITE_ID }], error: null });
  const client = {
    rpc: rpcStub,
    from: sinon.stub().returns({
      select: sinon.stub().returns({
        eq: sinon.stub().returns({
          eq: sinon.stub().returns({
            limit: limitStub,
          }),
        }),
      }),
    }),
  };

  return { client, rpcStub, limitStub };
}

function createContext(params = {}, data = {}, overrides = {}) {
  const { client, rpcStub, limitStub } = createRpcMock(overrides.rpcResults);
  return {
    context: {
      params: { spaceCatId: ORG_ID, brandId: 'all', ...params },
      data: { siteId: SITE_ID, ...data },
      log: { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() },
      dataAccess: {
        Site: { postgrestService: client },
        Organization: {
          findById: sinon.stub().resolves({
            getId: () => ORG_ID,
            getImsOrgId: () => 'ims-org',
          }),
        },
      },
    },
    client,
    rpcStub,
    limitStub,
  };
}

function getOrgAndValidateAccess() {
  return async () => ({ organization: { getId: () => ORG_ID } });
}

describe('URL Inspector Handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('createUrlInspectorStatsHandler', () => {
    it('returns stats and weekly trends on success', async () => {
      const rpcData = [
        {
          week: null,
          total_prompts_cited: 10,
          total_prompts: 50,
          unique_urls: 5,
          total_citations: 100,
        },
        {
          week: '2026-W10', total_prompts_cited: 4, total_prompts: 20, unique_urls: 3, total_citations: 40,
        },
        {
          week: '2026-W11', total_prompts_cited: 6, total_prompts: 30, unique_urls: 4, total_citations: 60,
        },
      ];

      const { context, rpcStub } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_stats: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.stats.totalPromptsCited).to.equal(10);
      expect(body.stats.totalPrompts).to.equal(50);
      expect(body.stats.uniqueUrls).to.equal(5);
      expect(body.stats.totalCitations).to.equal(100);
      expect(body.weeklyTrends).to.have.length(2);
      expect(body.weeklyTrends[0].week).to.equal('2026-W10');
      expect(rpcStub).to.have.been.calledWith('rpc_url_inspector_stats');
    });

    it('returns badRequest when siteId is missing', async () => {
      const { context } = createContext({}, { siteId: undefined });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns forbidden when site does not belong to org', async () => {
      const { context, limitStub } = createContext();
      limitStub.resolves({ data: [], error: null }); // site not found in org

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns internalServerError on RPC error without leaking details', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: {
          rpc_url_inspector_stats: { data: null, error: { message: 'pq: column "x" does not exist' } },
        },
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.not.include('pq:');
    });

    it('returns empty stats when RPC returns empty data', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_stats: { data: [], error: null } },
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.stats.totalPromptsCited).to.equal(0);
      expect(body.weeklyTrends).to.have.length(0);
    });

    it('passes brandId filter when brandId is not "all"', async () => {
      const { context, rpcStub } = createContext(
        { brandId: BRAND_ID },
        {},
        { rpcResults: { rpc_url_inspector_stats: { data: [], error: null } } },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_brand_id).to.equal(BRAND_ID);
    });

    it('passes null for platform when not provided', async () => {
      const { context, rpcStub } = createContext(
        {},
        {},
        { rpcResults: { rpc_url_inspector_stats: { data: [], error: null } } },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_platform).to.equal(null);
    });

    it('passes valid model to RPC when platform is provided', async () => {
      const { context, rpcStub } = createContext(
        {},
        { platform: 'perplexity' },
        { rpcResults: { rpc_url_inspector_stats: { data: [], error: null } } },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_platform).to.equal('perplexity');
    });

    it('passes category and region filters to RPC', async () => {
      const { context, rpcStub } = createContext(
        {},
        {
          categoryId: 'cat-1', regionCode: 'US', startDate: '2026-01-01', endDate: '2026-02-01',
        },
        { rpcResults: { rpc_url_inspector_stats: { data: [], error: null } } },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_category).to.equal('cat-1');
      expect(rpcCall.args[1].p_region).to.equal('US');
      expect(rpcCall.args[1].p_start_date).to.equal('2026-01-01');
      expect(rpcCall.args[1].p_end_date).to.equal('2026-02-01');
    });

    it('handles weekly rows with null fields', async () => {
      const rpcData = [
        {
          week: '2026-W10',
          total_prompts_cited: null,
          total_prompts: null,
          unique_urls: null,
          total_citations: null,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_stats: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(body.stats.totalPromptsCited).to.equal(0);
      expect(body.weeklyTrends).to.have.length(1);
      expect(body.weeklyTrends[0].totalPromptsCited).to.equal(0);
      expect(body.weeklyTrends[0].totalPrompts).to.equal(0);
      expect(body.weeklyTrends[0].uniqueUrls).to.equal(0);
      expect(body.weeklyTrends[0].totalCitations).to.equal(0);
    });
  });

  describe('createUrlInspectorOwnedUrlsHandler', () => {
    it('returns paginated owned URLs', async () => {
      const rpcData = [
        {
          url: 'https://example.com/page1',
          citations: 42,
          prompts_cited: 12,
          products: ['Category A'],
          regions: ['US', 'DE'],
          weekly_citations: [{ week: '2026-W10', value: 20 }],
          weekly_prompts_cited: [{ week: '2026-W10', value: 5 }],
          total_count: 100,
        },
        {
          url: 'https://example.com/page2',
          citations: 30,
          prompts_cited: 8,
          products: ['Category B'],
          regions: ['US'],
          weekly_citations: [{ week: '2026-W10', value: 15 }],
          weekly_prompts_cited: [{ week: '2026-W10', value: 4 }],
          total_count: 100,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_owned_urls: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(2);
      expect(body.totalCount).to.equal(100);
      expect(body.urls[0].url).to.equal('https://example.com/page1');
      expect(body.urls[0].citations).to.equal(42);
      expect(body.urls[0].weeklyCitations).to.deep.equal([{ week: '2026-W10', value: 20 }]);
    });

    it('returns empty result when no data', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } },
      });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(0);
      expect(body.totalCount).to.equal(0);
    });

    it('passes pagination params to RPC', async () => {
      const { context, rpcStub } = createContext(
        {},
        { page: '2', pageSize: '25' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_limit).to.equal(25);
      expect(rpcCall.args[1].p_offset).to.equal(50); // page 2 * pageSize 25
    });

    it('returns badRequest when siteId is missing', async () => {
      const { context } = createContext({}, { siteId: undefined });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns forbidden when site does not belong to org', async () => {
      const { context, limitStub } = createContext();
      limitStub.resolves({ data: [], error: null });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns badRequest for invalid model', async () => {
      const { context } = createContext({}, { platform: 'bad-model' });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns internalServerError on RPC error', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: {
          rpc_url_inspector_owned_urls: { data: null, error: { message: 'RPC failed' } },
        },
      });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
    });

    it('passes filters and handles null row fields', async () => {
      const rpcData = [{
        url: 'https://example.com/page1',
        citations: null,
        prompts_cited: null,
        products: null,
        regions: null,
        weekly_citations: null,
        weekly_prompts_cited: null,
        total_count: null,
      }];

      const { context, rpcStub } = createContext(
        { brandId: BRAND_ID },
        { categoryId: 'cat-1', regionCode: 'US' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: rpcData, error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls[0].citations).to.equal(0);
      expect(body.urls[0].promptsCited).to.equal(0);
      expect(body.urls[0].products).to.deep.equal([]);
      expect(body.urls[0].regions).to.deep.equal([]);
      expect(body.urls[0].weeklyCitations).to.deep.equal([]);
      expect(body.urls[0].weeklyPromptsCited).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_brand_id).to.equal(BRAND_ID);
      expect(rpcCall.args[1].p_category).to.equal('cat-1');
      expect(rpcCall.args[1].p_region).to.equal('US');
    });
  });

  describe('createUrlInspectorTrendingUrlsHandler', () => {
    it('groups flat rows by URL with nested prompts', async () => {
      const rpcData = [
        {
          total_non_owned_urls: 500,
          url: 'https://competitor.com/a',
          content_type: 'earned',
          prompt: 'What is X?',
          category: 'Category A',
          region: 'US',
          topics: 'Topic 1',
          citation_count: 30,
          execution_count: 5,
        },
        {
          total_non_owned_urls: 500,
          url: 'https://competitor.com/a',
          content_type: 'earned',
          prompt: 'How does Y work?',
          category: 'Category A',
          region: 'DE',
          topics: 'Topic 2',
          citation_count: 25,
          execution_count: 3,
        },
        {
          total_non_owned_urls: 500,
          url: 'https://other.com/b',
          content_type: 'social',
          prompt: 'What is Z?',
          category: 'Category B',
          region: 'US',
          topics: 'Topic 1',
          citation_count: 10,
          execution_count: 2,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_trending_urls: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.totalNonOwnedUrls).to.equal(500);
      expect(body.urls).to.have.length(2);

      // First URL: competitor.com/a has 2 prompts
      const url1 = body.urls.find((u) => u.url === 'https://competitor.com/a');
      expect(url1.contentType).to.equal('earned');
      expect(url1.prompts).to.have.length(2);
      expect(url1.totalCitations).to.equal(55); // 30 + 25
      expect(url1.prompts[0].prompt).to.equal('What is X?');
      expect(url1.prompts[1].prompt).to.equal('How does Y work?');

      // Second URL: other.com/b has 1 prompt
      const url2 = body.urls.find((u) => u.url === 'https://other.com/b');
      expect(url2.contentType).to.equal('social');
      expect(url2.prompts).to.have.length(1);
      expect(url2.totalCitations).to.equal(10);
    });

    it('handles single URL with single prompt', async () => {
      const rpcData = [
        {
          total_non_owned_urls: 1,
          url: 'https://example.com',
          content_type: 'competitor',
          prompt: 'Test prompt',
          category: 'Cat',
          region: 'US',
          topics: 'Topic',
          citation_count: 5,
          execution_count: 1,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_trending_urls: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(body.urls).to.have.length(1);
      expect(body.urls[0].prompts).to.have.length(1);
      expect(body.urls[0].totalCitations).to.equal(5);
    });

    it('returns empty when no data', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_trending_urls: { data: [], error: null } },
      });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(0);
      expect(body.totalNonOwnedUrls).to.equal(0);
    });

    it('passes channel filter to RPC', async () => {
      const { context, rpcStub } = createContext(
        {},
        { channel: 'earned' },
        { rpcResults: { rpc_url_inspector_trending_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_channel).to.equal('earned');
    });

    it('returns badRequest when siteId is missing', async () => {
      const { context } = createContext({}, { siteId: undefined });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns forbidden when site does not belong to org', async () => {
      const { context, limitStub } = createContext();
      limitStub.resolves({ data: [], error: null });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns badRequest for invalid model', async () => {
      const { context } = createContext({}, { platform: 'bad-model' });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns internalServerError on RPC error', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: {
          rpc_url_inspector_trending_urls: { data: null, error: { message: 'RPC failed' } },
        },
      });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
    });

    it('passes brandId, selectedChannel and filters out null URL rows', async () => {
      const rpcData = [
        {
          total_non_owned_urls: 1,
          url: null,
          content_type: null,
          prompt: null,
          category: null,
          region: null,
          topics: null,
          citation_count: null,
          execution_count: null,
        },
        {
          total_non_owned_urls: 1,
          url: 'https://valid.com',
          content_type: 'earned',
          prompt: 'test',
          category: 'Cat',
          region: 'DE',
          topics: 'Topic',
          citation_count: 5,
          execution_count: 1,
        },
      ];

      const { context, rpcStub } = createContext(
        { brandId: BRAND_ID },
        { selectedChannel: 'social', categoryId: 'cat-1', regionCode: 'DE' },
        { rpcResults: { rpc_url_inspector_trending_urls: { data: rpcData, error: null } } },
      );

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(1);
      expect(body.urls[0].url).to.equal('https://valid.com');
      expect(body.urls[0].totalCitations).to.equal(5);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_brand_id).to.equal(BRAND_ID);
      expect(rpcCall.args[1].p_channel).to.equal('social');
      expect(rpcCall.args[1].p_category).to.equal('cat-1');
      expect(rpcCall.args[1].p_region).to.equal('DE');
    });
  });

  describe('createUrlInspectorCitedDomainsHandler', () => {
    it('returns cited domains', async () => {
      const rpcData = [
        {
          domain: 'example.com',
          total_citations: 100,
          total_urls: 25,
          prompts_cited: 15,
          content_type: 'earned',
          categories: 'Cat A,Cat B',
          regions: 'US,DE',
          total_count: 2,
        },
        {
          domain: 'other.com',
          total_citations: 50,
          total_urls: 10,
          prompts_cited: 8,
          content_type: 'social',
          categories: 'Cat A',
          regions: 'US',
          total_count: 2,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_cited_domains: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.domains).to.have.length(2);
      expect(body.totalCount).to.equal(2);
      expect(body.domains[0].domain).to.equal('example.com');
      expect(body.domains[0].totalCitations).to.equal(100);
      expect(body.domains[0].contentType).to.equal('earned');
    });

    it('returns badRequest when siteId is missing', async () => {
      const { context } = createContext({}, { siteId: undefined });

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns badRequest when PostgREST is not available', async () => {
      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());

      const context = {
        params: { spaceCatId: ORG_ID, brandId: 'all' },
        data: { siteId: SITE_ID },
        log: { error: sinon.stub() },
        dataAccess: {
          Site: { postgrestService: null },
          Organization: {
            findById: sinon.stub().resolves({ getId: () => ORG_ID }),
          },
        },
      };

      const response = await handler(context);
      expect(response.status).to.equal(400);
    });

    it('returns forbidden when site does not belong to org', async () => {
      const { context, limitStub } = createContext();
      limitStub.resolves({ data: [], error: null });

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns badRequest for invalid model', async () => {
      const { context } = createContext({}, { platform: 'bad-model' });

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns internalServerError on RPC error', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: {
          rpc_url_inspector_cited_domains: { data: null, error: { message: 'RPC failed' } },
        },
      });

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
    });

    it('passes brandId, channel filters and handles null row fields', async () => {
      const rpcData = [{
        domain: null,
        total_citations: null,
        total_urls: null,
        prompts_cited: null,
        content_type: null,
        categories: null,
        regions: null,
        total_count: null,
      }];

      const { context, rpcStub } = createContext(
        { brandId: BRAND_ID },
        { channel: 'earned', categoryId: 'cat-1', regionCode: 'US' },
        { rpcResults: { rpc_url_inspector_cited_domains: { data: rpcData, error: null } } },
      );

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.domains[0].domain).to.equal('');
      expect(body.domains[0].totalCitations).to.equal(0);
      expect(body.domains[0].totalUrls).to.equal(0);
      expect(body.domains[0].contentType).to.equal('');
      expect(body.totalCount).to.equal(0);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_brand_id).to.equal(BRAND_ID);
      expect(rpcCall.args[1].p_channel).to.equal('earned');
    });
  });

  describe('createUrlInspectorDomainUrlsHandler', () => {
    it('returns paginated URLs for a domain', async () => {
      const rpcData = [
        {
          url: 'https://example.com/page1',
          content_type: 'earned',
          citations: 42,
          total_count: 100,
        },
        {
          url: 'https://example.com/page2',
          content_type: 'earned',
          citations: 30,
          total_count: 100,
        },
      ];

      const { context } = createContext(
        {},
        { hostname: 'example.com' },
        {
          rpcResults: {
            rpc_url_inspector_domain_urls: {
              data: rpcData,
              error: null,
            },
          },
        },
      );

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(2);
      expect(body.totalCount).to.equal(100);
      expect(body.urls[0].url).to.equal('https://example.com/page1');
      expect(body.urls[0].citations).to.equal(42);
    });

    it('returns badRequest when hostname is missing', async () => {
      const { context } = createContext({}, { hostname: undefined });

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns badRequest when siteId is missing', async () => {
      const { context } = createContext(
        {},
        { siteId: undefined, hostname: 'example.com' },
      );

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns forbidden when site not in org', async () => {
      const { context, limitStub } = createContext(
        {},
        { hostname: 'example.com' },
      );
      limitStub.resolves({ data: [], error: null });

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns internalServerError on RPC error', async () => {
      const { context } = createContext(
        {},
        { hostname: 'example.com' },
        {
          rpcResults: {
            rpc_url_inspector_domain_urls: {
              data: null,
              error: { message: 'RPC failed' },
            },
          },
        },
      );

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(500);
    });

    it('returns badRequest for invalid model', async () => {
      const { context } = createContext(
        {},
        { hostname: 'example.com', platform: 'bad-model' },
      );

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('uses domain alias and selectedChannel, handles null row fields', async () => {
      const rpcData = [{
        url_id: null,
        url: null,
        content_type: null,
        citations: null,
        total_count: null,
      }];

      const { context, rpcStub } = createContext(
        {},
        { domain: 'example.com', selectedChannel: 'social' },
        {
          rpcResults: {
            rpc_url_inspector_domain_urls: { data: rpcData, error: null },
          },
        },
      );

      const handler = createUrlInspectorDomainUrlsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls[0].urlId).to.equal('');
      expect(body.urls[0].url).to.equal('');
      expect(body.urls[0].contentType).to.equal('');
      expect(body.urls[0].citations).to.equal(0);
      expect(body.totalCount).to.equal(0);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_hostname).to.equal('example.com');
      expect(rpcCall.args[1].p_channel).to.equal('social');
    });
  });

  describe('createUrlInspectorUrlPromptsHandler', () => {
    it('returns prompt breakdown for a URL', async () => {
      const rpcData = [
        {
          prompt: 'What is X?',
          category: 'Cat A',
          region: 'US',
          topics: 'Topic 1',
          citations: 15,
        },
        {
          prompt: 'How does Y work?',
          category: 'Cat B',
          region: 'DE',
          topics: 'Topic 2',
          citations: 8,
        },
      ];

      const urlId = '44444444-4444-4444-4444-444444444444';
      const { context } = createContext(
        {},
        { urlId },
        {
          rpcResults: {
            rpc_url_inspector_url_prompts: {
              data: rpcData,
              error: null,
            },
          },
        },
      );

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.prompts).to.have.length(2);
      expect(body.prompts[0].prompt).to.equal('What is X?');
      expect(body.prompts[0].citations).to.equal(15);
    });

    it('returns badRequest when urlId is missing', async () => {
      const { context } = createContext({}, { urlId: undefined });

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns forbidden when site not in org', async () => {
      const urlId = '44444444-4444-4444-4444-444444444444';
      const { context, limitStub } = createContext({}, { urlId });
      limitStub.resolves({ data: [], error: null });

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns badRequest when siteId is missing', async () => {
      const urlId = '44444444-4444-4444-4444-444444444444';
      const { context } = createContext({}, { siteId: undefined, urlId });

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns badRequest for invalid model', async () => {
      const urlId = '44444444-4444-4444-4444-444444444444';
      const { context } = createContext({}, { urlId, platform: 'bad-model' });

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns internalServerError on RPC error', async () => {
      const urlId = '44444444-4444-4444-4444-444444444444';
      const { context } = createContext(
        {},
        { urlId },
        {
          rpcResults: {
            rpc_url_inspector_url_prompts: {
              data: null,
              error: { message: 'RPC failed' },
            },
          },
        },
      );

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(500);
    });

    it('uses url_id alias and handles null row fields', async () => {
      const urlId = '44444444-4444-4444-4444-444444444444';
      const rpcData = [{
        prompt: null,
        category: null,
        region: null,
        topics: null,
        citations: null,
      }];

      const { context, rpcStub } = createContext(
        {},
        { url_id: urlId, startDate: '2026-01-01', endDate: '2026-02-01' },
        {
          rpcResults: {
            rpc_url_inspector_url_prompts: { data: rpcData, error: null },
          },
        },
      );

      const handler = createUrlInspectorUrlPromptsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.prompts[0].prompt).to.equal('');
      expect(body.prompts[0].category).to.equal('');
      expect(body.prompts[0].region).to.equal('');
      expect(body.prompts[0].topics).to.equal('');
      expect(body.prompts[0].citations).to.equal(0);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_url_id).to.equal(urlId);
      expect(rpcCall.args[1].p_start_date).to.equal('2026-01-01');
    });
  });

  describe('null data from RPC', () => {
    it('stats handles null data from RPC gracefully', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_stats: { data: null, error: null } },
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.stats.totalPromptsCited).to.equal(0);
    });

    it('owned-urls handles null data from RPC gracefully', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_owned_urls: { data: null, error: null } },
      });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(0);
      expect(body.totalCount).to.equal(0);
    });

    it('trending-urls handles null data from RPC gracefully', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_trending_urls: { data: null, error: null } },
      });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(0);
      expect(body.totalNonOwnedUrls).to.equal(0);
    });

    it('cited-domains handles null data from RPC gracefully', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_cited_domains: { data: null, error: null } },
      });

      const handler = createUrlInspectorCitedDomainsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.domains).to.have.length(0);
      expect(body.totalCount).to.equal(0);
    });

    it('domain-urls handles null data from RPC gracefully', async () => {
      const { context } = createContext(
        {},
        { hostname: 'example.com' },
        {
          rpcResults: {
            rpc_url_inspector_domain_urls: { data: null, error: null },
          },
        },
      );

      const handler = createUrlInspectorDomainUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls).to.have.length(0);
      expect(body.totalCount).to.equal(0);
    });

    it('url-prompts handles null data from RPC gracefully', async () => {
      const urlId = '44444444-4444-4444-4444-444444444444';
      const { context } = createContext(
        {},
        { urlId },
        {
          rpcResults: {
            rpc_url_inspector_url_prompts: { data: null, error: null },
          },
        },
      );

      const handler = createUrlInspectorUrlPromptsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.prompts).to.have.length(0);
    });
  });

  describe('platform validation', () => {
    it('returns badRequest for invalid platform value', async () => {
      const { context } = createContext(
        {},
        { platform: 'invalid-model-name' },
        {
          rpcResults: {
            rpc_url_inspector_stats: {
              data: [],
              error: null,
            },
          },
        },
      );

      const handler = createUrlInspectorStatsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });
  });
});
