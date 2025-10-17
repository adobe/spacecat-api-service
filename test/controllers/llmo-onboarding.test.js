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
import esmock from 'esmock';

use(sinonChai);

describe('LLMO Onboarding Functions', () => {
  let mockDataAccess;
  let mockLog;
  let mockEnv;
  let mockSharePointClient;
  let mockSharePointFolder;

  beforeEach(() => {
    // Create mock data access
    mockDataAccess = {
      Site: {
        findByBaseURL: sinon.stub(),
        create: sinon.stub(),
      },
      Organization: {
        findByImsOrgId: sinon.stub(),
      },
      Configuration: {
        findLatest: sinon.stub(),
      },
    };

    // Create mock log
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub(),
    };

    // Create mock environment
    mockEnv = {
      ENV: 'dev',
      SHAREPOINT_CLIENT_ID: 'test-client-id',
      SHAREPOINT_CLIENT_SECRET: 'test-client-secret',
      SHAREPOINT_AUTHORITY: 'test-authority',
      SHAREPOINT_DOMAIN_ID: 'test-domain-id',
      DEFAULT_ORGANIZATION_ID: 'default-org-id',
    };

    // Create mock SharePoint client and folder
    mockSharePointFolder = {
      exists: sinon.stub(),
    };

    mockSharePointClient = {
      getDocument: sinon.stub().returns(mockSharePointFolder),
    };

    // _createSharePointClientStub = sinon.stub().resolves(mockSharePointClient);
  });

  describe('generateDataFolder', () => {
    it('should generate correct data folder name for production environment', async () => {
      // Import the function
      const { generateDataFolder } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {});

      // Test parameters
      const baseURL = 'https://test.com';
      const env = 'prod';

      // Call the function
      const result = generateDataFolder(baseURL, env);

      // Verify result
      expect(result).to.equal('test-com');
    }).timeout(5000);

    it('should generate correct data folder name for development environment', async () => {
      // Import the function
      const { generateDataFolder } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {});

      // Test parameters
      const baseURL = 'https://test.com';
      const env = 'dev';

      // Call the function
      const result = generateDataFolder(baseURL, env);

      // Verify result
      expect(result).to.equal('dev/test-com');
    });

    it('should handle complex domain names correctly', async () => {
      // Import the function
      const { generateDataFolder } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {});

      // Test with a complex domain
      const baseURL = 'https://my-awesome-site.example.com';
      const env = 'dev';

      // Call the function
      const result = generateDataFolder(baseURL, env);

      // Verify result
      expect(result).to.equal('dev/my-awesome-site-example-com');
    });

    it('should handle domains with special characters', async () => {
      // Import the function
      const { generateDataFolder } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {});

      // Test with special characters
      const baseURL = 'https://test-site.example.com:8080';
      const env = 'prod';

      // Call the function
      const result = generateDataFolder(baseURL, env);

      // Verify result - should extract hostname and replace special chars with hyphens
      expect(result).to.equal('test-site-example-com');
    });

    it('should use default env as dev when not specified', async () => {
      // Import the function
      const { generateDataFolder } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {});

      // Test parameters without env (should default to 'dev')
      const baseURL = 'https://test.com';

      // Call the function
      const result = generateDataFolder(baseURL);

      // Verify result
      expect(result).to.equal('dev/test-com');
    });
  });

  describe('validateSiteNotOnboarded', () => {
    it('should return isValid true when site and organization do not exist yet', async () => {
      // Setup mocks for non-existing site and organization
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockSharePointFolder.exists.resolves(false);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result
      expect(result).to.deep.equal({ isValid: true });

      // Verify SharePoint client was created and folder existence was checked
      expect(mockSharePointClient.getDocument).to.have.been.calledWith('/sites/elmo-ui-data/dev/example-com/');
      expect(mockSharePointFolder.exists).to.have.been.calledOnce;

      // Verify site and organization lookups
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(baseURL);
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith(imsOrgId);

      // Verify no errors were logged
      expect(mockLog.error).to.not.have.been.called;
    }).timeout(5000);

    it('should return isValid false when SharePoint folder already exists', async () => {
      // Setup mocks for non-existing site and organization but existing folder
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockSharePointFolder.exists.resolves(true);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result
      expect(result).to.deep.equal({
        isValid: false,
        error: 'Data folder for site https://example.com already exists. The site is already onboarded.',
      });

      // Verify SharePoint client was created and folder existence was checked
      expect(mockSharePointClient.getDocument).to.have.been.calledWith('/sites/elmo-ui-data/dev/example-com/');
      expect(mockSharePointFolder.exists).to.have.been.calledOnce;

      // Verify site and organization lookups were NOT called (early return)
      expect(mockDataAccess.Site.findByBaseURL).to.not.have.been.called;
      expect(mockDataAccess.Organization.findByImsOrgId).to.not.have.been.called;
    });

    it('should return isValid false when site exists and is assigned to different organization', async () => {
      // Create mock existing site assigned to different organization
      const existingSite = {
        getOrganizationId: sinon.stub().returns('different-org-id'),
      };

      // Create mock organization
      const organization = {
        getId: sinon.stub().returns('test-org-id'),
      };

      // Setup mocks
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(organization);
      mockSharePointFolder.exists.resolves(false);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result
      expect(result).to.deep.equal({
        isValid: false,
        error: 'Site https://example.com has already been assigned to a different organization.',
      });

      // Verify all checks were performed
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(baseURL);
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
      expect(existingSite.getOrganizationId).to.have.been.calledTwice;
      expect(organization.getId).to.have.been.calledOnce;
    });

    it('should return isValid true when site exists but is assigned to default organization', async () => {
      // Create mock existing site assigned to default organization
      const existingSite = {
        getOrganizationId: sinon.stub().returns('default-org-id'),
      };

      // Create mock organization
      const organization = {
        getId: sinon.stub().returns('test-org-id'),
      };

      // Setup mocks
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(organization);
      mockSharePointFolder.exists.resolves(false);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result
      expect(result).to.deep.equal({ isValid: true });

      // Verify all checks were performed
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(baseURL);
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
      expect(existingSite.getOrganizationId).to.have.been.calledTwice;
      expect(organization.getId).to.have.been.calledOnce;
    });

    it('should return isValid false when site exists but organization does not exist and site is not assigned to default organization', async () => {
      // Create mock existing site assigned to a non-default organization
      const existingSite = {
        getOrganizationId: sinon.stub().returns('some-other-org-id'),
      };

      // Setup mocks - site exists but organization does not exist
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockSharePointFolder.exists.resolves(false);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result
      expect(result).to.deep.equal({
        isValid: false,
        error: 'Site https://example.com has already been assigned to a different organization.',
      });

      // Verify all checks were performed
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(baseURL);
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
      expect(existingSite.getOrganizationId).to.have.been.calledOnce;
    });

    it('should return isValid false when error occurs during validation', async () => {
      // Setup mocks to throw an error
      const error = new Error('Database connection failed');
      mockDataAccess.Site.findByBaseURL.rejects(error);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result
      expect(result).to.deep.equal({
        isValid: false,
        error: 'Unable to validate onboarding status: Database connection failed',
      });

      // Verify error was logged
      expect(mockLog.error).to.have.been.calledWith(
        'Error validating site onboarding status: Database connection failed',
      );
    });
  });

  describe('createOrFindOrganization', () => {
    it('should return existing organization when found', async () => {
      const { createOrFindOrganization } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { LLMO: 'LLMO' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: sinon.stub(),
        },
      });

      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
      };

      const result = await createOrFindOrganization('ABC123@AdobeOrg', context);

      expect(result).to.equal(mockOrganization);
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');
      expect(mockLog.debug).to.have.been.calledWith('Found existing organization for IMS Org ID: ABC123@AdobeOrg');
    });
  });

  describe('createOrFindSite', () => {
    it('should update organization ID when existing site has different organization', async () => {
      const { createOrFindSite } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { LLMO: 'LLMO' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: sinon.stub(),
        },
      });

      const mockSite = {
        getOrganizationId: sinon.stub().returns('old-org-123'),
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);

      const context = {
        dataAccess: mockDataAccess,
      };

      const result = await createOrFindSite('https://example.com', 'new-org-456', context);

      expect(result).to.equal(mockSite);
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockSite.getOrganizationId).to.have.been.called;
      expect(mockSite.setOrganizationId).to.have.been.calledWith('new-org-456');
      expect(mockSite.save).to.have.been.called;
    });

    it('should not update organization ID when existing site has same organization', async () => {
      const { createOrFindSite } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { LLMO: 'LLMO' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: sinon.stub(),
        },
      });

      const mockSite = {
        getOrganizationId: sinon.stub().returns('org-123'),
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      mockDataAccess.Site.findByBaseURL.resolves(mockSite);

      const context = {
        dataAccess: mockDataAccess,
      };

      const result = await createOrFindSite('https://example.com', 'org-123', context);

      expect(result).to.equal(mockSite);
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockSite.getOrganizationId).to.have.been.called;
      expect(mockSite.setOrganizationId).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });
  });

  describe('performLlmoOnboarding', () => {
    it('should successfully perform complete LLMO onboarding process', async () => {
      // Mock organization
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null); // No existing site
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock Config.toDynamoItem
      const mockConfigToDynamoItem = sinon.stub().returns({ config: 'dynamo-item' });
      const mockConfig = {
        toDynamoItem: mockConfigToDynamoItem,
      };

      // Mock TierClient
      const mockTierClient = {
        createForSite: sinon.stub().returns({
          createEntitlement: sinon.stub().resolves({
            entitlement: {
              getId: sinon.stub().returns('entitlement123'),
            },
            siteEnrollment: {
              getId: sinon.stub().returns('enrollment123'),
            },
          }),
        }),
      };

      // Mock tracingFetch for publishToAdminHlx
      const mockTracingFetch = sinon.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      // Mock setTimeout to execute immediately (avoid 2 second delay)
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = sinon.stub().callsFake((fn) => {
        fn();
        return 1; // Return a fake timer ID
      });

      // Mock the Config import
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { LLMO: 'LLMO' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
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
                data: {
                  content: Buffer.from('test content').toString('base64'),
                  sha: 'test-sha-123',
                },
              }),
              createOrUpdateFileContents: sinon.stub().resolves(),
            },
          }),
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: mockConfig,
        },
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
          composeBaseURL: sinon.stub().callsFake((domain) => `https://${domain}`),
        },
      });

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      const result = await performLlmoOnboardingWithMocks(params, context);

      // Verify the result
      expect(result).to.deep.equal({
        siteId: 'site123',
        organizationId: 'org123',
        baseURL: 'https://example.com',
        dataFolder: 'dev/example-com',
        message: 'LLMO onboarding completed successfully',
      });

      // Verify organization was found/created
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify site was created
      expect(mockDataAccess.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        organizationId: 'org123',
      });

      // Verify site config was updated
      expect(mockSite.getConfig().updateLlmoBrand).to.have.been.calledWith('Test Brand');
      expect(mockSite.getConfig().updateLlmoDataFolder).to.have.been.calledWith('dev/example-com');

      // Verify site was saved
      expect(mockSite.setConfig).to.have.been.calledWith({ config: 'dynamo-item' });
      expect(mockSite.save).to.have.been.called;

      // Verify enableAudits was called
      expect(mockDataAccess.Configuration.findLatest).to.have.been.called;
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledWith('headings', mockSite);
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledWith('llm-blocked', mockSite);
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);
      expect(mockConfiguration.save).to.have.been.called;

      // Verify tracingFetch was called for publishing
      expect(mockTracingFetch).to.have.been.called;

      // Verify logging
      expect(mockLog.info).to.have.been.calledWith('Starting LLMO onboarding for IMS org ABC123@AdobeOrg, domain example.com, brand Test Brand');
      expect(mockLog.info).to.have.been.calledWith('Created site site123 for https://example.com');

      // Restore setTimeout
      global.setTimeout = originalSetTimeout;
    });

    it('should create new organization when organization does not exist', async () => {
      // Mock new organization
      const mockOrganization = {
        getId: sinon.stub().returns('new-org-123'),
        getImsOrgId: sinon.stub().returns('NEW123@AdobeOrg'),
      };

      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site456'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Setup mocks - organization does not exist
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.create = sinon.stub().resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock Config.toDynamoItem
      const mockConfig = {
        toDynamoItem: sinon.stub().returns({ config: 'dynamo-item' }),
      };

      // Mock TierClient
      const mockTierClient = {
        createForSite: sinon.stub().returns({
          createEntitlement: sinon.stub().resolves({
            entitlement: { getId: sinon.stub().returns('entitlement456') },
            siteEnrollment: { getId: sinon.stub().returns('enrollment456') },
          }),
        }),
      };

      // Mock tracingFetch for publishToAdminHlx
      const mockTracingFetch = sinon.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      // Mock setTimeout to execute immediately (avoid 2 second delay)
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = sinon.stub().callsFake((fn) => {
        fn();
        return 1; // Return a fake timer ID
      });

      // Mock the module
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { LLMO: 'LLMO' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
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
                data: {
                  content: Buffer.from('test content').toString('base64'),
                  sha: 'test-sha-456',
                },
              }),
              createOrUpdateFileContents: sinon.stub().resolves(),
            },
          }),
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: mockConfig,
        },
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
          composeBaseURL: sinon.stub().callsFake((domain) => `https://${domain}`),
        },
      });

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const params = {
        domain: 'newdomain.com',
        brandName: 'New Brand',
        imsOrgId: 'NEW123@AdobeOrg',
      };

      const result = await performLlmoOnboardingWithMocks(params, context);

      // Verify organization was created
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith('NEW123@AdobeOrg');
      expect(mockDataAccess.Organization.create).to.have.been.calledWith({
        name: 'Organization NEW123@AdobeOrg',
        imsOrgId: 'NEW123@AdobeOrg',
      });

      // Verify logging for organization creation
      expect(mockLog.info).to.have.been.calledWith('Creating new organization for IMS Org ID: NEW123@AdobeOrg');
      expect(mockLog.info).to.have.been.calledWith('Created organization new-org-123 for IMS Org ID: NEW123@AdobeOrg');

      // Verify result
      expect(result.organizationId).to.equal('new-org-123');
      expect(result.siteId).to.equal('site456');

      // Restore setTimeout
      global.setTimeout = originalSetTimeout;
    });

    it('should call cleanup functions when site.save() throws an error', async () => {
      // Mock organization
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      // Mock site that throws on save
      const mockSite = {
        getId: sinon.stub().returns('site789'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().rejects(new Error('Database save failed')),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null); // New site
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock Config.toDynamoItem
      const mockConfigToDynamoItem = sinon.stub().returns({ config: 'dynamo-item' });
      const mockConfig = {
        toDynamoItem: mockConfigToDynamoItem,
      };

      // Mock TierClient
      const mockTierClient = {
        createForSite: sinon.stub().returns({
          createEntitlement: sinon.stub().resolves({
            entitlement: {
              getId: sinon.stub().returns('entitlement789'),
            },
            siteEnrollment: {
              getId: sinon.stub().returns('enrollment789'),
            },
          }),
          revokeSiteEnrollment: sinon.stub().resolves(),
        }),
      };

      // Mock tracingFetch for unpublishFromAdminHlx (will be called twice in cleanup)
      const mockTracingFetch = sinon.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      // Mock setTimeout to execute immediately
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = sinon.stub().callsFake((fn) => {
        fn();
        return 1;
      });

      // Mock SharePoint folder operations
      const mockSharePointFolderLocal = {
        exists: sinon.stub().resolves(true),
        delete: sinon.stub().resolves(),
      };

      const mockSharePointClientLocal = {
        getDocument: sinon.stub().returns(mockSharePointFolderLocal),
      };

      // Mock the Config import
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
          Entitlement: {
            PRODUCT_CODES: { LLMO: 'LLMO' },
            TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
          },
        },
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClientLocal),
        },
        '@octokit/rest': {
          Octokit: sinon.stub().returns({
            repos: {
              getContent: sinon.stub().resolves({
                data: {
                  content: Buffer.from('test content').toString('base64'),
                  sha: 'test-sha-123',
                },
              }),
              createOrUpdateFileContents: sinon.stub().resolves(),
            },
          }),
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: mockConfig,
        },
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
          composeBaseURL: sinon.stub().callsFake((domain) => `https://${domain}`),
        },
      });

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      // Execute and expect error to be thrown
      try {
        await performLlmoOnboardingWithMocks(params, context);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Database save failed');
      }

      // Verify cleanup was attempted
      expect(mockLog.error).to.have.been.calledWith(sinon.match('Error during LLMO onboarding: Database save failed. Attempting cleanup.'));

      // Verify deleteSharePointFolder was called (which deletes folder and unpublishes)
      expect(mockSharePointFolderLocal.exists).to.have.been.called;
      expect(mockSharePointFolderLocal.delete).to.have.been.called;
      expect(mockTracingFetch).to.have.callCount(6);

      // Verify revokeEnrollment was called
      const tierClient = mockTierClient.createForSite.returnValues[0];
      expect(tierClient.revokeSiteEnrollment).to.have.been.called;

      // Restore setTimeout
      global.setTimeout = originalSetTimeout;
    });
  });

  describe('createEntitlementAndEnrollment', () => {
    it('should re-throw error when tierClient throws', async () => {
      const mockSite = {
        getId: sinon.stub().returns('site123'),
      };

      const tierError = new Error('Tier service unavailable');
      const mockTierClient = {
        createForSite: sinon.stub().rejects(tierError),
      };

      const {
        createEntitlementAndEnrollment: createEntitlementAndEnrollmentWithMocks,
      } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
        },
      });

      try {
        await createEntitlementAndEnrollmentWithMocks(mockSite, { log: mockLog });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Tier service unavailable');
      }
    });
  });

  describe('deleteSharePointFolder', () => {
    async function setupDeleteSharePointFolderTest(folderExists, deleteResult) {
      const mockFolder = {
        exists: sinon.stub().resolves(folderExists),
        delete: deleteResult instanceof Error
          ? sinon.stub().rejects(deleteResult)
          : sinon.stub().resolves(deleteResult),
      };

      const spClient = {
        getDocument: sinon.stub().returns(mockFolder),
      };

      // Mock tracingFetch for unpublishFromAdminHlx
      const mockTracingFetch = sinon.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      const {
        deleteSharePointFolder: deleteSharePointFolderWithMocks,
      } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(spClient),
        },
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
      });

      return {
        deleteSharePointFolderWithMocks, mockFolder, spClient, mockTracingFetch,
      };
    }

    it('should successfully delete a folder when it exists', async () => {
      const dataFolder = 'dev/test-com';
      const {
        deleteSharePointFolderWithMocks,
        mockFolder,
        spClient,
        mockTracingFetch,
      } = await setupDeleteSharePointFolderTest(true);

      await deleteSharePointFolderWithMocks(dataFolder, { log: mockLog, env: mockEnv });

      expect(spClient.getDocument)
        .to.have.been.calledWith('/sites/elmo-ui-data/dev/test-com/');
      expect(mockFolder.exists).to.have.been.called;
      expect(mockFolder.delete).to.have.been.called;

      // Verify unpublishFromAdminHlx was called (via tracingFetch)
      expect(mockTracingFetch).to.have.been.called;
    });

    it('should handle case when folder does not exist', async () => {
      const dataFolder = 'dev/nonexistent-com';
      const {
        deleteSharePointFolderWithMocks,
        mockFolder,
        mockTracingFetch,
      } = await setupDeleteSharePointFolderTest(false);

      await deleteSharePointFolderWithMocks(dataFolder, { log: mockLog, env: mockEnv });

      expect(mockFolder.exists).to.have.been.called;
      expect(mockFolder.delete).to.not.have.been.called;

      // Verify unpublishFromAdminHlx was still called even if folder doesn't exist
      expect(mockTracingFetch).to.have.been.called;
    });

    it('should handle errors when folder delete fails', async () => {
      const dataFolder = 'dev/error-com';
      const deleteError = new Error('Permission denied');
      const {
        deleteSharePointFolderWithMocks,
        mockFolder,
        mockTracingFetch,
      } = await setupDeleteSharePointFolderTest(true, deleteError);

      await deleteSharePointFolderWithMocks(dataFolder, { log: mockLog, env: mockEnv });

      expect(mockFolder.exists).to.have.been.called;
      expect(mockLog.error).to.have.been.calledWith(
        'Error deleting SharePoint folder dev/error-com: Permission denied',
      );

      // Verify unpublishFromAdminHlx was still called even after SharePoint error
      expect(mockTracingFetch).to.have.been.called;
    });
  });

  describe('revokeEnrollment', () => {
    it('should log error when tier client throws an error', async () => {
      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site123'),
      };

      // Mock TierClient that throws an error
      const mockTierClient = {
        createForSite: sinon.stub().rejects(new Error('Tier service unavailable')),
      };

      // Mock the module with failing TierClient
      const { revokeEnrollment: revokeEnrollmentWithMocks } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
        },
      });

      const context = {
        log: mockLog,
      };

      // Call revokeEnrollment - should not throw
      await revokeEnrollmentWithMocks(mockSite, context);

      // Verify error was logged
      expect(mockLog.error).to.have.been.calledWith('Error revoking LLMO enrollment for site site123: Tier service unavailable');

      // Verify info logs were still called
      expect(mockLog.info).to.have.been.calledWith('Revoking LLMO enrollment for site site123');

      // Verify the successful log was NOT called since it failed
      expect(mockLog.info).to.not.have.been.calledWith('Successfully revoked LLMO enrollment for site site123');
    });

    it('should log error when revokeSiteEnrollment throws an error', async () => {
      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site456'),
      };

      // Mock TierClient where revokeSiteEnrollment throws
      const mockTierClient = {
        createForSite: sinon.stub().resolves({
          revokeSiteEnrollment: sinon.stub().rejects(new Error('Enrollment not found')),
        }),
      };

      // Mock the module with failing revokeSiteEnrollment
      const { revokeEnrollment: revokeEnrollmentWithMocks } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
        },
      });

      const context = {
        log: mockLog,
      };

      // Call revokeEnrollment - should not throw
      await revokeEnrollmentWithMocks(mockSite, context);

      // Verify error was logged
      expect(mockLog.error).to.have.been.calledWith('Error revoking LLMO enrollment for site site456: Enrollment not found');

      // Verify the successful log was NOT called since it failed
      expect(mockLog.info).to.not.have.been.calledWith('Successfully revoked LLMO enrollment for site site456');
    });
  });

  describe('performLlmoOffboarding', () => {
    it('should successfully offboard a site (happy path)', async () => {
      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site789'),
        getBaseURL: sinon.stub().returns('https://offboard.com'),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock config with LLMO config
      const mockConfig = {
        getLlmoConfig: sinon.stub().returns({
          dataFolder: 'dev/offboard-com',
          brand: 'Test Brand',
        }),
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
      };

      // Mock TierClient for revoke enrollment
      const mockTierClient = {
        createForSite: sinon.stub().resolves({
          revokeSiteEnrollment: sinon.stub().resolves(),
        }),
      };

      // Mock Config.toDynamoItem
      const mockConfigClass = {
        toDynamoItem: sinon.stub().returns({ config: 'dynamo-item' }),
      };

      // Mock tracingFetch for unpublishFromAdminHlx
      const mockTracingFetch = sinon.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      // Mock composeBaseURL
      const mockComposeBaseURL = sinon.stub().callsFake((url) => url);

      // Mock the module with all dependencies
      const { performLlmoOffboarding } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(true),
              delete: sinon.stub().resolves(),
            }),
          }),
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: mockConfigClass,
        },
        '@adobe/spacecat-shared-utils': {
          composeBaseURL: mockComposeBaseURL,
          tracingFetch: mockTracingFetch,
        },
      });

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const result = await performLlmoOffboarding(mockSite, mockConfig, context);

      // Verify the result
      expect(result).to.deep.equal({
        siteId: 'site789',
        baseURL: 'https://offboard.com',
        dataFolder: 'dev/offboard-com',
        message: 'LLMO offboarding completed successfully',
      });

      // Verify LLMO config was retrieved
      expect(mockConfig.getLlmoConfig).to.have.been.called;

      // Verify LLMO config was removed
      expect(mockConfig.updateLlmoBrand).to.have.been.calledWith(null);
      expect(mockConfig.updateLlmoDataFolder).to.have.been.calledWith(null);
      expect(mockSite.setConfig).to.have.been.calledWith({ config: 'dynamo-item' });
      expect(mockSite.save).to.have.been.called;

      // Verify TierClient was called to revoke enrollment
      expect(mockTierClient.createForSite).to.have.been.called;

      // Verify tracingFetch was called to unpublish from admin.hlx.page (2 times: live and preview)
      expect(mockTracingFetch).to.have.been.calledTwice;

      // Verify logging
      expect(mockLog.info).to.have.been.calledWith('Starting LLMO offboarding process for site: site789');
      expect(mockLog.info).to.have.been.calledWith('Offboarding site site789 with domain https://offboard.com and data folder dev/offboard-com');
      expect(mockLog.info).to.have.been.calledWith('LLMO offboarding process completed for site site789');

      // Verify no errors were logged (fetch should have succeeded)
      expect(mockLog.error.called).to.be.false;
    });

    it('should successfully offboard a site when dataFolder is not set (recalculated)', async () => {
      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site999'),
        getBaseURL: sinon.stub().returns('https://recalc-test.com'),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock config with LLMO config that has NO dataFolder set
      const mockConfig = {
        getLlmoConfig: sinon.stub().returns({
          brand: 'Test Brand',
          // dataFolder is intentionally missing
        }),
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
      };

      // Mock TierClient for revoke enrollment
      const mockTierClient = {
        createForSite: sinon.stub().resolves({
          revokeSiteEnrollment: sinon.stub().resolves(),
        }),
      };

      // Mock Config.toDynamoItem
      const mockConfigClass = {
        toDynamoItem: sinon.stub().returns({ config: 'dynamo-item' }),
      };

      // Mock tracingFetch for unpublishFromAdminHlx
      const mockTracingFetch = sinon.stub().resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      // Mock composeBaseURL
      const mockComposeBaseURL = sinon.stub().callsFake((url) => url);

      // Mock the module with all dependencies
      const { performLlmoOffboarding } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-tier-client': {
          default: mockTierClient,
        },
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves({
            getDocument: sinon.stub().returns({
              exists: sinon.stub().resolves(true),
              delete: sinon.stub().resolves(),
            }),
          }),
        },
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: mockConfigClass,
        },
        '@adobe/spacecat-shared-utils': {
          composeBaseURL: mockComposeBaseURL,
          tracingFetch: mockTracingFetch,
        },
      });

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const result = await performLlmoOffboarding(mockSite, mockConfig, context);

      // Verify the result - dataFolder should be recalculated
      expect(result).to.deep.equal({
        siteId: 'site999',
        baseURL: 'https://recalc-test.com',
        dataFolder: 'dev/recalc-test-com', // Recalculated from base URL
        message: 'LLMO offboarding completed successfully',
      });

      // Verify LLMO config was retrieved
      expect(mockConfig.getLlmoConfig).to.have.been.called;

      // Verify debug log for recalculation
      expect(mockLog.debug).to.have.been.calledWith('Data folder not found in LLMO config, calculating from base URL: https://recalc-test.com');

      // Verify LLMO config was removed
      expect(mockConfig.updateLlmoBrand).to.have.been.calledWith(null);
      expect(mockConfig.updateLlmoDataFolder).to.have.been.calledWith(null);
      expect(mockSite.setConfig).to.have.been.calledWith({ config: 'dynamo-item' });
      expect(mockSite.save).to.have.been.called;

      // Verify TierClient was called to revoke enrollment
      expect(mockTierClient.createForSite).to.have.been.called;

      // Verify tracingFetch was called to unpublish from admin.hlx.page (2 times: live and preview)
      expect(mockTracingFetch).to.have.been.calledTwice;

      // Verify logging
      expect(mockLog.info).to.have.been.calledWith('Starting LLMO offboarding process for site: site999');
      expect(mockLog.info).to.have.been.calledWith('Offboarding site site999 with domain https://recalc-test.com and data folder dev/recalc-test-com');
      expect(mockLog.info).to.have.been.calledWith('LLMO offboarding process completed for site site999');

      // Verify no errors were logged (fetch should have succeeded)
      expect(mockLog.error.called).to.be.false;
    });

    it('should handle non-ok response when unpublishing from admin.hlx.page', async () => {
      // Mock tracingFetch to return non-ok response
      const mockTracingFetch = sinon.stub().resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Mock the module with tracingFetch
      const { unpublishFromAdminHlx } = await esmock('../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
      });

      // Call unpublishFromAdminHlx directly
      await unpublishFromAdminHlx('query-index', 'dev/offboard-com', mockLog);

      // Verify that error was logged for unpublish failure
      expect(mockLog.error).to.have.been.calledWith(sinon.match('Failed to unpublish via admin.hlx.page: live unpublish failed: 500 Internal Server Error'));

      // Verify tracingFetch was called (attempted to unpublish)
      expect(mockTracingFetch).to.have.been.called;
    });
  });
});
