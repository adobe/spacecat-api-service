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
  TEST_ORG_ID,
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
        updateRumConfig: sandbox.stub(),
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
      // called once in the RUM-fail path; Step 5a is skipped (siteCreated=true)
      expect(findDeliveryTypeStub).to.have.been.calledOnce;
    });

    it('alerts via Slack when detected delivery type differs from stored type', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
      findDeliveryTypeStub.resetHistory();
      findDeliveryTypeStub.resolves('aem_edge');
      const existingSite = createMockSite({ deliveryType: 'aem_cs', orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const postSlackMessageStub = sandbox.stub().resolves();
      const AlertController = (await esmock(
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
              REVIEW_DECISIONS: {
                BYPASSED: 'BYPASSED',
                UPHELD: 'UPHELD',
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
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => false }) },
          },
          '../../../../src/support/rum-config-service.js': { updateRumConfig: updateRumConfigStub },
        },
      )).default;

      const alertController = AlertController({ log: mockLog });
      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = {
        ...context.env,
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C_ALERT',
        SLACK_BOT_TOKEN: 'xoxb-test',
      };

      const res = await alertController.onboard(context);

      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(findDeliveryTypeStub).to.have.been.calledOnceWith(TEST_BASE_URL);
      // site must NOT be mutated — alert only
      expect(existingSite.setDeliveryType).to.not.have.been.called;
      expect(existingSite.setDeliveryConfig).to.not.have.been.called;
      expect(existingSite.setHlxConfig).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/Delivery type mismatch/);
      expect(postSlackMessageStub).to.have.been.calledOnce;
      const [channelId, message] = postSlackMessageStub.firstCall.args;
      expect(channelId).to.equal('C_ALERT');
      expect(message).to.include('aem_cs');
      expect(message).to.include('aem_edge');
      expect(message).to.include(existingSite.getId());
      expect(message).to.include(TEST_ORG_ID);
    });

    it('logs error and continues onboarding when delivery type mismatch Slack alert fails', async () => {
      rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
      findDeliveryTypeStub.resetHistory();
      findDeliveryTypeStub.resolves('aem_edge');
      const existingSite = createMockSite({ deliveryType: 'aem_cs', orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const postSlackMessageStub = sandbox.stub().rejects(new Error('Slack API down'));
      const AlertController = (await esmock(
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
              REVIEW_DECISIONS: {
                BYPASSED: 'BYPASSED',
                UPHELD: 'UPHELD',
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
            queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
          },
          '../../../../src/utils/slack/base.js': {
            loadProfileConfig: loadProfileConfigStub,
            postSlackMessage: postSlackMessageStub,
          },
          '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
          '../../../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAdminAccess: () => false }) },
          },
          '../../../../src/support/rum-config-service.js': { updateRumConfig: updateRumConfigStub },
        },
      )).default;

      const alertController = AlertController({ log: mockLog });
      const context = buildContext({ domain: TEST_DOMAIN });
      context.env = {
        ...context.env,
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C_ALERT',
        SLACK_BOT_TOKEN: 'xoxb-test',
      };

      const res = await alertController.onboard(context);

      // Onboarding must still succeed despite the Slack failure
      expect(res.status).to.equal(200);
      expect(mockOnboarding.setStatus).to.have.been.calledWith('ONBOARDED');
      expect(postSlackMessageStub).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWithMatch(/Failed to post delivery type mismatch alert/);
    });

    it('does not alert when detected delivery type matches existing', async () => {
      findDeliveryTypeStub.resetHistory();
      findDeliveryTypeStub.resolves('aem_edge');
      const existingSite = createMockSite({ deliveryType: 'aem_edge', orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setDeliveryType).to.not.have.been.called;
      expect(mockLog.warn).to.not.have.been.calledWithMatch(/Delivery type mismatch/);
    });

    it('skips Step 5a entirely for a new site — no redundant findDeliveryType call', async () => {
      findDeliveryTypeStub.resetHistory();
      findDeliveryTypeStub.resolves('aem_edge');
      // no existing site — Site.findByBaseURL returns null so Site.create is called
      mockDataAccess.Site.findByBaseURL.resolves(null);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      // findDeliveryType called once in Step 5 for site creation; Step 5a is skipped
      expect(findDeliveryTypeStub).to.have.been.calledOnce;
      expect(mockLog.info).to.not.have.been.calledWithMatch(/Clearing stale config/);
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
      // called twice: once in the RUM-fail path (type is OTHER) and once in Step 5a
      expect(findDeliveryTypeStub).to.have.been.calledTwice;
      expect(findDeliveryTypeStub).to.have.been.calledWith(TEST_BASE_URL);
      expect(mockLog.info).to.not.have.been.calledWithMatch(/Using existing site delivery type/);
    });

    it('continues onboarding when findDeliveryType throws in Step 5a', async () => {
      findDeliveryTypeStub.resetHistory();
      findDeliveryTypeStub.rejects(new Error('network timeout'));
      const existingSite = createMockSite({ deliveryType: 'aem_cs', orgId: TEST_ORG_ID });
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);

      const context = buildContext({ domain: TEST_DOMAIN });
      const res = await controller.onboard(context);

      expect(res.status).to.equal(200);
      expect(existingSite.setDeliveryType).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch(/Failed to detect delivery type/);
    });
  });

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
});
