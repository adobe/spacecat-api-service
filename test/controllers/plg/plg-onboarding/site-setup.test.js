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
import {
  TEST_DOMAIN,
  TEST_BASE_URL,
  TEST_ORG_ID,
  TEST_IMS_ORG_ID,
  TEST_PROJECT_ID,
  createSharedMocks,
  createMockSite as createMockSiteShared,
  createMockOnboarding as createMockOnboardingShared,
  createMockDataAccess,
  buildContext as buildContextShared,
} from './shared-fixtures.js';
import { createPlgEsmock } from './plg-esmock-factory.js';

use(sinonChai);

describe('PlgOnboardingController', function describePlgOnboarding() {
  // esmock + extensive sinon stubs make individual tests slower than the 2000ms default.
  this.timeout(10000);

  let sandbox;
  let stubs;
  let PlgOnboardingController;

  // Stub locals (reassigned each beforeEach for use in tests and inline esmock maps)
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

  before(async () => {
    sandbox = sinon.createSandbox();
    stubs = { ...createSharedMocks(sandbox), sandbox };
    PlgOnboardingController = await createPlgEsmock(stubs);
  });

  after(() => sandbox.restore());

  beforeEach(() => {
    sandbox.reset();

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
    } = stubs);

    // Re-apply stub defaults (sandbox.reset() clears both history and behavior)
    composeBaseURLStub.returns('https://example.com');
    resolveWwwUrlStub.resolves('example.com');
    rumRetrieveDomainkeyStub.resolves('test-domainkey');
    stubs.rumApiClientCreateFromStub.returns({ retrieveDomainkey: rumRetrieveDomainkeyStub });
    updateRumConfigStub.resolves(true);
    detectBotBlockerStub.resolves({ crawlable: true });
    detectLocaleStub.resolves({ language: 'en', region: 'US' });
    resolveCanonicalUrlStub.resolves('https://example.com');
    createOrFindOrganizationStub.resolves(mockOrganization);
    enableAuditsStub.resolves();
    enableImportsStub.resolves();
    triggerAuditsStub.resolves();
    autoResolveAuthorUrlStub.resolves(null);
    updateCodeConfigStub.resolves();
    findDeliveryTypeStub.resolves('aem_edge');
    deriveProjectNameStub.returns('example.com');
    queueDeliveryConfigWriterStub.resolves({ ok: true });
    loadProfileConfigStub.returns({
      audits: {
        'alt-text': {}, cwv: {}, 'broken-backlinks': {}, 'scrape-top-pages': {},
      },
      imports: {
        'organic-traffic': {}, 'top-pages': {}, 'all-traffic': {},
      },
    });
    triggerBrandProfileAgentStub.resolves('exec-123');
    ldCreateFromStub.returns({
      getFeatureFlag: stubs.ldGetFeatureFlagStub,
      updateVariationValue: stubs.ldUpdateVariationValueStub,
    });
    stubs.ldGetFeatureFlagStub.resolves({ variations: [{ value: {} }] });
    stubs.ldUpdateVariationValueStub.resolves({});
    tierClientCreateForSiteStub.resolves({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID },
        siteEnrollment: { getId: () => 'enroll-1' },
      }),
    });
    tierClientCreateForOrgStub.returns({
      createEntitlement: stubs.tierClientCreateEntitlementStub,
      checkValidEntitlement: sandbox.stub().resolves({
        entitlement: {
          getId: () => 'ent-1',
          getOrganizationId: () => TEST_ORG_ID,
          getTier: () => 'PLG',
        },
      }),
    });
    stubs.tierClientCreateEntitlementStub.resolves({
      entitlement: { getId: () => 'ent-1', getOrganizationId: () => TEST_ORG_ID, getTier: () => 'PLG' },
      siteEnrollment: { getId: () => 'enroll-1' },
    });
    configToDynamoItemStub.returns({ config: 'dynamo' });
    // Re-apply mock object stub defaults (sandbox.reset() clears these too)
    mockOrganization.getId.returns(TEST_ORG_ID);
    mockOrganization.getImsOrgId.returns(TEST_IMS_ORG_ID);
    mockOrganization.getName.returns('Test Org');
    mockProject.getId.returns(TEST_PROJECT_ID);
    mockProject.getProjectName.returns('example.com');
    mockSiteConfig.getFetchConfig.returns({});
    mockSiteConfig.getImports.returns([]);

    mockSite = createMockSite();
    mockOnboarding = createMockOnboarding();
    mockDataAccess = createMockDataAccess(sandbox, {
      mockSite, mockOrganization, mockProject, mockOnboarding,
    });
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

    describe('delivery type mismatch alerts', () => {
      let postSlackMessageStub;
      let AlertControllerFactory;

      before(async () => {
        postSlackMessageStub = sandbox.stub().resolves();
        AlertControllerFactory = await createPlgEsmock(stubs, {
          hasAdminAccess: false,
          postSlackMessageStub,
        });
      });

      beforeEach(() => {
        postSlackMessageStub.reset();
      });

      it('alerts via Slack when detected delivery type differs from stored type', async () => {
        rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
        findDeliveryTypeStub.resetHistory();
        findDeliveryTypeStub.resolves('aem_edge');
        const existingSite = createMockSite({ deliveryType: 'aem_cs', orgId: TEST_ORG_ID });
        mockDataAccess.Site.findByBaseURL.resolves(existingSite);

        const alertController = AlertControllerFactory({ log: mockLog });
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
        postSlackMessageStub.rejects(new Error('Slack API down'));
        rumRetrieveDomainkeyStub.rejects(new Error('No RUM data'));
        findDeliveryTypeStub.resetHistory();
        findDeliveryTypeStub.resolves('aem_edge');
        const existingSite = createMockSite({ deliveryType: 'aem_cs', orgId: TEST_ORG_ID });
        mockDataAccess.Site.findByBaseURL.resolves(existingSite);

        const alertController = AlertControllerFactory({ log: mockLog });
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
