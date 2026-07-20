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
  TEST_SITE_ID,
  DEMO_ORG_ID,
  createSharedMocks,
  resetStubDefaults,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';
import { PLG_CONFIG_HANDLERS } from '../../../../src/controllers/plg/plg-onboarding/site-setup.js';

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

  describe('onboard - entitlement handling', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('handles entitlement already exists gracefully', async () => {
      stubs.tierClientCreateEntitlementStub.rejects(
        new Error('Entitlement already exists'),
      );

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('falls back to checkValidEntitlement when entitlement creation fails', async () => {
      stubs.tierClientCreateEntitlementStub.rejects(
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
      stubs.tierClientCreateForOrgStub.returns(orgClientStub);

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
      stubs.tierClientCreateForOrgStub.returns(orgClientStub);

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
      stubs.tierClientCreateForOrgStub.returns(orgClientStub);
      mockOnboarding.save.rejects(new Error('db write failed'));

      const res = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(res.status).to.equal(200);
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to persist waitlist state/);
    });
  });

  describe('onboard - previous ASO enrollment revocation for org', () => {
    let controller;

    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
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
      stubs.tierClientCreateEntitlementStub.resolves({
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
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('enrolls site in all PLG config handlers', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      const config = await mockDataAccess.Configuration.findLatest();
      for (const handler of PLG_CONFIG_HANDLERS) {
        expect(config.enableHandlerForSite).to.have.been.calledWith(handler, mockSite);
      }
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
