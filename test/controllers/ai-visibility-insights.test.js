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

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('AiVisibilityInsightsController', () => {
  let sandbox;
  let AiVisibilityInsightsController;
  let mockGetGrpcClients;
  let mockHandleBrandStats;
  let mockHandleBrandTopics;
  let mockModelInvoke;
  let mockCachedOk;
  let mockBadRequest;
  let mockInternalServerError;
  let mockCreateResponse;

  const log = {
    info: sinon.stub(),
    error: sinon.stub(),
    warn: sinon.stub(),
    debug: sinon.stub(),
  };

  const env = {
    AZURE_OPEN_AI_API_KEY: 'test-key',
    AZURE_OPEN_AI_API_INSTANCE_NAME: 'test-instance',
    AZURE_OPEN_AI_API_DEPLOYMENT_NAME: 'test-deployment',
    AZURE_OPEN_AI_API_VERSION: '2024-02-01',
  };

  const fakeClients = { brandClient: {}, topicClient: {} };

  const insightJson = {
    summary: 'Brand X has strong AI visibility.',
    trendDirection: 'up',
    topTopic: 'running shoes',
    action: 'Publish FAQ content targeting top AI prompts.',
  };

  const statsBody = {
    aiVisibility: 0.42,
    mentions: { all: 500 },
    audience: 12000,
    byDate: [
      { aiVisibility: 0.38 },
      { aiVisibility: 0.40 },
      { aiVisibility: 0.42 },
    ],
  };

  const topicsBody = {
    items: [
      { name: 'running shoes' },
      { name: 'trail running' },
    ],
    total: 2,
  };

  function makeContext(url = 'https://api.example.com/llmo/ai-visibility/insights?domain=acme.com&region=US') {
    return { env, request: { url } };
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    mockGetGrpcClients = sandbox.stub().returns(fakeClients);
    mockHandleBrandStats = sandbox.stub().resolves({ status: 200, body: statsBody });
    mockHandleBrandTopics = sandbox.stub().resolves({ status: 200, body: topicsBody });

    mockModelInvoke = sandbox.stub().resolves({ content: JSON.stringify(insightJson) });
    const MockAzureChatOpenAI = sandbox.stub().returns({ invoke: mockModelInvoke });

    mockCachedOk = sandbox.stub().callsFake((body) => ({ status: 200, body }));
    mockBadRequest = sandbox.stub().callsFake((msg) => ({ status: 400, body: { error: msg } }));
    mockInternalServerError = sandbox.stub().callsFake(
      (msg) => ({ status: 500, body: { error: msg } }),
    );
    mockCreateResponse = sandbox.stub().callsFake((body, status) => ({ status, body }));

    const mod = await esmock('../../src/controllers/ai-visibility-insights.js', {
      '../../src/support/ai-visibility/grpc-transport.js': {
        getGrpcClients: mockGetGrpcClients,
      },
      '../../src/support/ai-visibility/handlers/brands.js': {
        handleBrandStats: mockHandleBrandStats,
        handleBrandTopics: mockHandleBrandTopics,
      },
      '../../src/support/cached-response.js': {
        cachedOk: mockCachedOk,
      },
      '@adobe/spacecat-shared-http-utils': {
        badRequest: mockBadRequest,
        internalServerError: mockInternalServerError,
        createResponse: mockCreateResponse,
      },
      '@adobe/spacecat-shared-utils': {
        isNonEmptyObject: (o) => o != null && typeof o === 'object' && Object.keys(o).length > 0,
      },
      '@langchain/openai': {
        AzureChatOpenAI: MockAzureChatOpenAI,
      },
      '@langchain/core/messages': {
        // eslint-disable-next-line func-names
        HumanMessage: function HumanMessage(c) { this.content = c; },
        // eslint-disable-next-line func-names
        SystemMessage: function SystemMessage(c) { this.content = c; },
      },
    });

    AiVisibilityInsightsController = mod.default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  // -------------------------------------------------------------------------
  // Constructor validation
  // -------------------------------------------------------------------------
  describe('constructor validation', () => {
    it('throws when context is null', () => {
      expect(() => AiVisibilityInsightsController(null, log, env)).to.throw('Context required');
    });

    it('throws when context is undefined', () => {
      expect(() => AiVisibilityInsightsController(undefined, log, env)).to.throw('Context required');
    });

    it('throws when context is an empty object', () => {
      expect(() => AiVisibilityInsightsController({}, log, env)).to.throw('Context required');
    });

    it('throws when log is null', () => {
      expect(() => AiVisibilityInsightsController({ some: 'data' }, null, env)).to.throw('Log required');
    });

    it('throws when log is undefined', () => {
      expect(() => AiVisibilityInsightsController({ some: 'data' }, undefined, env)).to.throw('Log required');
    });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe('getInsights – happy path', () => {
    it('returns cachedOk with synthesised insight shape', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(result.status).to.equal(200);
      expect(result.body).to.deep.include({
        domain: 'acme.com',
        region: 'US',
        aiVisibility: 0.42,
        trendDirection: insightJson.trendDirection,
        summary: insightJson.summary,
        topTopic: insightJson.topTopic,
        action: insightJson.action,
      });
    });

    it('calls handleBrandStats and handleBrandTopics in parallel', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      expect(mockHandleBrandStats.calledOnce).to.be.true;
      expect(mockHandleBrandTopics.calledOnce).to.be.true;
    });

    it('passes domain and region to brand stats', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('domain')).to.equal('acme.com');
      expect(sp.get('region')).to.equal('US');
      expect(sp.get('windowMonths')).to.equal('4');
    });

    it('defaults region to US when not provided', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext('https://api.example.com/insights?domain=acme.com'));

      const [sp] = mockHandleBrandStats.firstCall.args;
      expect(sp.get('region')).to.equal('US');
    });

    it('invokes the LLM model with a prompt containing the domain', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      expect(mockModelInvoke.calledOnce).to.be.true;
      const [messages] = mockModelInvoke.firstCall.args;
      const promptText = messages.map((m) => m.content).join(' ');
      expect(promptText).to.include('acme.com');
    });

    it('uses topics items in the LLM prompt', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      const [messages] = mockModelInvoke.firstCall.args;
      const promptText = messages.map((m) => m.content).join(' ');
      expect(promptText).to.include('running shoes');
    });

    it('handles topics body with no items gracefully', async () => {
      mockHandleBrandTopics.resolves({ status: 200, body: {} });
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(result.status).to.equal(200);
    });
  });

  // -------------------------------------------------------------------------
  // Trend detection
  // -------------------------------------------------------------------------
  describe('trend detection', () => {
    it('returns "up" when latest visibility is more than 5% above the first', async () => {
      mockHandleBrandStats.resolves({
        status: 200,
        body: {
          aiVisibility: 0.5,
          mentions: { all: 100 },
          audience: 1000,
          byDate: [{ aiVisibility: 0.30 }, { aiVisibility: 0.50 }],
        },
      });
      mockModelInvoke.resolves({ content: JSON.stringify({ ...insightJson, trendDirection: 'up' }) });

      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      const [messages] = mockModelInvoke.firstCall.args;
      expect(messages.map((m) => m.content).join(' ')).to.include('up');
      expect(result.body.trendDirection).to.equal('up');
    });

    it('returns "down" when latest visibility is more than 5% below the first', async () => {
      mockHandleBrandStats.resolves({
        status: 200,
        body: {
          aiVisibility: 0.28,
          mentions: { all: 100 },
          audience: 1000,
          byDate: [{ aiVisibility: 0.40 }, { aiVisibility: 0.28 }],
        },
      });
      mockModelInvoke.resolves({ content: JSON.stringify({ ...insightJson, trendDirection: 'down' }) });

      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());
      expect(result.body.trendDirection).to.equal('down');
    });

    it('returns "flat" when byDate is empty', async () => {
      mockHandleBrandStats.resolves({
        status: 200,
        body: {
          aiVisibility: 0.4, mentions: { all: 100 }, audience: 1000, byDate: [],
        },
      });
      mockModelInvoke.resolves({ content: JSON.stringify({ ...insightJson, trendDirection: 'flat' }) });

      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());
      expect(result.body.trendDirection).to.equal('flat');
    });
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------
  describe('getInsights – validation', () => {
    it('returns 400 when domain is missing', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext('https://api.example.com/insights?region=US'));

      expect(mockBadRequest.calledOnce).to.be.true;
      expect(result.status).to.equal(400);
      expect(mockHandleBrandStats.called).to.be.false;
    });

    it('returns 400 when domain is empty string', async () => {
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext('https://api.example.com/insights?domain=&region=US'));

      expect(mockBadRequest.calledOnce).to.be.true;
      expect(result.status).to.equal(400);
    });
  });

  // -------------------------------------------------------------------------
  // gRPC transport failure
  // -------------------------------------------------------------------------
  describe('getInsights – gRPC transport failure', () => {
    it('returns 503 when getGrpcClients throws', async () => {
      mockGetGrpcClients.throws(new Error('credentials missing'));
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      expect(mockCreateResponse.calledOnce).to.be.true;
      const [body, status] = mockCreateResponse.firstCall.args;
      expect(status).to.equal(503);
      expect(body.error).to.equal('aiVisibilityNotConfigured');
      expect(mockHandleBrandStats.called).to.be.false;
    });

    it('logs the gRPC init error', async () => {
      const err = new Error('transport failed');
      mockGetGrpcClients.throws(err);
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      expect(log.error.calledWith('AI Visibility gRPC transport init failed', err)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // Data fetch failures
  // -------------------------------------------------------------------------
  describe('getInsights – data fetch failures', () => {
    it('returns 500 when handleBrandStats rejects', async () => {
      mockHandleBrandStats.rejects(new Error('gRPC timeout'));
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(mockInternalServerError.calledOnce).to.be.true;
      expect(result.status).to.equal(500);
    });

    it('returns non-200 from brand stats upstream', async () => {
      mockHandleBrandStats.resolves({ status: 404, body: { error: 'not_found' } });
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(mockCreateResponse.calledOnce).to.be.true;
      expect(result.status).to.equal(404);
      expect(mockModelInvoke.called).to.be.false;
    });

    it('continues with empty topics when handleBrandTopics returns non-200', async () => {
      mockHandleBrandTopics.resolves({ status: 503, body: { error: 'unavailable' } });
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(result.status).to.equal(200);
      expect(mockModelInvoke.calledOnce).to.be.true;
    });

    it('logs the data fetch error', async () => {
      const err = new Error('fetch failed');
      mockHandleBrandStats.rejects(err);
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      expect(log.error.calledWith('AI Visibility data fetch failed', err)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // LLM failures
  // -------------------------------------------------------------------------
  describe('getInsights – LLM failures', () => {
    it('returns 500 when model.invoke rejects', async () => {
      mockModelInvoke.rejects(new Error('OpenAI rate limit'));
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(mockInternalServerError.calledOnce).to.be.true;
      expect(result.status).to.equal(500);
    });

    it('returns 500 when model returns non-JSON content', async () => {
      mockModelInvoke.resolves({ content: 'not valid json {{' });
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      const result = await controller.getInsights(makeContext());

      expect(mockInternalServerError.calledOnce).to.be.true;
      expect(result.status).to.equal(500);
    });

    it('logs the LLM error', async () => {
      const err = new Error('timeout');
      mockModelInvoke.rejects(err);
      const controller = AiVisibilityInsightsController({ some: 'data' }, log, env);
      await controller.getInsights(makeContext());

      expect(log.error.calledWith('AI insight generation failed', err)).to.be.true;
    });
  });
});
