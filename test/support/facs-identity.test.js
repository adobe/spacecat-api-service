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
import {
  resolveCallerUserIdent,
  resolveCallerImsOrgIdentBare,
  callerHasStateLayerCapability,
} from '../../src/support/facs-identity.js';

const CAP = 'llmo/can_track';
const BRAND = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

// Chainable PostgREST stub mirroring findFacsResourceBinding's query
// (.from().select().eq()xN.is().limit().maybeSingle()). Records the resolved
// filters per call and matches an active row on (subject_type, subject_id).
function makePostgrestStub(bindings, { readError = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = { table };
      const chain = {
        select() { return chain; },
        eq(col, val) {
          filters[col] = val;
          return chain;
        },
        is() { return chain; },
        limit() { return chain; },
        maybeSingle() {
          calls.push(filters);
          if (readError) {
            return Promise.resolve({ data: null, error: { message: 'boom' } });
          }
          const match = bindings.find(
            (b) => b.subject_type === filters.subject_type
              && b.subject_id === filters.subject_id,
          );
          return Promise.resolve({
            data: match ? { id: 'row-1', granted_capabilities: match.granted_capabilities } : null,
            error: null,
          });
        },
      };
      return chain;
    },
  };
}

function makeCtx({ postgrestClient, sub = 'user@AdobeOrg', tenant = 'org-1' } = {}) {
  return {
    dataAccess: { services: { postgrestClient } },
    attributes: {
      authInfo: {
        getProfile: () => ({ sub }),
        getTenantIds: () => (tenant ? [tenant] : []),
      },
    },
  };
}

describe('facs-identity resolvers', () => {
  it('resolveCallerUserIdent returns profile.sub', () => {
    expect(resolveCallerUserIdent(makeCtx({}))).to.equal('user@AdobeOrg');
  });

  it('resolveCallerUserIdent returns null when the profile/sub is absent', () => {
    expect(resolveCallerUserIdent({})).to.equal(null);
    const noSub = { attributes: { authInfo: { getProfile: () => ({}) } } };
    expect(resolveCallerUserIdent(noSub)).to.equal(null);
  });

  it('resolveCallerImsOrgIdentBare returns the first tenant id', () => {
    expect(resolveCallerImsOrgIdentBare(makeCtx({}))).to.equal('org-1');
  });

  it('resolveCallerImsOrgIdentBare returns null when there is no tenant', () => {
    expect(resolveCallerImsOrgIdentBare(makeCtx({ tenant: null }))).to.equal(null);
    expect(resolveCallerImsOrgIdentBare({})).to.equal(null);
  });
});

describe('callerHasStateLayerCapability', () => {
  const opts = { product: 'LLMO', capability: CAP, brandUuid: BRAND };

  it('true on a user-subject grant, keyed correctly', async () => {
    const pg = makePostgrestStub([{
      subject_type: 'user',
      subject_id: 'user@AdobeOrg',
      granted_capabilities: ['llmo/can_view', CAP],
    }]);
    const ctx = makeCtx({ postgrestClient: pg });
    expect(await callerHasStateLayerCapability(ctx, opts)).to.equal(true);
    // Keys match the write path: normalized org, uppercase product, brand resource.
    const userCall = pg.calls.find((c) => c.subject_type === 'user');
    expect(userCall).to.include({
      table: 'facs_access_mappings',
      ims_org_id: 'org-1@AdobeOrg',
      product: 'LLMO',
      subject_id: 'user@AdobeOrg',
      resource_type: 'brand',
      resource_id: BRAND,
    });
  });

  it('true on an org-subject grant (subject_id === normalized imsOrgId)', async () => {
    const pg = makePostgrestStub([{
      subject_type: 'org',
      subject_id: 'org-1@AdobeOrg',
      granted_capabilities: [CAP],
    }]);
    const granted = await callerHasStateLayerCapability(makeCtx({ postgrestClient: pg }), opts);
    expect(granted).to.equal(true);
  });

  it('unions both subject scopes (user + org) in one call', async () => {
    const pg = makePostgrestStub([]);
    await callerHasStateLayerCapability(makeCtx({ postgrestClient: pg }), opts);
    const scopes = pg.calls.map((c) => c.subject_type).sort();
    expect(scopes).to.deep.equal(['org', 'user']);
  });

  it('false when a binding exists but lacks the capability', async () => {
    const pg = makePostgrestStub([{
      subject_type: 'user',
      subject_id: 'user@AdobeOrg',
      granted_capabilities: ['llmo/can_view'],
    }]);
    const granted = await callerHasStateLayerCapability(makeCtx({ postgrestClient: pg }), opts);
    expect(granted).to.equal(false);
  });

  it('false when there is no matching binding', async () => {
    const pg = makePostgrestStub([]);
    const granted = await callerHasStateLayerCapability(makeCtx({ postgrestClient: pg }), opts);
    expect(granted).to.equal(false);
  });

  it('false (no read) when postgrestClient is unavailable', async () => {
    const ctx = makeCtx({ postgrestClient: undefined });
    expect(await callerHasStateLayerCapability(ctx, opts)).to.equal(false);
  });

  it('false when brandUuid is missing', async () => {
    const pg = makePostgrestStub([]);
    expect(await callerHasStateLayerCapability(
      makeCtx({ postgrestClient: pg }),
      { ...opts, brandUuid: undefined },
    )).to.equal(false);
    expect(pg.calls).to.have.lengthOf(0);
  });

  it('false when the caller has no IMS org', async () => {
    const pg = makePostgrestStub([]);
    expect(await callerHasStateLayerCapability(
      makeCtx({ postgrestClient: pg, tenant: null }),
      opts,
    )).to.equal(false);
    expect(pg.calls).to.have.lengthOf(0);
  });

  it('FAIL-CLOSED: a state-layer read error resolves false, never throws', async () => {
    const pg = makePostgrestStub([], { readError: true });
    const logged = [];
    const ctx = { ...makeCtx({ postgrestClient: pg }) };
    const result = await callerHasStateLayerCapability(ctx, {
      ...opts,
      log: { warn: (...a) => logged.push(a) },
    });
    expect(result).to.equal(false);
    expect(logged).to.have.lengthOf(1);
  });
});
