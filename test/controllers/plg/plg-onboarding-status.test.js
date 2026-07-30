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

/* eslint-disable no-unused-vars */

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

const TEST_DOMAIN = 'example.com';
const TEST_BASE_URL = 'https://example.com';
const TEST_IMS_ORG_ID = 'ABC123@AdobeOrg';
const TEST_ORG_ID = 'org-uuid-1';
const TEST_SITE_ID = 'site-uuid-1';
const TEST_PROJECT_ID = 'project-uuid-1';
const TEST_ONBOARDING_ID = 'onboarding-uuid-1';
const DEFAULT_ORG_ID = 'default-org-id';
const DEMO_ORG_ID = '66331367-70e6-4a49-8445-4f6d9c265af9';
const OTHER_CUSTOMER_ORG_ID = 'other-customer-org-id';

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
  let ldGetFeatureFlagStub;
  let ldUpdateVariationValueStub;
  let ldCreateFromStub;
  let configToDynamoItemStub;

  // Mock objects
  let mockLog;
  let mockEnv;
  let mockSiteConfig;
  let mockSite;
  let mockOrganization;
  let mockProject;
  let mockDataAccess;
  let mockOnboarding;

  const PLG_PROFILE = {
    audits: {
      'alt-text': {},
      cwv: {},
      'broken-backlinks': {},
      'scrape-top-pages': {},
    },
    imports: {
      'organic-traffic': {},
      'top-pages': {},
      'all-traffic': {},
    },
  };

  function createMockSite(overrides = {}) {
    const mock = {
      getId: sandbox.stub().returns(overrides.id || TEST_SITE_ID),
      getBaseURL: sandbox.stub().returns(overrides.baseURL || TEST_BASE_URL),
      getOrganizationId: sandbox.stub().returns(overrides.orgId || TEST_ORG_ID),
      setOrganizationId: sandbox.stub(),
      getConfig: sandbox.stub().returns(mockSiteConfig),
      setConfig: sandbox.stub(),
      getLanguage: sandbox.stub().returns(overrides.language || null),
      setLanguage: sandbox.stub(),
      getRegion: sandbox.stub().returns(overrides.region || null),
      setRegion: sandbox.stub(),
      getDeliveryConfig: sandbox.stub().returns(overrides.deliveryConfig || {}),
      setDeliveryConfig: sandbox.stub(),
      getCode: sandbox.stub().returns(overrides.code || null),
      setCode: sandbox.stub(),
      getHlxConfig: sandbox.stub().returns(overrides.hlxConfig || null),
      setHlxConfig: sandbox.stub(),
      getProjectId: sandbox.stub().returns(overrides.projectId || null),
      setProjectId: sandbox.stub(),
      getAuthoringType: sandbox.stub().returns(overrides.authoringType ?? null),
      getDeliveryType: sandbox.stub().returns(overrides.deliveryType ?? null),
      setDeliveryType: sandbox.stub(),
      getSiteEnrollments: sandbox.stub().resolves(overrides.siteEnrollments ?? []),
    };
    mock.save = sandbox.stub().resolves(mock);
    return mock;
  }

  function createMockOnboarding(overrides = {}) {
    const record = {
      id: overrides.id || TEST_ONBOARDING_ID,
      imsOrgId: overrides.imsOrgId !== undefined ? overrides.imsOrgId : TEST_IMS_ORG_ID,
      domain: overrides.domain || TEST_DOMAIN,
      baseURL: overrides.baseURL || TEST_BASE_URL,
      status: overrides.status || 'IN_PROGRESS',
      siteId: overrides.siteId || null,
      organizationId: overrides.organizationId || null,
      steps: overrides.steps || null,
      error: overrides.error || null,
      botBlocker: overrides.botBlocker || null,
      waitlistReason: overrides.waitlistReason || null,
      reviews: overrides.reviews || null,
      updatedBy: overrides.updatedBy || null,
      createdBy: overrides.createdBy !== undefined ? overrides.createdBy : 'system',
      completedAt: overrides.completedAt || null,
      createdAt: overrides.createdAt || '2026-03-09T12:00:00.000Z',
      updatedAt: overrides.updatedAt || '2026-03-09T12:00:00.000Z',
    };

    return {
      getId: sandbox.stub().returns(record.id),
      getImsOrgId: sandbox.stub().returns(record.imsOrgId),
      getDomain: sandbox.stub().returns(record.domain),
      getBaseURL: sandbox.stub().returns(record.baseURL),
      getStatus: sandbox.stub().returns(record.status),
      getSiteId: sandbox.stub().returns(record.siteId),
      getOrganizationId: sandbox.stub().returns(record.organizationId),
      getSteps: sandbox.stub().returns(record.steps),
      getError: sandbox.stub().returns(record.error),
      getBotBlocker: sandbox.stub().returns(record.botBlocker),
      getWaitlistReason: sandbox.stub().returns(record.waitlistReason),
      getReviews: sandbox.stub().returns(record.reviews),
      getUpdatedBy: sandbox.stub().returns(overrides.updatedBy || null),
      getCreatedBy: sandbox.stub().returns(overrides.createdBy !== undefined ? overrides.createdBy : 'system'),
      getCompletedAt: sandbox.stub().returns(record.completedAt),
      getCreatedAt: sandbox.stub().returns(record.createdAt),
      getUpdatedAt: sandbox.stub().returns(record.updatedAt),
      setStatus: sandbox.stub(),
      setUpdatedBy: sandbox.stub(),
      setCreatedBy: sandbox.stub(),
      setSiteId: sandbox.stub(),
      setOrganizationId: sandbox.stub(),
      setSteps: sandbox.stub(),
      setError: sandbox.stub(),
      setBotBlocker: sandbox.stub(),
      setWaitlistReason: sandbox.stub(),
      setReviews: sandbox.stub(),
      setCompletedAt: sandbox.stub(),
      save: sandbox.stub().resolves(),
      remove: sandbox.stub().resolves(),
    };
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // RUM API client stubs
    rumRetrieveDomainkeyStub = sandbox.stub().resolves('test-domainkey');

    // Shared-utils stubs
    composeBaseURLStub = sandbox.stub().returns(TEST_BASE_URL);
    detectBotBlockerStub = sandbox.stub().resolves({ crawlable: true });
    detectLocaleStub = sandbox.stub().resolves({ language: 'en', region: 'US' });
    resolveCanonicalUrlStub = sandbox.stub().resolves(TEST_BASE_URL);

    // LLMO onboarding stubs
    mockOrganization = {
      getId: sandbox.stub().returns(TEST_ORG_ID),
      getImsOrgId: sandbox.stub().returns(TEST_IMS_ORG_ID),
      getName: sandbox.stub().returns('Test Org'),
    };
    createOrFindOrganizationStub = sandbox.stub().resolves(mockOrganization);
    enableAuditsStub = sandbox.stub().resolves();
    enableImportsStub = sandbox.stub().resolves();
    triggerAuditsStub = sandbox.stub().resolves();

    // Support utils stubs
    autoResolveAuthorUrlStub = sandbox.stub().resolves(null);
    resolveWwwUrlStub = sandbox.stub().resolves(TEST_DOMAIN);
    updateCodeConfigStub = sandbox.stub().resolves();
    findDeliveryTypeStub = sandbox.stub().resolves('aem_edge');
    deriveProjectNameStub = sandbox.stub().returns('example.com');
    queueDeliveryConfigWriterStub = sandbox.stub().resolves({ ok: true });

    // Profile config
    loadProfileConfigStub = sandbox.stub().returns(PLG_PROFILE);

    // Brand profile
    triggerBrandProfileAgentStub = sandbox.stub().resolves('exec-123');

    // LaunchDarkly
    ldGetFeatureFlagStub = sandbox.stub().resolves({
      variations: [{ value: {} }],
    });
    ldUpdateVariationValueStub = sandbox.stub().resolves({});
    ldCreateFromStub = sandbox.stub().returns({
      getFeatureFlag: ldGetFeatureFlagStub,
      updateVariationValue: ldUpdateVariationValueStub,
    });

    // TierClient — entitlement.organizationId matches the resolved customer org so the
    // revocation guard in revokePreviousAsoEnrollmentsForOrg sees a consistent state.
    tierClientCreateEntitlementStub = sandbox.stub().resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    tierClientCreateForSiteStub = sandbox.stub().resolves({
      createEntitlement: tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
        siteEnrollment: { getId: () => 'enroll-1' },
      }),
    });
    tierClientCreateForOrgStub = sandbox.stub().returns({
      createEntitlement: tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: {
          getId: () => 'ent-1',
          getOrganizationId: () => TEST_ORG_ID,
          getTier: () => 'PLG',
        },
      }),
    });

    // Config
    configToDynamoItemStub = sandbox.stub().returns({ config: 'dynamo' });

    // Site config mock
    mockSiteConfig = {
      getFetchConfig: sandbox.stub().returns({}),
      updateFetchConfig: sandbox.stub(),
      getImports: sandbox.stub().returns([]),
      enableImport: sandbox.stub(),
    };

    // Default mock site (for new site flow: findByBaseURL returns null)
    mockSite = createMockSite();

    // Project
    mockProject = {
      getId: sandbox.stub().returns(TEST_PROJECT_ID),
      getProjectName: sandbox.stub().returns('example.com'),
    };

    // PlgOnboarding mock
    mockOnboarding = createMockOnboarding();

    // DataAccess
    mockDataAccess = {
      Site: {
        findByBaseURL: sandbox.stub().resolves(null),
        findById: sandbox.stub().resolves(null),
        create: sandbox.stub().resolves(mockSite),
      },
      Organization: {
        findByImsOrgId: sandbox.stub().resolves(mockOrganization),
        findById: sandbox.stub().resolves(mockOrganization),
      },
      Project: {
        allByOrganizationId: sandbox.stub().resolves([]),
        create: sandbox.stub().resolves(mockProject),
      },
      Configuration: {
        findLatest: sandbox.stub().resolves({
          enableHandlerForSite: sandbox.stub(),
          disableHandlerForSite: sandbox.stub(),
          save: sandbox.stub().resolves(),
          getQueues: sandbox.stub().returns({ audits: 'audit-queue-url' }),
        }),
      },
      PlgOnboarding: {
        findByImsOrgIdAndDomain: sandbox.stub().resolves(null),
        findById: sandbox.stub().resolves(null),
        create: sandbox.stub().resolves(mockOnboarding),
        allByImsOrgId: sandbox.stub().resolves([]),
        all: sandbox.stub().resolves([]),
      },
      SiteEnrollment: {
        allByEntitlementId: sandbox.stub().resolves([]),
        allBySiteId: sandbox.stub().resolves([]),
        create: sandbox.stub().resolves({ getId: () => 'enroll-1', getEntitlementId: () => 'ent-1' }),
      },
      Entitlement: {
        allByOrganizationId: sandbox.stub().resolves([]),
      },
      Opportunity: {
        allBySiteId: sandbox.stub().resolves([]),
      },
      Suggestion: {
        allByOpportunityId: sandbox.stub().resolves([]),
        bulkUpdateStatus: sandbox.stub().resolves(),
      },
      FixEntity: {
        allByOpportunityId: sandbox.stub().resolves([]),
        removeByIds: sandbox.stub().resolves(),
      },
    };

    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };

    mockEnv = {
      DEFAULT_ORGANIZATION_ID: DEFAULT_ORG_ID,
      ASO_PLG_EXCLUDED_ORGS: DEMO_ORG_ID,
      LD_EXPERIENCE_SUCCESS_API_TOKEN: 'test-ld-token',
    };

    PlgOnboardingController = (await esmock(
      '../../../src/controllers/plg/plg-onboarding.js',
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
            PRODUCT_CODES: { ASO: 'aso_optimizer' },
            TIERS: {
              FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD',
            },
          },
        },
        '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js': {
          default: {
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
            },
          },
        },
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          createOrFindOrganization: createOrFindOrganizationStub,
          enableAudits: enableAuditsStub,
          enableImports: enableImportsStub,
          triggerAudits: triggerAuditsStub,
        },
        '../../../src/support/utils.js': {
          autoResolveAuthorUrl: autoResolveAuthorUrlStub,
          resolveWwwUrl: resolveWwwUrlStub,
          updateCodeConfig: updateCodeConfigStub,
          findDeliveryType: findDeliveryTypeStub,
          deriveProjectName: deriveProjectNameStub,
          queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
        },
        '../../../src/utils/slack/base.js': {
          loadProfileConfig: loadProfileConfigStub,
        },
        '../../../src/support/brand-profile-trigger.js': {
          triggerBrandProfileAgent: triggerBrandProfileAgentStub,
        },
        '../../../src/support/access-control-util.js': {
          default: {
            fromContext: () => ({ hasAdminAccess: () => false, hasAdminReadAccess: () => false }),
          },
        },
      },
    )).default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  function mockAuthInfo(imsOrgId = TEST_IMS_ORG_ID) {
    const tenantId = imsOrgId.replace('@AdobeOrg', '');
    return {
      getProfile: sandbox.stub().returns({
        tenants: [{ id: tenantId }],
      }),
    };
  }

  function buildContext(data = {}, { authInfo } = {}) {
    return {
      data,
      dataAccess: mockDataAccess,
      log: mockLog,
      env: mockEnv,
      sqs: { sendMessage: sandbox.stub().resolves() },
      attributes: {
        authInfo: authInfo !== undefined ? authInfo : mockAuthInfo(),
      },
    };
  }

  // --- Controller validation tests ---

  // --- getStatus endpoint ---

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

  // --- getStatus: admin / API key bypass ---

  describe('getStatus - admin bypass', () => {
    let AdminPlgOnboardingController;

    beforeEach(async () => {
      AdminPlgOnboardingController = (await esmock(
        '../../../src/controllers/plg/plg-onboarding.js',
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
              PRODUCT_CODES: { ASO: 'aso_optimizer' },
              TIERS: {
                FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD',
              },
            },
          },
          '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js': {
            default: {
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
          '../../../src/controllers/llmo/llmo-onboarding.js': {
            createOrFindOrganization: createOrFindOrganizationStub,
            enableAudits: enableAuditsStub,
            enableImports: enableImportsStub,
            triggerAudits: triggerAuditsStub,
          },
          '../../../src/support/utils.js': {
            autoResolveAuthorUrl: autoResolveAuthorUrlStub,
            resolveWwwUrl: resolveWwwUrlStub,
            updateCodeConfig: updateCodeConfigStub,
            findDeliveryType: findDeliveryTypeStub,
            deriveProjectName: deriveProjectNameStub,
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
          },
          '../../../src/support/brand-profile-trigger.js': {
            triggerBrandProfileAgent: triggerBrandProfileAgentStub,
          },
          '../../../src/support/access-control-util.js': {
            default: {
              fromContext: () => ({ hasAdminAccess: () => true }),
            },
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
          '../../../src/controllers/plg/plg-onboarding.js',
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
                PRODUCT_CODES: { ASO: 'aso_optimizer' },
                TIERS: { FREE_TRIAL: 'FREE_TRIAL', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD' },
              },
            },
            '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js': {
              default: {
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
            '../../../src/controllers/llmo/llmo-onboarding.js': {
              createOrFindOrganization: createOrFindOrganizationStub,
              enableAudits: enableAuditsStub,
              enableImports: enableImportsStub,
              triggerAudits: triggerAuditsStub,
            },
            '../../../src/support/utils.js': {
              autoResolveAuthorUrl: autoResolveAuthorUrlStub,
              updateCodeConfig: updateCodeConfigStub,
              findDeliveryType: findDeliveryTypeStub,
              deriveProjectName: deriveProjectNameStub,
            },
            '../../../src/utils/slack/base.js': {
              loadProfileConfig: loadProfileConfigStub,
            },
            '../../../src/support/brand-profile-trigger.js': {
              triggerBrandProfileAgent: triggerBrandProfileAgentStub,
            },
            // Read-only admin: hasAdminAccess() is false, hasAdminReadAccess() is true.
            // The controller should NOT use hasAdminReadAccess for this flow.
            '../../../src/support/access-control-util.js': {
              default: {
                fromContext: () => ({
                  hasAdminAccess: () => false,
                  hasAdminReadAccess: () => true,
                }),
              },
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
});
