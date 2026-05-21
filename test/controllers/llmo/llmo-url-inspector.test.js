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
  createUrlInspectorFilterDimensionsHandler,
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

// Helper: build rpcResults for the four split stats RPCs from a simple
// per-metric object. Each entry is a list of rows (one aggregate row with
// week=null and any number of per-week rows). When `error` is present,
// every split RPC returns that error; pass `errorOnFn` to target a single
// RPC.
function statsRpcResults({
  totalPromptsCited = [], totalPrompts = [], uniqueUrls = [], totalCitations = [],
  error = null, errorOnFn = null, data = undefined,
} = {}) {
  const rpcs = {
    rpc_url_inspector_total_prompts_cited: totalPromptsCited,
    rpc_url_inspector_total_prompts: totalPrompts,
    rpc_url_inspector_unique_urls: uniqueUrls,
    rpc_url_inspector_total_citations: totalCitations,
  };
  const out = {};
  Object.entries(rpcs).forEach(([fn, rows]) => {
    if (error && (!errorOnFn || errorOnFn === fn)) {
      out[fn] = { data: null, error };
    } else {
      out[fn] = { data: data === undefined ? rows : data, error: null };
    }
  });
  return out;
}

describe('URL Inspector Handlers', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('createUrlInspectorStatsHandler', () => {
    it('returns stats and weekly trends on success', async () => {
      const { context, rpcStub } = createContext({}, {}, {
        rpcResults: statsRpcResults({
          totalPromptsCited: [
            { week: null, value: 10 },
            { week: '2026-W10', value: 4 },
            { week: '2026-W11', value: 6 },
          ],
          totalPrompts: [
            { week: null, value: 50 },
            { week: '2026-W10', value: 20 },
            { week: '2026-W11', value: 30 },
          ],
          uniqueUrls: [
            { week: null, value: 5 },
            { week: '2026-W10', value: 3 },
            { week: '2026-W11', value: 4 },
          ],
          totalCitations: [
            { week: null, value: 100 },
            { week: '2026-W10', value: 40 },
            { week: '2026-W11', value: 60 },
          ],
        }),
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
      expect(body.weeklyTrends[0]).to.deep.equal({
        week: '2026-W10',
        totalPromptsCited: 4,
        totalPrompts: 20,
        uniqueUrls: 3,
        totalCitations: 40,
      });
      expect(body.weeklyTrends[1]).to.deep.equal({
        week: '2026-W11',
        totalPromptsCited: 6,
        totalPrompts: 30,
        uniqueUrls: 4,
        totalCitations: 60,
      });

      expect(rpcStub).to.have.been.calledWith('rpc_url_inspector_total_prompts_cited');
      expect(rpcStub).to.have.been.calledWith('rpc_url_inspector_total_prompts');
      expect(rpcStub).to.have.been.calledWith('rpc_url_inspector_unique_urls');
      expect(rpcStub).to.have.been.calledWith('rpc_url_inspector_total_citations');
      expect(rpcStub.callCount).to.equal(4);
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

    it('returns internalServerError when any split RPC errors, without leaking details', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: statsRpcResults({
          error: { message: 'pq: column "x" does not exist' },
          errorOnFn: 'rpc_url_inspector_unique_urls',
        }),
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.not.include('pq:');
      expect(context.log.error).to.have.been.calledWithMatch(/rpc_url_inspector_unique_urls/);
    });

    it('includes PostgREST code/details/hint in the error log when present', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: statsRpcResults({
          error: {
            message: 'pq: column "x" does not exist',
            code: 'PGRST202',
            details: 'col "x"',
            hint: 'try reloading schema',
          },
          errorOnFn: 'rpc_url_inspector_unique_urls',
        }),
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWithMatch(/code=PGRST202/);
      expect(context.log.error).to.have.been.calledWithMatch(/details=col "x"/);
      expect(context.log.error).to.have.been.calledWithMatch(/hint=try reloading schema/);
    });

    it('returns internalServerError when a split RPC rejects with an Error', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: {
          rpc_url_inspector_total_prompts_cited: () => Promise.reject(new Error('network boom')),
        },
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
      const body = await response.json();
      expect(body.message).to.not.include('boom');
      expect(context.log.error).to.have.been.calledWithMatch(/URL Inspector stats RPC threw: network boom/);
    });

    it('returns internalServerError when a split RPC rejects with a non-Error value', async () => {
      /* eslint-disable prefer-promise-reject-errors */
      const { context } = createContext({}, {}, {
        rpcResults: {
          rpc_url_inspector_total_prompts_cited: () => Promise.reject('bare-string-reject'),
        },
      });
      /* eslint-enable prefer-promise-reject-errors */

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWithMatch(/URL Inspector stats RPC threw: bare-string-reject/);
    });

    it('returns empty stats when all split RPCs return empty data', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: statsRpcResults(),
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.stats).to.deep.equal({
        totalPromptsCited: 0,
        totalPrompts: 0,
        uniqueUrls: 0,
        totalCitations: 0,
      });
      expect(body.weeklyTrends).to.have.length(0);
    });

    it('passes brandId to the split RPCs as p_brand_id', async () => {
      const { context, rpcStub } = createContext(
        { brandId: BRAND_ID },
        {},
        { rpcResults: statsRpcResults() },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      expect(rpcStub.callCount).to.equal(4);
      rpcStub.getCalls().forEach((call) => {
        expect(call.args[1]).to.have.property('p_brand_id', BRAND_ID);
      });
    });

    it('passes p_brand_id=null when brandId is "all"', async () => {
      const { context, rpcStub } = createContext(
        { brandId: 'all' },
        {},
        { rpcResults: statsRpcResults() },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      rpcStub.getCalls().forEach((call) => {
        expect(call.args[1].p_brand_id).to.equal(null);
      });
    });

    it('passes null for platform when not provided', async () => {
      const { context, rpcStub } = createContext(
        {},
        {},
        { rpcResults: statsRpcResults() },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      expect(rpcStub.firstCall.args[1].p_platform).to.equal(null);
    });

    it('passes valid model to all RPCs when platform is provided', async () => {
      const { context, rpcStub } = createContext(
        {},
        { platform: 'perplexity' },
        { rpcResults: statsRpcResults() },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      rpcStub.getCalls().forEach((call) => {
        expect(call.args[1].p_platform).to.equal('perplexity');
      });
    });

    it('passes category and region filters to all RPCs', async () => {
      const { context, rpcStub } = createContext(
        {},
        {
          categoryId: 'cat-1', regionCode: 'US', startDate: '2026-01-01', endDate: '2026-02-01',
        },
        { rpcResults: statsRpcResults() },
      );

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      await handler(context);

      rpcStub.getCalls().forEach((call) => {
        expect(call.args[1].p_category).to.equal('cat-1');
        expect(call.args[1].p_region).to.equal('US');
        expect(call.args[1].p_start_date).to.equal('2026-01-01');
        expect(call.args[1].p_end_date).to.equal('2026-02-01');
      });
    });

    it('handles weekly rows with null values', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: statsRpcResults({
          totalPromptsCited: [{ week: '2026-W10', value: null }],
          totalPrompts: [{ week: '2026-W10', value: null }],
          uniqueUrls: [{ week: '2026-W10', value: null }],
          totalCitations: [{ week: '2026-W10', value: null }],
        }),
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(body.stats.totalPromptsCited).to.equal(0);
      expect(body.weeklyTrends).to.have.length(1);
      expect(body.weeklyTrends[0]).to.deep.equal({
        week: '2026-W10',
        totalPromptsCited: 0,
        totalPrompts: 0,
        uniqueUrls: 0,
        totalCitations: 0,
      });
    });

    it('unions weeks across split RPCs (missing metric for a week stays 0)', async () => {
      const { context } = createContext({}, {}, {
        rpcResults: statsRpcResults({
          totalPromptsCited: [
            { week: null, value: 4 },
            { week: '2026-W10', value: 4 },
          ],
          totalPrompts: [
            { week: null, value: 20 },
            { week: '2026-W10', value: 10 },
            { week: '2026-W11', value: 10 },
          ],
          uniqueUrls: [
            { week: null, value: 3 },
            { week: '2026-W11', value: 3 },
          ],
          totalCitations: [
            { week: null, value: 40 },
          ],
        }),
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.weeklyTrends).to.have.length(2);
      const w10 = body.weeklyTrends.find((w) => w.week === '2026-W10');
      const w11 = body.weeklyTrends.find((w) => w.week === '2026-W11');
      expect(w10).to.deep.equal({
        week: '2026-W10',
        totalPromptsCited: 4,
        totalPrompts: 10,
        uniqueUrls: 0,
        totalCitations: 0,
      });
      expect(w11).to.deep.equal({
        week: '2026-W11',
        totalPromptsCited: 0,
        totalPrompts: 10,
        uniqueUrls: 3,
        totalCitations: 0,
      });
    });
  });

  describe('createUrlInspectorOwnedUrlsHandler', () => {
    it('returns paginated owned URLs with agentic + referral fields mapped', async () => {
      const rpcData = [
        {
          url: 'https://example.com/page1',
          citations: 42,
          prompts_cited: 12,
          products: ['Category A'],
          regions: ['US', 'DE'],
          weekly_citations: [{ week: '2026-W10', value: 20 }],
          weekly_prompts_cited: [{ week: '2026-W10', value: 5 }],
          agentic_hits: 160,
          agentic_hits_trend: [
            { week_start: '2026-01-12', value: 100 },
            { week_start: '2026-01-19', value: 60 },
          ],
          referral_hits: 9400,
          referral_hits_trend: [
            { week_start: '2026-01-12', value: 4400 },
            { week_start: '2026-01-19', value: 5000 },
          ],
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
          agentic_hits: 0,
          agentic_hits_trend: [],
          referral_hits: 0,
          referral_hits_trend: [],
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
      // Server-side agentic merge (LLMO-4526 M2): the dashboard reads these
      // straight off each row, so they must come through camelCased and the
      // trend's snake_case `week_start` must be normalised to `weekStart`.
      expect(body.urls[0].agenticHits).to.equal(160);
      expect(body.urls[0].agenticHitsTrend).to.deep.equal([
        { weekStart: '2026-01-12', value: 100 },
        { weekStart: '2026-01-19', value: 60 },
      ]);
      expect(body.urls[1].agenticHits).to.equal(0);
      expect(body.urls[1].agenticHitsTrend).to.deep.equal([]);
      // Server-side referral merge (LLMO-4729 Decision A pull-in): same
      // camelCase + weekStart normalisation as agentic. The dashboard renders
      // these in the Owned URLs table's Referral Hits column + sparkline.
      expect(body.urls[0].referralHits).to.equal(9400);
      expect(body.urls[0].referralHitsTrend).to.deep.equal([
        { weekStart: '2026-01-12', value: 4400 },
        { weekStart: '2026-01-19', value: 5000 },
      ]);
      expect(body.urls[1].referralHits).to.equal(0);
      expect(body.urls[1].referralHitsTrend).to.deep.equal([]);
    });

    // Same defence-in-depth as the agentic-trend test below — referral side
    // gets its own coverage so the `??` fallbacks inside the referral
    // trend's `.map` callback are pinned.
    it('coerces null fields inside referral_hits_trend points (weekStart→null, value→0)', async () => {
      const rpcData = [
        {
          url: 'https://example.com/page1',
          citations: 1,
          prompts_cited: 1,
          products: [],
          regions: [],
          weekly_citations: [],
          weekly_prompts_cited: [],
          agentic_hits: 0,
          agentic_hits_trend: [],
          referral_hits: 0,
          referral_hits_trend: [
            { week_start: null, value: null },
            { /* week_start missing entirely */ value: 5 },
            { week_start: '2026-01-12' /* value missing entirely */ },
          ],
          total_count: 1,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_owned_urls: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls[0].referralHitsTrend).to.deep.equal([
        { weekStart: null, value: 0 },
        { weekStart: null, value: 5 },
        { weekStart: '2026-01-12', value: 0 },
      ]);
    });

    // Defence-in-depth: PostgREST occasionally returns null on numeric / text
    // columns when the underlying JSONB element omits a key. The handler
    // collapses missing `week_start` to null and missing `value` to 0 so the
    // dashboard's WoW indicator never NaN-explodes a sparkline. This pins
    // both `??` fallback branches inside the trend `.map` callback.
    it('coerces null fields inside agentic_hits_trend points (weekStart→null, value→0)', async () => {
      const rpcData = [
        {
          url: 'https://example.com/page1',
          citations: 1,
          prompts_cited: 1,
          products: [],
          regions: [],
          weekly_citations: [],
          weekly_prompts_cited: [],
          agentic_hits: 0,
          agentic_hits_trend: [
            { week_start: null, value: null },
            { /* week_start missing entirely */ value: 5 },
            { week_start: '2026-01-12' /* value missing entirely */ },
          ],
          total_count: 1,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_owned_urls: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.urls[0].agenticHitsTrend).to.deep.equal([
        { weekStart: null, value: 0 },
        { weekStart: null, value: 5 },
        { weekStart: '2026-01-12', value: 0 },
      ]);
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

    it('passes filters and handles null row fields (agentic + referral + brand-presence)', async () => {
      const rpcData = [{
        url: 'https://example.com/page1',
        citations: null,
        prompts_cited: null,
        products: null,
        regions: null,
        weekly_citations: null,
        weekly_prompts_cited: null,
        agentic_hits: null,
        agentic_hits_trend: null,
        referral_hits: null,
        referral_hits_trend: null,
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
      // Defence-in-depth: null/undefined agentic columns must collapse to
      // safe defaults so the UI's WoW trend / sparkline never NaNs.
      expect(body.urls[0].agenticHits).to.equal(0);
      expect(body.urls[0].agenticHitsTrend).to.deep.equal([]);
      // Same defence for the LLMO-4729 referral columns.
      expect(body.urls[0].referralHits).to.equal(0);
      expect(body.urls[0].referralHitsTrend).to.deep.equal([]);
      expect(body.totalCount).to.equal(0);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_brand_id).to.equal(BRAND_ID);
      expect(rpcCall.args[1].p_category).to.equal('cat-1');
      expect(rpcCall.args[1].p_region).to.equal('US');
      // Without `agentTypes` in the query string the handler must NOT add
      // p_agent_types to the RPC payload — keeps the contract compatible
      // with internal tooling that still calls the older 9-arg signature.
      expect(rpcCall.args[1]).to.not.have.property('p_agent_types');
      // Same back-compat guarantee for `p_referral_source` (LLMO-4729
      // Decision A pull-in): when the caller does not supply
      // `referralSource`, the handler MUST omit the parameter entirely so
      // the call still works against mysticat builds that pre-date the
      // LLMO-4729 migration. The new RPC has DEFAULT 'optel', so the
      // omitted-param path still reads from referral_traffic_optel
      // server-side without any wire-shape coupling here.
      expect(rpcCall.args[1]).to.not.have.property('p_referral_source');
    });

    it('forwards comma-separated agentTypes as p_agent_types array', async () => {
      const { context, rpcStub } = createContext(
        {},
        { agentTypes: 'Chatbots,Research' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(200);
      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_agent_types).to.deep.equal(['Chatbots', 'Research']);
    });

    it('also accepts agentTypes as an array (no extra serialisation)', async () => {
      const { context, rpcStub } = createContext(
        {},
        { agentTypes: ['Chatbots', 'Research'] },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1].p_agent_types).to.deep.equal(['Chatbots', 'Research']);
    });

    it('drops unknown agentTypes values and omits the param when empty', async () => {
      const { context, rpcStub } = createContext(
        {},
        // The first three are unknown; the parser drops them all and the
        // resulting list collapses to null, which means the handler should
        // omit p_agent_types entirely (rather than sending an empty array
        // that the RPC would interpret as an empty inclusion list).
        { agentTypes: 'NotAType,, ,unknown' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      expect(rpcCall.args[1]).to.not.have.property('p_agent_types');
    });

    it('canonicalises agentTypes casing before forwarding', async () => {
      const { context, rpcStub } = createContext(
        {},
        // Mixed-case + snake_case alias + an unknown filler — the canonical
        // values must come back regardless of the input shape.
        { agent_types: 'chatbots, RESEARCH, training-bots' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      const rpcCall = rpcStub.firstCall;
      // 'training-bots' is unknown (canonical is 'Training bots') so it's
      // dropped — keeps the URL Inspector PG inclusion list intentionally
      // narrow until somebody plumbs Training bots into the dashboard.
      expect(rpcCall.args[1].p_agent_types).to.deep.equal(['Chatbots', 'Research']);
    });

    // -----------------------------------------------------------------------
    // LLMO-4729 (Decision A pull-in) — referralSource forwarding
    // -----------------------------------------------------------------------
    // The owned-URLs handler reads the optional `referralSource` query param
    // and forwards it as `p_referral_source` to rpc_url_inspector_owned_urls
    // so the RPC reads from the right `referral_traffic_<source>` table.
    // Whitelist mirrors the one in llmo-referral-traffic.js.

    it('forwards referralSource query param as p_referral_source', async () => {
      const { context, rpcStub } = createContext(
        {},
        { referralSource: 'cdn' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      expect(rpcStub.firstCall.args[1].p_referral_source).to.equal('cdn');
    });

    it('accepts referral_source snake_case alias', async () => {
      const { context, rpcStub } = createContext(
        {},
        { referral_source: 'ga4' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      expect(rpcStub.firstCall.args[1].p_referral_source).to.equal('ga4');
    });

    it('falls back to optel for unknown referralSource values', async () => {
      const { context, rpcStub } = createContext(
        {},
        // Unknown value; mirrors the parser's rejection of
        // not-on-the-whitelist sources (defence in depth — the underlying
        // RPC's CASE statement falls through to optel too, but doing it in
        // the handler avoids a wasted RPC trip on hostile input).
        { referralSource: 'nope' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );

      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      expect(rpcStub.firstCall.args[1].p_referral_source).to.equal('optel');
    });

    it('forwards every whitelisted referralSource verbatim', async () => {
      // Pin the four known sources so a future contributor adding (or
      // removing) one in the whitelist must update this assertion in lock-
      // step with the controller + the underlying RPC's CASE branches.
      for (const source of ['optel', 'cdn', 'adobe_analytics', 'ga4']) {
        // eslint-disable-next-line no-await-in-loop
        const { context, rpcStub } = createContext(
          {},
          { referralSource: source },
          { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
        );
        const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
        // eslint-disable-next-line no-await-in-loop
        await handler(context);
        expect(
          rpcStub.firstCall.args[1].p_referral_source,
          `whitelist member '${source}' should round-trip`,
        ).to.equal(source);
      }
    });

    it('omits p_referral_source when referralSource is an empty string', async () => {
      // Mirrors the agentTypes "drops unknown values and omits the param
      // when empty" test (LLMO-4526). The parser treats an empty string as
      // "no value supplied" so the handler MUST omit p_referral_source
      // from the RPC payload — keeps the call compatible with mysticat
      // builds that pre-date the LLMO-4729 migration. The post-LLMO-4729
      // RPC has DEFAULT 'optel' so the omitted-param path still reads
      // from referral_traffic_optel server-side.
      const { context, rpcStub } = createContext(
        {},
        { referralSource: '' },
        { rpcResults: { rpc_url_inspector_owned_urls: { data: [], error: null } } },
      );
      const handler = createUrlInspectorOwnedUrlsHandler(getOrgAndValidateAccess());
      await handler(context);

      expect(rpcStub.firstCall.args[1]).to.not.have.property('p_referral_source');
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

    it('handles rows with null fields but valid url', async () => {
      const rpcData = [
        {
          total_non_owned_urls: null,
          url: 'https://nullfields.com',
          content_type: null,
          prompt: null,
          category: null,
          region: null,
          topics: null,
          citation_count: null,
          execution_count: null,
        },
      ];

      const { context } = createContext({}, {}, {
        rpcResults: { rpc_url_inspector_trending_urls: { data: rpcData, error: null } },
      });

      const handler = createUrlInspectorTrendingUrlsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.totalNonOwnedUrls).to.equal(0);
      expect(body.urls).to.have.length(1);
      expect(body.urls[0].contentType).to.equal('');
      expect(body.urls[0].prompts[0].prompt).to.equal('');
      expect(body.urls[0].prompts[0].category).to.equal('');
      expect(body.urls[0].prompts[0].region).to.equal('');
      expect(body.urls[0].prompts[0].topics).to.equal('');
      expect(body.urls[0].prompts[0].citationCount).to.equal(0);
      expect(body.urls[0].prompts[0].executionCount).to.equal(0);
      expect(body.urls[0].totalCitations).to.equal(0);
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
      expect(rpcCall.args[1]).to.not.have.property('p_brand_id');
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

    /**
     * LLMO-4526 — URL Inspector PG dashboard's owned-URLs flow synthesises
     * `url-${index}-${slug}` ids because rpc_url_inspector_owned_urls does
     * not return source_urls.id. When that synthetic id is forwarded to
     * rpc_url_inspector_url_prompts (which takes a UUID), Postgres returns
     * SQLSTATE 22P02 (`invalid input syntax for type uuid`). Coercing that
     * to "no prompts for this row" keeps the URL Details dialog functional
     * (agentic chart + URL info still render) instead of forcing the UI
     * to render an opaque error state.
     */
    it('coerces invalid-UUID RPC errors to 200 + empty prompts (LLMO-4526)', async () => {
      const synthUrlId = 'url-3-https---www-adobe-com-products-firefly-html-utm-source-chatgpt-com';
      const { context } = createContext(
        {},
        { urlId: synthUrlId },
        {
          rpcResults: {
            rpc_url_inspector_url_prompts: {
              data: null,
              error: {
                code: '22P02',
                message: `invalid input syntax for type uuid: "${synthUrlId}"`,
              },
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
      expect(body).to.deep.equal({ prompts: [] });
    });

    it('coerces invalid-UUID RPC errors detected by message even when code is missing', async () => {
      const synthUrlId = 'not-a-uuid';
      const { context } = createContext(
        {},
        { urlId: synthUrlId },
        {
          rpcResults: {
            rpc_url_inspector_url_prompts: {
              data: null,
              error: {
                message: 'invalid input syntax for uuid: "not-a-uuid"',
              },
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
      expect(body).to.deep.equal({ prompts: [] });
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
        rpcResults: statsRpcResults({ data: null }),
      });

      const handler = createUrlInspectorStatsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.stats.totalPromptsCited).to.equal(0);
      expect(body.weeklyTrends).to.have.length(0);
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
        { rpcResults: statsRpcResults() },
      );

      const handler = createUrlInspectorStatsHandler(
        getOrgAndValidateAccess(),
      );
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });
  });

  describe('createUrlInspectorFilterDimensionsHandler', () => {
    const DIMENSIONS_DATA = {
      categories: [{ id: 'Reader', label: 'Reader' }],
      regions: [{ id: 'US', label: 'US' }],
      content_types: [{ id: 'owned', label: 'owned' }],
    };

    it('returns filter dimensions on success', async () => {
      const { context, rpcStub } = createContext(
        {},
        { startDate: '2026-01-01', endDate: '2026-01-31', platform: 'chatgpt-paid' },
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: DIMENSIONS_DATA, error: null },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.categories).to.deep.equal(DIMENSIONS_DATA.categories);
      expect(body.regions).to.deep.equal(DIMENSIONS_DATA.regions);
      expect(body.content_types).to.deep.equal(DIMENSIONS_DATA.content_types);

      // LLMO-4525 review (major): pin the FULL RPC argument contract so any
      // drift in parameter names or types is caught here — not in prod.
      // p_brand_id is NULL for brandId='all' (the default fixture).
      expect(rpcStub).to.have.been.calledOnceWith('rpc_url_inspector_filter_dimensions', {
        p_site_id: SITE_ID,
        p_start_date: '2026-01-01',
        p_end_date: '2026-01-31',
        p_platform: 'chatgpt-paid',
        p_brand_id: null,
      });
    });

    it('passes brandId from path to RPC when not \'all\'', async () => {
      // LLMO-4525 review (major bug this PR fixes): previously the handler
      // read brandId via parseFilterDimensionsParams (query string only),
      // which always yielded undefined. It must come from ctx.params (path).
      const { context, rpcStub } = createContext(
        { brandId: BRAND_ID },
        { startDate: '2026-01-01', endDate: '2026-01-31' },
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: DIMENSIONS_DATA, error: null },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(200);
      expect(rpcStub).to.have.been.calledOnceWith('rpc_url_inspector_filter_dimensions', sinon.match({
        p_brand_id: BRAND_ID,
      }));
    });

    it('passes p_brand_id = null when brandId path param is \'all\'', async () => {
      const { context, rpcStub } = createContext(
        { brandId: 'all' },
        {},
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: DIMENSIONS_DATA, error: null },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(200);
      expect(rpcStub).to.have.been.calledOnceWith('rpc_url_inspector_filter_dimensions', sinon.match({
        p_brand_id: null,
      }));
    });

    it('maps \'openai\' platform alias to canonical \'chatgpt-paid\' (MODEL_QUERY_ALIASES)', async () => {
      // LLMO-4525 review (major): the UI sends platform='openai' via
      // PLATFORM_CODES.ChatGPTPaid. The alias is resolved by validateModel
      // in llmo-brand-presence.js. Guard this seam so silent regressions are
      // caught at the API layer.
      const { context, rpcStub } = createContext(
        {},
        { platform: 'openai' },
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: DIMENSIONS_DATA, error: null },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(200);
      expect(rpcStub).to.have.been.calledOnceWith('rpc_url_inspector_filter_dimensions', sinon.match({
        p_platform: 'chatgpt-paid',
      }));
    });

    it('passes p_platform = null when platform is absent ("no filter" semantics)', async () => {
      const { context, rpcStub } = createContext(
        {},
        {},
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: DIMENSIONS_DATA, error: null },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(200);
      expect(rpcStub).to.have.been.calledOnceWith('rpc_url_inspector_filter_dimensions', sinon.match({
        p_platform: null,
      }));
    });

    it('defaults dates when startDate/endDate are absent', async () => {
      const { context, rpcStub } = createContext(
        {},
        {},
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: DIMENSIONS_DATA, error: null },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      await handler(context);

      const call = rpcStub.firstCall.args[1];
      // defaultDateRange returns a 28-day window ending today.
      expect(call.p_start_date).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(call.p_end_date).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns 400 when siteId is missing', async () => {
      const { context } = createContext({}, { siteId: undefined });

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });

    it('returns 403 when site does not belong to org', async () => {
      const { context } = createContext({}, {});
      context.dataAccess.Site.postgrestService.from = sinon.stub().returns({
        select: sinon.stub().returns({
          eq: sinon.stub().returns({
            eq: sinon.stub().returns({
              limit: sinon.stub().resolves({ data: [], error: null }),
            }),
          }),
        }),
      });

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(403);
    });

    it('returns 500 when RPC returns an error', async () => {
      const { context } = createContext(
        {},
        {},
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: { data: null, error: { message: 'db error' } },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(500);
    });

    it('logs enriched error context (code/details/hint + structured fields)', async () => {
      // LLMO-4525 review (tester): when the RPC fails we need enough detail
      // to triage without DB access. Assert the logger sees code/details/hint
      // in the message and structured siteId/platform in the metadata object.
      const { context } = createContext(
        { brandId: BRAND_ID },
        { platform: 'chatgpt-paid' },
        {
          rpcResults: {
            rpc_url_inspector_filter_dimensions: {
              data: null,
              error: {
                message: 'permission denied for function',
                code: '42501',
                details: 'missing grant on rpc_url_inspector_filter_dimensions',
                hint: 'GRANT EXECUTE TO postgrest_anon',
              },
            },
          },
        },
      );

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      expect(response.status).to.equal(500);

      expect(context.log.error).to.have.been.calledOnce;
      const [message, meta] = context.log.error.firstCall.args;
      expect(message).to.contain('permission denied for function');
      expect(message).to.contain('[code=42501]');
      expect(message).to.contain('[details=missing grant');
      expect(message).to.contain('[hint=GRANT EXECUTE TO postgrest_anon]');
      expect(meta).to.include({
        route: 'url-inspector-filter-dimensions',
        siteId: SITE_ID,
        platform: 'chatgpt-paid',
        hasBrandIdFilter: true,
      });
    });

    it('returns 500 and logs structured context when the RPC client throws', async () => {
      // LLMO-4525 review (security): defence-in-depth — a throwing transport
      // must not leak a stack to the caller, and we still want structured
      // context in the log for triage.
      const { context, rpcStub } = createContext({}, {});
      rpcStub.callsFake(() => Promise.reject(new Error('ECONNRESET')));

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      expect(response.status).to.equal(500);

      expect(context.log.error).to.have.been.calledOnce;
      const [message, meta] = context.log.error.firstCall.args;
      expect(message).to.contain('ECONNRESET');
      expect(meta).to.include({ route: 'url-inspector-filter-dimensions', siteId: SITE_ID });
    });

    it('falls back to String(e) when a non-Error value is thrown', async () => {
      // LLMO-4525 CI fix (branch coverage): the catch block uses
      // `e?.message || e` so that both Error instances AND bare thrown
      // values (strings, null, numbers — what some AWS SDK transports do
      // under the hood) produce a useful log line. The happy-path throw
      // test above only exercises the `.message` branch. This test pins
      // the fallback branch so coverage does not regress to < 100 %.
      // Matches the pattern used at the top of this file for
      // `createUrlInspectorStatsHandler` (bare-string-reject test) which
      // scopes the `prefer-promise-reject-errors` disable to a single
      // line — intentional non-Error rejection to exercise the fallback.
      const { context, rpcStub } = createContext({}, {});
      /* eslint-disable prefer-promise-reject-errors */
      rpcStub.callsFake(() => Promise.reject('bare-string-rejection'));
      /* eslint-enable prefer-promise-reject-errors */

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);
      expect(response.status).to.equal(500);

      expect(context.log.error).to.have.been.calledOnce;
      const [message, meta] = context.log.error.firstCall.args;
      expect(message).to.contain('bare-string-rejection');
      expect(meta).to.include({ route: 'url-inspector-filter-dimensions', siteId: SITE_ID });
    });

    it('returns 400 for invalid platform value', async () => {
      const { context } = createContext({}, { platform: 'not-a-real-model' });

      const handler = createUrlInspectorFilterDimensionsHandler(getOrgAndValidateAccess());
      const response = await handler(context);

      expect(response.status).to.equal(400);
    });
  });
});
