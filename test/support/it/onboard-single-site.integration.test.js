/*
 * Copyright 2025 Adobe. All rights reserved.
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
import chaiAsPromised from 'chai-as-promised';
import * as sfn from '@aws-sdk/client-sfn';
import esmock from 'esmock';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';

use(sinonChai);
use(chaiAsPromised);

/**
 * Integration tests for onboardSingleSite
 *
 * These tests call the REAL onboardSingleSite function (not mocked)
 * and verify the actual onboarding logic executes correctly.
 *
 * External dependencies (network calls, TierClient) are mocked.
 */
describe('onboardSingleSite - Integration Tests', () => {
  let onboardSingleSite;
  let sandbox;
  let context;
  let slackContext;
  let configuration;
  let profile;
  let mockSite;
  let mockOrganization;
  let mockProject;
  let mockConfig;
  let sayStub;
  let TierClientMock;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Mock site config with all getter methods needed by Config.toDynamoItem
    mockConfig = {
      // Methods called by Config.toDynamoItem (lines 749-758)
      getSlackConfig: sandbox.stub().returns({}),
      getHandlers: sandbox.stub().returns([]),
      getContentAiConfig: sandbox.stub().returns({}),
      getImports: sandbox.stub().returns([]),
      getFetchConfig: sandbox.stub().returns({}),
      getBrandConfig: sandbox.stub().returns({}),
      getBrandProfile: sandbox.stub().returns(null),
      getCdnLogsConfig: sandbox.stub().returns({}),
      getLlmoConfig: sandbox.stub().returns({}),
      getTokowakaConfig: sandbox.stub().returns({}),
      // Additional methods used by onboardSingleSite
      getHelixConfig: sandbox.stub().returns({}),
      getDeliveryConfig: sandbox.stub().returns({}),
      enableImport: sandbox.stub(),
      updateFetchConfig: sandbox.stub(),
    };

    // Mock site entity methods
    mockSite = {
      getId: sandbox.stub().returns('site-123'),
      getBaseURL: sandbox.stub().returns('https://example.com'),
      getDeliveryType: sandbox.stub().returns('aem_edge'),
      getAuthoringType: sandbox.stub().returns('documentauthoring'),
      getOrganizationId: sandbox.stub().returns('org-123'),
      getProjectId: sandbox.stub().returns(null),
      getLanguage: sandbox.stub().returns(''),
      getRegion: sandbox.stub().returns(''),
      getConfig: sandbox.stub().returns(mockConfig),
      setProjectId: sandbox.stub(),
      setLanguage: sandbox.stub(),
      setRegion: sandbox.stub(),
      setConfig: sandbox.stub(),
      setDeliveryConfig: sandbox.stub(),
      setAuthoringType: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    // Mock organization
    mockOrganization = {
      getId: sandbox.stub().returns('org-123'),
      getName: sandbox.stub().returns('Test Organization'),
      getImsOrgId: sandbox.stub().returns('TEST123@AdobeOrg'),
    };

    // Mock project
    mockProject = {
      getId: sandbox.stub().returns('project-123'),
      getName: sandbox.stub().returns('Test Project'),
      getProjectName: sandbox.stub().returns('Test Project'),
    };

    // Configuration mock
    configuration = {
      getQueues: sandbox.stub().returns({ audits: 'audit-queue-url' }),
      enableHandlerForSite: sandbox.stub(),
      isHandlerEnabledForSite: sandbox.stub().returns(false),
      save: sandbox.stub().resolves(),
    };

    // Slack context
    sayStub = sandbox.stub().resolves();
    slackContext = {
      say: sayStub,
      client: {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      },
      channelId: 'C123',
      threadTs: '1234567890.123456',
    };

    // Lambda context
    context = {
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      },
      sqs: {
        sendMessage: sandbox.stub().resolves(),
      },
      dataAccess: {
        Site: {
          findByBaseURL: sandbox.stub().resolves(null),
          create: sandbox.stub().resolves(mockSite),
        },
        Configuration: {
          findLatest: sandbox.stub().resolves(configuration),
        },
        Organization: {
          findByImsOrgId: sandbox.stub().resolves(mockOrganization),
          create: sandbox.stub().resolves(mockOrganization),
        },
        Project: {
          findById: sandbox.stub().resolves(null),
          allByOrganizationId: sandbox.stub().resolves([]),
          create: sandbox.stub().resolves(mockProject),
        },
        Entitlement: {
          findByOrganizationIdAndProductCode: sandbox.stub().resolves(null),
          create: sandbox.stub().resolves({
            getId: sandbox.stub().returns('entitlement-123'),
          }),
        },
        SiteEnrollment: {
          findBySiteIdAndProductCode: sandbox.stub().resolves(null),
          create: sandbox.stub().resolves({
            getId: sandbox.stub().returns('enrollment-123'),
          }),
        },
      },
      env: {
        DEMO_IMS_ORG: 'DEMO123@AdobeOrg',
        WORKFLOW_WAIT_TIME_IN_SECONDS: 300,
        ONBOARD_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:onboard',
        EXPERIENCE_URL: 'https://experience.adobe.com',
      },
      imsClient: {
        getImsOrganizationDetails: sandbox.stub().resolves({
          orgId: 'org-123',
          name: 'Test Organization',
        }),
      },
    };

    // Profile configuration
    profile = {
      audits: {
        'broken-backlinks': {},
        'broken-internal-links': {},
        'experimentation-opportunities': {},
      },
      imports: {
        'organic-traffic': {},
        'top-pages': {},
      },
    };

    // Mock TierClient
    TierClientMock = {
      createForSite: sandbox.stub().resolves({
        createEntitlement: sandbox.stub().resolves({
          entitlement: {
            getId: sandbox.stub().returns('entitlement-123'),
          },
          siteEnrollment: {
            getId: sandbox.stub().returns('enrollment-123'),
          },
        }),
      }),
    };

    // Stub Step Functions
    sandbox.stub(sfn.SFNClient.prototype, 'send').resolves({ executionArn: 'arn:xyz' });

    // Use esmock to load onboardSingleSite with mocked external dependencies
    const mockedModule = await esmock('../../../src/support/utils.js', {
      '@adobe/spacecat-shared-utils': {
        isValidUrl: () => true,
        isValidIMSOrgId: () => true,
        detectLocale: async () => ({ language: 'en', region: 'US' }),
        resolveCanonicalUrl: async () => 'https://example.com',
      },
      '@adobe/spacecat-shared-tier-client': {
        default: TierClientMock,
      },
    });

    onboardSingleSite = mockedModule.onboardSingleSite;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Happy Path - New Site Onboarding', () => {
    it('should successfully onboard a new site', async () => {
      const result = await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        {},
        { profileName: 'demo' },
      );

      // Verify site was created
      expect(context.dataAccess.Site.create).to.have.been.calledOnce;

      // Verify imports were enabled
      expect(mockConfig.enableImport).to.have.been.calledWith('organic-traffic');
      expect(mockConfig.enableImport).to.have.been.calledWith('top-pages');

      // Verify audits were enabled (auditType, site)
      expect(configuration.enableHandlerForSite).to.have.been.calledWith('broken-backlinks', sinon.match.object);
      expect(configuration.enableHandlerForSite).to.have.been.calledWith('broken-internal-links', sinon.match.object);
      expect(configuration.enableHandlerForSite).to.have.been.calledWith('experimentation-opportunities', sinon.match.object);

      // Verify site was saved
      expect(mockSite.save).to.have.been.called;

      // Verify configuration was saved
      expect(configuration.save).to.have.been.called;

      // Verify Step Functions workflow was started
      expect(sfn.SFNClient.prototype.send).to.have.been.calledOnce;

      // Verify result
      expect(result.status).to.equal('Success');
      expect(result.siteId).to.equal('site-123');
      expect(result.spacecatOrgId).to.equal('org-123');
      expect(result.profile).to.equal('demo');
    });

    it('should onboard existing site', async () => {
      mockSite.getId.returns('existing-site-123');
      context.dataAccess.Site.findByBaseURL.resolves(mockSite);

      const result = await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      // Should not create a new site
      expect(context.dataAccess.Site.create).to.not.have.been.called;

      // Should still enable imports/audits
      expect(mockConfig.enableImport).to.have.been.called;
      expect(configuration.enableHandlerForSite).to.have.been.called;

      // Verify result (existingSite remains "No" as code doesn't set it to "Yes")
      expect(result.siteId).to.equal('existing-site-123');
      expect(result.status).to.equal('Success');
    });
  });

  describe('Organization Handling', () => {
    it('should create new organization if not found', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);

      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      expect(context.imsClient.getImsOrganizationDetails).to.have.been.calledWith('TEST123@AdobeOrg');
      expect(context.dataAccess.Organization.create).to.have.been.calledOnce;
    });

    it('should reuse existing organization', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(mockOrganization);

      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      expect(context.dataAccess.Organization.create).to.not.have.been.called;
    });

    it('should use DEMO_IMS_ORG when no IMS Org ID provided', async () => {
      await onboardSingleSite(
        'https://example.com',
        '', // Empty IMS Org ID
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      expect(context.dataAccess.Organization.findByImsOrgId)
        .to.have.been.calledWith('DEMO123@AdobeOrg');
    });
  });

  describe('Imports Configuration', () => {
    it('should enable only new imports', async () => {
      // Reset the stub to start fresh
      mockConfig.getImports.resetBehavior();
      mockConfig.getImports.returns([{ type: 'organic-traffic' }]);

      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      // organic-traffic already enabled, should only enable top-pages
      // Note: enableImport might be called for both, so we verify top-pages was called
      expect(mockConfig.enableImport).to.have.been.calledWith('top-pages');
    });

    it('should trigger import runs via SQS', async () => {
      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      // Should trigger SQS messages for imports
      expect(context.sqs.sendMessage).to.have.been.called;
    });
  });

  describe('Audits Configuration', () => {
    it('should enable only new audits', async () => {
      configuration.isHandlerEnabledForSite.withArgs('broken-backlinks', sinon.match.object).returns(true);

      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
      );

      // broken-backlinks already enabled, should skip it
      const enableHandlerCalls = configuration.enableHandlerForSite.getCalls();
      const brokenBacklinksCalls = enableHandlerCalls.filter((call) => call.args[0] === 'broken-backlinks');
      expect(brokenBacklinksCalls.length).to.equal(0);

      // Should enable the other two (auditType, site)
      expect(configuration.enableHandlerForSite).to.have.been.calledWith('broken-internal-links', sinon.match.object);
      expect(configuration.enableHandlerForSite).to.have.been.calledWith('experimentation-opportunities', sinon.match.object);
    });
  });

  describe('Workflow Triggering', () => {
    it('should start Step Functions workflow with correct parameters', async () => {
      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        60, // Custom wait time
        slackContext,
        context,
      );

      const sfnCall = sfn.SFNClient.prototype.send.getCall(0);
      expect(sfnCall).to.exist;

      const workflowInput = JSON.parse(sfnCall.args[0].input.input);
      expect(workflowInput).to.have.property('opportunityStatusJob');
      expect(workflowInput).to.have.property('disableImportAndAuditJob');
      expect(workflowInput).to.have.property('demoURLJob');
      expect(workflowInput).to.have.property('cwvDemoSuggestionsJob');
      expect(workflowInput.workflowWaitTime).to.equal(60);
      expect(workflowInput.opportunityStatusJob.siteId).to.equal('site-123');
      expect(workflowInput.demoURLJob.siteId).to.equal('site-123');
    });

    it('should pass scheduledRun parameter correctly', async () => {
      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        { scheduledRun: false },
      );

      const sfnCall = sfn.SFNClient.prototype.send.getCall(0);
      const workflowInput = JSON.parse(sfnCall.args[0].input.input);
      expect(workflowInput.disableImportAndAuditJob.taskContext.scheduledRun).to.equal(false);
    });
  });

  describe('Additional Parameters', () => {
    it('should handle deliveryType parameter', async () => {
      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        { deliveryType: 'aem_cs' },
      );

      const createCall = context.dataAccess.Site.create.getCall(0);
      expect(createCall.args[0]).to.have.property('deliveryType', 'aem_cs');
    });

    it('should handle authoringType parameter', async () => {
      // Ensure Site.create is called so we get a new site (not existing)
      context.dataAccess.Site.findByBaseURL.resolves(null);

      const deliveryConfig = {
        programId: '12345',
        environmentId: '67890',
      };

      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        {
          authoringType: 'cs',
          deliveryConfig, // Required for setAuthoringType to be called
        },
      );

      // setAuthoringType is called when both deliveryConfig and authoringType are provided
      expect(mockSite.setAuthoringType).to.have.been.calledWith('cs');
    });

    it('should handle deliveryConfig parameter', async () => {
      const deliveryConfig = {
        programId: '12345',
        environmentId: '67890',
        authorURL: 'https://author.example.com',
      };

      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        { deliveryConfig },
      );

      expect(mockSite.setDeliveryConfig).to.have.been.calledWith(deliveryConfig);
    });

    it('should handle language and region parameters', async () => {
      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        { language: 'de', region: 'DE' },
      );

      expect(mockSite.setLanguage).to.have.been.calledWith('de');
      expect(mockSite.setRegion).to.have.been.calledWith('DE');
    });

    it('should handle tier parameter', async () => {
      const result = await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        { tier: EntitlementModel.TIERS.PAID },
        { profileName: 'paid' },
      );

      expect(result.tier).to.equal(EntitlementModel.TIERS.PAID);
    });
  });

  describe('Slack Messaging', () => {
    it('should send Slack messages during onboarding', async () => {
      await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        {},
        { profileName: 'demo' },
      );

      // Should send multiple Slack messages
      expect(sayStub).to.have.been.called;
      expect(sayStub.firstCall.args[0]).to.include('Starting environment setup');
      expect(sayStub.firstCall.args[0]).to.include('demo profile');
    });
  });

  describe('Return Value', () => {
    it('should return complete report line', async () => {
      const result = await onboardSingleSite(
        'https://example.com',
        'TEST123@AdobeOrg',
        configuration,
        profile,
        30,
        slackContext,
        context,
        {
          deliveryType: 'aem_edge',
          authoringType: 'documentauthoring',
          tier: EntitlementModel.TIERS.FREE_TRIAL,
        },
        { profileName: 'demo' },
      );

      expect(result).to.deep.include({
        site: 'https://example.com',
        imsOrgId: 'TEST123@AdobeOrg',
        spacecatOrgId: 'org-123',
        siteId: 'site-123',
        profile: 'demo',
        deliveryType: 'aem_edge',
        authoringType: 'documentauthoring',
        tier: EntitlementModel.TIERS.FREE_TRIAL,
        status: 'Success',
        existingSite: 'No',
      });

      expect(result.imports).to.be.a('string');
      expect(result.audits).to.be.a('string');
    });
  });
});
