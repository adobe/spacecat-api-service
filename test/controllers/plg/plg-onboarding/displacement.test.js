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
  TEST_ORG_ID,
  TEST_SITE_ID,
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
      mockSiteConfig, mockOrganization, mockProject, mockLog,
    } = stubs);

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  describe('onboard - preonboarding fast path', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('fast-tracks preonboarded site: adds enrollment and sets ONBOARDED', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        steps: { orgResolved: true, siteResolved: true, configUpdated: true },
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);
      mockDataAccess.Site.findById.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.called;
      expect(stubs.triggerAuditsStub).to.not.have.been.called;
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(preonboardedOnboarding.setCompletedAt).to.have.been.called;
      expect(preonboardedOnboarding.setSteps).to.have.been.calledWith(
        sinon.match({
          orgResolved: true,
          siteResolved: true,
          configUpdated: true,
          preOnboarded: true,
        }),
      );
      expect(preonboardedOnboarding.setSteps).to.have.been.calledWith(
        sinon.match({
          orgResolved: true,
          siteResolved: true,
          configUpdated: true,
          entitlementCreated: true,
        }),
      );
      // Fast path walks entitlement siblings to enforce one-enrollment-per-org.
      expect(mockDataAccess.SiteEnrollment.allByEntitlementId).to.have.been.called;
      expect(stubs.ldGetFeatureFlagStub).to.have.been.called;
      // Organization must be resolved in fast path now
      expect(stubs.createOrFindOrganizationStub).to.have.been.called;
      // PlgOnboarding's organizationId is anchored to the resolved customer org up-front.
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      // Should NOT run other full onboarding steps
      expect(stubs.detectBotBlockerStub).to.not.have.been.called;
    });

    it('fast-tracks preonboarded site with null steps', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        steps: null,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);
      mockDataAccess.Site.findById.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(preonboardedOnboarding.setSteps).to.have.been.calledWith({ preOnboarded: true });
      expect(preonboardedOnboarding.setSteps).to.have.been.calledWith({ entitlementCreated: true });
      // Config handlers enrolled, no audit trigger
      const config = await mockDataAccess.Configuration.findLatest();
      expect(config.enableHandlerForSite).to.have.been.calledWith('summit-plg', mockSite);
      expect(stubs.triggerAuditsStub).to.not.have.been.called;
    });

    it('falls through to full onboarding when preonboarded site not found', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: 'missing-site-id',
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);
      mockDataAccess.Site.findById.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      // Falls through to full onboarding which succeeds
      expect(response.status).to.equal(200);
      expect(stubs.createOrFindOrganizationStub).to.have.been.called;
    });

    it('falls through to full onboarding when PRE_ONBOARDING but no siteId', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: null,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      // Falls through to full onboarding
      expect(response.status).to.equal(200);
      expect(stubs.createOrFindOrganizationStub).to.have.been.called;
    });

    it('reassigns preonboarded site from internal org to customer org', async () => {
      const INTERNAL_ORG_ID = 'internal-org-123';

      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: INTERNAL_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const siteInInternalOrg = createMockSite({ id: TEST_SITE_ID, orgId: INTERNAL_ORG_ID });
      const refreshedSite = createMockSite({ id: TEST_SITE_ID, orgId: TEST_ORG_ID });
      // first call: demo-site check; second call: initial fetch for fast-track;
      // third call: re-fetch after reassignment
      mockDataAccess.Site.findById.onFirstCall().resolves(siteInInternalOrg)
        .onSecondCall().resolves(siteInInternalOrg)
        .onThirdCall()
        .resolves(refreshedSite);

      stubs.mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      stubs.mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(stubs.createOrFindOrganizationStub).to.have.been.called;
      expect(siteInInternalOrg.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(siteInInternalOrg.save).to.have.been.called;
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      // Verify order: site org reassignment happens BEFORE enrollment creation
      const { create: enrollCreate } = mockDataAccess.SiteEnrollment;
      expect(siteInInternalOrg.save).to.have.been.calledBefore(enrollCreate);
      // Enrollment is bound directly to the entitlement ID — org is not re-derived from site
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.calledWith(
        sinon.match({ entitlementId: 'ent-1' }),
      );
    });

    it('does not reassign when preonboarded site already in customer org', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: TEST_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const siteInCustomerOrg = createMockSite({ id: TEST_SITE_ID, orgId: TEST_ORG_ID });
      mockDataAccess.Site.findById.resolves(siteInCustomerOrg);

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(stubs.createOrFindOrganizationStub).to.have.been.called;
      // Site org should NOT be changed (already in customer org)
      expect(siteInCustomerOrg.setOrganizationId).to.not.have.been.called;
      // PlgOnboarding org is anchored to the resolved customer org regardless of
      // whether the site itself needed reassignment.
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('rejects PRE_ONBOARDING for internal org demo sites', async () => {
      const INTERNAL_ORG_ID = 'internal-org-123';
      const DEMO_SITE_ID = 'demo-site-456';

      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: DEMO_SITE_ID,
        organizationId: INTERNAL_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const demoSite = createMockSite({ id: DEMO_SITE_ID, orgId: INTERNAL_ORG_ID });
      mockDataAccess.Site.findById.resolves(demoSite);

      stubs.mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      stubs.mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = DEMO_SITE_ID;

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('REJECTED');
      expect(demoSite.setOrganizationId).to.not.have.been.called;
    });

    it('waitlists when preonboarded site is in different customer org', async () => {
      const OTHER_CUSTOMER_ORG = 'other-customer-org-789';

      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: OTHER_CUSTOMER_ORG,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const siteInOtherOrg = createMockSite({ id: TEST_SITE_ID, orgId: OTHER_CUSTOMER_ORG });
      mockDataAccess.Site.findById.resolves(siteInOtherOrg);

      stubs.mockEnv.ASO_PLG_EXCLUDED_ORGS = 'some-internal-org';
      stubs.mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      // Should be WAITLISTED, not ONBOARDED
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(preonboardedOnboarding.setWaitlistReason).to.have.been.calledWithMatch(
        /already assigned to another organization/,
      );
      // Site should NOT be changed
      expect(siteInOtherOrg.setOrganizationId).to.not.have.been.called;
      // PlgOnboarding org is anchored to the requesting customer's resolved org up-front,
      // even when we then waitlist — the record is the trace of the request attempt.
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      // Should NOT create entitlement or enrollment
      expect(stubs.tierClientCreateForOrgStub).to.not.have.been.called;
      expect(mockDataAccess.SiteEnrollment.create).to.not.have.been.called;
    });

    it('waitlists with "safely moved" hint when preonboarded site in different org has no enrollments', async () => {
      const OTHER_CUSTOMER_ORG = 'other-customer-org-789';
      const existingOrg = {
        getImsOrgId: sandbox.stub().returns('existing-ims@AdobeOrg'),
        getName: sandbox.stub().returns('Existing Org Name'),
      };

      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: OTHER_CUSTOMER_ORG,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const siteInOtherOrg = createMockSite({
        id: TEST_SITE_ID,
        orgId: OTHER_CUSTOMER_ORG,
        siteEnrollments: [],
      });
      mockDataAccess.Site.findById.resolves(siteInOtherOrg);
      mockDataAccess.Organization.findById.resolves(existingOrg);

      stubs.mockEnv.ASO_PLG_EXCLUDED_ORGS = 'some-internal-org';
      stubs.mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(preonboardedOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/no active products in its existing org/);
      expect(preonboardedOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/safely moved to 'Test Org'/);
    });

    it('waitlists with "cannot be moved" message when preonboarded site in different org has active enrollments', async () => {
      const OTHER_CUSTOMER_ORG = 'other-customer-org-789';
      const existingOrg = {
        getImsOrgId: sandbox.stub().returns('existing-ims@AdobeOrg'),
        getName: sandbox.stub().returns('Existing Org Name'),
      };

      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: OTHER_CUSTOMER_ORG,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .resolves(preonboardedOnboarding);

      const siteInOtherOrg = createMockSite({
        id: TEST_SITE_ID,
        orgId: OTHER_CUSTOMER_ORG,
        siteEnrollments: [{ getId: () => 'enroll-1' }],
      });
      mockDataAccess.Site.findById.resolves(siteInOtherOrg);
      mockDataAccess.Organization.findById.resolves(existingOrg);

      stubs.mockEnv.ASO_PLG_EXCLUDED_ORGS = 'some-internal-org';
      stubs.mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(preonboardedOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/cannot be moved.*active products/);
    });

    it('waitlists fast-track when both entitlement create and fetch fail', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: TEST_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(preonboardedOnboarding);
      const mockSiteInOrg = createMockSite({ id: TEST_SITE_ID, orgId: TEST_ORG_ID });
      mockDataAccess.Site.findById.resolves(mockSiteInOrg);

      const orgClientStub = {
        createEntitlement: sandbox.stub().rejects(new Error('service down')),
        checkValidEntitlement: sandbox.stub().rejects(new Error('service down')),
      };
      stubs.tierClientCreateForOrgStub.returns(orgClientStub);

      const response = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(response.status).to.equal(200);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(preonboardedOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/Unable to create or fetch ASO entitlement/);
      expect(preonboardedOnboarding.setSteps)
        .to.have.been.calledWithMatch({ entitlementFailed: true });
    });

    it('logs error when persisting entitlement waitlist state fails in fast-track', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: TEST_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(preonboardedOnboarding);
      const mockSiteInOrg = createMockSite({ id: TEST_SITE_ID, orgId: TEST_ORG_ID });
      mockDataAccess.Site.findById.resolves(mockSiteInOrg);
      preonboardedOnboarding.save.rejects(new Error('db write failed'));

      const orgClientStub = {
        createEntitlement: sandbox.stub().rejects(new Error('service down')),
        checkValidEntitlement: sandbox.stub().rejects(new Error('service down')),
      };
      stubs.tierClientCreateForOrgStub.returns(orgClientStub);

      const response = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(response.status).to.equal(200);
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to persist waitlist state/);
    });

    it('rethrows non-entitlement errors from fast-track', async () => {
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: TEST_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(preonboardedOnboarding);
      const mockSiteInOrg = createMockSite({ id: TEST_SITE_ID, orgId: TEST_ORG_ID });
      mockDataAccess.Site.findById.resolves(mockSiteInOrg);
      // Not an EntitlementWaitlistError — revocation throws unexpectedly → should 500.
      mockDataAccess.SiteEnrollment.allByEntitlementId.rejects(new Error('db error'));

      const response = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(response.status).to.equal(500);
    });

    it('reassigns site from internal org before entitlement in full onboarding path', async () => {
      const INTERNAL_ORG_ID = 'internal-org-999';

      // Simulate full onboarding (not PRE_ONBOARDING)
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);

      // Existing site in internal org
      const existingSite = createMockSite({ id: TEST_SITE_ID, orgId: INTERNAL_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      const refreshedSiteFullPath = createMockSite({ id: TEST_SITE_ID, orgId: TEST_ORG_ID });
      mockDataAccess.Site.findById.resolves(refreshedSiteFullPath);

      stubs.mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      stubs.mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      // Verify site was reassigned
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(existingSite.save).to.have.been.called;
      // Verify order: site org reassignment happens BEFORE enrollment creation
      expect(existingSite.save).to.have.been.calledBefore(mockDataAccess.SiteEnrollment.create);
      // Enrollment is bound directly to the entitlement ID — org is not re-derived from site
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.calledWith(
        sinon.match({ entitlementId: 'ent-1' }),
      );
    });
  });
});
