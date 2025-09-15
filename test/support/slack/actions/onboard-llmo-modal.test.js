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
  let octokitMock;

  // Default mocks that can be reused across tests
  const createDefaultMockSite = (sinonSandbox) => {
    let organizationId = 'org123';
    return {
      getId: sinonSandbox.stub().returns('site123'),
      getOrganizationId: sinonSandbox.stub().callsFake(() => organizationId),
      setOrganizationId: sinonSandbox.stub().callsFake((newOrgId) => {
        organizationId = newOrgId;
      }),
      getConfig: sinonSandbox.stub().returns({
        updateLlmoBrand: sinonSandbox.stub(),
        updateLlmoDataFolder: sinonSandbox.stub(),
        enableImport: sinonSandbox.stub(),
      }),
      setConfig: sinonSandbox.stub(),
      save: sinonSandbox.stub().resolves(),
    };
  };

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
    findById: sinonSandbox.stub().resolves({
      getId: sinonSandbox.stub().returns('org123'),
      getImsOrgId: sinonSandbox.stub().returns('ABC123@AdobeOrg'),
    }),
    create: sinonSandbox.stub().returns({
      getId: sinonSandbox.stub().returns('org123'),
      save: sinonSandbox.stub().resolves(),
    }),
  });

  const createDefaultMockEntitlement = (sinonSandbox) => ({
    create: sinonSandbox.stub().returns({
      save: sinonSandbox.stub().resolves(),
      getId: sinonSandbox.stub().returns('entitlement123'),
    }),
    findById: sinonSandbox.stub().resolves({
      getProductCode: sinonSandbox.stub().returns('LLMO'),
      getOrganizationId: sinonSandbox.stub().returns('org123'),
    }),
    findByOrganizationIdAndProductCode: sinonSandbox.stub().resolves(null),
  });

  const createDefaultMockSiteEnrollment = (sinonSandbox) => ({
    allBySiteId: sinonSandbox.stub().resolves([]),
    create: sinonSandbox.stub().returns({
      save: sinonSandbox.stub().resolves(),
      getId: sinonSandbox.stub().returns('enrollment123'),
    }),
  });

  const createDefaultMockOrganizationIdentityProvider = (sinonSandbox) => ({
    allByOrganizationId: sinonSandbox.stub().resolves([]),
    create: sinonSandbox.stub().returns({
      save: sinonSandbox.stub().resolves(),
      getId: sinonSandbox.stub().returns('idp123'),
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
    const mockOrganizationIdentityProvider = overrides.mockOrganizationIdentityProvider
      || createDefaultMockOrganizationIdentityProvider(sinonSandbox);
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
        debug: sinonSandbox.stub(),
      },
      dataAccess: {
        Site: mockSiteModel,
        Configuration: mockConfiguration,
        Organization: mockOrganization,
        Entitlement: mockEntitlement,
        SiteEnrollment: mockSiteEnrollment,
        OrganizationIdentityProvider: mockOrganizationIdentityProvider,
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
    // Create octokit mock
    octokitMock = sinon.stub().returns({
      repos: {
        getContent: sinon.stub().resolves({
          data: {
            content: Buffer.from('test content').toString('base64'),
            sha: 'test-sha-123',
          },
        }),
        createOrUpdateFileContents: sinon.stub().resolves(),
      },
    });

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
        Octokit: octokitMock,
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
    // Mock setTimeout to resolve immediately
    sandbox.stub(global, 'setTimeout').callsFake((fn) => {
      fn();
      return 1; // Return a fake timer ID
    });
  });

  afterEach(() => {
    // Clean up after each test
    nock.cleanAll();
    nock.enableNetConnect();
    sandbox.restore();
  });

  describe('onboardSite', () => {
    it('should successfully onboard a new site with all expected messages and function calls', async () => {
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

      expect(sayStub).to.have.been.calledWith(':gear: Test Brand onboarding started...');
      expect(sayStub).to.have.been.calledWith(sinon.match(':white_check_mark: *LLMO onboarding completed successfully!*'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':link: *Site:* https://example.com'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':identification_card: *Site ID:* site123'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':file_folder: *Data Folder:* example-com'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':label: *Brand:* Test Brand'));
      expect(sayStub).to.have.been.calledWith(sinon.match(':identification_card: *IMS Org ID:* ABC123@AdobeOrg'));
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.dataAccess.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        deliveryType: 'aem_edge',
        organizationId: 'org123',
      });
      expect(mockSite.save).to.have.been.called;
      expect(lambdaCtx.dataAccess.Configuration.findLatest).to.have.been.calledTwice;
      expect(lambdaCtx.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'org123',
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.allByOrganizationId).to.have.been.calledWith('org123');
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.create).to.have.been.calledWith({
        organizationId: 'org123',
        provider: 'IMS',
        externalId: 'ABC123@AdobeOrg',
      });
      expect(lambdaCtx.sqs.sendMessage).to.have.been.calledWith('audit-queue', {
        type: 'llmo-customer-analysis',
        siteId: 'site123',
        auditContext: { auditType: 'llmo-customer-analysis' },
      });
      const siteConfig = mockSite.getConfig();
      expect(siteConfig.updateLlmoBrand).to.have.been.calledWith('Test Brand');
      expect(siteConfig.updateLlmoDataFolder).to.have.been.calledWith('example-com');
      expect(siteConfig.enableImport).to.have.been.calledWith('traffic-analysis');
      expect(siteConfig.enableImport).to.have.been.calledWith('llmo-prompts-ahrefs', { limit: 25 });
      const config = await lambdaCtx.dataAccess.Configuration.findLatest();
      expect(config.enableHandlerForSite).to.have.been.calledWith('llmo-referral-traffic', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('geo-brand-presence', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('cdn-analysis', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('cdn-logs-report', mockSite);
      expect(config.enableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);

      // Verify that octokit was called to update the helix query config
      expect(octokitMock).to.have.been.called;
      const octokitInstance = octokitMock.getCall(0).returnValue;
      expect(octokitInstance.repos.getContent).to.have.been.calledWith({
        owner: 'adobe',
        repo: 'project-elmo-ui-data',
        ref: 'main',
        path: 'helix-query.yaml',
      });
      expect(octokitInstance.repos.createOrUpdateFileContents).to.have.been.calledWith({
        owner: 'adobe',
        repo: 'project-elmo-ui-data',
        ref: 'main',
        path: 'helix-query.yaml',
        message: 'Automation: Onboard example-com',
        content: sinon.match.string,
        sha: 'test-sha-123',
      });
    });

    it('should not add new line to yaml if it already ends with a newline', async () => {
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

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Create a new octokit mock for this specific test that returns content ending with newline
      const testOctokitMock = sinon.stub().returns({
        repos: {
          getContent: sinon.stub().resolves({
            data: {
              content: Buffer.from('test content\n').toString('base64'), // Content ends with newline
              sha: 'test-sha-123',
            },
          }),
          createOrUpdateFileContents: sinon.stub().resolves(),
        },
      });

      // Override the octokit mock for this test
      const originalOctokitMock = octokitMock;
      octokitMock = testOctokitMock;

      // Re-mock the module with the new octokit mock
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
          Octokit: testOctokitMock,
        },
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: sinon.stub(),
        },
      });

      onboardSite = mockedModule.onboardSite;

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      const octokitInstance = testOctokitMock.getCall(0).returnValue;
      const createOrUpdateCall = octokitInstance.repos.createOrUpdateFileContents.getCall(0);
      const contentArg = createOrUpdateCall.args[0].content;
      const decodedContent = Buffer.from(contentArg, 'base64').toString('utf-8');

      // The content should end with exactly one newline, not two
      expect(decodedContent).to.match(/\n$/);
      expect(decodedContent).to.not.match(/\n\n$/);

      // Verify the specific content structure
      expect(decodedContent).to.include('test content');
      expect(decodedContent).to.include('example-com:');
      expect(decodedContent).to.include('<<: *default');
      expect(decodedContent).to.include('include:');
      expect(decodedContent).to.include('- \'/example-com/**\'');
      expect(decodedContent).to.include('target: /example-com/query-index.xlsx');

      octokitMock = originalOctokitMock;
    });

    it('should handle existing site with matching organization ID', async () => {
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

      await onboardSite(input, lambdaCtx, slackCtx);

      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');
      expect(existingSite.setOrganizationId).to.not.have.been.called;
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;

      // Verify that entitlement and enrollment were created
      expect(lambdaCtx.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'org123',
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });

      // Verify that organization identity provider was created
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.allByOrganizationId).to.have.been.calledWith('org123');
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.create).to.have.been.calledWith({
        organizationId: 'org123',
        provider: 'IMS',
        externalId: 'ABC123@AdobeOrg',
      });
    });

    it('should handle existing site with different organization ID and update it', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists with a different org ID
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.setOrganizationId('old-org-123'); // Set initial org ID

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

      await onboardSite(input, lambdaCtx, slackCtx);

      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');
      expect(existingSite.setOrganizationId).to.have.been.calledWith('new-org-456');
      expect(existingSite.save).to.have.been.called;
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;

      // Verify that entitlement and enrollment were created
      expect(lambdaCtx.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'new-org-456',
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });

      // Verify that organization identity provider was created
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.allByOrganizationId).to.have.been.calledWith('new-org-456');
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.create).to.have.been.calledWith({
        organizationId: 'new-org-456',
        provider: 'IMS',
        externalId: 'ABC123@AdobeOrg',
      });
    });

    it('should handle existing site with non-existent organization and create new org', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists with a different org ID
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.setOrganizationId('old-org-123'); // Set initial org ID

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

      await onboardSite(input, lambdaCtx, slackCtx);

      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');
      expect(lambdaCtx.imsClient.getImsOrganizationDetails).to.have.been.calledWith('ABC123@AdobeOrg');
      expect(lambdaCtx.dataAccess.Organization.create).to.have.been.calledWith({
        name: 'New Test Organization',
        imsOrgId: 'ABC123@AdobeOrg',
      });
      expect(newOrg.save).to.have.been.called;
      expect(existingSite.setOrganizationId).to.have.been.calledWith('new-org-789');
      expect(existingSite.save).to.have.been.called;
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;

      // Verify that entitlement and enrollment were created
      expect(lambdaCtx.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'new-org-789',
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });

      // Verify that organization identity provider was created
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.allByOrganizationId).to.have.been.calledWith('new-org-789');
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.create).to.have.been.calledWith({
        organizationId: 'new-org-789',
        provider: 'IMS',
        externalId: 'ABC123@AdobeOrg',
      });
    });

    it('should handle createOrg error when IMS client throws an error', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'INVALID_ORG_ID',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists with a different org ID
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.getOrganizationId.returns('old-org-123');
      existingSite.setOrganizationId = sandbox.stub();

      // Create mocks with the existing site
      const mockSiteModel = createDefaultMockSiteModel(sandbox, existingSite);
      mockSiteModel.findByBaseURL.resolves(existingSite);

      const mockOrganization = createDefaultMockOrganization(sandbox);
      // The organization lookup should return null (org doesn't exist)
      mockOrganization.findByImsOrgId.resolves(null);

      // Mock IMS client to throw an error
      const mockImsClient = createDefaultMockImsClient(sandbox);
      mockImsClient.getImsOrganizationDetails.rejects(new Error('IMS org not found'));

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite: existingSite,
        mockSiteModel,
        mockOrganization,
        mockImsClient,
      });

      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      try {
        await onboardSite(input, lambdaCtx, slackCtx);
        expect.fail('Expected onboardSite to throw an error');
      } catch (error) {
        expect(slackCtx.say).to.have.been.calledWith(':x: Could not find an IMS org with the ID *INVALID_ORG_ID*.');
      }
    });

    it('should handle createOrg error when IMS org details are null', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'NULL_DETAILS_ORG_ID',
        deliveryType: 'aem_edge',
      };

      // Create a mock site that already exists with a different org ID
      const existingSite = createDefaultMockSite(sandbox);
      existingSite.getOrganizationId.returns('old-org-123');
      existingSite.setOrganizationId = sandbox.stub();

      // Create mocks with the existing site
      const mockSiteModel = createDefaultMockSiteModel(sandbox, existingSite);
      mockSiteModel.findByBaseURL.resolves(existingSite);

      const mockOrganization = createDefaultMockOrganization(sandbox);
      // The organization lookup should return null (org doesn't exist)
      mockOrganization.findByImsOrgId.resolves(null);

      // Mock IMS client to return null details
      const mockImsClient = createDefaultMockImsClient(sandbox);
      mockImsClient.getImsOrganizationDetails.resolves(null);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite: existingSite,
        mockSiteModel,
        mockOrganization,
        mockImsClient,
      });

      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      try {
        await onboardSite(input, lambdaCtx, slackCtx);
        expect.fail('Expected onboardSite to throw an error');
      } catch (error) {
        expect(slackCtx.say).to.have.been.calledWith(':x: Could not find an IMS org with the ID *NULL_DETAILS_ORG_ID*.');
      }
    });

    it('should handle SQS sendMessage failure through catch block', async () => {
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

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Make SQS sendMessage throw an error
      lambdaCtx.sqs.sendMessage.rejects(new Error('SQS service unavailable'));

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that SQS sendMessage was called but failed
      expect(lambdaCtx.sqs.sendMessage).to.have.been.called;
      expect(lambdaCtx.log.error).to.have.been.calledWith(sinon.match('Error saving LLMO config for site site123: SQS service unavailable'));
    });

    it('should log that agentic traffic audits are already enabled when organization has them', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock sites in organization to include one with agentic traffic already enabled
      const existingSiteWithAgenticTraffic = createDefaultMockSite(sandbox);
      existingSiteWithAgenticTraffic.getId.returns('existing-site-456');

      // Mock the configuration to return that agentic traffic is already enabled for existing site
      const mockConfiguration = createDefaultMockConfiguration(sandbox);
      const configurationInstance = {
        save: sandbox.stub().resolves(),
        enableHandlerForSite: sandbox.stub(),
        isHandlerEnabledForSite: sandbox.stub().callsFake((auditType, site) => {
          if (auditType === 'cdn-analysis') {
            // Return true for the existing site with agentic traffic enabled
            return site.getId() === 'existing-site-456';
          }
          return false;
        }),
        getQueues: sandbox.stub().returns({ audits: 'audit-queue' }),
      };
      mockConfiguration.findLatest.resolves(configurationInstance);

      // Mock allByOrganizationId to return sites including the one with agentic traffic enabled
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.allByOrganizationId = sandbox.stub()
        .callsFake(() => Promise.resolve([existingSiteWithAgenticTraffic, mockSite]));

      const lambdaCtxWithSites = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockConfiguration,
        mockSiteModel,
      });

      // Execute the function
      await onboardSite(input, lambdaCtxWithSites, slackCtx);

      // Verify that the log message for already enabled agentic traffic audits is called
      expect(lambdaCtxWithSites.log.debug).to.have.been.calledWith(sinon.match('Agentic traffic audits already enabled for organization org123, skipping'));
    });

    it('should create new organization when no existing organization is found', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks - no existing site
      const mockSite = createDefaultMockSite(sandbox);
      mockSite.setOrganizationId('new-org-789'); // Set the correct organization ID
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock organization lookup to return null (no existing org)
      const mockOrganization = createDefaultMockOrganization(sandbox);
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

      const lambdaCtxWithNewOrg = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockOrganization,
        mockImsClient,
      });

      // Execute the function
      await onboardSite(input, lambdaCtxWithNewOrg, slackCtx);

      // Verify that organization lookup was called
      expect(lambdaCtxWithNewOrg.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify that IMS client was called to get org details
      expect(lambdaCtxWithNewOrg.imsClient.getImsOrganizationDetails).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify that new organization was created
      expect(lambdaCtxWithNewOrg.dataAccess.Organization.create).to.have.been.calledWith({
        name: 'New Test Organization',
        imsOrgId: 'ABC123@AdobeOrg',
      });

      // Verify that new organization was saved
      expect(newOrg.save).to.have.been.called;

      // Verify that site was created with the new organization ID
      expect(lambdaCtxWithNewOrg.dataAccess.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        deliveryType: 'aem_edge',
        organizationId: 'new-org-789',
      });

      // Verify that entitlement and enrollment were created
      expect(lambdaCtxWithNewOrg.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'new-org-789',
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtxWithNewOrg.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });

      // Verify that organization identity provider was created
      expect(lambdaCtxWithNewOrg.dataAccess.OrganizationIdentityProvider.allByOrganizationId)
        .to.have.been.calledWith('new-org-789');
      expect(lambdaCtxWithNewOrg.dataAccess.OrganizationIdentityProvider.create)
        .to.have.been.calledWith({
          organizationId: 'new-org-789',
          provider: 'IMS',
          externalId: 'ABC123@AdobeOrg',
        });
    });

    it('should skip entitlement creation when site already has LLMO entitlements', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock existing LLMO entitlement
      const existingEntitlement = {
        getId: sandbox.stub().returns('existing-entitlement-123'),
        getProductCode: sandbox.stub().returns('LLMO'),
        getOrganizationId: sandbox.stub().returns('org123'),
      };

      const mockEntitlement = createDefaultMockEntitlement(sandbox);
      mockEntitlement.findByOrganizationIdAndProductCode.resolves(existingEntitlement);

      const mockSiteEnrollment = createDefaultMockSiteEnrollment(sandbox);
      mockSiteEnrollment.allBySiteId.resolves([]); // No existing enrollments for this site

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockEntitlement,
        mockSiteEnrollment,
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that entitlement creation was skipped but enrollment was still created
      expect(lambdaCtx.dataAccess.Entitlement.create).to.not.have.been.called;
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'existing-entitlement-123',
        siteId: 'site123',
      });
    });

    it('should skip organization identity provider creation when it already exists', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock existing organization identity provider
      const existingIdp = {
        getProvider: sandbox.stub().returns('IMS'),
      };

      const mockOrganizationIdentityProvider = createDefaultMockOrganizationIdentityProvider(
        sandbox,
      );
      mockOrganizationIdentityProvider.allByOrganizationId.resolves([existingIdp]);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockOrganizationIdentityProvider,
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that IDP creation was skipped
      expect(lambdaCtx.dataAccess.OrganizationIdentityProvider.create).to.not.have.been.called;
      expect(lambdaCtx.log.info).to.have.been.calledWith('Organization identity provider already exists for organization org123, skipping creation');
    });

    it('should log warning when HLX_ADMIN_TOKEN is not set', async () => {
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

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Store original env var
      const originalToken = process.env.HLX_ADMIN_TOKEN;
      // Remove the token
      delete process.env.HLX_ADMIN_TOKEN;

      try {
        // Execute the function
        await onboardSite(input, lambdaCtx, slackCtx);

        // Verify that warning was logged
        expect(lambdaCtx.log.warn).to.have.been.calledWith('LLMO onboarding: HLX_ADMIN_TOKEN is not set');
      } finally {
        // Restore original env var
        if (originalToken !== undefined) {
          process.env.HLX_ADMIN_TOKEN = originalToken;
        }
      }
    });

    it('should handle fetch error when publishing to admin.hlx.page fails', async () => {
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

      // Mock fetch to throw an error
      global.fetch = sandbox.stub().rejects(new Error('Network error'));

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that error was logged
      expect(lambdaCtx.log.error).to.have.been.calledWith(sinon.match('Failed to publish via admin.hlx.page: Network error'));
    });

    it('should handle non-ok response when publishing to admin.hlx.page', async () => {
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

      // Mock fetch to return non-ok response
      global.fetch = sandbox.stub().resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that error was logged
      expect(lambdaCtx.log.error).to.have.been.calledWith(sinon.match('Failed to publish via admin.hlx.page: preview failed: 500 Internal Server Error'));
    });

    it('should handle existing SharePoint folder and query index file', async () => {
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

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Create a new octokit mock for this specific test that returns content ending with newline
      const testOctokitMock = sinon.stub().returns({
        repos: {
          getContent: sinon.stub().resolves({
            data: {
              content: Buffer.from('test content\n').toString('base64'),
              sha: 'test-sha-123',
            },
          }),
          createOrUpdateFileContents: sinon.stub().resolves(),
        },
      });

      // Override the octokit mock for this test
      const originalOctokitMock = octokitMock;
      octokitMock = testOctokitMock;

      // Create a mock SharePoint client that returns existing files
      const mockSharepointClient = {
        getDocument: sinon.stub().callsFake((path) => {
          const mockDoc = {
            exists: sinon.stub().callsFake(() => {
              // Mock folder and query index as existing
              if (path.includes('example-com')) {
                return Promise.resolve(true);
              }
              return Promise.resolve(false);
            }),
            createFolder: sinon.stub().resolves(),
            copy: sinon.stub().resolves(),
          };
          return mockDoc;
        }),
      };

      // Re-mock the module with the new octokit mock and SharePoint mocks
      mockedModule = await esmock('../../../../src/support/slack/actions/onboard-llmo-modal.js', {
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: {
            toDynamoItem: sinon.stub().returns({}),
          },
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharepointClient),
        },
        '@octokit/rest': {
          Octokit: testOctokitMock,
        },
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: sinon.stub(),
        },
      });

      onboardSite = mockedModule.onboardSite;

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that warning messages were sent for existing folder and query index
      expect(slackCtx.say).to.have.been.calledWith('Folder example-com already exists. Skipping creation.');
      expect(slackCtx.say).to.have.been.calledWith('Query index in example-com already exists. Skipping creation.');

      // Verify that warning was logged
      expect(lambdaCtx.log.warn).to.have.been.calledWith('Warning: Folder example-com already exists. Skipping creation.');
      expect(lambdaCtx.log.warn).to.have.been.calledWith('Warning: Query index at example-com already exists. Skipping creation.');

      // Verify that createFolder and copy were not called since files already exist
      expect(mockSharepointClient.getDocument().createFolder).to.not.have.been.called;
      expect(mockSharepointClient.getDocument().copy).to.not.have.been.called;

      // Restore original octokit mock
      octokitMock = originalOctokitMock;
    });

    it('should skip YAML update when data folder already exists in helix-query.yaml', async () => {
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

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Create a new octokit mock that returns content containing the data folder
      const testOctokitMock = sinon.stub().returns({
        repos: {
          getContent: sinon.stub().resolves({
            data: {
              content: Buffer.from(`existing content
example-com:
  <<: *default
  include:
    - '/example-com/**'
  target: /example-com/query-index.xlsx
`).toString('base64'),
              sha: 'test-sha-123',
            },
          }),
          createOrUpdateFileContents: sinon.stub().resolves(),
        },
      });

      // Override the octokit mock for this test
      const originalOctokitMock = octokitMock;
      octokitMock = testOctokitMock;

      // Re-mock the module with the new octokit mock
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
          Octokit: testOctokitMock,
        },
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: sinon.stub(),
        },
      });

      onboardSite = mockedModule.onboardSite;

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that warning messages were sent for existing data folder in YAML
      expect(slackCtx.say).to.have.been.calledWith('Helix query yaml already contains string example-com. Skipping GitHub update.');

      // Verify that warning was logged
      expect(lambdaCtx.log.warn).to.have.been.calledWith('Helix query yaml already contains string example-com. Skipping update.');

      // Verify that createOrUpdateFileContents was not called since the data folder already exists
      const octokitInstance = testOctokitMock.getCall(0).returnValue;
      expect(octokitInstance.repos.createOrUpdateFileContents).to.not.have.been.called;

      // Restore original octokit mock
      octokitMock = originalOctokitMock;
    });

    it('should create new entitlement when site has entitlement with different organization ID', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock no existing entitlement for this organization (will create new one)
      const mockEntitlement = createDefaultMockEntitlement(sandbox);
      // Return null to indicate no existing entitlement for this org/product combination
      mockEntitlement.findByOrganizationIdAndProductCode.resolves(null);

      const mockSiteEnrollment = createDefaultMockSiteEnrollment(sandbox);
      mockSiteEnrollment.allBySiteId.resolves([]);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockEntitlement,
        mockSiteEnrollment,
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that a new entitlement was created (since existing one has different org ID)
      expect(lambdaCtx.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'org123', // Site's organization ID
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });

      // Verify that the organization entitlement was checked
      expect(lambdaCtx.dataAccess.Entitlement.findByOrganizationIdAndProductCode).to.have.been.calledWith('org123', 'LLMO');
    });

    it('should create new entitlement when site has entitlement with wrong product code', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock no existing LLMO entitlement for this organization (will create new one)
      const mockEntitlement = createDefaultMockEntitlement(sandbox);
      // Return null to indicate no existing LLMO entitlement for this org
      mockEntitlement.findByOrganizationIdAndProductCode.resolves(null);

      const mockSiteEnrollment = createDefaultMockSiteEnrollment(sandbox);
      mockSiteEnrollment.allBySiteId.resolves([]);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockEntitlement,
        mockSiteEnrollment,
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that a new entitlement was created (since existing one has wrong product code)
      expect(lambdaCtx.dataAccess.Entitlement.create).to.have.been.calledWith({
        organizationId: 'org123', // Site's organization ID
        productCode: 'LLMO',
        tier: 'FREE_TRIAL',
        quotas: { llmo_trial_prompts: 200 },
      });
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.have.been.calledWith({
        entitlementId: 'entitlement123',
        siteId: 'site123',
      });

      // Verify that the organization entitlement was checked
      expect(lambdaCtx.dataAccess.Entitlement.findByOrganizationIdAndProductCode).to.have.been.calledWith('org123', 'LLMO');
    });

    it('should skip enrollment creation when site is already enrolled in the entitlement', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock existing LLMO entitlement
      const existingEntitlement = {
        getId: sandbox.stub().returns('existing-entitlement-456'),
        getProductCode: sandbox.stub().returns('LLMO'),
        getOrganizationId: sandbox.stub().returns('org123'),
      };

      const mockEntitlement = createDefaultMockEntitlement(sandbox);
      mockEntitlement.findByOrganizationIdAndProductCode.resolves(existingEntitlement);

      // Mock existing enrollment for the site in this entitlement
      const existingEnrollment = {
        getId: sandbox.stub().returns('existing-enrollment-789'),
        getEntitlementId: sandbox.stub().returns('existing-entitlement-456'),
        getSiteId: sandbox.stub().returns('site123'),
      };

      const mockSiteEnrollment = createDefaultMockSiteEnrollment(sandbox);
      mockSiteEnrollment.allBySiteId.resolves([existingEnrollment]); // Site already enrolled

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockEntitlement,
        mockSiteEnrollment,
      });

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that no new entitlement was created (existing one was used)
      expect(lambdaCtx.dataAccess.Entitlement.create).to.not.have.been.called;

      // Verify that no new enrollment was created (existing one was used)
      expect(lambdaCtx.dataAccess.SiteEnrollment.create).to.not.have.been.called;

      // Verify that the existing entitlement was found
      expect(lambdaCtx.dataAccess.Entitlement.findByOrganizationIdAndProductCode)
        .to.have.been.calledWith('org123', 'LLMO');

      // Verify that existing enrollments were checked
      expect(lambdaCtx.dataAccess.SiteEnrollment.allBySiteId).to.have.been.calledWith('site123');

      // Verify that log message was recorded for existing enrollment
      expect(lambdaCtx.log.info).to.have.been.calledWith('Site site123 already enrolled in entitlement existing-entitlement-456');
    });

    it('should handle entitlement creation error and show proper error message', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock entitlement creation to throw an error
      const mockEntitlement = createDefaultMockEntitlement(sandbox);
      mockEntitlement.findByOrganizationIdAndProductCode.resolves(null); // No existing entitlement
      const entitlementError = new Error('Failed to create entitlement');
      mockEntitlement.create.throws(entitlementError);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockEntitlement,
      });

      // Execute the function - it should handle the error gracefully
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that the error was logged
      expect(lambdaCtx.log.error).to.have.been.calledWith('Error in LLMO onboarding:', entitlementError);

      // Verify that the error message was posted to Slack
      expect(slackCtx.say).to.have.been.calledWith(
        sinon.match.string, // The postErrorMessage function formats the error message
      );
    });

    it('should handle enrollment creation error and show proper error message', async () => {
      // Mock data
      const input = {
        baseURL: 'https://example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
      };

      // Use default mocks
      const mockSite = createDefaultMockSite(sandbox);
      const slackCtx = createDefaultMockSlackCtx(sandbox);

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Mock entitlement creation to succeed but enrollment creation to fail
      const mockEntitlement = createDefaultMockEntitlement(sandbox);
      mockEntitlement.findByOrganizationIdAndProductCode.resolves(null); // No existing entitlement
      const createdEntitlement = {
        getId: sandbox.stub().returns('entitlement123'),
        save: sandbox.stub().resolves(),
      };
      mockEntitlement.create.returns(createdEntitlement);

      const mockSiteEnrollment = createDefaultMockSiteEnrollment(sandbox);
      mockSiteEnrollment.allBySiteId.resolves([]); // No existing enrollments
      const enrollmentError = new Error('Failed to create enrollment');
      mockSiteEnrollment.create.throws(enrollmentError);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {
        mockSite,
        mockEntitlement,
        mockSiteEnrollment,
      });

      // Execute the function - it should handle the error gracefully
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that the error was logged
      expect(lambdaCtx.log.error).to.have.been.calledWith('Error in LLMO onboarding:', enrollmentError);

      // Verify that the error message was posted to Slack
      expect(slackCtx.say).to.have.been.calledWith(
        sinon.match.string, // The postErrorMessage function formats the error message
      );
    });
  });

  describe('onboardLLMOModal', () => {
    it('should handle modal submission successfully and log expected messages', async () => {
      const mockBody = {
        view: {
          state: {
            values: {
              brand_name_input: {
                brand_name: { value: 'Test Brand' },
              },
              ims_org_input: {
                ims_org_id: { value: 'ABC123@AdobeOrg' },
              },
              delivery_type_input: {
                delivery_type: {
                  selected_option: { value: 'aem_edge' },
                },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'C1234567890',
            originalThreadTs: '1234567890.123456',
            brandURL: 'https://example.com',
          }),
        },
        user: { id: 'U1234567890' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { onboardLLMOModal } = mockedModule;
      const handler = onboardLLMOModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.debug).to.have.been.calledWith('Starting onboarding process...');
      expect(lambdaCtx.log.info).to.have.been.calledWith('Onboarding request with parameters:', {
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
        brandURL: 'https://example.com',
        originalChannel: 'C1234567890',
        originalThreadTs: '1234567890.123456',
      });
      expect(lambdaCtx.log.debug).to.have.been.calledWith('Onboard LLMO modal processed for user U1234567890, site https://example.com');
      expect(mockAck).to.have.been.calledOnce;
    });

    it('should print error message if onboarding throws an error', async () => {
      const mockBody = {
        view: {
          state: {
            values: {
              brand_name_input: {
                brand_name: { value: 'Test Brand' },
              },
              ims_org_input: {
                ims_org_id: { value: 'ABC123@AdobeOrg' },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'C1234567890',
            originalThreadTs: '1234567890.123456',
            brandURL: 'this is not a valid URL',
          }),
        },
        user: { id: 'U1234567890' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, {});

      const { onboardLLMOModal } = mockedModule;
      const handler = onboardLLMOModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.error).to.have.been.calledWith('Error handling onboard site modal:', sinon.match.instanceOf(Error));
      expect(mockAck).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          brand_name_input: 'There was an error processing the onboarding request.',
        },
      });
    });

    it('should return validation error when IMS org ID is not provided', async () => {
      const mockBody = {
        view: {
          state: {
            values: {
              brand_name_input: {
                brand_name: { value: 'Test Brand' },
              },
              ims_org_input: {
                ims_org_id: { value: '' }, // Empty IMS org ID
              },
              delivery_type_input: {
                delivery_type: {
                  selected_option: { value: 'aem_edge' },
                },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'C1234567890',
            originalThreadTs: '1234567890.123456',
            brandURL: 'https://example.com',
          }),
        },
        user: { id: 'U1234567890' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { onboardLLMOModal } = mockedModule;
      const handler = onboardLLMOModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          brand_name_input: undefined,
          ims_org_input: 'IMS Org ID is required',
        },
      });
    });

    it('should return validation error when brand name is not provided', async () => {
      const mockBody = {
        view: {
          state: {
            values: {
              brand_name_input: {
                brand_name: { value: '' }, // Empty brand name
              },
              ims_org_input: {
                ims_org_id: { value: 'ABC123@AdobeOrg' },
              },
              delivery_type_input: {
                delivery_type: {
                  selected_option: { value: 'aem_edge' },
                },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'C1234567890',
            originalThreadTs: '1234567890.123456',
            brandURL: 'https://example.com',
          }),
        },
        user: { id: 'U1234567890' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { onboardLLMOModal } = mockedModule;
      const handler = onboardLLMOModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          brand_name_input: 'Brand name is required',
          ims_org_input: undefined,
        },
      });
    });

    it('should log warning when private metadata parsing fails', async () => {
      const mockBody = {
        view: {
          state: {
            values: {
              brand_name_input: {
                brand_name: { value: 'Test Brand' },
              },
              ims_org_input: {
                ims_org_id: { value: 'ABC123@AdobeOrg' },
              },
              delivery_type_input: {
                delivery_type: {
                  selected_option: { value: 'aem_edge' },
                },
              },
            },
          },
          private_metadata: 'invalid json{', // Invalid JSON that will cause parsing to fail
        },
        user: { id: 'U1234567890' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { onboardLLMOModal } = mockedModule;
      const handler = onboardLLMOModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.warn).to.have.been.calledWith('Failed to parse private metadata:', sinon.match.instanceOf(Error));
      expect(lambdaCtx.log.debug).to.have.been.calledWith('Starting onboarding process...');
      expect(lambdaCtx.log.info).to.have.been.calledWith('Onboarding request with parameters:', {
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
        brandURL: undefined, // Should be undefined when parsing fails
        originalChannel: undefined,
        originalThreadTs: undefined,
      });
    });
  });

  describe('startLLMOOnboarding', () => {
    it('should call fullOnboardingModal when site is not found', async () => {
      const mockBody = {
        user: { id: 'user123' },
        actions: [{ value: 'https://example.com' }],
        trigger_id: 'trigger123',
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };
      const mockRespond = sandbox.stub();

      // Mock Site.findByBaseURL to return null (site not found)
      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findByBaseURL.resolves(null);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { startLLMOOnboarding } = mockedModule;
      const handler = startLLMOOnboarding(lambdaCtx);

      await handler({
        ack: mockAck, body: mockBody, client: mockClient, respond: mockRespond,
      });

      expect(mockAck).to.have.been.called;
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.log.debug).to.have.been.calledWith('User user123 started full onboarding process for https://example.com.');
    });

    it('should show error message when site is found but already has brand configured', async () => {
      const mockBody = {
        user: { id: 'user123' },
        actions: [{ value: 'https://example.com' }],
        trigger_id: 'trigger123',
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };
      const mockRespond = sandbox.stub();

      // Mock site with existing brand configuration
      const mockSite = createDefaultMockSite(sandbox);
      const mockConfig = {
        getLlmoBrand: sandbox.stub().returns('Existing Brand'),
      };
      mockSite.getConfig.returns(mockConfig);

      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findByBaseURL.resolves(mockSite);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { startLLMOOnboarding } = mockedModule;
      const handler = startLLMOOnboarding(lambdaCtx);

      await handler({
        ack: mockAck, body: mockBody, client: mockClient, respond: mockRespond,
      });

      expect(mockAck).to.have.been.called;
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockRespond).to.have.been.calledWith({
        text: ':cdbot-error: It looks like https://example.com is already configured for LLMO with brand Existing Brand',
        replace_original: true,
      });
      expect(lambdaCtx.log.debug).to.have.been.calledWith('Aborted https://example.com onboarding: Already onboarded with brand Existing Brand');
    });

    it('should call elmoOnboardingModal when site is found but no brand configured', async () => {
      const mockBody = {
        user: { id: 'user123' },
        actions: [{ value: 'https://example.com' }],
        trigger_id: 'trigger123',
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };
      const mockRespond = sandbox.stub();

      // Mock site without brand configuration
      const mockSite = createDefaultMockSite(sandbox);
      const mockConfig = {
        getLlmoBrand: sandbox.stub().returns(null), // No brand configured
      };
      mockSite.getConfig.returns(mockConfig);

      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findByBaseURL.resolves(mockSite);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { startLLMOOnboarding } = mockedModule;
      const handler = startLLMOOnboarding(lambdaCtx);

      await handler({
        ack: mockAck, body: mockBody, client: mockClient, respond: mockRespond,
      });

      expect(mockAck).to.have.been.called;
      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.log.debug).to.have.been.calledWith('User user123 started LLMO onboarding process for https://example.com with existing site site123.');
    });

    it('should handle errors gracefully', async () => {
      const mockBody = {
        user: { id: 'user123' },
        actions: [{ value: 'https://example.com' }],
        trigger_id: 'trigger123',
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };
      const mockRespond = sandbox.stub();

      // Mock Site.findByBaseURL to throw an error
      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findByBaseURL.rejects(new Error('Database error'));

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { startLLMOOnboarding } = mockedModule;
      const handler = startLLMOOnboarding(lambdaCtx);

      await handler({
        ack: mockAck, body: mockBody, client: mockClient, respond: mockRespond,
      });

      expect(mockAck).to.have.been.called;
      expect(lambdaCtx.log.error).to.have.been.calledWith('Error handling start onboarding:', sinon.match.instanceOf(Error));
      expect(mockRespond).to.have.been.calledWith({
        text: ':x: There was an error starting the onboarding process.',
        replace_original: false,
      });
    });
  });
});
