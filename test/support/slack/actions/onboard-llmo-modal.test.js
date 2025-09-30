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
  let mockTierClient;
  let tierClientMock;

  // Default mocks that can be reused across tests
  const createDefaultMockSite = (sinonSandbox) => {
    let organizationId = 'org123';
    return {
      getId: sinonSandbox.stub().returns('site123'),
      getOrganizationId: sinonSandbox.stub().callsFake(() => organizationId),
      setOrganizationId: sinonSandbox.stub().callsFake((newOrgId) => {
        organizationId = newOrgId;
      }),
      getOrganization: sinonSandbox.stub().resolves({
        getId: sinonSandbox.stub().returns('org123'),
        getImsOrgId: sinonSandbox.stub().returns('ABC123@AdobeOrg'),
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
        debug: sinonSandbox.stub(),
      },
      dataAccess: {
        Site: mockSiteModel,
        Configuration: mockConfiguration,
        Organization: mockOrganization,
        Entitlement: mockEntitlement,
        SiteEnrollment: mockSiteEnrollment,

      },
      env: {
        ENV: 'prod',
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

    // Create TierClient mock with a stable reference that can be reset
    const mockClientInstance = {
      createEntitlement: sinon.stub().resolves({
        entitlement: {
          getId: () => 'entitlement123',
          getOrganizationId: () => 'org123',
          getProductCode: () => 'LLMO',
          getTier: () => 'FREE_TRIAL',
        },
        siteEnrollment: {
          getId: () => 'enrollment123',
          getSiteId: () => 'site123',
          getEntitlementId: () => 'entitlement123',
        },
      }),
    };

    tierClientMock = {
      createForSite: sinon.stub().returns(mockClientInstance),
    };

    // Store the mock instance for easier access in tests
    mockTierClient = mockClientInstance;

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
      '@adobe/spacecat-shared-tier-client': {
        default: tierClientMock,
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

    // Reset TierClient mock completely for each test
    tierClientMock.createForSite.resetHistory();
    tierClientMock.createForSite.resetBehavior();

    // Create a fresh mock instance for each test with sandbox stubs
    const freshCreateEntitlementStub = sandbox.stub().resolves({
      entitlement: {
        getId: sandbox.stub().returns('entitlement123'),
        getOrganizationId: sandbox.stub().returns('org123'),
        getProductCode: sandbox.stub().returns('LLMO'),
        getTier: sandbox.stub().returns('FREE_TRIAL'),
      },
      siteEnrollment: {
        getId: sandbox.stub().returns('enrollment123'),
        getSiteId: sandbox.stub().returns('site123'),
        getEntitlementId: sandbox.stub().returns('entitlement123'),
      },
    });

    // Create a fresh mock client instance for each test
    const freshMockClientInstance = {
      createEntitlement: freshCreateEntitlementStub,
    };

    // Configure the createForSite mock to return a fresh instance
    tierClientMock.createForSite.returns(freshMockClientInstance);

    // Update mockTierClient reference for easy access in tests
    mockTierClient = freshMockClientInstance;
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

      // Verify that TierClient was used for entitlement and enrollment
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
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
        branch: 'main',
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
        '@adobe/spacecat-shared-tier-client': {
          default: tierClientMock,
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

      // Verify that TierClient was used for entitlement and enrollment
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
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

      // Verify that TierClient was used for entitlement and enrollment
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
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

      // Verify that TierClient was used for entitlement and enrollment
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
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

      // Verify that TierClient was used for entitlement and enrollment
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
    });

    it('should handle LLMO entitlement creation via TierClient', async () => {
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
      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSite });

      // Mock fetch for admin.hlx.page calls
      global.fetch = createDefaultMockFetch(sandbox);

      // Execute the function
      await onboardSite(input, lambdaCtx, slackCtx);

      // Verify that TierClient was used for entitlement and enrollment
      expect(mockTierClient.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
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
        '@adobe/spacecat-shared-tier-client': {
          default: tierClientMock,
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
        '@adobe/spacecat-shared-tier-client': {
          default: tierClientMock,
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

    it('should return immediately after ack without waiting for onboarding to complete', async () => {
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

      // Create a slow onboarding process to verify fire-and-forget behavior
      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);
      const slowOnboardingPromise = new Promise((resolve) => {
        setTimeout(resolve, 1000); // Simulate slow operation
      });
      lambdaCtx.dataAccess.Site.findByBaseURL = sandbox.stub().returns(slowOnboardingPromise);

      const { onboardLLMOModal } = mockedModule;
      const handler = onboardLLMOModal(lambdaCtx);

      const startTime = Date.now();
      await handler({ ack: mockAck, body: mockBody, client: mockClient });
      const endTime = Date.now();

      // Handler should return quickly (well under 1 second), not wait for the slow operation
      expect(endTime - startTime).to.be.lessThan(500);
      expect(mockAck).to.have.been.calledOnce;
      expect(mockAck).to.have.been.calledWith(); // Called without errors
      expect(lambdaCtx.log.debug).to.have.been.calledWith('Onboard LLMO modal processed for user U1234567890, site https://example.com');
    });

    it('should log error if onboarding throws an error in background', async () => {
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

      // The handler should acknowledge successfully even if onboarding will fail
      expect(mockAck).to.have.been.calledOnce;
      expect(mockAck).to.have.been.calledWith();

      // Wait a bit for the background promise to settle
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      // The error should be logged by the background error handler
      expect(lambdaCtx.log.error).to.have.been.calledWith(
        sinon.match(/Error in background onboarding for site/),
        sinon.match.instanceOf(Error),
      );
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

    it('should call elmoOnboardingModal when site is found with brand configured', async () => {
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

      // Mock site with brand configuration
      const mockSite = createDefaultMockSite(sandbox);
      const mockConfig = {
        getLlmoBrand: sandbox.stub().returns('Test Brand'), // Brand configured
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

  describe('addEntitlementsAction', () => {
    it('should successfully add entitlements for a site', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub(),
          update: sandbox.stub().resolves(),
        },
        views: {
          update: sandbox.stub().resolves(),
        },
      };

      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findById.resolves(mockSite);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { addEntitlementsAction } = mockedModule;
      const handler = addEntitlementsAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;

      // Check that the original message was updated to prevent re-triggering
      expect(mockClient.chat.update).to.have.been.calledWith({
        channel: 'channel123',
        ts: 'message123',
        text: ':gear: Test User is adding LLMO entitlements...',
        blocks: [],
      });

      // Check that the function completed successfully by verifying the debug log
      expect(lambdaCtx.log.debug).to.have.been.calledWith('Added entitlements for site site123 (https://example.com) for user user123');
    });

    it('should handle errors during entitlement addition', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub(),
        },
        views: {
          update: sandbox.stub().resolves(),
        },
      };

      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findById.rejects(new Error('Database error'));

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { addEntitlementsAction } = mockedModule;
      const handler = addEntitlementsAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.error).to.have.been.calledWith('Error adding entitlements:', sinon.match.instanceOf(Error));
    });

    it('should handle site not found', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub(),
          update: sandbox.stub().resolves(),
        },
        views: {
          update: sandbox.stub().resolves(),
        },
      };

      const mockSiteModel = createDefaultMockSiteModel(sandbox);
      mockSiteModel.findById.resolves(null); // Site not found

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { addEntitlementsAction } = mockedModule;
      const handler = addEntitlementsAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;

      // Check that the original message was updated to prevent re-triggering
      expect(mockClient.chat.update).to.have.been.calledWith({
        channel: 'channel123',
        ts: 'message123',
        text: ':gear: Test User is adding LLMO entitlements...',
        blocks: [],
      });

      // Check that a chat message was posted for site not found
      expect(mockClient.chat.postMessage).to.have.been.calledWith({
        channel: 'channel123',
        text: ':x: Site not found. Please try again.',
        thread_ts: 'thread123',
      });
    });
  });

  describe('updateOrgAction', () => {
    it('should successfully update organization modal', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            currentOrgId: 'org123',
            originalChannel: 'channel123',
            originalThreadTs: 'message123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          update: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };

      // Mock organization with IMS org ID
      const mockOrganizationInstance = {
        getImsOrgId: sandbox.stub().returns('CURRENT123@AdobeOrg'),
      };

      const mockOrganization = {
        findById: sandbox.stub().withArgs('org123').resolves(mockOrganizationInstance),
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockOrganization });

      const { updateOrgAction } = mockedModule;
      const handler = updateOrgAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;

      // Check that the original message was updated to prevent re-triggering
      expect(mockClient.chat.update).to.have.been.calledWith({
        channel: 'channel123',
        ts: 'message123',
        text: ':gear: Test User is updating IMS organization...',
        blocks: [],
      });

      expect(mockClient.views.open).to.have.been.called;

      // Check that the modal was opened with the current IMS org ID as placeholder
      const openCall = mockClient.views.open.getCall(0);
      const modalBlocks = openCall.args[0].view.blocks;
      const inputBlock = modalBlocks.find((block) => block.type === 'input');
      expect(inputBlock.element.placeholder.text).to.equal('CURRENT123@AdobeOrg');

      expect(lambdaCtx.log.debug).to.have.been.calledWith('User user123 started org update process for site site123 (https://example.com)');
    });

    it('should use default placeholder when organization is not found', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            currentOrgId: 'org123',
            originalChannel: 'channel123',
            originalThreadTs: 'message123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          update: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };

      // Mock organization lookup to return null (not found)
      const mockOrganization = {
        findById: sandbox.stub().withArgs('org123').resolves(null),
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockOrganization });

      const { updateOrgAction } = mockedModule;
      const handler = updateOrgAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;

      // Check that the original message was updated to prevent re-triggering
      expect(mockClient.chat.update).to.have.been.calledWith({
        channel: 'channel123',
        ts: 'message123',
        text: ':gear: Test User is updating IMS organization...',
        blocks: [],
      });

      expect(mockClient.views.open).to.have.been.called;

      // Check that the modal was opened with the default placeholder
      const openCall = mockClient.views.open.getCall(0);
      const modalBlocks = openCall.args[0].view.blocks;
      const inputBlock = modalBlocks.find((block) => block.type === 'input');
      expect(inputBlock.element.placeholder.text).to.equal('ABC123@AdobeOrg');

      // When organization is not found, no warning is logged (it's a normal case)
      expect(lambdaCtx.log.warn).to.not.have.been.called;
    });

    it('should use default placeholder when organization lookup throws error', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            currentOrgId: 'org123',
            originalChannel: 'channel123',
            originalThreadTs: 'message123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          update: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };

      // Mock organization lookup to throw an error
      const mockOrganization = {
        findById: sandbox.stub().withArgs('org123').rejects(new Error('Database error')),
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockOrganization });

      const { updateOrgAction } = mockedModule;
      const handler = updateOrgAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;

      // Check that the original message was updated to prevent re-triggering
      expect(mockClient.chat.update).to.have.been.calledWith({
        channel: 'channel123',
        ts: 'message123',
        text: ':gear: Test User is updating IMS organization...',
        blocks: [],
      });

      expect(mockClient.views.open).to.have.been.called;

      // Check that the modal was opened with the default placeholder
      const openCall = mockClient.views.open.getCall(0);
      const modalBlocks = openCall.args[0].view.blocks;
      const inputBlock = modalBlocks.find((block) => block.type === 'input');
      expect(inputBlock.element.placeholder.text).to.equal('ABC123@AdobeOrg');

      expect(lambdaCtx.log.warn).to.have.been.calledWith('Could not fetch current IMS org ID for organization org123: Database error');
    });

    it('should use default placeholder when organization has no IMS org ID', async () => {
      const mockBody = {
        user: { id: 'user123', name: 'Test User' },
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            currentOrgId: 'org123',
            originalChannel: 'channel123',
            originalThreadTs: 'message123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          update: sandbox.stub().resolves(),
        },
        views: {
          open: sandbox.stub().resolves(),
        },
      };

      // Mock organization with no IMS org ID
      const mockOrganizationInstance = {
        getImsOrgId: sandbox.stub().returns(null),
      };

      const mockOrganization = {
        findById: sandbox.stub().withArgs('org123').resolves(mockOrganizationInstance),
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockOrganization });

      const { updateOrgAction } = mockedModule;
      const handler = updateOrgAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;

      // Check that the original message was updated to prevent re-triggering
      expect(mockClient.chat.update).to.have.been.calledWith({
        channel: 'channel123',
        ts: 'message123',
        text: ':gear: Test User is updating IMS organization...',
        blocks: [],
      });

      expect(mockClient.views.open).to.have.been.called;

      // Check that the modal was opened with the default placeholder
      const openCall = mockClient.views.open.getCall(0);
      const modalBlocks = openCall.args[0].view.blocks;
      const inputBlock = modalBlocks.find((block) => block.type === 'input');
      expect(inputBlock.element.placeholder.text).to.equal('ABC123@AdobeOrg');
    });

    it('should handle errors during modal update', async () => {
      const mockBody = {
        user: { id: 'user123' },
        channel: { id: 'channel123' },
        trigger_id: 'trigger123',
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
            originalChannel: 'channel123',
            originalThreadTs: 'message123',
          }),
        }],
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        views: {
          open: sandbox.stub().rejects(new Error('Modal error')),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { updateOrgAction } = mockedModule;
      const handler = updateOrgAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.error).to.have.been.calledWith('Error starting org update:', sinon.match.instanceOf(Error));
    });
  });

  describe('updateIMSOrgModal', () => {
    it('should successfully update IMS organization', async () => {
      const mockBody = {
        user: { id: 'user123' },
        view: {
          state: {
            values: {
              new_ims_org_input: {
                new_ims_org_id: { value: 'NEW123@AdobeOrg' },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
          }),
        },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findById.resolves(mockSite);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { updateIMSOrgModal } = mockedModule;
      const handler = updateIMSOrgModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.called;
      expect(mockClient.chat.postMessage).to.have.been.calledWith({
        channel: 'channel123',
        text: ':white_check_mark: Successfully updated organization and applied LLMO entitlements for *https://example.com* (brand: *Test Brand*)',
        thread_ts: 'thread123',
      });
      expect(lambdaCtx.log.debug).to.have.been.calledWith('Updated org and applied entitlements for site site123 (https://example.com) for user user123');
    });

    it('should return validation error when IMS org ID is not provided', async () => {
      const mockBody = {
        user: { id: 'user123' },
        view: {
          state: {
            values: {
              new_ims_org_input: {
                new_ims_org_id: { value: '' }, // Empty IMS org ID
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
          }),
        },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { updateIMSOrgModal } = mockedModule;
      const handler = updateIMSOrgModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockAck).to.have.been.calledWith({
        response_action: 'errors',
        errors: {
          new_ims_org_input: 'IMS Organization ID is required',
        },
      });
    });

    it('should handle site not found error', async () => {
      const mockBody = {
        user: { id: 'user123' },
        view: {
          state: {
            values: {
              new_ims_org_input: {
                new_ims_org_id: { value: 'NEW123@AdobeOrg' },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
          }),
        },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findById.resolves(null); // Site not found

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { updateIMSOrgModal } = mockedModule;
      const handler = updateIMSOrgModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(mockClient.chat.postMessage).to.have.been.calledWith({
        channel: 'channel123',
        text: ':x: Site not found. Please try again.',
        thread_ts: 'thread123',
      });
    });

    it('should handle errors during organization update', async () => {
      const mockBody = {
        user: { id: 'user123' },
        view: {
          state: {
            values: {
              new_ims_org_input: {
                new_ims_org_id: { value: 'NEW123@AdobeOrg' },
              },
            },
          },
          private_metadata: JSON.stringify({
            originalChannel: 'channel123',
            originalThreadTs: 'thread123',
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
          }),
        },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        chat: {
          postMessage: sandbox.stub().resolves(),
        },
      };

      const mockSite = createDefaultMockSite(sandbox);
      const mockSiteModel = createDefaultMockSiteModel(sandbox, mockSite);
      mockSiteModel.findById.rejects(new Error('Database error'));

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox, { mockSiteModel });

      const { updateIMSOrgModal } = mockedModule;
      const handler = updateIMSOrgModal(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.error).to.have.been.calledWith('Error updating organization:', sinon.match.instanceOf(Error));
      expect(mockAck).to.have.been.calledWith();
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle errors in createEntitlementAndEnrollment', async () => {
      const mockSite = createDefaultMockSite(sandbox);
      mockSite.getOrganizationId.returns('org123');

      // Override the tierClientMock to fail
      const failingMockClientInstance = {
        createEntitlement: sandbox.stub().rejects(new Error('Tier client error')),
      };
      tierClientMock.createForSite.returns(failingMockClientInstance);

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);
      const slackCtx = {
        say: sandbox.stub(),
      };

      // This should trigger the error handling in createEntitlementAndEnrollment
      try {
        await mockedModule.onboardSite({
          baseURL: 'https://example.com',
          brandName: 'Test Brand',
          imsOrgId: 'ABC123@AdobeOrg',
          deliveryType: 'aem_edge',
        }, lambdaCtx, slackCtx);
      } catch (error) {
        // Expected to throw
      }

      expect(lambdaCtx.log.info).to.have.been.calledWith(sinon.match('Ensuring LLMO entitlement and enrollment failed'));
      expect(slackCtx.say).to.have.been.calledWith(sinon.match('❌ Ensuring LLMO entitlement and enrollment failed'));
    });

    it('should handle missing user in updateOrgAction', async () => {
      const mockBody = {
        // Missing user property to trigger error
        actions: [{
          value: JSON.stringify({
            brandURL: 'https://example.com',
            siteId: 'site123',
            existingBrand: 'Test Brand',
          }),
        }],
        channel: { id: 'channel123' },
        message: { ts: 'message123' },
        view: { id: 'view123' },
      };

      const mockAck = sandbox.stub();
      const mockClient = {
        views: {
          update: sandbox.stub().resolves(),
        },
      };

      const lambdaCtx = createDefaultMockLambdaCtx(sandbox);

      const { updateOrgAction } = mockedModule;
      const handler = updateOrgAction(lambdaCtx);

      await handler({ ack: mockAck, body: mockBody, client: mockClient });

      expect(lambdaCtx.log.error).to.have.been.calledWith('Error starting org update:', sinon.match.instanceOf(Error));
    });
  });
});
