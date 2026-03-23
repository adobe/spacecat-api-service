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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  createCitedDomainsHandler,
} from '../../../src/controllers/llmo/llmo-url-inspector-cited-domains.js';

use(sinonChai);

function createRpcMock(resolveValue = { data: [], error: null }) {
  return { rpc: sinon.stub().resolves(resolveValue) };
}

// eslint-disable-next-line max-params
function makeDomainRow(
  domain,
  totalCitations,
  totalUrls,
  promptsCited,
  contentType,
  categories,
  regions,
) {
  return {
    domain,
    total_citations: totalCitations,
    total_urls: totalUrls,
    prompts_cited: promptsCited,
    content_type: contentType,
    categories,
    regions,
  };
}

describe('llmo-url-inspector-cited-domains', () => {
  let sandbox;
  let getOrgAndValidateAccess;
  let mockContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    getOrgAndValidateAccess = sandbox.stub().resolves({ organization: {} });
    mockContext = {
      params: { spaceCatId: '0178a3f0-1234-7000-8000-000000000001', brandId: 'all' },
      data: { siteId: 'site-001' },
      log: { info: sandbox.stub(), error: sandbox.stub(), warn: sandbox.stub() },
      dataAccess: { Site: { postgrestService: null } },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns badRequest when postgrestService is missing', async () => {
    mockContext.dataAccess.Site.postgrestService = null;
    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
    expect(getOrgAndValidateAccess).not.to.have.been.called;
  });

  it('returns forbidden when user has no org access', async () => {
    const mock = createRpcMock();
    mockContext.dataAccess.Site.postgrestService = mock;
    getOrgAndValidateAccess.rejects(
      new Error('Only users belonging to the organization can view URL Inspector data'),
    );

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(403);
  });

  it('returns badRequest when organization not found', async () => {
    const mock = createRpcMock();
    mockContext.dataAccess.Site.postgrestService = mock;
    getOrgAndValidateAccess.rejects(new Error('Organization not found: x'));

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
  });

  it('returns badRequest when siteId is missing', async () => {
    const mock = createRpcMock();
    mockContext.dataAccess.Site.postgrestService = mock;
    mockContext.data = {};

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.include('siteId');
  });

  it('returns badRequest when RPC returns error', async () => {
    const mock = createRpcMock({ data: null, error: { message: 'relation does not exist' } });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(400);
    const body = await result.json();
    expect(body.message).to.equal('relation does not exist');
  });

  it('returns ok with domain aggregations on happy path', async () => {
    const rows = [
      makeDomainRow('competitor.com', 456, 23, 89, 'competitor', 'Software,Security', 'US,UK'),
      makeDomainRow('news.org', 120, 10, 45, 'earned', 'AI Tools', 'DE'),
    ];
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();

    expect(body.totalDomains).to.equal(2);
    expect(body.topDomains).to.have.lengthOf(2);
    expect(body.allDomains).to.deep.equal([]);

    expect(body.topDomains[0]).to.deep.equal({
      domain: 'competitor.com',
      totalCitations: 456,
      totalUrls: 23,
      promptsCited: 89,
      contentType: 'competitor',
      categories: 'Software,Security',
      regions: 'US,UK',
    });
    expect(body.topDomains[1]).to.deep.equal({
      domain: 'news.org',
      totalCitations: 120,
      totalUrls: 10,
      promptsCited: 45,
      contentType: 'earned',
      categories: 'AI Tools',
      regions: 'DE',
    });

    expect(mock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_cited_domains',
      sinon.match({
        p_site_id: 'site-001',
      }),
    );
  });

  it('passes filter params to RPC when provided', async () => {
    const mock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = mock;
    mockContext.data = {
      siteId: 'site-001',
      startDate: '2026-01-01',
      endDate: '2026-03-01',
      category: 'Software',
      region: 'US',
      channel: 'competitor',
      platform: 'chatgpt',
    };

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(mock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_cited_domains',
      sinon.match({
        p_site_id: 'site-001',
        p_start_date: '2026-01-01',
        p_end_date: '2026-03-01',
        p_category: 'Software',
        p_region: 'US',
        p_channel: 'competitor',
        p_platform: 'chatgpt',
      }),
    );
  });

  it('passes null for skip-value filters (all, empty, *)', async () => {
    const mock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = mock;
    mockContext.data = {
      siteId: 'site-001',
      category: 'all',
      region: '*',
      channel: '',
    };

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(mock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_cited_domains',
      sinon.match({
        p_category: null,
        p_region: null,
        p_channel: null,
      }),
    );
  });

  it('passes brandId to RPC when a specific brand UUID is provided', async () => {
    const brandUuid = '0178a3f0-bbbb-7000-8000-000000000001';
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;
    mockContext.params.brandId = brandUuid;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(rpcMock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_cited_domains',
      sinon.match({
        p_brand_id: brandUuid,
      }),
    );
  });

  it('passes null p_brand_id when brandId is "all"', async () => {
    const rpcMock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = rpcMock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    await handler(mockContext);

    expect(rpcMock.rpc).to.have.been.calledOnceWith(
      'rpc_url_inspector_cited_domains',
      sinon.match({
        p_brand_id: null,
      }),
    );
  });

  it('populates allDomains when includeAll is true', async () => {
    const rows = [
      makeDomainRow('a.com', 100, 5, 20, 'competitor', 'Cat1', 'US'),
      makeDomainRow('b.com', 50, 3, 10, 'earned', 'Cat2', 'UK'),
    ];
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;
    mockContext.data = { siteId: 'site-001', includeAll: 'true' };

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();

    expect(body.allDomains).to.have.lengthOf(2);
    expect(body.allDomains[0].domain).to.equal('a.com');
    expect(body.allDomains[1].domain).to.equal('b.com');
  });

  it('returns empty allDomains when includeAll is false (default)', async () => {
    const rows = [makeDomainRow('a.com', 100, 5, 20, 'competitor', 'Cat1', 'US')];
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    const body = await result.json();
    expect(body.allDomains).to.deep.equal([]);
  });

  it('respects limit param for topDomains', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeDomainRow(`d${i}.com`, 100 - i, 1, 1, 'competitor', '', ''));
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;
    mockContext.data = { siteId: 'site-001', limit: '3' };

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    const body = await result.json();
    expect(body.totalDomains).to.equal(5);
    expect(body.topDomains).to.have.lengthOf(3);
    expect(body.topDomains[0].domain).to.equal('d0.com');
    expect(body.topDomains[2].domain).to.equal('d2.com');
  });

  it('defaults limit to 200 when not specified', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => makeDomainRow(`d${i}.com`, 250 - i, 1, 1, 'competitor', '', ''));
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    const body = await result.json();
    expect(body.totalDomains).to.equal(250);
    expect(body.topDomains).to.have.lengthOf(200);
  });

  it('returns empty results when RPC returns no data', async () => {
    const mock = createRpcMock({ data: [], error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.totalDomains).to.equal(0);
    expect(body.topDomains).to.deep.equal([]);
    expect(body.allDomains).to.deep.equal([]);
  });

  it('returns empty results when RPC returns null data', async () => {
    const mock = createRpcMock({ data: null, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(200);
    const body = await result.json();
    expect(body.totalDomains).to.equal(0);
    expect(body.topDomains).to.deep.equal([]);
  });

  it('defaults contentType to unknown when null', async () => {
    const rows = [makeDomainRow('a.com', 10, 1, 1, null, '', '')];
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    const body = await result.json();
    expect(body.topDomains[0].contentType).to.equal('unknown');
  });

  it('defaults categories and regions to empty string when null', async () => {
    const rows = [makeDomainRow('a.com', 10, 1, 1, 'owned', null, null)];
    const mock = createRpcMock({ data: rows, error: null });
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    const body = await result.json();
    expect(body.topDomains[0].categories).to.equal('');
    expect(body.topDomains[0].regions).to.equal('');
  });

  it('returns internalServerError when handler throws unexpectedly', async () => {
    const mock = { rpc: sinon.stub().rejects(new Error('unexpected crash')) };
    mockContext.dataAccess.Site.postgrestService = mock;

    const handler = createCitedDomainsHandler(getOrgAndValidateAccess);
    const result = await handler(mockContext);

    expect(result.status).to.equal(500);
  });
});
