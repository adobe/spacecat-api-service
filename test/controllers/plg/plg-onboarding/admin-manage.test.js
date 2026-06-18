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
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  TEST_SITE_ID,
  TEST_ONBOARDING_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController - transitionStatus and admin management', function () {
  this.timeout(10000);

  let sandbox;
  let stubs;
  let AdminAccessPlgController;
  let PlgOnboardingController;
  let mockSiteConfig;
  let mockOrganization;
  let mockProject;
  let mockLog;
  let mockSite;
  let mockOnboarding;
  let mockDataAccess;

  function createMockSite(overrides = {}) {
    return createMockSiteShared(sandbox, overrides, mockSiteConfig);
  }
  function createMockOnboarding(overrides = {}) {
    return createMockOnboardingShared(sandbox, overrides);
  }

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = { ...createSharedMocks(sandbox), sandbox };
    ({
      mockSiteConfig, mockOrganization, mockProject, mockLog,
    } = stubs);

    [AdminAccessPlgController, PlgOnboardingController] = await Promise.all([
      createPlgEsmock(stubs, { hasAdminAccess: true }),
      createPlgEsmock(stubs, { hasAdminAccess: false }),
    ]);
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();
    // Re-apply stub defaults after reset
    stubs.composeBaseURLStub.returns('https://example.com');
    stubs.resolveWwwUrlStub.resolves(TEST_DOMAIN);
    stubs.loadProfileConfigStub.returns({});
    stubs.ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });
    stubs.ldCreateFromStub.returns({
      getFeatureFlag: stubs.ldGetFeatureFlagStub,
      updateVariationValue: stubs.ldUpdateVariationValueStub,
    });
    stubs.rumRetrieveDomainkeyStub.resolves('test-domainkey');
    stubs.rumApiClientCreateFromStub.returns({ retrieveDomainkey: stubs.rumRetrieveDomainkeyStub });
    stubs.detectBotBlockerStub.resolves({ crawlable: true });
    stubs.findDeliveryTypeStub.resolves('aem_edge');
    stubs.deriveProjectNameStub.returns('example.com');
    stubs.queueDeliveryConfigWriterStub.resolves({ ok: true });
    stubs.triggerBrandProfileAgentStub.resolves('exec-123');
    stubs.createOrFindOrganizationStub.resolves(mockOrganization);
    // Re-apply mockOrganization stub defaults (reset clears these too)
    mockOrganization.getId.returns(TEST_ORG_ID);
    mockOrganization.getImsOrgId.returns(TEST_IMS_ORG_ID);
    mockOrganization.getName.returns('Test Org');
    // Re-apply mockProject stub defaults
    mockProject.getId.returns(TEST_PROJECT_ID);
    mockProject.getProjectName.returns('example.com');
    stubs.tierClientCreateEntitlementStub.resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    stubs.tierClientCreateForSiteStub.resolves({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
        siteEnrollment: { getId: () => 'enroll-1' },
      }),
    });
    stubs.tierClientCreateForOrgStub.returns({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: {
          getId: () => 'ent-1',
          getOrganizationId: () => TEST_ORG_ID,
          getTier: () => 'PLG',
        },
      }),
    });

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  // ─── transitionStatus ────────────────────────────────────────────────────────

  describe('transitionStatus', () => {
    const adminAuthAttributes = {
      authInfo: { getProfile: () => ({ email: 'ese@adobe.com' }) },
    };

    it('returns 403 for non-admin', async () => {
      const res = await PlgOnboardingController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: {},
      });
      expect(res.status).to.equal(403);
    });

    it('returns 400 when status is missing', async () => {
      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.match(/status is required/);
    });

    it('returns 400 when status is not OUTDATED', async () => {
      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'WAITLISTED', justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.match(/status is required and must be one of/);
    });

    it('returns 400 when justification is missing', async () => {
      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('justification is required');
    });

    it('returns 404 when record not found', async () => {
      mockDataAccess.PlgOnboarding.findById.resolves(null);

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
      });
      expect(res.status).to.equal(404);
    });

    it('returns 400 when current status is not WAITLISTED/ONBOARDED/REJECTED', async () => {
      const record = createMockOnboarding({ status: 'IN_PROGRESS' });
      mockDataAccess.PlgOnboarding.findById.resolves(record);

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.match(/Only WAITLISTED, ONBOARDED, or REJECTED records can be transitioned/);
    });

    it('transitions WAITLISTED to OUTDATED with CLOSED review and returns 200', async () => {
      const record = createMockOnboarding({
        status: 'WAITLISTED',
        waitlistReason: 'another domain is already onboarded',
      });
      mockDataAccess.PlgOnboarding.findById.resolves(record);

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'Manually closing old waitlist entry' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      expect(res.status).to.equal(200);
      expect(record.setStatus).to.have.been.calledWith('OUTDATED');
      expect(record.setWaitlistReason).to.have.been.calledWith(null);
      expect(record.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
      expect(record.setReviews).to.have.been.calledOnce;
      const reviews = record.setReviews.firstCall.args[0];
      expect(reviews).to.have.length(1);
      expect(reviews[0].decision).to.equal('CLOSED');
      expect(reviews[0].justification).to.equal('Manually closing old waitlist entry');
      expect(reviews[0].reviewedBy).to.equal('ese@adobe.com');
      expect(reviews[0].reason).to.be.null;
      expect(record.save).to.have.been.calledOnce;
    });

    it('transitions REJECTED to OUTDATED with REOPENED review', async () => {
      const record = createMockOnboarding({ status: 'REJECTED' });
      mockDataAccess.PlgOnboarding.findById.resolves(record);

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'Customer reapplied' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      expect(res.status).to.equal(200);
      expect(record.setStatus).to.have.been.calledWith('OUTDATED');
      const reviews = record.setReviews.firstCall.args[0];
      expect(reviews[0].decision).to.equal('REOPENED');
      expect(reviews[0].reason).to.be.null;
    });

    it('transitions ONBOARDED to OUTDATED with OFFBOARDED review and revokes ASO enrollments', async () => {
      const asoEntitlement = { getProductCode: () => ASO_PRODUCT_CODE };
      const mockEnrollment = {
        getId: () => 'enroll-1',
        remove: sandbox.stub().resolves(),
        getEntitlement: sandbox.stub().resolves(asoEntitlement),
      };
      const linkedSite = createMockSite({ siteEnrollments: [mockEnrollment] });
      const record = createMockOnboarding({ status: 'ONBOARDED', siteId: TEST_SITE_ID });
      mockDataAccess.PlgOnboarding.findById.resolves(record);
      mockDataAccess.Site.findById.resolves(linkedSite);

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'Offboarding at customer request' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      expect(res.status).to.equal(200);
      expect(record.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockEnrollment.remove).to.have.been.calledOnce;
      const reviews = record.setReviews.firstCall.args[0];
      expect(reviews[0].decision).to.equal('OFFBOARDED');
      expect(reviews[0].reason).to.be.null;
      expect(reviews[0].justification).to.equal('Offboarding at customer request');
    });

    it('transitions ONBOARDED to OUTDATED and warns when disabling summit-plg handler fails', async () => {
      const asoEntitlement = { getProductCode: () => ASO_PRODUCT_CODE };
      const mockEnrollment = {
        getId: () => 'enroll-1',
        remove: sandbox.stub().resolves(),
        getEntitlement: sandbox.stub().resolves(asoEntitlement),
      };
      const linkedSite = createMockSite({ siteEnrollments: [mockEnrollment] });
      const record = createMockOnboarding({ status: 'ONBOARDED', siteId: TEST_SITE_ID });
      mockDataAccess.PlgOnboarding.findById.resolves(record);
      mockDataAccess.Site.findById.resolves(linkedSite);
      mockDataAccess.Configuration.findLatest.rejects(new Error('config unavailable'));

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'Offboarding at customer request' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to disable summit-plg handler/);
    });

    it('returns 200 and logs error when ASO enrollment revocation fails for ONBOARDED record', async () => {
      const linkedSite = createMockSite({
        siteEnrollments: [{
          getId: () => 'enroll-fail',
          remove: sandbox.stub().rejects(new Error('revoke failed')),
          getEntitlement: sandbox.stub().resolves({ getProductCode: () => ASO_PRODUCT_CODE }),
        }],
      });
      const record = createMockOnboarding({ status: 'ONBOARDED', siteId: TEST_SITE_ID });
      mockDataAccess.PlgOnboarding.findById.resolves(record);
      mockDataAccess.Site.findById.resolves(linkedSite);

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
      });

      expect(res.status).to.equal(200);
      expect(record.setStatus).to.have.been.calledWith('OUTDATED');
      expect(record.save).to.have.been.called;
      expect(mockLog.error).to.have.been.calledWith(sinon.match(/Failed to revoke ASO enrollments/));
    });

    it('returns 400 when data is null (covers data || {} fallback)', async () => {
      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: null,
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      expect(res.status).to.equal(400);
    });

    it('returns 200 and logs stringified non-Error thrown by revokeAsoSiteEnrollments', async () => {
      const record = createMockOnboarding({ status: 'ONBOARDED', siteId: TEST_SITE_ID });
      mockDataAccess.PlgOnboarding.findById.resolves(record);
      mockDataAccess.Site.findById.callsFake(async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'non-error failure';
      });

      const res = await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'test' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      expect(res.status).to.equal(200);
      expect(record.setStatus).to.have.been.calledWith('OUTDATED');
      expect(record.save).to.have.been.called;
      expect(mockLog.error).to.have.been.calledWith(sinon.match(/Failed to revoke ASO enrollments/));
    });

    it('appends to existing reviews rather than replacing them', async () => {
      const existingReview = {
        reason: 'first reason',
        decision: 'UPHELD',
        reviewedBy: 'other@adobe.com',
        reviewedAt: '2026-01-01T00:00:00.000Z',
        justification: 'first pass',
      };
      const record = createMockOnboarding({
        status: 'WAITLISTED',
        reviews: [existingReview],
      });
      record.getReviews.returns([existingReview]);
      mockDataAccess.PlgOnboarding.findById.resolves(record);

      await AdminAccessPlgController({ log: mockLog }).transitionStatus({
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { status: 'OUTDATED', justification: 'Second review' },
        dataAccess: mockDataAccess,
        attributes: adminAuthAttributes,
        env: {},
        log: mockLog,
      });

      const reviews = record.setReviews.firstCall.args[0];
      expect(reviews).to.have.length(2);
      expect(reviews[0]).to.deep.equal(existingReview);
      expect(reviews[1].decision).to.equal('CLOSED');
    });
  });

  // ─── admin onboarding management ─────────────────────────────────────────────

  describe('admin onboarding management', () => {
    describe('createOnboarding', () => {
      it('returns 403 when caller is not admin', async () => {
        const res = await PlgOnboardingController({ log: mockLog }).createOnboarding({
          data: { imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(403);
      });

      it('returns 400 when data is null', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: null,
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when imsOrgId is missing', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: { domain: TEST_DOMAIN },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when domain is missing', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: { imsOrgId: TEST_IMS_ORG_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when status is invalid', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: { imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN, status: 'BOGUS' },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 409 when record already exists', async () => {
        mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(mockOnboarding);
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: { imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(409);
      });

      it('creates record with INACTIVE status by default and returns 201', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: { imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(201);
        expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
          sinon.match({ imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN, status: 'INACTIVE' }),
        );
      });

      it('creates record with explicit status when provided', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: { imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN, status: 'PRE_ONBOARDING' },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(201);
        expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
          sinon.match({ status: 'PRE_ONBOARDING' }),
        );
      });

      it('creates preonboarding record with siteId, organizationId, and steps', async () => {
        const preonboardingData = {
          imsOrgId: TEST_IMS_ORG_ID,
          domain: TEST_DOMAIN,
          status: 'PRE_ONBOARDING',
          siteId: TEST_SITE_ID,
          organizationId: TEST_ORG_ID,
          steps: { siteCreated: true, entitlementCreated: true },
        };

        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: preonboardingData,
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setSiteId).to.have.been.calledWith(TEST_SITE_ID);
        expect(mockOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
        expect(mockOnboarding.setSteps).to.have.been.calledWith(
          sinon.match({ siteCreated: true, entitlementCreated: true }),
        );
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('creates preonboarding record with botBlocker info', async () => {
        const botBlockerInfo = {
          type: 'Cloudflare',
          ipsToAllowlist: ['1.2.3.4', '5.6.7.8'],
        };

        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: {
            imsOrgId: TEST_IMS_ORG_ID,
            domain: TEST_DOMAIN,
            status: 'WAITING_FOR_IP_ALLOWLISTING',
            botBlocker: botBlockerInfo,
          },
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setBotBlocker).to.have.been.calledWith(
          sinon.match(botBlockerInfo),
        );
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('creates preonboarding record with completedAt timestamp', async () => {
        const completedAt = '2026-04-18T12:00:00.000Z';

        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: {
            imsOrgId: TEST_IMS_ORG_ID,
            domain: TEST_DOMAIN,
            status: 'PRE_ONBOARDING',
            completedAt,
          },
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setCompletedAt).to.have.been.calledWith(completedAt);
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('creates preonboarding record with all optional fields', async () => {
        const fullPreonboardingData = {
          imsOrgId: TEST_IMS_ORG_ID,
          domain: TEST_DOMAIN,
          status: 'PRE_ONBOARDING',
          siteId: TEST_SITE_ID,
          organizationId: TEST_ORG_ID,
          steps: { siteCreated: true, entitlementCreated: true, auditsEnabled: true },
          completedAt: '2026-04-18T12:00:00.000Z',
        };

        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: fullPreonboardingData,
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setSiteId).to.have.been.calledWith(TEST_SITE_ID);
        expect(mockOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
        expect(mockOnboarding.setSteps).to.have.been.calledWith(
          sinon.match({
            siteCreated: true,
            entitlementCreated: true,
            auditsEnabled: true,
          }),
        );
        expect(mockOnboarding.setCompletedAt).to.have.been.calledWith(
          '2026-04-18T12:00:00.000Z',
        );
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('creates record without optional fields when not provided', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: {
            imsOrgId: TEST_IMS_ORG_ID,
            domain: TEST_DOMAIN,
            status: 'INACTIVE',
          },
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setSiteId).to.not.have.been.called;
        expect(mockOnboarding.setOrganizationId).to.not.have.been.called;
        expect(mockOnboarding.setSteps).to.not.have.been.called;
        expect(mockOnboarding.setBotBlocker).to.not.have.been.called;
        expect(mockOnboarding.setCompletedAt).to.not.have.been.called;
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('ignores invalid steps field (non-object)', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: {
            imsOrgId: TEST_IMS_ORG_ID,
            domain: TEST_DOMAIN,
            status: 'PRE_ONBOARDING',
            steps: 'invalid-string',
          },
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setSteps).to.not.have.been.called;
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('ignores invalid botBlocker field (non-object)', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).createOnboarding({
          data: {
            imsOrgId: TEST_IMS_ORG_ID,
            domain: TEST_DOMAIN,
            status: 'WAITING_FOR_IP_ALLOWLISTING',
            botBlocker: 'invalid-string',
          },
          dataAccess: mockDataAccess,
          attributes: {},
        });

        expect(res.status).to.equal(201);
        expect(mockOnboarding.setBotBlocker).to.not.have.been.called;
        expect(mockOnboarding.save).to.have.been.called;
      });
    });

    describe('updateOnboarding', () => {
      it('returns 403 when caller is not admin', async () => {
        const res = await PlgOnboardingController({ log: mockLog }).updateOnboarding({
          data: { status: 'INACTIVE' },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(403);
      });

      it('returns 400 when data is null', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: null,
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when no fields provided', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: {},
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when status is invalid', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { status: 'BOGUS' },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when siteId is not a valid UUID', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { siteId: 'not-a-uuid' },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when organizationId is not a valid UUID', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { organizationId: 'not-a-uuid' },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 400 when steps contains invalid keys', async () => {
        mockDataAccess.PlgOnboarding.findById.resolves(mockOnboarding);
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { steps: { orgResolved: true, unknownStep: true } },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(400);
      });

      it('returns 404 when record not found', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { status: 'INACTIVE' },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(404);
      });

      it('updates all editable fields and returns 200', async () => {
        const newSiteId = '66331367-70e6-4a49-8445-4f6d9c265af9';
        const newOrgId = '77441478-81f7-4b5a-9556-5a7e0d376b00';
        mockDataAccess.PlgOnboarding.findById.resolves(mockOnboarding);

        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: {
            status: 'WAITLISTED',
            siteId: newSiteId,
            organizationId: newOrgId,
            steps: { orgResolved: true, rumVerified: true, preOnboarded: true },
            botBlocker: { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4'], userAgent: 'bot' },
            waitlistReason: 'pending review',
            updatedBy: 'admin@example.com',
            createdBy: 'admin@example.com',
          },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
        expect(mockOnboarding.setSiteId).to.have.been.calledWith(newSiteId);
        expect(mockOnboarding.setOrganizationId).to.have.been.calledWith(newOrgId);
        expect(mockOnboarding.setBotBlocker).to.have.been.calledWith(
          { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4'], userAgent: 'bot' },
        );
        expect(mockOnboarding.setWaitlistReason).to.have.been.calledWith('pending review');
        expect(mockOnboarding.setUpdatedBy).to.have.been.calledWith('admin@example.com');
        expect(mockOnboarding.setCreatedBy).to.have.been.calledWith('admin@example.com');
        expect(mockOnboarding.setSteps).to.have.been.calledWith(
          { orgResolved: true, rumVerified: true, preOnboarded: true },
        );
        expect(mockOnboarding.save).to.have.been.called;
      });

      it('merges provided steps into existing steps', async () => {
        const record = createMockOnboarding({
          steps: { orgResolved: true, rumVerified: false, siteCreated: false },
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { steps: { rumVerified: true, siteCreated: true } },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(record.setSteps).to.have.been.calledWith(
          { orgResolved: true, rumVerified: true, siteCreated: true },
        );
        expect(record.save).to.have.been.called;
      });

      it('updates status when record imsOrgId is missing', async () => {
        const record = createMockOnboarding({ imsOrgId: '' });
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        const res = await AdminAccessPlgController({ log: mockLog }).updateOnboarding({
          data: { status: 'INACTIVE' },
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(record.save).to.have.been.called;
      });
    });

    describe('deleteOnboarding', () => {
      it('returns 403 when caller is not admin', async () => {
        const res = await PlgOnboardingController({ log: mockLog }).deleteOnboarding({
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(403);
      });

      it('returns 404 when record not found', async () => {
        const res = await AdminAccessPlgController({ log: mockLog }).deleteOnboarding({
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(404);
      });

      it('deletes record and returns 204', async () => {
        mockDataAccess.PlgOnboarding.findById.resolves(mockOnboarding);
        const res = await AdminAccessPlgController({ log: mockLog }).deleteOnboarding({
          params: { plgOnboardingId: TEST_ONBOARDING_ID },
          dataAccess: mockDataAccess,
          attributes: {},
        });
        expect(res.status).to.equal(204);
        expect(mockOnboarding.remove).to.have.been.called;
      });
    });
  });
});
