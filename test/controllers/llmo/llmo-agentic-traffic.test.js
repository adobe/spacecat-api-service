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
  createAgenticTrafficHasDataHandler,
  createAgenticTrafficUrlsExportHandler,
  createAgenticTrafficUrlsExportStatusHandler,
  jcsStringify,
} from '../../../src/controllers/llmo/llmo-agentic-traffic.js';

use(sinonChai);

const SITE_ID = '11111111-1111-1111-1111-111111111111';
const EXPORT_ID = 'a'.repeat(64);

function ListObjectsV2Command(input) {
  this.input = input;
}

function GetObjectCommand(input) {
  this.input = input;
}

function DeleteObjectCommand(input) {
  this.input = input;
}

function PutObjectCommand(input) {
  this.input = input;
}

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
    log: { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() },
    ...overrides.context,
  };
}

// Stubs s3Client.send so ListObjectsV2 returns the supplied keys (or echoes
// the request Prefix when `echoPrefix` is set, simulating a single cached
// object at the deterministic key the controller computed) and GetObject
// returns the supplied metadata (or 404 NoSuchKey when metadata is omitted).
function stubS3({ keys = [], echoPrefix = false, metadata } = {}) {
  return sinon.stub().callsFake((command) => {
    if (command instanceof ListObjectsV2Command) {
      const Contents = echoPrefix
        ? [{ Key: command.input.Prefix }]
        : keys.map((Key) => ({ Key }));
      return Promise.resolve({ Contents });
    }
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({});
    }
    if (command instanceof DeleteObjectCommand) {
      return Promise.resolve({});
    }
    if (metadata === undefined) {
      const error = new Error('not found');
      error.name = 'NoSuchKey';
      return Promise.reject(error);
    }
    return Promise.resolve({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(metadata)) },
    });
  });
}

function makeExportContext(overrides = {}) {
  const send = sinon.stub().callsFake((command) => {
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [], NextContinuationToken: undefined });
    }
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({});
    }
    if (command instanceof DeleteObjectCommand) {
      return Promise.resolve({});
    }
    const error = new Error('not found');
    error.name = 'NoSuchKey';
    return Promise.reject(error);
  });
  const s3 = {
    s3Client: { send },
    s3Bucket: 'default-bucket',
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    getSignedUrl: sinon.stub().resolves('https://signed.example.com/export.csv'),
    ...overrides.s3,
  };
  const sqs = {
    sendMessage: sinon.stub().resolves(),
    ...overrides.sqs,
  };
  return makeContext({
    ...overrides,
    context: {
      ...overrides.context,
      s3,
      sqs,
      env: {
        REPORT_JOBS_QUEUE_URL: 'https://sqs.example.com/report-jobs',
        S3_REPORT_BUCKET: 'report-bucket',
        ...overrides.context?.env,
      },
      runtime: { region: 'us-east-1', ...overrides.context?.runtime },
      attributes: {
        authInfo: { profile: { email: 'user@example.com' } },
        ...overrides.context?.attributes,
      },
    },
  });
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
            success_rate: 'high',
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
        p_success_rate: 'high',
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

  // ── agentTypes additive inclusion list ────────────────────────────────────

  describe('agentTypes inclusion list', () => {
    it('forwards a comma-separated list to kpis-trend as canonical TEXT[]', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', agentTypes: 'Chatbots,Research' },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_agent_types: ['Chatbots', 'Research'],
      });
    });

    it('forwards an array passed directly without re-splitting', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', agentTypes: ['Chatbots', 'Research'] },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_agent_types: ['Chatbots', 'Research'],
      });
    });

    it('drops unknown agent types silently and dedupes case-insensitively', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: {
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          agentTypes: 'chatbots, RESEARCH , unknown ,Chatbots',
        },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_agent_types: ['Chatbots', 'Research'],
      });
    });

    it('ignores non-string entries when an array is passed directly', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        // Defensive coercion: if a caller hands us an array with a
        // non-string element (e.g. a serialiser bug or a rogue middleware),
        // we drop it silently instead of throwing.
        data: { startDate: '2026-01-01', endDate: '2026-01-28', agentTypes: ['Chatbots', 42, 'Research'] },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_agent_types: ['Chatbots', 'Research'],
      });
    });

    it('skips empty tokens (e.g. trailing or repeated commas) without dropping the rest', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: {
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          // Repeated comma + whitespace-only token must not collapse the
          // inclusion list to null; this exercises the empty-key branch
          // in parseAgentTypes alongside two valid values.
          agentTypes: 'Chatbots,, ,Research,',
        },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_agent_types: ['Chatbots', 'Research'],
      });
    });

    it('omits p_agent_types entirely when the parameter is missing', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      // The key must be absent (not null) so PostgREST falls back to the RPC's
      // own DEFAULT NULL — same back-compat contract every other consumer relies on.
      const call = client.rpc.getCall(0);
      expect(call).to.not.be.null;
      expect(call.args[1]).to.not.have.property('p_agent_types');
    });

    it('accepts the snake_case alias agent_types and trims whitespace', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: {
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          agent_types: ' Chatbots , Training bots ',
        },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_kpis_trend', {
        p_agent_types: ['Chatbots', 'Training bots'],
      });
    });

    it('collapses an all-unknown list to omitted (null behaviour)', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis_trend: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', agentTypes: 'foo,bar' },
      });
      const handler = createAgenticTrafficKpisTrendHandler(stubbedValidateAccess);
      await handler(ctx);
      const call = client.rpc.getCall(0);
      expect(call).to.not.be.null;
      expect(call.args[1]).to.not.have.property('p_agent_types');
    });

    it('forwards p_agent_types to by-url alongside paging/sort params', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_url: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: {
          startDate: '2026-01-01',
          endDate: '2026-01-28',
          agentTypes: 'Chatbots,Research',
          pageSize: 25,
          sortBy: 'success_rate',
          sortOrder: 'asc',
        },
      });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_by_url', {
        p_agent_types: ['Chatbots', 'Research'],
        p_page_limit: 25,
        p_sort_by: 'success_rate',
        p_sort_order: 'asc',
      });
    });

    it('does not leak p_agent_types into RPCs that do not accept it', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_kpis: { data: [], error: null },
      });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', agentTypes: 'Chatbots,Research' },
      });
      const handler = createAgenticTrafficKpisHandler(stubbedValidateAccess);
      await handler(ctx);
      const call = client.rpc.getCall(0);
      expect(call).to.not.be.null;
      // kpis (non-trend) hasn't been extended yet so the key must still be absent.
      expect(call.args[1]).to.not.have.property('p_agent_types');
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
            page_type: 'article',
            agent_type: 'Chatbots',
            unique_agents: 5,
            unique_agent_names: ['ChatGPT-User', 'GPTBot'],
            total_hits: 200,
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
      expect(body[0].uniqueAgentNames).to.deep.equal(['ChatGPT-User', 'GPTBot']);
    });

    it('handles null row fields with safe defaults', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: {
          data: [{
            page_type: null,
            agent_type: null,
            unique_agents: null,
            unique_agent_names: null,
            total_hits: null,
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
      expect(body[0].uniqueAgentNames).to.deep.equal([]);
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

    it('falls back to total_hits for an invalid sortBy value', async () => {
      const client = createMockClient({
        rpc_agentic_traffic_by_user_agent: { data: [], error: null },
      });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', sortBy: 'DROP TABLE' } });
      const handler = createAgenticTrafficByUserAgentHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_sort_by).to.equal('total_hits');
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
            unique_agent_names: ['ChatGPT-User', 'GPTBot'],
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
      expect(body.rows[0].uniqueAgentNames).to.deep.equal(['ChatGPT-User', 'GPTBot']);
      expect(body.rows[0].topAgent).to.equal('ChatGPT-User');
      expect(body.rows[0].topAgentType).to.equal('Chatbots');
      expect(body.rows[0].responseCodes).to.deep.equal([200, 301]);
      expect(body.rows[0].deployedAtEdge).to.equal(true);
    });

    it('maps hits_trend points to camelCase and coerces missing values to 0', async () => {
      // Covers the truthy branch of `Array.isArray(row.hits_trend)`: the
      // RPC returns a [{week_start, value}] series and the controller
      // forwards it to the UI as [{weekStart, value}] so the URL Inspector
      // PG dashboard can derive its sparkline + WoW + dialog chart from
      // the same per-URL series.
      const client = createMockClient({
        rpc_agentic_traffic_by_url: {
          data: [{
            host: 'example.com',
            url_path: '/page',
            total_count: 1,
            total_hits: 42,
            hits_trend: [
              { week_start: '2026-01-05', value: 30 },
              { week_start: '2026-01-12', value: null },
              { week_start: '2026-01-19', value: 12 },
            ],
          }],
          error: null,
        },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(body.rows[0].hitsTrend).to.deep.equal([
        { weekStart: '2026-01-05', value: 30 },
        { weekStart: '2026-01-12', value: 0 },
        { weekStart: '2026-01-19', value: 12 },
      ]);
    });

    it('caps limit at 500 via legacy "limit" param', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', limit: 99999 } });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      const rpcCallArgs = client.rpc.firstCall.args[1];
      expect(rpcCallArgs.p_page_limit).to.equal(500);
    });

    it('accepts "pageSize" as the documented parameter name', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', pageSize: 25 } });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_page_limit).to.equal(25);
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

    it('falls back to total_hits for an invalid sortBy value', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({ client, data: { startDate: '2026-01-01', endDate: '2026-01-28', sortBy: 'DROP TABLE' } });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc.firstCall.args[1].p_sort_by).to.equal('total_hits');
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

    it('forwards successRate filter as p_success_rate to the RPC', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', successRate: 'low' },
      });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_by_url', {
        p_success_rate: 'low',
      });
    });

    it('accepts snake_case success_rate alias', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', success_rate: 'medium' },
      });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_by_url', {
        p_success_rate: 'medium',
      });
    });

    it('normalizes unknown successRate values to null instead of forwarding to the RPC', async () => {
      const client = createMockClient({ rpc_agentic_traffic_by_url: { data: [], error: null } });
      const ctx = makeContext({
        client,
        data: { startDate: '2026-01-01', endDate: '2026-01-28', successRate: 'invalid-bucket' },
      });
      const handler = createAgenticTrafficByUrlHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.rpc).to.have.been.calledWithMatch('rpc_agentic_traffic_by_url', {
        p_success_rate: null,
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
            unique_agent_names: null,
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
      expect(body.rows[0].uniqueAgentNames).to.deep.equal([]);
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

  // ── JCS hash invariants ────────────────────────────────────────────────────

  describe('jcsStringify', () => {
    it('canonicalises primitives + objects with sorted keys', () => {
      expect(jcsStringify(null)).to.equal('null');
      expect(jcsStringify('a')).to.equal('"a"');
      expect(jcsStringify(true)).to.equal('true');
      expect(jcsStringify(0)).to.equal('0');
      expect(jcsStringify([1, 'a', null])).to.equal('[1,"a",null]');
      expect(jcsStringify({ b: 2, a: 1 })).to.equal('{"a":1,"b":2}');
    });

    it('throws on non-finite numbers per JCS', () => {
      expect(() => jcsStringify(NaN)).to.throw(TypeError);
      expect(() => jcsStringify(Infinity)).to.throw(TypeError);
    });

    it('locks the hash for a known canonical payload (worker must produce the same)', async () => {
      // Cross-service contract: spacecat-reporting-worker must hash the same
      // input to the same exportId. If this golden value changes, the worker
      // PR needs to match — coordinate before merging.
      const crypto = await import('node:crypto');
      const payload = {
        kind: 'agentic-traffic-urls',
        v: 1,
        c: 1,
        format: 'csv',
        siteId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        platform: null,
        categoryName: null,
        agentType: null,
        userAgent: null,
        contentType: null,
        successRate: null,
        urlPathSearch: null,
      };
      const hash = crypto.createHash('sha256').update(jcsStringify(payload)).digest('hex');
      expect(hash).to.equal('6e6f6d808e6760960dc7540c3b28d991375852b56981bc66fca91e708b812101');
    });
  });

  // ── URL Export ─────────────────────────────────────────────────────────────

  describe('createAgenticTrafficUrlsExportHandler', () => {
    it('returns a cached download URL when the CSV already exists (legacy: no files[])', async () => {
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = stubS3({
        echoPrefix: true,
        metadata: { status: 'success', rowCount: 2 },
      });

      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.status).to.equal('ready');
      // ListObjectsV2 is the fallback when metadata.files is missing — verify
      // the prefix it asked for matches the deterministic key shape.
      const listCmd = ctx.s3.s3Client.send.getCalls()
        .map((c) => c.args[0])
        .find((cmd) => cmd instanceof ListObjectsV2Command);
      expect(listCmd.input.Prefix).to.match(
        new RegExp(`^agentic-traffic/url-exports/${SITE_ID}/v1c1/[a-f0-9]{64}/urls\\.csv$`),
      );
      expect(body.downloadUrls).to.deep.equal(['https://signed.example.com/export.csv']);
      expect(ctx.sqs.sendMessage).to.not.have.been.called;
    });

    it('skips ListObjectsV2 when metadata.files is present (fast path)', async () => {
      const ctx = makeExportContext();
      // Echo the metadata's key prefix back as files[] so the fast-path
      // prefix-validation accepts the entries (mirrors what the worker writes).
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.reject(new Error('should not be called'));
        }
        const prefix = command.input.Key.replace(/\/metadata\.json$/, '');
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              rowCount: 42,
              files: [`${prefix}/urls.csv`],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.status).to.equal('ready');
      expect(body.downloadUrls).to.have.length(1);
      const [, cmd] = ctx.s3.getSignedUrl.firstCall.args;
      expect(cmd.input.ResponseContentDisposition).to.equal('attachment; filename="urls.csv"');
      expect(cmd.input.ResponseContentType).to.equal('text/csv; charset=utf-8');
      const listCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof ListObjectsV2Command);
      expect(listCalls).to.have.length(0);
    });

    it('sorts metadata.files by part number in fast path (out-of-order worker writes)', async () => {
      const ctx = makeExportContext();
      ctx.s3.getSignedUrl = sinon.stub()
        .onFirstCall()
        .resolves('https://signed.example.com/part1')
        .onSecondCall()
        .resolves('https://signed.example.com/part2');
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.reject(new Error('should not be called'));
        }
        const prefix = command.input.Key.replace(/\/metadata\.json$/, '');
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              rowCount: 20,
              // Worker wrote part2 before part1 — fast path must sort before signing.
              files: [`${prefix}/urls.csv_part2`, `${prefix}/urls.csv_part1`],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.status).to.equal('ready');
      const calls = ctx.s3.getSignedUrl.getCalls();
      // After sorting, part1 key must be signed first.
      expect(calls[0].args[1].input).to.include({ ResponseContentDisposition: 'attachment; filename="urls_part1.csv"' });
      expect(calls[1].args[1].input).to.include({ ResponseContentDisposition: 'attachment; filename="urls_part2.csv"' });
    });

    it('falls back to ListObjectsV2 when metadata.files contains out-of-prefix keys', async () => {
      // Defense in depth: worker bug / compromise writes wrong keys in files[];
      // producer must not sign URLs against them — falls back to ListObjectsV2
      // which constrains by prefix.
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [{ Key: command.input.Prefix }] });
        }
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              rowCount: 1,
              files: ['agentic-traffic/url-exports/EVIL_SITE/v1c1/EVIL_EXPORT/urls.csv'],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const listCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof ListObjectsV2Command);
      expect(listCalls).to.have.length(1);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/out-of-prefix/);
    });

    it('falls back to ListObjectsV2 when metadata.files contains in-prefix non-CSV keys', async () => {
      // Worker bug: an in-prefix path that isn't a CSV (e.g. metadata.json
      // itself) would otherwise get signed. Reject any entry whose filename
      // doesn't match urls.csv or urls.csv_partN.
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [{ Key: command.input.Prefix }] });
        }
        const prefix = command.input.Key.replace(/\/metadata\.json$/, '');
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              rowCount: 1,
              // In-prefix but not a CSV — must be rejected.
              files: [`${prefix}/metadata.json`],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const listCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof ListObjectsV2Command);
      expect(listCalls).to.have.length(1);
      expect(ctx.log.warn).to.have.been.calledWithMatch(/out-of-prefix/);
    });

    it('signs with the regular S3 client (not accelerated) when AWS_ENDPOINT_URL_S3 is set (IT/MinIO)', async () => {
      const ctx = makeExportContext({
        context: { env: { AWS_ENDPOINT_URL_S3: 'http://localhost:4566' } },
      });
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        const prefix = command.input.Key.replace(/\/metadata\.json$/, '');
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              rowCount: 1,
              files: [`${prefix}/urls.csv`],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      await handler(ctx);
      // Regular client used, not accelerated.
      expect(ctx.s3.getSignedUrl.firstCall.args[0]).to.equal(ctx.s3.s3Client);
    });

    it('produces the same exportId for the same filter set across calls', async () => {
      // The cache contract rests on stableStringify being key-order invariant.
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const ctxA = makeExportContext({ data: { platform: 'chatgpt', urlPathSearch: 'pricing' } });
      const ctxB = makeExportContext({ data: { urlPathSearch: 'pricing', platform: 'chatgpt' } });
      const idA = (await (await handler(ctxA)).json()).exportId;
      const idB = (await (await handler(ctxB)).json()).exportId;
      expect(idA).to.equal(idB);
    });

    it('re-enqueues when prior `processing` metadata is stale (worker abandoned)', async () => {
      const ctx = makeExportContext();
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      ctx.s3.s3Client.send = stubS3({
        metadata: { status: 'processing', createdAt: oldDate },
      });

      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(202);
      expect(ctx.sqs.sendMessage).to.have.been.calledOnce;
    });

    it('drops non-string filter values instead of forwarding them', async () => {
      const ctx = makeExportContext({
        data: { urlPathSearch: { $ne: null }, userAgent: ['a', 'b'] },
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      await handler(ctx);
      const { filters } = ctx.sqs.sendMessage.firstCall.args[1].data;
      expect(filters.urlPathSearch).to.equal(null);
      expect(filters.userAgent).to.equal(null);
    });

    it('queues an export job with mapped filters when no cached CSV exists', async () => {
      // Also covers UI→DB platform code mapping (chatgpt → ChatGPT) in the payload.
      const ctx = makeExportContext({ data: { platform: 'chatgpt' } });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(202);
      expect(body.status).to.equal('processing');
      expect(body.exportId).to.match(/^[a-f0-9]{64}$/);
      expect(ctx.sqs.sendMessage).to.have.been.calledOnce;
      const [queueUrl, message] = ctx.sqs.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('https://sqs.example.com/report-jobs');
      expect(message.type).to.equal('agentic-traffic-urls-export');
      expect(message.data.filters.platform).to.equal('ChatGPT');
      expect(message.data.s3Key).to.include(`/v1c1/${body.exportId}/urls.csv`);
      expect(message.data.requestedBy).to.equal('user@example.com');
    });

    it('does not queue another job while an export is already processing', async () => {
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = stubS3({ metadata: { status: 'processing' } });

      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(202);
      expect(body.status).to.equal('processing');
      expect(ctx.sqs.sendMessage).to.not.have.been.called;
    });

    it('re-enqueues when a prior attempt failed (failed metadata is retriable)', async () => {
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = stubS3({
        metadata: { status: 'failed', failureReason: 'db error' },
      });

      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(202);
      expect(body.status).to.equal('processing');
      expect(ctx.sqs.sendMessage).to.have.been.calledOnce;
    });

    it('does not enqueue when CAS write loses the race', async () => {
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        if (command instanceof PutObjectCommand) {
          const error = new Error('precondition failed');
          error.name = 'PreconditionFailed';
          return Promise.reject(error);
        }
        const error = new Error('not found');
        error.name = 'NoSuchKey';
        return Promise.reject(error);
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(202);
      expect(ctx.sqs.sendMessage).to.not.have.been.called;
    });

    it('writes processing metadata with IfNoneMatch:* before enqueueing on first POST', async () => {
      const ctx = makeExportContext();
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      await handler(ctx);
      const putCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof PutObjectCommand);
      expect(putCalls).to.have.length(1);
      expect(putCalls[0].args[0].input.IfNoneMatch).to.equal('*');
      const written = JSON.parse(putCalls[0].args[0].input.Body);
      expect(written.status).to.equal('processing');
      expect(written.kind).to.equal('agentic-traffic-urls');
      expect(written.createdAt).to.be.a('string');
      // PUT must happen before SQS sendMessage — locks the claim-before-enqueue order.
      const putOrder = ctx.s3.s3Client.send.firstCall.calledBefore(ctx.sqs.sendMessage.firstCall);
      expect(putOrder).to.equal(true);
    });

    it('rolls back processing metadata when SQS sendMessage fails', async () => {
      // Without rollback a transient SQS failure would block the cache key
      // for the full stale-processing window — 30 min outage on a blip.
      const ctx = makeExportContext({
        sqs: { sendMessage: sinon.stub().rejects(new Error('sqs unavailable')) },
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
      const deleteCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof DeleteObjectCommand);
      expect(deleteCalls).to.have.length(1);
    });

    it('uses CAS (IfNoneMatch:*) when retrying against success metadata so success records are not clobbered', async () => {
      // If CSV was evicted but success metadata remained, an unconditional
      // overwrite would destroy the success record. CAS lets us fall through
      // to 202 processing without touching state.
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        if (command instanceof PutObjectCommand) {
          // CAS should fail because the object exists.
          if (command.input.IfNoneMatch === '*') {
            const error = new Error('precondition failed');
            error.$metadata = { httpStatusCode: 412 };
            return Promise.reject(error);
          }
          return Promise.resolve({});
        }
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success', rowCount: 5,
              // No files[] — exercises the legacy success-without-files path.
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(202);
      const putCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof PutObjectCommand);
      expect(putCalls).to.have.length(1);
      expect(putCalls[0].args[0].input.IfNoneMatch).to.equal('*');
      expect(ctx.sqs.sendMessage).to.not.have.been.called;
    });

    it('uses unconditional overwrite when retrying against stale processing metadata', async () => {
      const ctx = makeExportContext();
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        if (command instanceof PutObjectCommand) {
          return Promise.resolve({});
        }
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'processing', createdAt: oldDate,
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(202);
      const putCall = ctx.s3.s3Client.send.getCalls()
        .find((c) => c.args[0] instanceof PutObjectCommand);
      expect(putCall.args[0].input.IfNoneMatch).to.equal(undefined);
      expect(ctx.sqs.sendMessage).to.have.been.calledOnce;
    });

    it('treats corrupt metadata.json as absent (heals via re-enqueue rather than 500-looping)', async () => {
      const ctx = makeExportContext();
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        if (command instanceof PutObjectCommand) {
          return Promise.resolve({});
        }
        return Promise.resolve({
          Body: { transformToString: () => Promise.resolve('{not-json') },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(202);
      expect(ctx.sqs.sendMessage).to.have.been.calledOnce;
    });

    it('signs customer presigned URLs against the s3-accelerate endpoint, not the regional client', async () => {
      const ctx = makeExportContext();
      // The metadata-fetch stub also serves as the success path. Echo the
      // metadata's prefix into files[] so the fast path accepts it.
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }
        const prefix = command.input.Key.replace(/\/metadata\.json$/, '');
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success', rowCount: 1, files: [`${prefix}/urls.csv`],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportHandler(stubbedValidateAccess);
      await handler(ctx);
      // The first arg to getSignedUrl must NOT be the regional ctx.s3.s3Client
      // — it should be the accelerated client constructed inside the handler.
      const signingClient = ctx.s3.getSignedUrl.firstCall.args[0];
      expect(signingClient).to.not.equal(ctx.s3.s3Client);
      // The accelerated client carries the useAccelerateEndpoint flag (boolean or provider).
      expect(signingClient.config?.useAccelerateEndpoint).to.not.equal(undefined);
    });
  });

  describe('createAgenticTrafficUrlsExportStatusHandler', () => {
    it('returns 200 processing when fresh processing metadata exists', async () => {
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      ctx.s3.s3Client.send = stubS3({
        metadata: { status: 'processing', createdAt: new Date().toISOString() },
      });
      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body).to.deep.equal({ exportId: EXPORT_ID, status: 'processing' });
    });

    it('GET skips ListObjectsV2 when metadata.files is present', async () => {
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.reject(new Error('should not be called'));
        }
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              rowCount: 7,
              files: [`agentic-traffic/url-exports/${SITE_ID}/v1c1/${EXPORT_ID}/urls.csv`],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.status).to.equal('ready');
      expect(body.downloadUrls).to.have.length(1);
    });

    it('GET falls back to ListObjectsV2 when metadata.files contains out-of-prefix keys', async () => {
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      ctx.s3.s3Client.send = sinon.stub().callsFake((command) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: [{ Key: `agentic-traffic/url-exports/${SITE_ID}/v1c1/${EXPORT_ID}/urls.csv` }],
          });
        }
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({
              status: 'success',
              files: ['agentic-traffic/url-exports/EVIL/v1c1/EVIL/urls.csv'],
            })),
          },
        });
      });
      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const listCalls = ctx.s3.s3Client.send.getCalls()
        .filter((c) => c.args[0] instanceof ListObjectsV2Command);
      expect(listCalls).to.have.length(1);
    });

    it('returns 404 when no CSV or metadata exists (unknown exportId)', async () => {
      // POST writes processing metadata atomically before enqueueing, so an
      // unknown exportId on GET means it was never POSTed (typo, forged) or
      // metadata has been evicted — terminal, not "still processing".
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns ready with presigned URLs for split CSV parts', async () => {
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      ctx.s3.s3Client.send = stubS3({
        keys: [
          `agentic-traffic/url-exports/${SITE_ID}/v1c1/${EXPORT_ID}/urls.csv_part2`,
          `agentic-traffic/url-exports/${SITE_ID}/v1c1/${EXPORT_ID}/urls.csv`,
        ],
        metadata: {
          status: 'success', rowCount: 10, filesUploaded: 2, bytesUploaded: 1000,
        },
      });
      ctx.s3.getSignedUrl = sinon.stub()
        .onFirstCall()
        .resolves('https://signed.example.com/part1')
        .onSecondCall()
        .resolves('https://signed.example.com/part2');

      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.status).to.equal('ready');
      expect(body.downloadUrls).to.deep.equal([
        'https://signed.example.com/part1',
        'https://signed.example.com/part2',
      ]);
      expect(body.rowCount).to.equal(10);
      expect(body.filesUploaded).to.equal(2);
      expect(body.bytesUploaded).to.equal(1000);
      const getSignedUrlCalls = ctx.s3.getSignedUrl.getCalls();
      expect(getSignedUrlCalls[0].args[1].input).to.include({
        ResponseContentDisposition: 'attachment; filename="urls_part1.csv"',
        ResponseContentType: 'text/csv; charset=utf-8',
      });
      expect(getSignedUrlCalls[1].args[1].input).to.include({
        ResponseContentDisposition: 'attachment; filename="urls_part2.csv"',
        ResponseContentType: 'text/csv; charset=utf-8',
      });
    });

    it('returns failed (ADR enum + message) when metadata reports a failed export', async () => {
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      ctx.s3.s3Client.send = stubS3({
        metadata: {
          status: 'failed',
          failureReason: 'db_error',
          failureMessage: 'connection lost',
        },
      });

      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body).to.deep.equal({
        exportId: EXPORT_ID,
        status: 'failed',
        failureReason: 'db_error',
        failureMessage: 'connection lost',
      });
    });

    it('surfaces stale `processing` metadata as failed/timeout so the UI can retry', async () => {
      const ctx = makeExportContext({ params: { exportId: EXPORT_ID } });
      const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      ctx.s3.s3Client.send = stubS3({
        metadata: { status: 'processing', createdAt: oldDate },
      });

      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      const body = await res.json();
      expect(res.status).to.equal(200);
      expect(body.status).to.equal('failed');
      expect(body.failureReason).to.equal('timeout');
      expect(body.failureMessage).to.match(/timed out/i);
    });

    it('rejects invalid export ids', async () => {
      const ctx = makeExportContext({ params: { exportId: 'not-a-hash' } });
      const handler = createAgenticTrafficUrlsExportStatusHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(400);
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

  // ── Has Data ───────────────────────────────────────────────────────────────

  describe('createAgenticTrafficHasDataHandler', () => {
    it('returns hasData: true when agentic_traffic has rows for the site', async () => {
      const client = createMockClient({}, {
        agentic_traffic: { data: [{ traffic_date: '2026-01-05' }], error: null },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficHasDataHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(true);
    });

    it('returns hasData: false when no rows exist for the site', async () => {
      const client = createMockClient({}, {
        agentic_traffic: { data: [], error: null },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficHasDataHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.hasData).to.equal(false);
    });

    it('returns 500 when the PostgREST query errors', async () => {
      const client = createMockClient({}, {
        agentic_traffic: { data: null, error: { message: 'db error' } },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficHasDataHandler(stubbedValidateAccess);
      const res = await handler(ctx);
      expect(res.status).to.equal(500);
    });

    it('queries the agentic_traffic table with the site id and a limit of 1', async () => {
      const client = createMockClient({}, {
        agentic_traffic: { data: [], error: null },
      });
      const ctx = makeContext({ client });
      const handler = createAgenticTrafficHasDataHandler(stubbedValidateAccess);
      await handler(ctx);
      expect(client.from).to.have.been.calledWith('agentic_traffic');
      const chain = client.from.firstCall.returnValue;
      expect(chain.eq).to.have.been.calledWith('site_id', SITE_ID);
      expect(chain.limit).to.have.been.calledWith(1);
    });
  });
});
