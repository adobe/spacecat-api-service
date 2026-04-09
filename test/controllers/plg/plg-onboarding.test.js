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

describe('PlgOnboardingController', () => {
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
  let updateCodeConfigStub;
  let findDeliveryTypeStub;
  let deriveProjectNameStub;
  let loadProfileConfigStub;
  let queueDeliveryConfigWriterStub;
  let triggerBrandProfileAgentStub;
  let tierClientCreateForSiteStub;
  let tierClientCreateEntitlementStub;
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
      save: sandbox.stub().resolves(),
    };
  }

  function createMockOnboarding(overrides = {}) {
    const record = {
      id: overrides.id || TEST_ONBOARDING_ID,
      imsOrgId: overrides.imsOrgId || TEST_IMS_ORG_ID,
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
      getCompletedAt: sandbox.stub().returns(record.completedAt),
      getCreatedAt: sandbox.stub().returns(record.createdAt),
      getUpdatedAt: sandbox.stub().returns(record.updatedAt),
      setStatus: sandbox.stub(),
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
    };
    createOrFindOrganizationStub = sandbox.stub().resolves(mockOrganization);
    enableAuditsStub = sandbox.stub().resolves();
    enableImportsStub = sandbox.stub().resolves();
    triggerAuditsStub = sandbox.stub().resolves();

    // Support utils stubs
    autoResolveAuthorUrlStub = sandbox.stub().resolves(null);
    updateCodeConfigStub = sandbox.stub().resolves();
    findDeliveryTypeStub = sandbox.stub().resolves('aem_edge');
    deriveProjectNameStub = sandbox.stub().returns('example.com');
    queueDeliveryConfigWriterStub = sandbox.stub().resolves({ ok: true });

    // Profile config
    loadProfileConfigStub = sandbox.stub().returns(PLG_PROFILE);

    // Brand profile
    triggerBrandProfileAgentStub = sandbox.stub().resolves('exec-123');

    // TierClient
    tierClientCreateEntitlementStub = sandbox.stub().resolves({
      entitlement: { getId: () => 'ent-1' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    tierClientCreateForSiteStub = sandbox.stub().resolves({
      createEntitlement: tierClientCreateEntitlementStub,
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
    };

    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };

    mockEnv = {
      DEFAULT_ORGANIZATION_ID: DEFAULT_ORG_ID,
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
        '@adobe/spacecat-shared-rum-api-client': {
          default: {
            createFrom: sandbox.stub().returns({
              retrieveDomainkey: rumRetrieveDomainkeyStub,
            }),
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: { createForSite: tierClientCreateForSiteStub },
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: configToDynamoItemStub },
        },
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { ASO: 'aso_optimizer' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
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
          ASO_DEMO_ORG: DEMO_ORG_ID,
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
          '@adobe/spacecat-shared-tier-client': {
            default: { createForSite: tierClientCreateForSiteStub },
          },
          '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
            Config: { toDynamoItem: configToDynamoItemStub },
          },
          '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
            Entitlement: {
              PRODUCT_CODES: { ASO: 'aso_optimizer' },
              TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
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
            ASO_DEMO_ORG: DEMO_ORG_ID,
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
      expect(res.value).to.equal('imsOrgId is required when onboarding as admin');
    });

    it('returns 400 when imsOrgId is empty string in admin onboard call', async () => {
      const context = buildContext({ domain: TEST_DOMAIN, imsOrgId: '' });
      const res = await adminController.onboard(context);
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('imsOrgId is required when onboarding as admin');
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
      expect(mockOnboarding.save).to.have.been.called;
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

    it('returns WAITING_FOR_IP_ALLOWLISTING for existing site and saves org change', async () => {
      const existingSite = createMockSite({ orgId: DEFAULT_ORG_ID });
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
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(existingSite.save).to.have.been.called;
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

    it('reassigns site from DEFAULT_ORGANIZATION_ID to customer org', async () => {
      const existingSite = createMockSite({ orgId: DEFAULT_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('reassigns site from ASO_DEMO_ORG to customer org', async () => {
      const existingSite = createMockSite({ orgId: DEMO_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
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
  });

  // --- AEM site verification ---

  describe('onboard - AEM site verification', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
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

    it('returns 500 when entitlement creation fails unexpectedly', async () => {
      tierClientCreateEntitlementStub.rejects(
        new Error('Tier service unavailable'),
      );

      const context = buildContext({ domain: TEST_DOMAIN });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(500);
      expect(res.value).to.equal('Onboarding failed. Please try again later.');
      // Verify error was recorded with sanitized message
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ERROR');
      expect(mockOnboarding.setError).to.have.been.calledWith({
        message: 'An internal error occurred',
      });
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
      // Should NOT run full onboarding steps
      expect(createOrFindOrganizationStub).to.not.have.been.called;
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
          '@adobe/spacecat-shared-tier-client': {
            default: { createForSite: tierClientCreateForSiteStub },
          },
          '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
            Config: { toDynamoItem: configToDynamoItemStub },
          },
          '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
            Entitlement: {
              PRODUCT_CODES: { ASO: 'aso_optimizer' },
              TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
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
            ASO_DEMO_ORG: DEMO_ORG_ID,
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
          '@adobe/spacecat-shared-tier-client': {
            default: { createForSite: tierClientCreateForSiteStub },
          },
          '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
            Config: { toDynamoItem: configToDynamoItemStub },
          },
          '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
            Entitlement: {
              PRODUCT_CODES: { ASO: 'aso_optimizer' },
              TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
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
            ASO_DEMO_ORG: DEMO_ORG_ID,
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
            '@adobe/spacecat-shared-tier-client': {
              default: { createForSite: sandbox.stub() },
            },
            '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
              Config: { toDynamoItem: sandbox.stub() },
            },
            '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
              Entitlement: { PRODUCT_CODES: { ASO: 'aso_optimizer' }, TIERS: { FREE_TRIAL: 'FREE_TRIAL' } },
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
              ASO_DEMO_ORG: DEMO_ORG_ID,
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

      it('returns 400 when onboarding is not in a blocked state', async () => {
        const record = createMockOnboarding({ status: 'ONBOARDED' });
        mockDataAccess.PlgOnboarding.findById.resolves(record);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'test' },
          attributes: adminAuthAttributes,
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('Onboarding record is not in a waitlisted state');
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
        expect(oldOnboardedRecord.setStatus).to.have.been.calledWith('INACTIVE');
        expect(oldOnboardedRecord.setReviews).to.have.been.calledOnce;
        const oldReviews = oldOnboardedRecord.setReviews.firstCall.args[0];
        expect(oldReviews).to.have.length(1);
        expect(oldReviews[0].reason).to.include('Offboarded to onboard');
        expect(oldReviews[0].justification).to.include('Offboarded to onboard');
        expect(oldOnboardedRecord.save).to.have.been.called;
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
        expect(res.value).to.include('rumHost');
      });

      it('BYPASS AEM_SITE_CHECK: returns 400 when rumHost format is invalid', async () => {
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
            siteConfig: { rumHost: 'not-a-valid-rum-host.example.com' },
          },
          attributes: adminAuthAttributes,
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.include('rumHost must be a valid');
      });

      it('BYPASS AEM_SITE_CHECK: pre-sets delivery config and re-runs flow', async () => {
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
              rumHost: 'publish-p123-e456.adobeaemcloud.com',
            },
          },
          attributes: adminAuthAttributes,
          env: mockEnv,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
      });

      it('BYPASS DOMAIN_ALREADY_ASSIGNED: returns 409 when onboarding exists for existing org', async () => {
        const record = createMockOnboarding({
          status: 'WAITLISTED',
          waitlistReason: 'Domain example.com is already assigned to another organization',
          siteId: TEST_SITE_ID,
        });
        const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
        const existingOrg = {
          getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
          getImsOrgId: sandbox.stub().returns('OTHERORG123@AdobeOrg'),
        };
        const existingPlgOnboarding = createMockOnboarding({
          imsOrgId: 'OTHERORG123@AdobeOrg',
          status: 'ONBOARDED',
        });

        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findByBaseURL.resolves(existingSite);
        mockDataAccess.Organization.findById.resolves(existingOrg);
        mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(existingPlgOnboarding);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'Run under existing org' },
          attributes: adminAuthAttributes,
          env: mockEnv,
          log: mockLog,
        });

        expect(res.status).to.equal(409);
        expect(res.value.message).to.include('already an onboarding entry');
      });

      it('BYPASS DOMAIN_ALREADY_ASSIGNED: offboards original and runs flow under existing org', async () => {
        const record = createMockOnboarding({
          status: 'WAITLISTED',
          waitlistReason: 'Domain example.com is already assigned to another organization',
          siteId: TEST_SITE_ID,
        });
        const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
        const existingOrg = {
          getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
          getImsOrgId: sandbox.stub().returns('OTHERORG123@AdobeOrg'),
        };

        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findByBaseURL.resolves(existingSite);
        mockDataAccess.Organization.findById.resolves(existingOrg);
        // No existing PLG onboarding for (domain, OrgB)
        mockDataAccess.PlgOnboarding.findByImsOrgIdAndDomain.resolves(null);
        mockDataAccess.Site.create.resolves(mockSite);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'Run under existing org' },
          attributes: adminAuthAttributes,
          env: mockEnv,
          log: mockLog,
        });

        expect(res.status).to.equal(200);
        // Original record should be offboarded
        expect(record.setStatus).to.have.been.calledWith('INACTIVE');
        expect(record.save).to.have.been.called;
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

      it('BYPASS DOMAIN_ALREADY_ASSIGNED: returns 400 when existing org has no IMS org ID', async () => {
        const record = createMockOnboarding({
          status: 'WAITLISTED',
          waitlistReason: 'Domain example.com is already assigned to another organization',
          siteId: TEST_SITE_ID,
        });
        const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
        const orgWithoutIms = {
          getId: sandbox.stub().returns(OTHER_CUSTOMER_ORG_ID),
          getImsOrgId: sandbox.stub().returns(null),
        };

        mockDataAccess.PlgOnboarding.findById.resolves(record);
        mockDataAccess.Site.findByBaseURL.resolves(existingSite);
        mockDataAccess.Organization.findById.resolves(orgWithoutIms);

        const res = await AdminAccessPlgController({ log: mockLog }).update({
          dataAccess: mockDataAccess,
          params: { onboardingId: TEST_ONBOARDING_ID },
          data: { decision: 'BYPASSED', justification: 'Run under existing org' },
          attributes: adminAuthAttributes,
          env: mockEnv,
          log: mockLog,
        });

        expect(res.status).to.equal(400);
        expect(res.value).to.equal('Cannot determine IMS org for the existing site owner');
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
          });
          expect(res.status).to.equal(200);
          expect(mockOnboarding.setStatus).to.have.been.calledWith('INACTIVE');
          expect(mockOnboarding.save).to.have.been.called;
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
