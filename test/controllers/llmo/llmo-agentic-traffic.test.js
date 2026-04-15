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
  createAgenticTrafficMoversHandler,
  createAgenticTrafficKpisHandler,
  createAgenticTrafficKpisTrendHandler,
  createAgenticTrafficByRegionHandler,
  createAgenticTrafficByCategoryHandler,
  createAgenticTrafficByPageTypeHandler,
  createAgenticTrafficByStatusHandler,
  createAgenticTrafficByUserAgentHandler,
  createAgenticTrafficByUrlHandler,
  createAgenticTrafficFilterDimensionsHandler,
  createAgenticTrafficWeeksHandler,
  createAgenticTrafficUrlBrandPresenceHandler,
} from '../../../src/controllers/llmo/llmo-agentic-traffic.js';

use(sinonChai);

const SITE_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Minimal chainable PostgREST client mock.
 * rpcResults: { [rpcName]: { data, error } }
 * tableResults: { [tableName]: { data, error } }
 */
function createMockClient(rpcResults = {}, tableResults = {}) {
  const defaultResult = { data: [], error: null };

  const rpc = sinon.stub().callsFake((name) => Promise.resolve(rpcResults[name] ?? defaultResult));

  const makeChain = (tableName) => {
    const result = tableResults[tableName] ?? defaultResult;
    const chain = {
      select: sinon.stub().returnsThis(),
      eq: sinon.stub().returnsThis(),
      gte: sinon.stub().returnsThis(),
      lte: sinon.stub().returnsThis(),
      not: sinon.stub().returnsThis(),
      neq: sinon.stub().returnsThis(),
      order: sinon.stub().returnsThis(),
      limit: sinon.stub().resolves(result),
    };
    return chain;
  };

  const from = sinon.stub().callsFake((tableName) => makeChain(tableName));

  return { rpc, from };
}

function makeContext(overrides = {}) {
  return {
    params: { siteId: SITE_ID, ...overrides.params },
    data: { startDate: '2026-01-01', endDate: '2026-01-28', ...overrides.data },
    dataAccess: {
      Site: {
        postgrestService: overrides.client ?? createMockClient(),
        findById: sinon.stub().resolves({ getOrganizationId: () => 'org-1' }),
      },
      Organization: {
        findById: sinon.stub().resolves({ id: 'org-1' }),
      },
      ...overrides.dataAccess,
    },
    log: { error: sinon.stub(), info: sinon.stub() },
    ...overrides.context,
  };
}

// Resolves with the same shape as the real getSiteAndValidateAccess so that
// withAgenticTrafficAuth forwards { site, organization } to handlerFn as siteContext.
const stubbedValidateAccess = sinon.stub().resolves({
  site: { getOrganizationId: () => 'org-1' },
  organization: { getId: () => 'org-1' },
});

describe('llmo-agentic-traffic', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
    // reset() clears call history AND any per-test behaviour overrides;
    // then re-apply the default so subsequent tests get the site context.
    stubbedValidateAccess.reset();
    stubbedValidateAccess.resolves({
      site: { getOrganizationId: () => 'org-1' },
      organization: { getId: () => 'org-1' },
    });
  });

  // ── Shared: PostgREST availability ──────────────────────────────────────────

  describe('PostgREST not available', () => {
    it('returns 400 when Site.postgrestService is missing', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Site.postgrestService = null;
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
    });
  });

  // ── Shared: Access control ─────────────────────────────────────────────────

  describe('access control', () => {
    it('returns 400 with message for unexpected access error', async () => {
      const unexpectedError = sinon.stub().rejects(new Error('Something unexpected'));
      const ctx = makeContext();
      const handler = createAgenticTrafficKpisHandler(unexpectedError);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body.message).to.include('Something unexpected');
    });
    it('returns 403 when getSiteAndValidateAccess throws an access error', async () => {
      const denyAccess = sinon.stub().rejects(new Error('Only users belonging to the organization'));
      const ctx = makeContext();
      const handler = createAgenticTrafficKpisHandler(denyAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 400 when getSiteAndValidateAccess throws not found error', async () => {
      const denyAccess = sinon.stub().rejects(new Error('Site not found: some-id'));
      const ctx = makeContext();
      const handler = createAgenticTrafficKpisHandler(denyAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
    });
  });

  // ── Platform code translation ──────────────────────────────────────────────

  describe('platform code to DB value translation', () => {
    const cases = [
      ['openai', 'ChatGPT'],
      ['chatgpt', 'ChatGPT'],
      ['anthropic', 'Anthropic'],
      ['mistral', 'MistralAI'],
      ['perplexity', 'Perplexity'],
      ['gemini', 'Gemini'],
      ['google', 'Google'],
      ['amazon', 'Amazon'],
      ['all', null],
      [undefined, null],
      ['unknown-code', null],
    ];

    cases.forEach(([input, expected]) => {
      it(`translates platform='${input}' → p_platform=${JSON.stringify(expected)}`, async () => {
        const client = createMockClient({ rpc_agentic_traffic_kpis: { data: [], error: null } });
        const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', platform: input } });
        const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
        await handler(ctx);
        expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis', {
          p_platform: expected,
        });
      });
    });
  });

  // ── KPIs ───────────────────────────────────────────────────────────────────

  describe('createAgenticTrafficKpisHandler', () => {
    it('returns mapped KPI data on success', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis: {
          data: [{
            total_hits: 1000,
            success_rate: 95.5,
            avg_ttfb_ms: 200.3,
            avg_citability_score: 72.1,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.totalHits).to.equal(1000);
      expect(body.successRate).to.equal(95.5);
      expect(body.avgTtfbMs).to.equal(200.3);
      expect(body.avgCitabilityScore).to.equal(72.1);
    });

    it('returns zeros when RPC returns empty data', async () => {
      const client = createMockClient({ rpc_agentic_traffic_kpis: { data: [], error: null } });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.totalHits).to.equal(0);
    });

    it('returns null for optional fields when DB returns null values', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis: {
          data: [{
            total_hits: 0, success_rate: null, avg_ttfb_ms: null, avg_citability_score: null,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body.successRate).to.be.null;
      expect(body.avgTtfbMs).to.be.null;
      expect(body.avgCitabilityScore).to.be.null;
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });

    it('accepts snake_case query parameter aliases', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        context: {
          data: {
            start_date: '2026-01-01',
            end_date: '2026-01-28',
            category_name: 'Products',
            agent_type: 'Chatbots',
            user_agent: 'GPTBot',
            content_type: 'html',
          },
        },
      });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis', {
        p_start_date: '2026-01-01',
        p_end_date: '2026-01-28',
        p_category_name: 'Products',
        p_agent_type: 'Chatbots',
        p_user_agent: 'GPTBot',
        p_content_type: 'html',
      });
    });

    it('uses the default date range when dates are omitted', async () => {
      sandbox.useFakeTimers(new Date('2026-02-01T12:00:00.000Z'));
      const client = createMockClient({
        rpc_agentic_traffic_kpis: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        context: {
          data: undefined,
        },
      });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis', {
        p_start_date: '2026-01-04',
        p_end_date: '2026-02-01',
      });
    });
  });

  // ── KPIs Trend ─────────────────────────────────────────────────────────────

  describe('createAgenticTrafficKpisTrendHandler', () => {
    it('returns trend rows on success', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: {
          data: [
            {
              period_start: '2026-01-05', total_hits: 500, success_rate: 90, avg_ttfb_ms: 180, avg_citability_score: 70,
            },
            {
              period_start: '2026-01-12', total_hits: 600, success_rate: 92, avg_ttfb_ms: 175, avg_citability_score: 75,
            },
          ],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.length(2);
      expect(body[0].periodStart).to.equal('2026-01-05');
      expect(body[0].totalHits).to.equal(500);
    });

    it('defaults to week interval when not specified', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_interval: 'week',
      });
    });

    it('accepts a valid interval override', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', interval: 'day' } });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_interval: 'day',
      });
    });

    it('falls back to week for an invalid interval value', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', interval: 'invalid' } });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_interval: 'week',
      });
    });

    it('returns null for optional fields and 0 for null total_hits', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: {
          data: [{
            period_start: '2026-01-05',
            total_hits: null,
            success_rate: null,
            avg_ttfb_ms: null,
            avg_citability_score: null,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].totalHits).to.equal(0);
      expect(body[0].successRate).to.be.null;
      expect(body[0].avgTtfbMs).to.be.null;
      expect(body[0].avgCitabilityScore).to.be.null;
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── By Region ──────────────────────────────────────────────────────────────

  describe('createAgenticTrafficByRegionHandler', () => {
    it('returns region data on success', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_region: {
          data: [{ region: 'US', total_hits: 800 }, { region: 'DE', total_hits: 200 }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByRegionHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body[0].region).to.equal('US');
      expect(body[0].totalHits).to.equal(800);
    });

    it('defaults null region and null total_hits to safe values', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_region: {
          data: [{ region: null, total_hits: null }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByRegionHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].region).to.equal('');
      expect(body[0].totalHits).to.equal(0);
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_region: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByRegionHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── By Category ────────────────────────────────────────────────────────────

  describe('createAgenticTrafficByCategoryHandler', () => {
    it('returns category data on success', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_category: {
          data: [{ category_name: 'Electronics', total_hits: 400 }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByCategoryHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body[0].categoryName).to.equal('Electronics');
    });

    it('substitutes Uncategorized for null category_name and 0 for null total_hits', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_category: {
          data: [{ category_name: null, total_hits: null }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByCategoryHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].categoryName).to.equal('Uncategorized');
      expect(body[0].totalHits).to.equal(0);
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_category: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByCategoryHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── By Page Type ───────────────────────────────────────────────────────────

  describe('createAgenticTrafficByPageTypeHandler', () => {
    it('returns page type data', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_page_type: {
          data: [{ page_type: 'article', total_hits: 300 }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByPageTypeHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].pageType).to.equal('article');
    });

    it('defaults null page_type to Other and null total_hits to 0', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_page_type: {
          data: [{ page_type: null, total_hits: null }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByPageTypeHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].pageType).to.equal('Other');
      expect(body[0].totalHits).to.equal(0);
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_page_type: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByPageTypeHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── By Status ──────────────────────────────────────────────────────────────

  describe('createAgenticTrafficByStatusHandler', () => {
    it('returns status data and defaults null total_hits to 0', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_status: {
          data: [
            { http_status: 200, total_hits: 900 },
            { http_status: 404, total_hits: null },
          ],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].httpStatus).to.equal(200);
      expect(body[1].httpStatus).to.equal(404);
      expect(body[1].totalHits).to.equal(0);
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_status: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── By User Agent ──────────────────────────────────────────────────────────

  describe('createAgenticTrafficByUserAgentHandler', () => {
    it('returns user agent data with camelCase fields', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: {
          data: [{
            page_type: 'article', agent_type: 'Chatbots', unique_agents: 5, total_hits: 200,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUserAgentHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].pageType).to.equal('article');
      expect(body[0].agentType).to.equal('Chatbots');
      expect(body[0].uniqueAgents).to.equal(5);
    });

    it('handles null row fields with safe defaults', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: {
          data: [{
            page_type: null, agent_type: null, unique_agents: null, total_hits: null,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUserAgentHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].pageType).to.equal('');
      expect(body[0].agentType).to.equal('');
      expect(body[0].uniqueAgents).to.equal(0);
      expect(body[0].totalHits).to.equal(0);
    });

    it('does not include p_user_agent in the RPC call', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: { data: [], error: null },
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', userAgent: 'GPTBot' } });
      const handler = createAgenticTrafficByUserAgentHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcCallArgs = client.rpc.firstCall.args[1];
      expect(rpcCallArgs).to.not.have.property('p_user_agent');
    });

    it('falls back to desc for an invalid sort order', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: { data: [], error: null },
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', sortOrder: 'invalid' } });
      const handler = createAgenticTrafficByUserAgentHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_sort_order).to.equal('desc');
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUserAgentHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── By URL ─────────────────────────────────────────────────────────────────

  describe('createAgenticTrafficByUrlHandler', () => {
    it('returns URL data with camelCase fields', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_url: {
          data: [{
            host: 'example.com',
            url_path: '/page',
            total_count: 1,
            total_hits: 150,
            unique_agents: 3,
            top_agent: 'ChatGPT-User',
            top_agent_type: 'Chatbots',
            response_codes: [200, 301],
            success_rate: 98.5,
            avg_ttfb_ms: 120.5,
            category_name: 'Blog',
            avg_citability_score: 65.0,
            deployed_at_edge: true,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body.totalCount).to.equal(1);
      expect(body.rows[0].host).to.equal('example.com');
      expect(body.rows[0].urlPath).to.equal('/page');
      expect(body.rows[0].topAgent).to.equal('ChatGPT-User');
      expect(body.rows[0].topAgentType).to.equal('Chatbots');
      expect(body.rows[0].responseCodes).to.deep.equal([200, 301]);
      expect(body.rows[0].deployedAtEdge).to.equal(true);
    });

    it('caps limit at 500', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', limit: 99999 } });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcCallArgs = client.rpc.firstCall.args[1];
      expect(rpcCallArgs.p_page_limit).to.equal(500);
    });

    it('uses default limit of 50 when not specified', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_page_limit).to.equal(50);
    });

    it('falls back to desc for an invalid sort order', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', sortOrder: 'invalid' } });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_sort_order).to.equal('desc');
    });

    it('forwards pagination and path search params to the new RPC signature', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({
        client,
        data: {
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          limit: 75,
          pageOffset: 10,
          urlPathSearch: 'pricing',
        },
      });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_by_url', {
        p_page_limit: 75,
        p_page_offset: 10,
        p_url_path_search: 'pricing',
      });
    });

    it('normalizes invalid page offsets to 0', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({
        client,
        data: {
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          pageOffset: 'not-a-number',
        },
      });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_by_url', {
        p_page_offset: 0,
      });
    });

    it('handles null optional fields in URL rows', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_url: {
          data: [{
            host: null,
            url_path: null,
            total_hits: null,
            unique_agents: null,
            top_agent: null,
            top_agent_type: null,
            response_codes: null,
            success_rate: null,
            avg_ttfb_ms: null,
            category_name: null,
            avg_citability_score: null,
            deployed_at_edge: false,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body.rows[0].host).to.equal('');
      expect(body.rows[0].urlPath).to.equal('');
      expect(body.rows[0].topAgent).to.equal('');
      expect(body.rows[0].responseCodes).to.deep.equal([]);
      expect(body.rows[0].successRate).to.be.null;
      expect(body.rows[0].avgTtfbMs).to.be.null;
      expect(body.rows[0].avgCitabilityScore).to.be.null;
    });

    it('returns null for fields that are undefined in the response', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_url: {
          data: [{
            host: 'a.com',
            url_path: '/p',
            total_hits: 1,
            unique_agents: 1,
            top_agent: 'bot',
            top_agent_type: 'Chatbots',
            response_codes: [200],
            success_rate: undefined,
            avg_ttfb_ms: undefined,
            avg_citability_score: undefined,
            deployed_at_edge: undefined,
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body.rows[0].successRate).to.be.null;
      expect(body.rows[0].avgTtfbMs).to.be.null;
      expect(body.rows[0].avgCitabilityScore).to.be.null;
      expect(body.rows[0].deployedAtEdge).to.equal(false);
    });

    it('returns 500 when RPC returns an error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_url: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── Filter Dimensions ──────────────────────────────────────────────────────

  describe('createAgenticTrafficFilterDimensionsHandler', () => {
    it('returns distinct filter values from rpc_agentic_traffic_distinct_filters', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_distinct_filters: {
          data: [{
            categories: ['Electronics', 'Fashion'],
            agent_types: ['Chatbots', 'Research'],
            platforms: ['ChatGPT', 'Perplexity'],
            content_types: ['article', 'product'],
            user_agents: ['ClaudeBot', 'GPTBot', 'PerplexityBot'],
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficFilterDimensionsHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.categories).to.deep.equal(['Electronics', 'Fashion']);
      expect(body.agentTypes).to.deep.equal(['Chatbots', 'Research']);
      expect(body.platforms).to.deep.equal(['ChatGPT', 'Perplexity']);
      expect(body.contentTypes).to.deep.equal(['article', 'product']);
      expect(body.userAgents).to.deep.equal(['ClaudeBot', 'GPTBot', 'PerplexityBot']);
    });

    it('returns 500 when the RPC fails', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_distinct_filters: {
          data: null,
          error: { message: 'db error' },
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficFilterDimensionsHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });

    it('returns empty arrays when the RPC returns no rows', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_distinct_filters: {
          data: [],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficFilterDimensionsHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.categories).to.deep.equal([]);
      expect(body.agentTypes).to.deep.equal([]);
      expect(body.platforms).to.deep.equal([]);
      expect(body.contentTypes).to.deep.equal([]);
    });
  });

  // ── Movers ─────────────────────────────────────────────────────────────────

  describe('createAgenticTrafficMoversHandler', () => {
    it('returns top and bottom movers with camelCase fields', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_movers: {
          data: [
            {
              host: 'example.com',
              url_path: '/page-a',
              previous_hits: 100,
              current_hits: 200,
              hits_change: 100,
              change_percent: 100.00,
              direction: 'up',
            },
            {
              host: 'example.com',
              url_path: '/page-b',
              previous_hits: 200,
              current_hits: 80,
              hits_change: -120,
              change_percent: -60.00,
              direction: 'down',
            },
          ],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficMoversHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.length(2);
      expect(body[0].host).to.equal('example.com');
      expect(body[0].urlPath).to.equal('/page-a');
      expect(body[0].hitsChange).to.equal(100);
      expect(body[0].direction).to.equal('up');
      expect(body[1].direction).to.equal('down');
      expect(body[1].hitsChange).to.equal(-120);
    });

    it('defaults to limit 5 when not specified', async () => {
      const client = createMockClient({ rpc_agentic_traffic_movers: { data: [], error: null } });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficMoversHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcCallArgs = client.rpc.firstCall.args[1];
      expect(rpcCallArgs.p_limit).to.equal(5);
    });

    it('returns 500 on RPC error', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_movers: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficMoversHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });

    it('uses default limit of 5 when rawLimit parses to NaN', async () => {
      const client = createMockClient({ rpc_agentic_traffic_movers: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', limit: 'abc' } });
      const handler = createAgenticTrafficMoversHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_limit).to.equal(5);
    });

    it('handles null mover fields with safe defaults', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_movers: {
          data: [{
            host: null,
            url_path: null,
            previous_hits: null,
            current_hits: null,
            hits_change: null,
            change_percent: null,
            direction: 'up',
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficMoversHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].host).to.equal('');
      expect(body[0].urlPath).to.equal('');
      expect(body[0].previousHits).to.equal(0);
      expect(body[0].currentHits).to.equal(0);
      expect(body[0].hitsChange).to.equal(0);
    });

    it('returns null for changePercent when DB value is null', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_movers: {
          data: [{
            host: 'example.com',
            url_path: '/new-page',
            previous_hits: 0,
            current_hits: 50,
            hits_change: 50,
            change_percent: null,
            direction: 'up',
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficMoversHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body[0].changePercent).to.be.null;
    });
  });

  // ── Weeks ──────────────────────────────────────────────────────────────────

  describe('createAgenticTrafficWeeksHandler', () => {
    it('returns ISO weeks for the site date range', async () => {
      const client = createMockClient(
        {},
        {
          agentic_traffic: { data: [{ traffic_date: '2026-01-05' }], error: null },
        },
      );
      // First call (ascending) returns min date; second call (descending) returns max date.
      // Both are set to same table result here — the handler picks [0] from each call.
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.have.property('weeks');
      expect(Array.isArray(body.weeks)).to.equal(true);
    });

    it('returns empty weeks array when site has no data', async () => {
      const client = createMockClient({}, {
        agentic_traffic: { data: [], error: null },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.weeks).to.deep.equal([]);
    });

    it('returns 500 when PostgREST errors', async () => {
      const client = createMockClient({}, {
        agentic_traffic: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });

    it('returns 500 when the max-date query errors (min succeeds)', async () => {
      // Both calls go to agentic_traffic; use a counter to return different results.
      let callCount = 0;
      const makeChain = () => {
        const idx = callCount;
        callCount += 1;
        const result = idx === 0
          ? { data: [{ traffic_date: '2026-01-05' }], error: null }
          : { data: null, error: { message: 'max query failed' } };
        return {
          select: sinon.stub().returnsThis(),
          eq: sinon.stub().returnsThis(),
          not: sinon.stub().returnsThis(),
          neq: sinon.stub().returnsThis(),
          order: sinon.stub().returnsThis(),
          limit: sinon.stub().resolves(result),
        };
      };
      const client = { rpc: sinon.stub(), from: sinon.stub().callsFake(() => makeChain()) };
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficWeeksHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });

  // ── URL Brand Presence ──────────────────────────────────────────────────────

  describe('createAgenticTrafficUrlBrandPresenceHandler', () => {
    const RPC = 'rpc_brand_presence_url_detail';

    it('returns brand presence data for the URL on success', async () => {
      const rpcPayload = {
        totalCitations: 42,
        totalMentions: 30,
        uniquePrompts: 10,
        weeklyTrends: [
          { weekStr: '2026-W01', citationCount: 5, mentionCount: 3 },
        ],
        prompts: [
          {
            prompt: 'What is Adobe Express?',
            topic: 'Product Features',
            topicId: 'topic-uuid-1',
            regionCode: 'US',
            citations: 8,
            mentions: 6,
            avgSentiment: 0.75,
            avgVisibilityScore: 85.0,
            executionCount: 10,
          },
        ],
      };
      const client = createMockClient({
        [RPC]: { data: rpcPayload, error: null }, // RETURNS JSONB → object directly, not array
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', url: 'https://www.adobe.com/express' } });
      const handler = createAgenticTrafficUrlBrandPresenceHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.totalCitations).to.equal(42);
      expect(body.uniquePrompts).to.equal(10);
      expect(body.weeklyTrends).to.have.length(1);
      expect(body.prompts).to.have.length(1);
      expect(body.prompts[0].prompt).to.equal('What is Adobe Express?');
    });

    it('returns 400 when url param is missing', async () => {
      const client = createMockClient({ [RPC]: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28' } });
      const handler = createAgenticTrafficUrlBrandPresenceHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
      expect(client.rpc).not.to.have.been.called;
    });

    it('passes organizationId from site to the RPC', async () => {
      const client = createMockClient({
        [RPC]: {
          data: {
            totalCitations: 0, totalMentions: 0, uniquePrompts: 0, weeklyTrends: [], prompts: [],
          },
          error: null,
        },
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', url: 'https://example.com/page' } });
      const handler = createAgenticTrafficUrlBrandPresenceHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcArgs = client.rpc.firstCall.args[1];
      expect(rpcArgs.p_organization_id).to.equal('org-1');
      expect(rpcArgs.p_url).to.equal('https://example.com/page');
      expect(rpcArgs.p_site_id).to.equal(SITE_ID);
    });

    it('returns empty arrays when RPC returns no data', async () => {
      const client = createMockClient({ [RPC]: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', url: 'https://example.com' } });
      const handler = createAgenticTrafficUrlBrandPresenceHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.totalCitations).to.equal(0);
      expect(body.weeklyTrends).to.deep.equal([]);
      expect(body.prompts).to.deep.equal([]);
    });

    it('returns 500 when RPC errors', async () => {
      const client = createMockClient({ [RPC]: { data: null, error: { message: 'db error' } } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', url: 'https://example.com' } });
      const handler = createAgenticTrafficUrlBrandPresenceHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });
  });
});
