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
  DEMO_ORG_ID,
  OTHER_CUSTOMER_ORG_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController - update', function () {
  this.timeout(10000);

  let sandbox;
  let stubs;
  let AdminAccessPlgController;
  let NonAdminController;
  let mockSiteConfig;
  let mockOrganization;
  let mockProject;
  let mockLog;
  let mockEnv;
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
      mockSiteConfig, mockOrganization, mockProject, mockLog, mockEnv,
    } = stubs);

    [AdminAccessPlgController, NonAdminController] = await Promise.all([
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

  const adminAuthAttributes = {
    authInfo: {
      getProfile: () => ({ email: 'ese@adobe.com' }),
    },
  };

  it('returns 403 for non-admin users', async () => {
    const res = await NonAdminController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(403);
  });

  it('returns 400 for missing onboardingId', async () => {
    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: {},
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
  });

  it('returns 400 for missing request body', async () => {
    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: null,
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
  });

  it('returns 400 for invalid decision', async () => {
    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'INVALID', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
  });

  it('returns 400 for missing justification', async () => {
    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
  });

  it('returns 404 when onboarding record not found', async () => {
    mockDataAccess.PlgOnboarding.findById.resolves(null);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(404);
  });

  it('returns 400 when onboarding is not WAITLISTED or ONBOARDED', async () => {
    const record = createMockOnboarding({ status: 'IN_PROGRESS' });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal('Onboarding record must be in WAITLISTED state');
  });

  it('returns 400 for ONBOARDED record (use transitionStatus endpoint instead)', async () => {
    const record = createMockOnboarding({ status: 'ONBOARDED' });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal('Onboarding record must be in WAITLISTED state');
  });

  it('returns 400 for REJECTED record (use transitionStatus endpoint instead)', async () => {
    const record = createMockOnboarding({ status: 'REJECTED' });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'UPHELD', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal('Onboarding record must be in WAITLISTED state');
  });

  it('stores UPHELD review and transitions to REJECTED', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'UPHELD', justification: 'Not ready to proceed' },
      attributes: adminAuthAttributes,
      env: {},
    });

    expect(res.status).to.equal(200);
    expect(record.setReviews).to.have.been.calledOnce;
    const reviews = record.setReviews.firstCall.args[0];
    expect(reviews).to.have.length(1);
    expect(reviews[0].reason).to.equal('Domain site-a.com is another domain is already onboarded for this IMS org');
    expect(reviews[0].decision).to.equal('UPHELD');
    expect(reviews[0].justification).to.equal('Not ready to proceed');
    expect(record.setStatus).to.have.been.calledWith('REJECTED');
    expect(record.setWaitlistReason).to.have.been.calledWith(null);
    expect(record.save).to.have.been.calledOnce;
  });

  it('clears waitlistReason when UPHELD transitions WAITLISTED to REJECTED', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'UPHELD', justification: 'Rejected — domain does not qualify' },
      attributes: adminAuthAttributes,
      env: {},
    });

    expect(res.status).to.equal(200);
    expect(record.setWaitlistReason).to.have.been.calledWith(null);
    expect(record.setStatus).to.have.been.calledWith('REJECTED');
  });

  it('uses authInfo.profile when getProfile is unavailable', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'UPHELD', justification: 'Not ready to proceed' },
      attributes: {
        authInfo: {
          profile: { email: 'profile-fallback@example.com' },
        },
      },
      env: {},
    });

    expect(res.status).to.equal(200);
    const reviews = record.setReviews.firstCall.args[0];
    expect(reviews[0].reviewedBy).to.equal('profile-fallback@example.com');
  });

  it('falls back to admin reviewer when auth profile email and imsOrgId are missing', async () => {
    const record = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'UPHELD', justification: 'Not ready to proceed' },
      attributes: {},
      env: {},
    });

    expect(res.status).to.equal(200);
    expect(record.setUpdatedBy).to.have.been.calledWith('admin');
    const reviews = record.setReviews.firstCall.args[0];
    expect(reviews[0].reviewedBy).to.equal('admin');
  });

  it('PENDING: records review without changing status', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain is not an AEM site',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'PENDING', justification: 'Emailed customer, awaiting response' },
      attributes: adminAuthAttributes,
      env: {},
    });

    expect(res.status).to.equal(200);
    expect(record.setReviews).to.have.been.calledOnce;
    const reviews = record.setReviews.firstCall.args[0];
    expect(reviews).to.have.length(1);
    expect(reviews[0].decision).to.equal('PENDING');
    expect(reviews[0].justification).to.equal('Emailed customer, awaiting response');
    expect(reviews[0].reviewedBy).to.equal('ese@adobe.com');
    expect(record.setStatus).to.not.have.been.called;
    expect(record.setWaitlistReason).to.not.have.been.called;
    expect(record.save).to.have.been.calledOnce;
  });

  it('PENDING: preserves existing reviews', async () => {
    const existingReview = {
      reason: 'Domain is not an AEM site',
      decision: 'PENDING',
      reviewedBy: 'other-ese@adobe.com',
      reviewedAt: '2026-05-01T10:00:00.000Z',
      justification: 'First contact attempt',
    };
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain is not an AEM site',
      reviews: [existingReview],
    });
    record.getReviews.returns([existingReview]);
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'PENDING', justification: 'Second follow-up sent' },
      attributes: adminAuthAttributes,
      env: {},
    });

    expect(res.status).to.equal(200);
    const reviews = record.setReviews.firstCall.args[0];
    expect(reviews).to.have.length(2);
    expect(reviews[0]).to.deep.equal(existingReview);
    expect(reviews[1].decision).to.equal('PENDING');
    expect(reviews[1].justification).to.equal('Second follow-up sent');
    expect(record.setStatus).to.not.have.been.called;
  });

  it('PENDING: succeeds even when waitlistReason is absent (no checkKey needed)', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: null,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'PENDING', justification: 'Emailed customer, awaiting response' },
      attributes: adminAuthAttributes,
      env: {},
    });

    expect(res.status).to.equal(200);
    const reviews = record.setReviews.firstCall.args[0];
    expect(reviews[0].decision).to.equal('PENDING');
    expect(record.setStatus).to.not.have.been.called;
    expect(record.save).to.have.been.calledOnce;
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: replaces old domain and re-runs flow', async () => {
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    // After INACTIVE, the re-run finds the existing record
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
    expect(oldOnboardedRecord.setWaitlistReason).to.have.been.calledWith(null);
    expect(oldOnboardedRecord.setReviews).to.have.been.calledOnce;
    const oldReviews = oldOnboardedRecord.setReviews.firstCall.args[0];
    expect(oldReviews).to.have.length(1);
    expect(oldReviews[0].reason).to.be.null;
    expect(oldReviews[0].decision).to.equal('OFFBOARDED');
    expect(oldReviews[0].justification)
      .to.equal('System action to start onboarding for new domain in the same IMS org.');
    expect(oldOnboardedRecord.save).to.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: returns 500 when imsOrgId is missing and rerun errors', async () => {
    const waitlistedRecord = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      imsOrgId: '',
      domain: 'site-a.com',
      status: 'ONBOARDED',
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'IN_PROGRESS',
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId
      .onFirstCall().resolves([waitlistedRecord, oldOnboardedRecord])
      .onSecondCall().resolves([]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);
    stubs.createOrFindOrganizationStub.rejects(new Error('organization lookup failed'));

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(500);
    expect(waitlistedRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: rerun waitlists a non-AEM domain when imsOrgId is missing', async () => {
    const waitlistedRecord = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'IN_PROGRESS',
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId
      .onFirstCall().resolves([waitlistedRecord])
      .onSecondCall().resolves([]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);
    stubs.rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
    stubs.findDeliveryTypeStub.resolves('other');

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setStatus).to.have.been.calledWith('WAITLISTED');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: rerun is waitlisted due to an existing onboarded domain', async () => {
    const waitlistedRecord = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      imsOrgId: '',
      domain: 'site-a.com',
      status: 'ONBOARDED',
    });
    const stillOnboardedRecord = createMockOnboarding({
      id: 'still-onboarded-id',
      imsOrgId: '',
      domain: 'site-b.com',
      status: 'ONBOARDED',
      siteId: 'still-onboarded-site-id',
      organizationId: TEST_ORG_ID,
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'IN_PROGRESS',
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId
      .onFirstCall().resolves([waitlistedRecord, oldOnboardedRecord])
      .onSecondCall().resolves([stillOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);
    mockDataAccess.Opportunity.allBySiteId.resolves([{
      getId: sandbox.stub().returns('oppty-1'),
      getType: sandbox.stub().returns('cwv'),
      getLastAuditedAt: sandbox.stub().returns(null),
    }]);
    mockDataAccess.Suggestion.allByOpportunityId.resolves([
      { getStatus: sandbox.stub().returns('NEW') },
    ]);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setStatus).to.have.been.calledWith('WAITLISTED');
    expect(rerunRecord.setWaitlistReason)
      .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: rerun stops at bot blocker when imsOrgId is missing', async () => {
    const waitlistedRecord = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'IN_PROGRESS',
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId
      .onFirstCall().resolves([waitlistedRecord])
      .onSecondCall().resolves([]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);
    stubs.detectBotBlockerStub.resolves({
      crawlable: false,
      type: 'akamai',
      ipsToAllowlist: ['1.2.3.4'],
      userAgent: 'SpaceCat/1.0',
    });

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setStatus).to.have.been.calledWith('WAITING_FOR_IP_ALLOWLISTING');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: rerun completes successfully when imsOrgId is missing', async function () {
    this.timeout(10000);
    const waitlistedRecord = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      imsOrgId: '',
      domain: 'site-a.com',
      status: 'ONBOARDED',
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'IN_PROGRESS',
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId
      .onFirstCall().resolves([waitlistedRecord, oldOnboardedRecord])
      .onSecondCall().resolves([]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setStatus).to.have.been.calledWith('ONBOARDED');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: pre-onboarding fast path when imsOrgId is missing', async () => {
    const waitlistedRecord = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      imsOrgId: '',
      domain: 'site-a.com',
      status: 'ONBOARDED',
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'PRE_ONBOARDING',
      siteId: TEST_SITE_ID,
    });
    const preOnboardedSite = createMockSite({ id: TEST_SITE_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId
      .onFirstCall().resolves([waitlistedRecord, oldOnboardedRecord])
      .onSecondCall().resolves([]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);
    mockDataAccess.Site.findById.resolves(preOnboardedSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setStatus).to.have.been.calledWith('ONBOARDED');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: revokes ASO enrollments when old domain has a linked site', async () => {
    const asoEntitlement = { getProductCode: () => ASO_PRODUCT_CODE };
    const mockEnrollment = {
      getId: () => 'enroll-1',
      remove: sandbox.stub().resolves(),
      getEntitlement: sandbox.stub().resolves(asoEntitlement),
    };
    const oldSite = createMockSite({ siteEnrollments: [mockEnrollment] });
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.findById.resolves(oldSite);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
    expect(mockEnrollment.remove).to.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: skips enrollment revocation when site not found', async () => {
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.findById.resolves(null); // site not found
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: skips enrollment revocation when no enrollments', async () => {
    const oldSite = createMockSite({ siteEnrollments: [] });
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.findById.resolves(oldSite);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: skips revocation when no ASO enrollments found', async () => {
    const nonAsoEntitlement = { getProductCode: () => 'other_product' };
    const nonAsoEnrollment = {
      getId: () => 'enroll-2',
      remove: sandbox.stub().resolves(),
      getEntitlement: sandbox.stub().resolves(nonAsoEntitlement),
    };
    const oldSite = createMockSite({ siteEnrollments: [nonAsoEnrollment] });
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.findById.resolves(oldSite);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(nonAsoEnrollment.remove).to.not.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: continues and logs warn when enrollment revocation throws', async () => {
    const failingEnrollment = {
      getId: () => 'enroll-fail',
      getEntitlement: sandbox.stub().resolves({ getProductCode: () => ASO_PRODUCT_CODE }),
      remove: sandbox.stub().rejects(new Error('DB error')),
    };
    const oldSite = createMockSite({ siteEnrollments: [failingEnrollment] });
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.findById.resolves(oldSite);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to revoke one or more ASO enrollments/);
  });

  it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: continues and logs warn when revokeAsoSiteEnrollments throws', async () => {
    const throwingSite = createMockSite({ siteId: TEST_SITE_ID });
    throwingSite.getSiteEnrollments.rejects(new Error('DB connection lost'));
    const waitlistedRecord = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    const oldOnboardedRecord = createMockOnboarding({
      id: 'old-onboarding-id',
      domain: 'site-a.com',
      status: 'ONBOARDED',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(waitlistedRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord, oldOnboardedRecord]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(waitlistedRecord);
    mockDataAccess.Site.findById.resolves(throwingSite);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Customer wants new domain' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to revoke enrollments for offboarded domain/);
  });

  it('BYPASS AEM_SITE_CHECK: returns 400 when siteConfig is missing', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'AEM migration confirmed' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('deliveryType');
  });

  it('BYPASS AEM_SITE_CHECK: returns 400 when deliveryType is invalid', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AEM migration confirmed',
        siteConfig: { deliveryType: 'OTHER' },
      },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('deliveryType must be one of');
  });

  it('BYPASS AEM_SITE_CHECK: re-runs flow with preset deliveryType aem_cs and author URL', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AEM migration confirmed',
        siteConfig: {
          deliveryType: 'aem_cs',
          authorUrl: 'https://author-p152454-e345003.adobeaemcloud.com',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setDeliveryConfig).to.have.been.calledWithMatch({
      authorURL: 'https://author-p152454-e345003.adobeaemcloud.com',
      preferContentApi: true,
      enableDAMAltTextUpdate: true,
    });
  });

  it('BYPASS AEM_SITE_CHECK: rerun waitlists when site belongs to another org and imsOrgId is missing', async () => {
    const record = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
    });
    const rerunRecord = createMockOnboarding({
      id: 'rerun-onboarding-id',
      imsOrgId: '',
      domain: TEST_DOMAIN,
      status: 'IN_PROGRESS',
    });
    const conflictingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.PlgOnboarding.create.resolves(rerunRecord);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([]);
    mockDataAccess.Site.findByBaseURL.resolves(conflictingSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'Force retry',
        siteConfig: {
          deliveryType: 'aem_cs',
          authorUrl: 'https://author-p123-e456.adobeaemcloud.com',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(record.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
    expect(rerunRecord.setStatus).to.have.been.calledWith('WAITLISTED');
  });

  it('BYPASS AEM_SITE_CHECK: sets hlxConfig when deliveryType is aem_edge with EDS author URL', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'EDS site confirmed',
        siteConfig: {
          deliveryType: 'aem_edge',
          authorUrl: 'main--repo--owner.aem.live',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setHlxConfig).to.have.been.calledWithMatch({ hlxVersion: 5 });
  });

  it('BYPASS AEM_SITE_CHECK: sets authorURL when deliveryType is aem_ams', async function () {
    this.timeout(10000);
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AMS site confirmed',
        siteConfig: {
          deliveryType: 'aem_ams',
          programId: '12345',
          authorUrl: 'https://author.example.com',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setDeliveryConfig).to.have.been.calledWithMatch({
      authorURL: 'https://author.example.com',
      programId: '12345',
    });
  });

  it('BYPASS AEM_SITE_CHECK: allows aem_ams without programId when authorUrl is set', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AMS site',
        siteConfig: {
          deliveryType: 'aem_ams',
          authorUrl: 'https://author.example.com',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setDeliveryConfig).to.have.been.calledWithMatch({
      authorURL: 'https://author.example.com',
    });
  });

  it('BYPASS AEM_SITE_CHECK: sets programId for aem_ams when authorUrl omitted', async function () {
    this.timeout(10000);
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AMS program only',
        siteConfig: {
          deliveryType: 'aem_ams',
          programId: 67890,
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setDeliveryConfig).to.have.been.calledWithMatch({ programId: '67890' });
  });

  it('BYPASS AEM_SITE_CHECK: sets authorURL for aem_headless (non-CS/EDGE/AMS preset path)', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'Headless',
        siteConfig: {
          deliveryType: 'aem_headless',
          authorUrl: 'https://headless.example.com',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setDeliveryConfig).to.have.been.calledWithMatch({
      authorURL: 'https://headless.example.com',
    });
  });

  it('BYPASS AEM_SITE_CHECK: returns 400 when AEM_CS authorUrl does not match expected pattern', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AEM CS site',
        siteConfig: { deliveryType: 'aem_cs', authorUrl: 'https://not-an-aem-cs-host.com' },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('AEM_CS');
  });

  it('BYPASS AEM_SITE_CHECK: prepends https:// to bare AEM_CS authorUrl before validating', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AEM CS site confirmed',
        siteConfig: {
          deliveryType: 'aem_cs',
          authorUrl: 'author-p12345-e67890.adobeaemcloud.com',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(mockSite.setDeliveryConfig).to.have.been.calledWithMatch({
      authorURL: 'https://author-p12345-e67890.adobeaemcloud.com',
    });
  });

  it('BYPASS AEM_SITE_CHECK: returns 400 when AEM_EDGE authorUrl is not a valid EDS host', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'EDS site',
        siteConfig: { deliveryType: 'aem_edge', authorUrl: 'https://not-an-eds-host.example.com' },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('AEM_EDGE');
  });

  it('BYPASS AEM_SITE_CHECK: returns 400 when authorUrl for non-CS/EDGE type is not an HTTP(S) URL', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is not an AEM site',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'AMS site',
        siteConfig: {
          deliveryType: 'aem_ams',
          programId: '999',
          authorUrl: 'not-a-url',
        },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('HTTP(S)');
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED: returns 400 when siteConfig omits moveSite and alternateDomain', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Missing siteConfig action' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal(
      'siteConfig.moveSite or siteConfig.alternateDomain is required for DOMAIN_ALREADY_ASSIGNED bypass',
    );
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED: returns 400 when siteConfig is empty', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'x', siteConfig: {} },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal(
      'siteConfig.moveSite or siteConfig.alternateDomain is required for DOMAIN_ALREADY_ASSIGNED bypass',
    );
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED: returns 400 when site no longer exists', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(null);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Run under existing org' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal('Site no longer exists for this domain');
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED alternateDomain: returns 400 when alternate domain is invalid', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Use alternate', siteConfig: { alternateDomain: 'localhost' } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('Invalid alternate domain');
    expect(record.setStatus).to.not.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED alternateDomain: rejects scheme-prefixed internal IP (regression for isSafeDomain bypass)', async () => {
    // Regression: previously `https://10.0.0.1` slipped past isSafeDomain because
    // split('/')[0] returned `https:` instead of the IP. isValidDomain now runs first.
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Use alternate', siteConfig: { alternateDomain: 'https://10.0.0.1' } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('Invalid alternate domain');
    expect(record.setStatus).to.not.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED alternateDomain: rejects syntactically-valid SSRF target (foo.localhost)', async () => {
    // Covers the isSafeDomain branch: input passes isValidDomain (has a dot, alphabetic TLD)
    // but matches the \.localhost$ blocklist entry.
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Use alternate', siteConfig: { alternateDomain: 'foo.localhost' } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('Invalid alternate domain');
    expect(record.setStatus).to.not.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED alternateDomain: retires current domain and onboards alternate domain', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'Use alternate domain',
        siteConfig: { alternateDomain: 'other-example.com' },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(record.setStatus).to.have.been.calledWith('OUTDATED');
    expect(record.setWaitlistReason).to.have.been.calledWith(null);
    expect(record.save).to.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED alternateDomain: subpath alternate domain reaches composeBaseURL and create with full path', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'Use alternate subpath',
        siteConfig: { alternateDomain: 'other-example.com/kings' },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    // Pin that the FULL subpath (not just hostname) flows through the bypass entry
    // point — locks in I4 equivalence for the alternateDomain code path.
    expect(stubs.composeBaseURLStub).to.have.been.calledWith('other-example.com/kings');
    expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
      sinon.match({ domain: 'other-example.com/kings' }),
    );
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED alternateDomain: retires current record when imsOrgId is missing', async () => {
    const record = createMockOnboarding({
      imsOrgId: '',
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
    mockDataAccess.Site.create.resolves(mockSite);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([]);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: {
        decision: 'BYPASSED',
        justification: 'Use alternate domain',
        siteConfig: { alternateDomain: 'other-example.com' },
      },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(record.setUpdatedBy).to.have.been.calledWith('ese@adobe.com');
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED moveSite: returns 400 when existing org is internal/demo and site has enrollments', async () => {
    const enrollment1 = { getId: () => 'enroll-1', remove: sandbox.stub().resolves() };
    const enrollment2 = { getId: () => 'enroll-2', remove: sandbox.stub().resolves() };
    const existingSite = createMockSite({
      orgId: DEMO_ORG_ID,
      siteEnrollments: [enrollment1, enrollment2],
    });
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
      organizationId: TEST_ORG_ID,
    });
    const demoOrg = {
      getId: sandbox.stub().returns(DEMO_ORG_ID),
      getName: sandbox.stub().returns('Demo Org'),
    };

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.Organization.findById.resolves(demoOrg);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Move from demo', siteConfig: { moveSite: true } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('active products');
    expect(enrollment1.remove).to.not.have.been.called;
    expect(enrollment2.remove).to.not.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED moveSite: returns 400 when onboarding has no organizationId', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
      organizationId: null,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Move site', siteConfig: { moveSite: true } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('no associated organization');
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED moveSite: returns 400 when site has active enrollments', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
    });
    const existingSite = createMockSite({
      orgId: OTHER_CUSTOMER_ORG_ID,
      siteEnrollments: [{ getId: () => 'enroll-1' }],
    });
    const existingOrg = {
      getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
      getImsOrgId: sandbox.stub().returns('OTHERORG123@AdobeOrg'),
      getName: sandbox.stub().returns('Other Org'),
    };

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.Organization.findById.resolves(existingOrg);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Move site', siteConfig: { moveSite: true } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.include('active products');
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED moveSite: moves site to current org and runs flow', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
      organizationId: TEST_ORG_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
    const existingOrg = {
      getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
      getImsOrgId: sandbox.stub().returns('OTHERORG123@AdobeOrg'),
      getName: sandbox.stub().returns('Other Org'),
    };

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.Site.findById.resolves(createMockSite({ orgId: TEST_ORG_ID }));
    mockDataAccess.Organization.findById.resolves(existingOrg);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Move site', siteConfig: { moveSite: true } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    // Site should be reassigned to the current org
    expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
    expect(existingSite.save).to.have.been.called;
    expect(record.save).to.have.been.called;
    // Original record should NOT be offboarded (different from default flow)
    expect(record.setStatus).to.not.have.been.calledWith('INACTIVE');
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED moveSite: updates imsOrgId in delivery config when present', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
      organizationId: TEST_ORG_ID,
    });
    const existingSite = createMockSite({
      orgId: OTHER_CUSTOMER_ORG_ID,
      deliveryConfig: { authorURL: 'https://author.example.com', imsOrgId: 'OTHERORG123@AdobeOrg' },
    });
    const existingOrg = {
      getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
      getImsOrgId: sandbox.stub().returns('OTHERORG123@AdobeOrg'),
      getName: sandbox.stub().returns('Other Org'),
    };

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.Site.findById.resolves(createMockSite({ orgId: TEST_ORG_ID }));
    mockDataAccess.Organization.findById.resolves(existingOrg);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.resolves(mockSite);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Move site', siteConfig: { moveSite: true } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(200);
    expect(existingSite.setDeliveryConfig).to.have.been.calledWithMatch({
      imsOrgId: TEST_IMS_ORG_ID,
      authorURL: 'https://author.example.com',
    });
    expect(record.save).to.have.been.called;
  });

  it('BYPASS DOMAIN_ALREADY_ASSIGNED moveSite: rethrows non-waitlist errors from site save', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain example.com is already assigned to another organization',
      siteId: TEST_SITE_ID,
      organizationId: TEST_ORG_ID,
    });
    const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
    // site.save() throws a non-waitlist error → reassignSiteOrganization propagates it.
    existingSite.save.rejects(new Error('db write failed'));
    const existingOrg = {
      getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
      getImsOrgId: sandbox.stub().returns('OTHERORG123@AdobeOrg'),
      getName: sandbox.stub().returns('Other Org'),
    };

    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.Site.findByBaseURL.resolves(existingSite);
    mockDataAccess.Organization.findById.resolves(existingOrg);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'Move site', siteConfig: { moveSite: true } },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    // Non-waitlist errors propagate to the outer admin catch → 500.
    expect(res.status).to.equal(500);
    expect(record.setStatus).to.not.have.been.calledWith('WAITLISTED');
  });

  it('returns 400 for unknown waitlist reason', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Some completely unknown reason',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal('Unable to determine the review reason from the onboarding record');
  });

  it('BYPASS returns 409 on conflict error during flow', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.rejects(
      Object.assign(new Error('Org conflict'), { conflict: true }),
    );

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(409);
    expect(res.value.message).to.equal('Org conflict');
  });

  it('BYPASS returns 400 on client error during flow', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.rejects(
      Object.assign(new Error('Bad domain'), { clientError: true }),
    );

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(400);
    expect(res.value).to.equal('Bad domain');
  });

  it('BYPASS returns 500 on unexpected error during flow', async () => {
    const record = createMockOnboarding({
      status: 'WAITLISTED',
      waitlistReason: 'Domain site-a.com is another domain is already onboarded for this IMS org',
    });
    mockDataAccess.PlgOnboarding.findById.resolves(record);
    mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);
    mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(record);
    mockDataAccess.Site.create.rejects(new Error('DB connection failed'));

    const res = await AdminAccessPlgController({ log: mockLog }).update({
      dataAccess: mockDataAccess,
      params: { onboardingId: TEST_ONBOARDING_ID },
      data: { decision: 'BYPASSED', justification: 'test' },
      attributes: adminAuthAttributes,
      env: mockEnv,
      log: mockLog,
    });

    expect(res.status).to.equal(500);
    expect(res.value).to.equal('Onboarding bypass failed. Please try again later.');
  });
});
