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

describe('SerenityController', () => {
  const sandbox = sinon.createSandbox();

  let SerenityController;
  let mockSend;
  let MockLambdaClient;
  let MockInvokeCommand;

  // esmock is slow; load once
  before(async function () {
    this.timeout(10000);
    mockSend = sandbox.stub();
    MockInvokeCommand = sandbox.stub().callsFake((params) => params);
    MockLambdaClient = sandbox.stub().returns({ send: mockSend });

    SerenityController = await esmock('../../src/controllers/serenity.js', {
      '@aws-sdk/client-lambda': {
        LambdaClient: MockLambdaClient,
        InvokeCommand: MockInvokeCommand,
      },
    });
  });

  const BASE_URL = 'https://spacecat.example.com';
  const BRIDGE_LAMBDA = 'serenity-bridge-dev';
  const BRIDGE_URL = 'http://127.0.0.1:8788';

  const makeContext = (envOverrides = {}, url = `${BASE_URL}/apis/serenity/v1/ai-visibility/brands/stats?country=US`) => ({
    log: {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    },
    env: {
      SR_GRPC_ADAPTER_LAMBDA_NAME: BRIDGE_LAMBDA,
      ...envOverrides,
    },
    request: new Request(url),
    pathInfo: { suffix: new URL(url).pathname },
  });

  const makeBridgePayload = (body, statusCode = 200) => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({ statusCode, body: JSON.stringify(body) }),
    );
    return { Payload: encoded, FunctionError: undefined };
  };

  beforeEach(() => {
    mockSend.reset();
    MockInvokeCommand.reset();
    MockLambdaClient.reset();
    MockLambdaClient.returns({ send: mockSend });
    MockInvokeCommand.callsFake((params) => params);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Lambda bridge', () => {
    it('invokes bridge Lambda and returns enriched JSON on 200', async () => {
      const bridgeBody = { data: [{ country: 'US', engine: 'chatgpt' }] };
      mockSend.resolves(makeBridgePayload(bridgeBody));

      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(200);
      const json = await response.json();
      expect(json.data).to.deep.equal(bridgeBody.data);
      expect(json.sr_filters).to.exist;
      expect(json.sr_filters.markets).to.include('US');
      expect(json.sr_filters.models).to.include('chatgpt');
    });

    it('passes path and query string to Lambda', async () => {
      const url = `${BASE_URL}/apis/serenity/v1/ai-visibility/brands/topics?country=DE&engine=gemini`;
      const bridgeBody = { data: [] };
      mockSend.resolves(makeBridgePayload(bridgeBody));

      const ctx = makeContext({}, url);
      const controller = SerenityController(ctx);
      await controller.getBrandsTopics(ctx);

      const invokeArg = MockInvokeCommand.firstCall.args[0];
      const payload = JSON.parse(invokeArg.Payload);
      expect(payload.path).to.equal('/apis/serenity/v1/ai-visibility/brands/topics?country=DE&engine=gemini');
    });

    it('returns non-200 status from bridge without filter enrichment', async () => {
      const bridgeBody = { error: 'not_found' };
      mockSend.resolves(makeBridgePayload(bridgeBody, 404));

      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(404);
      const json = await response.json();
      expect(json.error).to.equal('not_found');
      expect(json.sr_filters).to.not.exist;
    });

    it('returns 502 on Lambda FunctionError', async () => {
      const errPayload = new TextEncoder().encode(JSON.stringify({ errorMessage: 'timeout' }));
      mockSend.resolves({ Payload: errPayload, FunctionError: 'Unhandled' });

      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(502);
      const json = await response.json();
      expect(json.error).to.equal('bridge_error');
    });

    it('returns 502 on Lambda FunctionError without Payload', async () => {
      mockSend.resolves({ Payload: undefined, FunctionError: 'Unhandled' });

      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(502);
      const json = await response.json();
      expect(json.error).to.equal('bridge_error');
      expect(json.message).to.equal('Unhandled');
    });

    it('returns 502 when Lambda returns malformed body JSON', async () => {
      const encoded = new TextEncoder().encode(
        JSON.stringify({ statusCode: 200, body: 'NOT_JSON{{' }),
      );
      mockSend.resolves({ Payload: encoded, FunctionError: undefined });

      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(502);
      const json = await response.json();
      expect(json.error).to.equal('bridge_bad_payload');
    });

    it('returns 500 when Lambda invocation throws', async () => {
      mockSend.rejects(new Error('network failure'));

      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(500);
    });

    it('applies gap-prompts normalization for the right relPath', async () => {
      const url = `${BASE_URL}/apis/serenity/v1/ai-visibility/competitors/gap-prompts`;
      const bridgeBody = { data: [{ p: 1 }], offset: 0, total: 0 };
      mockSend.resolves(makeBridgePayload(bridgeBody));

      const ctx = makeContext({}, url);
      const controller = SerenityController(ctx);
      const response = await controller.getCompetitorsGapPrompts(ctx);

      expect(response.status).to.equal(200);
      const json = await response.json();
      expect(json.total).to.equal(1);
    });

    it('exposes all 22 handler methods', () => {
      const ctx = makeContext();
      const controller = SerenityController(ctx);
      const expectedMethods = [
        'getBrandsStats', 'getBrandsTopics', 'getBrandsPrompts', 'getBrandsCitedPages',
        'getBrandsTopicOpportunities', 'getBrandsTopBrands', 'getBrandsCitedSources',
        'getBrandsSourceOpportunities', 'getBrandsCompetitors', 'getCompetitorsMetrics',
        'getCompetitorsGapTopics', 'getCompetitorsGapSourceDomains', 'getCompetitorsGapPrompts',
        'getMeta', 'getPromptsResponses', 'getPromptsResponsesLatest', 'getTopicsResearchStats',
        'getTopicsResearch', 'getTopicsStats', 'getTopicsResearchPrompts',
        'getTopicsResearchBrands', 'getTopicsResearchSourceDomains',
      ];
      for (const method of expectedMethods) {
        expect(controller).to.have.property(method).that.is.a('function');
      }
    });
  });

  describe('HTTP bridge', () => {
    it('proxies via HTTP when SR_GRPC_ADAPTER_URL is set', async () => {
      const bridgeBody = { data: [] };
      sandbox.stub(globalThis, 'fetch').resolves(
        new Response(JSON.stringify(bridgeBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const ctx = makeContext({ SR_GRPC_ADAPTER_LAMBDA_NAME: '', SR_GRPC_ADAPTER_URL: BRIDGE_URL });
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(200);
      const json = await response.json();
      expect(json.sr_filters).to.exist;
    });

    it('returns 500 when HTTP bridge throws', async () => {
      sandbox.stub(globalThis, 'fetch').rejects(new Error('connection refused'));

      const ctx = makeContext({ SR_GRPC_ADAPTER_LAMBDA_NAME: '', SR_GRPC_ADAPTER_URL: BRIDGE_URL });
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(500);
    });
  });

  describe('misconfigured', () => {
    it('returns 503 when neither Lambda nor HTTP bridge is configured', async () => {
      const ctx = makeContext({ SR_GRPC_ADAPTER_LAMBDA_NAME: '', SR_GRPC_ADAPTER_URL: '' });
      const controller = SerenityController(ctx);
      const response = await controller.getBrandsStats(ctx);

      expect(response.status).to.equal(503);
      const json = await response.json();
      expect(json.error).to.equal('bridge_not_configured');
    });
  });
});
