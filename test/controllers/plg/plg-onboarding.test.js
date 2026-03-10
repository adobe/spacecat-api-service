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

/* eslint-env mocha */
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
  let composeBaseURLStub;
  let detectBotBlockerStub;
  let detectLocaleStub;
  let resolveCanonicalUrlStub;
  let createOrFindOrganizationStub;
  let enableAuditsStub;
  let enableImportsStub;
  let triggerAuditsStub;
  let findDeliveryTypeStub;
  let deriveProjectNameStub;
  let loadProfileConfigStub;
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
      getProjectId: sandbox.stub().returns(overrides.projectId || null),
      setProjectId: sandbox.stub(),
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
      setCompletedAt: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Shared-utils stubs
    composeBaseURLStub = sandbox.stub().returns(TEST_BASE_URL);
    detectBotBlockerStub = sandbox.stub().resolves({ crawlable: true });
    detectLocaleStub = sandbox.stub().resolves({ language: 'en', region: 'US' });
    resolveCanonicalUrlStub = sandbox.stub().resolves(TEST_BASE_URL);

    // LLMO onboarding stubs
    mockOrganization = {
      getId: sandbox.stub().returns(TEST_ORG_ID),
    };
    createOrFindOrganizationStub = sandbox.stub().resolves(mockOrganization);
    enableAuditsStub = sandbox.stub().resolves();
    enableImportsStub = sandbox.stub().resolves();
    triggerAuditsStub = sandbox.stub().resolves();

    // Support utils stubs
    findDeliveryTypeStub = sandbox.stub().resolves('aem_edge');
    deriveProjectNameStub = sandbox.stub().returns('example.com');

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
        create: sandbox.stub().resolves(mockSite),
      },
      Organization: {
        findByImsOrgId: sandbox.stub().resolves(mockOrganization),
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
        create: sandbox.stub().resolves(mockOnboarding),
        allByImsOrgId: sandbox.stub().resolves([]),
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
          notFound: (msg) => ({ status: 404, value: msg }),
          ok: (data) => ({ status: 200, value: data }),
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
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          createOrFindOrganization: createOrFindOrganizationStub,
          enableAudits: enableAuditsStub,
          enableImports: enableImportsStub,
          triggerAudits: triggerAuditsStub,
          ASO_DEMO_ORG: DEMO_ORG_ID,
        },
        '../../../src/support/utils.js': {
          findDeliveryType: findDeliveryTypeStub,
          deriveProjectName: deriveProjectNameStub,
        },
        '../../../src/utils/slack/base.js': {
          loadProfileConfig: loadProfileConfigStub,
        },
        '../../../src/support/brand-profile-trigger.js': {
          triggerBrandProfileAgent: triggerBrandProfileAgentStub,
        },
      },
    )).default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  function buildContext(data = {}) {
    return {
      data,
      dataAccess: mockDataAccess,
      log: mockLog,
      env: mockEnv,
      sqs: { sendMessage: sandbox.stub().resolves() },
    };
  }

  // --- Controller validation tests ---

  describe('onboard - input validation', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns 400 when request body is missing', async () => {
      const res = await controller.onboard({ data: null });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Request body is required');
    });

    it('returns 400 when domain is missing', async () => {
      const res = await controller.onboard({
        data: { imsOrgId: TEST_IMS_ORG_ID },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('domain is required');
    });

    it('returns 400 when imsOrgId is missing', async () => {
      const res = await controller.onboard({
        data: { domain: TEST_DOMAIN },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required');
    });

    it('returns 400 when imsOrgId is invalid', async () => {
      const res = await controller.onboard({
        data: { domain: TEST_DOMAIN, imsOrgId: 'not-valid' },
      });
      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required');
    });
  });

  // --- Happy path: new site ---

  describe('onboard - new site (happy path)', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('onboards a new site successfully', async () => {
      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      // Response is now a DTO of the PlgOnboarding model
      expect(res.value.id).to.equal(TEST_ONBOARDING_ID);
      expect(res.value.imsOrgId).to.equal(TEST_IMS_ORG_ID);
      expect(res.value.domain).to.equal(TEST_DOMAIN);
      expect(res.value.baseURL).to.equal(TEST_BASE_URL);

      // Verify PlgOnboarding was created
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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockDataAccess.PlgOnboarding.create).to.not.have.been.called;
      expect(existingOnboarding.setStatus).to.have.been.calledWith('IN_PROGRESS');
      expect(existingOnboarding.setError).to.have.been.calledWith(null);
      expect(existingOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(existingOnboarding.save).to.have.been.called;
    });

    it('sets locale when detected', async () => {
      detectLocaleStub.resolves({ language: 'fr', region: 'FR' });

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSite.setLanguage).to.have.been.calledWith('fr');
      expect(mockSite.setRegion).to.have.been.calledWith('FR');
    });

    it('falls back to en/US when locale detection fails', async () => {
      detectLocaleStub.rejects(new Error('timeout'));

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSite.setLanguage).to.have.been.calledWith('en');
      expect(mockSite.setRegion).to.have.been.calledWith('US');
    });

    it('sets overrideBaseURL when canonical differs', async () => {
      resolveCanonicalUrlStub.resolves('https://www.example.com');

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.have.been.calledWith({
        overrideBaseURL: 'https://www.example.com',
      });
    });

    it('skips overrideBaseURL when canonical matches', async () => {
      resolveCanonicalUrlStub.resolves(TEST_BASE_URL);

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.not.have.been.called;
    });

    it('skips overrideBaseURL when already set', async () => {
      mockSiteConfig.getFetchConfig.returns({
        overrideBaseURL: 'https://existing.com',
      });

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(resolveCanonicalUrlStub).to.not.have.been.called;
    });

    it('handles canonical URL resolution failure gracefully', async () => {
      resolveCanonicalUrlStub.rejects(new Error('network error'));

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to resolve canonical URL/);
    });

    it('sets overrideBaseURL preserving subpath when base URL has one', async () => {
      composeBaseURLStub.returns('https://example.com/blog');
      resolveCanonicalUrlStub.resolves('https://www.example.com/blog');

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.have.been.calledWith({
        overrideBaseURL: 'https://www.example.com/blog',
      });
    });

    it('handles null resolveCanonicalUrl result', async () => {
      resolveCanonicalUrlStub.resolves(null);

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSiteConfig.updateFetchConfig).to.not.have.been.called;
    });

    it('handles getFetchConfig returning null', async () => {
      mockSiteConfig.getFetchConfig.returns(null);
      resolveCanonicalUrlStub.resolves('https://www.example.com');

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockSiteConfig.updateFetchConfig).to.have.been.called;
    });

    it('handles profile with undefined imports and audits', async () => {
      loadProfileConfigStub.returns({});

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
    });

    it('creates a project and assigns it to the site', async () => {
      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockDataAccess.Project.create).to.have.been.calledWith({
        projectName: 'example.com',
        organizationId: TEST_ORG_ID,
      });
      expect(mockSite.setProjectId).to.have.been.calledWith(TEST_PROJECT_ID);
    });

    it('reuses existing project when found', async () => {
      mockDataAccess.Project.allByOrganizationId.resolves([mockProject]);

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockDataAccess.Project.create).to.not.have.been.called;
      expect(mockSite.setProjectId).to.have.been.calledWith(TEST_PROJECT_ID);
    });

    it('skips project assignment when site already has one', async () => {
      mockSite = createMockSite({ projectId: 'existing-project-id' });
      mockDataAccess.Site.create.resolves(mockSite);

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockSite.setProjectId).to.not.have.been.called;
    });
  });

  // --- Bot blocker ---

  describe('onboard - bot blocker', () => {
    let controller;
    beforeEach(() => {
      controller = PlgOnboardingController({ log: mockLog });
    });

    it('returns WAITING_FOR_IP_WHITELISTING when bot blocked (new site)', async () => {
      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      });

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      // Verify onboarding record was updated with bot blocker status
      expect(mockOnboarding.setStatus)
        .to.have.been.calledWith('WAITING_FOR_IP_WHITELISTING');
      expect(mockOnboarding.setBotBlocker).to.have.been.calledWith({
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      });
      expect(mockOnboarding.save).to.have.been.called;
      // Should NOT create a site
      expect(mockDataAccess.Site.create).to.not.have.been.called;
    });

    it('returns WAITING_FOR_IP_WHITELISTING for existing site and saves org change', async () => {
      const existingSite = createMockSite({ orgId: DEFAULT_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      detectBotBlockerStub.resolves({
        crawlable: false,
        type: 'akamai',
        userAgent: 'SpaceCat/1.0',
      });

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus)
        .to.have.been.calledWith('WAITING_FOR_IP_WHITELISTING');
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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(mockOnboarding.setBotBlocker).to.have.been.calledWith({
        type: 'generic',
        ipsToAllowlist: ['5.6.7.8'],
        userAgent: 'Bot/2.0',
      });
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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setOrganizationId).to.have.been.calledWith(TEST_ORG_ID);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('reassigns site from ASO_DEMO_ORG to customer org', async () => {
      const existingSite = createMockSite({ orgId: DEMO_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

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

    it('returns 400 when site belongs to another customer org', async () => {
      const existingSite = createMockSite({ orgId: OTHER_CUSTOMER_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(400);
      expect(res.value).to.include('already assigned to another organization');
      // Should NOT modify the site
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      expect(existingSite.save).to.not.have.been.called;
      // Verify onboarding record was set to ERROR
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ERROR');
      expect(mockOnboarding.setError).to.have.been.called;
      expect(mockOnboarding.save).to.have.been.called;
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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
    });

    it('returns 400 when entitlement creation fails unexpectedly', async () => {
      tierClientCreateEntitlementStub.rejects(
        new Error('Tier service unavailable'),
      );

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      const res = await controller.onboard(context);

      expect(res.status).to.equal(400);
      expect(res.value).to.include('Tier service unavailable');
      // Verify error was recorded in onboarding record
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ERROR');
      expect(mockOnboarding.setError).to.have.been.called;
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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

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

      const context = buildContext({
        domain: TEST_DOMAIN,
        imsOrgId: TEST_IMS_ORG_ID,
      });

      await controller.onboard(context);

      expect(detectLocaleStub).to.not.have.been.called;
      expect(mockSite.setLanguage).to.not.have.been.called;
      expect(mockSite.setRegion).to.not.have.been.called;
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
      });

      expect(res.status).to.equal(400);
      expect(res.value).to.equal('Valid imsOrgId is required');
    });

    it('returns 400 for empty imsOrgId', async () => {
      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: '' },
      });

      expect(res.status).to.equal(400);
    });

    it('returns 404 when no records found', async () => {
      mockDataAccess.PlgOnboarding.allByImsOrgId.resolves([]);

      const res = await controller.getStatus({
        dataAccess: mockDataAccess,
        params: { imsOrgId: TEST_IMS_ORG_ID },
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
      });

      expect(res.status).to.equal(200);
      expect(res.value).to.be.an('array').with.length(2);
      expect(res.value[0].id).to.equal('rec-1');
      expect(res.value[0].domain).to.equal('example1.com');
      expect(res.value[1].id).to.equal('rec-2');
      expect(res.value[1].domain).to.equal('example2.com');
    });
  });
});
