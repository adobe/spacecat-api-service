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

/* eslint-disable max-len, no-await-in-loop -- AI Visibility controller tests */

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

const ALL_METHOD_NAMES = [
  'getBrandsStats',
  'getBrandsTopics',
  'getBrandsPrompts',
  'getBrandsCitedPages',
  'getBrandsTopicOpportunities',
  'getBrandsTopBrands',
  'getBrandsCitedSources',
  'getBrandsSourceOpportunities',
  'getBrandsCompetitors',
  'getCompetitorsMetrics',
  'getCompetitorsGapTopics',
  'getCompetitorsGapSourceDomains',
  'getCompetitorsGapPrompts',
  'getMeta',
  'getPromptsResponsesLatest',
  'getPromptsResponses',
  'getTopicsResearchStats',
  'getTopicsResearchPrompts',
  'getTopicsResearchBrands',
  'getTopicsResearchSourceDomains',
  'getTopicsResearch',
  'getTopicsStats',
  'getV1TopicBrandTopics',
  'getV1TopicBrandTopicsTotals',
  'getV1TopicGapTopics',
  'getV1TopicGapTopicsTotals',
  'getV1PromptBrandPrompts',
  'getV1PromptGapPrompts',
  'getV1PromptPromptResponse',
];

describe('AiVisibilityController', () => {
  let sandbox;
  let AiVisibilityController;
  let mockGetGrpcClients;
  let mockNormalize;
  let mockAttachFilters;
  let mockOk;
  let mockCreateResponse;
  let mockInternalServerError;
  let mockHandleBrandStats;
  let mockHandleBrandTopics;
  let mockHandleBrandPrompts;
  let mockHandleBrandCitedPages;
  let mockHandleBrandTopicOpportunities;
  let mockHandleBrandTopBrands;
  let mockHandleBrandCitedSources;
  let mockHandleBrandSourceOpportunities;
  let mockHandleBrandCompetitors;
  let mockHandleCompetitorsMetrics;
  let mockHandleCompetitorsGapTopics;
  let mockHandleCompetitorsGapSourceDomains;
  let mockHandleCompetitorsGapPrompts;
  let mockHandleMeta;
  let mockHandlePromptsResponses;
  let mockHandlePromptsResponsesLatest;
  let mockHandleTopicsResearchStats;
  let mockHandleTopicsResearch;
  let mockHandleTopicsStats;
  let mockHandleTopicsResearchPrompts;
  let mockHandleTopicsResearchBrands;
  let mockHandleTopicsResearchSourceDomains;
  let mockHandleV1TopicBrandTopics;
  let mockHandleV1TopicBrandTopicsTotals;
  let mockHandleV1TopicGapTopics;
  let mockHandleV1TopicGapTopicsTotals;
  let mockHandleV1PromptBrandPrompts;
  let mockHandleV1PromptGapPrompts;
  let mockHandleV1PromptPromptResponse;

  const log = {
    info: sinon.stub(),
    error: sinon.stub(),
    warn: sinon.stub(),
    debug: sinon.stub(),
  };

  const env = { SEO_CLIENT_ID: 'id', SEO_CLIENT_SECRET: 'secret' };
  const fakeClients = { brandClient: {}, topicClient: {} };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    mockGetGrpcClients = sandbox.stub().returns(fakeClients);
    mockNormalize = sandbox.stub().callsFake((_, body) => body);
    mockAttachFilters = sandbox.stub().callsFake((_, body) => body);
    mockOk = sandbox.stub().callsFake((body) => ({ status: 200, body }));
    mockCreateResponse = sandbox
      .stub()
      .callsFake((body, status) => ({ status, body }));
    mockInternalServerError = sandbox
      .stub()
      .callsFake((msg) => ({ status: 500, body: { error: msg } }));

    mockHandleBrandStats = sandbox
      .stub()
      .resolves({ status: 200, body: { ok: true } });
    mockHandleBrandTopics = sandbox.stub().resolves({ status: 200, body: {} });
    mockHandleBrandPrompts = sandbox.stub().resolves({ status: 200, body: {} });
    mockHandleBrandCitedPages = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleBrandTopicOpportunities = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleBrandTopBrands = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleBrandCitedSources = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleBrandSourceOpportunities = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleBrandCompetitors = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleCompetitorsMetrics = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleCompetitorsGapTopics = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleCompetitorsGapSourceDomains = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleCompetitorsGapPrompts = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleMeta = sandbox.stub().resolves({ status: 200, body: {} });
    mockHandlePromptsResponses = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandlePromptsResponsesLatest = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleTopicsResearchStats = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleTopicsResearch = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleTopicsStats = sandbox.stub().resolves({ status: 200, body: {} });
    mockHandleTopicsResearchPrompts = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleTopicsResearchBrands = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleTopicsResearchSourceDomains = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1TopicBrandTopics = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1TopicBrandTopicsTotals = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1TopicGapTopics = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1TopicGapTopicsTotals = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1PromptBrandPrompts = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1PromptGapPrompts = sandbox
      .stub()
      .resolves({ status: 200, body: {} });
    mockHandleV1PromptPromptResponse = sandbox
      .stub()
      .resolves({ status: 200, body: {} });

    const mod = await esmock('../../src/controllers/ai-visibility.js', {
      '../../src/support/ai-visibility/grpc-transport.js': {
        getGrpcClients: mockGetGrpcClients,
      },
      '../../src/support/ai-visibility/visibility-normalize.js': {
        normalizeVisibilityV1SuccessfulBody: mockNormalize,
      },
      '../../src/support/ai-visibility/visibility-filters.js': {
        attachSrFiltersToSuccessfulBody: mockAttachFilters,
      },
      '../../src/support/ai-visibility/handlers/brands.js': {
        handleBrandStats: mockHandleBrandStats,
        handleBrandTopics: mockHandleBrandTopics,
        handleBrandPrompts: mockHandleBrandPrompts,
        handleBrandCitedPages: mockHandleBrandCitedPages,
        handleBrandTopicOpportunities: mockHandleBrandTopicOpportunities,
        handleBrandTopBrands: mockHandleBrandTopBrands,
        handleBrandCitedSources: mockHandleBrandCitedSources,
        handleBrandSourceOpportunities: mockHandleBrandSourceOpportunities,
        handleBrandCompetitors: mockHandleBrandCompetitors,
      },
      '../../src/support/ai-visibility/handlers/competitors.js': {
        handleCompetitorsMetrics: mockHandleCompetitorsMetrics,
        handleCompetitorsGapTopics: mockHandleCompetitorsGapTopics,
        handleCompetitorsGapSourceDomains:
          mockHandleCompetitorsGapSourceDomains,
        handleCompetitorsGapPrompts: mockHandleCompetitorsGapPrompts,
      },
      '../../src/support/ai-visibility/handlers/prompts.js': {
        handlePromptsResponses: mockHandlePromptsResponses,
        handlePromptsResponsesLatest: mockHandlePromptsResponsesLatest,
      },
      '../../src/support/ai-visibility/handlers/topics.js': {
        handleTopicsResearchStats: mockHandleTopicsResearchStats,
        handleTopicsResearch: mockHandleTopicsResearch,
        handleTopicsStats: mockHandleTopicsStats,
        handleTopicsResearchPrompts: mockHandleTopicsResearchPrompts,
        handleTopicsResearchBrands: mockHandleTopicsResearchBrands,
        handleTopicsResearchSourceDomains:
          mockHandleTopicsResearchSourceDomains,
      },
      '../../src/support/ai-visibility/handlers/meta.js': {
        handleMeta: mockHandleMeta,
      },
      '../../src/support/ai-visibility/handlers/v1/topic/brand-topics.js': {
        handleBrandTopics: mockHandleV1TopicBrandTopics,
        buildBrandTopicsDimensionFilterQl: sandbox.stub().returns(''),
        buildBrandTopicsMetricFilterQl: sandbox.stub().returns({ ok: true, metricFilterQl: '' }),
      },
      '../../src/support/ai-visibility/handlers/v1/topic/brand-topics-totals.js': {
        handleBrandTopicsTotals: mockHandleV1TopicBrandTopicsTotals,
      },
      '../../src/support/ai-visibility/handlers/v1/topic/gap-topics.js': {
        handleGapTopics: mockHandleV1TopicGapTopics,
        buildGapTopicsDimensionFilterQl: sandbox.stub().returns(''),
        buildGapTopicsMetricFilterQl: sandbox.stub().returns({ ok: true, metricFilterQl: '' }),
      },
      '../../src/support/ai-visibility/handlers/v1/topic/gap-topics-totals.js': {
        handleGapTopicsTotals: mockHandleV1TopicGapTopicsTotals,
      },
      '../../src/support/ai-visibility/handlers/v1/prompt/brand-prompts.js': {
        handleBrandPrompts: mockHandleV1PromptBrandPrompts,
      },
      '../../src/support/ai-visibility/handlers/v1/prompt/gap-prompts.js': {
        handleGapPrompts: mockHandleV1PromptGapPrompts,
      },
      '../../src/support/ai-visibility/handlers/v1/prompt/prompt-response.js': {
        handlePromptResponse: mockHandleV1PromptPromptResponse,
      },
      '../../third-party/ai-seo-ts/v2/brand/service_pb.js': {
        BrandService: {},
      },
      '../../third-party/ai-seo-ts/v2/topic/service_pb.js': {
        TopicService: {},
      },
      '../../third-party/ai-seo-ts/v2/prompt/service_pb.js': {
        PromptService: {},
      },
      '../../third-party/ai-seo-ts/v2/source/service_pb.js': {
        SourceService: {},
      },
      '../../third-party/ai-seo-ts/v2/competitor/service_pb.js': {
        CompetitorService: {},
      },
      '../../third-party/ai-seo-ts/ai-cr/service_pb.js': {
        CompetitorsMetrics: {},
        Meta: {},
      },
      '../../third-party/ai-seo-ts/ai-vo/service_pb.js': { Sources: {} },
      '../../third-party/ai-seo-ts/ai-pr/service_pb.js': { Relations: {} },
      '@adobe/spacecat-shared-http-utils': {
        ok: mockOk,
        badRequest: sandbox.stub(),
        internalServerError: mockInternalServerError,
        createResponse: mockCreateResponse,
      },
      '@adobe/spacecat-shared-utils': {
        isNonEmptyObject: (o) => o != null && typeof o === 'object' && Object.keys(o).length > 0,
      },
    });
    AiVisibilityController = mod.default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor validation', () => {
    it('throws when context is null', () => {
      expect(() => AiVisibilityController(null, log, env)).to.throw(
        'Context required',
      );
    });

    it('throws when context is undefined', () => {
      expect(() => AiVisibilityController(undefined, log, env)).to.throw(
        'Context required',
      );
    });

    it('throws when context is an empty object', () => {
      expect(() => AiVisibilityController({}, log, env)).to.throw(
        'Context required',
      );
    });

    it('throws when log is null', () => {
      expect(() => AiVisibilityController({ some: 'data' }, null, env)).to.throw('Log required');
    });

    it('throws when log is undefined', () => {
      expect(() => AiVisibilityController({ some: 'data' }, undefined, env)).to.throw('Log required');
    });
  });

  describe('returned handler object', () => {
    it('returns an object with all 29 method names', () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      expect(Object.keys(handlers)).to.have.lengthOf(29);
      for (const name of ALL_METHOD_NAMES) {
        expect(handlers).to.have.property(name).that.is.a('function');
      }
    });

    it('each returned method is a function', () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      for (const value of Object.values(handlers)) {
        expect(value).to.be.a('function');
      }
    });
  });

  describe('wrapHandler – successful call', () => {
    it('calls handler → normalize → attachFilters → ok', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const handlerBody = { data: [1, 2, 3] };
      mockHandleBrandStats.resolves({ status: 200, body: handlerBody });

      const normalizedBody = { data: [1, 2, 3], normalized: true };
      mockNormalize.returns(normalizedBody);

      const withFilters = { data: [1, 2, 3], normalized: true, sr_filters: {} };
      mockAttachFilters.returns(withFilters);

      const context = {
        env,
        request: { url: 'https://example.com/brands/stats?domain=test.com' },
      };
      const result = await handlers.getBrandsStats(context);

      expect(mockGetGrpcClients.calledOnce).to.be.true;
      expect(mockGetGrpcClients.calledWith(env)).to.be.true;

      expect(mockHandleBrandStats.calledOnce).to.be.true;
      const [sp, clients] = mockHandleBrandStats.firstCall.args;
      expect(sp).to.be.instanceOf(URLSearchParams);
      expect(sp.get('domain')).to.equal('test.com');
      expect(clients).to.equal(fakeClients);

      expect(mockNormalize.calledOnce).to.be.true;
      expect(mockNormalize.calledWith('/brands/stats', handlerBody)).to.be.true;

      expect(mockAttachFilters.calledOnce).to.be.true;
      expect(mockAttachFilters.calledWith(200, normalizedBody)).to.be.true;

      expect(mockOk.calledWith(withFilters)).to.be.true;
      expect(result.status).to.equal(200);
    });

    it('returns createResponse when handler returns non-200', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      mockHandleBrandStats.resolves({
        status: 400,
        body: { error: 'bad_request', message: 'no' },
      });
      const context = { env, data: {} };
      const result = await handlers.getBrandsStats(context);
      expect(mockCreateResponse.calledOnce).to.be.true;
      expect(mockCreateResponse.firstCall.args[1]).to.equal(400);
      expect(mockNormalize.called).to.be.false;
      expect(mockOk.called).to.be.false;
      expect(result.status).to.equal(400);
    });

    it('passes searchParams as third argument to attachFilters', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = {
        env,
        request: { url: 'https://example.com/meta?country=US' },
      };
      await handlers.getMeta(context);

      const attachCall = mockAttachFilters.firstCall;
      expect(attachCall.args[2]).to.be.instanceOf(URLSearchParams);
      expect(attachCall.args[2].get('country')).to.equal('US');
    });
  });

  describe('wrapHandler – gRPC init failure', () => {
    it('returns 503 when getGrpcClients throws', async () => {
      mockGetGrpcClients.throws(new Error('credentials missing'));
      const handlers = AiVisibilityController({ some: 'data' }, log, env);

      const context = { env, data: { domain: 'test.com' } };
      const result = await handlers.getBrandsStats(context);

      expect(mockCreateResponse.calledOnce).to.be.true;
      const [body, status] = mockCreateResponse.firstCall.args;
      expect(status).to.equal(503);
      expect(body).to.deep.equal({
        error: 'aiVisibilityNotConfigured',
        message: 'AI Visibility is not configured.',
      });

      expect(mockHandleBrandStats.called).to.be.false;
      expect(result.status).to.equal(503);
    });

    it('logs the gRPC init error', async () => {
      const err = new Error('transport failed');
      mockGetGrpcClients.throws(err);
      const handlers = AiVisibilityController({ some: 'data' }, log, env);

      const context = { env, data: {} };
      await handlers.getCompetitorsMetrics(context);

      expect(
        log.error.calledWith('AI Visibility gRPC transport init failed', err),
      ).to.be.true;
    });
  });

  describe('wrapHandler – handler error', () => {
    it('returns internalServerError when handler throws', async () => {
      mockHandleBrandTopics.rejects(new Error('upstream timeout'));
      const handlers = AiVisibilityController({ some: 'data' }, log, env);

      const context = { env, data: {} };
      const result = await handlers.getBrandsTopics(context);

      expect(mockInternalServerError.calledOnce).to.be.true;
      expect(mockInternalServerError.calledWith('AI Visibility request failed'))
        .to.be.true;
      expect(result.status).to.equal(500);
    });

    it('logs the handler error with relPath', async () => {
      const err = new Error('parse failure');
      mockHandleTopicsStats.rejects(err);
      const handlers = AiVisibilityController({ some: 'data' }, log, env);

      const context = { env, data: {} };
      await handlers.getTopicsStats(context);

      expect(
        log.error.calledWith(
          'AI Visibility handler error [/topics/stats]',
          err,
        ),
      ).to.be.true;
    });
  });

  describe('extractSearchParams', () => {
    it('extracts params from context.request.url', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = {
        env,
        request: { url: 'https://example.com/path?foo=bar&baz=42' },
      };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('foo')).to.equal('bar');
      expect(sp.get('baz')).to.equal('42');
    });

    it('falls back to context.data when request.url is absent', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = {
        env,
        data: { domain: 'example.com', limit: 10 },
      };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('domain')).to.equal('example.com');
      expect(sp.get('limit')).to.equal('10');
    });

    it('falls back to context.data when request is undefined', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = { env, data: { key: 'value' } };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('key')).to.equal('value');
    });

    it('handles array values in context.data', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = {
        env,
        data: { tags: ['a', 'b', 'c'] },
      };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.getAll('tags')).to.deep.equal(['a', 'b', 'c']);
    });

    it('skips null/undefined values in context.data', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = {
        env,
        data: { present: 'yes', absent: null, missing: undefined },
      };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('present')).to.equal('yes');
      expect(sp.has('absent')).to.be.false;
      expect(sp.has('missing')).to.be.false;
    });

    it('produces empty params when both request.url and data are absent', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = { env };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect([...sp.entries()]).to.have.lengthOf(0);
    });

    it('falls back to context.data on malformed request.url', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = {
        env,
        request: { url: 'not-a-valid-url' },
        data: { fallback: 'works' },
      };
      await handlers.getBrandsStats(context);

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('fallback')).to.equal('works');
    });
  });

  describe('all handler routes are wired', () => {
    const handlerMap = () => ({
      getBrandsStats: mockHandleBrandStats,
      getBrandsTopics: mockHandleBrandTopics,
      getBrandsPrompts: mockHandleBrandPrompts,
      getBrandsCitedPages: mockHandleBrandCitedPages,
      getBrandsTopicOpportunities: mockHandleBrandTopicOpportunities,
      getBrandsTopBrands: mockHandleBrandTopBrands,
      getBrandsCitedSources: mockHandleBrandCitedSources,
      getBrandsSourceOpportunities: mockHandleBrandSourceOpportunities,
      getBrandsCompetitors: mockHandleBrandCompetitors,
      getCompetitorsMetrics: mockHandleCompetitorsMetrics,
      getCompetitorsGapTopics: mockHandleCompetitorsGapTopics,
      getCompetitorsGapSourceDomains: mockHandleCompetitorsGapSourceDomains,
      getCompetitorsGapPrompts: mockHandleCompetitorsGapPrompts,
      getMeta: mockHandleMeta,
      getPromptsResponsesLatest: mockHandlePromptsResponsesLatest,
      getPromptsResponses: mockHandlePromptsResponses,
      getTopicsResearchStats: mockHandleTopicsResearchStats,
      getTopicsResearchPrompts: mockHandleTopicsResearchPrompts,
      getTopicsResearchBrands: mockHandleTopicsResearchBrands,
      getTopicsResearchSourceDomains: mockHandleTopicsResearchSourceDomains,
      getTopicsResearch: mockHandleTopicsResearch,
      getTopicsStats: mockHandleTopicsStats,
      getV1TopicBrandTopics: mockHandleV1TopicBrandTopics,
      getV1TopicGapTopics: mockHandleV1TopicGapTopics,
      getV1PromptBrandPrompts: mockHandleV1PromptBrandPrompts,
      getV1PromptGapPrompts: mockHandleV1PromptGapPrompts,
      getV1PromptPromptResponse: mockHandleV1PromptPromptResponse,
    });

    it('each method invokes its corresponding handler', async () => {
      const handlers = AiVisibilityController({ some: 'data' }, log, env);
      const context = { env, data: {} };
      const map = handlerMap();

      for (const [methodName, mockHandler] of Object.entries(map)) {
        mockHandler.resetHistory();
        await handlers[methodName](context);
        expect(mockHandler.calledOnce, `${methodName} should call its handler`)
          .to.be.true;
      }
    });
  });
});
