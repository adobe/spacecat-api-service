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

// Import real PlgOnboarding model statics for esmock stubs: normalizeDomain and
// isValidDomain are pure utilities that the controller now delegates to. Stubbing
// them out would silently disable validation — use the real implementations.
import RealPlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';

export const PLG_MODEL_DOMAIN_HELPERS = {
  normalizeDomain: RealPlgOnboardingModel.normalizeDomain,
  isValidDomain: RealPlgOnboardingModel.isValidDomain,
};

export const TEST_DOMAIN = 'example.com';
export const TEST_BASE_URL = 'https://example.com';
export const TEST_IMS_ORG_ID = 'ABC123@AdobeOrg';
export const TEST_ORG_ID = 'org-uuid-1';
export const TEST_SITE_ID = 'site-uuid-1';
export const TEST_PROJECT_ID = 'project-uuid-1';
export const TEST_ONBOARDING_ID = 'onboarding-uuid-1';
export const DEFAULT_ORG_ID = 'default-org-id';
export const DEMO_ORG_ID = '66331367-70e6-4a49-8445-4f6d9c265af9';
export const OTHER_CUSTOMER_ORG_ID = 'other-customer-org-id';
export const ASO_PRODUCT_CODE = 'ASO';

export const PLG_PROFILE = {
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

export function createMockSite(sandbox, overrides = {}, mockSiteConfig = undefined) {
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

export function createMockOnboarding(sandbox, overrides = {}) {
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

/**
 * Creates and returns all the shared stubs and mock objects used across the PLG
 * onboarding controller tests. Mirrors the original top-level beforeEach setup.
 */
export function createSharedMocks(sandbox) {
  // RUM API client stubs
  const rumRetrieveDomainkeyStub = sandbox.stub().resolves('test-domainkey');
  const updateRumConfigStub = sandbox.stub().resolves(true);

  // Shared-utils stubs
  const composeBaseURLStub = sandbox.stub().returns(TEST_BASE_URL);
  const detectBotBlockerStub = sandbox.stub().resolves({ crawlable: true });
  const detectLocaleStub = sandbox.stub().resolves({ language: 'en', region: 'US' });
  const resolveCanonicalUrlStub = sandbox.stub().resolves(TEST_BASE_URL);

  // LLMO onboarding stubs
  const mockOrganization = {
    getId: sandbox.stub().returns(TEST_ORG_ID),
    getImsOrgId: sandbox.stub().returns(TEST_IMS_ORG_ID),
    getName: sandbox.stub().returns('Test Org'),
  };
  const createOrFindOrganizationStub = sandbox.stub().resolves(mockOrganization);
  const enableAuditsStub = sandbox.stub().resolves();
  const enableImportsStub = sandbox.stub().resolves();
  const triggerAuditsStub = sandbox.stub().resolves();

  // Support utils stubs
  const autoResolveAuthorUrlStub = sandbox.stub().resolves(null);
  const resolveWwwUrlStub = sandbox.stub().resolves(TEST_DOMAIN);
  const updateCodeConfigStub = sandbox.stub().resolves();
  const findDeliveryTypeStub = sandbox.stub().resolves('aem_edge');
  const deriveProjectNameStub = sandbox.stub().returns('example.com');
  const queueDeliveryConfigWriterStub = sandbox.stub().resolves({ ok: true });

  // Profile config
  const loadProfileConfigStub = sandbox.stub().returns(PLG_PROFILE);

  // Brand profile
  const triggerBrandProfileAgentStub = sandbox.stub().resolves('exec-123');

  // LaunchDarkly
  const ldGetFeatureFlagStub = sandbox.stub().resolves({
    variations: [{ value: {} }],
  });
  const ldUpdateVariationValueStub = sandbox.stub().resolves({});
  const ldCreateFromStub = sandbox.stub().returns({
    getFeatureFlag: ldGetFeatureFlagStub,
    updateVariationValue: ldUpdateVariationValueStub,
  });

  // TierClient — entitlement.organizationId matches the resolved customer org so the
  // revocation guard in revokePreviousAsoEnrollmentsForOrg sees a consistent state.
  const tierClientCreateEntitlementStub = sandbox.stub().resolves({
    entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
    siteEnrollment: { getId: () => 'enroll-1' },
  });
  const tierClientCreateForSiteStub = sandbox.stub().resolves({
    createEntitlement: tierClientCreateEntitlementStub,
    checkValidEntitlement: sandbox.stub().resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
      siteEnrollment: { getId: () => 'enroll-1' },
    }),
  });
  const tierClientCreateForOrgStub = sandbox.stub().returns({
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
  const configToDynamoItemStub = sandbox.stub().returns({ config: 'dynamo' });

  // Site config mock
  const mockSiteConfig = {
    getFetchConfig: sandbox.stub().returns({}),
    updateFetchConfig: sandbox.stub(),
    updateRumConfig: sandbox.stub(),
    getImports: sandbox.stub().returns([]),
    enableImport: sandbox.stub(),
  };

  // Project
  const mockProject = {
    getId: sandbox.stub().returns(TEST_PROJECT_ID),
    getProjectName: sandbox.stub().returns('example.com'),
  };

  const mockLog = {
    info: sandbox.stub(),
    warn: sandbox.stub(),
    error: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockEnv = {
    DEFAULT_ORGANIZATION_ID: DEFAULT_ORG_ID,
    ASO_PLG_EXCLUDED_ORGS: DEMO_ORG_ID,
    LD_EXPERIENCE_SUCCESS_API_TOKEN: 'test-ld-token',
  };

  return {
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
    ldGetFeatureFlagStub,
    ldUpdateVariationValueStub,
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
  };
}

/**
 * Builds the mockDataAccess object. Requires the shared mocks (mockSite, mockOrganization,
 * mockProject, mockOnboarding) created beforehand.
 */
export function createMockDataAccess(sandbox, {
  mockSite, mockOrganization, mockProject, mockOnboarding,
}) {
  return {
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
}

export function mockAuthInfo(sandbox, imsOrgId = TEST_IMS_ORG_ID) {
  const tenantId = imsOrgId.replace('@AdobeOrg', '');
  return {
    getProfile: sandbox.stub().returns({
      tenants: [{ id: tenantId }],
    }),
  };
}

export function buildContext(
  sandbox,
  mockDataAccess,
  mockLog,
  mockEnv,
  data = {},
  { authInfo, headers } = {},
) {
  return {
    data,
    dataAccess: mockDataAccess,
    log: mockLog,
    env: mockEnv,
    sqs: { sendMessage: sandbox.stub().resolves() },
    attributes: {
      authInfo: authInfo !== undefined ? authInfo : mockAuthInfo(sandbox),
    },
    pathInfo: { headers: headers || {} },
  };
}
