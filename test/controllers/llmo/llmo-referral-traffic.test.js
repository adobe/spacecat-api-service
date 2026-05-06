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
  createReferralTrafficFilterDimensionsHandler,
  createReferralTrafficKpisHandler,
  createReferralTrafficTrendHandler,
  createReferralTrafficByPlatformHandler,
  createReferralTrafficByRegionHandler,
  createReferralTrafficByPageIntentHandler,
  createReferralTrafficByUrlHandler,
  createReferralTrafficUrlTrendHandler,
  createReferralTrafficBusinessImpactHandler,
  createReferralTrafficWeeksHandler,
  createReferralTrafficHasDataHandler,
} from '../../../src/controllers/llmo/llmo-referral-traffic.js';

use(sinonChai);

const SITE_ID = '11111111-1111-1111-1111-111111111111';

/** RPC-based client — used by all handlers except /weeks. */
function makeRpcClient(result = { data: [], error: null }) {
  return { rpc: sinon.stub().resolves(result) };
}

/**
 * Chain-based client — used by the /weeks handler which queries the table
 * directly via .from().select().eq().order().limit().
 * limit() resolves minResult on the first call and maxResult on the second.
 */
function makeWeeksChainClient(
  minResult = { data: [], error: null },
  maxResult = { data: [], error: null },
) {
  const chain = {
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    order: sinon.stub().returnsThis(),
    limit: sinon.stub()
      .onFirstCall().resolves(minResult)
      .onSecondCall()
      .resolves(maxResult),
  };
  return { from: sinon.stub().returns(chain), chain };
}

/**
 * The two Traffic Insights tables checked by the has-data handler.
 * Must stay in sync with TRAFFIC_INSIGHTS_TABLES in llmo-referral-traffic.js.
 */
const HAS_DATA_TABLES = [
  'referral_traffic_optel',
  'referral_traffic_cdn',
];

/**
 * Chain-based client for the /has-data handler.
 *
 * @param {Record<string, object>} resultsByTable  - Per-table PostgREST results.
 *   Defaults to { data: [], error: null } for any table not specified.
 */
function makeHasDataChainClient(resultsByTable = {}) {
  const makeChain = (result) => ({
    select: sinon.stub().returnsThis(),
    eq: sinon.stub().returnsThis(),
    limit: sinon.stub().resolves(result),
  });
  const chains = {};
  const fromStub = sinon.stub();
  for (const table of HAS_DATA_TABLES) {
    chains[table] = makeChain(resultsByTable[table] ?? { data: [], error: null });
    fromStub.withArgs(table).returns(chains[table]);
  }
  return { from: fromStub, chains };
}

function makeContext(overrides = {}) {
  return {
    params: { siteId: SITE_ID, ...overrides.params },
    data: { startDate: '2026-01-01', endDate: '2026-01-28', ...overrides.data },
    dataAccess: {
      Site: {
        postgrestService: overrides.client ?? makeRpcClient(),
      },
    },
    log: { error: sinon.stub(), info: sinon.stub() },
  };
}

const stubbedValidateAccess = sinon.stub().resolves({
  site: { getOrganizationId: () => 'org-1' },
  organization: { getId: () => 'org-1' },
});

describe('llmo-referral-traffic', () => {
  afterEach(() => {
    stubbedValidateAccess.reset();
    stubbedValidateAccess.resolves({
      site: { getOrganizationId: () => 'org-1' },
      organization: { getId: () => 'org-1' },
    });
  });

  // ── auth / PostgREST availability ──────────────────────────────────────────

  describe('auth and PostgREST availability', () => {
    it('returns 400 when Site.postgrestService is missing', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = null;
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 403 when access validation throws access error', async () => {
      const deny = sinon.stub().rejects(new Error('Only users belonging to the organization'));
      const handler = createReferralTrafficKpisHandler(deny);
      const res = await handler(makeContext());
      expect(res.status).to.equal(403);
    });

    it('returns 400 when access validation throws not found error', async () => {
      const deny = sinon.stub().rejects(new Error('Site not found: foo'));
      const handler = createReferralTrafficKpisHandler(deny);
      const res = await handler(makeContext());
      expect(res.status).to.equal(400);
    });

    it('returns 500 for unexpected access errors', async () => {
      const deny = sinon.stub().rejects(new Error('Something unexpected'));
      const handler = createReferralTrafficKpisHandler(deny);
      const res = await handler(makeContext());
      expect(res.status).to.equal(500);
    });
  });

  // ── parseParams branches ──────────────────────────────────────────────────

  describe('parseParams', () => {
    it('uses {} when context.data is null (line 80)', async () => {
      const client = makeRpcClient({ data: [] });
      const ctx = makeContext({ client });
      ctx.data = null;
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      // defaults kick in — source=optel, dates from defaultDateRange()
      expect(res.status).to.equal(200);
      expect(client.rpc.getCall(0).args[1].p_source).to.equal('optel');
    });

    it('accepts snake_case start_date / end_date aliases (lines 86-87)', async () => {
      const client = makeRpcClient({ data: [] });
      const ctx = makeContext({ client });
      // Set data directly so startDate is absent and start_date alias is reached.
      ctx.data = { start_date: '2026-02-01', end_date: '2026-02-28' };
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcArgs = client.rpc.getCall(0).args[1];
      expect(rpcArgs.p_start_date).to.equal('2026-02-01');
      expect(rpcArgs.p_end_date).to.equal('2026-02-28');
    });

    it('falls back to default date range when no dates provided (lines 86-87)', async () => {
      const client = makeRpcClient({ data: [] });
      const ctx = makeContext({ client });
      ctx.data = {};
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcArgs = client.rpc.getCall(0).args[1];
      expect(rpcArgs.p_start_date).to.be.a('string').and.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(rpcArgs.p_end_date).to.be.a('string').and.match(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ── /filter-dimensions ────────────────────────────────────────────────────

  describe('filter-dimensions', () => {
    it('returns dimension arrays from RPC row', async () => {
      const client = makeRpcClient({
        data: [{
          platforms: ['openai', 'perplexity'],
          regions: ['US', 'DE'],
          devices: ['desktop', 'mobile'],
          page_intents: ['purchase'],
          available_sources: ['optel', 'cdn'],
        }],
      });
      const handler = createReferralTrafficFilterDimensionsHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.platforms).to.deep.equal(['openai', 'perplexity']);
      expect(body.regions).to.deep.equal(['US', 'DE']);
      expect(body.devices).to.deep.equal(['desktop', 'mobile']);
      expect(body.pageIntents).to.deep.equal(['purchase']);
      expect(body.availableSources).to.deep.equal(['optel', 'cdn']);
    });

    it('returns empty arrays when RPC returns no rows', async () => {
      const client = makeRpcClient({ data: [], error: null });
      const handler = createReferralTrafficFilterDimensionsHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.platforms).to.deep.equal([]);
      expect(body.availableSources).to.deep.equal([]);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'boom' } });
      const handler = createReferralTrafficFilterDimensionsHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /kpis ─────────────────────────────────────────────────────────────────

  describe('kpis', () => {
    it('maps RPC row to totalPageviews, bounceRate, consentRate', async () => {
      const client = makeRpcClient({
        data: [{ total_pageviews: 175, bounce_rate: 0.666667, consent_rate: 0.5 }],
      });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.totalPageviews).to.equal(175);
      expect(body.bounceRate).to.be.closeTo(0.666667, 1e-4);
      expect(body.consentRate).to.equal(0.5);
    });

    it('returns null bounceRate/consentRate when RPC returns null', async () => {
      const client = makeRpcClient({
        data: [{ total_pageviews: 10, bounce_rate: null, consent_rate: null }],
      });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.bounceRate).to.equal(null);
      expect(body.consentRate).to.equal(null);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'db down' } });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /trend ────────────────────────────────────────────────────────────────

  describe('trend', () => {
    it('maps RPC rows to date+pageviews series', async () => {
      const client = makeRpcClient({
        data: [
          { traffic_date: '2026-01-05', total_pageviews: 500 },
          { traffic_date: '2026-01-12', total_pageviews: 800 },
        ],
      });
      const handler = createReferralTrafficTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.trend).to.deep.equal([
        {
          date: '2026-01-05',
          pageviews: 500,
          entries: null,
          revenue: null,
          bounceRate: null,
          consentRate: null,
          avgSessionDuration: null,
          pagesPerVisit: null,
          orders: null,
          conversionRate: null,
        },
        {
          date: '2026-01-12',
          pageviews: 800,
          entries: null,
          revenue: null,
          bounceRate: null,
          consentRate: null,
          avgSessionDuration: null,
          pagesPerVisit: null,
          orders: null,
          conversionRate: null,
        },
      ]);
    });

    it('maps all optional numeric fields when non-null (lines 276-284)', async () => {
      const client = makeRpcClient({
        data: [{
          traffic_date: '2026-02-03',
          total_pageviews: 1000,
          entries: 800,
          revenue: 5000,
          bounce_rate: 0.35,
          consent_rate: 0.75,
          avg_session_duration: 180,
          pages_per_visit: 3.2,
          orders: 25,
          conversion_rate: 0.03,
        }],
      });
      const handler = createReferralTrafficTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.trend[0]).to.deep.equal({
        date: '2026-02-03',
        pageviews: 1000,
        entries: 800,
        revenue: 5000,
        bounceRate: 0.35,
        consentRate: 0.75,
        avgSessionDuration: 180,
        pagesPerVisit: 3.2,
        orders: 25,
        conversionRate: 0.03,
      });
    });

    it('returns empty trend array when RPC returns no rows', async () => {
      const client = makeRpcClient({ data: [], error: null });
      const handler = createReferralTrafficTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.trend).to.deep.equal([]);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'fail' } });
      const handler = createReferralTrafficTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /by-platform ──────────────────────────────────────────────────────────

  describe('by-platform', () => {
    it('maps RPC rows to platform+pageviews+bounceRate+channels', async () => {
      const client = makeRpcClient({
        data: [
          {
            platform: 'openai', total_pageviews: 100, bounce_rate: 0.3, channels: ['llm'],
          },
          {
            platform: 'google', total_pageviews: 50, bounce_rate: null, channels: ['social'],
          },
        ],
      });
      const handler = createReferralTrafficByPlatformHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.rows[0]).to.deep.equal({
        platform: 'openai',
        pageviews: 100,
        bounceRate: 0.3,
        channels: ['llm'],
        visits: null,
        avgTimeOnSite: null,
        revenue: null,
        visitors: null,
        orders: null,
      });
      expect(body.rows[1]).to.deep.equal({
        platform: 'google',
        pageviews: 50,
        bounceRate: null,
        channels: ['social'],
        visits: null,
        avgTimeOnSite: null,
        revenue: null,
        visitors: null,
        orders: null,
      });
    });

    it('maps visits, avgTimeOnSite and revenue when non-null (lines 328-330)', async () => {
      const client = makeRpcClient({
        data: [{
          platform: 'perplexity',
          total_pageviews: 200,
          bounce_rate: 0.25,
          channels: ['llm'],
          visits: 150,
          avg_time_on_site: 95,
          revenue: 1200,
        }],
      });
      const handler = createReferralTrafficByPlatformHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.rows[0]).to.deep.equal({
        platform: 'perplexity',
        pageviews: 200,
        bounceRate: 0.25,
        channels: ['llm'],
        visits: 150,
        avgTimeOnSite: 95,
        revenue: 1200,
        visitors: null,
        orders: null,
      });
    });

    it('maps visitors and orders when non-null (lines 332-333)', async () => {
      const client = makeRpcClient({
        data: [{
          platform: 'perplexity',
          total_pageviews: 200,
          bounce_rate: 0.25,
          channels: ['llm'],
          visits: 150,
          avg_time_on_site: 95,
          revenue: 1200,
          visitors: 80,
          orders: 12,
        }],
      });
      const handler = createReferralTrafficByPlatformHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.rows[0]).to.deep.equal({
        platform: 'perplexity',
        pageviews: 200,
        bounceRate: 0.25,
        channels: ['llm'],
        visits: 150,
        avgTimeOnSite: 95,
        revenue: 1200,
        visitors: 80,
        orders: 12,
      });
    });

    it('falls back to empty array when RPC returns null channels', async () => {
      const client = makeRpcClient({
        data: [{
          platform: 'openai', total_pageviews: 10, bounce_rate: null, channels: null,
        }],
      });
      const handler = createReferralTrafficByPlatformHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.rows[0].channels).to.deep.equal([]);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'err' } });
      const handler = createReferralTrafficByPlatformHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /by-region ────────────────────────────────────────────────────────────

  describe('by-region', () => {
    it('maps RPC rows to region+pageviews', async () => {
      const client = makeRpcClient({
        data: [
          { region: 'US', total_pageviews: 300 },
          { region: 'DE', total_pageviews: 100 },
        ],
      });
      const handler = createReferralTrafficByRegionHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.rows).to.deep.equal([
        { region: 'US', pageviews: 300 },
        { region: 'DE', pageviews: 100 },
      ]);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'region-fail' } });
      const handler = createReferralTrafficByRegionHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /by-page-intent ───────────────────────────────────────────────────────

  describe('by-page-intent', () => {
    it('maps RPC rows to pageIntent+pageviews', async () => {
      const client = makeRpcClient({
        data: [
          { page_intent: 'purchase', total_pageviews: 80 },
          { page_intent: '', total_pageviews: 20 },
        ],
      });
      const handler = createReferralTrafficByPageIntentHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.rows).to.deep.equal([
        { pageIntent: 'purchase', pageviews: 80 },
      ]);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'intent-fail' } });
      const handler = createReferralTrafficByPageIntentHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /by-url ───────────────────────────────────────────────────────────────

  describe('by-url', () => {
    it('maps RPC rows including new fields (bounceRate, consentRate, pageIntent)', async () => {
      const client = makeRpcClient({
        data: [
          {
            url_path: '/products',
            host: 'example.com',
            total_pageviews: 200,
            bounce_rate: 0.4,
            consent_rate: 0.9,
            page_intent: 'purchase',
            total_count: 2,
          },
          {
            url_path: '/blog',
            host: null,
            total_pageviews: 50,
            bounce_rate: null,
            consent_rate: null,
            page_intent: null,
            total_count: 2,
          },
        ],
      });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.totalCount).to.equal(2);
      expect(body.rows[0]).to.deep.equal({
        urlPath: '/products',
        host: 'example.com',
        pageviews: 200,
        bounceRate: 0.4,
        consentRate: 0.9,
        pageIntent: 'purchase',
        entries: null,
        exits: null,
        avgTimeOnSite: null,
        revenue: null,
      });
      expect(body.rows[1]).to.deep.equal({
        urlPath: '/blog',
        host: '',
        pageviews: 50,
        bounceRate: null,
        consentRate: null,
        pageIntent: null,
        entries: null,
        exits: null,
        avgTimeOnSite: null,
        revenue: null,
      });
    });

    it('returns totalCount 0 when data is empty', async () => {
      const client = makeRpcClient({ data: [], error: null });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.totalCount).to.equal(0);
      expect(body.rows).to.deep.equal([]);
    });

    it('passes urlPathSearch to RPC', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { urlPathSearch: 'blog' } }));
      expect(client.rpc.getCall(0).args[1].p_url_search).to.equal('blog');
    });

    it('clamps pageSize above the max', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { pageSize: 10000 } }));
      expect(client.rpc.getCall(0).args[1].p_limit).to.equal(1000);
    });

    it('uses {} when context.data is null in by-url handler (line 412)', async () => {
      const client = makeRpcClient({ data: [] });
      const ctx = makeContext({ client });
      ctx.data = null;
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
    });

    it('accepts page_size alias (line 406)', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { page_size: 25 } }));
      expect(client.rpc.getCall(0).args[1].p_limit).to.equal(25);
    });

    it('accepts pageOffset to exercise rawOffset != null true branch (line 416)', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { pageOffset: 50 } }));
      expect(client.rpc.getCall(0).args[1].p_offset).to.equal(50);
    });

    it('covers Number.parseInt || 0 branch via page_offset: 0 alias (line 422)', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      // page_offset: 0 → rawOffset = undefined || 0 = 0 → 0 != null → enters ternary true branch
      // parseInt('0') = 0 → 0 || 0 hits the right-hand fallback
      await handler(makeContext({ client, data: { page_offset: 0 } }));
      expect(client.rpc.getCall(0).args[1].p_offset).to.equal(0);
    });

    it('falls back to desc for invalid sortOrder (line 428)', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { sortOrder: 'invalid' } }));
      expect(client.rpc.getCall(0).args[1].p_sort_order).to.equal('desc');
    });

    it('accepts sort_order snake_case alias (line 422)', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { sort_order: 'asc' } }));
      expect(client.rpc.getCall(0).args[1].p_sort_order).to.equal('asc');
    });

    it('defaults sort to total_pageviews desc', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client }));
      const rpcArgs = client.rpc.getCall(0).args[1];
      expect(rpcArgs.p_sort_by).to.equal('total_pageviews');
      expect(rpcArgs.p_sort_order).to.equal('desc');
    });

    it('passes valid sortBy and sortOrder to RPC', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { sortBy: 'bounce_rate', sortOrder: 'asc' } }));
      const rpcArgs = client.rpc.getCall(0).args[1];
      expect(rpcArgs.p_sort_by).to.equal('bounce_rate');
      expect(rpcArgs.p_sort_order).to.equal('asc');
    });

    it('falls back to total_pageviews for unknown sortBy', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { sortBy: 'hacked_column' } }));
      expect(client.rpc.getCall(0).args[1].p_sort_by).to.equal('total_pageviews');
    });

    it('maps entries, exits, avgTimeOnSite, revenue when non-null (lines 526-529)', async () => {
      const client = makeRpcClient({
        data: [{
          url_path: '/checkout',
          host: 'shop.example.com',
          total_pageviews: 500,
          bounce_rate: 0.2,
          consent_rate: 0.8,
          page_intent: 'purchase',
          entries: 400,
          exits: 100,
          avg_time_on_site: 210,
          revenue: 9800,
          total_count: 1,
        }],
      });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.rows[0]).to.deep.equal({
        urlPath: '/checkout',
        host: 'shop.example.com',
        pageviews: 500,
        bounceRate: 0.2,
        consentRate: 0.8,
        pageIntent: 'purchase',
        entries: 400,
        exits: 100,
        avgTimeOnSite: 210,
        revenue: 9800,
      });
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'url-fail' } });
      const handler = createReferralTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /by-url-trend ─────────────────────────────────────────────────────────

  describe('by-url-trend', () => {
    it('returns 400 when urlPath param is missing', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when urlPath is only whitespace', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { urlPath: '   ' } }));
      expect(res.status).to.equal(400);
    });

    it('returns empty trend array when RPC returns no rows', async () => {
      const client = makeRpcClient({ data: [], error: null });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { urlPath: '/blog' } }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.trend).to.deep.equal([]);
    });

    it('maps week_start and total_pageviews to camelCase response shape', async () => {
      const client = makeRpcClient({
        data: [
          { week_start: '2026-04-14', total_pageviews: 120 },
          { week_start: '2026-04-21', total_pageviews: 200 },
        ],
      });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { urlPath: '/products' } }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.trend).to.deep.equal([
        { weekStart: '2026-04-14', pageviews: 120 },
        { weekStart: '2026-04-21', pageviews: 200 },
      ]);
    });

    it('passes urlPath to RPC as p_url_path', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { urlPath: '/products' } }));
      expect(client.rpc.getCall(0).args[1].p_url_path).to.equal('/products');
    });

    it('passes the RPC name rpc_referral_traffic_url_trend', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { urlPath: '/products' } }));
      expect(client.rpc.getCall(0).args[0]).to.equal('rpc_referral_traffic_url_trend');
    });

    it('forwards common params (source, dates, platform) to RPC', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      await handler(makeContext({
        client,
        data: {
          urlPath: '/blog',
          source: 'adobe_analytics',
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          platform: 'openai',
        },
      }));
      const rpcArgs = client.rpc.getCall(0).args[1];
      expect(rpcArgs.p_source).to.equal('adobe_analytics');
      expect(rpcArgs.p_start_date).to.equal('2026-01-01');
      expect(rpcArgs.p_end_date).to.equal('2026-01-28');
      expect(rpcArgs.p_platform).to.equal('openai');
    });

    it('uses {} when context.data is null', async () => {
      const client = makeRpcClient({ data: [] });
      const ctx = makeContext({ client });
      ctx.data = null;
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      // urlPath will be null → 400
      expect(res.status).to.equal(400);
    });

    it('returns 500 and logs error on PostgREST failure', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'by-url-trend-fail' } });
      const ctx = makeContext({ client, data: { urlPath: '/fail' } });
      const handler = createReferralTrafficUrlTrendHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
      expect(ctx.log.error).to.have.been.calledWithMatch(/by-url-trend-fail/);
    });
  });

  // ── /business-impact ──────────────────────────────────────────────────────

  describe('business-impact', () => {
    it('maps RPC row to source+metrics for adobe_analytics', async () => {
      const client = makeRpcClient({
        data: [{
          total_pageviews: 30, visits: 15, bounce_rate: 0.2, orders: 3, revenue: 300,
        }],
      });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { source: 'adobe_analytics' } }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.source).to.equal('adobe_analytics');
      expect(body.totalPageviews).to.equal(30);
      expect(body.metrics.visits).to.equal(15);
      expect(body.metrics.bounceRate).to.be.closeTo(0.2, 1e-6);
      expect(body.metrics.orders).to.equal(3);
      expect(body.metrics.revenue).to.equal(300);
    });

    it('maps RPC row to source+metrics for ga4', async () => {
      const client = makeRpcClient({
        data: [{
          total_pageviews: 12, visits: 7, bounce_rate: 0.1, orders: 2, revenue: 120,
        }],
      });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { source: 'ga4' } }));
      const body = await res.json();
      expect(body.source).to.equal('ga4');
      expect(body.metrics.visits).to.equal(7);
    });

    it('uses {} when context.data is null — defaults source to adobe_analytics (line 553)', async () => {
      const client = makeRpcClient({ data: [] });
      const ctx = makeContext({ client });
      ctx.data = null;
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body.source).to.equal('adobe_analytics');
    });

    it('returns 400 for an unrecognised source', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { source: 'weird' } }));
      expect(res.status).to.equal(400);
    });

    it('returns 400 when source is optel (not supported by business-impact)', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client, data: { source: 'optel' } }));
      expect(res.status).to.equal(400);
    });

    it('maps optional numeric metrics when all fields are present', async () => {
      const client = makeRpcClient({
        data: [{
          total_pageviews: 100,
          visits: 50,
          bounce_rate: 0.3,
          entries: 40,
          avg_session_duration: 120,
          pages_per_visit: 2.5,
          conversion_rate: 0.05,
          orders: 5,
          revenue: 500,
        }],
      });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.metrics.entries).to.equal(40);
      expect(body.metrics.avgSessionDuration).to.equal(120);
      expect(body.metrics.pagesPerVisit).to.be.closeTo(2.5, 1e-6);
      expect(body.metrics.conversionRate).to.be.closeTo(0.05, 1e-6);
    });

    it('returns null bounceRate when bounce_rate is null', async () => {
      const client = makeRpcClient({
        data: [{
          total_pageviews: 0, visits: 0, bounce_rate: null, orders: 0, revenue: 0,
        }],
      });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      const body = await res.json();
      expect(body.metrics.bounceRate).to.equal(null);
    });

    it('returns 500 on PostgREST error', async () => {
      const client = makeRpcClient({ data: null, error: { message: 'impact-fail' } });
      const handler = createReferralTrafficBusinessImpactHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });
  });

  // ── /weeks ────────────────────────────────────────────────────────────────

  describe('weeks', () => {
    it('returns ISO week range between min and max traffic_date', async () => {
      const client = makeWeeksChainClient(
        { data: [{ traffic_date: '2026-01-05' }], error: null },
        { data: [{ traffic_date: '2026-01-19' }], error: null },
      );
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.weeks).to.be.an('array').with.length.greaterThan(0);
      body.weeks.forEach((w) => {
        expect(w).to.have.keys(['week', 'startDate', 'endDate']);
        expect(w.week).to.match(/^\d{4}-W\d{2}$/);
      });
    });

    it('returns empty weeks when no data exists for site', async () => {
      const client = makeWeeksChainClient(
        { data: [], error: null },
        { data: [], error: null },
      );
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.weeks).to.deep.equal([]);
    });

    it('returns 500 when min-date query fails', async () => {
      const client = makeWeeksChainClient(
        { data: null, error: { message: 'min-fail' } },
        { data: [{ traffic_date: '2026-01-19' }], error: null },
      );
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });

    it('returns 500 when max-date query fails', async () => {
      const client = makeWeeksChainClient(
        { data: [{ traffic_date: '2026-01-05' }], error: null },
        { data: null, error: { message: 'max-fail' } },
      );
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(makeContext({ client }));
      expect(res.status).to.equal(500);
    });

    it('returns 400 when Site.postgrestService is missing', async () => {
      const ctx = makeContext({ client: makeWeeksChainClient() });
      ctx.dataAccess.Site.postgrestService = null;
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
    });

    it('queries the source-specific table when ?source is given', async () => {
      const client = makeWeeksChainClient(
        { data: [{ traffic_date: '2026-01-05' }], error: null },
        { data: [{ traffic_date: '2026-01-12' }], error: null },
      );
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { source: 'cdn' } }));
      expect(client.from.calledWith('referral_traffic_cdn')).to.be.true;
    });

    it('defaults to referral_traffic_optel when source is omitted', async () => {
      const client = makeWeeksChainClient(
        { data: [{ traffic_date: '2026-01-05' }], error: null },
        { data: [{ traffic_date: '2026-01-12' }], error: null },
      );
      const handler = createReferralTrafficWeeksHandler(stubbedValidateAccess);
      await handler(makeContext({ client }));
      expect(client.from.calledWith('referral_traffic_optel')).to.be.true;
    });
  });

  // ── /has-data ─────────────────────────────────────────────────────────────
  // Checks only Traffic Insights sources (optel, cdn). Business Impact sources
  // (adobe_analytics, ga4) are gated separately via the DRS provider endpoint.

  const ROW = { traffic_date: '2026-01-05' };

  describe('has-data', () => {
    it('returns hasData:true and availableSources:["optel"] when only optel has records', async () => {
      const client = makeHasDataChainClient({
        referral_traffic_optel: { data: [ROW], error: null },
      });
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(true);
      expect(body.availableSources).to.deep.equal(['optel']);
    });

    it('returns hasData:true and availableSources:["cdn"] when only cdn has records', async () => {
      const client = makeHasDataChainClient({
        referral_traffic_cdn: { data: [ROW], error: null },
      });
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(true);
      expect(body.availableSources).to.deep.equal(['cdn']);
    });

    it('returns hasData:true and availableSources:["optel","cdn"] when both have records', async () => {
      const client = makeHasDataChainClient({
        referral_traffic_optel: { data: [ROW], error: null },
        referral_traffic_cdn: { data: [ROW], error: null },
      });
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(true);
      expect(body.availableSources).to.deep.equal(['optel', 'cdn']);
    });

    it('returns hasData:false and availableSources:[] when both tables are empty', async () => {
      const client = makeHasDataChainClient();
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(false);
      expect(body.availableSources).to.deep.equal([]);
    });

    it('returns hasData:false and availableSources:[] when both tables return null data', async () => {
      const nullResults = Object.fromEntries(
        HAS_DATA_TABLES.map((t) => [t, { data: null, error: null }]),
      );
      const client = makeHasDataChainClient(nullResults);
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(false);
      expect(body.availableSources).to.deep.equal([]);
    });

    it('returns 500 and fails closed when one source errors (even if the other has data)', async () => {
      const client = makeHasDataChainClient({
        referral_traffic_optel: { data: [ROW], error: null },
        referral_traffic_cdn: { data: null, error: { message: 'cdn-fail' } },
      });
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(500);
    });

    it('returns 500 when both sources error simultaneously', async () => {
      const errorResults = Object.fromEntries(
        HAS_DATA_TABLES.map((t) => [t, { data: null, error: { message: `${t}-fail` } }]),
      );
      const client = makeHasDataChainClient(errorResults);
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(
        makeContext({ client }),
      );
      expect(res.status).to.equal(500);
    });

    it('logs the erroring table name and siteId on PostgREST error', async () => {
      const client = makeHasDataChainClient({
        referral_traffic_cdn: { data: null, error: { message: 'cdn-pg-fail' } },
      });
      const ctx = makeContext({ client });
      await createReferralTrafficHasDataHandler(stubbedValidateAccess)(ctx);
      expect(ctx.log.error).to.have.been.calledWithMatch(/referral_traffic_cdn/);
      expect(ctx.log.error).to.have.been.calledWithMatch(/cdn-pg-fail/);
      expect(ctx.log.error).to.have.been.calledWithMatch(new RegExp(SITE_ID));
    });

    it('returns 500 when limit() rejects (thrown error from PostgREST client)', async () => {
      const throwingChain = {
        select: sinon.stub().returnsThis(),
        eq: sinon.stub().returnsThis(),
        limit: sinon.stub().rejects(new Error('network timeout')),
      };
      const ctx = makeContext({ client: { from: sinon.stub().returns(throwingChain) } });
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(ctx);
      expect(res.status).to.equal(500);
    });

    it('queries only optel and cdn tables with the site id', async () => {
      const client = makeHasDataChainClient();
      await createReferralTrafficHasDataHandler(stubbedValidateAccess)(makeContext({ client }));
      for (const table of HAS_DATA_TABLES) {
        expect(client.from).to.have.been.calledWith(table);
        expect(client.chains[table].eq).to.have.been.calledWith('site_id', SITE_ID);
        expect(client.chains[table].limit).to.have.been.calledWith(1);
      }
      expect(client.from).not.to.have.been.calledWith('referral_traffic_adobe_analytics');
      expect(client.from).not.to.have.been.calledWith('referral_traffic_ga4');
    });

    it('returns 400 when Site.postgrestService is missing', async () => {
      const ctx = makeContext({ client: makeHasDataChainClient() });
      ctx.dataAccess.Site.postgrestService = null;
      const res = await createReferralTrafficHasDataHandler(stubbedValidateAccess)(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 403 when access validation denies the request', async () => {
      const deny = sinon.stub().rejects(new Error('Only users belonging to the organization'));
      const res = await createReferralTrafficHasDataHandler(deny)(
        makeContext({ client: makeHasDataChainClient() }),
      );
      expect(res.status).to.equal(403);
    });
  });

  // ── platform filter mapping ───────────────────────────────────────────────

  describe('platform filter mapping', () => {
    it('maps "chatgpt" to DB "openai"', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { platform: 'chatgpt' } }));
      expect(client.rpc.getCall(0).args[1].p_platform).to.equal('openai');
    });

    it('maps "anthropic" to DB "claude"', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { platform: 'anthropic' } }));
      expect(client.rpc.getCall(0).args[1].p_platform).to.equal('claude');
    });

    it('passes null for unknown platforms', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { platform: 'bogus' } }));
      expect(client.rpc.getCall(0).args[1].p_platform).to.equal(null);
    });
  });

  // ── source selection ──────────────────────────────────────────────────────

  describe('source selection', () => {
    it('defaults to optel', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(makeContext({ client }));
      expect(client.rpc.getCall(0).args[1].p_source).to.equal('optel');
    });

    it('uses specified source when valid', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { source: 'cdn' } }));
      expect(client.rpc.getCall(0).args[1].p_source).to.equal('cdn');
    });

    it('falls back to optel when source is invalid', async () => {
      const client = makeRpcClient({ data: [] });
      const handler = createReferralTrafficKpisHandler(stubbedValidateAccess);
      await handler(makeContext({ client, data: { source: 'invalid' } }));
      expect(client.rpc.getCall(0).args[1].p_source).to.equal('optel');
    });
  });
});
