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

describe('isDynamicAllocationActiveForOrg', () => {
  let readFeatureFlagStub;
  let isDynamicAllocationActiveForOrg;
  let clearDynamicAllocationFlagCache;
  let PRODUCT;
  let NAME;

  beforeEach(async () => {
    readFeatureFlagStub = sinon.stub();
    const mod = await esmock('../../../src/support/serenity/dynamic-allocation-active.js', {
      '../../../src/support/feature-flags-storage.js': {
        readFeatureFlag: readFeatureFlagStub,
      },
    });
    ({
      isDynamicAllocationActiveForOrg,
      clearDynamicAllocationFlagCache,
      DYNAMIC_ALLOCATION_FEATURE_FLAG_PRODUCT: PRODUCT,
      DYNAMIC_ALLOCATION_FEATURE_FLAG_NAME: NAME,
    } = mod);
    clearDynamicAllocationFlagCache();
  });

  afterEach(() => sinon.restore());

  it('exposes the org-wide LLMO/dynamic_allocation flag identity', () => {
    expect(PRODUCT).to.equal('LLMO');
    expect(NAME).to.equal('dynamic_allocation');
  });

  it('returns true when the flag is true and reads it with the right key', async () => {
    readFeatureFlagStub.resolves(true);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(true);
    expect(readFeatureFlagStub.firstCall.args[0]).to.include({
      organizationId: ORG, product: 'LLMO', flagName: 'dynamic_allocation',
    });
  });

  it('defaults OFF for false / null (missing row)', async () => {
    readFeatureFlagStub.resolves(false);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
    clearDynamicAllocationFlagCache();
    readFeatureFlagStub.resolves(null);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('returns false for a missing/blank org id without touching the DB', async () => {
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), '', fakeLog())).to.equal(false);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), undefined, fakeLog())).to.equal(false);
    expect(readFeatureFlagStub).to.not.have.been.called;
  });

  it('returns false and warns when the PostgREST client is unavailable', async () => {
    const log = fakeLog();
    const ctx = { dataAccess: { services: {} } };
    expect(await isDynamicAllocationActiveForOrg(ctx, ORG, log)).to.equal(false);
    expect(readFeatureFlagStub).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('returns false and logs (does not throw) when the flag read fails', async () => {
    const log = fakeLog();
    readFeatureFlagStub.rejects(new Error('boom'));
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    expect(log.error).to.have.been.calledOnce;
  });

  it('does not require a logger', async () => {
    readFeatureFlagStub.resolves(true);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG)).to.equal(true);
  });

  it('caches within the TTL, and clear forces a re-read', async () => {
    readFeatureFlagStub.resolves(true);
    await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
    await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(readFeatureFlagStub).to.have.been.calledOnce;
    clearDynamicAllocationFlagCache();
    await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(readFeatureFlagStub).to.have.been.calledTwice;
  });

  it('evicts the oldest entry once the cache exceeds MAX_ENTRIES', async () => {
    readFeatureFlagStub.resolves(true);
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await isDynamicAllocationActiveForOrg(fakeCtx(), `org-${i}`, fakeLog());
    }
    const afterFill = readFeatureFlagStub.callCount;
    await isDynamicAllocationActiveForOrg(fakeCtx(), 'org-0', fakeLog()); // evicted → re-read
    expect(readFeatureFlagStub.callCount).to.equal(afterFill + 1);
  });

  it('does NOT cache a transient read error (re-reads on the next call)', async () => {
    readFeatureFlagStub.onFirstCall().rejects(new Error('boom'));
    readFeatureFlagStub.onSecondCall().resolves(true);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
    expect(await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(true);
    expect(readFeatureFlagStub).to.have.been.calledTwice;
  });

  describe('TTL expiry (fake timers)', () => {
    let clock;
    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 1_000_000 });
    });
    afterEach(() => clock.restore());

    it('re-reads a positive value only after the positive TTL', async () => {
      readFeatureFlagStub.resolves(true);
      await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
      clock.tick(CACHE_TTL_MS - 1);
      await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledOnce;
      clock.tick(2);
      await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledTwice;
    });

    it('re-reads a negative value after the shorter negative TTL', async () => {
      readFeatureFlagStub.resolves(false);
      await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
      clock.tick(NEG_TTL_MS - 1);
      await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledOnce;
      clock.tick(2);
      await isDynamicAllocationActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readFeatureFlagStub).to.have.been.calledTwice;
    });
  });
});
