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

import {
  resolveSemrushCredential,
  setSemrushCredentialProvider,
  getCachedToken,
  resetSemrushCredentialCache,
  setTokenCacheMaxSize,
  getTokenCacheSize,
} from '../../../src/support/ai-visibility/semrush-credential-resolver.js';

use(chaiAsPromised);

describe('semrush-credential-resolver', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
    // Restore module state to its default (inert) shape between tests.
    setSemrushCredentialProvider(null);
    resetSemrushCredentialCache();
  });

  describe('resolveSemrushCredential', () => {
    it('returns null when no provider is configured (default)', () => {
      expect(resolveSemrushCredential('brand-1', {})).to.equal(null);
    });

    it('returns the descriptor from an installed provider with the correct key', () => {
      const getAuthToken = sandbox.stub().resolves('raw-token');
      const provider = sandbox.stub().returns({ key: 'org-42', getAuthToken });
      setSemrushCredentialProvider(provider);

      const env = { SOME: 'env' };
      const descriptor = resolveSemrushCredential('brand-1', env);

      expect(descriptor).to.not.equal(null);
      expect(descriptor.key).to.equal('org-42');
      expect(descriptor.getAuthToken).to.equal(getAuthToken);
      expect(provider.calledOnceWithExactly('brand-1', env)).to.be.true;
    });

    it('returns null when the provider yields a falsy value', () => {
      setSemrushCredentialProvider(() => null);
      expect(resolveSemrushCredential('brand-1', {})).to.equal(null);
    });

    it('treats a non-function provider as no provider (restores fallback)', () => {
      setSemrushCredentialProvider(() => ({ key: 'k', getAuthToken: async () => 't' }));
      setSemrushCredentialProvider(null);
      expect(resolveSemrushCredential('brand-1', {})).to.equal(null);
    });
  });

  describe('getCachedToken', () => {
    it('mints once and reuses the cached token within the default TTL', async () => {
      const mint = sandbox.stub().resolves('tok-1');

      const first = await getCachedToken('k1', mint, 0);
      const second = await getCachedToken('k1', mint, 1000);

      expect(first).to.equal('tok-1');
      expect(second).to.equal('tok-1');
      expect(mint.calledOnce).to.be.true;
    });

    it('re-mints after expiry (default TTL, injected now)', async () => {
      let n = 0;
      const mint = sandbox.stub().callsFake(() => {
        n += 1;
        return Promise.resolve(`tok-${n}`);
      });

      const ttl = 5 * 60 * 1000;
      const first = await getCachedToken('k1', mint, 0);
      // Still within TTL: cached.
      const cached = await getCachedToken('k1', mint, ttl - 1);
      // At/after TTL boundary: re-mint.
      const reminted = await getCachedToken('k1', mint, ttl);

      expect(first).to.equal('tok-1');
      expect(cached).to.equal('tok-1');
      expect(reminted).to.equal('tok-2');
      expect(mint.calledTwice).to.be.true;
    });

    it('honors expiresInMs from the mint result', async () => {
      const mint = sandbox.stub();
      mint.onFirstCall().resolves({ token: 'a', expiresInMs: 100 });
      mint.onSecondCall().resolves({ token: 'b', expiresInMs: 100 });

      const first = await getCachedToken('k1', mint, 0);
      const stillCached = await getCachedToken('k1', mint, 99);
      const reminted = await getCachedToken('k1', mint, 100);

      expect(first).to.equal('a');
      expect(stillCached).to.equal('a');
      expect(reminted).to.equal('b');
      expect(mint.calledTwice).to.be.true;
    });

    it('honors an absolute expiresAtMs from the mint result', async () => {
      const mint = sandbox.stub();
      mint.onFirstCall().resolves({ token: 'a', expiresAtMs: 500 });
      mint.onSecondCall().resolves({ token: 'b', expiresAtMs: 5000 });

      const first = await getCachedToken('k1', mint, 100);
      const stillCached = await getCachedToken('k1', mint, 499);
      const reminted = await getCachedToken('k1', mint, 500);

      expect(first).to.equal('a');
      expect(stillCached).to.equal('a');
      expect(reminted).to.equal('b');
    });

    it('caches distinct keys independently', async () => {
      const mintA = sandbox.stub().resolves('a');
      const mintB = sandbox.stub().resolves('b');

      const a = await getCachedToken('k-a', mintA, 0);
      const b = await getCachedToken('k-b', mintB, 0);

      expect(a).to.equal('a');
      expect(b).to.equal('b');
      expect(getTokenCacheSize()).to.equal(2);
    });

    it('throws on a malformed mint result and caches nothing', async () => {
      const mint = sandbox.stub().resolves({ notToken: 'oops' });

      await expect(getCachedToken('k1', mint, 0)).to.be.rejectedWith(
        /mintFn must resolve a token string/,
      );
      expect(getTokenCacheSize()).to.equal(0);

      // A subsequent well-formed mint still works (nothing poisoned the cache).
      const good = sandbox.stub().resolves('tok-ok');
      expect(await getCachedToken('k1', good, 0)).to.equal('tok-ok');
      expect(good.calledOnce).to.be.true;
    });

    it('propagates a mintFn rejection and caches nothing', async () => {
      const boom = new Error('mint failed');
      const mint = sandbox.stub().rejects(boom);

      await expect(getCachedToken('k1', mint, 0)).to.be.rejectedWith('mint failed');
      expect(getTokenCacheSize()).to.equal(0);
    });

    it('evicts the oldest entry when the cache is at capacity', async () => {
      setTokenCacheMaxSize(2);

      const mint = sandbox.stub();
      mint.resolves('t');

      await getCachedToken('a', mint, 0);
      await getCachedToken('b', mint, 0);
      await getCachedToken('c', mint, 0); // evicts 'a'

      expect(getTokenCacheSize()).to.equal(2);
      expect(mint.callCount).to.equal(3);

      // 'a' was evicted -> re-request mints again; 'b'/'c' remain cached.
      await getCachedToken('a', mint, 0);
      expect(mint.callCount).to.equal(4);
      await getCachedToken('c', mint, 0);
      expect(mint.callCount).to.equal(4);
    });
  });
});
