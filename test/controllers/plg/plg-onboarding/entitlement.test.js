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
  TEST_SITE_ID,
  DEMO_ORG_ID,
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
  let tierClientCreateEntitlementStub;
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
      ldCreateFromStub,
      tierClientCreateEntitlementStub,
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

  describe('onboard - entitlement handling', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('handles entitlement already exists gracefully', async () => {
      tierClientCreateEntitlementStub.rejects(
        new Error('Entitlement already exists'),
      );

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('falls back to checkValidEntitlement when entitlement creation fails', async () => {
      tierClientCreateEntitlementStub.rejects(
        new Error('Tier service unavailable'),
      );

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('waitlists when both createEntitlement and checkValidEntitlement fail', async () => {
      const orgClientStub = {
        createEntitlement: sandbox.stub().rejects(new Error('service down')),
        checkValidEntitlement: sandbox.stub().rejects(new Error('service down')),
      };
      tierClientCreateForOrgStub.returns(orgClientStub);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/Unable to create or fetch ASO entitlement/);
      expect(mockOnboarding.setSteps).to.have.been.calledWithMatch({ entitlementFailed: true });
      expect(mockLog.error).to.have.been.calledWithMatch(/createEntitlement failed/);
    });

    it('waitlists when tier service returns entitlement for wrong org', async () => {
      const orgClientStub = {
        createEntitlement: sandbox.stub().resolves({
          entitlement: {
            getId: () => 'ent-drift',
            getOrganizationId: () => 'different-org-id',
          },
        }),
        checkValidEntitlement: sandbox.stub(),
      };
      tierClientCreateForOrgStub.returns(orgClientStub);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/entitlement org drift/);
      expect(mockOnboarding.setSteps).to.have.been.calledWithMatch({ entitlementFailed: true });
    });

    it('waitlists when enrollment creation and fetch both fail', async () => {
      mockDataAccess.SiteEnrollment.allBySiteId.rejects(new Error('enrollment down'));

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/Unable to create or fetch ASO enrollment/);
      expect(mockOnboarding.setSteps).to.have.been.calledWithMatch({ entitlementFailed: true });
    });

    it('reuses an existing site enrollment when one already matches the entitlement', async () => {
      const existingEnrollment = { getId: () => 'enroll-existing', getEntitlementId: () => 'ent-1' };
      mockDataAccess.SiteEnrollment.allBySiteId.resolves([existingEnrollment]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.SiteEnrollment.create).not.to.have.been.called;
    });

    it('logs error when persisting entitlement waitlist state fails in full onboarding', async () => {
      const orgClientStub = {
        createEntitlement: sandbox.stub().rejects(new Error('service down')),
        checkValidEntitlement: sandbox.stub().rejects(new Error('service down')),
      };
      tierClientCreateForOrgStub.returns(orgClientStub);
      mockOnboarding.save.rejects(new Error('db write failed'));

      const res = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(res.status).to.equal(200);
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to persist waitlist state/);
    });
  });

  describe('onboard - previous ASO enrollment revocation for org', () => {
    let controller;

    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    function buildSiblingEnrollment(id, siteId) {
      return {
        getId: sandbox.stub().returns(id),
        getSiteId: sandbox.stub().returns(siteId),
        remove: sandbox.stub().resolves(),
      };
    }

    it('revokes every ASO enrollment under the entitlement except the new site\'s', async () => {
      const newSiteEnrollment = buildSiblingEnrollment('enroll-new', TEST_SITE_ID);
      const sibling1 = buildSiblingEnrollment('enroll-sib-1', 'prev-site-1');
      const sibling2 = buildSiblingEnrollment('enroll-sib-2', 'prev-site-2');
      mockDataAccess.SiteEnrollment.allByEntitlementId
        .resolves([newSiteEnrollment, sibling1, sibling2]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(newSiteEnrollment.remove).to.not.have.been.called;
      expect(sibling1.remove).to.have.been.called;
      expect(sibling2.remove).to.have.been.called;
    });

    it('waitlists when entitlement.organizationId disagrees with resolved customer org', async () => {
      const sibling = buildSiblingEnrollment('enroll-sib', 'prev-site-1');
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([sibling]);

      // Drift: entitlement belongs to a different org than the one resolved from imsOrgId.
      tierClientCreateEntitlementStub.resolves({
        entitlement: { getId: () => 'ent-drift', getOrganizationId: () => 'drifted-org' },
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/entitlement org drift/);
      expect(mockOnboarding.setSteps).to.have.been.calledWithMatch({ entitlementFailed: true });
      // Enrollment was never created so there is nothing to revoke
      expect(sibling.remove).to.not.have.been.called;
    });

    it('refuses revocation when the resolved customer org is internal/demo', async () => {
      mockOrganization.getId.returns(DEMO_ORG_ID);
      const sibling = buildSiblingEnrollment('enroll-sib', 'prev-site-1');
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([sibling]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(400);
      expect(res.value).to.include('internal organizations');
      expect(sibling.remove).to.not.have.been.called;
    });

    it('continues past individual remove failures', async () => {
      const sibling1 = buildSiblingEnrollment('enroll-sib-1', 'prev-site-1');
      const sibling2 = buildSiblingEnrollment('enroll-sib-2', 'prev-site-2');
      sibling1.remove.rejects(new Error('transient failure'));
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([sibling1, sibling2]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(sibling2.remove).to.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to revoke ASO enrollment/);
    });

    it('no-op when the entitlement has no sibling enrollments', async () => {
      const onlyNew = buildSiblingEnrollment('enroll-new', TEST_SITE_ID);
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([onlyNew]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onlyNew.remove).to.not.have.been.called;
    });

    it('warns when more than 3 sibling enrollments are revoked', async () => {
      const siblings = Array.from({ length: 4 }, (_, i) => (
        buildSiblingEnrollment(`enroll-sib-${i}`, `prev-site-${i}`)
      ));
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves(siblings);

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(mockLog.warn).to.have.been.calledWithMatch(/Found 4 other ASO enrollments/);
    });
  });

  describe('onboard - summit-plg config enrollment', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('enrolls site in summit-plg config handler', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      const config = await mockDataAccess.Configuration.findLatest();
      expect(config.enableHandlerForSite).to.have.been.calledWith('summit-plg', mockSite);
    });

    it('continues onboarding when summit-plg enrollment fails', async () => {
      mockDataAccess.Configuration.findLatest.resolves({
        enableHandlerForSite: sandbox.stub().throws(new Error('Config write failed')),
        save: sandbox.stub().resolves(),
        getQueues: sandbox.stub().returns({ audits: 'audit-queue-url' }),
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to enroll site in config handlers/);
    });
  });
});
