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

/* eslint-env mocha */
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  normalizeLlmoOnboardingMode,
  readBrandalfFlagOverride,
  resolveLlmoOnboardingMode,
} from '../../src/support/llmo-onboarding-mode.js';

use(sinonChai);

describe('llmo-onboarding-mode', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('normalizes invalid values to v1', () => {
    expect(normalizeLlmoOnboardingMode()).to.equal('v1');
    expect(normalizeLlmoOnboardingMode('bogus')).to.equal('v1');
    expect(normalizeLlmoOnboardingMode('v1')).to.equal('v1');
    expect(normalizeLlmoOnboardingMode('v2')).to.equal('v2');
  });

  it('reads the brandalf override from feature_flags', async () => {
    const maybeSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
    const eqFlag = sinon.stub().returns({ maybeSingle });
    const eqProduct = sinon.stub().returns({ eq: eqFlag });
    const eqOrg = sinon.stub().returns({ eq: eqProduct });
    const select = sinon.stub().returns({ eq: eqOrg });
    const postgrestClient = { from: sinon.stub().returns({ select }) };

    const result = await readBrandalfFlagOverride('org-1', postgrestClient);

    expect(result).to.equal(true);
    expect(postgrestClient.from).to.have.been.calledWith('feature_flags');
  });

  it('resolves v2 when brandalf override is true', async () => {
    const maybeSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
    const context = {
      env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
      log: { warn: sinon.stub() },
      dataAccess: {
        services: {
          postgrestClient: {
            from: sinon.stub().returns({
              select: sinon.stub().returns({
                eq: sinon.stub().returns({
                  eq: sinon.stub().returns({
                    eq: sinon.stub().returns({ maybeSingle }),
                  }),
                }),
              }),
            }),
          },
        },
      },
    };

    const mode = await resolveLlmoOnboardingMode('org-1', context);
    expect(mode).to.equal('v2');
  });

  it('falls back to the configured default when no override exists', async () => {
    const maybeSingle = sinon.stub().resolves({ data: null, error: null });
    const context = {
      env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'v2' },
      log: { warn: sinon.stub() },
      dataAccess: {
        services: {
          postgrestClient: {
            from: sinon.stub().returns({
              select: sinon.stub().returns({
                eq: sinon.stub().returns({
                  eq: sinon.stub().returns({
                    eq: sinon.stub().returns({ maybeSingle }),
                  }),
                }),
              }),
            }),
          },
        },
      },
    };

    const mode = await resolveLlmoOnboardingMode('org-1', context);
    expect(mode).to.equal('v2');
  });
});
