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
import { BRAND_CACHE_TTL_MS, MAX_ENTRIES } from '../../../src/support/serenity/workspace-resolver.js';

use(sinonChai);

const ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const OTHER_BRAND = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
const STAMP = '2026-08-10T09:00:00Z';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function fakeCtx() {
  return { dataAccess: { services: { postgrestClient: { from: () => ({}) } } } };
}

/**
 * Builds a `readFeatureFlagScopes` result. `org` omitted means the organization
 * has no row at all; `brands` maps brand id to that brand's override value.
 */
function scopes({ org, brands = {} } = {}) {
  return {
    orgRow: org === undefined ? null : { flag_value: org, updated_at: STAMP },
    brandRows: new Map(
      Object.entries(brands).map(([id, value]) => [id, { flag_value: value, updated_at: STAMP }]),
    ),
  };
}

describe('isSerenityActiveForOrg', () => {
  let readScopesStub;
  let isSerenityActiveForOrg;
  let clearSerenityFlagCache;
  let SERENITY_FEATURE_FLAG_PRODUCT;
  let SERENITY_FEATURE_FLAG_NAME;

  beforeEach(async () => {
    readScopesStub = sinon.stub();
    const mod = await esmock('../../../src/support/serenity/serenity-active.js', {
      '../../../src/support/feature-flags-storage.js': {
        readFeatureFlagScopes: readScopesStub,
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

  it('exposes the LLMO/serenity flag identity', () => {
    expect(SERENITY_FEATURE_FLAG_PRODUCT).to.equal('LLMO');
    expect(SERENITY_FEATURE_FLAG_NAME).to.equal('serenity');
  });

  it('returns true when the org row is true and reads it with the right key', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    const active = await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(active).to.equal(true);
    expect(readScopesStub).to.have.been.calledOnce;
    expect(readScopesStub.firstCall.args[0]).to.include({
      organizationId: ORG,
      product: 'LLMO',
      flagName: 'serenity',
    });
  });

  it('returns false when the org row is explicitly false', async () => {
    readScopesStub.resolves(scopes({ org: false }));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('returns false when the org has no row, defaulting OFF', async () => {
    readScopesStub.resolves(scopes());
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('ignores brand overrides — it answers for the organization only', async () => {
    // A wave has activated one brand; the organization itself is still off, and
    // this predicate must keep saying so (brand creation depends on it).
    readScopesStub.resolves(scopes({ brands: { [BRAND]: true } }));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('returns false for a missing/blank organization id without touching the DB', async () => {
    expect(await isSerenityActiveForOrg(fakeCtx(), '', fakeLog())).to.equal(false);
    expect(await isSerenityActiveForOrg(fakeCtx(), undefined, fakeLog())).to.equal(false);
    expect(readScopesStub).to.not.have.been.called;
  });

  it('returns false and warns when the PostgREST client is unavailable', async () => {
    const log = fakeLog();
    const ctx = { dataAccess: { services: {} } };
    expect(await isSerenityActiveForOrg(ctx, ORG, log)).to.equal(false);
    expect(readScopesStub).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('returns false and logs (does not throw) when the flag read fails', async () => {
    const log = fakeLog();
    readScopesStub.rejects(new Error('boom'));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    expect(log.error).to.have.been.calledOnce;
  });

  it('does not require a logger', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG)).to.equal(true);
  });

  it('caches the value within the TTL (one DB read for repeated calls)', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(readScopesStub).to.have.been.calledOnce;
  });

  it('clearSerenityFlagCache forces a re-read', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    clearSerenityFlagCache();
    await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
    expect(readScopesStub).to.have.been.calledTwice;
  });

  it('evicts the oldest entry once the cache exceeds MAX_ENTRIES', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    // Fill past the cap so the oldest entries are evicted (insertion-order LRU).
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await isSerenityActiveForOrg(fakeCtx(), `org-${i}`, fakeLog());
    }
    const callsAfterFill = readScopesStub.callCount;
    // org-0 was evicted, so resolving it again re-reads (a still-cached org would not).
    await isSerenityActiveForOrg(fakeCtx(), 'org-0', fakeLog());
    expect(readScopesStub.callCount).to.equal(callsAfterFill + 1);
  });

  it('does NOT cache a transient read error (re-reads on the next call)', async () => {
    const log = fakeLog();
    readScopesStub.onFirstCall().rejects(new Error('boom'));
    readScopesStub.onSecondCall().resolves(scopes({ org: true }));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, log)).to.equal(true);
    expect(readScopesStub).to.have.been.calledTwice;
  });

  describe('TTL expiry (fake timers)', () => {
    let clock;
    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 1_000_000 });
    });
    afterEach(() => clock.restore());

    it('re-reads only after the short brand TTL elapses', async () => {
      readScopesStub.resolves(scopes({ org: true }));
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      clock.tick(BRAND_CACHE_TTL_MS - 1);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readScopesStub).to.have.been.calledOnce; // still cached
      clock.tick(2);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readScopesStub).to.have.been.calledTwice; // expired → re-read
    });

    it('applies the same TTL to an absent flag, so activation lands within it', async () => {
      readScopesStub.resolves(scopes());
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      clock.tick(BRAND_CACHE_TTL_MS - 1);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readScopesStub).to.have.been.calledOnce; // still cached
      clock.tick(2);
      await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog());
      expect(readScopesStub).to.have.been.calledTwice; // expired → re-read
    });
  });
});

describe('isSerenityActiveForBrand', () => {
  let readScopesStub;
  let isSerenityActiveForBrand;
  let isSerenityActiveForOrg;
  let clearSerenityFlagCache;

  beforeEach(async () => {
    readScopesStub = sinon.stub();
    const mod = await esmock('../../../src/support/serenity/serenity-active.js', {
      '../../../src/support/feature-flags-storage.js': {
        readFeatureFlagScopes: readScopesStub,
      },
    });
    ({
      isSerenityActiveForBrand,
      isSerenityActiveForOrg,
      clearSerenityFlagCache,
    } = mod);
    clearSerenityFlagCache();
  });

  afterEach(() => sinon.restore());

  it('resolves the org row for a brand with no override', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(true);
  });

  it('lets a brand override hold one brand back from an active organization', async () => {
    readScopesStub.resolves(scopes({ org: true, brands: { [BRAND]: false } }));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(false);
    // Its sibling, with no override of its own, still inherits the org's value.
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, OTHER_BRAND, fakeLog())).to.equal(true);
  });

  it('activates a brand while its organization has no row — the migration wave case', async () => {
    readScopesStub.resolves(scopes({ brands: { [BRAND]: true } }));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(true);
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, OTHER_BRAND, fakeLog())).to.equal(false);
  });

  it('activates a brand while its organization is explicitly false', async () => {
    readScopesStub.resolves(scopes({ org: false, brands: { [BRAND]: true } }));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(true);
  });

  it('is off when neither scope says otherwise', async () => {
    readScopesStub.resolves(scopes());
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(false);
  });

  it('is off when both scopes are false', async () => {
    readScopesStub.resolves(scopes({ org: false, brands: { [BRAND]: false } }));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(false);
  });

  it('falls back to the org row when no brand id is given', async () => {
    readScopesStub.resolves(scopes({ org: true, brands: { [BRAND]: false } }));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, undefined, fakeLog())).to.equal(true);
  });

  it('is off (and logs) when the flag read fails', async () => {
    const log = fakeLog();
    readScopesStub.rejects(new Error('boom'));
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, log)).to.equal(false);
    expect(log.error).to.have.been.calledOnce;
  });

  it('is off and warns when the PostgREST client is unavailable', async () => {
    const log = fakeLog();
    const ctx = { dataAccess: { services: {} } };
    expect(await isSerenityActiveForBrand(ctx, ORG, BRAND, log)).to.equal(false);
    expect(log.warn).to.have.been.calledOnce;
  });

  it('serves every brand in an org, and the org itself, from ONE read', async () => {
    // The whole point of caching both scopes together: a request that asks about
    // the org and about several brands cannot see the two views disagree, and
    // pays a single query.
    readScopesStub.resolves(scopes({ org: false, brands: { [BRAND]: true } }));
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, BRAND, fakeLog())).to.equal(true);
    expect(await isSerenityActiveForBrand(fakeCtx(), ORG, OTHER_BRAND, fakeLog())).to.equal(false);
    expect(readScopesStub).to.have.been.calledOnce;
  });
});

describe('isSerenityUiActiveForOrg', () => {
  let readScopesStub;
  let isSerenityActiveForOrg;
  let isSerenityUiActiveForOrg;
  let clearSerenityFlagCache;
  let SERENITY_UI_FEATURE_FLAG_NAME;

  beforeEach(async () => {
    readScopesStub = sinon.stub();
    const mod = await esmock('../../../src/support/serenity/serenity-active.js', {
      '../../../src/support/feature-flags-storage.js': {
        readFeatureFlagScopes: readScopesStub,
      },
    });
    ({
      isSerenityActiveForOrg,
      isSerenityUiActiveForOrg,
      clearSerenityFlagCache,
      SERENITY_UI_FEATURE_FLAG_NAME,
    } = mod);
    clearSerenityFlagCache();
  });

  afterEach(() => sinon.restore());

  it('exposes the org-wide LLMO/serenity_ui flag identity', () => {
    expect(SERENITY_UI_FEATURE_FLAG_NAME).to.equal('serenity_ui');
  });

  it('returns true when the flag is true and reads it with the right key', async () => {
    readScopesStub.resolves(scopes({ org: true }));
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(true);
    expect(readScopesStub.firstCall.args[0]).to.include({
      organizationId: ORG,
      product: 'LLMO',
      flagName: 'serenity_ui',
    });
  });

  it('defaults OFF for an absent row, a false row, a blank org and a read error', async () => {
    const log = fakeLog();
    readScopesStub.resolves(scopes());
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    clearSerenityFlagCache();
    readScopesStub.resolves(scopes({ org: false }));
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
    expect(await isSerenityUiActiveForOrg(fakeCtx(), '', log)).to.equal(false);
    clearSerenityFlagCache();
    readScopesStub.rejects(new Error('boom'));
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, log)).to.equal(false);
  });

  it('stays org-wide: a brand override never turns it on', async () => {
    // serenity_ui describes whether the org's USERS are provisioned in Semrush,
    // which no single brand can differ on.
    readScopesStub.resolves(scopes({ brands: { [BRAND]: true } }));
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
  });

  it('returns false and warns when the PostgREST client is unavailable', async () => {
    const log = fakeLog();
    expect(await isSerenityUiActiveForOrg({ dataAccess: { services: {} } }, ORG, log))
      .to.equal(false);
    expect(readScopesStub).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('caches per flag, so one flag never reads the other cached value', async () => {
    // Same org, different flag: the composite cache key must keep them apart —
    // otherwise an org that is serenity-active would read as serenity_ui too.
    readScopesStub.withArgs(sinon.match({ flagName: 'serenity' }))
      .resolves(scopes({ org: true }));
    readScopesStub.withArgs(sinon.match({ flagName: 'serenity_ui' }))
      .resolves(scopes({ org: false }));

    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(true);
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
    expect(readScopesStub).to.have.been.calledTwice;

    // Both are now cached independently — no further reads, same answers.
    expect(await isSerenityActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(true);
    expect(await isSerenityUiActiveForOrg(fakeCtx(), ORG, fakeLog())).to.equal(false);
    expect(readScopesStub).to.have.been.calledTwice;
  });
});
