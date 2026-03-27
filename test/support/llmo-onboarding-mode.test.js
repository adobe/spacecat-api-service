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

  it('returns null when brandalf override cannot be queried', async () => {
    expect(await readBrandalfFlagOverride()).to.equal(null);
    expect(await readBrandalfFlagOverride('org-1', {})).to.equal(null);
  });

  it('returns null when the feature flag value is not a boolean', async () => {
    const maybeSingle = sinon.stub().resolves({ data: { flag_value: 'true' }, error: null });
    const eqFlag = sinon.stub().returns({ maybeSingle });
    const eqProduct = sinon.stub().returns({ eq: eqFlag });
    const eqOrg = sinon.stub().returns({ eq: eqProduct });
    const select = sinon.stub().returns({ eq: eqOrg });
    const postgrestClient = { from: sinon.stub().returns({ select }) };

    const result = await readBrandalfFlagOverride('org-1', postgrestClient);

    expect(result).to.equal(null);
  });

  it('throws when reading the brandalf override fails', async () => {
    const maybeSingle = sinon.stub().resolves({ data: null, error: { message: 'boom' } });
    const eqFlag = sinon.stub().returns({ maybeSingle });
    const eqProduct = sinon.stub().returns({ eq: eqFlag });
    const eqOrg = sinon.stub().returns({ eq: eqProduct });
    const select = sinon.stub().returns({ eq: eqOrg });
    const postgrestClient = { from: sinon.stub().returns({ select }) };

    try {
      await readBrandalfFlagOverride('org-1', postgrestClient);
      expect.fail('Expected readBrandalfFlagOverride to throw');
    } catch (error) {
      expect(error.message).to.equal('Failed to read feature flag brandalf: boom');
    }
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

  it('resolves v1 when brandalf override is false', async () => {
    const maybeSingle = sinon.stub().resolves({ data: { flag_value: false }, error: null });
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
    expect(mode).to.equal('v1');
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

  it('warns and falls back to v1 when the configured default is invalid', async () => {
    const context = {
      env: { LLMO_ONBOARDING_DEFAULT_VERSION: 'bogus' },
      log: { warn: sinon.stub() },
    };

    const mode = await resolveLlmoOnboardingMode('org-1', context);

    expect(mode).to.equal('v1');
    expect(context.log.warn).to.have.been.calledWith(
      'Invalid LLMO_ONBOARDING_DEFAULT_VERSION "bogus", falling back to v1',
    );
  });

  it('falls back to v1 when no context is provided', async () => {
    const mode = await resolveLlmoOnboardingMode('org-1');
    expect(mode).to.equal('v1');
  });

  it('warns and falls back to the default when flag resolution fails', async () => {
    const maybeSingle = sinon.stub().resolves({ data: null, error: { message: 'boom' } });
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
    expect(context.log.warn).to.have.been.calledWith(
      'Failed to resolve brandalf feature flag for organization org-1: Failed to read feature flag brandalf: boom',
    );
  });
});
