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
import sinonChai from 'sinon-chai';
import {
  TEST_DOMAIN,
  TEST_IMS_ORG_ID,
  TEST_SITE_ID,
  DEFAULT_ORG_ID,
  createSharedMocks,
  resetStubDefaults,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let stubs;
  let PlgOnboardingControllerFactory;

  // Mock objects
  let mockLog;
  let mockSiteConfig;
  let mockSite;
  let mockOrganization;
  let mockProject;
  let mockDataAccess;
  let mockOnboarding;
  let ldGetFeatureFlagStub;
  let ldUpdateVariationValueStub;

  function createMockSite(overrides = {}) {
    return createMockSiteShared(sandbox, overrides, mockSiteConfig);
  }

  function createMockOnboarding(overrides = {}) {
    return createMockOnboardingShared(sandbox, overrides);
  }

  function buildContext(data = {}, options = {}) {
    return buildContextShared(sandbox, mockDataAccess, mockLog, stubs.mockEnv, data, options);
  }

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = createSharedMocks(sandbox);
    ({
      mockSiteConfig, mockOrganization, mockProject, mockLog,
    } = stubs);
    PlgOnboardingControllerFactory = await createPlgEsmock(stubs, {
      hasAdminAccess: false,
      hasAdminReadAccess: false,
    });
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();
    resetStubDefaults(stubs);
    ({
      ldGetFeatureFlagStub,
      ldUpdateVariationValueStub,
      mockLog,
      mockSiteConfig,
      mockOrganization,
      mockProject,
    } = stubs);

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  describe('onboard - LaunchDarkly flag update', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('adds org and site to all 3 auto-fix flags in variation 0', async () => {
      ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      const expectedFlags = ['FF_cwv-auto-fix', 'FF_alt-text-auto-fix', 'FF_broken-backlinks-auto-fix'];
      expectedFlags.forEach((flagKey) => {
        expect(ldGetFeatureFlagStub).to.have.been.calledWith('experience-success-studio', flagKey);
      });
      expect(ldUpdateVariationValueStub.callCount).to.equal(3);
      const cwvCall = ldUpdateVariationValueStub.getCalls().find((c) => c.args[1] === 'FF_cwv-auto-fix');
      expect(cwvCall).to.exist;
      expect(cwvCall.args[0]).to.equal('experience-success-studio');
      expect(cwvCall.args[2]).to.equal(0);
      expect(cwvCall.args[3]).to.deep.equal({ [TEST_IMS_ORG_ID]: [TEST_SITE_ID] });
    });

    it('skips duplicate site already present in variation 0', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: { [TEST_IMS_ORG_ID]: [TEST_SITE_ID] } }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('continues onboarding when LD flag update fails', async () => {
      ldGetFeatureFlagStub.rejects(new Error('LD service unavailable'));

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('skips LD update when LD_EXPERIENCE_SUCCESS_API_TOKEN is not set', async () => {
      const context = {
        ...buildContext({ domain: TEST_DOMAIN }),
        env: { DEFAULT_ORGANIZATION_ID: DEFAULT_ORG_ID },
      };
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldGetFeatureFlagStub).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/LD_EXPERIENCE_SUCCESS_API_TOKEN/);
    });

    it('skips LD update when org has no IMS org ID', async () => {
      mockOrganization.getImsOrgId.returns(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('skips LD update when flag has no variations', async () => {
      ldGetFeatureFlagStub.resolves({ variations: [] });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('handles string-wrapped variation 0 value', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: JSON.stringify({}) }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(ldUpdateVariationValueStub.callCount).to.equal(3);
      ldUpdateVariationValueStub.getCalls().forEach((call) => {
        const newValue = call.args[3];
        expect(typeof newValue).to.equal('string');
        expect(JSON.parse(newValue)).to.deep.equal({ [TEST_IMS_ORG_ID]: [TEST_SITE_ID] });
      });
    });

    it('skips flag and warns when variation 0 contains malformed JSON string', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: 'not-valid-json{{{' }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/malformed JSON/);
    });
  });
});
