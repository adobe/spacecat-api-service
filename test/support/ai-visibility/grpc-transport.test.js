/* eslint-disable header/header */
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
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

use(chaiAsPromised);

/** Avoid "fetch is already stubbed" when another test leaves globalThis.fetch wrapped. */
function restoreGlobalFetchIfStubbed() {
  const f = globalThis.fetch;
  if (f && typeof f.restore === 'function') {
    f.restore();
  }
}

describe('grpc-transport', () => {
  let sandbox;
  let getGrpcClients;
  let resetGrpcClients;
  let getAccessToken;
  let createAuthInterceptor;
  let mockCreateClient;
  let mockCreateGrpcTransport;

  beforeEach(async () => {
    restoreGlobalFetchIfStubbed();
    sandbox = sinon.createSandbox();
    mockCreateClient = sandbox.stub().returns({});
    mockCreateGrpcTransport = sandbox.stub().returns({});

    const mod = await esmock('../../../src/support/ai-visibility/grpc-transport.js', {
      '@connectrpc/connect': { createClient: mockCreateClient },
      '@connectrpc/connect-node': { createGrpcTransport: mockCreateGrpcTransport },
      '../../../third-party/ai-seo-ts/v2/brand/service_pb.js': { BrandService: {} },
      '../../../third-party/ai-seo-ts/v2/topic/service_pb.js': { TopicService: {} },
      '../../../third-party/ai-seo-ts/v2/prompt/service_pb.js': { PromptService: {} },
      '../../../third-party/ai-seo-ts/v2/source/service_pb.js': { SourceService: {} },
      '../../../third-party/ai-seo-ts/v2/competitor/service_pb.js': { CompetitorService: {} },
      '../../../third-party/ai-seo-ts/ai-cr/service_pb.js': { CompetitorsMetrics: {}, Meta: {} },
      '../../../third-party/ai-seo-ts/ai-vo/service_pb.js': { Sources: {} },
      '../../../third-party/ai-seo-ts/ai-pr/service_pb.js': { Relations: {} },
    });
    ({
      getGrpcClients,
      resetGrpcClients,
      getAccessToken,
      createAuthInterceptor,
    } = mod);
  });

  afterEach(() => {
    sandbox.restore();
    restoreGlobalFetchIfStubbed();
    if (resetGrpcClients) { resetGrpcClients(); }
  });

  describe('getGrpcClients', () => {
    const env = { AI_SEO_CLIENT_ID: 'id', AI_SEO_CLIENT_SECRET: 'sec' };

    it('returns object with all 9 client keys', () => {
      const clients = getGrpcClients(env);
      expect(Object.keys(clients)).to.have.members([
        'brandClient',
        'topicClient',
        'promptClient',
        'sourceClient',
        'competitorClient',
        'crMetricsClient',
        'crMetaClient',
        'voSourcesClient',
        'prRelationsClient',
      ]);
      expect(mockCreateGrpcTransport.calledOnce).to.be.true;
      expect(mockCreateClient.callCount).to.equal(9);
    });

    it('passes correct transport options', () => {
      getGrpcClients(env);
      const opts = mockCreateGrpcTransport.firstCall.args[0];
      expect(opts.baseUrl).to.equal('https://grpc-api.semrush.com');
      expect(opts.httpVersion).to.equal('2');
      expect(opts.interceptors).to.be.an('array').with.lengthOf(1);
    });

    it('caches clients across calls', () => {
      const first = getGrpcClients(env);
      const second = getGrpcClients(env);
      expect(first).to.equal(second);
      expect(mockCreateGrpcTransport.calledOnce).to.be.true;
    });
  });

  describe('resetGrpcClients', () => {
    it('clears cached clients and token cache', () => {
      const env = { AI_SEO_CLIENT_ID: 'id', AI_SEO_CLIENT_SECRET: 'sec' };
      const first = getGrpcClients(env);
      resetGrpcClients();
      const second = getGrpcClients(env);
      expect(first).to.not.equal(second);
      expect(mockCreateGrpcTransport.calledTwice).to.be.true;
    });
  });

  describe('getAccessToken', () => {
    const validEnv = {
      AI_SEO_CLIENT_ID: 'test-id',
      AI_SEO_CLIENT_SECRET: 'test-secret',
    };

    function stubFetch(response = { access_token: 'tok123' }) {
      restoreGlobalFetchIfStubbed();
      return sandbox.stub(globalThis, 'fetch').resolves({
        json: () => Promise.resolve(response),
      });
    }

    it('fetches and returns a token', async () => {
      const fetchStub = stubFetch();
      const token = await getAccessToken(validEnv);

      expect(token).to.equal('tok123');
      expect(fetchStub.calledOnce).to.be.true;
    });

    it('uses the default Semrush OAuth URL when AI_SEO_OAUTH_TOKEN_URL is not set', async () => {
      const fetchStub = stubFetch();
      await getAccessToken(validEnv);

      const url = fetchStub.firstCall.args[0];
      expect(url).to.equal('https://api.semrush.com/apis/v4-raw/auth/v0/oauth2/access_token');
    });

    it('falls back to default URL when AI_SEO_OAUTH_TOKEN_URL is whitespace', async () => {
      const fetchStub = stubFetch();
      await getAccessToken({ ...validEnv, AI_SEO_OAUTH_TOKEN_URL: '   ' });

      const url = fetchStub.firstCall.args[0];
      expect(url).to.include('api.semrush.com');
    });

    it('uses custom token URL from env', async () => {
      const fetchStub = stubFetch();
      const customUrl = 'https://custom.example.com/token';
      await getAccessToken({ ...validEnv, AI_SEO_OAUTH_TOKEN_URL: customUrl });

      expect(fetchStub.firstCall.args[0]).to.equal(customUrl);
    });

    it('sends correct body parameters with default scopes', async () => {
      const fetchStub = stubFetch();
      await getAccessToken(validEnv);

      const opts = fetchStub.firstCall.args[1];
      expect(opts.method).to.equal('POST');
      expect(opts.headers['Content-Type']).to.equal('application/x-www-form-urlencoded');

      const { body } = opts;
      expect(body.get('client_id')).to.equal('test-id');
      expect(body.get('client_secret')).to.equal('test-secret');
      expect(body.get('grant_type')).to.equal('client_credentials');
      expect(body.get('scope')).to.include('ai-seo.meta');
    });

    it('uses custom scopes from env', async () => {
      const fetchStub = stubFetch();
      await getAccessToken({ ...validEnv, AI_SEO_OAUTH_SCOPES: 'custom-scope' });

      const { body } = fetchStub.firstCall.args[1];
      expect(body.get('scope')).to.equal('custom-scope');
    });

    it('caches the token on second call', async () => {
      const fetchStub = stubFetch({ access_token: 'cached-tok' });

      const first = await getAccessToken(validEnv);
      const second = await getAccessToken(validEnv);

      expect(first).to.equal('cached-tok');
      expect(second).to.equal('cached-tok');
      expect(fetchStub.calledOnce).to.be.true;
    });

    it('refreshes token after resetGrpcClients', async () => {
      const fetchStub = stubFetch({ access_token: 'new-tok' });

      await getAccessToken(validEnv);
      resetGrpcClients();
      await getAccessToken(validEnv);

      expect(fetchStub.calledTwice).to.be.true;
    });

    it('throws when client ID is missing', async () => {
      await expect(getAccessToken({ AI_SEO_CLIENT_SECRET: 'sec' }))
        .to.be.rejectedWith('AI_SEO_CLIENT_ID and AI_SEO_CLIENT_SECRET must be set');
    });

    it('throws when client secret is missing', async () => {
      await expect(getAccessToken({ AI_SEO_CLIENT_ID: 'id' }))
        .to.be.rejectedWith('AI_SEO_CLIENT_ID and AI_SEO_CLIENT_SECRET must be set');
    });

    it('throws when client ID is whitespace only', async () => {
      await expect(getAccessToken({ AI_SEO_CLIENT_ID: '  ', AI_SEO_CLIENT_SECRET: 'sec' }))
        .to.be.rejectedWith('AI_SEO_CLIENT_ID and AI_SEO_CLIENT_SECRET must be set');
    });

    it('throws when client secret is whitespace only', async () => {
      await expect(getAccessToken({ AI_SEO_CLIENT_ID: 'id', AI_SEO_CLIENT_SECRET: '  ' }))
        .to.be.rejectedWith('AI_SEO_CLIENT_ID and AI_SEO_CLIENT_SECRET must be set');
    });

    it('throws when OAuth response has no access_token', async () => {
      stubFetch({ error: 'invalid_client' });

      await expect(getAccessToken(validEnv))
        .to.be.rejectedWith('oauth_failed');
    });

    it('trims client ID and secret', async () => {
      const fetchStub = stubFetch();
      await getAccessToken({
        AI_SEO_CLIENT_ID: '  padded-id  ',
        AI_SEO_CLIENT_SECRET: '  padded-secret  ',
      });

      const { body } = fetchStub.firstCall.args[1];
      expect(body.get('client_id')).to.equal('padded-id');
      expect(body.get('client_secret')).to.equal('padded-secret');
    });
  });

  describe('createAuthInterceptor', () => {
    it('returns a function that sets Authorization header and calls next', async () => {
      stubFetchForInterceptor();
      const env = { AI_SEO_CLIENT_ID: 'id', AI_SEO_CLIENT_SECRET: 'sec' };
      const interceptor = createAuthInterceptor(env);

      const nextStub = sandbox.stub().resolves('response');
      const req = { header: { set: sandbox.stub() } };
      const handler = interceptor(nextStub);
      const result = await handler(req);

      expect(req.header.set.calledOnce).to.be.true;
      expect(req.header.set.firstCall.args).to.deep.equal(['authorization', 'Bearer tok-int']);
      expect(nextStub.calledOnce).to.be.true;
      expect(nextStub.firstCall.args[0]).to.equal(req);
      expect(result).to.equal('response');
    });

    function stubFetchForInterceptor() {
      restoreGlobalFetchIfStubbed();
      sandbox.stub(globalThis, 'fetch').resolves({
        json: () => Promise.resolve({ access_token: 'tok-int' }),
      });
    }
  });
});
