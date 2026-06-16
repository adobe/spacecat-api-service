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
  TEST_IMS_ORG_ID,
  TEST_ORG_ID,
  TEST_SITE_ID,
  TEST_ONBOARDING_ID,
  DEMO_ORG_ID,
  OTHER_CUSTOMER_ORG_ID,
  ASO_PRODUCT_CODE,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  mockAuthInfo as mockAuthInfoShared,
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

  function mockAuthInfo(imsOrgId = TEST_IMS_ORG_ID) {
    return mockAuthInfoShared(sandbox, imsOrgId);
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

  describe('getStatus', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns 400 for invalid imsOrgId', async () => {
      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: 'not-valid' },
        attributes: { authInfo: mockAuthInfo() },
      });

      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required');
    });

    it('returns 400 for empty imsOrgId', async () => {
      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: '' },
        attributes: { authInfo: mockAuthInfo() },
      });

      expect(res.status).to.equal(400);
    });

    it('returns 403 when caller org does not match requested org', async () => {
      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: 'OTHER999@AdobeOrg' },
        attributes: { authInfo: mockAuthInfo() },
      });

      expect(res.status).to.equal(403);
    });

    it('allows access when requested org matches a non-first tenant', async () => {
      const secondOrgId = 'BBBBBBBBBBBBBBBBBBBBBBBB@AdobeOrg';
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([createMockOnboarding()]);

      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: secondOrgId },
        attributes: {
          authInfo: {
            getProfile: sandbox.stub().returns({
              tenants: [
                { id: 'ABC123' },
                { id: 'BBBBBBBBBBBBBBBBBBBBBBBB' },
              ],
            }),
          },
        },
      });

      expect(res.status).to.equal(200);
    });

    it('returns 400 when authInfo is missing', async () => {
      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: {},
      });

      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Authentication information is required');
    });

    it('returns 400 when profile has no tenants', async () => {
      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: { getProfile: sandbox.stub().returns({}) } },
      });

      expect(res.status).to.equal(400);
      expect(res.value).to.equal('User profile or organization ID not found in authentication token');
    });

    it('returns 404 when no records found', async () => {
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([]);

      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: mockAuthInfo() },
      });

      expect(res.status).to.equal(404);
      expect(res.value).to.include('No onboarding records found');
    });

    it('returns onboarding records for valid imsOrgId', async () => {
      const record1 = createMockOnboarding({
        id: 'rec-1',
        domain: 'example1.com',
        status: 'ONBOARDED',
      });
      const record2 = createMockOnboarding({
        id: 'rec-2',
        domain: 'example2.com',
        status: 'IN_PROGRESS',
      });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record1, record2]);

      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: { authInfo: mockAuthInfo() },
      });

      expect(res.status).to.equal(200);
      expect(res.value).to.be.an('array').with.length(2);
      expect(res.value[0].id).to.equal('rec-1');
      expect(res.value[0].domain).to.equal('example1.com');
      expect(res.value[1].id).to.equal('rec-2');
      expect(res.value[1].domain).to.equal('example2.com');
    });
  });

  describe('getStatus - admin bypass', () => {
    let AdminPlgOnboardingController;

    beforeEach(async () => {
      AdminPlgOnboardingController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            createResponse: (body, status) => ({ status, value: body }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            noContent: () => ({ status: 204 }),
            notFound: (msg) => ({ status: 404, value: msg }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({
                retrieveDomainkey: rumRetrieveDomainkeyStub,
              }),
            },
          },
          '@adobe/spacecat-shared-launchdarkly-client': {
            default: ldCreateFromStub,
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
              fromContext: () => ({ hasAdminAccess: () => true }),
            },
          },
          '../../../../src/support/rum-config-service.js': {
            updateRumConfig: updateRumConfigStub,
          },
        },
      )).default;
    });

    it('allows admin to access any org without tenant match', async () => {
      const record = createMockOnboarding({ status: 'ONBOARDED' });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);

      const res = await AdminPlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: 'COMPLETELY_DIFFERENT@AdobeOrg' },
        attributes: {
          authInfo: {
            getProfile: sandbox.stub().returns({ tenants: [{ id: 'ADMIN_TENANT' }] }),
          },
        },
      });

      expect(res.status).to.equal(200);
      expect(res.value).to.be.an('array').with.length(1);
    });

    it('allows admin even when authInfo has no profile tenants', async () => {
      const record = createMockOnboarding({ status: 'ONBOARDED' });
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([record]);

      const res = await AdminPlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: {
          authInfo: {
            getProfile: sandbox.stub().returns(null),
          },
        },
      });

      expect(res.status).to.equal(200);
    });

    it('still returns 400 for missing authInfo even as admin path', async () => {
      const res = await AdminPlgOnboardingController({ log: mockLog }).getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
        attributes: {},
      });

      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Authentication information is required');
    });

    describe('read-only admin denial', () => {
      // PLG onboarding flow is gated by hasAdminAccess() (full admin only).
      // A read-only admin token has hasAdminAccess()=false and falls through to
      // the tenant-match path, so it cannot bypass the org check the way a full
      // admin can.
      let ReadOnlyAdminPlgController;

      beforeEach(async () => {
        ReadOnlyAdminPlgController = (await esmock(
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
              created: (data) => ({ status: 201, value: data }),
              createResponse: (body, status) => ({ status, value: body }),
              forbidden: (msg) => ({ status: 403, value: msg }),
              internalServerError: (msg) => ({ status: 500, value: msg }),
              noContent: () => ({ status: 204 }),
              notFound: (msg) => ({ status: 404, value: msg }),
              ok: (data) => ({ status: 200, value: data }),
            },
            '@adobe/spacecat-shared-rum-api-client': {
              default: {
                createFrom: sandbox.stub().returns({
                  retrieveDomainkey: rumRetrieveDomainkeyStub,
                }),
              },
            },
            '@adobe/spacecat-shared-launchdarkly-client': {
              default: ldCreateFromStub,
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
                TIERS: { FREE_TRIAL: 'FREE_TRIAL', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD' },
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
              updateCodeConfig: updateCodeConfigStub,
              findDeliveryType: findDeliveryTypeStub,
              deriveProjectName: deriveProjectNameStub,
            },
            '../../../../src/utils/slack/base.js': {
              loadProfileConfig: loadProfileConfigStub,
            },
            '../../../../src/support/brand-profile-trigger.js': {
              triggerBrandProfileAgent: triggerBrandProfileAgentStub,
            },
            // Read-only admin: hasAdminAccess() is false, hasAdminReadAccess() is true.
            // The controller should NOT use hasAdminReadAccess for this flow.
            '../../../../src/support/access-control-util.js': {
              default: {
                fromContext: () => ({
                  hasAdminAccess: () => false,
                  hasAdminReadAccess: () => true,
                }),
              },
            },
            '../../../../src/support/rum-config-service.js': {
              updateRumConfig: updateRumConfigStub,
            },
          },
        )).default;
      });

      it('falls through to tenant check; denies read-only admin on a non-matching org', async () => {
        const res = await ReadOnlyAdminPlgController({ log: mockLog }).getStatus({
          dataAccess: mockDataAccess,
          params: { imsOrgId: 'COMPLETELY_DIFFERENT@AdobeOrg' },
          attributes: {
            authInfo: {
              getProfile: sandbox.stub().returns({
                tenants: [{ id: 'READONLY_TENANT' }],
              }),
            },
          },
        });

        expect(res.status).to.equal(403);
        expect(mockDataAccess.PlgOnboarding.allByImsOrgId).to.not.have.been.called;
      });

      it('does not bypass when read-only admin has no tenants in profile', async () => {
        const res = await ReadOnlyAdminPlgController({ log: mockLog }).getStatus({
          dataAccess: mockDataAccess,
          params: { imsOrgId: TEST_IMS_ORG_ID },
          attributes: {
            authInfo: { getProfile: sandbox.stub().returns({}) },
          },
        });

        // Full admin would have returned 200; read-only admin falls through to
        // the tenant-not-found branch and receives 400.
        expect(res.status).to.equal(400);
        expect(res.value).to.equal('User profile or organization ID not found in authentication token');
      });
    });

    describe('getAllOnboardings', () => {
      beforeEach(() => {
        mockDataAccess.PlgOnboarding.all.reset();
        mockDataAccess.PlgOnboarding.all.resolves([]);
      });

      it('returns 403 when caller is not admin', async () => {
        const nonAdminController = PlgOnboardingController({ log: mockLog });
        const res = await nonAdminController.getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });

        expect(res.status).to.equal(403);
        expect(res.value).to.equal('Only admins can list all PLG onboarding records');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 200 with all records when admin', async () => {
        const record = createMockOnboarding({
          id: 'all-rec-1',
          domain: 'plg-all.example.com',
          status: 'ONBOARDED',
        });
        mockDataAccess.PlgOnboarding.all.resolves([record]);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').with.length(1);
        expect(res.value[0].id).to.equal('all-rec-1');
        expect(res.value[0].domain).to.equal('plg-all.example.com');
        expect(mockDataAccess.PlgOnboarding.all).to.have.been.calledOnceWith(
          {},
          { fetchAllPages: true },
        );
      });

      it('returns 200 and passes limit when admin sends limit', async () => {
        mockDataAccess.PlgOnboarding.all.resolves([]);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '50' },
        });

        expect(res.status).to.equal(200);
        expect(mockDataAccess.PlgOnboarding.all).to.have.been.calledOnceWith(
          {},
          { limit: 50 },
        );
      });

      it('returns 200 with one-item array when limit is 1 (data access returns single instance)', async () => {
        const record = createMockOnboarding({
          id: 'limit-1-rec',
          domain: 'one.example.com',
          status: 'ONBOARDED',
        });
        mockDataAccess.PlgOnboarding.all.resolves(record);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '1' },
        });

        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').with.length(1);
        expect(res.value[0].id).to.equal('limit-1-rec');
        expect(mockDataAccess.PlgOnboarding.all).to.have.been.calledOnceWith(
          {},
          { limit: 1 },
        );
      });

      it('returns 200 with empty array when limit is 1 and data access returns null', async () => {
        mockDataAccess.PlgOnboarding.all.resolves(null);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '1' },
        });

        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').that.is.empty;
      });

      it('returns 200 with empty array when limit is 1 and data access returns undefined', async () => {
        mockDataAccess.PlgOnboarding.all.resolves(undefined);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '1' },
        });

        expect(res.status).to.equal(200);
        expect(res.value).to.be.an('array').that.is.empty;
      });

      it('returns 500 when data access returns a non-model value', async () => {
        mockDataAccess.PlgOnboarding.all.resolves(0);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '1' },
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to list PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(
          sinon.match(/^Unexpected PLG onboarding list result shape/),
        );
      });

      it('returns 500 when DTO serialization throws an Error', async () => {
        const record = createMockOnboarding({ id: 'bad-ser' });
        record.getId.throws(new Error('broken model'));

        mockDataAccess.PlgOnboarding.all.resolves([record]);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to serialize PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(
          sinon.match(/^Failed to serialize PLG onboarding records: broken model/),
        );
      });

      it('returns 500 when DTO serialization throws a non-Error', async () => {
        const record = createMockOnboarding();
        record.getId.callsFake(() => {
          // eslint-disable-next-line no-throw-literal -- non-Error catch branch in controller
          throw 'not an Error object';
        });

        mockDataAccess.PlgOnboarding.all.resolves([record]);

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to serialize PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(
          sinon.match(/^Failed to serialize PLG onboarding records: not an Error object/),
        );
      });

      it('returns 400 when limit is not a positive integer', async () => {
        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '0' },
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 400 when limit is a decimal string (not an integer token)', async () => {
        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '1.5' },
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 400 when limit has trailing non-digits', async () => {
        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '50abc' },
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 400 when limit is negative', async () => {
        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
          data: { limit: '-1' },
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('limit must be a positive integer');
        expect(mockDataAccess.PlgOnboarding.all).to.not.have.been.called;
      });

      it('returns 500 when data access fails', async () => {
        mockDataAccess.PlgOnboarding.all.rejects(new Error('db unavailable'));

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to list PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(
          sinon.match(/^Failed to list PLG onboardings: db unavailable/),
        );
      });

      it('returns 500 when data access rejects with a non-Error', async () => {
        /* eslint-disable-next-line prefer-promise-reject-errors -- non-Error catch in controller */
        mockDataAccess.PlgOnboarding.all.returns(Promise.reject('connection reset'));

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          log: mockLog,
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to list PLG onboarding records');
        expect(mockLog.error).to.have.been.calledWithMatch(
          sinon.match(/^Failed to list PLG onboardings: connection reset/),
        );
      });

      it('resolves updatedBy to email via getImsAdminProfile when updatedBy is set', async () => {
        const record = createMockOnboarding({ updatedBy: 'user-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().resolves({ email: 'user@example.com' }),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.equal('user@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnceWith('user-ims-id@AdobeID');
      });

      it('falls back to IMS ID when getImsAdminProfile returns no email', async () => {
        const record = createMockOnboarding({ updatedBy: 'user-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().resolves({}),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.equal('user-ims-id@AdobeID');
      });

      it('falls back to IMS ID when getImsAdminProfile fails', async () => {
        const record = createMockOnboarding({ updatedBy: 'bad-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().rejects(new Error('IMS unavailable')),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.equal('bad-ims-id@AdobeID');
        expect(mockLog.warn).to.have.been.calledWithMatch(
          sinon.match(/Failed to resolve email for IMS ID bad-ims-id@AdobeID/),
        );
      });

      it('resolves reviewedBy IMS IDs to emails in reviews array', async () => {
        const record = createMockOnboarding({
          reviews: [
            { reviewedBy: 'reviewer-ims-id@AdobeID', decision: 'BYPASSED', reason: 'test' },
          ],
        });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().resolves({ email: 'reviewer@example.com' }),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].reviews[0].reviewedBy).to.equal('reviewer@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnceWith('reviewer-ims-id@AdobeID');
      });

      it('keeps reviewedBy as-is when not resolvable (e.g. "admin")', async () => {
        const record = createMockOnboarding({
          reviews: [
            { reviewedBy: 'admin', decision: 'UPHELD', reason: 'test' },
          ],
        });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].reviews[0].reviewedBy).to.equal('admin');
        expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      });

      it('sets updatedBy to null when updatedBy is null (system-triggered onboarding)', async () => {
        const record = createMockOnboarding({ updatedBy: null });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].updatedBy).to.be.null;
        expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      });

      it('resolves createdBy to email via getImsAdminProfile when createdBy is set', async () => {
        const record = createMockOnboarding({ createdBy: 'creator-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().resolves({ email: 'creator@example.com' }),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('creator@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnceWith('creator-ims-id@AdobeID');
      });

      it('falls back to IMS ID for createdBy when getImsAdminProfile returns no email', async () => {
        const record = createMockOnboarding({ createdBy: 'creator-ims-id@AdobeID' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().resolves({}),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('creator-ims-id@AdobeID');
      });

      it('skips IMS resolution for createdBy when value is "system"', async () => {
        const record = createMockOnboarding({ createdBy: 'system' });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('system');
        expect(mockImsClient.getImsAdminProfile).to.not.have.been.called;
      });

      it('sets createdBy to null when createdBy is null', async () => {
        const record = createMockOnboarding({ createdBy: null });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = { getImsAdminProfile: sandbox.stub() };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.be.null;
      });

      it('deduplicates IMS IDs across createdBy and updatedBy', async () => {
        const sharedImsId = 'shared-ims-id@AdobeID';
        const record = createMockOnboarding({ createdBy: sharedImsId, updatedBy: sharedImsId });
        mockDataAccess.PlgOnboarding.all.resolves([record]);
        const mockImsClient = {
          getImsAdminProfile: sandbox.stub().resolves({ email: 'shared@example.com' }),
        };

        const res = await AdminPlgOnboardingController({ log: mockLog }).getAllOnboardings({
          dataAccess: mockDataAccess,
          imsClient: mockImsClient,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        expect(res.value[0].createdBy).to.equal('shared@example.com');
        expect(res.value[0].updatedBy).to.equal('shared@example.com');
        expect(mockImsClient.getImsAdminProfile).to.have.been.calledOnce;
      });
    });
  });

  describe('update and admin PLG record APIs', () => {
    let AdminAccessPlgController;

    beforeEach(async () => {
      AdminAccessPlgController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            createResponse: (body, status) => ({ status, value: body }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            noContent: () => ({ status: 204 }),
            notFound: (msg) => ({ status: 404, value: msg }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({
                retrieveDomainkey: rumRetrieveDomainkeyStub,
              }),
            },
          },
          '@adobe/spacecat-shared-launchdarkly-client': {
            default: ldCreateFromStub,
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
          '../../../../src/utils/slack/base.js': { loadProfileConfig: loadProfileConfigStub },
          '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => true }) },
          },
          '../../../../src/support/rum-config-service.js': {
            updateRumConfig: updateRumConfigStub,
          },
        },
      )).default;
    });

    describe('update', () => {
      const adminAuthAttributes = {
        authInfo: {
          getProfile: () => ({ email: 'ese@adobe.com' }),
        },
      };

      it('returns 403 for non-admin users', async () => {
        const NonAdminController = (await esmock(
          '../../../../src/controllers/plg/plg-onboarding.js',
          {
            '@adobe/spacecat-shared-utils': {
              composeBaseURL: composeBaseURLStub,
              detectBotBlocker: detectBotBlockerStub,
              detectLocale: detectLocaleStub,
              hasText: (val) => typeof val === 'string' && val.trim().length > 0,
              isValidIMSOrgId: () => true,
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
            '@adobe/spacecat-shared-rum-api-client': {
              default: {
                createFrom: sandbox.stub().returns({
                  retrieveDomainkey: sandbox.stub(),
                }),
              },
            },
            '@adobe/spacecat-shared-launchdarkly-client': {
              default: ldCreateFromStub,
            },
            '@adobe/spacecat-shared-tier-client': {
              default: { createForOrg: sandbox.stub() },
            },
            '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
              Config: { toDynamoItem: sandbox.stub() },
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
                },
                REVIEW_DECISIONS: {
                  BYPASSED: 'BYPASSED', UPHELD: 'UPHELD', CLOSED: 'CLOSED', REOPENED: 'REOPENED', OFFBOARDED: 'OFFBOARDED',
                },
              },
            },
            '../../../../src/controllers/llmo/llmo-onboarding.js': {
              createOrFindOrganization: sandbox.stub(),
              enableAudits: sandbox.stub(),
              enableImports: sandbox.stub(),
              triggerAudits: sandbox.stub(),
            },
            '../../../../src/support/utils.js': {
              autoResolveAuthorUrl: sandbox.stub(),
              resolveWwwUrl: sandbox.stub().resolves(TEST_DOMAIN),
              updateCodeConfig: sandbox.stub(),
              findDeliveryType: sandbox.stub(),
              deriveProjectName: sandbox.stub(),
              queueDeliveryConfigWriter: sandbox.stub(),
            },
            '../../../../src/utils/slack/base.js': { loadProfileConfig: sandbox.stub().returns(PLG_PROFILE) },
            '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: sandbox.stub() },
            '../../../../src/support/access-control-util.js': {
              default: { fromContext: () => ({ hasAdminAccess: () => false }) },
            },
            '../../../../src/support/rum-config-service.js': {
              updateRumConfig: updateRumConfigStub,
            },
          },
        )).default;

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
        createOrFindOrganizationStub.rejects(new Error('organization lookup failed'));

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
        rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
        findDeliveryTypeStub.resolves('other');

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
        detectBotBlockerStub.resolves({
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
        expect(composeBaseURLStub).to.have.been.calledWith('other-example.com/kings');
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
});
