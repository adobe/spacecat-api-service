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

/** Snapshot at load time so we can reset after other suites stub `globalThis.fetch`. */
const ORIGINAL_FETCH = globalThis.fetch;

function restoreGlobalFetchIfStubbed() {
  const f = globalThis.fetch;
  if (f && typeof f.restore === 'function') {
    f.restore();
  }
  if (typeof ORIGINAL_FETCH === 'function') {
    globalThis.fetch = ORIGINAL_FETCH;
  }
}

const FLAG = 'AI_VISIBILITY_PER_BRAND_AUTH_ENABLED';

describe('grpc-transport per-brand auth seam', () => {
  let sandbox;
  let getGrpcClients;
  let resetGrpcClients;
  let setClientPoolMaxSize;
  let getClientPoolSize;
  let mockCreateClient;
  let mockCreateGrpcTransport;
  let mockResolve;
  let mockGetCachedToken;

  beforeEach(async () => {
    restoreGlobalFetchIfStubbed();
    sandbox = sinon.createSandbox();
    // Each createClient call returns a distinct object so we can assert per-key pools.
    mockCreateClient = sandbox.stub().callsFake(() => ({}));
    mockCreateGrpcTransport = sandbox.stub().callsFake(() => ({}));
    mockResolve = sandbox.stub();
    mockGetCachedToken = sandbox.stub();

    const mod = await esmock(
      '../../../src/support/ai-visibility/grpc-transport.js',
      {
        '@connectrpc/connect': { createClient: mockCreateClient },
        '@connectrpc/connect-node': {
          createGrpcTransport: mockCreateGrpcTransport,
        },
        '../../../third-party/ai-seo-ts/v2/brand/service_pb.js': {
          BrandService: {},
        },
        '../../../third-party/ai-seo-ts/v2/topic/service_pb.js': {
          TopicService: {},
        },
        '../../../third-party/ai-seo-ts/v2/prompt/service_pb.js': {
          PromptService: {},
        },
        '../../../third-party/ai-seo-ts/v2/source/service_pb.js': {
          SourceService: {},
        },
        '../../../third-party/ai-seo-ts/v2/competitor/service_pb.js': {
          CompetitorService: {},
        },
        '../../../third-party/ai-seo-ts/ai-cr/service_pb.js': {
          CompetitorsMetrics: {},
          Meta: {},
        },
        '../../../third-party/ai-seo-ts/ai-vo/service_pb.js': { Sources: {} },
        '../../../third-party/ai-seo-ts/ai-pr/service_pb.js': { Relations: {} },
        '../../../src/support/ai-visibility/semrush-credential-resolver.js': {
          resolveSemrushCredential: mockResolve,
          getCachedToken: mockGetCachedToken,
        },
      },
    );
    ({
      getGrpcClients,
      resetGrpcClients,
      setClientPoolMaxSize,
      getClientPoolSize,
    } = mod);
  });

  afterEach(() => {
    sandbox.restore();
    restoreGlobalFetchIfStubbed();
    if (resetGrpcClients) {
      resetGrpcClients();
    }
  });

  /** Grab the single interceptor handed to the (stubbed) transport factory. */
  function interceptorFromCall(callIndex = 0) {
    return mockCreateGrpcTransport.getCall(callIndex).args[0].interceptors[0];
  }

  /** Drive an interceptor exactly as connect would, returning the mutated request. */
  async function runInterceptor(interceptor) {
    const next = sandbox.stub().resolves('response');
    const req = { header: { set: sandbox.stub() } };
    const result = await interceptor(next)(req);
    return { next, req, result };
  }

  function stubSharedTokenFetch(token = 'shared-tok') {
    restoreGlobalFetchIfStubbed();
    return sandbox.stub(globalThis, 'fetch').resolves({
      status: 200,
      json: () => Promise.resolve({ access_token: token }),
    });
  }

  describe('flag OFF (default)', () => {
    it('never consults the credential seam and reuses the singleton', () => {
      const env = { SEO_CLIENT_ID: 'id', SEO_CLIENT_SECRET: 'sec' };
      const first = getGrpcClients(env);
      const second = getGrpcClients(env, 'brand-1');

      expect(first).to.equal(second);
      expect(mockCreateGrpcTransport.calledOnce).to.be.true;
      expect(mockResolve.notCalled).to.be.true;
      expect(mockGetCachedToken.notCalled).to.be.true;
    });

    it('treats FLAG="false" as off', () => {
      getGrpcClients({ [FLAG]: 'false' }, 'brand-1');
      expect(mockResolve.notCalled).to.be.true;
    });

    it('treats an unrecognized FLAG value as off', () => {
      getGrpcClients({ [FLAG]: 'yes' }, 'brand-1');
      expect(mockResolve.notCalled).to.be.true;
    });

    it('uses the shared client_credentials interceptor (getAccessToken via fetch)', async () => {
      const fetchStub = stubSharedTokenFetch('off-tok');
      const env = { SEO_CLIENT_ID: 'id', SEO_CLIENT_SECRET: 'sec' };

      getGrpcClients(env);
      const { req, next } = await runInterceptor(interceptorFromCall());

      expect(fetchStub.calledOnce).to.be.true;
      expect(mockGetCachedToken.notCalled).to.be.true;
      expect(req.header.set.firstCall.args).to.deep.equal([
        'authorization',
        'Bearer off-tok',
      ]);
      expect(next.calledOnce).to.be.true;
    });
  });

  describe('flag ON', () => {
    const onEnv = () => ({
      [FLAG]: 'true',
      SEO_CLIENT_ID: 'id',
      SEO_CLIENT_SECRET: 'sec',
    });

    it('resolver returns null -> falls back to the shared credential path', async () => {
      mockResolve.returns(null);
      const fetchStub = stubSharedTokenFetch('fallback-tok');
      const env = onEnv();

      getGrpcClients(env, 'brand-1');

      expect(mockResolve.calledOnceWithExactly('brand-1', env)).to.be.true;
      expect(mockCreateGrpcTransport.calledOnce).to.be.true;

      const { req } = await runInterceptor(interceptorFromCall());
      expect(fetchStub.calledOnce).to.be.true;
      expect(mockGetCachedToken.notCalled).to.be.true;
      expect(req.header.set.firstCall.args).to.deep.equal([
        'authorization',
        'Bearer fallback-tok',
      ]);
    });

    it('resolver returns a descriptor -> uses its key + token via the TTL cache', async () => {
      const getAuthToken = sandbox.stub().resolves('brand-raw-token');
      mockResolve.returns({ key: 'org-42', getAuthToken });
      mockGetCachedToken.resolves('brand-cached-token');
      const env = onEnv();

      getGrpcClients(env, 'brand-1');
      const { req } = await runInterceptor(interceptorFromCall());

      // Header carries the token from the credential cache, not the shared path.
      expect(req.header.set.firstCall.args).to.deep.equal([
        'authorization',
        'Bearer brand-cached-token',
      ]);
      // Cache was keyed by the descriptor key; getAuthToken was NOT called directly
      // (only through the mint fn the cache owns).
      expect(mockGetCachedToken.calledOnce).to.be.true;
      expect(mockGetCachedToken.firstCall.args[0]).to.equal('org-42');
      expect(getAuthToken.notCalled).to.be.true;
    });

    it('the mint fn passed to the cache mints the raw token via getAuthToken(env)', async () => {
      const getAuthToken = sandbox.stub().resolves('brand-raw-token');
      mockResolve.returns({ key: 'org-42', getAuthToken });
      // Execute the mint fn the interceptor hands to the cache.
      mockGetCachedToken.callsFake((key, mintFn) => mintFn());
      const env = onEnv();

      getGrpcClients(env, 'brand-1');
      const { req } = await runInterceptor(interceptorFromCall());

      expect(getAuthToken.calledOnceWithExactly(env)).to.be.true;
      expect(req.header.set.firstCall.args).to.deep.equal([
        'authorization',
        'Bearer brand-raw-token',
      ]);
    });

    it('keys the transport pool per credential (distinct brands -> distinct clients)', () => {
      mockResolve.withArgs('brand-a').returns({ key: 'org-a', getAuthToken: async () => 'a' });
      mockResolve.withArgs('brand-b').returns({ key: 'org-b', getAuthToken: async () => 'b' });
      const env = onEnv();

      const a1 = getGrpcClients(env, 'brand-a');
      const a2 = getGrpcClients(env, 'brand-a');
      const b1 = getGrpcClients(env, 'brand-b');

      expect(a1).to.equal(a2); // same key -> cached
      expect(a1).to.not.equal(b1); // different key -> distinct pool
      expect(mockCreateGrpcTransport.calledTwice).to.be.true; // one per key
    });

    it('resetGrpcClients clears the per-credential pool', () => {
      mockResolve.returns({ key: 'org-42', getAuthToken: async () => 't' });
      const env = onEnv();

      const first = getGrpcClients(env, 'brand-1');
      resetGrpcClients();
      const second = getGrpcClients(env, 'brand-1');

      expect(first).to.not.equal(second);
      expect(mockCreateGrpcTransport.calledTwice).to.be.true;
    });

    it('bounds the client pool and rebuilds an evicted key', () => {
      setClientPoolMaxSize(2);
      mockResolve.withArgs('brand-a').returns({ key: 'org-a', getAuthToken: async () => 'a' });
      mockResolve.withArgs('brand-b').returns({ key: 'org-b', getAuthToken: async () => 'b' });
      mockResolve.withArgs('brand-c').returns({ key: 'org-c', getAuthToken: async () => 'c' });
      const env = onEnv();

      const a1 = getGrpcClients(env, 'brand-a');
      getGrpcClients(env, 'brand-b');
      getGrpcClients(env, 'brand-c'); // evicts org-a (oldest)

      expect(getClientPoolSize()).to.equal(2); // never exceeds the bound
      expect(mockCreateGrpcTransport.callCount).to.equal(3);

      // org-a was evicted -> re-resolving builds a NEW clients object (transport recreated).
      const a2 = getGrpcClients(env, 'brand-a');
      expect(a2).to.not.equal(a1);
      expect(getClientPoolSize()).to.equal(2);
      expect(mockCreateGrpcTransport.callCount).to.equal(4);
    });

    it('enables the per-brand path for boolean true and string "1"', () => {
      getGrpcClients({ [FLAG]: true, SEO_CLIENT_ID: 'id', SEO_CLIENT_SECRET: 'sec' }, 'brand-1');
      getGrpcClients({ [FLAG]: '1', SEO_CLIENT_ID: 'id', SEO_CLIENT_SECRET: 'sec' }, 'brand-2');

      expect(mockResolve.calledWith('brand-1')).to.be.true;
      expect(mockResolve.calledWith('brand-2')).to.be.true;
    });
  });
});
