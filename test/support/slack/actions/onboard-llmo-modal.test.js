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
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import nock from 'nock';

use(chaiAsPromised);
use(sinonChai);

describe('onboard-llmo-modal', () => {
  let sandbox;
  let onboardSite;
  let mockedModule;

  // Default mocks that can be reused across tests
  const createDefaultMockSite = (sinonSandbox) => ({
    getId: sinonSandbox.stub().returns('site123'),
    getOrganizationId: sinonSandbox.stub().returns('org123'),
    setOrganizationId: sinonSandbox.stub(),
    getConfig: sinonSandbox.stub().returns({
      updateLlmoBrand: sinonSandbox.stub(),
      updateLlmoDataFolder: sinonSandbox.stub(),
      enableImport: sinonSandbox.stub(),
    }),
    setConfig: sinonSandbox.stub(),
    save: sinonSandbox.stub().resolves(),
  });

  const createDefaultMockConfiguration = (sinonSandbox) => ({
    findLatest: sinonSandbox.stub().resolves({
      save: sinonSandbox.stub().resolves(),
      enableHandlerForSite: sinonSandbox.stub(),
      isHandlerEnabledForSite: sinonSandbox.stub().returns(false),
      getQueues: sinonSandbox.stub().returns({ audits: 'audit-queue' }),
    }),
  });

  const createDefaultMockOrganization = (sinonSandbox) => ({
    findByImsOrgId: sinonSandbox.stub().resolves({
      getId: sinonSandbox.stub().returns('org123'),
    }),
  });

  const createDefaultMockEntitlement = (sinonSandbox) => ({
    create: sinonSandbox.stub().returns({
      save: sinonSandbox.stub().resolves(),
      getId: sinonSandbox.stub().returns('entitlement123'),
    }),
    findById: sinonSandbox.stub().resolves({
      getProductCode: sinonSandbox.stub().returns('OTHER'),
    }),
  });

  const createDefaultMockSiteEnrollment = (sinonSandbox) => ({
    allBySiteId: sinonSandbox.stub().resolves([]),
    create: sinonSandbox.stub().returns({
      save: sinonSandbox.stub().resolves(),
    }),
  });

  const createDefaultMockSiteModel = (sinonSandbox, mockSite) => ({
    findByBaseURL: sinonSandbox.stub().resolves(null), // New site by default
    findById: sinonSandbox.stub().resolves(mockSite),
    create: sinonSandbox.stub().returns({
      save: sinonSandbox.stub().resolves(),
      getId: sinonSandbox.stub().returns('site123'),
    }),
    allByOrganizationId: sinonSandbox.stub().resolves([]),
  });

  const createDefaultMockImsClient = (sinonSandbox) => ({
    getImsOrganizationDetails: sinonSandbox.stub().resolves({
      orgName: 'Test Organization',
    }),
  });

  const createDefaultMockSqs = (sinonSandbox) => ({
    sendMessage: sinonSandbox.stub(),
  });

  const createDefaultMockLambdaCtx = (sinonSandbox, overrides = {}) => {
    const mockSite = overrides.mockSite || createDefaultMockSite(sinonSandbox);
    const mockConfiguration = overrides.mockConfiguration
      || createDefaultMockConfiguration(sinonSandbox);
    const mockOrganization = overrides.mockOrganization
      || createDefaultMockOrganization(sinonSandbox);
    const mockEntitlement = overrides.mockEntitlement
      || createDefaultMockEntitlement(sinonSandbox);
    const mockSiteEnrollment = overrides.mockSiteEnrollment
      || createDefaultMockSiteEnrollment(sinonSandbox);
    const mockSiteModel = overrides.mockSiteModel
      || createDefaultMockSiteModel(sinonSandbox, mockSite);
    const mockImsClient = overrides.mockImsClient
      || createDefaultMockImsClient(sinonSandbox);
    const mockSqs = overrides.mockSqs || createDefaultMockSqs(sinonSandbox);

    return {
      log: {
        info: sinonSandbox.stub(),
        warn: sinonSandbox.stub(),
        error: sinonSandbox.stub(),
      },
      dataAccess: {
        Site: mockSiteModel,
        Configuration: mockConfiguration,
        Organization: mockOrganization,
        Entitlement: mockEntitlement,
        SiteEnrollment: mockSiteEnrollment,
      },
      imsClient: mockImsClient,
      sqs: mockSqs,
      ...overrides,
    };
  };

  const createDefaultMockSlackCtx = (sinonSandbox) => ({
    say: sinonSandbox.stub(),
  });

  const createDefaultMockFetch = (sinonSandbox) => sinonSandbox.stub().resolves({
    ok: true,
    status: 200,
    statusText: 'OK',
  });

  before(async () => {
    // Mock the ES modules that can't be stubbed directly
    mockedModule = await esmock('../../../../src/support/slack/actions/onboard-llmo-modal.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: {
          toDynamoItem: sinon.stub().returns({}),
        },
      },
      '@adobe/spacecat-helix-content-sdk': {
        createFrom: sinon.stub().resolves({
          getDocument: sinon.stub().returns({
            exists: sinon.stub().resolves(false),
            createFolder: sinon.stub().resolves(),
            copy: sinon.stub().resolves(),
          }),
        }),
      },
      '@octokit/rest': {
        Octokit: sinon.stub().returns({
          repos: {
            getContent: sinon.stub().resolves({
              data: { content: Buffer.from('test content').toString('base64') },
            }),
            createOrUpdateFileContents: sinon.stub().resolves(),
          },
        }),
      },
      '../../../../src/utils/slack/base.js': {
        postErrorMessage: sinon.stub(),
      },
    });

    onboardSite = mockedModule.onboardSite;
  });

  beforeEach(() => {
    // Block all network requests during tests
    nock.disableNetConnect();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    // Clean up after each test
    nock.cleanAll();
    nock.enableNetConnect();
    sandbox.restore();
  });

  describe('onboardSite', () => {
    it('should successfully onboard a new site with all expected messages and function calls', async function testNewSiteOnboarding() {
      this.timeout(10000); // Increase timeout to 10 seconds
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSite });
      const slackCtx = createDefaultMockSlackCtx(sandbox);
      const sayStub = slackCtx.say;

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify the expected say() messages
      expect(sayStub).to.have.been.calledWith(':gear: Test Brand onboarding started...');
      expect(sayStub).to.have.been.calledWith(sinon.match(':white_check_mark: *LLMO onboarding completed successfully!*'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':link: *Site:* https://example.com'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':identification_card: *Site ID:* site123'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':file_folder: *Data Folder:* example-com'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':label: *Brand:* Test Brand'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':identification_card: *IMS Org ID:* ABC123@AdobeOrg'));

      // Verify key function calls
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.dataAccess.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        deliveryType: 'aem_edge',
        organizationId: 'org123',
      });
      expect(mockSite.save).to.have.been.called;
      expect(lambdaCtx.dataAccess.Configuration.findLatest).to.have.been.calledTwice;
      expect(lambdaCtx.sqs.sendMessage).to.have.been.calledWith('audit-queue', {
        type: 'llmo-customer-analysis',
        siteId: 'site123',
        auditContext: {
          auditType: 'llmo-customer-analysis',
        },
      });

      // Verify site config updates
      const siteConfig = mockSite.getConfig();
      expect(siteConfig.updateLlmoBrand).to.have.been.calledWith('Test Brand');
      expect(siteConfig.updateLlmoDataFolder).to.have.been.calledWith('example-com');
      expect(siteConfig.enableImport).to.have.been.calledWith('traffic-analysis');
      expect(siteConfig.enableImport).to.have.been.calledWith('llmo-prompts-ahrefs', { limit: 25 });

      // Verify handler enabling
      const config = await lambdaCtx.dataAccess.Configuration.findLatest();
      expect(config.enableHandlerForSite).to.have.been.calledWith('llmo-referral-traffic', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('geo-brand-presence', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('cdn-analysis', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('cdn-logs-report', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);
    });

    it('should handle existing site with matching organization ID', async function testExistingSiteMatchingOrg() {
      this.timeout(10000);
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.getOrganizationId.returns('org123'); // Same org ID as the provided one

      // Create mocks with the existing site
      const mockSiteModel = createDefaultMockSiteModel(sandbox, existingSite);
      mockSiteModel.findByBaseURL.resolves(existingSite); // Return existing site instead of null

      const mockOrganization = createDefaultMockOrganization(sandbox);
      // The organization lookup should return the same org ID
      mockOrganization.findByImsOrgId.resolves({
        getId: sandbox.stub().returns('org123'), // Same as existing site's org ID
      });

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite: existingSite,
        mockSiteModel,
        mockOrganization,
      });

      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that it found the existing site
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');

      // Verify that checkOrg was called (organization lookup)
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify that setOrganizationId was NOT called since orgs match
      expect(existingSite.setOrganizationId).to.not.have.been.called;

      // Verify that the site was not created (since we found an existing one)
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;
    });

    it('should handle existing site with different organization ID and update it', async function testExistingSiteDifferentOrg() {
      this.timeout(10000);
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists with a different org ID
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.getOrganizationId.returns('old-org-123'); // Different from provided org ID
      existingSite.setOrganizationId = sandbox.stub(); // Add setOrganizationId stub

      // Create mocks with the existing site
      const mockSiteModel = createDefaultMockSiteModel(sandbox, existingSite);
      mockSiteModel.findByBaseURL.resolves(existingSite); // Return existing site instead of null

      const mockOrganization = createDefaultMockOrganization(sandbox);
      // The organization lookup should return a different org ID
      mockOrganization.findByImsOrgId.resolves({
        getId: sandbox.stub().returns('new-org-456'), // Different from existing site's org ID
      });

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite: existingSite,
        mockSiteModel,
        mockOrganization,
      });

      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that it found the existing site
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');

      // Verify that checkOrg was called (organization lookup)
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify that setOrganizationId WAS called to update the site's org
      expect(existingSite.setOrganizationId).to.have.been.calledWith('new-org-456');

      // Verify that the site was saved after updating the organization
      expect(existingSite.save).to.have.been.called;

      // Verify that the site was not created (since we found an existing one)
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;
    });

    it('should handle existing site with non-existent organization and create new org', async function testExistingSiteCreateNewOrg() {
      this.timeout(10000);
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists with a different org ID
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.getOrganizationId.returns('old-org-123'); // Different from provided org ID
      existingSite.setOrganizationId = sandbox.stub(); // Add setOrganizationId stub

      // Create mocks with the existing site
      const mockSiteModel = createDefaultMockSiteModel(sandbox, existingSite);
      mockSiteModel.findByBaseURL.resolves(existingSite); // Return existing site instead of null

      const mockOrganization = createDefaultMockOrganization(sandbox);
      // The organization lookup should return null (org doesn't exist)
      mockOrganization.findByImsOrgId.resolves(null);
      // Mock the create method for new organization
      const newOrg = {
        getId: sandbox.stub().returns('new-org-789'),
        save: sandbox.stub().resolves(),
      };
      mockOrganization.create = sandbox.stub().returns(newOrg);

      // Mock IMS client to return org details
      const mockImsClient = createDefaultMockImsClient(sandbox);
      mockImsClient.getImsOrganizationDetails.resolves({
        orgName: 'New Test Organization',
      });

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite: existingSite,
        mockSiteModel,
        mockOrganization,
        mockImsClient,
      });

      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that it found the existing site
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');

      // Verify that checkOrg was called (organization lookup)
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify that IMS client was called to get org details
      expect(lambdaCtx.imsClient.getImsOrganizationDetails).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify that a new organization was created
      expect(lambdaCtx.dataAccess.Organization.create).to.have.been.calledWith({
        name: 'New Test Organization',
        imsOrgId: 'ABC123@AdobeOrg',
      });

      // Verify that the new organization was saved
      expect(newOrg.save).to.have.been.called;

      // Verify that setOrganizationId was called with the new org ID
      expect(existingSite.setOrganizationId).to.have.been.calledWith('new-org-789');

      // Verify that the site was saved after updating the organization
      expect(existingSite.save).to.have.been.called;

      // Verify that the site was not created (since we found an existing one)
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;
    });
  });
});
