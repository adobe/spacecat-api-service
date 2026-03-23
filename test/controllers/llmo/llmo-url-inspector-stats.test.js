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
import { createStatsHandler } from '../../../src/controllers/llmo/llmo-url-inspector-stats.js';

use(sinonChai);

const SITE_ID = '0178a3f0-1234-7000-8000-000000000001';
const ORG_ID = '0178a3f0-aaaa-7000-8000-000000000001';

const aggRow = {
  week: null,
  week_number: null,
  year_val: null,
  total_prompts_cited: 42,
  total_prompts: 120,
  unique_urls: 15,
  total_citations: 200,
};

const week1Row = {
  week: '2026-W10',
  week_number: 10,
  year_val: 2026,
  total_prompts_cited: 20,
  total_prompts: 60,
  unique_urls: 8,
  total_citations: 95,
};

const week2Row = {
  week: '2026-W11',
  week_number: 11,
  year_val: 2026,
  total_prompts_cited: 22,
  total_prompts: 60,
  unique_urls: 10,
  total_citations: 105,
};

function createRpcMock(resolveValue = { data: [], error: null }) {
  return {
    rpc: sinon.stub().resolves(resolveValue),
  };
}

describe('llmo-url-inspector-stats', () => {
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

  describe('createStatsHandler', () => {
    it('returns badRequest when postgrestService is missing', async () => {
      mockContext.dataAccess.Site.postgrestService = null;
      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(getOrgAndValidateAccess).not.to.have.been.called;
    });

    it('returns forbidden when user has no org access', async () => {
      const rpcMock = createRpcMock();
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      getOrgAndValidateAccess.rejects(
        new Error('Only users belonging to the organization can view URL Inspector data'),
      );

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns badRequest when organization not found', async () => {
      const rpcMock = createRpcMock();
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      getOrgAndValidateAccess.rejects(new Error('Organization not found: x'));

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns badRequest for generic org-validation errors', async () => {
      const rpcMock = createRpcMock();
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      getOrgAndValidateAccess.rejects(new Error('unexpected database failure'));

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      expect(mockContext.log.error).to.have.been.called;
    });

    it('returns badRequest when siteId is missing', async () => {
      const rpcMock = createRpcMock();
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {};

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('siteId');
    });

    it('returns badRequest when RPC returns error', async () => {
      const rpcMock = createRpcMock({ data: null, error: { message: 'relation does not exist' } });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('relation does not exist');
      expect(mockContext.log.error).to.have.been.calledOnce;
    });

    it('returns ok with aggregate stats and weekly trends (happy path)', async () => {
      const rpcMock = createRpcMock({
        data: [aggRow, week1Row, week2Row],
        error: null,
      });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        siteId: SITE_ID,
        startDate: '2026-03-01',
        endDate: '2026-03-15',
      };

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.totalPromptsCited).to.equal(42);
      expect(body.totalPrompts).to.equal(120);
      expect(body.uniqueUrls).to.equal(15);
      expect(body.totalCitations).to.equal(200);

      expect(body.weeklyTrends).to.have.lengthOf(2);
      expect(body.weeklyTrends[0]).to.deep.equal({
        week: '2026-W10',
        weekNumber: 10,
        year: 2026,
        totalPromptsCited: 20,
        totalPrompts: 60,
        uniqueUrls: 8,
        totalCitations: 95,
      });
      expect(body.weeklyTrends[1]).to.deep.equal({
        week: '2026-W11',
        weekNumber: 11,
        year: 2026,
        totalPromptsCited: 22,
        totalPrompts: 60,
        uniqueUrls: 10,
        totalCitations: 105,
      });
    });

    it('returns all zeros when RPC returns empty data', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.totalPromptsCited).to.equal(0);
      expect(body.totalPrompts).to.equal(0);
      expect(body.uniqueUrls).to.equal(0);
      expect(body.totalCitations).to.equal(0);
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('returns all zeros when RPC returns null data', async () => {
      const rpcMock = createRpcMock({ data: null, error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.totalPromptsCited).to.equal(0);
      expect(body.totalPrompts).to.equal(0);
      expect(body.uniqueUrls).to.equal(0);
      expect(body.totalCitations).to.equal(0);
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('passes correct RPC params with all filters applied', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        siteId: SITE_ID,
        startDate: '2026-01-01',
        endDate: '2026-03-31',
        category: 'Software',
        region: 'US',
        platform: 'chatgpt',
      };

      const handler = createStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({
          p_site_id: SITE_ID,
          p_start_date: '2026-01-01',
          p_end_date: '2026-03-31',
          p_category: 'Software',
          p_region: 'US',
          p_platform: 'chatgpt',
        }),
      );
    });

    it('passes null for filters set to "all"', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        siteId: SITE_ID,
        category: 'all',
        region: 'all',
        platform: 'all',
      };

      const handler = createStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({
          p_site_id: SITE_ID,
          p_start_date: null,
          p_end_date: null,
          p_category: null,
          p_region: null,
          p_platform: null,
        }),
      );
    });

    it('passes null for empty string filters', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        siteId: SITE_ID,
        category: '',
        region: '',
        platform: '',
      };

      const handler = createStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({
          p_category: null,
          p_region: null,
          p_platform: null,
        }),
      );
    });

    it('passes brandId to RPC when a specific brand UUID is provided', async () => {
      const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.params.brandId = brandUuid;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({
          p_site_id: SITE_ID,
          p_brand_id: brandUuid,
        }),
      );
    });

    it('passes null p_brand_id when brandId is "all"', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      await handler(mockContext);

      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({
          p_brand_id: null,
        }),
      );
    });

    it('handles aggregate-only response (no weekly rows)', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.totalPromptsCited).to.equal(42);
      expect(body.totalPrompts).to.equal(120);
      expect(body.weeklyTrends).to.deep.equal([]);
    });

    it('handles rows with missing/null numeric fields gracefully', async () => {
      const sparseRow = {
        week: '2026-W10',
        week_number: null,
        year_val: null,
        total_prompts_cited: null,
        total_prompts: undefined,
        unique_urls: 0,
        total_citations: null,
      };
      const rpcMock = createRpcMock({ data: [sparseRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();

      expect(body.totalPromptsCited).to.equal(0);
      expect(body.totalPrompts).to.equal(0);
      expect(body.uniqueUrls).to.equal(0);
      expect(body.totalCitations).to.equal(0);
      expect(body.weeklyTrends[0]).to.deep.equal({
        week: '2026-W10',
        weekNumber: 0,
        year: 0,
        totalPromptsCited: 0,
        totalPrompts: 0,
        uniqueUrls: 0,
        totalCitations: 0,
      });
    });

    it('returns 500 when handler throws unexpectedly', async () => {
      const rpcMock = {
        rpc: sinon.stub().rejects(new Error('connection reset')),
      };
      mockContext.dataAccess.Site.postgrestService = rpcMock;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(500);
      expect(mockContext.log.error).to.have.been.called;
    });

    it('handles missing context.params gracefully (defaults brandId to null)', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.params = undefined;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({ p_brand_id: null }),
      );
    });

    it('handles null context.data gracefully', async () => {
      const rpcMock = createRpcMock({ data: [], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = null;

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('siteId');
    });

    it('supports snake_case query param aliases', async () => {
      const rpcMock = createRpcMock({ data: [aggRow], error: null });
      mockContext.dataAccess.Site.postgrestService = rpcMock;
      mockContext.data = {
        site_id: SITE_ID,
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        content_type: 'owned',
      };

      const handler = createStatsHandler(getOrgAndValidateAccess);
      const result = await handler(mockContext);

      expect(result.status).to.equal(200);
      expect(rpcMock.rpc).to.have.been.calledOnceWith(
        'rpc_url_inspector_stats',
        sinon.match({
          p_site_id: SITE_ID,
          p_start_date: '2026-01-01',
          p_end_date: '2026-03-31',
        }),
      );
    });
  });
});
