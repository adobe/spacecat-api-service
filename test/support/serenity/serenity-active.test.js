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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { CACHE_TTL_MS, NEG_TTL_MS, MAX_ENTRIES } from '../../../src/support/serenity/workspace-resolver.js';

use(sinonChai);

const ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function fakeCtx() {
  return { dataAccess: { services: { postgrestClient: { from: () => ({}) } } } };
}

describe('isSerenityActiveForOrg', () => {
  let readFeatureFlagStub;
  let isSerenityActiveForOrg;
  let clearSerenityFlagCache;
  let SERENITY_FEATURE_FLAG_PRODUCT;
  let SERENITY_FEATURE_FLAG_NAME;

  beforeEach(async () => {
    readFeatureFlagStub = sinon.stub();
    const mod = await esmock('../../../src/support/serenity/serenity-active.js', {
      '../../../src/support/feature-flags-storage.js': {
        readFeatureFlag: readFeatureFlagStub,
      },
    });
    ({
      isSerenityActiveForOrg,
      clearSerenityFlagCache,
      SERENITY_FEATURE_FLAG_PRODUCT,
      SERENITY_FEATURE_FLAG_NAME,
    } = mod);
    clearSerenityFlagCache();
  });

  afterEach(() => sinon.restore());

  it('exposes the org-wide LLMO/serenity flag identity', () => {
    expect(SERENITY_FEATURE_FLAG_PRODUCT).to.equal('LLMO');
    expect(SERENITY_FEATURE_FLAG_NAME).to.equal('serenity');
  });

  it('returns true when the flag is true and reads it with the right key', async () => {
    readFeatureFlagStub.resolves(true);
    const active = await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(active).to.equal(true);
    expect(readFeatureFlagStub).to.have.been.calledOnce;
    expect(readFeatureFlagStub.firstCall.args[0]).to.include({
      organizationId: ORG,
      product: 'LLMO',
      flagName: 'serenity',
    });
  });

  it('returns false when the flag is explicitly false', async () => {
    readFeatureFlagStub.resolves(false);
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('returns false when no flag row exists (null), defaulting OFF', async () => {
    readFeatureFlagStub.resolves(null);
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('returns false for a missing/blank organization id without touching the DB', async () => {
    expect(await isSerenityActiveForOrg(fakeCtx(), '', fakeLog())).to.equal(false);
    expect(await isSerenityActiveForOrg(fakeCtx(), undefined, fakeLog())).to.equal(false);
    expect(readFeatureFlagStub).to.not.have.been.called;
  });

  it('returns false and warns when the PostgREST client is unavailable', async () => {
    const log = fakeLog();
    const ctx = { dataAccess: { services: {} } };
    expect(await isSerenityActiveForOrg(ctx, ORG, log)).to.equal(false);
    expect(readFeatureFlagStub).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('returns false and logs (does not throw) when the flag read fails', async () => {
    const log = fakeLog();
    readFeatureFlagStub.rejects(new Error('boom'));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    expect(log.error).to.have.been.calledOnce;
  });

  it('does not require a logger', async () => {
    readFeatureFlagStub.resolves(true);
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG)).to.equal(true);
  });

  it('caches the value within the TTL (one DB read for repeated calls)', async () => {
    readFeatureFlagStub.resolves(true);
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(readFeatureFlagStub).to.have.been.calledOnce;
  });

  it('clearSerenityFlagCache forces a re-read', async () => {
    readFeatureFlagStub.resolves(true);
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    clearSerenityFlagCache();
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(readFeatureFlagStub).to.have.been.calledTwice;
  });

  it('evicts the oldest entry once the cache exceeds MAX_ENTRIES', async () => {
    readFeatureFlagStub.resolves(true);
    // Fill past the cap so the oldest entries are evicted (insertion-order LRU).
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await isSerenityActiveForOrg(fakeCtx(), `org-${i}`, fakeLog());
    }
    const callsAfterFill = readFeatureFlagStub.callCount;
    // org-0 was evicted, so resolving it again re-reads (a still-cached org would not).
    await isSerenityActiveForOrg(fakeCtx(), 'org-0', fakeLog());
    expect(readFeatureFlagStub.callCount).to.equal(callsAfterFill + 1);
  });

  it('does NOT cache a transient read error (re-reads on the next call)', async () => {
    const log = fakeLog();
    readFeatureFlagStub.onFirstCall().rejects(new Error('boom'));
    readFeatureFlagStub.onSecondCall().resolves(true);
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, log)).to.equal(true);
    expect(readFeatureFlagStub).to.have.been.calledTwice;
  });

  describe('TTL expiry (fake timers)', () => {
    let clock;
    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 1_000_000 });
    });
    afterEach(() => clock.restore());

    it('re-reads a positive value only after the positive TTL elapses', async () => {
      readFeatureFlagStub.resolves(true);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      clock.tick(CACHE_TTL_MS - 1);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledOnce; // still cached
      clock.tick(2);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledTwice; // expired → re-read
    });

    it('re-reads a negative value after the shorter negative TTL', async () => {
      readFeatureFlagStub.resolves(false);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      clock.tick(NEG_TTL_MS - 1);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledOnce; // still cached
      clock.tick(2);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledTwice; // expired → re-read
    });
  });
});
