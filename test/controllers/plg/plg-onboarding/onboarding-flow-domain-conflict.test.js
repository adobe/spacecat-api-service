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
  PLG_PROFILE,
  TEST_DOMAIN,
  TEST_BASE_URL,
  TEST_IMS_ORG_ID,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  OTHER_CUSTOMER_ORG_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';

use(sinonChai);

// Covers: onboard - one domain per IMS org (waitlisting, displacement, auto-transition).
describe('PlgOnboardingController (onboarding-flow-domain-conflict)', function describePlgOnboarding() {
  this.timeout(10000);

  let sandbox;
  let PlgOnboardingControllerFactory;

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

  // esmock is expensive — run once per file, not once per test.
  // The sandbox is kept alive for the whole file; stubs are reset (not recreated)
  // between tests so esmock's captured references stay valid.
  before(async () => {
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

    PlgOnboardingControllerFactory = (await esmock(
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

  // Reset stub call history and default behaviour between tests.
  // Do NOT restore/recreate the sandbox — esmock captured the original stub references.
  beforeEach(() => {
    sandbox.reset();

    composeBaseURLStub.returns(TEST_BASE_URL);
    detectBotBlockerStub.resolves({ crawlable: true });
    detectLocaleStub.resolves({ language: 'en', region: 'US' });
    resolveCanonicalUrlStub.resolves(TEST_BASE_URL);
    rumRetrieveDomainkeyStub.resolves('test-domainkey');
    updateRumConfigStub.resolves(true);
    autoResolveAuthorUrlStub.resolves(null);
    resolveWwwUrlStub.resolves(TEST_DOMAIN);
    updateCodeConfigStub.resolves();
    findDeliveryTypeStub.resolves('aem_edge');
    deriveProjectNameStub.returns('example.com');
    queueDeliveryConfigWriterStub.resolves({ ok: true });
    loadProfileConfigStub.returns(PLG_PROFILE);
    triggerBrandProfileAgentStub.resolves('exec-123');
    configToDynamoItemStub.returns({ config: 'dynamo' });
    tierClientCreateEntitlementStub.resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    tierClientCreateForSiteStub.resolves({
      createEntitlement: tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
        siteEnrollment: { getId: () => 'enroll-1' },
      }),
    });
    tierClientCreateForOrgStub.returns({
      createEntitlement: tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
      }),
    });
    createOrFindOrganizationStub.resolves(mockOrganization);
    enableAuditsStub.resolves();
    enableImportsStub.resolves();
    triggerAuditsStub.resolves();
    mockOrganization.getId.returns(TEST_ORG_ID);
    mockOrganization.getImsOrgId.returns(TEST_IMS_ORG_ID);
    mockOrganization.getName.returns('Test Org');
    mockSiteConfig.getFetchConfig.returns({});
    mockSiteConfig.updateFetchConfig.returns(undefined);
    mockProject.getId.returns(TEST_PROJECT_ID);
    mockProject.getProjectName.returns('example.com');

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
  });

  describe('onboard - one domain per IMS org', () => {
    let controller;

    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('waitlists domain when another domain is already onboarded for the same IMS org', async () => {
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
      expect(mockOnboarding.save).to.have.been.called;
      expect(createOrFindOrganizationStub).to.not.have.been.called;
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });

    it('waitlists and uses org ID as fallback name when Organization.findById returns null for already-onboarded record', async () => {
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        organizationId: OTHER_CUSTOMER_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Organization.findById.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('allows onboarding when the same domain is already onboarded (re-onboard)', async () => {
      const onboardedRecord = createMockOnboarding({
        domain: TEST_DOMAIN,
        status: 'ONBOARDED',
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('stamps customer identity as createdBy when request comes from ASO UI', async () => {
      mockOnboarding.getStatus.returns('PRE_ONBOARDING');
      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'AAAAAAAABBBBBBBBCCCCCCCC' }], email: 'customer@example.com' }) };
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo, headers: { 'x-client-type': 'sites-optimizer-ui' } },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(mockOnboarding.setCreatedBy).to.have.been.calledWith('customer@example.com');
    });

    it('does not set createdBy when request is not from ASO UI', async () => {
      mockOnboarding.getStatus.returns('PRE_ONBOARDING');
      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'AAAAAAAABBBBBBBBCCCCCCCC' }], email: 'customer@example.com' }) };
      const context = buildContext({ domain: TEST_DOMAIN }, { authInfo });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(mockOnboarding.setCreatedBy).to.not.have.been.called;
    });

    it('does not set createdBy when x-client-type is a different value', async () => {
      mockOnboarding.getStatus.returns('PRE_ONBOARDING');
      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'AAAAAAAABBBBBBBBCCCCCCCC' }], email: 'customer@example.com' }) };
      const context = buildContext({ domain: TEST_DOMAIN }, { authInfo, headers: { 'x-client-type': 'some-other-client' } });
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(mockOnboarding.setCreatedBy).to.not.have.been.called;
    });

    it('does not set createdBy when pathInfo is absent', async () => {
      mockOnboarding.getStatus.returns('PRE_ONBOARDING');
      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'AAAAAAAABBBBBBBBCCCCCCCC' }], email: 'customer@example.com' }) };
      const context = buildContext({ domain: TEST_DOMAIN }, { authInfo });
      delete context.pathInfo;
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(mockOnboarding.setCreatedBy).to.not.have.been.called;
    });

    it('does not set createdBy when headers are absent', async () => {
      mockOnboarding.getStatus.returns('PRE_ONBOARDING');
      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'AAAAAAAABBBBBBBBCCCCCCCC' }], email: 'customer@example.com' }) };
      const context = buildContext({ domain: TEST_DOMAIN }, { authInfo });
      context.pathInfo = {};
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(mockOnboarding.setCreatedBy).to.not.have.been.called;
    });

    it('allows onboarding when other domains exist but none are onboarded', async () => {
      const waitlistedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'WAITLISTED',
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([waitlistedRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('auto-transitions other WAITLISTED records to OUTDATED with CLOSED review on new onboard', async () => {
      const staleWaitlisted = createMockOnboarding({
        id: 'stale-waitlisted-id',
        domain: 'old-domain.com',
        status: 'WAITLISTED',
        waitlistReason: 'previous waitlist reason',
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([staleWaitlisted]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);

      expect(staleWaitlisted.setStatus).to.have.been.calledWith('OUTDATED');
      expect(staleWaitlisted.setWaitlistReason).to.have.been.calledWith(null);
      expect(staleWaitlisted.setUpdatedBy).to.have.been.calledWith('system');
      expect(staleWaitlisted.setReviews).to.have.been.calledOnce;
      const reviews = staleWaitlisted.setReviews.firstCall.args[0];
      expect(reviews).to.have.length(1);
      expect(reviews[0].decision).to.equal('CLOSED');
      expect(reviews[0].reviewedBy).to.equal('system');
      expect(reviews[0].reason).to.equal('previous waitlist reason');
      expect(reviews[0].justification).to.match(/Automatically closed by system/);
      expect(staleWaitlisted.save).to.have.been.called;

      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('auto-transitions WAITING_FOR_IP_ALLOWLISTING records to OUTDATED with CLOSED review', async () => {
      const blockedRecord = createMockOnboarding({
        id: 'blocked-id',
        domain: 'blocked-domain.com',
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4'] },
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([blockedRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);

      expect(blockedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(blockedRecord.setWaitlistReason).to.have.been.calledWith(null);
      expect(blockedRecord.setUpdatedBy).to.have.been.calledWith('system');
      const reviews = blockedRecord.setReviews.firstCall.args[0];
      expect(reviews[0].decision).to.equal('CLOSED');

      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('auto-transitions multiple pending records to OUTDATED when new onboarding starts', async () => {
      const record1 = createMockOnboarding({ id: 'r1', domain: 'a.com', status: 'WAITLISTED' });
      const record2 = createMockOnboarding({ id: 'r2', domain: 'b.com', status: 'WAITING_FOR_IP_ALLOWLISTING' });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record1, record2]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(record1.setStatus).to.have.been.calledWith('OUTDATED');
      expect(record2.setStatus).to.have.been.calledWith('OUTDATED');
    });

    it('logs warn and continues when notification throws during WAITLISTED sweep', async () => {
      const staleRecord = createMockOnboarding({
        id: 'stale-id',
        domain: 'stale-domain.com',
        status: 'WAITLISTED',
        waitlistReason: 'old reason',
      });
      staleRecord.getImsOrgId.throws(new Error('IMS org ID fetch failed'));
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([staleRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = {
        ...context.env,
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123',
        SLACK_BOT_TOKEN: 'xoxb-test',
      };
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(staleRecord.save).to.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(
        /Failed to post OUTDATED notification for domain stale-domain\.com/,
      );
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('does not auto-transition the record for the domain being onboarded', async () => {
      const sameRecord = createMockOnboarding({
        id: 'same-domain-id',
        domain: TEST_DOMAIN,
        status: 'WAITLISTED',
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([sameRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(sameRecord.setStatus).to.not.have.been.calledWith('OUTDATED');
    });

    it('displaces already-onboarded domain when it has no open PLG suggestions', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const OLD_ORG_ID = OTHER_CUSTOMER_ORG_ID;
      const ASO_ENTITLEMENT_ID = 'aso-entitlement-uuid';

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      const mockAsoEntitlement = {
        getId: sandbox.stub().returns(ASO_ENTITLEMENT_ID),
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PLG'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([mockAsoEntitlement]);

      const mockEnrollmentToRevoke = {
        getId: sandbox.stub().returns('enroll-old-1'),
        getSiteId: sandbox.stub().returns(OLD_SITE_ID),
        remove: sandbox.stub().resolves(),
      };
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([mockEnrollmentToRevoke]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);

      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(onboardedRecord.setWaitlistReason).to.have.been.calledWith(null);
      expect(onboardedRecord.setReviews).to.have.been.called;
      const offboardedReviews = onboardedRecord.setReviews.lastCall.args[0];
      expect(offboardedReviews[offboardedReviews.length - 1].justification).to.match(/Automatically offboarded by system/);
      expect(onboardedRecord.setUpdatedBy).to.have.been.calledWith('system');
      expect(onboardedRecord.save).to.have.been.called;

      expect(mockDataAccess.Entitlement.allByOrganizationId).to.have.been.calledWith(OLD_ORG_ID);
      expect(mockDataAccess.SiteEnrollment.allByEntitlementId)
        .to.have.been.calledWith(ASO_ENTITLEMENT_ID);
      expect(mockEnrollmentToRevoke.remove).to.have.been.called;

      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('logs when Site.findById fails while disabling summit-plg after displacement', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const OLD_ORG_ID = OTHER_CUSTOMER_ORG_ID;
      const ASO_ENTITLEMENT_ID = 'aso-entitlement-uuid';

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      const mockAsoEntitlement = {
        getId: sandbox.stub().returns(ASO_ENTITLEMENT_ID),
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PLG'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([mockAsoEntitlement]);
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([]);

      mockDataAccess.Site.findById.callsFake((siteId) => {
        if (siteId === OLD_SITE_ID) {
          return Promise.reject(new Error('lookup failed'));
        }
        return Promise.resolve(null);
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(
        /Failed to disable summit-plg for displaced site old-site-uuid: lookup failed/,
      );
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('does not set updatedBy on displaced onboarded record when imsOrgId is missing', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const OLD_ORG_ID = OTHER_CUSTOMER_ORG_ID;
      const ASO_ENTITLEMENT_ID = 'aso-entitlement-uuid';

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        imsOrgId: '',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      const mockAsoEntitlement = {
        getId: sandbox.stub().returns(ASO_ENTITLEMENT_ID),
        getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
        getTier: sandbox.stub().returns('PLG'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([mockAsoEntitlement]);
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([]);

      const res = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setUpdatedBy).to.have.been.calledWith('system');
    });

    it('waitlists new domain when already-onboarded site has NEW PLG suggestions', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([{
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('cwv'),
        getLastAuditedAt: sandbox.stub().returns(null),
      }]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        { getStatus: sandbox.stub().returns('NEW') },
      ]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).not.to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('waitlists new domain when already-onboarded site has IN_PROGRESS PLG suggestions', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([{
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('alt-text'),
        getLastAuditedAt: sandbox.stub().returns(null),
      }]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        { getStatus: sandbox.stub().returns('IN_PROGRESS') },
      ]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).not.to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('waitlists new domain when already-onboarded site has FIXED PLG suggestions', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([{
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('broken-backlinks'),
        getLastAuditedAt: sandbox.stub().returns(null),
      }]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        { getStatus: sandbox.stub().returns('FIXED') },
      ]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).not.to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('waitlists new domain when already-onboarded site has SKIPPED PLG suggestions', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([{
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('cwv'),
        getLastAuditedAt: sandbox.stub().returns(null),
      }]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        { getStatus: sandbox.stub().returns('SKIPPED') },
      ]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).not.to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('displaces when all PLG suggestions are PENDING_VALIDATION', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OTHER_CUSTOMER_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([{
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('cwv'),
        getLastAuditedAt: sandbox.stub().returns(null),
      }]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        { getStatus: sandbox.stub().returns('PENDING_VALIDATION') },
      ]);
      mockDataAccess.Entitlement.allByOrganizationId.resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('displaces when all PLG suggestions are OUTDATED', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OTHER_CUSTOMER_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([{
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('cwv'),
        getLastAuditedAt: sandbox.stub().returns(null),
      }]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        { getStatus: sandbox.stub().returns('OUTDATED') },
      ]);
      mockDataAccess.Entitlement.allByOrganizationId.resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('conservatively waitlists new domain when suggestion check throws', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.rejects(new Error('DB unavailable'));

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).not.to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('displaces already-onboarded domain when audit completed with no open suggestions', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const OLD_ORG_ID = OTHER_CUSTOMER_ORG_ID;

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);

      const mockOpportunity = {
        getId: sandbox.stub().returns('oppty-1'),
        getType: sandbox.stub().returns('cwv'),
        getLastAuditedAt: sandbox.stub().returns('2026-04-01T10:00:00.000Z'),
      };
      mockDataAccess.Opportunity.allBySiteId.resolves([mockOpportunity]);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([]);

      mockDataAccess.Entitlement.allByOrganizationId.resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('waitlists new domain when already-onboarded record has no siteId', async () => {
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: null,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.Opportunity.allBySiteId).not.to.have.been.called;
      expect(onboardedRecord.setStatus).not.to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/another domain is already onboarded for this IMS org/);
    });

    it('displaces already-onboarded domain when displaced site has no organizationId', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: null,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(onboardedRecord.save).to.have.been.called;
      expect(mockDataAccess.Entitlement.allByOrganizationId).not.to.have.been.calledWith(null);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('displaces but skips ASO revocation when previous org is internal/demo', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const INTERNAL_OLD_ORG_ID = 'internal-old-org';

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: INTERNAL_OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_OLD_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockDataAccess.Entitlement.allByOrganizationId)
        .not.to.have.been.calledWith(INTERNAL_OLD_ORG_ID);
      expect(mockLog.error).to.have.been.calledWithMatch(
        /Refusing to revoke ASO enrollment.*previous org .* is internal\/demo/,
      );
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('displaces already-onboarded domain when no ASO entitlement found for old org', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const OLD_ORG_ID = OTHER_CUSTOMER_ORG_ID;
      const NON_ASO_ENT_ID = 'non-aso-ent-id';

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      mockDataAccess.Entitlement.allByOrganizationId.resolves([
        { getId: sandbox.stub().returns(NON_ASO_ENT_ID), getProductCode: sandbox.stub().returns('other_product') },
      ]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockDataAccess.SiteEnrollment.allByEntitlementId)
        .not.to.have.been.calledWith(NON_ASO_ENT_ID);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('continues onboarding new domain even when enrollment revocation fails', async () => {
      const OLD_SITE_ID = 'old-site-uuid';
      const OLD_ORG_ID = OTHER_CUSTOMER_ORG_ID;
      const ASO_ENTITLEMENT_ID = 'aso-entitlement-uuid';

      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        siteId: OLD_SITE_ID,
        organizationId: OLD_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]);

      mockDataAccess.Entitlement.allByOrganizationId.resolves([
        {
          getId: sandbox.stub().returns(ASO_ENTITLEMENT_ID),
          getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
          getTier: sandbox.stub().returns('PLG'),
        },
      ]);

      mockDataAccess.SiteEnrollment.allByEntitlementId
        .onFirstCall().rejects(new Error('DB timeout'))
        .resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(onboardedRecord.save).to.have.been.called;
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to revoke ASO enrollment/);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });
  });
});
