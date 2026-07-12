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

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
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
  TEST_SITE_ID,
  TEST_PROJECT_ID,
  TEST_ONBOARDING_ID,
  DEFAULT_ORG_ID,
  DEMO_ORG_ID,
  OTHER_CUSTOMER_ORG_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';

use(sinonChai);

// Covers: already ONBOARDED, race condition, error handler resilience, new site (happy path),
// bot blocker, RUM check, existing site in customer org, existing site in internal org,
// existing site in different customer org.
describe('PlgOnboardingController (onboarding-flow-core)', function describePlgOnboarding() {
  this.timeout(10000);

  let sandbox;
  // esmock result — loaded once per file, not per test
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
    sandbox.reset(); // clears call history + resets all stub behaviours to defaults

    // Re-apply default behaviours that createSharedMocks set up
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

  describe('onboard - already ONBOARDED domain', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('returns existing record without calling Site.create when domain is already ONBOARDED', async () => {
      const onboardedRecord = createMockOnboarding({ status: 'ONBOARDED' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(onboardedRecord);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });
  });

  describe('onboard - race condition on create', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('resumes when concurrent create causes unique violation', async () => {
      mockDataAccess.PlgOnboarding.create.rejects(
        new Error('unique constraint violation'),
      );
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(mockOnboarding);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('throws when create fails and record still not found', async () => {
      mockDataAccess.PlgOnboarding.create.rejects(
        new Error('DB connection lost'),
      );
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(500);
    });

    it('returns existing record without re-running flow when concurrent create finds ONBOARDED record', async () => {
      const onboardedRecord = createMockOnboarding({ status: 'ONBOARDED' });
      mockDataAccess.PlgOnboarding.create.rejects(new Error('unique constraint violation'));
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(onboardedRecord);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });
  });

  describe('onboard - error handler resilience', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('does not swallow original error when save in catch fails', async () => {
      tierClientCreateEntitlementStub.rejects(
        new Error('Tier service down'),
      );
      mockOnboarding.save.rejects(new Error('DB write failed'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(500);
      expect(res.value).to.equal('Onboarding failed. Please try again later.');
      expect(mockLog.error).to.have.been.calledWithMatch(
        /Failed to persist error state/,
      );
    });

    it('returns 409 when error has conflict flag', async () => {
      const conflictError = new Error('Domain ownership conflict');
      conflictError.conflict = true;
      createOrFindOrganizationStub.rejects(conflictError);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(409);
      expect(res.value).to.deep.equal({ message: 'Domain ownership conflict' });
    });
  });

  describe('onboard - new site (happy path)', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('onboards a new site successfully', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(res.value.id).to.equal(TEST_ONBOARDING_ID);
      expect(res.value.imsOrgId).to.equal(TEST_IMS_ORG_ID);
      expect(res.value.domain).to.equal(TEST_DOMAIN);
      expect(res.value.baseURL).to.equal(TEST_BASE_URL);

      expect(mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain)
        .to.have.been.calledWith(TEST_IMS_ORG_ID, TEST_DOMAIN);
      expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
        sinon.match({
          imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN, baseURL: TEST_BASE_URL, status: 'IN_PROGRESS',
        }),
      );

      expect(composeBaseURLStub).to.have.been.calledWith(TEST_DOMAIN);
      expect(loadProfileConfigStub).to.have.been.calledWith('aso_plg');
      expect(createOrFindOrganizationStub).to.have.been.calledWith(TEST_IMS_ORG_ID, context);
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(TEST_BASE_URL);
      expect(detectBotBlockerStub).to.have.been.calledWith({ baseUrl: TEST_BASE_URL });
      expect(findDeliveryTypeStub).to.have.been.calledWith(TEST_BASE_URL);
      expect(mockDataAccess.Site.create).to.have.been.called;
      expect(enableImportsStub).to.have.been.called;
      expect(enableAuditsStub).to.have.been.called;
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.called;
      expect(triggerAuditsStub).to.have.been.called;
      expect(triggerBrandProfileAgentStub).to.have.been.called;
      expect(configToDynamoItemStub).to.have.been.called;
      expect(mockSite.save).to.have.been.called;

      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(mockOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(mockOnboarding.setSiteId).to.have.been.calledWith(TEST_SITE_ID);
      expect(mockOnboarding.setCompletedAt).to.have.been.called;
      expect(mockOnboarding.setSteps).to.have.been.called;
      expect(mockOnboarding.setUpdatedBy).to.have.been.calledWith('admin');
      expect(mockOnboarding.save).to.have.been.called;
    });

    it('sets updatedBy to caller identity (admin when no email in profile)', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setUpdatedBy).to.have.been.calledWith('admin');
    });

    it('sets updatedBy to email when auth profile has email', async () => {
      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'ABC123' }], email: 'user@example.com' }) };
      const context = buildContext({ domain: TEST_DOMAIN }, { authInfo });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setUpdatedBy).to.have.been.calledWith('user@example.com');
    });

    it('sets createdBy when request comes from ASO UI on an existing record', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'IN_PROGRESS', createdBy: 'system' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'ABC123' }], email: 'ese@adobe.com' }) };
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo, headers: { 'x-client-type': 'sites-optimizer-ui' } },
      );

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingOnboarding.setCreatedBy).to.have.been.calledWith('ese@adobe.com');
    });

    it('does not set createdBy when request does not come from ASO UI', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'IN_PROGRESS', createdBy: 'system' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingOnboarding.setCreatedBy).to.not.have.been.called;
    });

    it('does not set createdBy when x-client-type is a different value', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'IN_PROGRESS', createdBy: 'system' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const context = buildContext(
        { domain: TEST_DOMAIN },
        { headers: { 'x-client-type': 'some-other-client' } },
      );

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingOnboarding.setCreatedBy).to.not.have.been.called;
    });

    it('sets createdBy when request comes from ASO UI on a WAITLISTED record', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'WAITLISTED', createdBy: 'system' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'ABC123' }], email: 'ese@adobe.com' }) };
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo, headers: { 'x-client-type': 'sites-optimizer-ui' } },
      );

      await controller.onboard(context);

      expect(existingOnboarding.setCreatedBy).to.have.been.calledWith('ese@adobe.com');
    });

    it('sets createdBy when request comes from ASO UI on an ERROR record', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'ERROR', createdBy: 'system' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'ABC123' }], email: 'ese@adobe.com' }) };
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo, headers: { 'x-client-type': 'sites-optimizer-ui' } },
      );

      await controller.onboard(context);

      expect(existingOnboarding.setCreatedBy).to.have.been.calledWith('ese@adobe.com');
    });

    it('sets createdBy when request comes from ASO UI on an OUTDATED record', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'OUTDATED', createdBy: 'system' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const authInfo = { getProfile: sandbox.stub().returns({ tenants: [{ id: 'ABC123' }], email: 'ese@adobe.com' }) };
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo, headers: { 'x-client-type': 'sites-optimizer-ui' } },
      );

      await controller.onboard(context);

      expect(existingOnboarding.setCreatedBy).to.have.been.calledWith('ese@adobe.com');
    });

    it('resumes existing onboarding record for same imsOrgId+domain', async () => {
      const existingOnboarding = createMockOnboarding({ status: 'ERROR' });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.PlgOnboarding.create).to.not.have.been.called;
      expect(existingOnboarding.setStatus).to.have.been.calledWith('IN_PROGRESS');
      expect(existingOnboarding.setError).to.have.been.calledWith(null);
      expect(existingOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(existingOnboarding.save).to.have.been.called;
    });

    it('resumes from WAITING_FOR_IP_ALLOWLISTING when site is now crawlable', async () => {
      const existingOnboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        steps: { orgResolved: true, rumVerified: true },
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.PlgOnboarding.create).to.not.have.been.called;
      expect(existingOnboarding.setStatus).to.have.been.calledWith('IN_PROGRESS');
      expect(existingOnboarding.setError).to.have.been.calledWith(null);
      expect(existingOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('resumes from WAITLISTED when domain ownership is resolved', async () => {
      const existingOnboarding = createMockOnboarding({
        status: 'WAITLISTED',
        steps: { orgResolved: true },
        waitlistReason: `Domain ${TEST_DOMAIN} is already assigned to another organization`,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingOnboarding);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.PlgOnboarding.create).to.not.have.been.called;
      expect(existingOnboarding.setStatus).to.have.been.calledWith('IN_PROGRESS');
      expect(existingOnboarding.setError).to.have.been.calledWith(null);
      expect(existingOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('sets locale when detected', async () => {
      detectLocaleStub.resolves({ language: 'fr', region: 'FR' });

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSite.setLanguage).to.have.been.calledWith('fr');
      expect(mockSite.setRegion).to.have.been.calledWith('FR');
    });

    it('falls back to en/US when locale detection fails', async () => {
      detectLocaleStub.rejects(new Error('timeout'));

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSite.setLanguage).to.have.been.calledWith('en');
      expect(mockSite.setRegion).to.have.been.calledWith('US');
    });

    it('sets overrideBaseURL when canonical differs', async () => {
      resolveCanonicalUrlStub.resolves('https://www.example.com');

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.have.been.calledWith({
        overrideBaseURL: 'https://www.example.com',
      });
    });

    it('skips overrideBaseURL when canonical matches', async () => {
      resolveCanonicalUrlStub.resolves(TEST_BASE_URL);

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.not.have.been.called;
    });

    it('skips overrideBaseURL when already set', async () => {
      mockSiteConfig.getFetchConfig.returns({
        overrideBaseURL: 'https://existing.com',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(resolveCanonicalUrlStub).to.not.have.been.called;
    });

    it('handles canonical URL resolution failure gracefully', async () => {
      resolveCanonicalUrlStub.rejects(new Error('network error'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to resolve canonical URL/);
    });

    it('sets overrideBaseURL preserving subpath when base URL has one', async () => {
      composeBaseURLStub.returns('https://example.com/blog');
      resolveCanonicalUrlStub.resolves('https://www.example.com/blog');

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.have.been.calledWith({
        overrideBaseURL: 'https://www.example.com/blog',
      });
    });

    it('handles null resolveCanonicalUrl result', async () => {
      resolveCanonicalUrlStub.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.not.have.been.called;
    });

    it('handles getFetchConfig returning null', async () => {
      mockSiteConfig.getFetchConfig.returns(null);
      resolveCanonicalUrlStub.resolves('https://www.example.com');

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSiteConfig.updateFetchConfig).to.have.been.called;
    });

    it('handles profile with undefined imports and audits', async () => {
      loadProfileConfigStub.returns({});

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
    });

    it('creates a project and assigns it to the site', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockDataAccess.Project.create).to.have.been.calledWith({
        projectName: 'example.com',
        organizationId: TEST_ORG_ID,
      });
      expect(mockSite.setProjectId).to.have.been.calledWith(TEST_PROJECT_ID);
    });

    it('reuses existing project when found', async () => {
      mockDataAccess.Project.allByOrganizationId.resolves([mockProject]);

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockDataAccess.Project.create).to.not.have.been.called;
      expect(mockSite.setProjectId).to.have.been.calledWith(TEST_PROJECT_ID);
    });

    it('skips project assignment when site already has one', async () => {
      mockSite = createMockSite({ projectId: 'existing-project-id' });
      mockDataAccess.Site.create.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockSite.setProjectId).to.not.have.been.called;
    });

    it('auto-resolves author URL and sets deliveryConfig with preferContentApi and imsOrgId', async () => {
      autoResolveAuthorUrlStub.resolves({
        authorURL: 'https://author-p123-e456.adobeaemcloud.com',
        programId: '123',
        environmentId: '456',
        host: 'publish-p123-e456.adobeaemcloud.net',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(autoResolveAuthorUrlStub).to.have.been.calledWith(mockSite, context);
      expect(mockSite.setDeliveryType).to.have.been.calledWith(SiteModel.DELIVERY_TYPES.AEM_CS);
      expect(mockSite.setDeliveryConfig).to.have.been.calledWith({
        authorURL: 'https://author-p123-e456.adobeaemcloud.com',
        programId: '123',
        environmentId: '456',
        preferContentApi: true,
        enableDAMAltTextUpdate: true,
        imsOrgId: TEST_IMS_ORG_ID,
      });
    });

    it('handles null deliveryConfig when resolving author URL', async () => {
      mockSite = createMockSite({ deliveryConfig: null });
      mockSite.getDeliveryConfig.returns(null);
      mockDataAccess.Site.create.resolves(mockSite);

      autoResolveAuthorUrlStub.resolves({
        authorURL: 'https://author-p123-e456.adobeaemcloud.com',
        programId: '123',
        environmentId: '456',
        host: 'publish-p123-e456.adobeaemcloud.net',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setDeliveryType).to.have.been.calledWith(SiteModel.DELIVERY_TYPES.AEM_CS);
      expect(mockSite.setDeliveryConfig).to.have.been.calledWith({
        authorURL: 'https://author-p123-e456.adobeaemcloud.com',
        programId: '123',
        environmentId: '456',
        preferContentApi: true,
        enableDAMAltTextUpdate: true,
        imsOrgId: TEST_IMS_ORG_ID,
      });
    });

    it('skips setting deliveryConfig when authorURL already set but still resolves RUM host', async () => {
      mockSite = createMockSite({
        deliveryConfig: { authorURL: 'https://existing-author.adobeaemcloud.com' },
      });
      mockDataAccess.Site.create.resolves(mockSite);

      autoResolveAuthorUrlStub.resolves({
        host: 'main--my-site--adobe.aem.live',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(autoResolveAuthorUrlStub).to.have.been.called;
      expect(mockSite.setDeliveryConfig).to.not.have.been.called;
      expect(updateCodeConfigStub).to.have.been.calledWith(
        mockSite,
        'main--my-site--adobe.aem.live',
        sinon.match.object,
        sinon.match.object,
      );
    });

    it('continues onboarding when author URL resolution fails', async () => {
      autoResolveAuthorUrlStub.rejects(new Error('RUM service down'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to auto-resolve author URL/);
    });

    it('skips setting deliveryConfig when autoResolveAuthorUrl returns null', async () => {
      autoResolveAuthorUrlStub.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setDeliveryConfig).to.not.have.been.called;
    });

    it('skips setting deliveryConfig when autoResolveAuthorUrl returns no authorURL', async () => {
      autoResolveAuthorUrlStub.resolves({ host: 'some-host.net' });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setDeliveryConfig).to.not.have.been.called;
    });

    it('calls updateCodeConfig with RUM host from autoResolveAuthorUrl', async () => {
      autoResolveAuthorUrlStub.resolves({
        authorURL: 'https://author-p123-e456.adobeaemcloud.com',
        programId: '123',
        environmentId: '456',
        host: 'publish-p123-e456.adobeaemcloud.net',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(updateCodeConfigStub).to.have.been.calledWith(
        mockSite,
        'publish-p123-e456.adobeaemcloud.net',
        sinon.match({ say: sinon.match.func }),
        sinon.match.object,
      );
    });

    it('passes null host to updateCodeConfig when autoResolveAuthorUrl returns null', async () => {
      autoResolveAuthorUrlStub.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(updateCodeConfigStub).to.have.been.calledWith(
        mockSite,
        null,
        sinon.match({ say: sinon.match.func }),
        sinon.match.object,
      );
    });

    it('sets codeConfigResolved step when code config is resolved', async () => {
      mockSite.getCode.returns({ owner: 'adobe', repo: 'my-site', ref: 'main' });

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      const stepsCall = mockOnboarding.setSteps.lastCall.args[0];
      expect(stepsCall.codeConfigResolved).to.be.true;
    });

    it('continues onboarding when updateCodeConfig fails', async () => {
      updateCodeConfigStub.rejects(new Error('pattern match failed'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to resolve code config/);
    });

    it('sets hlxConfig for EDS sites from RUM host', async () => {
      autoResolveAuthorUrlStub.resolves({
        host: 'main--my-site--adobe.aem.live',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setHlxConfig).to.have.been.calledWith({
        hlxVersion: 5,
        rso: {
          ref: 'main', site: 'my-site', owner: 'adobe', tld: 'aem.live',
        },
      });
    });

    it('sets hlxConfig for hlx.live hosts', async () => {
      autoResolveAuthorUrlStub.resolves({
        host: 'main--my-site--adobe.hlx.live',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setHlxConfig).to.have.been.calledWith({
        hlxVersion: 5,
        rso: {
          ref: 'main', site: 'my-site', owner: 'adobe', tld: 'hlx.live',
        },
      });
    });

    it('skips hlxConfig when already set', async () => {
      mockSite = createMockSite({
        hlxConfig: {
          hlxVersion: 5,
          rso: {
            ref: 'main', site: 'existing', owner: 'org', tld: 'aem.live',
          },
        },
      });
      mockDataAccess.Site.create.resolves(mockSite);

      autoResolveAuthorUrlStub.resolves({
        host: 'main--my-site--adobe.aem.live',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setHlxConfig).to.not.have.been.called;
    });

    it('skips hlxConfig when RUM host is not EDS pattern', async () => {
      autoResolveAuthorUrlStub.resolves({
        authorURL: 'https://author-p123-e456.adobeaemcloud.com',
        programId: '123',
        environmentId: '456',
        host: 'publish-p123-e456.adobeaemcloud.net',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setHlxConfig).to.not.have.been.called;
    });

    it('skips hlxConfig when no RUM host available', async () => {
      autoResolveAuthorUrlStub.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSite.setHlxConfig).to.not.have.been.called;
    });
  });

  describe('onboard - bot blocker', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('returns WAITING_FOR_IP_ALLOWLISTING when bot blocked (new site)', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus)
        .to.have.been.calledWith('WAITING_FOR_IP_ALLOWLISTING');
      expect(mockOnboarding.setBotBlocker).to.have.been.calledWith({
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      });
      expect(mockOnboarding.save).to.have.been.called;
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });

    it('returns WAITING_FOR_IP_ALLOWLISTING for existing site in same org', async () => {
      const existingSite = createMockSite({ orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'akamai',
        userAgent: 'SpaceCat/1.0',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus)
        .to.have.been.calledWith('WAITING_FOR_IP_ALLOWLISTING');
    });

    it('uses ipsToWhitelist fallback for bot blocker', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'generic',
        // eslint-disable-next-line id-match
        ipsToWhitelist: ['5.6.7.8'],
        userAgent: 'Bot/2.0',
      });

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(mockOnboarding.setBotBlocker).to.have.been.calledWith({
        type: 'generic',
        ipsToAllowlist: ['5.6.7.8'],
        userAgent: 'Bot/2.0',
      });
    });

    it('sets waitlist reason with IPs and user-agent when bot blocked', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4', '5.6.7.8'],
        userAgent: 'SpaceCat/1.0',
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/blocked by a bot blocker of type 'cloudflare'/);
      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/1\.2\.3\.4.*5\.6\.7\.8/);
      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/SpaceCat\/1\.0/);
    });

    it('sets waitlist reason without IPs when ipsToAllowlist is empty', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'akamai',
        userAgent: 'SpaceCat/1.0',
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/blocked by a bot blocker of type 'akamai'/);
      expect(mockOnboarding.setWaitlistReason).to.not.have.been.calledWithMatch(/IPs must be allowlisted/);
    });

    it('sets waitlist reason without user-agent when not provided', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(mockOnboarding.setWaitlistReason).to.have.been.calledWithMatch(/blocked by a bot blocker of type 'cloudflare'/);
      expect(mockOnboarding.setWaitlistReason).to.not.have.been.calledWithMatch(/User-agent used/);
    });

    it('sets waitlist reason before setBotBlocker', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledBefore(mockOnboarding.setBotBlocker);
    });
  });

  describe('onboard - RUM check', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('continues onboarding when no RUM data for domain', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No domainkey found'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.not.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(detectBotBlockerStub).to.have.been.called;
      expect(mockDataAccess.Site.create).to.have.been.called;
    });
  });

  describe('onboard - existing site in customer org', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('onboards existing site belonging to customer org', async () => {
      const existingSite = createMockSite({ orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      expect(mockDataAccess.Site.create).to.not.have.been.called;
      expect(enableAuditsStub).to.have.been.called;
      expect(enableImportsStub).to.have.been.called;
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });
  });

  describe('onboard - existing site in internal org', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('waitlists when site belongs to DEFAULT_ORGANIZATION_ID', async () => {
      const existingSite = createMockSite({ orgId: DEFAULT_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/already assigned to another organization/);
    });

    it('continues onboarding when site belongs to ASO_DEMO_ORG with no enrollments', async () => {
      const existingSite = createMockSite({ orgId: DEMO_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Site.findById.resolves(createMockSite({ orgId: TEST_ORG_ID }));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.not.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('continues onboarding when site in demo org has enrollments (internal org bypass)', async () => {
      const existingSite = createMockSite({
        orgId: DEMO_ORG_ID,
        siteEnrollments: [{ getId: () => 'enroll-1' }],
      });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Site.findById.resolves(createMockSite({ orgId: TEST_ORG_ID }));

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.not.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(existingSite.save).to.have.been.called;
      expect(mockOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
    });

    it('returns 400 when site id is listed in ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS', async () => {
      const existingSite = createMockSite({ orgId: DEMO_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = {
        ...buildContext({ domain: TEST_DOMAIN }),
        env: {
          ...mockEnv,
          ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS: `${TEST_SITE_ID}, other-site-uuid`,
        },
      };

      const res = await controller.onboard(context);

      expect(res.status).to.equal(400);
    });

    it('treats org as non-internal when ASO_PLG_EXCLUDED_ORGS is not set', async () => {
      const existingSite = createMockSite({
        orgId: DEMO_ORG_ID,
        siteEnrollments: [{ getId: () => 'enroll-1' }],
      });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = { ...buildContext({ domain: TEST_DOMAIN }), env: {} };
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/cannot be moved/);
    });
  });

  describe('onboard - existing site in different customer org', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
    });

    it('returns WAITLISTED when site belongs to another customer org', async () => {
      const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      expect(existingSite.save).to.not.have.been.called;
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/already assigned to another organization/);
      expect(mockOnboarding.setSiteId).to.have.been.calledWith(existingSite.getId());
      expect(mockOnboarding.save).to.have.been.called;
      expect(detectBotBlockerStub).to.not.have.been.called;
    });

    it('uses org ID as fallback in waitlist reason when Organization.findById returns null', async () => {
      const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findById.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/already assigned to another organization/);
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(new RegExp(OTHER_CUSTOMER_ORG_ID));
    });

    it('appends move suggestion to waitlist reason when site has no enrollments', async () => {
      const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID, siteEnrollments: [] });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/no active products in its existing org/);
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/safely moved to 'Test Org'/);
    });

    it('does not append move suggestion to waitlist reason when site has active enrollments', async () => {
      const existingSite = createMockSite({
        orgId: OTHER_CUSTOMER_ORG_ID,
        siteEnrollments: [{ getId: () => 'enroll-1' }],
      });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/already assigned to another organization/);
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/cannot be moved.*active products/);
    });
  });

  describe('onboard - non-production domain guard', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingControllerFactory({ log: mockLog });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([]);
      mockDataAccess.PlgOnboarding.create.resolves(mockOnboarding);
    });

    const NON_PROD_DOMAINS = [
      // non-prod subdomain keywords
      'qa.example.com',
      'stage.example.com',
      'staging.example.com',
      'dev.example.com',
      'development.example.com',
      'example.qa.com',
      'example.stage.com',
      'experience-qa.adobe.com',
      'dev-preview.example.com',
      'example-stage.com',
      'qa-internal.example.com',
      'newweb-qa2.infineon.cn',
      'stage2.example.com',
      'dev3-preview.example.com',
      // author/publish keywords
      'author-mls-prod-65a.adobecqms.net',
      'publish-lottretail.corp.tlclimited.com',
      'author.example.com',
      'publish.example.com',
      // hlx/AEM delivery URLs
      'main--notice--softbankbtob.aem.page',
      'bundled-journey-qa-1--forms-engine-qa--hdfc-forms.aem.live',
      'main--mysite--owner.hlx.live',
      'main--mysite--owner.hlx.page',
    ];

    for (const domain of NON_PROD_DOMAINS) {
      // eslint-disable-next-line no-loop-func
      it(`waitlists domain containing non-prod subdomain: ${domain}`, async () => {
        mockOnboarding.getDomain.returns(domain);
        const context = buildContext({ domain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(200);
        expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
        expect(mockOnboarding.setWaitlistReason)
          .to.have.been.calledWithMatch(/non-production domain/);
        expect(mockOnboarding.setSteps).to.not.have.been
          .calledWithMatch({ nonProdCheckBypassed: true });
      });
    }

    it('does not waitlist a normal production domain', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('does not waitlist a .dev TLD domain (legitimate production gTLD)', async () => {
      mockOnboarding.getDomain.returns('mysite.dev');
      const context = buildContext({ domain: 'mysite.dev' });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('does not waitlist a web.dev domain (legitimate production gTLD)', async () => {
      mockOnboarding.getDomain.returns('web.dev');
      const context = buildContext({ domain: 'web.dev' });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('skips non-prod guard when steps.nonProdCheckBypassed is already true (re-entrancy guard)', async () => {
      // Simulates a bypass handler re-running the flow after the guard already fired
      mockOnboarding.getDomain.returns('dev.example.com');
      mockOnboarding.getSteps.returns({ nonProdCheckBypassed: true });
      const context = buildContext({ domain: 'dev.example.com' });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      // Guard must not fire again — status should reach ONBOARDED, not WAITLISTED
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(mockOnboarding.setStatus).to.not.have.been.calledWith('WAITLISTED');
    });
  });
});
