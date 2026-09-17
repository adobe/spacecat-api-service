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

  // Mock objects
  let mockLog;
  let mockSiteConfig;
  let mockSite;
  let mockOrganization;
  let mockProject;
  let mockDataAccess;
  let mockOnboarding;

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
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();
    resetStubDefaults(stubs);
    ({
      mockSiteConfig, mockOrganization, mockProject, mockLog,
    } = stubs);

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  describe('onboard - admin access', () => {
    let adminController;
    let AdminPlgOnboardingControllerFactory;

    before(async () => {
      AdminPlgOnboardingControllerFactory = await createPlgEsmock(stubs, { hasAdminAccess: true });
    });

    beforeEach(() => {
      adminController = AdminPlgOnboardingControllerFactory({ log: mockLog });
    });

    it('returns 400 when imsOrgId is missing in admin onboard call', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required when onboarding as admin');
    });

    it('returns 400 when imsOrgId is empty string in admin onboard call', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, imsOrgId: '' });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required when onboarding as admin');
    });

    it('onboards successfully when admin provides imsOrgId', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, imsOrgId: TEST_IMS_ORG_ID });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(200);
      expect(stubs.createOrFindOrganizationStub).to.have.been.calledWith(
        TEST_IMS_ORG_ID,
        sinon.match.any,
      );
    });
  });
});
