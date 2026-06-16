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

  describe('onboard - already ONBOARDED domain', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
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
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('resumes when concurrent create causes unique violation', async () => {
      mockDataAccess.PlgOnboarding.create.rejects(
        new Error('unique constraint violation'),
      );
      // Second findByImsOrgIdAndDomain call returns the record
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
      controller = PlgOnboardingController({ log: mockLog });
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
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('onboards a new site successfully', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(res.value.id).to.equal(TEST_ONBOARDING_ID);
      expect(res.value.imsOrgId).to.equal(TEST_IMS_ORG_ID);
      expect(res.value.domain).to.equal(TEST_DOMAIN);
      expect(res.value.baseURL).to.equal(TEST_BASE_URL);

      // Verify imsOrgId derived from token, not body
      expect(mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain)
        .to.have.been.calledWith(TEST_IMS_ORG_ID, TEST_DOMAIN);
      expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith(
        sinon.match({
          imsOrgId: TEST_IMS_ORG_ID, domain: TEST_DOMAIN, baseURL: TEST_BASE_URL, status: 'IN_PROGRESS',
        }),
      );

      // Verify flow
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

      // Verify onboarding record updated with final status
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
      // But RUM host is still passed to updateCodeConfig
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
      controller = PlgOnboardingController({ log: mockLog });
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
      // Verify onboarding record was updated with bot blocker status
      expect(mockOnboarding.setStatus)
        .to.have.been.calledWith('WAITING_FOR_IP_ALLOWLISTING');
      expect(mockOnboarding.setBotBlocker).to.have.been.calledWith({
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      });
      expect(mockOnboarding.save).to.have.been.called;
      // Should NOT create a site
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
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('continues onboarding when no RUM data for domain', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No domainkey found'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      // Should NOT be waitlisted — onboarding continues
      expect(mockOnboarding.setStatus).to.not.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      // Should proceed to bot blocker and site creation
      expect(detectBotBlockerStub).to.have.been.called;
      expect(mockDataAccess.Site.create).to.have.been.called;
    });
  });

  describe('onboard - existing site in customer org', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('onboards existing site belonging to customer org', async () => {
      const existingSite = createMockSite({ orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      // Should NOT reassign org
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      // Should NOT create a new site
      expect(mockDataAccess.Site.create).to.not.have.been.called;
      // Should still enable audits, imports, entitlement
      expect(enableAuditsStub).to.have.been.called;
      expect(enableImportsStub).to.have.been.called;
      expect(mockDataAccess.SiteEnrollment.create).to.have.been.called;
      // Verify onboarding record completed
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });
  });

  describe('onboard - existing site in internal org', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
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
      // Verify site org is reassigned to the new customer org
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(existingSite.save).to.have.been.called;
      // Verify PlgOnboarding org is also updated to match
      expect(mockOnboarding.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
    });

    it('waitlists when site id is listed in ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS', async () => {
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

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
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
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns WAITLISTED when site belongs to another customer org', async () => {
      const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      // Should NOT modify the site
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      expect(existingSite.save).to.not.have.been.called;
      // Verify onboarding record was set to WAITLISTED with reason
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/already assigned to another organization/);
      expect(mockOnboarding.setSiteId).to.have.been.calledWith(existingSite.getId());
      expect(mockOnboarding.save).to.have.been.called;
      // Should NOT proceed to bot blocker or site creation
      expect(detectBotBlockerStub).to.not.have.been.called;
    });

    it('uses org ID as fallback in waitlist reason when Organization.findById returns null', async () => {
      const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findById.resolves(null); // triggers || existingOrgId fallback

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/already assigned to another organization/);
      // Falls back to org UUID in the reason since no org was found
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

  describe('onboard - one domain per IMS org', () => {
    let controller;

    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
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
      // Should NOT proceed to org resolution or site creation
      expect(createOrFindOrganizationStub).to.not.have.been.called;
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });

    it('waitlists and uses org ID as fallback name when Organization.findById returns null for already-onboarded record', async () => {
      const onboardedRecord = createMockOnboarding({
        id: 'other-onboarding-id',
        domain: 'other-domain.com',
        status: 'ONBOARDED',
        organizationId: OTHER_CUSTOMER_ORG_ID, // has org ID so findById is called
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Organization.findById.resolves(null); // org not found — fallback to org ID

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

      // The new domain still gets onboarded
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
      // postPlgOnboardingNotification has its own internal try/catch for postSlackMessage,
      // so the outer catch at lines 710-711 fires only when something else inside the
      // function throws unexpectedly. getImsOrgId() is an unprotected call — making it
      // throw exercises that exact path without needing a separate esmock.
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

      // Onboarding still succeeds despite notification failure
      expect(res.status).to.equal(200);
      // Peer record was saved before notification was attempted
      expect(staleRecord.save).to.have.been.called;
      // Notification failure is logged as a warning, not rethrown
      expect(mockLog.warn).to.have.been.calledWithMatch(
        /Failed to post OUTDATED notification for domain stale-domain\.com/,
      );
      // Main onboarding proceeded normally
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
      mockDataAccess.Opportunity.allBySiteId.resolves([]); // no opportunities → no suggestions

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

      // Old domain is marked OUTDATED with system OFFBOARDED review
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(onboardedRecord.setWaitlistReason).to.have.been.calledWith(null);
      expect(onboardedRecord.setReviews).to.have.been.called;
      const offboardedReviews = onboardedRecord.setReviews.lastCall.args[0];
      expect(offboardedReviews[offboardedReviews.length - 1].justification).to.match(/Automatically offboarded by system/);
      expect(onboardedRecord.setUpdatedBy).to.have.been.calledWith('system');
      expect(onboardedRecord.save).to.have.been.called;

      // Only the ASO enrollment is revoked
      expect(mockDataAccess.Entitlement.allByOrganizationId).to.have.been.calledWith(OLD_ORG_ID);
      expect(mockDataAccess.SiteEnrollment.allByEntitlementId)
        .to.have.been.calledWith(ASO_ENTITLEMENT_ID);
      expect(mockEnrollmentToRevoke.remove).to.have.been.called;

      // New domain is onboarded
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

      // Old domain is NOT displaced
      expect(onboardedRecord.setStatus).not.to.have.been.called;

      // New domain is waitlisted (conservative fallback)
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

      // Audit ran (lastAuditedAt set) but no open suggestions — nothing left to protect
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
      // When the onboarded record has no siteId, displacement is skipped entirely
      // (canDisplace is false because alreadyOnboardedSiteId is falsy). Opportunity
      // lookup must not be called with a null/undefined siteId.
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

      // Displacement skipped — Opportunity lookup never called with null siteId
      expect(mockDataAccess.Opportunity.allBySiteId).not.to.have.been.called;
      expect(onboardedRecord.setStatus).not.to.have.been.called;

      // New domain is waitlisted
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
        organizationId: null, // no org ID
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([onboardedRecord]);
      mockDataAccess.Opportunity.allBySiteId.resolves([]); // no suggestions

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);

      // Old domain is displaced (OUTDATED)
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(onboardedRecord.save).to.have.been.called;

      // No enrollment revocation attempted for displaced record (no org ID on old record)
      expect(mockDataAccess.Entitlement.allByOrganizationId).not.to.have.been.calledWith(null);

      // New domain is onboarded
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
      mockDataAccess.Opportunity.allBySiteId.resolves([]); // no suggestions

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_OLD_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);

      // Old domain is still waitlisted
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');

      // ASO revocation must be SKIPPED — entitlement lookup never runs for internal old org.
      expect(mockDataAccess.Entitlement.allByOrganizationId)
        .not.to.have.been.calledWith(INTERNAL_OLD_ORG_ID);
      expect(mockLog.error).to.have.been.calledWithMatch(
        /Refusing to revoke ASO enrollment.*previous org .* is internal\/demo/,
      );

      // New domain is onboarded
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
      mockDataAccess.Opportunity.allBySiteId.resolves([]); // no suggestions

      // Entitlement exists but is not ASO — no enrollment revocation should happen for old site
      mockDataAccess.Entitlement.allByOrganizationId.resolves([
        { getId: sandbox.stub().returns(NON_ASO_ENT_ID), getProductCode: sandbox.stub().returns('other_product') },
      ]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);

      // Displacement proceeds; enrollment for the non-ASO entitlement was never queried
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(mockDataAccess.SiteEnrollment.allByEntitlementId)
        .not.to.have.been.calledWith(NON_ASO_ENT_ID);

      // New domain is onboarded
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
      mockDataAccess.Opportunity.allBySiteId.resolves([]); // no suggestions

      mockDataAccess.Entitlement.allByOrganizationId.resolves([
        {
          getId: sandbox.stub().returns(ASO_ENTITLEMENT_ID),
          getProductCode: sandbox.stub().returns(ASO_PRODUCT_CODE),
          getTier: sandbox.stub().returns('PLG'),
        },
      ]);

      // Simulate enrollment revocation failure on the first call (displacement),
      // but succeed on subsequent calls (normal onboarding flow)
      mockDataAccess.SiteEnrollment.allByEntitlementId
        .onFirstCall().rejects(new Error('DB timeout'))
        .resolves([]);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      // Displacement still completes — revocation failure is non-fatal
      expect(res.status).to.equal(200);

      // Old domain is displaced (OUTDATED)
      expect(onboardedRecord.setStatus).to.have.been.calledWith('OUTDATED');
      expect(onboardedRecord.save).to.have.been.called;

      // Revocation failure was logged as error
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to revoke ASO enrollment/);

      // New domain is still onboarded
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });
  });
});
