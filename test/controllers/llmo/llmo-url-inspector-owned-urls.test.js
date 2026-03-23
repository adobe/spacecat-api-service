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
  createOwnedUrlsHandler,
  computeTrend,
} from '../../../src/controllers/llmo/llmo-url-inspector-owned-urls.js';

use(sinonChai);

function createRpcMock(resolveValue = { data: [], error: null }) {
  return {
    rpc: sinon.stub().resolves(resolveValue),
  };
}

describe('computeTrend', () => {
  it('returns neutral with hasValidComparison=false for empty array', () => {
    const result = computeTrend([]);
    expect(result).to.deep.equal({
      direction: 'neutral',
      hasValidComparison: false,
      weeklyValues: [],
    });
  });

  it('returns neutral with hasValidComparison=false for null', () => {
    const result = computeTrend(null);
    expect(result).to.deep.equal({
      direction: 'neutral',
      hasValidComparison: false,
      weeklyValues: [],
    });
  });

  it('returns neutral with hasValidComparison=false for single week', () => {
    const result = computeTrend([{ week: '2026-W10', value: 5 }]);
    expect(result).to.deep.equal({
      direction: 'neutral',
      hasValidComparison: false,
      weeklyValues: [{ week: '2026-W10', value: 5 }],
    });
  });

  it('returns up when latest week is greater', () => {
    const result = computeTrend([
      { week: '2026-W09', value: 10 },
      { week: '2026-W10', value: 15 },
    ]);
    expect(result.direction).to.equal('up');
    expect(result.hasValidComparison).to.be.true;
    expect(result.weeklyValues).to.have.length(2);
  });

  it('returns down when latest week is smaller', () => {
    const result = computeTrend([
      { week: '2026-W09', value: 15 },
      { week: '2026-W10', value: 10 },
    ]);
    expect(result.direction).to.equal('down');
    expect(result.hasValidComparison).to.be.true;
  });

  it('returns neutral when both weeks are equal', () => {
    const result = computeTrend([
      { week: '2026-W09', value: 10 },
      { week: '2026-W10', value: 10 },
    ]);
    expect(result.direction).to.equal('neutral');
    expect(result.hasValidComparison).to.be.true;
  });

  it('compares the last two weeks when more than two are present', () => {
    const result = computeTrend([
      { week: '2026-W08', value: 100 },
      { week: '2026-W09', value: 5 },
      { week: '2026-W10', value: 15 },
    ]);
    expect(result.direction).to.equal('up');
    expect(result.hasValidComparison).to.be.true;
    expect(result.weeklyValues).to.have.length(3);
  });

  it('sorts unsorted input chronologically', () => {
    const result = computeTrend([
      { week: '2026-W10', value: 8 },
      { week: '2026-W08', value: 20 },
      { week: '2026-W09', value: 12 },
    ]);
    expect(result.weeklyValues[0].week).to.equal('2026-W08');
    expect(result.weeklyValues[2].week).to.equal('2026-W10');
    expect(result.direction).to.equal('down');
  });
});

describe('createOwnedUrlsHandler', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: { spaceCatId: '0178a3f0-1234-7000-8000-000000000001', brandId: 'all' },
      data: { siteId: '0178a3f0-1234-7000-8000-000000000099' },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: {
        Site: { postgrestService: null },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns badRequest when postgrestService is missing', async () => {
    mockContext.dataAccess.Site.postgrestService = null;
    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
    expect(getOrgAndValidateAccess).not.to.have.been.called;
  });

  it('returns forbidden when user has no org access', async () => {
    mockContext.dataAccess.Site.postgrestService = createRpcMock();
    getOrgAndValidateAccess.rejects(
      new Error('Only users belonging to the organization can view URL Inspector data'),
    );

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(403);
  });

  it('returns badRequest when siteId is missing', async () => {
    mockContext.dataAccess.Site.postgrestService = createRpcMock();
    mockContext.data = {};

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.include('siteId');
  });

  it('returns badRequest when RPC returns error', async () => {
    const rpcMock = createRpcMock({ data: null, error: { message: 'relation does not exist' } });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('relation does not exist');
  });

  it('returns empty urls array when RPC returns no data', async () => {
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.urls).to.deep.equal([]);
  });

  it('returns empty urls array when RPC returns null data without error', async () => {
    const rpcMock = createRpcMock({ data: null, error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.urls).to.deep.equal([]);
  });

  it('returns correctly shaped URL rows with trend computation', async () => {
    const rpcData = [
      {
        url: 'https://example.com/product/a',
        citations: 45,
        prompts_cited: 12,
        products: ['Software', 'AI Tools'],
        regions: ['US', 'UK'],
        weekly_citations: [
          { week: '2026-W09', value: 20 },
          { week: '2026-W10', value: 25 },
        ],
        weekly_prompts_cited: [
          { week: '2026-W09', value: 6 },
          { week: '2026-W10', value: 6 },
        ],
      },
      {
        url: 'https://example.com/product/b',
        citations: 10,
        prompts_cited: 3,
        products: ['Hardware'],
        regions: ['DE'],
        weekly_citations: [
          { week: '2026-W09', value: 8 },
          { week: '2026-W10', value: 2 },
        ],
        weekly_prompts_cited: [
          { week: '2026-W09', value: 3 },
          { week: '2026-W10', value: 1 },
        ],
      },
    ];
    const rpcMock = createRpcMock({ data: rpcData, error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;
    mockContext.data = {
      siteId: '0178a3f0-1234-7000-8000-000000000099',
      startDate: '2026-02-23',
      endDate: '2026-03-09',
    };

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.urls).to.have.length(2);

    const first = body.urls[0];
    expect(first.url).to.equal('https://example.com/product/a');
    expect(first.citations).to.equal(45);
    expect(first.promptsCited).to.equal(12);
    expect(first.products).to.deep.equal(['Software', 'AI Tools']);
    expect(first.regions).to.deep.equal(['US', 'UK']);
    expect(first.contentType).to.equal('owned');
    expect(first.citationsTrend.direction).to.equal('up');
    expect(first.citationsTrend.hasValidComparison).to.be.true;
    expect(first.citationsTrend.weeklyValues).to.have.length(2);
    expect(first.promptsCitedTrend.direction).to.equal('neutral');
    expect(first.promptsCitedTrend.hasValidComparison).to.be.true;

    const second = body.urls[1];
    expect(second.citationsTrend.direction).to.equal('down');
    expect(second.promptsCitedTrend.direction).to.equal('down');
  });

  it('handles single-week data with hasValidComparison=false', async () => {
    const rpcData = [
      {
        url: 'https://example.com/page',
        citations: 5,
        prompts_cited: 2,
        products: ['Software'],
        regions: ['US'],
        weekly_citations: [{ week: '2026-W10', value: 5 }],
        weekly_prompts_cited: [{ week: '2026-W10', value: 2 }],
      },
    ];
    const rpcMock = createRpcMock({ data: rpcData, error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.urls).to.have.length(1);
    expect(body.urls[0].citationsTrend.hasValidComparison).to.be.false;
    expect(body.urls[0].citationsTrend.direction).to.equal('neutral');
    expect(body.urls[0].promptsCitedTrend.hasValidComparison).to.be.false;
  });

  it('handles equal-week values with neutral direction', async () => {
    const rpcData = [
      {
        url: 'https://example.com/page',
        citations: 20,
        prompts_cited: 4,
        products: [],
        regions: [],
        weekly_citations: [
          { week: '2026-W09', value: 10 },
          { week: '2026-W10', value: 10 },
        ],
        weekly_prompts_cited: [
          { week: '2026-W09', value: 2 },
          { week: '2026-W10', value: 2 },
        ],
      },
    ];
    const rpcMock = createRpcMock({ data: rpcData, error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.urls[0].citationsTrend.direction).to.equal('neutral');
    expect(body.urls[0].citationsTrend.hasValidComparison).to.be.true;
  });

  it('defaults null products and regions to empty arrays', async () => {
    const rpcData = [
      {
        url: 'https://example.com/page',
        citations: 1,
        prompts_cited: 1,
        products: null,
        regions: null,
        weekly_citations: [{ week: '2026-W10', value: 1 }],
        weekly_prompts_cited: [{ week: '2026-W10', value: 1 }],
      },
    ];
    const rpcMock = createRpcMock({ data: rpcData, error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.urls[0].products).to.deep.equal([]);
    expect(body.urls[0].regions).to.deep.equal([]);
  });

  it('passes optional filter params to RPC', async () => {
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;
    mockContext.data = {
      siteId: '0178a3f0-1234-7000-8000-000000000099',
      startDate: '2026-02-01',
      endDate: '2026-03-01',
      category: 'Software',
      region: 'US',
      platform: 'chatgpt',
    };

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(rpcMock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_owned_urls',
      sinon.match({
        p_site_id: '0178a3f0-1234-7000-8000-000000000099',
        p_start_date: '2026-02-01',
        p_end_date: '2026-03-01',
        p_category: 'Software',
        p_region: 'US',
        p_platform: 'chatgpt',
      }),
    );
  });

  it('passes null for skipped filters (all, empty)', async () => {
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;
    mockContext.data = {
      siteId: '0178a3f0-1234-7000-8000-000000000099',
      category: 'all',
      region: '',
      platform: '*',
    };

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(rpcMock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_owned_urls',
      sinon.match({
        p_category: null,
        p_region: null,
        p_platform: null,
      }),
    );
  });

  it('passes brandId to RPC when a specific brand UUID is provided', async () => {
    const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;
    mockContext.params.brandId = brandUuid;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(rpcMock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_owned_urls',
      sinon.match({
        p_brand_id: brandUuid,
      }),
    );
  });

  it('passes null p_brand_id when brandId is "all"', async () => {
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(rpcMock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_owned_urls',
      sinon.match({
        p_brand_id: null,
      }),
    );
  });

  it('returns 500 when handler throws unexpected error', async () => {
    const rpcMock = { rpc: sandbox.stub().rejects(new Error('connection refused')) };
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createOwnedUrlsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(500);
  });
});
