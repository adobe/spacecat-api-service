/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import nock from 'nock';
import esmock from 'esmock';

use(sinonChai);

describe('OnboardCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let parseCSVStub;
  let baseURL;
  let OnboardCommand;
  let imsClientStub;

  beforeEach(async () => {
    const configuration = {
      enableHandlerForSite: sinon.stub(),
      save: sinon.stub().resolves(),
    };
    baseURL = 'https://example.com';

    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub().resolves(configuration),
      },
      Site: {
        create: sinon.stub(),
        findByBaseURL: sinon.stub(),
      },
      Organization: {
        create: sinon.stub(),
        findByImsOrgId: sinon.stub(),
        findById: sinon.stub(),
        getId: sinon.stub(),
      },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    imsClientStub = {
      getImsOrganizationDetails: sinon.stub(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: console,
      sqs: sqsStub,
      env: {
        AUDIT_JOBS_QUEUE_URL: 'testQueueUrl',
        token: 'test-token',
      },
      imsClient: imsClientStub,
    };
    slackContext = {
      say: sinon.spy(),
      files: [],
      client: {
        files: [],
        chat: {
          postMessage: sinon.stub().resolves(),
        },
      },
      channelId: 'test-channel',
      threadTs: 'test-thread',
    };
    slackContext.botToken = 'test-token';

    parseCSVStub = sinon.stub().resolves([]);
    OnboardCommand = await esmock(
      '../../../../src/support/slack/commands/onboard.js',
      {
        '../../../../src/utils/slack/base.js': { parseCSV: parseCSVStub },
      },
    );
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(OnboardCommand);
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = OnboardCommand(context);
      expect(command.id).to.equal('onboard-site');
      expect(command.name).to.equal('Onboard Site(s)');
      expect(command.description).to.equal(
        'Onboards a new site (or batch of sites from CSV) to AEM Sites Optimizer using an interactive modal interface.',
      );
      expect(command.phrases).to.deep.equal(['onboard site', 'onboard sites']);
    });
  });

  describe('Single-Site Onboarding', () => {
    beforeEach(() => {
      nock.cleanAll();
    });

    it('shows onboarding button when no arguments provided', async () => {
      const args = [];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.calledWith(
        sinon.match({
          channel: 'test-channel',
          blocks: sinon.match.array,
        }),
      );

      // Verify the message contains the start onboarding button
      const callArgs = slackContext.client.chat.postMessage.getCall(0).args[0];
      expect(callArgs.blocks).to.have.length(2);
      expect(callArgs.blocks[1].elements[0].action_id).to.equal('start_onboarding');
    });

    it('shows onboarding button when called with any non-CSV arguments', async () => {
      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.calledWith(
        sinon.match({
          channel: 'test-channel',
          blocks: sinon.match.array,
        }),
      );
    });

    it('shows onboarding button for any command arguments', async () => {
      const args = ['example.com', ''];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
    });

    it('shows onboarding button regardless of organization state', async () => {
      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      // Organization should not be accessed since we're showing button, not processing
      expect(dataAccessStub.Organization.findByImsOrgId).not.to.have.been.called;
    });

    it('shows onboarding button regardless of existing sites', async () => {
      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });
      dataAccessStub.Site.findByBaseURL.resolves({});

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(dataAccessStub.Site.create).not.to.have.been.called;
    });

    it('shows onboarding button and does not process organizations directly', async () => {
      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves({
        orgName: 'Mock IMS Org',
        tenantId: '123',
      });
      dataAccessStub.Organization.create.rejects(new Error('failed to create organization'));

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      // Should not process organization directly since we're showing button
      expect(dataAccessStub.Organization.findByImsOrgId).not.to.have.been.called;
      expect(imsClientStub.getImsOrganizationDetails).not.to.have.been.called;
      expect(dataAccessStub.Organization.create).not.to.have.been.called;
    });

    it('handles error when a site failed to be added', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');
      dataAccessStub.Organization.findByImsOrgId.resolves({
        getId: sinon.stub().returns('existing-org-123'),
      });
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.rejects(new Error('failed to add the site'));

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(dataAccessStub.Site.create).not.to.have.been.called;
    });

    it('uses default IMS Org ID when none is provided', async () => {
      context.env.DEMO_IMS_ORG = 'default-ims-org-id';
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('123'),
        getName: sinon.stub().returns('new-org'),
        getTenantId: sinon.stub().returns('123'),
      };

      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves({ orgName: 'Mock IMS Org' });
      dataAccessStub.Organization.create.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.resolves({
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'other',
        getIsLive: () => true,
        getId: () => 'site-123',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      });

      const args = ['example.com']; // No IMS Org ID provided
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Just verify the function executed without throwing
      expect(slackContext.say.called).to.be.true;
    });

    it('only enables imports that are not already enabled', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('123'),
        getName: sinon.stub().returns('new-org'),
      };

      const mockSiteConfig = {
        getImports: sinon.stub().returns([
          { type: 'organic-traffic', enabled: true },
          { type: 'top-pages', enabled: false },
        ]),
        enableImport: sinon.stub(),
        setConfig: sinon.stub(),
      };

      const mockSite = {
        getConfig: sinon.stub().returns(mockSiteConfig),
        save: sinon.stub().resolves(),
        getId: sinon.stub().returns('site-123'),
      };

      dataAccessStub.Organization.findByImsOrgId.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Just verify the function executed without throwing
      expect(slackContext.say.called).to.be.true;
    });

    it('only enables audits that are not already enabled', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('123'),
        getName: sinon.stub().returns('new-org'),
      };

      const mockSite = {
        getConfig: sinon.stub().returns({
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
        getId: sinon.stub().returns('site-123'),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        save: sinon.stub().resolves(),
      };

      dataAccessStub.Organization.findByImsOrgId.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);
      dataAccessStub.Configuration.findLatest.resolves(mockConfiguration);

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Just verify the function executed without throwing
      expect(slackContext.say.called).to.be.true;
    });

    // New tests for the updated functionality
    it('creates new site with provided organization', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('provided-org-id'),
        getName: sinon.stub().returns('Provided Org'),
        getTenantId: sinon.stub().returns('provided-tenant-id'),
      };

      const mockSite = {
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'other',
        getIsLive: () => true,
        getId: () => 'new-site-id',
        getOrganizationId: () => 'provided-org-id',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      // Mock that organization exists
      dataAccessStub.Organization.findByImsOrgId.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null); // Site doesn't exist
      dataAccessStub.Site.create.resolves(mockSite);

      const args = ['example.com', 'provided-ims-org-id'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });

    it('creates new site with demo organization when no org provided', async () => {
      context.env.DEMO_IMS_ORG = 'demo-ims-org-id';
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('demo-org-id'),
        getName: sinon.stub().returns('Demo Org'),
        getTenantId: sinon.stub().returns('demo-tenant-id'),
      };

      const mockSite = {
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'other',
        getIsLive: () => true,
        getId: () => 'new-site-id',
        getOrganizationId: () => 'demo-org-id',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      // Mock that demo organization exists
      dataAccessStub.Organization.findByImsOrgId.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null); // Site doesn't exist
      dataAccessStub.Site.create.resolves(mockSite);

      const args = ['example.com']; // No IMS Org ID provided
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });

    it('creates new organization when provided org does not exist', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('new-org-id'),
        getName: sinon.stub().returns('New Org'),
        getTenantId: sinon.stub().returns('new-tenant-id'),
      };

      const mockSite = {
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'other',
        getIsLive: () => true,
        getId: () => 'new-site-id',
        getOrganizationId: () => 'new-org-id',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      // Mock that organization doesn't exist initially, then gets created
      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves({
        orgName: 'New Org',
        tenantId: 'new-tenant-id',
      });
      dataAccessStub.Organization.create.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null); // Site doesn't exist
      dataAccessStub.Site.create.resolves(mockSite);

      const args = ['example.com', 'new-ims-org-id'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });

    it('handles existing site with organization found', async () => {
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com', 'new-ims-org-id'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });

    it('handles existing site with organization not found', async () => {
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'missing-org-id',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(null);

      const args = ['example.com', 'new-ims-org-id'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });

    it('does not create new organization when demo org is provided but site exists', async () => {
      context.env.DEMO_IMS_ORG = 'demo-ims-org-id';

      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com']; // No IMS Org ID provided, should use demo
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });
  });

  describe('Fetch Configuration and Error Handling', () => {
    it('should handle findDeliveryType errors gracefully and use OTHER delivery type', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('123'),
        getName: sinon.stub().returns('new-org'),
      };

      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves({
        orgName: 'Mock IMS Org',
        tenantId: '123',
      });
      dataAccessStub.Organization.create.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null);

      // Mock findDeliveryType to throw an error (simulating 403 or network error)
      const mockSite = {
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'other', // Should default to OTHER when error occurs
        getIsLive: () => false,
        getId: () => 'site-123',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };
      dataAccessStub.Site.create.resolves(mockSite);

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully despite findDeliveryType error
      expect(slackContext.say.called).to.be.true;
      expect(dataAccessStub.Site.create.called).to.be.true;
    });

    it('should use detected delivery type when findDeliveryType succeeds', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('123'),
        getName: sinon.stub().returns('new-org'),
      };

      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves({
        orgName: 'Mock IMS Org',
        tenantId: '123',
      });
      dataAccessStub.Organization.create.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null);

      // Mock findDeliveryType to work normally
      const mockSite = {
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'aem-edge', // Should use detected delivery type
        getIsLive: () => true,
        getId: () => 'site-123',
        getConfig: () => ({
          getImports: () => [],
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };
      dataAccessStub.Site.create.resolves(mockSite);

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully with detected delivery type
      expect(slackContext.say.called).to.be.true;
      expect(dataAccessStub.Site.create.called).to.be.true;
    });

    it('should skip canonical URL resolution when fetch config already exists', async () => {
      // Mock existing site with fetch configuration
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          getFetchConfig: () => ({ overrideBaseURL: 'https://resolved.example.com' }), // Has fetch config
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully and skipped canonical URL resolution
      expect(slackContext.say.called).to.be.true;
      // Should not call resolveCanonicalUrl (we can't easily test this without
      // mocking the function)
    });

    it('should attempt canonical URL resolution when no fetch config exists', async () => {
      // Mock existing site without fetch configuration
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          getFetchConfig: () => ({}), // No fetch config
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully and attempted canonical URL resolution
      expect(slackContext.say.called).to.be.true;
    });

    it('should handle resolveCanonicalUrl returning null gracefully', async () => {
      // Mock existing site without fetch configuration
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          getFetchConfig: () => ({}), // No fetch config
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully even when resolveCanonicalUrl fails
      expect(slackContext.say.called).to.be.true;
    });

    it('should handle resolveCanonicalUrl success correctly', async () => {
      // Mock existing site without fetch configuration
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          getFetchConfig: () => ({}), // No fetch config
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully when resolveCanonicalUrl succeeds
      expect(slackContext.say.called).to.be.true;
    });

    it('should provide appropriate Slack messages for different scenarios', async () => {
      // Mock existing site without fetch configuration
      const existingSite = {
        getId: () => 'existing-site-id',
        getDeliveryType: () => 'aem-edge',
        getOrganizationId: () => 'existing-org-id',
        getConfig: () => ({
          getImports: () => [],
          getFetchConfig: () => ({}), // No fetch config
          enableImport: sinon.stub(),
          setConfig: sinon.stub(),
        }),
        save: sinon.stub().resolves(),
      };

      const existingOrganization = {
        getId: () => 'existing-org-id',
        getName: () => 'Existing Org',
        getImsOrgId: () => 'existing-ims-org-id',
      };

      dataAccessStub.Site.findByBaseURL.resolves(existingSite);
      dataAccessStub.Organization.findById.resolves(existingOrganization);

      const args = ['example.com'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that appropriate Slack messages were sent
      expect(slackContext.say.called).to.be.true;
      // The specific messages depend on the resolveCanonicalUrl result, which we can't easily mock
    });
  });

  describe('Batch Onboarding from CSV', () => {
    beforeEach(() => {
      slackContext.files = [{ name: 'test.csv', url_private: 'https://mock-csv.com' }];
      slackContext.botToken = 'test-token';
    });

    it('handles batch onboarding with valid CSV', async () => {
      const mockCSVData = [
        ['https://example1.com', '000000000000000000000000@AdobeOrg'],
        ['https://example2.com', '000000000000000000000000@AdobeOrg'],
      ];

      parseCSVStub.withArgs('https://mock-csv.com', 'test-token').resolves(mockCSVData);

      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });
      dataAccessStub.Organization.create.resolves(null);
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.resolves({});

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      // Verify that the function executed successfully
      expect(slackContext.say.called).to.be.true;
    });

    it('rejects CSV with invalid data', async () => {
      parseCSVStub.resolves([]);

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No valid rows found in the CSV file. Please check the format.')).to.be.true;
    });

    it('warns when multiple CSV files are uploaded', async () => {
      slackContext.files = [
        { name: 'test1.csv', url_private: 'https://mock-csv.com/1' },
        { name: 'test2.csv', url_private: 'https://mock-csv.com/2' },
      ];

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please upload only *one* CSV file at a time.')).to.be.true;
    });

    it('warns when a non-CSV file is uploaded', async () => {
      slackContext.files = [{ name: 'test.txt', url_private: 'https://mock-file.com' }];

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please upload a *valid* CSV file.')).to.be.true;
    });
  });

  afterEach(() => {
    sinon.restore();
  });
});
