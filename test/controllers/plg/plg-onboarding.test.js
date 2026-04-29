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
    return {
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
      save: sandbox.stub().resolves(),
    };
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
      getCompletedAt: sandbox.stub().returns(record.completedAt),
      getCreatedAt: sandbox.stub().returns(record.createdAt),
      getUpdatedAt: sandbox.stub().returns(record.updatedAt),
      setStatus: sandbox.stub(),
      setUpdatedBy: sandbox.stub(),
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
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
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
            REVIEW_REASONS: {
              DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
              AEM_SITE_CHECK: 'AEM_SITE_CHECK',
              DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
              BOT_BLOCKER: 'BOT_BLOCKER',
            },
            REVIEW_DECISIONS: {
              BYPASSED: 'BYPASSED',
              UPHELD: 'UPHELD',
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
            fromContext: () => ({ hasAdminAccess: () => false }),
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

  describe('onboard - input validation', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns 400 when request body is missing', async () => {
      const res = await controller.onboard({
        data: null,
        attributes: { authInfo: mockAuthInfo() },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Request body is required');
    });

    it('returns 400 when domain is missing', async () => {
      const context = buildContext({});
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('domain is required');
    });

    it('returns 400 when authInfo is missing', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo: null },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Authentication information is required');
    });

    it('returns 400 when profile has no tenants', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo: { getProfile: sandbox.stub().returns({}) } },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('User profile or organization ID not found in authentication token');
    });

    it('returns 400 when profile is null', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN },
        { authInfo: { getProfile: sandbox.stub().returns(null) } },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('User profile or organization ID not found in authentication token');
    });

    it('returns 403 when requested imsOrgId does not match token tenants', async () => {
      const context = buildContext(
        { domain: TEST_DOMAIN, imsOrgId: 'XXXXXXXXXXXXXXXXXXXXXXXX@AdobeOrg' },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(403);
      expect(res.value).to.equal('Requested imsOrgId does not match any tenant in authentication token');
    });

    it('uses requested imsOrgId when it matches a token tenant', async () => {
      const secondOrgId = 'BBBBBBBBBBBBBBBBBBBBBBBB@AdobeOrg';
      const context = buildContext(
        { domain: TEST_DOMAIN, imsOrgId: secondOrgId },
        {
          authInfo: {
            getProfile: sandbox.stub().returns({
              tenants: [
                { id: 'ABC123' },
                { id: 'BBBBBBBBBBBBBBBBBBBBBBBB' },
              ],
            }),
          },
        },
      );
      const res = await controller.onboard(context);
      expect(res.status).to.equal(200);
      // Verify the org was resolved with the requested imsOrgId
      expect(createOrFindOrganizationStub).to.have.been.calledWith(secondOrgId, sinon.match.any);
    });
  });

  // --- Admin onboard access ---

  describe('onboard - admin access', () => {
    let adminController;

    beforeEach(async () => {
      const AdminPlgOnboardingController = (await esmock(
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
              REVIEW_REASONS: {
                DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
                AEM_SITE_CHECK: 'AEM_SITE_CHECK',
                DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
                BOT_BLOCKER: 'BOT_BLOCKER',
              },
              REVIEW_DECISIONS: {
                BYPASSED: 'BYPASSED',
                UPHELD: 'UPHELD',
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

      adminController = AdminPlgOnboardingController({ log: mockLog });
    });

    it('returns 400 when imsOrgId is missing in admin onboard call', async () => {
      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required when onboarding as admin');
    });

    it('returns 400 when imsOrgId is empty string in admin onboard call', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, imsOrgId: '' });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required when onboarding as admin');
    });

    it('onboards successfully when admin provides imsOrgId', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, imsOrgId: TEST_IMS_ORG_ID });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(200);
      expect(createOrFindOrganizationStub).to.have.been.calledWith(
        TEST_IMS_ORG_ID,
        sinon.match.any,
      );
    });
  });

  // --- SSRF protection ---

  describe('onboard - SSRF protection', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    const invalidHostnames = [
      '../../etc/passwd',
      'domain.com:8080',
      'http://domain.com',
      '-invalid.com',
      `${'a'.repeat(254)}.com`,
      'domain..com',
    ];

    invalidHostnames.forEach((invalidDomain) => {
      it(`returns 400 for invalid hostname: ${invalidDomain}`, async () => {
        const context = buildContext({ domain: invalidDomain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(400);
        expect(res.value).to.include('Invalid domain');
      });
    });

    // These are valid hostnames syntactically but point to unsafe addresses
    const unsafeDomains = [
      'myhost.local',
      'service.internal',
      'foo.private.adobe.io',
    ];

    unsafeDomains.forEach((unsafeDomain) => {
      it(`returns 400 for unsafe domain: ${unsafeDomain}`, async () => {
        const context = buildContext({ domain: unsafeDomain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('Invalid domain');
      });
    });

    // These fail hostname validation before reaching SSRF check
    const invalidAsHostnames = [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '[::1]',
    ];

    invalidAsHostnames.forEach((domain) => {
      it(`returns 400 for invalid/unsafe domain: ${domain}`, async () => {
        const context = buildContext({ domain });

        const res = await controller.onboard(context);

        expect(res.status).to.equal(400);
        expect(res.value).to.include('Invalid domain');
      });
    });
  });

  // --- Idempotency: already onboarded ---

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

  // --- Race condition handling ---

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

  // --- Error handler resilience ---

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

  // --- Happy path: new site ---

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
      expect(mockDataAccess.PlgOnboarding.create).to.have.been.calledWith({
        imsOrgId: TEST_IMS_ORG_ID,
        domain: TEST_DOMAIN,
        baseURL: TEST_BASE_URL,
        status: 'IN_PROGRESS',
      });

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
      expect(tierClientCreateForSiteStub).to.have.been.called;
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
      expect(mockOnboarding.setUpdatedBy).to.have.been.calledWith('system');
      expect(mockOnboarding.save).to.have.been.called;
    });

    it('does not set updatedBy when fromBackoffice is true', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, fromBackoffice: true });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setUpdatedBy).to.not.have.been.called;
    });

    it('still sets updatedBy when fromBackoffice is not a boolean true', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, fromBackoffice: 'true' });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setUpdatedBy).to.have.been.calledWith('system');
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

  // --- Bot blocker ---

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

  // --- Slack notifications ---

  describe('onboard - Slack notifications', () => {
    let postSlackMessageStub;
    let SlackController;

    beforeEach(async () => {
      postSlackMessageStub = sandbox.stub().resolves();

      SlackController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            notFound: (msg) => ({ status: 404, value: msg }),
            noContent: () => ({ status: 204 }),
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
              REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
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
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../src/support/brand-profile-trigger.js': {
            triggerBrandProfileAgent: triggerBrandProfileAgentStub,
          },
          '../../../src/support/access-control-util.js': {
            default: {
              fromContext: () => ({ hasAdminAccess: () => false }),
            },
          },
        },
      )).default;
    });

    function buildSlackContext(onboarding) {
      return {
        data: { domain: TEST_DOMAIN },
        dataAccess: {
          ...mockDataAccess,
          PlgOnboarding: {
            ...mockDataAccess.PlgOnboarding,
            findByImsOrgIdAndDomain: sandbox.stub().resolves(null),
            create: sandbox.stub().resolves(onboarding),
          },
        },
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST',
          SLACK_BOT_TOKEN: 'xoxb-test-token',
        },
        sqs: { sendMessage: sandbox.stub().resolves() },
        attributes: { authInfo: mockAuthInfo() },
      };
    }

    it('posts notification with botBlocker type and ipsToAllowlist', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4', '5.6.7.8'] },
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
      });
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4', '5.6.7.8'],
      });

      await SlackController({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [channelId, message] = postSlackMessageStub.firstCall.args;
      expect(channelId).to.equal('C123TEST');
      expect(message).to.include('Waiting for IP Allowlisting');
      expect(message).to.include('cloudflare');
      expect(message).to.include('1.2.3.4, 5.6.7.8');
      expect(message).to.include('Test Org');
      expect(message).to.include(TEST_ORG_ID);
      expect(message).to.include(TEST_SITE_ID);
    });

    it('posts notification with botBlocker type but no ipsToAllowlist', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'akamai' },
      });
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'akamai',
      });

      await SlackController({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('akamai');
      expect(message).to.not.include('IPs to allowlist');
      // organizationId is null on this onboarding, so org name/ID should not appear
      expect(message).to.not.include('IMS Org Name');
      expect(message).to.not.include('SpaceCat Org ID (derived from IMS Org)');
      expect(message).to.not.include('Site ID');
    });

    it('posts error notification including error message', async () => {
      const onboarding = createMockOnboarding({
        status: 'ERROR',
        error: { message: 'An internal error occurred' },
      });
      createOrFindOrganizationStub.rejects(new Error('DB failure'));

      await SlackController({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Error');
      expect(message).to.include('An internal error occurred');
    });

    it('posts notification with waitlist reason for non-AEM site', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITLISTED',
        waitlistReason: `Domain ${TEST_DOMAIN} is not an AEM site`,
      });
      rumRetrieveDomainkeyStub.rejects(new Error('No domainkey'));
      findDeliveryTypeStub.resolves('other');

      await SlackController({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Waitlisted');
      expect(message).to.include('is not an AEM site');
    });

    it('logs error when postSlackMessage fails but does not propagate', async () => {
      postSlackMessageStub.rejects(new Error('Slack API unavailable'));
      const onboarding = createMockOnboarding({
        status: 'WAITING_FOR_IP_ALLOWLISTING',
        botBlocker: { type: 'cloudflare', ipsToAllowlist: ['1.2.3.4'] },
      });
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
      });

      const res = await SlackController({ log: mockLog }).onboard(buildSlackContext(onboarding));

      expect(res.status).to.equal(200);
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to post PLG onboarding notification to Slack/),
      );
    });

    it('posts notification without org name when org lookup fails', async () => {
      const onboarding = createMockOnboarding({
        status: 'WAITLISTED',
        waitlistReason: `Domain ${TEST_DOMAIN} is not an AEM site`,
        organizationId: TEST_ORG_ID,
      });
      rumRetrieveDomainkeyStub.rejects(new Error('No domainkey'));
      findDeliveryTypeStub.resolves('other');

      const ctx = buildSlackContext(onboarding);
      ctx.dataAccess = {
        ...ctx.dataAccess,
        Organization: {
          ...ctx.dataAccess.Organization,
          findById: sandbox.stub().rejects(new Error('DB error')),
        },
      };

      await SlackController({ log: mockLog }).onboard(ctx);

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Waitlisted');
      expect(message).to.not.include('IMS Org Name');
      expect(mockLog.warn).to.have.been.calledWith(
        sinon.match(/Failed to look up org name for onboarding notification/),
      );
    });

    it('posts notification without org name when org has no name', async () => {
      const onboarding = createMockOnboarding({
        status: 'ONBOARDED',
        organizationId: TEST_ORG_ID,
        siteId: TEST_SITE_ID,
      });

      const ctx = buildSlackContext(onboarding);
      ctx.dataAccess = {
        ...ctx.dataAccess,
        Organization: {
          ...ctx.dataAccess.Organization,
          findById: sandbox.stub().resolves({ getName: () => null }),
        },
      };

      await SlackController({ log: mockLog }).onboard(ctx);

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Onboarded');
      expect(message).to.not.include('IMS Org Name');
      expect(message).to.include(TEST_ORG_ID);
      expect(message).to.include(TEST_SITE_ID);
    });

    it('INACTIVE notification includes last review reason', async () => {
      const AdminSlackController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            notFound: (msg) => ({ status: 404, value: msg }),
            noContent: () => ({ status: 204 }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-launchdarkly-client': { default: ldCreateFromStub },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({ retrieveDomainkey: rumRetrieveDomainkeyStub }),
            },
          },
          '@adobe/spacecat-shared-tier-client': { default: { createForSite: tierClientCreateForSiteStub, createForOrg: tierClientCreateForOrgStub } },
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
              REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
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
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => true }) },
          },
        },
      )).default;

      const record = createMockOnboarding({
        status: 'ONBOARDED',
        reviews: [{
          reason: 'Domain is not an AEM site', decision: 'UPHELD', reviewedBy: 'ese@adobe.com', reviewedAt: '2026-01-01T00:00:00Z', justification: 'confirmed',
        }],
      });
      let currentStatus = 'ONBOARDED';
      let currentWaitlistReason = null;
      record.getStatus.callsFake(() => currentStatus);
      record.setStatus.callsFake((s) => {
        currentStatus = s;
      });
      record.getWaitlistReason.callsFake(() => currentWaitlistReason);
      record.setWaitlistReason.callsFake((r) => {
        currentWaitlistReason = r;
      });
      mockDataAccess.PlgOnboarding.findById.resolves(record);

      await AdminSlackController({ log: mockLog }).update({
        dataAccess: mockDataAccess,
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { decision: 'UPHELD', justification: 'Inactivating per request' },
        attributes: { authInfo: { getProfile: () => ({ email: 'ese@adobe.com' }) } },
        env: { SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST', SLACK_BOT_TOKEN: 'xoxb-test' },
        log: mockLog,
      });

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Waitlisted');
      expect(message).to.include('Reason:');
      expect(message).to.include('Inactivating per request');
    });

    it('INACTIVE notification omits inactivation reason when there are no reviews', async () => {
      const AdminSlackController = (await esmock(
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
            created: (data) => ({ status: 201, value: data }),
            forbidden: (msg) => ({ status: 403, value: msg }),
            internalServerError: (msg) => ({ status: 500, value: msg }),
            notFound: (msg) => ({ status: 404, value: msg }),
            noContent: () => ({ status: 204 }),
            ok: (data) => ({ status: 200, value: data }),
          },
          '@adobe/spacecat-shared-launchdarkly-client': { default: ldCreateFromStub },
          '@adobe/spacecat-shared-rum-api-client': {
            default: {
              createFrom: sandbox.stub().returns({ retrieveDomainkey: rumRetrieveDomainkeyStub }),
            },
          },
          '@adobe/spacecat-shared-tier-client': { default: { createForSite: tierClientCreateForSiteStub, createForOrg: tierClientCreateForOrgStub } },
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
              REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
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
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => true }) },
          },
        },
      )).default;

      const record = createMockOnboarding({
        status: 'ONBOARDED',
        reviews: null,
      });
      let currentStatus = 'ONBOARDED';
      record.getStatus.callsFake(() => currentStatus);
      record.setStatus.callsFake((s) => {
        currentStatus = s;
      });
      mockDataAccess.PlgOnboarding.findById.resolves(record);

      await AdminSlackController({ log: mockLog }).update({
        dataAccess: mockDataAccess,
        params: { onboardingId: TEST_ONBOARDING_ID },
        data: { decision: 'UPHELD', justification: 'Inactivating per request' },
        attributes: { authInfo: { getProfile: () => ({ email: 'ese@adobe.com' }) } },
        env: { SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C123TEST', SLACK_BOT_TOKEN: 'xoxb-test' },
        log: mockLog,
      });

      expect(postSlackMessageStub).to.have.been.called;
      const [, message] = postSlackMessageStub.firstCall.args;
      expect(message).to.include('Waitlisted');
      expect(message).to.not.include('Inactivation Reason');
    });
  });

  // --- RUM check (informational, non-blocking) ---

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

  // --- Existing site: same org ---

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
      expect(tierClientCreateForSiteStub).to.have.been.called;
      // Verify onboarding record completed
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });
  });

  // --- Existing site: internal org ---

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

  // --- Existing site: different customer org ---

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

  // --- AEM site verification ---

  describe('onboard - AEM site verification', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('verifies RUM using www-resolved domain so www-keyed sites are not wrongly waitlisted', async () => {
      const wwwDomain = `www.${TEST_DOMAIN}`;
      resolveWwwUrlStub.resolves(wwwDomain);
      rumRetrieveDomainkeyStub.resolves('test-domainkey');

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(rumRetrieveDomainkeyStub).to.have.been.calledWith(wwwDomain);
    });

    it('proxy passed to resolveWwwUrl when no site record exists has getConfig so sharedWwwUrlResolver does not throw', async () => {
      // sharedWwwUrlResolver calls site.getConfig() (not site.getConfig?.()) so the proxy
      // must expose getConfig, otherwise resolveWwwUrl throws and rumVerified is wrongly false
      resolveWwwUrlStub.callsFake((siteArg) => {
        // Simulate the real implementation accessing site.getConfig()
        siteArg.getConfig();
        return Promise.resolve(TEST_DOMAIN);
      });
      rumRetrieveDomainkeyStub.resolves('test-domainkey');
      mockDataAccess.Site.findByBaseURL.resolves(null); // no existing site record

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('proxy getBaseURL returns the correct baseURL when no site record exists', async () => {
      resolveWwwUrlStub.callsFake((siteArg) => Promise.resolve(siteArg.getBaseURL()));
      rumRetrieveDomainkeyStub.resolves('test-domainkey');
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      // resolveWwwUrl should have been called with a proxy whose getBaseURL returns TEST_BASE_URL
      const [siteArg] = resolveWwwUrlStub.firstCall.args;
      expect(siteArg.getBaseURL()).to.equal(TEST_BASE_URL);
    });

    it('passes the real site object (not proxy) to resolveWwwUrl when a site record exists', async () => {
      const existingSite = createMockSite({ orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      rumRetrieveDomainkeyStub.resolves('test-domainkey');

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      const [siteArg] = resolveWwwUrlStub.firstCall.args;
      expect(siteArg).to.equal(existingSite);
    });

    it('sets rumVerified=false and falls through to delivery type when resolveWwwUrl itself throws', async () => {
      resolveWwwUrlStub.rejects(new Error('RUM client network error'));
      findDeliveryTypeStub.resolves('aem_edge');

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(rumRetrieveDomainkeyStub).to.not.have.been.called;
      expect(findDeliveryTypeStub).to.have.been.called;
    });

    it('sets rumVerified=false when resolveWwwUrl resolves but outer retrieveDomainkey rejects', async () => {
      resolveWwwUrlStub.resolves(`www.${TEST_DOMAIN}`);
      rumRetrieveDomainkeyStub.rejects(new Error('No domainkey'));
      findDeliveryTypeStub.resolves('aem_edge');

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(rumRetrieveDomainkeyStub).to.have.been.calledWith(`www.${TEST_DOMAIN}`);
      expect(findDeliveryTypeStub).to.have.been.called;
    });

    it('uses overrideBaseURL from site fetchConfig — real site passed so resolveWwwUrl short-circuits without a RUM call', async () => {
      // Real-world: ingrammicro.com site has overrideBaseURL = https://www.ingrammicro.com
      // sharedWwwUrlResolver reads overrideBaseURL and returns www.ingrammicro.com immediately
      // (no internal RUM calls — the only RUM call is the outer retrieveDomainkey)
      const siteWithOverride = createMockSite({ orgId: TEST_ORG_ID });
      const fetchConfigWithOverride = { overrideBaseURL: `https://www.${TEST_DOMAIN}` };
      siteWithOverride.getConfig.returns({
        getFetchConfig: () => fetchConfigWithOverride,
        updateFetchConfig: sandbox.stub(),
        getImports: () => [],
        enableImport: sandbox.stub(),
      });
      mockDataAccess.Site.findByBaseURL.resolves(siteWithOverride);
      // Simulate resolveWwwUrl returning www domain via overrideBaseURL (no internal RUM call)
      resolveWwwUrlStub.callsFake((siteArg) => {
        const override = siteArg.getConfig()?.getFetchConfig()?.overrideBaseURL;
        const wwwDomain = override ? override.replace(/^https?:\/\//, '') : `www.${TEST_DOMAIN}`;
        return Promise.resolve(wwwDomain);
      });
      rumRetrieveDomainkeyStub.resolves('test-domainkey');

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      // Real site was passed (not proxy) so overrideBaseURL was accessible
      const [siteArg] = resolveWwwUrlStub.firstCall.args;
      expect(siteArg).to.equal(siteWithOverride);
      expect(siteArg.getConfig().getFetchConfig().overrideBaseURL).to.equal(`https://www.${TEST_DOMAIN}`);
      // Outer retrieveDomainkey was called with the www domain from overrideBaseURL
      expect(rumRetrieveDomainkeyStub).to.have.been.calledWith(`www.${TEST_DOMAIN}`);
    });

    it('resolves www variant via proxy when no site record exists — proxy getConfig returns null skipping overrideBaseURL', async () => {
      // Real-world: ingrammicro.com with no existing site record
      // Proxy getConfig() returns null → sharedWwwUrlResolver skips overrideBaseURL,
      // falls through to www-toggle RUM check, returns www.ingrammicro.com
      mockDataAccess.Site.findByBaseURL.resolves(null);
      resolveWwwUrlStub.callsFake((siteArg) => {
        // Simulate real sharedWwwUrlResolver: getConfig() returns null → no overrideBaseURL
        const override = siteArg.getConfig()?.getFetchConfig()?.overrideBaseURL;
        expect(override).to.be.undefined; // proxy never sets overrideBaseURL
        return Promise.resolve(`www.${TEST_DOMAIN}`);
      });
      rumRetrieveDomainkeyStub.resolves('test-domainkey');

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      // Proxy was passed, not the real site
      const [siteArg] = resolveWwwUrlStub.firstCall.args;
      expect(siteArg.getConfig()).to.be.null; // proxy returns null, not throw
      expect(siteArg.getBaseURL()).to.equal(TEST_BASE_URL);
      // Outer retrieveDomainkey used the www-resolved domain
      expect(rumRetrieveDomainkeyStub).to.have.been.calledWith(`www.${TEST_DOMAIN}`);
    });

    it('waitlists domain when RUM check fails and delivery type is OTHER', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
      findDeliveryTypeStub.resolves('other');

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(mockOnboarding.setWaitlistReason)
        .to.have.been.calledWithMatch(/not an AEM site/);
      expect(mockOnboarding.save).to.have.been.called;
      // Should NOT proceed to bot blocker or site creation
      expect(detectBotBlockerStub).to.not.have.been.called;
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });

    it('continues onboarding when RUM fails but delivery type is AEM', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
      findDeliveryTypeStub.resolves('aem_edge');

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      // delivery type should NOT be fetched again at site creation (cached)
      expect(findDeliveryTypeStub).to.have.been.calledOnce;
    });

    it('prefers existing site delivery type over findDeliveryType when RUM fails', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
      findDeliveryTypeStub.resetHistory();
      const existingSite = createMockSite({ deliveryType: 'aem_cs', orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(findDeliveryTypeStub).to.not.have.been.called;
      expect(mockLog.info).to.have.been.calledWithMatch(/Using existing site delivery type aem_cs/);
    });

    it('does not use site delivery type OTHER — calls findDeliveryType when RUM fails', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
      findDeliveryTypeStub.resetHistory();
      findDeliveryTypeStub.resolves('aem_edge');
      const existingSite = createMockSite({ deliveryType: 'other', orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(findDeliveryTypeStub).to.have.been.calledOnceWith(TEST_BASE_URL);
      expect(mockLog.info).to.not.have.been.calledWithMatch(/Using existing site delivery type/);
    });
  });

  // --- One domain per IMS org ---

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
        getProductCode: sandbox.stub().returns('aso_optimizer'), // matches mocked PRODUCT_CODES.ASO
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

      // Old domain is waitlisted with displacement reason
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(onboardedRecord.setWaitlistReason)
        .to.have.been.calledWithMatch(/was replaced by.*no active suggestions.*new domain.*current org/);
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
        getProductCode: sandbox.stub().returns('aso_optimizer'),
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
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
        getProductCode: sandbox.stub().returns('aso_optimizer'),
      };
      mockDataAccess.Entitlement.allByOrganizationId.resolves([mockAsoEntitlement]);
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([]);

      const res = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(res.status).to.equal(200);
      expect(onboardedRecord.setUpdatedBy).to.not.have.been.called;
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
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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

      // Old domain is waitlisted
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(onboardedRecord.save).to.have.been.called;

      // No enrollment revocation attempted (no org ID)
      expect(mockDataAccess.Entitlement.allByOrganizationId).not.to.have.been.called;

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
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');

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
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
        { getId: sandbox.stub().returns(ASO_ENTITLEMENT_ID), getProductCode: sandbox.stub().returns('aso_optimizer') },
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

      // Old domain is waitlisted
      expect(onboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
      expect(onboardedRecord.save).to.have.been.called;

      // Revocation failure was logged as error
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to revoke ASO enrollment/);

      // New domain is still onboarded
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });
  });

  // --- Entitlement ---

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
  });

  // --- LaunchDarkly feature flag update ---

  describe('onboard - LaunchDarkly flag update', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('adds org and site to all 3 auto-fix flags in variation 0', async () => {
      ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      const expectedFlags = ['FF_cwv-auto-fix', 'FF_alt-text-auto-fix', 'FF_broken-backlinks-auto-fix'];
      expectedFlags.forEach((flagKey) => {
        expect(ldGetFeatureFlagStub).to.have.been.calledWith('experience-success-studio', flagKey);
      });
      expect(ldUpdateVariationValueStub.callCount).to.equal(3);
      const cwvCall = ldUpdateVariationValueStub.getCalls().find((c) => c.args[1] === 'FF_cwv-auto-fix');
      expect(cwvCall).to.exist;
      expect(cwvCall.args[0]).to.equal('experience-success-studio');
      expect(cwvCall.args[2]).to.equal(0);
      expect(cwvCall.args[3]).to.deep.equal({ [TEST_IMS_ORG_ID]: [TEST_SITE_ID] });
    });

    it('skips duplicate site already present in variation 0', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: { [TEST_IMS_ORG_ID]: [TEST_SITE_ID] } }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('continues onboarding when LD flag update fails', async () => {
      ldGetFeatureFlagStub.rejects(new Error('LD service unavailable'));

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('skips LD update when LD_EXPERIENCE_SUCCESS_API_TOKEN is not set', async () => {
      const context = {
        ...buildContext({ domain: TEST_DOMAIN }),
        env: { DEFAULT_ORGANIZATION_ID: DEFAULT_ORG_ID },
      };
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldGetFeatureFlagStub).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/LD_EXPERIENCE_SUCCESS_API_TOKEN/);
    });

    it('skips LD update when org has no IMS org ID', async () => {
      mockOrganization.getImsOrgId.returns(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('skips LD update when flag has no variations', async () => {
      ldGetFeatureFlagStub.resolves({ variations: [] });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
    });

    it('handles string-wrapped variation 0 value', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: JSON.stringify({}) }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(ldUpdateVariationValueStub.callCount).to.equal(3);
      ldUpdateVariationValueStub.getCalls().forEach((call) => {
        const newValue = call.args[3];
        expect(typeof newValue).to.equal('string');
        expect(JSON.parse(newValue)).to.deep.equal({ [TEST_IMS_ORG_ID]: [TEST_SITE_ID] });
      });
    });

    it('skips flag and warns when variation 0 contains malformed JSON string', async () => {
      ldGetFeatureFlagStub.resolves({
        variations: [{ value: 'not-valid-json{{{' }],
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(ldUpdateVariationValueStub).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/malformed JSON/);
    });
  });

  // --- Previous ASO enrollment revocation (one active enrollment per org) ---

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

    it('aborts when entitlement.organizationId disagrees with resolved customer org', async () => {
      const sibling = buildSiblingEnrollment('enroll-sib', 'prev-site-1');
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([sibling]);

      // Drift: entitlement belongs to a different org than the one resolved from imsOrgId.
      tierClientCreateEntitlementStub.resolves({
        entitlement: { getId: () => 'ent-drift', getOrganizationId: () => 'drifted-org' },
        siteEnrollment: { getId: () => 'enroll-1' },
      });

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(sibling.remove).to.not.have.been.called;
      expect(mockLog.error).to.have.been.calledWithMatch(
        /Refusing to revoke sibling ASO enrollments.*Possible entitlement-resolution drift/,
      );
    });

    it('refuses revocation when the resolved customer org is internal/demo', async () => {
      mockOrganization.getId.returns(DEMO_ORG_ID);
      // Keep the guard-2 invariant intact so only the internal-org guard is the blocker.
      tierClientCreateEntitlementStub.resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => DEMO_ORG_ID },
        siteEnrollment: { getId: () => 'enroll-1' },
      });
      const sibling = buildSiblingEnrollment('enroll-sib', 'prev-site-1');
      mockDataAccess.SiteEnrollment.allByEntitlementId.resolves([sibling]);

      const context = buildContext({ domain: TEST_DOMAIN });
      await controller.onboard(context);

      expect(sibling.remove).to.not.have.been.called;
      expect(mockLog.error).to.have.been.calledWithMatch(
        /Refusing to revoke sibling ASO enrollments.*internal\/demo/,
      );
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

  // --- Delivery config writer (CDN + optional redirect params) ---

  describe('onboard - delivery config writer', () => {
    const redirectReadyDeliveryConfig = {
      programId: 'test-program-id',
      environmentId: 'test-environment-id',
    };

    /** Built at assertion time so `site` is the mock created in each test. */
    function expectedRedirectQueuePayload() {
      return {
        site: mockSite,
        baseURL: TEST_BASE_URL,
        minutes: 2000,
        updateRedirects: true,
        slackContext: {},
      };
    }

    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    // happy path for AEM CS/CW site
    it('queues delivery config writer for CS site with program and environment', async () => {
      queueDeliveryConfigWriterStub.resolves({ ok: true });
      mockSite = createMockSite({
        authoringType: SiteModel.AUTHORING_TYPES.CS,
        deliveryConfig: redirectReadyDeliveryConfig,
      });
      mockDataAccess.Site.create.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(queueDeliveryConfigWriterStub).to.have.been.calledOnce;
      expect(queueDeliveryConfigWriterStub).to.have.been.calledWith(
        expectedRedirectQueuePayload(),
        context,
      );
      expect(mockOnboarding.setSteps).to.have.been.calledWith(
        sinon.match.hasNested('deliveryConfigQueued', true),
      );
      expect(mockLog.warn).to.not.have.been.calledWithMatch(
        /Failed to queue delivery config writer/,
      );
    });

    it('continues onboarding when delivery config writer returns ok: false with error', async () => {
      queueDeliveryConfigWriterStub.resolves({ ok: false, error: 'mock error' });
      mockSite = createMockSite({
        authoringType: SiteModel.AUTHORING_TYPES.CS,
        deliveryConfig: redirectReadyDeliveryConfig,
      });
      mockDataAccess.Site.create.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(queueDeliveryConfigWriterStub).to.have.been.calledOnce;
      expect(queueDeliveryConfigWriterStub).to.have.been.calledWith(
        expectedRedirectQueuePayload(),
        context,
      );
      expect(mockOnboarding.setSteps).to.have.been.calledWith(
        sinon.match.hasNested('deliveryConfigQueued', false),
      );
      expect(mockLog.warn).to.have.been.calledWithMatch(
        /Failed to queue delivery config writer for site .*mock error/,
      );
    });

    it('continues onboarding when delivery config writer returns ok: false without error string', async () => {
      queueDeliveryConfigWriterStub.resolves({ ok: false });
      mockSite = createMockSite({
        authoringType: SiteModel.AUTHORING_TYPES.CS,
        deliveryConfig: redirectReadyDeliveryConfig,
      });
      mockDataAccess.Site.create.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(queueDeliveryConfigWriterStub).to.have.been.calledOnce;
      expect(queueDeliveryConfigWriterStub).to.have.been.calledWith(
        expectedRedirectQueuePayload(),
        context,
      );
      expect(mockOnboarding.setSteps).to.have.been.calledWith(
        sinon.match.hasNested('deliveryConfigQueued', false),
      );
      expect(mockLog.warn).to.have.been.calledWithMatch(
        /Failed to queue delivery config writer/,
      );
    });
  });

  // --- Summit PLG config enrollment ---

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

  // --- Brand profile ---

  describe('onboard - brand profile trigger', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('continues when brand profile trigger fails', async () => {
      triggerBrandProfileAgentStub.rejects(new Error('SFN timeout'));

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to trigger brand-profile/);
    });
  });

  // --- Skips locale when already set ---

  describe('onboard - locale skipping', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('skips locale detection when language and region already set', async () => {
      mockSite = createMockSite({ language: 'de', region: 'DE' });
      mockDataAccess.Site.create.resolves(mockSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      await controller.onboard(context);

      expect(detectLocaleStub).to.not.have.been.called;
      expect(mockSite.setLanguage).to.not.have.been.called;
      expect(mockSite.setRegion).to.not.have.been.called;
    });
  });

  // --- Fast path for preonboarded sites ---

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
      expect(tierClientCreateForSiteStub).to.have.been.called;
      expect(triggerAuditsStub).to.not.have.been.called;
      expect(preonboardedOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(preonboardedOnboarding.setCompletedAt).to.have.been.called;
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
      // Verify order: site org reassignment happens BEFORE entitlement operations
      expect(siteInInternalOrg.save).to.have.been.calledBefore(tierClientCreateForSiteStub);
      // Verify TierClient.createForSite gets the REFRESHED instance, not the stale one —
      // this is the core invariant of the post-save re-fetch design.
      expect(tierClientCreateForSiteStub).to.have.been.calledWith(
        sinon.match.any,
        refreshedSite,
        sinon.match.any,
      );
      expect(tierClientCreateForSiteStub).to.not.have.been.calledWith(
        sinon.match.any,
        siteInInternalOrg,
        sinon.match.any,
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
      // Should NOT create entitlement
      expect(tierClientCreateForSiteStub).to.not.have.been.called;
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

    it('logs a warning when site org is not reflected in DB after reassignment', async () => {
      const INTERNAL_ORG_ID = 'internal-org-123';
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: INTERNAL_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(preonboardedOnboarding);

      const siteInInternalOrg = createMockSite({ id: TEST_SITE_ID, orgId: INTERNAL_ORG_ID });
      // Re-fetch returns null — warn path in reassignSiteOrganization.
      mockDataAccess.Site.findById.onFirstCall().resolves(siteInInternalOrg)
        .onSecondCall().resolves(null);

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const response = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(response.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/org not reflected in DB after save/);
    });

    it('logs a warning when refetched site still has the old org (replica lag)', async () => {
      const INTERNAL_ORG_ID = 'internal-org-stale';
      const preonboardedOnboarding = createMockOnboarding({
        status: 'PRE_ONBOARDING',
        siteId: TEST_SITE_ID,
        organizationId: INTERNAL_ORG_ID,
      });
      mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(preonboardedOnboarding);

      const siteInInternalOrg = createMockSite({ id: TEST_SITE_ID, orgId: INTERNAL_ORG_ID });
      // Re-fetch returns a site still pointing at the old org.
      const staleRefetch = createMockSite({ id: TEST_SITE_ID, orgId: INTERNAL_ORG_ID });
      mockDataAccess.Site.findById.onFirstCall().resolves(siteInInternalOrg)
        .onSecondCall().resolves(staleRefetch);

      mockEnv.ASO_PLG_EXCLUDED_ORGS = INTERNAL_ORG_ID;
      mockEnv.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS = '';

      const response = await controller.onboard(buildContext({ domain: TEST_DOMAIN }));

      expect(response.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/org not reflected in DB after save/);
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
      // Verify order: site org reassignment happens BEFORE entitlement operations
      expect(existingSite.save).to.have.been.calledBefore(tierClientCreateForSiteStub);
      // Verify TierClient.createForSite gets the REFRESHED instance, not the stale one —
      // this is the core invariant of the post-save re-fetch design.
      expect(tierClientCreateForSiteStub).to.have.been.calledWith(
        sinon.match.any,
        refreshedSiteFullPath,
        sinon.match.any,
      );
      expect(tierClientCreateForSiteStub).to.not.have.been.calledWith(
        sinon.match.any,
        existingSite,
        sinon.match.any,
      );
    });
  });

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
    });
  });

  // --- PATCH /plg/onboard/:onboardingId (update) + admin PLG record APIs ---

  describe('update and admin PLG record APIs', () => {
    let AdminAccessPlgController;

    beforeEach(async () => {
      AdminAccessPlgController = (await esmock(
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
              REVIEW_REASONS: {
                DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
                AEM_SITE_CHECK: 'AEM_SITE_CHECK',
                DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
              },
              REVIEW_DECISIONS: {
                BYPASSED: 'BYPASSED',
                UPHELD: 'UPHELD',
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
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../src/utils/slack/base.js': { loadProfileConfig: loadProfileConfigStub },
          '../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => true }) },
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
          '../../../src/controllers/plg/plg-onboarding.js',
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
              default: { createForSite: sandbox.stub() },
            },
            '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
              Config: { toDynamoItem: sandbox.stub() },
            },
            '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
              Entitlement: { PRODUCT_CODES: { ASO: 'aso_optimizer' }, TIERS: { FREE_TRIAL: 'FREE_TRIAL', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD' } },
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
                REVIEW_REASONS: {
                  DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
                  AEM_SITE_CHECK: 'AEM_SITE_CHECK',
                  DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
                },
                REVIEW_DECISIONS: { BYPASSED: 'BYPASSED', UPHELD: 'UPHELD' },
              },
            },
            '../../../src/controllers/llmo/llmo-onboarding.js': {
              createOrFindOrganization: sandbox.stub(),
              enableAudits: sandbox.stub(),
              enableImports: sandbox.stub(),
              triggerAudits: sandbox.stub(),
            },
            '../../../src/support/utils.js': {
              autoResolveAuthorUrl: sandbox.stub(),
              updateCodeConfig: sandbox.stub(),
              findDeliveryType: sandbox.stub(),
              deriveProjectName: sandbox.stub(),
              queueDeliveryConfigWriter: sandbox.stub(),
            },
            '../../../src/utils/slack/base.js': { loadProfileConfig: sandbox.stub().returns(PLG_PROFILE) },
            '../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: sandbox.stub() },
            '../../../src/support/access-control-util.js': {
              default: { fromContext: () => ({ hasAdminAccess: () => false }) },
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
        expect(res.value).to.equal('Onboarding record must be in WAITLISTED or ONBOARDED state');
      });

      it('ONBOARDED: revokes ASO enrollments, sets WAITLISTED, appends review', async () => {
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
        const mockEnrollment = {
          getId: () => 'enroll-onboarded',
          remove: sandbox.stub().resolves(),
          getEntitlement: sandbox.stub().resolves(asoEntitlement),
        };
        const linkedSite = createMockSite({ siteEnrollments: [mockEnrollment] });
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: TEST_SITE_ID,
          waitlistReason: '',
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findById.resolves(linkedSite);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'Recorded for audit' },
          attributes: adminAuthAttributes,
          log: mockLog,
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(mockDataAccess.Site.findById).to.have.been.calledWith(TEST_SITE_ID);
        expect(mockEnrollment.remove).to.have.been.calledOnce;
        expect(record.setReviews).to.have.been.calledOnce;
        const reviews = record.setReviews.firstCall.args[0];
        expect(reviews).to.have.length(1);
        expect(reviews[0].decision).to.equal('BYPASSED');
        expect(reviews[0].justification).to.equal('Recorded for audit');
        expect(record.setStatus).to.have.been.calledWith('WAITLISTED');
        expect(record.setWaitlistReason).to.have.been.calledWith('Recorded for audit');
        expect(record.save).to.have.been.calledOnce;
        expect(mockDataAccess.PlgOnboarding.allByImsOrgId).to.not.have.been.called;
        expect(res.value).to.have.property('updatedBy');
      });

      it('ONBOARDED: disables summit-plg handler when revoking enrollment', async () => {
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
        const mockEnrollment = {
          getId: () => 'enroll-onboarded',
          remove: sandbox.stub().resolves(),
          getEntitlement: sandbox.stub().resolves(asoEntitlement),
        };
        const linkedSite = createMockSite({ siteEnrollments: [mockEnrollment] });
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: TEST_SITE_ID,
          waitlistReason: '',
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findById.resolves(linkedSite);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'Offboarding' },
          attributes: adminAuthAttributes,
          log: mockLog,
          env: {},
        });

        expect(res.status).to.equal(200);
        const config = await mockDataAccess.Configuration.findLatest();
        expect(config.disableHandlerForSite).to.have.been.calledWith('summit-plg', linkedSite);
      });

      it('ONBOARDED: logs warning when disabling summit-plg handler fails', async () => {
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
        const mockEnrollment = {
          getId: () => 'enroll-onboarded',
          remove: sandbox.stub().resolves(),
          getEntitlement: sandbox.stub().resolves(asoEntitlement),
        };
        const linkedSite = createMockSite({ siteEnrollments: [mockEnrollment] });
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: TEST_SITE_ID,
          waitlistReason: '',
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findById.resolves(linkedSite);
        mockDataAccess.Configuration.findLatest.resolves({
          enableHandlerForSite: sandbox.stub(),
          disableHandlerForSite: sandbox.stub().throws(new Error('Config write failed')),
          save: sandbox.stub().resolves(),
          getQueues: sandbox.stub().returns({ audits: 'audit-queue-url' }),
        });

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'Offboarding' },
          attributes: adminAuthAttributes,
          log: mockLog,
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to disable summit-plg handler/);
      });

      it('ONBOARDED: sets WAITLISTED without Site lookup when no site is linked', async () => {
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: null,
          imsOrgId: '',
          waitlistReason: '',
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'UPHELD', justification: 'Offboarding without site' },
          attributes: adminAuthAttributes,
          log: mockLog,
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(mockDataAccess.Site.findById).to.not.have.been.called;
        expect(record.setStatus).to.have.been.calledWith('WAITLISTED');
        expect(record.setWaitlistReason).to.have.been.calledWith('Offboarding without site');
        expect(record.save).to.have.been.calledOnce;
      });

      it('ONBOARDED: logs warn and continues to WAITLISTED when ASO enrollment revocation fails', async () => {
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
        const mockEnrollment = {
          getId: () => 'enroll-onboarded',
          remove: sandbox.stub().rejects(new Error('remove failed')),
          getEntitlement: sandbox.stub().resolves(asoEntitlement),
        };
        const linkedSite = createMockSite({ siteEnrollments: [mockEnrollment] });
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: TEST_SITE_ID,
          waitlistReason: '',
        });
        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findById.resolves(linkedSite);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'test' },
          attributes: adminAuthAttributes,
          log: mockLog,
          env: {},
        });

        expect(res.status).to.equal(200);
        expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to revoke one or more ASO enrollments/);
        expect(record.setStatus).to.have.been.calledWith('WAITLISTED');
      });

      it('ONBOARDED: returns 500 when save fails', async () => {
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: null,
          waitlistReason: '',
        });
        record.save.rejects(new Error('persist failed'));
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'UPHELD', justification: 'test' },
          attributes: adminAuthAttributes,
          log: mockLog,
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to waitlist onboarding. Please try again later.');
        expect(mockLog.error).to.have.been.calledWithMatch(
          sinon.match(/^Failed to waitlist onboarded PLG domain example.com: persist failed/),
          sinon.match.instanceOf(Error),
        );
      });

      it('ONBOARDED: returns 500 when save rejects with a non-Error value', async () => {
        const record = createMockOnboarding({
          status: 'ONBOARDED',
          siteId: null,
          waitlistReason: '',
        });
        // eslint-disable-next-line prefer-promise-reject-errors -- cover catch String(err) branch
        record.save.callsFake(() => Promise.reject(503));
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'UPHELD', justification: 'test' },
          attributes: adminAuthAttributes,
          log: mockLog,
        });

        expect(res.status).to.equal(500);
        expect(res.value).to.equal('Failed to waitlist onboarding. Please try again later.');
        expect(mockLog.error).to.have.been.calledOnce;
        expect(mockLog.error.firstCall.args[0]).to.match(
          /^Failed to waitlist onboarded PLG domain example.com: 503$/,
        );
        expect(mockLog.error.firstCall.args[1]).to.equal(503);
      });

      it('stores UPHOLD review and keeps status unchanged', async () => {
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
        });

        expect(res.status).to.equal(200);
        expect(record.setReviews).to.have.been.calledOnce;
        const reviews = record.setReviews.firstCall.args[0];
        expect(reviews).to.have.length(1);
        expect(reviews[0].reason).to.equal('Domain site-a.com is another domain is already onboarded for this IMS org');
        expect(reviews[0].decision).to.equal('UPHELD');
        expect(reviews[0].justification).to.equal('Not ready to proceed');
        expect(record.setStatus).to.not.have.been.called;
        expect(record.save).to.have.been.calledOnce;
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
        });

        expect(res.status).to.equal(200);
        expect(record.setUpdatedBy).to.not.have.been.called;
        const reviews = record.setReviews.firstCall.args[0];
        expect(reviews[0].reviewedBy).to.equal('admin');
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
        expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
        expect(oldOnboardedRecord.setWaitlistReason).to.have.been.calledWith(
          sinon.match(/was displaced by.*for IMS org/),
        );
        expect(oldOnboardedRecord.setReviews).to.have.been.calledOnce;
        const oldReviews = oldOnboardedRecord.setReviews.firstCall.args[0];
        expect(oldReviews).to.have.length(1);
        expect(oldReviews[0].reason)
          .to.equal(`Offboarded to onboard ${TEST_DOMAIN} for same IMS org`);
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
        expect(waitlistedRecord.setUpdatedBy).to.not.have.been.called;
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
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
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
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
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
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
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
        expect(rerunRecord.setStatus).to.have.been.calledWith('WAITING_FOR_IP_ALLOWLISTING');
      });

      it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: rerun completes successfully when imsOrgId is missing', async () => {
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
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
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
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
        expect(rerunRecord.setStatus).to.have.been.calledWith('ONBOARDED');
      });

      it('BYPASS DOMAIN_ALREADY_ONBOARDED_IN_ORG: revokes ASO enrollments when old domain has a linked site', async () => {
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
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
        expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
        expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
        expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('WAITLISTED');
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
          getEntitlement: sandbox.stub().resolves({ getProductCode: () => 'aso_optimizer' }),
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
        expect(record.setUpdatedBy).to.not.have.been.called;
        expect(rerunRecord.setUpdatedBy).to.not.have.been.called;
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

      it('BYPASS AEM_SITE_CHECK: sets authorURL when deliveryType is aem_ams', async () => {
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

      it('BYPASS AEM_SITE_CHECK: sets programId for aem_ams when authorUrl omitted', async () => {
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
        expect(record.setStatus).to.have.been.calledWith('WAITLISTED');
        expect(record.setWaitlistReason).to.have.been.calledWith(
          sinon.match(/was replaced by alternate domain/),
        );
        expect(record.save).to.have.been.called;
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
        expect(record.setUpdatedBy).to.not.have.been.called;
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

      describe('updateOnboardingStatus', () => {
        it('returns 403 when caller is not admin', async () => {
          const res = await PlgOnboardingController({ log: mockLog }).updateOnboardingStatus({
            data: { status: 'INACTIVE' },
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
          });
          expect(res.status).to.equal(403);
        });

        it('returns 400 when data is null', async () => {
          const res = await AdminAccessPlgController({ log: mockLog }).updateOnboardingStatus({
            data: null,
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
          });
          expect(res.status).to.equal(400);
        });

        it('returns 400 when status is missing', async () => {
          const res = await AdminAccessPlgController({ log: mockLog }).updateOnboardingStatus({
            data: {},
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
          });
          expect(res.status).to.equal(400);
        });

        it('returns 400 when status is invalid', async () => {
          const res = await AdminAccessPlgController({ log: mockLog }).updateOnboardingStatus({
            data: { status: 'BOGUS' },
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
          });
          expect(res.status).to.equal(400);
        });

        it('returns 404 when record not found', async () => {
          const res = await AdminAccessPlgController({ log: mockLog }).updateOnboardingStatus({
            data: { status: 'INACTIVE' },
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
          });
          expect(res.status).to.equal(404);
        });

        it('updates status and returns 200', async () => {
          mockDataAccess.PlgOnboarding.findById.resolves(mockOnboarding);
          const res = await AdminAccessPlgController({ log: mockLog }).updateOnboardingStatus({
            data: { status: 'INACTIVE' },
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
            env: {},
          });
          expect(res.status).to.equal(200);
          expect(mockOnboarding.setStatus).to.have.been.calledWith('INACTIVE');
          expect(mockOnboarding.save).to.have.been.called;
        });

        it('updates status when record imsOrgId is missing', async () => {
          const record = createMockOnboarding({ imsOrgId: '' });
          mockDataAccess.PlgOnboarding.findById.resolves(record);

          const res = await AdminAccessPlgController({ log: mockLog }).updateOnboardingStatus({
            data: { status: 'INACTIVE' },
            params: { plgOnboardingId: TEST_ONBOARDING_ID },
            dataAccess: mockDataAccess,
            attributes: {},
            env: {},
          });

          expect(res.status).to.equal(200);
          expect(record.setStatus).to.have.been.calledWith('INACTIVE');
          expect(record.setUpdatedBy).to.not.have.been.called;
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
