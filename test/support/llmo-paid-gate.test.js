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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);

describe('hasPaidLlmoEntitlement', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
  });

  // Loads the helper with TierClient + the Entitlement model mocked, so the real
  // (network-touching) tier-client never runs.
  async function load(entitlement) {
    const checkValidEntitlement = sandbox.stub().resolves({ entitlement });
    const createForOrg = sandbox.stub().returns({ checkValidEntitlement });
    const mod = await esmock('../../src/support/llmo-paid-gate.js', {
      '@adobe/spacecat-shared-tier-client': { default: { createForOrg } },
      '@adobe/spacecat-shared-data-access': {
        Entitlement: { PRODUCT_CODES: { LLMO: 'LLMO' }, TIERS: { PAID: 'PAID' } },
      },
    });
    return { hasPaidLlmoEntitlement: mod.hasPaidLlmoEntitlement, createForOrg };
  }

  it('returns true for a PAID LLMO entitlement', async () => {
    const { hasPaidLlmoEntitlement, createForOrg } = await load({ getTier: () => 'PAID' });

    const result = await hasPaidLlmoEntitlement({ env: {} }, { getId: () => 'org-1' });

    expect(result).to.equal(true);
    expect(createForOrg.calledOnce).to.equal(true);
    // Called with the LLMO product code.
    expect(createForOrg.firstCall.args[2]).to.equal('LLMO');
  });

  it('returns false for a non-PAID (e.g. FREE_TRIAL) entitlement', async () => {
    const { hasPaidLlmoEntitlement } = await load({ getTier: () => 'FREE_TRIAL' });

    expect(await hasPaidLlmoEntitlement({}, {})).to.equal(false);
  });

  it('returns false when there is no entitlement', async () => {
    const { hasPaidLlmoEntitlement } = await load(null);

    expect(await hasPaidLlmoEntitlement({}, {})).to.equal(false);
  });
});
