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
              default: { createForOrg: sandbox.stub() },
            },
            '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
              Config: { toDynamoItem: sandbox.stub() },
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
                },
                REVIEW_DECISIONS: {
                  BYPASSED: 'BYPASSED', UPHELD: 'UPHELD', CLOSED: 'CLOSED', REOPENED: 'REOPENED', OFFBOARDED: 'OFFBOARDED',
                },
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
              resolveWwwUrl: sandbox.stub().resolves(TEST_DOMAIN),
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
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
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
        const asoEntitlement = { getProductCode: () => 'aso_optimizer' };
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
            getEntitlement: sandbox.stub().resolves({ getProductCode: () => 'aso_optimizer' }),
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
              steps: { orgResolved: true, rumVerified: true },
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
            { orgResolved: true, rumVerified: true },
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
