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
import esmock from 'esmock';
import {
  PLG_MODEL_DOMAIN_HELPERS,
  TEST_DOMAIN,
  TEST_ORG_ID,
  TEST_SITE_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let PlgOnboardingController;

  // Stubs for external dependencies
  let rumRetrieveDomainkeyStub;
  let composeBaseURLStub;
  let detectBotBlockerStub;
  let detectLocaleStub;
  let resolveCanonicalUrlStub;
  let createOrFindOrganizationStub;
  let enableAuditsStub;
  let enableImportsStub;
  let triggerAuditsStub;
  let autoResolveAuthorUrlStub;
  let resolveWwwUrlStub;
  let updateCodeConfigStub;
  let findDeliveryTypeStub;
  let deriveProjectNameStub;
  let loadProfileConfigStub;
  let queueDeliveryConfigWriterStub;
  let triggerBrandProfileAgentStub;
  let tierClientCreateForSiteStub;
  let tierClientCreateForOrgStub;
  let ldGetFeatureFlagStub;
  let ldCreateFromStub;
  let configToDynamoItemStub;
  let updateRumConfigStub;

  // Mock objects
  let mockLog;
  let mockEnv;
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
    return buildContextShared(sandbox, mockDataAccess, mockLog, mockEnv, data, options);
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    const shared = createSharedMocks(sandbox);
    ({
      rumRetrieveDomainkeyStub,
      updateRumConfigStub,
      composeBaseURLStub,
      detectBotBlockerStub,
      detectLocaleStub,
      resolveCanonicalUrlStub,
      createOrFindOrganizationStub,
      enableAuditsStub,
      enableImportsStub,
      triggerAuditsStub,
      autoResolveAuthorUrlStub,
      resolveWwwUrlStub,
      updateCodeConfigStub,
      findDeliveryTypeStub,
      deriveProjectNameStub,
      queueDeliveryConfigWriterStub,
      loadProfileConfigStub,
      triggerBrandProfileAgentStub,
      ldGetFeatureFlagStub,
      ldCreateFromStub,
      tierClientCreateForSiteStub,
      tierClientCreateForOrgStub,
      configToDynamoItemStub,
      mockLog,
      mockEnv,
      mockSiteConfig,
      mockOrganization,
      mockProject,
    } = shared);

    // Default mock site (for new site flow: findByBaseURL returns null)
    mockSite = createMockSite();

    // PlgOnboarding mock
    mockOnboarding = createMockOnboarding();

    // DataAccess
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });

    PlgOnboardingController = (await esmock(
      '../../../../src/controllers/plg/plg-onboarding.js',
      {
        '@adobe/spacecat-shared-utils': {
          composeBaseURL: composeBaseURLStub,
          detectBotBlocker: detectBotBlockerStub,
          detectLocale: detectLocaleStub,
          hasText: (val) => typeof val === 'string' && val.trim().length > 0,
          isValidIMSOrgId: (val) => typeof val === 'string' && val.endsWith('@AdobeOrg'),
          resolveCanonicalUrl: resolveCanonicalUrlStub,
        },
        '@adobe/spacecat-shared-http-utils': {
          badRequest: (msg) => ({ status: 400, value: msg }),
          createResponse: (body, status) => ({ status, value: body }),
          forbidden: (msg) => ({ status: 403, value: msg }),
          internalServerError: (msg) => ({ status: 500, value: msg }),
          notFound: (msg) => ({ status: 404, value: msg }),
          ok: (data) => ({ status: 200, value: data }),
        },
        '@adobe/spacecat-shared-launchdarkly-client': {
          default: ldCreateFromStub,
        },
        '@adobe/spacecat-shared-rum-api-client': {
          default: {
            createFrom: sandbox.stub().returns({
              retrieveDomainkey: rumRetrieveDomainkeyStub,
            }),
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: {
            createForSite: tierClientCreateForSiteStub,
            createForOrg: tierClientCreateForOrgStub,
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: configToDynamoItemStub },
        },
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { ASO: ASO_PRODUCT_CODE },
            TIERS: {
              FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD',
            },
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js': {
          default: {
            ...PLG_MODEL_DOMAIN_HELPERS,
            STATUSES: {
              IN_PROGRESS: 'IN_PROGRESS',
              ONBOARDED: 'ONBOARDED',
              PRE_ONBOARDING: 'PRE_ONBOARDING',
              ERROR: 'ERROR',
              WAITING_FOR_IP_ALLOWLISTING: 'WAITING_FOR_IP_ALLOWLISTING',
              WAITLISTED: 'WAITLISTED',
              INACTIVE: 'INACTIVE',
              REJECTED: 'REJECTED',
              OUTDATED: 'OUTDATED',
            },
            REVIEW_REASONS: {
              DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
              AEM_SITE_CHECK: 'AEM_SITE_CHECK',
              DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
              BOT_BLOCKER: 'BOT_BLOCKER',
            },
            REVIEW_DECISIONS: {
              BYPASSED: 'BYPASSED',
              UPHELD: 'UPHELD',
              CLOSED: 'CLOSED',
              REOPENED: 'REOPENED',
              OFFBOARDED: 'OFFBOARDED',
              PENDING: 'PENDING',
            },
          },
        },
        '../../../../src/controllers/llmo/llmo-onboarding.js': {
          createOrFindOrganization: createOrFindOrganizationStub,
          enableAudits: enableAuditsStub,
          enableImports: enableImportsStub,
          triggerAudits: triggerAuditsStub,
        },
        '../../../../src/support/utils.js': {
          autoResolveAuthorUrl: autoResolveAuthorUrlStub,
          resolveWwwUrl: resolveWwwUrlStub,
          updateCodeConfig: updateCodeConfigStub,
          findDeliveryType: findDeliveryTypeStub,
          deriveProjectName: deriveProjectNameStub,
          queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
        },
        '../../../../src/utils/slack/base.js': {
          loadProfileConfig: loadProfileConfigStub,
        },
        '../../../../src/support/brand-profile-trigger.js': {
          triggerBrandProfileAgent: triggerBrandProfileAgentStub,
        },
        '../../../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({ hasAdminAccess: () => false, hasAdminReadAccess: () => false }),
          },
        },
        '../../../../src/support/rum-config-service.js': {
          updateRumConfig: updateRumConfigStub,
        },
      },
    )).default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('onboard - preonboarding fast path', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
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
      expect(triggerAuditsStub).to.not.have.been.called;
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
      expect(ldGetFeatureFlagStub).to.have.been.called;
      // Organization must be resolved in fast path now
      expect(createOrFindOrganizationStub).to.have.been.called;
      // PlgOnboarding's organizationId is anchored to the resolved customer org up-front.
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      // Should NOT run other full onboarding steps
      expect(detectBotBlockerStub).to.not.have.been.called;
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
      expect(createOrFindOrganizationStub).to.have.been.called;
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
      expect(createOrFindOrganizationStub).to.have.been.called;
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
      // first call: initial fetch for fast-track; second call: re-fetch after reassignment
      mockDataAccess.Site.findById.onFirstCall().resolves(siteInInternalOrg)
        .onSecondCall().resolves(refreshedSite);

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      expect(createOrFindOrganizationStub).to.have.been.called;
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
      expect(createOrFindOrganizationStub).to.have.been.called;
      // Site org should NOT be changed (already in customer org)
      expect(siteInCustomerOrg.setOrganizationId).to.not.have.been.called;
      // PlgOnboarding org is anchored to the resolved customer org regardless of
      // whether the site itself needed reassignment.
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('skips reassignment for internal org demo sites', async () => {
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

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = DEMO_SITE_ID;

      const context = buildContext({ domain: TEST_DOMAIN });
      const response = await controller.onboard(context);

      expect(response.status).to.equal(200);
      // Demo site should NOT be reassigned (stays in internal org)
      expect(demoSite.setOrganizationId).to.not.have.been.called;
      // PlgOnboarding org is still anchored to the resolved customer org.
      expect(preonboardedOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
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

      mockEnv.ASO_PLG_EXCLUDED_ORGS = 'some-internal-org';
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

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
      expect(tierClientCreateForOrgStub).to.not.have.been.called;
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

      mockEnv.ASO_PLG_EXCLUDED_ORGS = 'some-internal-org';
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

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

      mockEnv.ASO_PLG_EXCLUDED_ORGS = 'some-internal-org';
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

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
      tierClientCreateForOrgStub.returns(orgClientStub);

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
      tierClientCreateForOrgStub.returns(orgClientStub);

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

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

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
