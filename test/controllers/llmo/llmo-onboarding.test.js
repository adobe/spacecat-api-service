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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import { testDetermineOverrideBaseURL } from './test-helpers.js';

use(sinonChai);

describe('LLMO Onboarding Functions', () => {
  let mockDataAccess;
  let mockLog;
  let mockEnv;
  let mockSharePointClient;
  let mockSharePointFolder;
  let originalSetTimeout;

  function restoreSetTimeout(original) {
    global.setTimeout = original;
  }

  beforeEach(() => {
    originalSetTimeout = null;
    // Create mock data access
    mockDataAccess = {
      Site: {
        findByBaseURL: sinon.stub(),
        create: sinon.stub(),
        // Default: no pre-cutoff sites → mode resolution returns v2 (the default).
        // Tests that need v1 mode should set LLMO_ONBOARDING_DEFAULT_VERSION='v1'
        // in context.env to use the global kill switch.
        allByOrganizationId: sinon.stub().resolves([]),
      },
      Organization: {
        findByImsOrgId: sinon.stub(),
        findById: sinon.stub(),
      },
      Configuration: {
        findLatest: sinon.stub(),
      },
      services: {
        postgrestClient: {
          from: sinon.stub(),
        },
      },
    };

    // Default feature_flags stub so all v2-path tests get a working postgrestClient.
    // Individual tests can override with .withArgs('feature_flags') for specific assertions.
    const defaultUpsertSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
    const defaultUpsertSelect = sinon.stub().returns({ single: defaultUpsertSingle });
    const defaultUpsert = sinon.stub().returns({ select: defaultUpsertSelect });
    const defaultMaybeSingle = sinon.stub().resolves({ data: null, error: null });
    const defaultEq3 = sinon.stub().returns({ maybeSingle: defaultMaybeSingle });
    const defaultEq2 = sinon.stub().returns({ eq: defaultEq3 });
    const defaultEq1 = sinon.stub().returns({ eq: defaultEq2 });
    const defaultSelect = sinon.stub().returns({ eq: defaultEq1 });
    mockDataAccess.services.postgrestClient.from.withArgs('feature_flags').returns({
      select: defaultSelect,
      upsert: defaultUpsert,
    });

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
      HLX_ONBOARDING_TOKEN: 'test-onboarding-token',
      LLMO_ONBOARDING_DEFAULT_VERSION: 'v2',
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

  afterEach(() => {
    if (originalSetTimeout) {
      restoreSetTimeout(originalSetTimeout);
      originalSetTimeout = null;
    }
  });

  // Helper functions for common mock setups
  const createMockTierClient = (sandbox = sinon) => ({
    createForSite: sandbox.stub().returns({
      createEntitlement: sandbox.stub().resolves({
        entitlement: {
          getId: sandbox.stub().returns('entitlement123'),
        },
        siteEnrollment: {
          getId: sandbox.stub().returns('enrollment123'),
        },
      }),
      revokeSiteEnrollment: sandbox.stub().resolves(),
    }),
  });

  const createMockTracingFetch = (sandbox = sinon, options = {}) => {
    const { ok = true, status = 200, statusText = 'OK' } = options;
    return sandbox.stub().resolves({ ok, status, statusText });
  };

  const mockSetTimeoutImmediate = (sandbox = sinon) => {
    const original = global.setTimeout;
    global.setTimeout = sandbox.stub().callsFake((fn) => {
      fn();
      return 1;
    });
    return original;
  };

  const createMockConfig = (sandbox = sinon) => ({
    toDynamoItem: sandbox.stub().returns({ config: 'dynamo-item' }),
  });

  const createMockComposeBaseURL = (sandbox = sinon) => sandbox.stub().callsFake((domain) => `https://${domain}`);

  const createMockSharePointClient = (sandbox = sinon, options = {}) => {
    const {
      folderExists = false,
      deleteResolves = true,
    } = options;

    const mockFolder = {
      exists: sandbox.stub().resolves(folderExists),
      createFolder: sandbox.stub().resolves(),
      copy: sandbox.stub().resolves(),
      delete: deleteResolves ? sandbox.stub().resolves() : sandbox.stub().rejects(new Error('Delete failed')),
    };

    return {
      mockClient: {
        getDocument: sandbox.stub().returns(mockFolder),
      },
      mockFolder,
    };
  };

  const createMockOctokit = (sandbox = sinon, options = {}) => {
    const { content = 'test content', sha = 'test-sha-123' } = options;

    return sandbox.stub().returns({
      repos: {
        getContent: sandbox.stub().resolves({
          data: {
            content: Buffer.from(content).toString('base64'),
            sha,
          },
        }),
        createOrUpdateFileContents: sandbox.stub().resolves(),
      },
    });
  };

  const createMockDrsClient = (sandbox = sinon, options = {}) => {
    const {
      isConfigured = true,
      submitJob = sandbox.stub().resolves({ job_id: 'test-brandalf-job-123' }),
      submitPromptGenerationJob = sandbox.stub().resolves({ job_id: 'test-drs-job-123' }),
    } = options;

    const instance = {
      isConfigured: sandbox.stub().returns(isConfigured),
      submitJob,
      submitPromptGenerationJob,
    };

    return {
      createFrom: sandbox.stub().returns(instance),
    };
  };

  const createMockCustomerConfigV2Storage = (sandbox = sinon, options = {}) => ({
    readCustomerConfigV2FromPostgres: options.readCustomerConfigV2FromPostgres
      || sandbox.stub().resolves(null),
    writeCustomerConfigV2ToPostgres: options.writeCustomerConfigV2ToPostgres
      || sandbox.stub().resolves(),
  });

  const createCommonEsmockDependencies = (options = {}) => {
    const {
      mockTierClient,
      mockTracingFetch,
      mockConfig,
      mockComposeBaseURL,
      mockSharePointClient: sharePointClient,
      mockOctokit,
      mockDrsClient,
      mockCustomerConfigV2Storage,
    } = options;
    const effectiveCustomerConfigV2Storage = mockCustomerConfigV2Storage
      || createMockCustomerConfigV2Storage();

    const deps = {
      '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
        Entitlement: {
          PRODUCT_CODES: { LLMO: 'LLMO' },
          TIERS: { FREE_TRIAL: 'FREE_TRIAL' },
        },
      },
    };

    if (mockTierClient) {
      deps['@adobe/spacecat-shared-tier-client'] = { default: mockTierClient };
    }

    if (sharePointClient) {
      deps['@adobe/spacecat-helix-content-sdk'] = { createFrom: sinon.stub().resolves(sharePointClient) };
    }

    if (mockOctokit) {
      deps['@octokit/rest'] = { Octokit: mockOctokit };
    }

    if (mockConfig) {
      deps['@adobe/spacecat-shared-data-access/src/models/site/config.js'] = { Config: mockConfig };
    }

    if (mockTracingFetch || mockComposeBaseURL) {
      deps['@adobe/spacecat-shared-utils'] = {};
      if (mockTracingFetch) {
        deps['@adobe/spacecat-shared-utils'].tracingFetch = mockTracingFetch;
      }
      if (mockComposeBaseURL) {
        deps['@adobe/spacecat-shared-utils'].composeBaseURL = mockComposeBaseURL;
      }
    }

    if (mockDrsClient) {
      deps['@adobe/spacecat-shared-drs-client'] = { default: mockDrsClient };
    }

    deps['../../../src/support/customer-config-v2-storage.js'] = effectiveCustomerConfigV2Storage;
    deps['../../../src/support/brands-storage.js'] = {
      upsertBrand: options.mockUpsertBrand || sinon.stub().resolves({ id: 'brand-123', name: 'Test Brand' }),
    };

    deps['../../../src/support/cdn-detection.js'] = {
      detectCdnForDomain: options.mockDetectCdnForDomain || sinon.stub().resolves(null),
    };

    return deps;
  };

  /**
   * Sets up and returns a mocked performLlmoOffboarding function for testing.
   * @param {Object} options - Mock options
   * @param {Object} options.mockTierClient - Mock TierClient instance
   * @param {Function} options.mockTracingFetch - Mock tracingFetch function
   * @param {Object} options.mockConfig - Mock Config class with toDynamoItem
   * @param {Function} options.mockComposeBaseURL - Mock composeBaseURL function
   * @param {Object} options.mockSharePointClient - Mock SharePoint client
   * @returns {Promise<Object>} Mocked module with performLlmoOffboarding
   */
  const setupPerformLlmoOffboardingTest = async (options = {}) => {
    const {
      mockTierClient,
      mockTracingFetch,
      mockConfig,
      mockComposeBaseURL,
      mockSharePointClient: sharePointClient,
    } = options;

    return esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
      '@adobe/spacecat-shared-tier-client': {
        default: mockTierClient,
      },
      '@adobe/spacecat-helix-content-sdk': {
        createFrom: sharePointClient,
      },
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: mockConfig,
      },
      '@adobe/spacecat-shared-utils': {
        composeBaseURL: mockComposeBaseURL,
        tracingFetch: mockTracingFetch,
      },
    });
  };

  describe('generateDataFolder', () => {
    it('should generate correct data folder name for production environment', async () => {
      // Import the function
      const { generateDataFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});

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
      const { generateDataFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});

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
      const { generateDataFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});

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
      const { generateDataFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});

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
      const { generateDataFolder } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});

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
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      mockDataAccess.Organization.findById.resolves(null);
      mockSharePointFolder.exists.resolves(true);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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

      // Verify site lookup was called for Slack notification enrichment
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(baseURL);
      // Organization.findByImsOrgId is still not called (early return before that logic)
      expect(mockDataAccess.Organization.findByImsOrgId).to.not.have.been.called;
    });

    it('should return isValid false when site is mission critical for ASO', async () => {
      // Use a hardcoded critical site ID to test the validation logic
      const criticalSiteId = 'mission-critical-site-123';

      // Create mock existing site with a critical site ID
      const existingSite = {
        getId: sinon.stub().returns(criticalSiteId),
        getOrganizationId: sinon.stub().returns('some-org-id'),
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
      const { validateSiteNotOnboarded, ASO_CRITICAL_SITES } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      // Temporarily add the critical site ID to the array after import
      const originalLength = ASO_CRITICAL_SITES.length;
      ASO_CRITICAL_SITES.push(criticalSiteId);

      try {
        // Test parameters
        const baseURL = 'https://critical-site.com';
        const imsOrgId = 'test-tenant-id@AdobeOrg';
        const dataFolder = 'dev/critical-site-com';

        // Call the function
        const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

        // Verify result
        expect(result).to.deep.equal({
          isValid: false,
          error: 'Site https://critical-site.com is mission critical for ASO.',
        });

        // Verify checks were performed
        expect(mockDataAccess.Site.findByBaseURL).to.have.been.calledWith(baseURL);
        expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith(imsOrgId);
        expect(existingSite.getId).to.have.been.called;
        // The check happens early, so organization.getId and existingSite.getOrganizationId
        // should NOT be called (we return before those comparisons)
        expect(organization.getId).to.not.have.been.called;
        expect(existingSite.getOrganizationId).to.not.have.been.called;
      } finally {
        // Restore the original ASO_CRITICAL_SITES array
        ASO_CRITICAL_SITES.length = originalLength;
      }
    });

    it('should return isValid false when site exists and is assigned to different organization', async () => {
      // Create mock existing site assigned to different organization
      const existingSite = {
        getId: sinon.stub().returns('site-123'),
        getOrganizationId: sinon.stub().returns('different-org-id'),
      };

      // Create mock organization
      const organization = {
        getId: sinon.stub().returns('test-org-id'),
      };

      // Create mock current organization (for Slack notification)
      const mockCurrentOrg = {
        getImsOrgId: sinon.stub().returns('current-ims-org@AdobeOrg'),
      };

      // Setup mocks
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(organization);
      mockDataAccess.Organization.findById.resolves(mockCurrentOrg);
      mockSharePointFolder.exists.resolves(false);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      // Called 5 times now (3 for logic + 2 for Slack message enrichment)
      expect(existingSite.getOrganizationId).to.have.callCount(5);
      // Called 2 times now (1 for logic + 1 for Slack message)
      expect(organization.getId).to.have.callCount(2);
    });

    it('should return isValid true when site exists but is assigned to default organization', async () => {
      // Create mock existing site assigned to default organization
      const existingSite = {
        getId: sinon.stub().returns('site-123'),
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
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
        getId: sinon.stub().returns('site-123'),
        getOrganizationId: sinon.stub().returns('some-other-org-id'),
      };

      // Create mock current organization (for Slack notification)
      const mockCurrentOrg = {
        getImsOrgId: sinon.stub().returns('current-ims-org@AdobeOrg'),
      };

      // Setup mocks - site exists but organization does not exist
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.findById.resolves(mockCurrentOrg);
      mockSharePointFolder.exists.resolves(false);

      // Create context
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      // Called 4 times now (2 for logic + 2 for Slack message enrichment)
      expect(existingSite.getOrganizationId).to.have.callCount(4);
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
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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

    it('should handle notification enrichment when folder exists and site exists', async () => {
      // Create mock existing site
      const existingSite = {
        getId: sinon.stub().returns('site-123'),
        getOrganizationId: sinon.stub().returns('existing-org-id'),
      };

      // Create mock organization
      const mockOrg = {
        getImsOrgId: sinon.stub().returns('existing-ims-org@AdobeOrg'),
      };

      // Setup mocks - folder exists, site exists
      mockSharePointFolder.exists.resolves(true);
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findById.resolves(mockOrg);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      const result = await validateSiteNotOnboarded('https://example.com', 'test-ims@AdobeOrg', 'dev/example-com', context);

      expect(result.isValid).to.be.false;
      expect(mockDataAccess.Site.findByBaseURL).to.have.been.called;
      expect(mockDataAccess.Organization.findById).to.have.been.calledWith('existing-org-id');
    });

    it('should handle error during notification enrichment gracefully', async () => {
      // Setup mocks - folder exists, but Site.findByBaseURL throws during enrichment
      mockSharePointFolder.exists.resolves(true);
      mockDataAccess.Site.findByBaseURL.rejects(new Error('DB lookup failed'));

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      const result = await validateSiteNotOnboarded('https://example.com', 'test-ims@AdobeOrg', 'dev/example-com', context);

      // Should still return invalid (main logic succeeds, only notification enrichment fails)
      expect(result.isValid).to.be.false;
      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Could not fetch IMS Org ID for site/));
    });

    it('should handle error when fetching organization for notification', async () => {
      // Create mock existing site
      const existingSite = {
        getId: sinon.stub().returns('site-123'),
        getOrganizationId: sinon.stub().returns('different-org-id'),
      };

      // Create mock organization
      const organization = {
        getId: sinon.stub().returns('test-org-id'),
      };

      // Setup mocks - Organization.findById throws error during notification enrichment
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(organization);
      mockDataAccess.Organization.findById.rejects(new Error('Org lookup failed'));
      mockSharePointFolder.exists.resolves(false);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      const result = await validateSiteNotOnboarded('https://example.com', 'test-ims@AdobeOrg', 'dev/example-com', context);

      // Should still return invalid (main logic succeeds, only notification enrichment fails)
      expect(result.isValid).to.be.false;
      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Could not fetch IMS Org ID for notification/));
    });

    it('should handle case when organization is not found during notification enrichment', async () => {
      // Create mock existing site
      const existingSite = {
        getId: sinon.stub().returns('site-123'),
        getOrganizationId: sinon.stub().returns('different-org-id'),
      };

      // Create mock organization
      const organization = {
        getId: sinon.stub().returns('test-org-id'),
      };

      // Setup mocks - Organization.findById returns null (org not found)
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(organization);
      mockDataAccess.Organization.findById.resolves(null);
      mockSharePointFolder.exists.resolves(false);

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
      };

      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
      });

      const result = await validateSiteNotOnboarded('https://example.com', 'test-ims@AdobeOrg', 'dev/example-com', context);

      // Should still return invalid (returns 'Unknown' for IMS Org ID)
      expect(result.isValid).to.be.false;
      expect(mockDataAccess.Organization.findById).to.have.been.called;
    });

    it('should send Slack alert when SharePoint folder already exists', async () => {
      // Mock postSlackMessage
      const mockPostSlackMessage = sinon.stub().resolves({ channel: 'test-channel', ts: '123456' });

      // Setup mocks for existing folder
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.findById.resolves(null);
      mockSharePointFolder.exists.resolves(true);

      // Create context with Slack credentials
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_LLMO_ALERTS_CHANNEL_ID: 'test-alert-channel',
          SLACK_BOT_TOKEN: 'test-bot-token',
        },
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
        '../../../src/utils/slack/base.js': {
          postSlackMessage: mockPostSlackMessage,
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

      // Verify Slack message was sent
      expect(mockPostSlackMessage).to.have.been.calledOnce;
      expect(mockPostSlackMessage).to.have.been.calledWith(
        'test-alert-channel',
        sinon.match(/Site is already onboarded.*Data folder already exists/),
        'test-bot-token',
      );
    });

    it('should send Slack alert when site is assigned to different organization', async () => {
      // Mock postSlackMessage
      const mockPostSlackMessage = sinon.stub().resolves({ channel: 'test-channel', ts: '123456' });

      // Create mock existing site assigned to different organization
      const existingSite = {
        getId: sinon.stub().returns('site-123'),
        getOrganizationId: sinon.stub().returns('different-org-id'),
      };

      // Create mock organization
      const organization = {
        getId: sinon.stub().returns('test-org-id'),
      };

      // Create mock current organization (for Slack notification)
      const mockCurrentOrg = {
        getImsOrgId: sinon.stub().returns('current-ims-org@AdobeOrg'),
      };

      // Setup mocks
      mockDataAccess.Site.findByBaseURL.resolves(existingSite);
      mockDataAccess.Organization.findByImsOrgId.resolves(organization);
      mockDataAccess.Organization.findById.resolves(mockCurrentOrg);
      mockSharePointFolder.exists.resolves(false);

      // Create context with Slack credentials
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_LLMO_ALERTS_CHANNEL_ID: 'test-alert-channel',
          SLACK_BOT_TOKEN: 'test-bot-token',
        },
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
        '../../../src/utils/slack/base.js': {
          postSlackMessage: mockPostSlackMessage,
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

      // Verify Slack message was sent
      expect(mockPostSlackMessage).to.have.been.calledOnce;
      expect(mockPostSlackMessage).to.have.been.calledWith(
        'test-alert-channel',
        sinon.match(/Site is already onboarded.*Assigned to a different organization/),
        'test-bot-token',
      );
    });

    it('should not send Slack alert when SLACK_LLMO_ALERTS_CHANNEL_ID is missing', async () => {
      // Mock postSlackMessage
      const mockPostSlackMessage = sinon.stub().resolves({ channel: 'test-channel', ts: '123456' });

      // Setup mocks for existing folder
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.findById.resolves(null);
      mockSharePointFolder.exists.resolves(true);

      // Create context WITHOUT Slack channel ID
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_BOT_TOKEN: 'test-bot-token',
        },
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
        '../../../src/utils/slack/base.js': {
          postSlackMessage: mockPostSlackMessage,
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

      // Verify Slack message was NOT sent
      expect(mockPostSlackMessage).to.not.have.been.called;
    });

    it('should not send Slack alert when SLACK_BOT_TOKEN is missing', async () => {
      // Mock postSlackMessage
      const mockPostSlackMessage = sinon.stub().resolves({ channel: 'test-channel', ts: '123456' });

      // Setup mocks for existing folder
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.findById.resolves(null);
      mockSharePointFolder.exists.resolves(true);

      // Create context WITHOUT Slack bot token
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_LLMO_ALERTS_CHANNEL_ID: 'test-alert-channel',
        },
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
        '../../../src/utils/slack/base.js': {
          postSlackMessage: mockPostSlackMessage,
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

      // Verify Slack message was NOT sent
      expect(mockPostSlackMessage).to.not.have.been.called;
    });

    it('should continue execution even when Slack posting fails', async () => {
      // Mock postSlackMessage to throw an error
      const mockPostSlackMessage = sinon.stub().rejects(new Error('Slack API error'));

      // Setup mocks for existing folder
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.findById.resolves(null);
      mockSharePointFolder.exists.resolves(true);

      // Create context with Slack credentials
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          SLACK_LLMO_ALERTS_CHANNEL_ID: 'test-alert-channel',
          SLACK_BOT_TOKEN: 'test-bot-token',
        },
      };

      // Import the function with mocked dependencies
      const { validateSiteNotOnboarded } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-helix-content-sdk': {
          createFrom: sinon.stub().resolves(mockSharePointClient),
        },
        '../../../src/utils/slack/base.js': {
          postSlackMessage: mockPostSlackMessage,
        },
      });

      // Test parameters
      const baseURL = 'https://example.com';
      const imsOrgId = 'test-tenant-id@AdobeOrg';
      const dataFolder = 'dev/example-com';

      // Call the function
      const result = await validateSiteNotOnboarded(baseURL, imsOrgId, dataFolder, context);

      // Verify result - validation error should still be returned
      expect(result).to.deep.equal({
        isValid: false,
        error: 'Data folder for site https://example.com already exists. The site is already onboarded.',
      });

      // Verify Slack posting was attempted
      expect(mockPostSlackMessage).to.have.been.calledOnce;

      // Verify error was logged
      expect(mockLog.error).to.have.been.calledWith(
        'Failed to post LLMO alert to Slack: Slack API error',
      );
    });
  });

  describe('createOrFindOrganization', () => {
    it('should return existing organization when found', async () => {
      const { createOrFindOrganization } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      const { createOrFindSite } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      // LLMO-4176: re-parent must be persisted before resolveLlmoOnboardingMode
      // queries Site.allByOrganizationId, otherwise a legacy site moved into a
      // brand-new org would be misclassified as v2.
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should not update organization ID when existing site has same organization', async () => {
      const { createOrFindSite } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns({
            main_profile: { target_audience: 'Tech-savvy professionals' },
          }),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null); // No existing site
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Stub postgrestClient for feature flag read (resolveLlmoOnboardingMode)
      // and upsert (enabling brandalf during v2 onboarding)
      const maybeSingle = sinon.stub().resolves({ data: null, error: null });
      const eqFlag = sinon.stub().returns({ maybeSingle });
      const eqProduct = sinon.stub().returns({ eq: eqFlag });
      const eqOrg = sinon.stub().returns({ eq: eqProduct });
      const selectRead = sinon.stub().returns({ eq: eqOrg });
      const upsertSingle = sinon.stub().resolves({
        data: {
          organization_id: 'org123', product: 'LLMO', flag_name: 'brandalf', flag_value: true,
        },
        error: null,
      });
      const upsertSelect = sinon.stub().returns({ single: upsertSingle });
      const upsertStub = sinon.stub().returns({ select: upsertSelect });
      mockDataAccess.services.postgrestClient.from.withArgs('feature_flags').returns({
        select: selectRead,
        upsert: upsertStub,
      });

      // Use helper functions for common mocks
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();
      const mockUpsertBrand = sinon.stub().resolves({ id: 'brand-123', name: 'Test Brand' });

      // Mock the Config import
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
          mockUpsertBrand,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      const result = await performLlmoOnboardingWithMocks(params, context);

      expect(mockDrsClient.createFrom().submitJob).to.have.been.calledWith(
        sinon.match({
          provider_id: 'single_shot_prompt',
          priority: 'HIGH',
          source: 'onboarding',
          parameters: {
            prompt_type: 'brandalf',
            name: 'Test Brand',
            company_website: 'https://example.com',
            metadata: {
              imsOrgId: 'ABC123@AdobeOrg',
              brand: 'Test Brand',
              site: 'example.com',
              site_id: 'site123',
              spaceCatId: 'org123',
              company_website: 'https://example.com',
              onboarding_mode: 'v2',
            },
          },
        }),
      );

      // Verify prompt generation is NOT submitted during onboarding (deferred to DRS post-Brandalf)
      expect(mockDrsClient.createFrom().submitJob.secondCall).to.be.null;

      // Verify the result contains expected fields
      expect(result.siteId).to.equal('site123');
      expect(result.organizationId).to.equal('org123');
      expect(result.baseURL).to.equal('https://example.com');
      expect(result.dataFolder).to.equal('dev/example-com');
      expect(result.message).to.equal('LLMO onboarding completed successfully');
      expect(result.site).to.exist;

      // Verify organization was found/created
      expect(mockDataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');

      // Verify site was created
      expect(mockDataAccess.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        organizationId: 'org123',
      });

      // LLMO-4176 regression guard: resolveLlmoOnboardingMode reads
      // Site.allByOrganizationId, and that read MUST happen after the site
      // has been created/re-parented — otherwise a legacy site moved into a
      // brand-new org gets misclassified as v2.
      expect(mockDataAccess.Site.allByOrganizationId)
        .to.have.been.calledAfter(mockDataAccess.Site.findByBaseURL);

      // Verify site config was updated
      expect(mockSite.getConfig().updateLlmoBrand).to.have.been.calledWith('Test Brand');
      expect(mockSite.getConfig().updateLlmoDataFolder).to.have.been.calledWith('dev/example-com');

      // Verify site was saved
      expect(mockSite.setConfig).to.have.been.calledWith({ config: 'dynamo-item' });
      expect(mockSite.save).to.have.been.called;
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres).to.have.been.calledOnce;

      const writtenConfig = mockCustomerConfigV2Storage
        .writeCustomerConfigV2ToPostgres.firstCall.args[1];
      expect(writtenConfig.customer.customerName).to.equal('Test Brand');
      expect(writtenConfig.customer.brands[0].v1SiteId).to.equal('site123');
      expect(writtenConfig.customer.brands[0].baseUrl).to.equal('https://example.com');

      // Verify brandalf feature flag was enabled during v2 onboarding
      expect(upsertStub).to.have.been.calledOnce;
      expect(upsertStub.firstCall.args[0]).to.deep.include({
        organization_id: 'org123',
        product: 'LLMO',
        flag_name: 'brandalf',
        flag_value: true,
        updated_by: 'llmo-onboarding',
      });
      expect(mockLog.info).to.have.been.calledWith('Enabled brandalf feature flag for organization org123');

      // Verify initial brand was written to normalized brands table with correct args
      expect(mockUpsertBrand).to.have.been.calledOnce;
      expect(mockUpsertBrand.firstCall.args[0]).to.deep.include({
        organizationId: 'org123',
        updatedBy: 'llmo-onboarding',
      });
      expect(mockUpsertBrand.firstCall.args[0].brand).to.deep.include({
        name: 'Test Brand',
        status: 'active',
      });
      // Must use baseURL (matches sites.base_url), not overrideBaseURL
      expect(mockUpsertBrand.firstCall.args[0].brand.urls).to.deep.equal([
        { value: 'https://example.com', type: 'base' },
      ]);
      expect(mockLog.info).to.have.been.calledWith('Created initial brand "Test Brand" in normalized table for site site123');

      // Verify enableAudits was called
      expect(mockDataAccess.Configuration.findLatest).to.have.been.called;
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledWith('headings', mockSite);
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledWith('llm-blocked', mockSite);
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);
      expect(mockConfiguration.save).to.have.been.called;

      // Verify async publish trigger is enqueued
      expect(context.sqs.sendMessage).to.have.been.calledWith(
        'audit-queue',
        sinon.match({
          type: 'trigger:llmo-onboarding-publish',
          siteId: 'site123',
          auditContext: sinon.match({
            dataFolder: 'dev/example-com',
          }),
        }),
      );
      expect(context.sqs.sendMessage).to.have.been.calledWith(
        'audit-queue',
        sinon.match({ type: 'wikipedia-analysis' }),
      );

      // Verify logging
      expect(mockLog.info).to.have.been.calledWith('Starting LLMO onboarding for IMS org ABC123@AdobeOrg, baseURL https://example.com, brand Test Brand');
      expect(mockLog.info).to.have.been.calledWith('Created site site123 for https://example.com using LLMO onboarding mode v2');
    });

    it('should continue onboarding when upsertBrand fails', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns(null),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Feature flag postgrest mock
      const maybeSingle = sinon.stub().resolves({ data: null, error: null });
      const eqFlag = sinon.stub().returns({ maybeSingle });
      const eqProduct = sinon.stub().returns({ eq: eqFlag });
      const eqOrg = sinon.stub().returns({ eq: eqProduct });
      const selectRead = sinon.stub().returns({ eq: eqOrg });
      const upsertSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const upsertSelect = sinon.stub().returns({ single: upsertSingle });
      const upsertStub = sinon.stub().returns({ select: upsertSelect });
      mockDataAccess.services.postgrestClient.from.withArgs('feature_flags').returns({
        select: selectRead,
        upsert: upsertStub,
      });

      // upsertBrand throws — should not block onboarding
      const failingUpsertBrand = sinon.stub().rejects(new Error('PostgREST unavailable'));
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: onboardWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
          mockUpsertBrand: failingUpsertBrand,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      const result = await onboardWithMocks(
        {
          domain: 'example.com',
          imsOrgId: 'ABC123@AdobeOrg',
          brandName: 'Test Brand',
        },
        context,
      );

      // Onboarding completes despite upsertBrand failure
      expect(result.message).to.equal(
        'LLMO onboarding completed successfully',
      );
      expect(failingUpsertBrand).to.have.been.calledOnce;
      expect(mockLog.warn).to.have.been.calledWith(
        'Failed to create initial brand in normalized table: '
        + 'PostgREST unavailable',
      );
      // Brandalf job should still be submitted
      expect(mockDrsClient.createFrom().submitJob)
        .to.have.been.called;
    });

    it('should include detectedCdn in result when CDN is detected', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        updateLlmoDetectedCdn: sinon.stub(),
        getImports: sinon.stub().returns([]),
        enableImport: sinon.stub(),
        getFetchConfig: sinon.stub().returns({}),
        updateFetchConfig: sinon.stub(),
        getBrandProfile: sinon.stub().returns({ main_profile: { target_audience: 'Tech-savvy professionals' } }),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      const maybeSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const eqFlag = sinon.stub().returns({ maybeSingle });
      const eqProduct = sinon.stub().returns({ eq: eqFlag });
      const eqOrg = sinon.stub().returns({ eq: eqProduct });
      const select = sinon.stub().returns({ eq: eqOrg });
      const upsertSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const upsertSelect = sinon.stub().returns({ single: upsertSingle });
      const upsertStub = sinon.stub().returns({ select: upsertSelect });
      mockDataAccess.services.postgrestClient.from.withArgs('feature_flags').returns({ select, upsert: upsertStub });

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();
      const mockDetectCdnForDomain = sinon.stub().resolves('aem-cs-fastly');

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
          mockDetectCdnForDomain,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      const result = await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(result.detectedCdn).to.equal('aem-cs-fastly');
      expect(mockSiteConfig.updateLlmoDetectedCdn).to.have.been.calledWith('aem-cs-fastly');
      expect(mockDetectCdnForDomain).to.have.been.calledWith('example.com');
    });

    it('should store detectedCdn as byocdn-other when CDN detection resolves but does not match a specific provider', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        updateLlmoDetectedCdn: sinon.stub(),
        getImports: sinon.stub().returns([]),
        enableImport: sinon.stub(),
        getFetchConfig: sinon.stub().returns({}),
        updateFetchConfig: sinon.stub(),
        getBrandProfile: sinon.stub().returns({ main_profile: { target_audience: 'Tech-savvy professionals' } }),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      const maybeSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const eqFlag = sinon.stub().returns({ maybeSingle });
      const eqProduct = sinon.stub().returns({ eq: eqFlag });
      const eqOrg = sinon.stub().returns({ eq: eqProduct });
      const select = sinon.stub().returns({ eq: eqOrg });
      const upsertSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const upsertSelect = sinon.stub().returns({ single: upsertSingle });
      const upsertStub = sinon.stub().returns({ select: upsertSelect });
      mockDataAccess.services.postgrestClient.from.withArgs('feature_flags').returns({ select, upsert: upsertStub });

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();
      const mockDetectCdnForDomain = sinon.stub().resolves('byocdn-other');

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
          mockDetectCdnForDomain,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      const result = await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(result.detectedCdn).to.equal('byocdn-other');
      expect(mockSiteConfig.updateLlmoDetectedCdn).to.have.been.calledWith('byocdn-other');
    });

    it('should continue onboarding when CDN detection throws', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        updateLlmoDetectedCdn: sinon.stub(),
        getImports: sinon.stub().returns([]),
        enableImport: sinon.stub(),
        getFetchConfig: sinon.stub().returns({}),
        updateFetchConfig: sinon.stub(),
        getBrandProfile: sinon.stub().returns({ main_profile: { target_audience: 'Tech-savvy professionals' } }),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      const maybeSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const eqFlag = sinon.stub().returns({ maybeSingle });
      const eqProduct = sinon.stub().returns({ eq: eqFlag });
      const eqOrg = sinon.stub().returns({ eq: eqProduct });
      const select = sinon.stub().returns({ eq: eqOrg });
      const upsertSingle = sinon.stub().resolves({ data: { flag_value: true }, error: null });
      const upsertSelect = sinon.stub().returns({ single: upsertSingle });
      const upsertStub = sinon.stub().returns({ select: upsertSelect });
      mockDataAccess.services.postgrestClient.from.withArgs('feature_flags').returns({ select, upsert: upsertStub });

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();
      const mockDetectCdnForDomain = sinon.stub().rejects(new Error('DNS exploded'));

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
          mockDetectCdnForDomain,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      const result = await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(result.detectedCdn).to.be.null;
      expect(mockSiteConfig.updateLlmoDetectedCdn).to.not.have.been.called;
      expect(mockLog.warn).to.have.been.calledWithMatch('CDN detection failed');
    });

    it('should skip v2 initialization and Brandalf in v1 onboarding mode', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns({ main_profile: { target_audience: 'Tech-savvy professionals' } }),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Force v1 mode via the global kill switch — no brandalf flag lookup needed.
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: { ...mockEnv, LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres).to.not.have.been.called;
      // V1 mode does not trigger Brandalf, but it MUST trigger DRS prompt generation
      // directly so the legacy LLMO config still gets prompts written (LLMO-4534).
      expect(mockDrsClient.createFrom().submitJob).to.not.have.been.called;
      expect(mockDrsClient.createFrom().submitPromptGenerationJob).to.have.been.calledOnce;
      expect(mockDrsClient.createFrom().submitPromptGenerationJob.firstCall.args[0]).to.include({
        brandName: 'Test Brand',
        siteId: 'site123',
        imsOrgId: 'ABC123@AdobeOrg',
        audience: 'Tech-savvy professionals',
      });
      // LLMO-4683: when the caller does not supply a region, the V1 path must NOT
      // pass `region` so the DRS client's existing default ('US') applies. This
      // locks in additive behavior — non-US callers must opt in.
      expect(mockDrsClient.createFrom().submitPromptGenerationJob.firstCall.args[0])
        .to.not.have.property('region');
    }).timeout(10000);

    it('should forward operator-supplied region to DRS prompt generation in v1 mode (LLMO-4683)', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns({ main_profile: { target_audience: 'General consumers in India' } }),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: { ...mockEnv, LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand IN',
        imsOrgId: 'ABC123@AdobeOrg',
        region: 'IN',
      }, context);

      expect(mockDrsClient.createFrom().submitPromptGenerationJob).to.have.been.calledOnce;
      expect(mockDrsClient.createFrom().submitPromptGenerationJob.firstCall.args[0]).to.include({
        brandName: 'Test Brand IN',
        siteId: 'site123',
        imsOrgId: 'ABC123@AdobeOrg',
        region: 'IN',
      });
      expect(mockLog.info).to.have.been.calledWithMatch(
        /Using operator-supplied region "IN" for v1 DRS prompt generation/,
      );
    }).timeout(10000);

    it('should skip DRS prompt generation in v1 mode when DRS client is not configured', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns(null),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      // DRS client not configured — v1 path should fall through the else branch and skip
      // submitPromptGenerationJob, emitting a debug log instead.
      const mockDrsClient = createMockDrsClient(sinon, { isConfigured: false });
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: { ...mockEnv, LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(mockDrsClient.createFrom().submitPromptGenerationJob).to.not.have.been.called;
      expect(mockLog.debug).to.have.been.calledWith('DRS client not configured, skipping prompt generation');
    }).timeout(10000);

    it('should handle DRS prompt generation failure gracefully in v1 mode', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns(null),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      // DRS prompt generation throws — onboarding should swallow the error, log it,
      // and warn via say() that a manual trigger is required (LLMO-4534).
      const submitPromptGenerationJob = sinon.stub().rejects(new Error('drs unavailable'));
      const mockDrsClient = createMockDrsClient(sinon, { submitPromptGenerationJob });
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: { ...mockEnv, LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      const sayStub = sinon.stub();

      const result = await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context, sayStub);

      // Onboarding still completes despite DRS failure
      expect(result.siteId).to.equal('site123');
      expect(submitPromptGenerationJob).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith('Failed to start DRS prompt generation: drs unavailable');
      expect(sayStub).to.have.been.calledWith(':warning: Failed to start DRS prompt generation for site site123 (will need manual trigger)');
    }).timeout(10000);

    it('should use the English fallback audience when brand profile is missing in v1 mode', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          // Brand profile missing entirely — exercises the `||` fallback at the audience line.
          getBrandProfile: sinon.stub().returns(null),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const mockDrsClient = createMockDrsClient();
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: { ...mockEnv, LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      // Caller passes brandName with whitespace to confirm trim is applied to BOTH the
      // audience template and the DRS payload (consistency).
      await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: '  Test Brand  ',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(mockDrsClient.createFrom().submitPromptGenerationJob).to.have.been.calledOnce;
      expect(mockDrsClient.createFrom().submitPromptGenerationJob.firstCall.args[0]).to.include({
        brandName: 'Test Brand',
        audience: 'General consumers interested in Test Brand products and services',
        siteId: 'site123',
        imsOrgId: 'ABC123@AdobeOrg',
      });
    }).timeout(10000);

    it('should treat a DRS response missing job_id as a failure in v1 mode', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
          getBrandProfile: sinon.stub().returns(null),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      // DRS resolves without a job_id — onboarding must NOT log/say a fake success;
      // it must throw into the catch and emit the `:warning:` instead.
      const submitPromptGenerationJob = sinon.stub().resolves({});
      const mockDrsClient = createMockDrsClient(sinon, { submitPromptGenerationJob });
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
          mockCustomerConfigV2Storage,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: { ...mockEnv, LLMO_ONBOARDING_DEFAULT_VERSION: 'v1' },
        sqs: { sendMessage: sinon.stub().resolves() },
      };

      const sayStub = sinon.stub();

      const result = await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context, sayStub);

      expect(result.siteId).to.equal('site123');
      expect(submitPromptGenerationJob).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith('Failed to start DRS prompt generation: DRS submitPromptGenerationJob returned no job_id');
      expect(sayStub).to.have.been.calledWith(':warning: Failed to start DRS prompt generation for site site123 (will need manual trigger)');
      // The success log/say must NOT have been emitted with `undefined`
      expect(mockLog.info).to.not.have.been.calledWith('Started DRS prompt generation: job=undefined');
      expect(sayStub).to.not.have.been.calledWith(':robot_face: Started DRS prompt generation job: undefined');
    }).timeout(10000);

    it('should skip DRS prompt generation when DRS client is not configured', async () => {
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
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      // DRS client not configured
      const mockDrsClient = createMockDrsClient(sinon, { isConfigured: false });

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      const result = await performLlmoOnboardingWithMocks(params, context);

      // Verify onboarding completed successfully
      expect(result.siteId).to.equal('site123');
      expect(result.message).to.equal('LLMO onboarding completed successfully');

      // Verify DRS was checked but not called (prompt gen is deferred, only Brandalf is checked)
      expect(mockLog.debug).to.have.been.calledWith('DRS client not configured, skipping Brandalf flow');
    });

    it('should handle Brandalf job submission failure gracefully', async () => {
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
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      // DRS client configured but job submission fails
      const mockDrsClient = createMockDrsClient(sinon, {
        isConfigured: true,
        submitJob: sinon.stub().rejects(new Error('Brandalf API connection failed')),
      });

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
          mockDrsClient,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      const result = await performLlmoOnboardingWithMocks(params, context);

      // Verify onboarding completed successfully despite DRS failure
      expect(result.siteId).to.equal('site123');
      expect(result.message).to.equal('LLMO onboarding completed successfully');

      // Verify error was logged but didn't fail onboarding
      expect(mockLog.error).to.have.been.calledWith('Failed to start DRS Brandalf flow: Brandalf API connection failed');
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
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks - organization does not exist
      mockDataAccess.Organization.findByImsOrgId.resolves(null);
      mockDataAccess.Organization.create = sinon.stub().resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Use helper functions for common mocks
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit(sinon, { sha: 'test-sha-456' });

      // Mock the module
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
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
    });

    it('should swallow async publish enqueue failures and still complete onboarding', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
        }),
      );

      const sendMessage = sinon.stub().callsFake(async (queue, message) => {
        if (message.type === 'trigger:llmo-onboarding-publish') {
          throw new Error('queue unavailable');
        }
        return Promise.resolve();
      });
      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: { sendMessage },
      };

      const result = await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      }, context);

      expect(result.siteId).to.equal('site123');
      expect(mockLog.warn).to.have.been.calledWith(
        sinon.match(/Failed to enqueue trigger:llmo-onboarding-publish/),
      );
    });

    it('should skip helix-query.yaml update when tempOnboarding is true', async () => {
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          updateLlmoBrand: sinon.stub(),
          updateLlmoDataFolder: sinon.stub(),
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();
      const { repos: { createOrUpdateFileContents } } = mockOctokit();

      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClient,
          mockOctokit,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      await performLlmoOnboardingWithMocks({
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        tempOnboarding: true,
      }, context);

      expect(createOrUpdateFileContents).to.not.have.been.called;
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/Skipping helix-query.yaml update \(temp-onboarding\)/),
      );
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
          getImports: sinon.stub().returns([]),
          enableImport: sinon.stub(),
          getFetchConfig: sinon.stub().returns({}),
          updateFetchConfig: sinon.stub(),
        }),
        setConfig: sinon.stub(),
        save: sinon.stub().rejects(new Error('Database save failed')),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null); // New site
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Use helper functions for common mocks
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();

      // Create mock fetch that handles bulk unpublish flows
      const mockTracingFetch = sinon.stub();
      // Bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'job-test-123' }),
      });
      // Job polling
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/example-com/query-index.json' }],
          },
        }),
      });
      // Bulk unpublish (live)
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpublish-job-123' }),
      });
      // Bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpreview-job-123' }),
      });

      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const {
        mockClient: sharePointClientLocal,
        mockFolder: mockSharePointFolderLocal,
      } = createMockSharePointClient(sinon, { folderExists: true });
      const mockOctokit = createMockOctokit();

      // Mock the Config import
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({
          mockTierClient,
          mockTracingFetch,
          mockConfig,
          mockComposeBaseURL,
          mockSharePointClient: sharePointClientLocal,
          mockOctokit,
        }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: mockEnv,
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
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
      expect(mockTracingFetch).to.have.callCount(4);

      // Verify revokeEnrollment was called
      const tierClient = mockTierClient.createForSite.returnValues[0];
      expect(tierClient.revokeSiteEnrollment).to.have.been.called;
    });

    it('should set overrideBaseURL when Ahrefs determines it is needed', async () => {
      // Mock organization
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      // Mock site config with getFetchConfig and updateFetchConfig
      const mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        getImports: sinon.stub().returns([]),
        enableImport: sinon.stub(),
        getFetchConfig: sinon.stub().returns({}),
        updateFetchConfig: sinon.stub(),
      };

      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock Ahrefs client to return overrideBaseURL
      const mockSeoClient = {
        getTopPages: sinon.stub(),
      };
      // Base URL fails, www variant succeeds
      mockSeoClient.getTopPages
        .withArgs('https://example.com', { limit: 1 })
        .resolves({ result: { pages: [] } });
      mockSeoClient.getTopPages
        .withArgs('https://www.example.com', { limit: 1 })
        .resolves({ result: { pages: [{ url: 'https://www.example.com/page1' }] } });

      // Use helper functions for common mocks
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();

      // Mock the module with Ahrefs client
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          ...createCommonEsmockDependencies({
            mockTierClient,
            mockTracingFetch,
            mockConfig,
            mockComposeBaseURL,
            mockSharePointClient: sharePointClient,
            mockOctokit,
          }),
          '@adobe/mysticat-shared-seo-client': {
            default: {
              createFrom: sinon.stub().returns(mockSeoClient),
            },
          },
        },
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          AHREFS_API_BASE_URL: 'https://api.ahrefs.com',
          AHREFS_API_KEY: 'test-ahrefs-key',
        },
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      const result = await performLlmoOnboardingWithMocks(params, context);

      // Verify the function completed successfully
      expect(result).to.exist;
      expect(result.siteId).to.equal('site123');

      // Debug: Check if determineOverrideBaseURL was called
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/Determining overrideBaseURL/),
      );

      // Verify updateFetchConfig was called with overrideBaseURL
      expect(mockSiteConfig.updateFetchConfig).to.have.been.called;
      const updateFetchConfigCall = mockSiteConfig.updateFetchConfig.getCall(0);
      expect(updateFetchConfigCall.args[0]).to.have.property('overrideBaseURL', 'https://www.example.com');

      // Verify log message
      expect(mockLog.info).to.have.been.calledWith(
        'Set overrideBaseURL to https://www.example.com for site site123',
      );
    });

    it('should not set overrideBaseURL when Ahrefs determines it is not needed', async () => {
      // Mock organization
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      // Mock site config
      const mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        getImports: sinon.stub().returns([]),
        enableImport: sinon.stub(),
        getFetchConfig: sinon.stub().returns({}),
        updateFetchConfig: sinon.stub(),
      };

      // Mock site
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(null);
      mockDataAccess.Site.create.resolves(mockSite);
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock Ahrefs client - both URLs succeed
      const mockSeoClient = {
        getTopPages: sinon.stub(),
      };
      // Both URLs succeed, so no overrideBaseURL should be set
      mockSeoClient.getTopPages
        .withArgs('https://example.com', { limit: 1 })
        .resolves({ result: { pages: [{ url: 'https://example.com/page1' }] } });
      mockSeoClient.getTopPages
        .withArgs('https://www.example.com', { limit: 1 })
        .resolves({ result: { pages: [{ url: 'https://www.example.com/page1' }] } });

      // Use helper functions for common mocks
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();

      // Mock the module with Ahrefs client
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          ...createCommonEsmockDependencies({
            mockTierClient,
            mockTracingFetch,
            mockConfig,
            mockComposeBaseURL,
            mockSharePointClient: sharePointClient,
            mockOctokit,
          }),
          '@adobe/mysticat-shared-seo-client': {
            default: {
              createFrom: sinon.stub().returns(mockSeoClient),
            },
          },
        },
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          AHREFS_API_BASE_URL: 'https://api.ahrefs.com',
          AHREFS_API_KEY: 'test-ahrefs-key',
        },
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      await performLlmoOnboardingWithMocks(params, context);

      // Verify updateFetchConfig was NOT called
      expect(mockSiteConfig.updateFetchConfig).to.not.have.been.called;
    });

    it('should respect existing overrideBaseURL and skip auto-detection', async () => {
      // Mock organization
      const mockOrganization = {
        getId: sinon.stub().returns('org123'),
        getImsOrgId: sinon.stub().returns('ABC123@AdobeOrg'),
      };

      // Mock site config with existing overrideBaseURL
      const existingOverrideURL = 'https://www.existing-override.com/';
      const mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        getImports: sinon.stub().returns([]),
        enableImport: sinon.stub(),
        getFetchConfig: sinon.stub().returns({ overrideBaseURL: existingOverrideURL }),
        updateFetchConfig: sinon.stub(),
      };

      // Mock site - simulating an existing site being re-onboarded
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
        getOrganizationId: sinon.stub().returns('org123'),
        setOrganizationId: sinon.stub(),
      };

      // Mock configuration
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        disableHandlerForSite: sinon.stub(),
        isHandlerEnabledForSite: sinon.stub().returns(false),
        getEnabledSiteIdsForHandler: sinon.stub().returns([]),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };

      // Setup mocks - site already exists
      mockDataAccess.Organization.findByImsOrgId.resolves(mockOrganization);
      mockDataAccess.Site.findByBaseURL.resolves(mockSite); // Existing site
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock Ahrefs client - should NOT be called since we skip detection
      const mockSeoClient = {
        getTopPages: sinon.stub(),
      };

      // Use helper functions for common mocks
      const mockConfig = createMockConfig();
      const mockTierClient = createMockTierClient();
      const mockTracingFetch = createMockTracingFetch();
      originalSetTimeout = mockSetTimeoutImmediate();
      const mockComposeBaseURL = createMockComposeBaseURL();
      const { mockClient: sharePointClient } = createMockSharePointClient(
        sinon,
        { folderExists: false },
      );
      const mockOctokit = createMockOctokit();

      // Mock the module with Ahrefs client
      const { performLlmoOnboarding: performLlmoOnboardingWithMocks } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          ...createCommonEsmockDependencies({
            mockTierClient,
            mockTracingFetch,
            mockConfig,
            mockComposeBaseURL,
            mockSharePointClient: sharePointClient,
            mockOctokit,
          }),
          '@adobe/mysticat-shared-seo-client': {
            default: {
              createFrom: sinon.stub().returns(mockSeoClient),
            },
          },
        },
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        env: {
          ...mockEnv,
          AHREFS_API_BASE_URL: 'https://api.ahrefs.com',
          AHREFS_API_KEY: 'test-ahrefs-key',
        },
        sqs: {
          sendMessage: sinon.stub().resolves(),
        },
      };

      const params = {
        domain: 'example.com',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
      };

      await performLlmoOnboardingWithMocks(params, context);

      // Verify Ahrefs was NOT called (auto-detection was skipped)
      expect(mockSeoClient.getTopPages).to.not.have.been.called;

      // Verify updateFetchConfig was NOT called (existing override preserved)
      expect(mockSiteConfig.updateFetchConfig).to.not.have.been.called;

      // Verify log message about skipping auto-detection
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/already has overrideBaseURL.*skipping auto-detection/),
      );

      // Restore setTimeout
    });
  });

  describe('buildInitialCustomerConfigV2', () => {
    it('builds a single active brand config for onboarding', async () => {
      const { buildInitialCustomerConfigV2 } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});

      const result = buildInitialCustomerConfigV2({
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'site-123',
        baseURL: 'https://example.com',
        overrideBaseURL: 'https://www.example.com',
        updatedBy: 'tester@example.com',
      });

      expect(result.customer.customerName).to.equal('Test Brand');
      expect(result.customer.imsOrgID).to.equal('ABC123@AdobeOrg');
      expect(result.customer.categories).to.deep.equal([]);
      expect(result.customer.topics).to.deep.equal([]);
      expect(result.customer.brands).to.have.lengthOf(1);
      expect(result.customer.availableVerticals).to.be.an('array').that.is.not.empty;

      const [brand] = result.customer.brands;
      expect(brand.name).to.equal('Test Brand');
      expect(brand.status).to.equal('active');
      expect(brand.v1SiteId).to.equal('site-123');
      expect(brand.baseUrl).to.equal('https://www.example.com');
      expect(brand.urls).to.deep.equal([{ value: 'https://www.example.com', type: 'base' }]);
      expect(brand.brandAliases).to.deep.equal([{ name: 'Test Brand', regions: ['gl'] }]);
      expect(brand.updatedBy).to.equal('tester@example.com');
      expect(brand.prompts).to.deep.equal([]);
    });
  });

  describe('ensureInitialCustomerConfigV2', () => {
    it('throws when PostgREST is not available', async () => {
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies(),
      );

      try {
        await ensureInitialCustomerConfigV2({
          organizationId: 'org-123',
          brandName: 'Test Brand',
          imsOrgId: 'ABC123@AdobeOrg',
          siteId: 'site-123',
          baseURL: 'https://example.com',
          context: {
            dataAccess: {
              services: {},
            },
            log: mockLog,
          },
        });
        expect.fail('Expected ensureInitialCustomerConfigV2 to throw');
      } catch (error) {
        expect(error.message).to.equal(
          'V2 customer config requires Postgres (DATA_SERVICE_PROVIDER=postgres)',
        );
      }
    });

    it('creates and writes the initial v2 config when one does not exist', async () => {
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({ mockCustomerConfigV2Storage }),
      );

      const context = {
        dataAccess: mockDataAccess,
        log: mockLog,
        attributes: {
          authInfo: {
            profile: {
              email: 'owner@example.com',
            },
          },
        },
      };

      const result = await ensureInitialCustomerConfigV2({
        organizationId: 'org-123',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'site-123',
        baseURL: 'https://example.com',
        overrideBaseURL: 'https://www.example.com',
        context,
      });

      expect(mockCustomerConfigV2Storage.readCustomerConfigV2FromPostgres).to.have.been.calledWith(
        'org-123',
        mockDataAccess.services.postgrestClient,
      );
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres).to.have.been.calledOnce;
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres.firstCall.args[0]).to.equal('org-123');
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres.firstCall.args[2])
        .to.equal(mockDataAccess.services.postgrestClient);
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres.firstCall.args[3])
        .to.equal('owner@example.com');

      const writtenConfig = mockCustomerConfigV2Storage
        .writeCustomerConfigV2ToPostgres.firstCall.args[1];
      expect(writtenConfig.customer.customerName).to.equal('Test Brand');
      expect(writtenConfig.customer.brands[0].v1SiteId).to.equal('site-123');
      expect(writtenConfig.customer.brands[0].baseUrl).to.equal('https://www.example.com');
      expect(result).to.deep.equal(writtenConfig);
      expect(mockLog.info).to.have.been.calledWith('Initialized V2 customer config for organization org-123 during onboarding');
    });

    it('uses authInfo.getProfile email when profile.email is not available', async () => {
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage();
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({ mockCustomerConfigV2Storage }),
      );

      await ensureInitialCustomerConfigV2({
        organizationId: 'org-123',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'site-123',
        baseURL: 'https://example.com',
        context: {
          dataAccess: mockDataAccess,
          log: mockLog,
          attributes: {
            authInfo: {
              getProfile: sinon.stub().returns({
                email: 'fallback-owner@example.com',
              }),
            },
          },
        },
      });

      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres.firstCall.args[3])
        .to.equal('fallback-owner@example.com');
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres.firstCall.args[1]
        .customer.brands[0].updatedBy).to.equal('fallback-owner@example.com');
    });

    it('skips writing when the v2 config already exists and site is already registered', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Existing',
          imsOrgID: 'ABC123@AdobeOrg',
          brands: [{ id: 'existing-brand', v1SiteId: 'site-123' }],
        },
      };
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage(sinon, {
        readCustomerConfigV2FromPostgres: sinon.stub().resolves(existingConfig),
      });
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({ mockCustomerConfigV2Storage }),
      );

      const result = await ensureInitialCustomerConfigV2({
        organizationId: 'org-123',
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'site-123',
        baseURL: 'https://example.com',
        context: {
          dataAccess: mockDataAccess,
          log: mockLog,
        },
      });

      expect(result).to.equal(existingConfig);
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres).to.not.have.been.called;
      expect(mockLog.info).to.have.been.calledWith(
        'V2 customer config already exists for organization org-123 with site site-123, skipping',
      );
    });

    it('adds new site as brand to existing v2 config when site is not registered', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Existing',
          imsOrgID: 'ABC123@AdobeOrg',
          brands: [{ id: 'existing-brand', v1SiteId: 'other-site-456', name: 'Other Brand' }],
        },
      };
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage(sinon, {
        readCustomerConfigV2FromPostgres: sinon.stub().resolves(existingConfig),
      });
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({ mockCustomerConfigV2Storage }),
      );

      const result = await ensureInitialCustomerConfigV2({
        organizationId: 'org-123',
        brandName: 'New Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'site-123',
        baseURL: 'https://example.com',
        overrideBaseURL: 'https://www.example.com',
        context: {
          dataAccess: mockDataAccess,
          log: mockLog,
        },
      });

      expect(result).to.equal(existingConfig);
      expect(result.customer.brands).to.have.length(2);
      expect(result.customer.brands[0].v1SiteId).to.equal('other-site-456');

      const newBrand = result.customer.brands[1];
      expect(newBrand.v1SiteId).to.equal('site-123');
      expect(newBrand.id).to.equal('new-brand');
      expect(newBrand.name).to.equal('New Brand');
      expect(newBrand.baseUrl).to.equal('https://www.example.com');
      expect(newBrand.status).to.equal('active');
      expect(newBrand.origin).to.equal('system');
      expect(newBrand.regions).to.deep.equal(['gl']);
      expect(newBrand.urls).to.deep.equal([{ value: 'https://www.example.com', type: 'base' }]);
      expect(newBrand.brandAliases).to.deep.equal([{ name: 'New Brand', regions: ['gl'] }]);

      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres).to.have.been.calledOnce;
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres.firstCall.args[0])
        .to.equal('org-123');
      expect(mockLog.info).to.have.been.calledWith(
        'Added site site-123 as brand "New Brand" to existing V2 config for organization org-123',
      );
    });

    it('deduplicates brand ID when colliding with existing brand', async () => {
      const existingConfig = {
        customer: {
          customerName: 'Existing',
          imsOrgID: 'ABC123@AdobeOrg',
          brands: [{ id: 'new-brand', v1SiteId: 'other-site-456', name: 'New Brand (old)' }],
        },
      };
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage(sinon, {
        readCustomerConfigV2FromPostgres: sinon.stub().resolves(existingConfig),
      });
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({ mockCustomerConfigV2Storage }),
      );

      const result = await ensureInitialCustomerConfigV2({
        organizationId: 'org-123',
        brandName: 'New Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'abcd1234-5678-9abc-def0-123456789abc',
        baseURL: 'https://example.com',
        context: {
          dataAccess: mockDataAccess,
          log: mockLog,
        },
      });

      expect(result.customer.brands).to.have.length(2);
      const addedBrand = result.customer.brands[1];
      expect(addedBrand.id).to.equal('new-brand-abcd1234');
      expect(addedBrand.name).to.equal('New Brand');
    });

    it('adds new site as brand when existing config has no customer or brands', async () => {
      const existingConfig = {};
      const mockCustomerConfigV2Storage = createMockCustomerConfigV2Storage(sinon, {
        readCustomerConfigV2FromPostgres: sinon.stub().resolves(existingConfig),
      });
      const { ensureInitialCustomerConfigV2 } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        createCommonEsmockDependencies({ mockCustomerConfigV2Storage }),
      );

      const result = await ensureInitialCustomerConfigV2({
        organizationId: 'org-123',
        brandName: 'New Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        siteId: 'site-123',
        baseURL: 'https://example.com',
        context: {
          dataAccess: mockDataAccess,
          log: mockLog,
        },
      });

      expect(result).to.equal(existingConfig);
      expect(mockCustomerConfigV2Storage.writeCustomerConfigV2ToPostgres).to.have.been.calledOnce;
      const newBrand = result.customer.brands[0];
      expect(newBrand.v1SiteId).to.equal('site-123');
      expect(newBrand.baseUrl).to.equal('https://example.com');
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
      } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
    async function setupDeleteSharePointFolderTest(folderExists, deleteResult, jobData = null) {
      const mockFolder = {
        exists: sinon.stub().resolves(folderExists),
        delete: deleteResult instanceof Error
          ? sinon.stub().rejects(deleteResult)
          : sinon.stub().resolves(deleteResult),
      };

      const spClient = {
        getDocument: sinon.stub().returns(mockFolder),
      };

      // Mock tracingFetch for bulk status, job polling, and bulk unpublish
      const mockTracingFetch = sinon.stub();

      // Mock bulk status job start response
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'job-test-123' }),
      });

      // Mock job polling response (completed)
      const defaultJobData = jobData || {
        state: 'stopped',
        data: {
          phase: 'completed',
          resources: [
            { path: '/dev/test-com/query-index.json' },
            { path: '/dev/test-com/file1.json' },
          ],
        },
      };

      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => defaultJobData,
      });

      // Mock bulk unpublish (live) response
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpublish-job-123' }),
      });

      // Mock bulk un-preview response
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpreview-job-123' }),
      });

      const {
        deleteSharePointFolder: deleteSharePointFolderWithMocks,
      } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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

    it('should successfully delete a folder and unpublish all files when it exists', async () => {
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

      // Verify bulk status job was started
      expect(mockTracingFetch.getCall(0).args[0]).to.include('/status/adobe/project-elmo-ui-data/main/*');

      // Verify job polling occurred
      expect(mockTracingFetch.getCall(1).args[0]).to.include('/job/adobe/project-elmo-ui-data/main/status/job-test-123/details');

      // Verify bulk unpublish was called
      expect(mockTracingFetch.getCall(2).args[0]).to.include('/live/adobe/project-elmo-ui-data/main/dev/test-com/*');
      expect(mockTracingFetch.getCall(2).args[1].method).to.equal('POST');

      // Verify bulk un-preview was called
      expect(mockTracingFetch.getCall(3).args[0]).to.include('/preview/adobe/project-elmo-ui-data/main/dev/test-com/*');
      expect(mockTracingFetch.getCall(3).args[1].method).to.equal('POST');
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

      // Verify bulk unpublish was still called even if folder doesn't exist
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

      // Verify bulk unpublish was still called even after SharePoint error
      expect(mockTracingFetch).to.have.been.called;
    });

    it('should handle case when no paths need to be unpublished', async () => {
      const dataFolder = 'dev/empty-com';
      const emptyJobData = {
        state: 'stopped',
        data: {
          phase: 'completed',
          resources: [],
        },
      };

      const {
        deleteSharePointFolderWithMocks,
        mockFolder,
        mockTracingFetch,
      } = await setupDeleteSharePointFolderTest(true, undefined, emptyJobData);

      await deleteSharePointFolderWithMocks(dataFolder, { log: mockLog, env: mockEnv });

      expect(mockFolder.exists).to.have.been.called;
      expect(mockFolder.delete).to.have.been.called;

      // Verify bulk status job was started
      expect(mockTracingFetch.getCall(0).args[0]).to.include('/status/adobe/project-elmo-ui-data/main/*');

      // Verify job polling occurred
      expect(mockTracingFetch.getCall(1).args[0]).to.include('/job/adobe/project-elmo-ui-data/main/status/job-test-123/details');

      // Verify bulk unpublish was NOT called (no paths)
      expect(mockTracingFetch.callCount).to.equal(2);
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
      const { revokeEnrollment: revokeEnrollmentWithMocks } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      const { revokeEnrollment: revokeEnrollmentWithMocks } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
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
      };

      // Create mocks using helper functions
      const mockTierClient = createMockTierClient(sinon);
      const mockConfigClass = createMockConfig(sinon);

      // Create mock fetch that handles bulk unpublish flow
      const mockTracingFetch = sinon.stub();
      // Bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'job-test-123' }),
      });
      // Job polling
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/offboard-com/query-index.json' }],
          },
        }),
      });
      // Bulk unpublish (live)
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpublish-job-123' }),
      });
      // Bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpreview-job-123' }),
      });

      const mockComposeBaseURL = sinon.stub().callsFake((url) => url);
      const sharePointClient = sinon.stub().resolves({
        getDocument: sinon.stub().returns({
          exists: sinon.stub().resolves(true),
          delete: sinon.stub().resolves(),
        }),
      });

      // Mock configuration for audit disabling
      const mockConfiguration = {
        disableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock the module with all dependencies using helper
      const { performLlmoOffboarding } = await setupPerformLlmoOffboardingTest({
        mockTierClient,
        mockTracingFetch,
        mockConfig: mockConfigClass,
        mockComposeBaseURL,
        mockSharePointClient: sharePointClient,
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

      // Verify audits were disabled
      expect(mockDataAccess.Configuration.findLatest).to.have.been.called;
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('llm-blocked', mockSite);
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('llm-error-pages', mockSite);
      expect(mockConfiguration.save).to.have.been.called;

      // Verify LLMO config was removed from site
      expect(mockSite.setConfig).to.have.been.calledWith({ config: 'dynamo-item' });
      expect(mockSite.save).to.have.been.called;

      // Verify TierClient was called to revoke enrollment
      expect(mockTierClient.createForSite).to.have.been.called;

      // Verify tracingFetch was called for bulk unpublish flow
      expect(mockTracingFetch.callCount).to.equal(4);

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
      };

      // Create mocks using helper functions
      const mockTierClient = createMockTierClient(sinon);
      const mockConfigClass = createMockConfig(sinon);

      // Create mock fetch that handles bulk unpublish flow
      const mockTracingFetch = sinon.stub();
      // Bulk status job start
      mockTracingFetch.onCall(0).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'job-test-456' }),
      });
      // Job polling
      mockTracingFetch.onCall(1).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          state: 'stopped',
          data: {
            phase: 'completed',
            resources: [{ path: '/dev/recalc-test-com/query-index.json' }],
          },
        }),
      });
      // Bulk unpublish (live)
      mockTracingFetch.onCall(2).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpublish-job-456' }),
      });
      // Bulk un-preview
      mockTracingFetch.onCall(3).resolves({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ name: 'unpreview-job-456' }),
      });

      const mockComposeBaseURL = sinon.stub().callsFake((url) => url);
      const sharePointClient = sinon.stub().resolves({
        getDocument: sinon.stub().returns({
          exists: sinon.stub().resolves(true),
          delete: sinon.stub().resolves(),
        }),
      });

      // Mock configuration for audit disabling
      const mockConfiguration = {
        disableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      // Mock the module with all dependencies using helper
      const { performLlmoOffboarding } = await setupPerformLlmoOffboardingTest({
        mockTierClient,
        mockTracingFetch,
        mockConfig: mockConfigClass,
        mockComposeBaseURL,
        mockSharePointClient: sharePointClient,
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

      // Verify audits were disabled
      expect(mockDataAccess.Configuration.findLatest).to.have.been.called;
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('llmo-customer-analysis', mockSite);
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('llm-blocked', mockSite);
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('llm-error-pages', mockSite);
      expect(mockConfiguration.save).to.have.been.called;

      // Verify LLMO config was removed from site
      expect(mockSite.setConfig).to.have.been.calledWith({ config: 'dynamo-item' });
      expect(mockSite.save).to.have.been.called;

      // Verify TierClient was called to revoke enrollment
      expect(mockTierClient.createForSite).to.have.been.called;

      expect(mockTracingFetch.callCount).to.equal(4);

      // Verify logging
      expect(mockLog.info).to.have.been.calledWith('Starting LLMO offboarding process for site: site999');
      expect(mockLog.info).to.have.been.calledWith('Offboarding site site999 with domain https://recalc-test.com and data folder dev/recalc-test-com');
      expect(mockLog.info).to.have.been.calledWith('LLMO offboarding process completed for site site999');

      // Verify no errors were logged (fetch should have succeeded)
      expect(mockLog.error.called).to.be.false;
    });

    it('should handle non-ok response when unpublishing from admin.hlx.page', async () => {
      // Mock tracingFetch - first call for bulk status job fails
      const mockTracingFetch = sinon.stub();
      mockTracingFetch.onCall(0).resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Mock the module with tracingFetch
      const { unpublishFromAdminHlx } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockTracingFetch,
        },
      });

      // Call unpublishFromAdminHlx with correct new signature (dataFolder, env, log)
      await unpublishFromAdminHlx('dev/offboard-com', mockEnv, mockLog);

      // Verify that error was logged for bulk status job failure
      expect(mockLog.error).to.have.been.calledWith(sinon.match('Error during bulk unpublish for folder dev/offboard-com'));

      // Verify tracingFetch was called (attempted to start bulk status job)
      expect(mockTracingFetch).to.have.been.called;
    });
  });

  describe('determineOverrideBaseURL', () => {
    // Helper function to create context and test determineOverrideBaseURL
    async function testOverrideBaseURL(baseURL, responses) {
      const context = {
        log: mockLog,
        env: mockEnv,
      };

      return testDetermineOverrideBaseURL(baseURL, responses, context);
    }

    const testCases = [
      {
        name: 'should return alternate URL when only alternate succeeds (base without www)',
        baseURL: 'https://example.com',
        responses: {
          'https://example.com': [],
          'https://www.example.com': [{ url: 'https://www.example.com/page1' }],
        },
        expected: 'https://www.example.com',
        expectedLog: { level: 'info', pattern: /Setting overrideBaseURL to https:\/\/www\.example\.com/ },
      },
      {
        name: 'should return alternate URL when only alternate succeeds (base with www)',
        baseURL: 'https://www.example.com',
        responses: {
          'https://www.example.com': [],
          'https://example.com': [{ url: 'https://example.com/page1' }],
        },
        expected: 'https://example.com',
        expectedLog: { level: 'info', pattern: /Setting overrideBaseURL/ },
      },
      {
        name: 'should return null when both URLs succeed',
        baseURL: 'https://example.com',
        responses: {
          'https://example.com': [{ url: 'https://example.com/page1' }],
          'https://www.example.com': [{ url: 'https://www.example.com/page1' }],
        },
        expected: null,
        expectedLog: { level: 'debug', pattern: /Both URLs succeeded, no overrideBaseURL needed/ },
      },
      {
        name: 'should return null when only base URL succeeds',
        baseURL: 'https://example.com',
        responses: {
          'https://example.com': [{ url: 'https://example.com/page1' }],
          'https://www.example.com': [],
        },
        expected: null,
        expectedLog: { level: 'debug', pattern: /Base URL succeeded, no overrideBaseURL needed/ },
      },
      {
        name: 'should return null when both URLs fail',
        baseURL: 'https://example.com',
        responses: {
          'https://example.com': [],
          'https://www.example.com': [],
        },
        expected: null,
        expectedLog: { level: 'warn', pattern: /Both URLs failed SEO top pages test/ },
      },
      {
        name: 'should handle multi-part TLD (.com.au) when only alternate succeeds',
        baseURL: 'https://example.com.au',
        responses: {
          'https://example.com.au': [],
          'https://www.example.com.au': [{ url: 'https://www.example.com.au/page1' }],
        },
        expected: 'https://www.example.com.au',
        expectedLog: { level: 'info', pattern: /Setting overrideBaseURL/ },
      },
      {
        name: 'should handle multi-part TLD (.co.uk) when only alternate succeeds',
        baseURL: 'https://example.co.uk',
        responses: {
          'https://example.co.uk': [],
          'https://www.example.co.uk': [{ url: 'https://www.example.co.uk/page1' }],
        },
        expected: 'https://www.example.co.uk',
        expectedLog: { level: 'info', pattern: /Setting overrideBaseURL/ },
      },
      {
        name: 'should handle multi-part TLD with www when only alternate succeeds',
        baseURL: 'https://www.example.com.au',
        responses: {
          'https://www.example.com.au': [],
          'https://example.com.au': [{ url: 'https://example.com.au/page1' }],
        },
        expected: 'https://example.com.au',
        expectedLog: { level: 'info', pattern: /Setting overrideBaseURL/ },
      },
    ];

    testCases.forEach(({
      name, baseURL, responses, expected, expectedLog,
    }) => {
      it(name, async () => {
        const { result } = await testOverrideBaseURL(baseURL, responses);

        expect(result).to.equal(expected);
        expect(mockLog[expectedLog.level])
          .to.have.been.calledWith(sinon.match(expectedLog.pattern));
      });
    });

    it('should handle Ahrefs API errors gracefully', async () => {
      const mockSeoClient = {
        getTopPages: sinon.stub().rejects(new Error('Ahrefs API error')),
      };

      const { determineOverrideBaseURL } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/mysticat-shared-seo-client': {
            default: {
              createFrom: sinon.stub().returns(mockSeoClient),
            },
          },
        },
      );

      const context = {
        log: mockLog,
        env: mockEnv,
      };

      const result = await determineOverrideBaseURL('https://example.com', context);

      expect(result).to.be.null;
      expect(mockLog.debug).to.have.been.calledWith(
        sinon.match(/SEO top pages test.*FAILED/),
      );
      expect(mockLog.warn).to.have.been.calledWith('Both URLs failed SEO top pages test, no overrideBaseURL set');
    });

    // Subdomain detection tests
    const subdomainTestCases = [
      {
        name: 'should skip detection for subdomain URLs (blog.example.com)',
        url: 'https://blog.example.com',
      },
      {
        name: 'should skip detection for multi-level subdomain (api.staging.example.com)',
        url: 'https://api.staging.example.com',
      },
      {
        name: 'should skip detection for subdomain with multi-part TLD (blog.example.co.uk)',
        url: 'https://blog.example.co.uk',
      },
    ];

    subdomainTestCases.forEach(({ name, url }) => {
      it(name, async () => {
        const { result, mockSeoClient } = await testOverrideBaseURL(url, {});

        expect(result).to.be.null;
        expect(mockLog.info).to.have.been.calledWith(
          `Skipping overrideBaseURL detection for subdomain URL: ${url}`,
        );
        // Verify Ahrefs was NOT called
        expect(mockSeoClient.getTopPages).to.not.have.been.called;
      });
    });

    it('should NOT skip detection for apex domain with multi-part TLD (example.co.uk)', async () => {
      const { result, mockSeoClient } = await testOverrideBaseURL(
        'https://example.co.uk',
        {
          'https://example.co.uk': [{ url: 'https://example.co.uk/page1' }],
          'https://www.example.co.uk': [{ url: 'https://www.example.co.uk/page1' }],
        },
      );

      expect(result).to.be.null; // Both succeed, no override needed
      // Verify Ahrefs WAS called (not skipped)
      expect(mockSeoClient.getTopPages).to.have.been.calledTwice;
      expect(mockLog.debug).to.have.been.calledWith('Both URLs succeeded, no overrideBaseURL needed');
    });

    it('should preserve trailing slash consistency when toggling www', async () => {
      // Test with URL without trailing slash - result should also not have trailing slash
      const { result: resultNoSlash } = await testOverrideBaseURL(
        'https://example.com',
        {
          'https://example.com': [],
          'https://www.example.com': [{ url: 'https://www.example.com/page1' }],
        },
      );
      expect(resultNoSlash).to.equal('https://www.example.com');
      expect(resultNoSlash.endsWith('/')).to.be.false;

      // Test with URL with trailing slash - result should also have trailing slash
      const { result: resultWithSlash } = await testOverrideBaseURL(
        'https://example.com/',
        {
          'https://example.com/': [],
          'https://www.example.com/': [{ url: 'https://www.example.com/page1' }],
        },
      );
      expect(resultWithSlash).to.equal('https://www.example.com/');
      expect(resultWithSlash.endsWith('/')).to.be.true;
    });
  });

  describe('enableAudits failure handling', () => {
    it('should log warning, call say, continue processing, and still save when an audit fails', async () => {
      const { enableAudits } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});
      const mockSite = { getId: () => 'site123' };
      const mockConfiguration = {
        enableHandlerForSite: sinon.stub().callsFake((audit) => {
          if (audit === 'fail') {
            throw new Error('fail error');
          }
        }),
        save: sinon.stub().resolves(),
      };
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);
      const mockSay = sinon.stub();

      await enableAudits(mockSite, { dataAccess: mockDataAccess, log: mockLog }, ['ok', 'fail'], mockSay);

      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Failed to enable audit 'fail'/));
      expect(mockSay).to.have.been.calledWith(sinon.match(/:warning:.*fail/));
      expect(mockConfiguration.enableHandlerForSite).to.have.been.calledTwice;
      expect(mockConfiguration.save).to.have.been.calledOnce;
    });
  });

  describe('enableImports failure handling', () => {
    it('should log warning, call say, and continue processing when an import fails', async () => {
      const { enableImports } = await esmock('../../../src/controllers/llmo/llmo-onboarding.js', {});
      const mockSiteConfig = {
        getImports: () => [],
        enableImport: sinon.stub().callsFake((type) => {
          if (type === 'fail') {
            throw new Error('fail error');
          }
        }),
      };
      const mockSay = sinon.stub();

      await enableImports(mockSiteConfig, [{ type: 'ok' }, { type: 'fail' }], mockLog, mockSay);

      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Failed to enable import 'fail'/));
      expect(mockSay).to.have.been.calledWith(sinon.match(/:warning:.*fail/));
      expect(mockSiteConfig.enableImport).to.have.been.calledTwice;
    });
  });

  describe('appendRowsToQueryIndex', () => {
    it('should append rows with correct format and timestamps', async () => {
      const mockAppendRowsToSheet = sinon.stub().resolves();
      const mockRedirects = { appendRowsToSheet: mockAppendRowsToSheet };
      const mockSPClient = { getRedirects: sinon.stub().returns(mockRedirects) };

      const { appendRowsToQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-helix-content-sdk': {
            createFrom: sinon.stub().resolves(mockSPClient),
          },
        },
      );

      await appendRowsToQueryIndex('dev/test-com', ['file1', 'file2.json'], mockEnv, mockLog);

      expect(mockAppendRowsToSheet).to.have.been.calledOnce;
      const [sheetPath, rows] = mockAppendRowsToSheet.firstCall.args;
      expect(sheetPath).to.equal('/dev/test-com/query-index.xlsx');
      expect(rows).to.have.length(2);
      expect(rows[0][0]).to.equal('/dev/test-com/file1.json');
      expect(rows[1][0]).to.equal('/dev/test-com/file2.json');
      expect(rows[0][1]).to.be.a('number');
      expect(rows[0][2]).to.be.a('number');
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Appending 2 rows/));
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Successfully appended rows/));
    });

    it('should not double-append .json extension for files already ending in .json', async () => {
      const mockAppendRowsToSheet = sinon.stub().resolves();
      const mockRedirects = { appendRowsToSheet: mockAppendRowsToSheet };
      const mockSPClient = { getRedirects: sinon.stub().returns(mockRedirects) };

      const { appendRowsToQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-helix-content-sdk': {
            createFrom: sinon.stub().resolves(mockSPClient),
          },
        },
      );

      await appendRowsToQueryIndex('dev/test-com', ['already.json'], mockEnv, mockLog);

      const [, rows] = mockAppendRowsToSheet.firstCall.args;
      expect(rows[0][0]).to.equal('/dev/test-com/already.json');
    });
  });

  describe('previewAndPublishQueryIndex', () => {
    it('should successfully preview and publish with .json path', async () => {
      const mockTracingFetch = sinon.stub();
      mockTracingFetch.onCall(0).resolves({ ok: true, status: 200, statusText: 'OK' });
      mockTracingFetch.onCall(1).resolves({ ok: true, status: 200, statusText: 'OK' });

      const { previewAndPublishQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockTracingFetch,
          },
        },
      );

      await previewAndPublishQueryIndex('dev/test-com', mockEnv, mockLog);

      expect(mockTracingFetch).to.have.been.calledTwice;
      const previewCall = mockTracingFetch.firstCall;
      expect(previewCall.args[0]).to.equal(
        'https://admin.hlx.page/preview/adobe/project-elmo-ui-data/main/dev/test-com/query-index.json',
      );
      expect(previewCall.args[1]).to.deep.include({ method: 'POST', timeout: 30000 });

      const publishCall = mockTracingFetch.secondCall;
      expect(publishCall.args[0]).to.equal(
        'https://admin.hlx.page/live/adobe/project-elmo-ui-data/main/dev/test-com/query-index.json',
      );
      expect(publishCall.args[1]).to.deep.include({ method: 'POST', timeout: 30000 });
      expect(mockLog.info).to.have.been.calledWith('Preview of query-index succeeded');
      expect(mockLog.info).to.have.been.calledWith('Publish of query-index succeeded');
    });

    it('should throw when HLX_ONBOARDING_TOKEN is not set', async () => {
      const { previewAndPublishQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {},
      );

      const envWithoutToken = { ...mockEnv, HLX_ONBOARDING_TOKEN: '' };

      try {
        await previewAndPublishQueryIndex('dev/test-com', envWithoutToken, mockLog);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('HLX_ONBOARDING_TOKEN is not set');
      }
    });

    it('should throw and log details when preview fails', async () => {
      const mockHeaders = { get: sinon.stub() };
      mockHeaders.get.withArgs('x-error-code').returns('CONTENT_NOT_FOUND');
      mockHeaders.get.withArgs('x-error').returns('resource not found');

      const mockTracingFetch = sinon.stub().resolves({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: mockHeaders,
        text: sinon.stub().resolves('detailed error body'),
      });

      const { previewAndPublishQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockTracingFetch,
          },
        },
      );

      try {
        await previewAndPublishQueryIndex('dev/test-com', mockEnv, mockLog);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Preview failed: 404 Not Found');
      }

      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Preview failed.*404.*x-error-code: CONTENT_NOT_FOUND.*x-error: resource not found.*body: detailed error body/),
      );
    });

    it('should throw and log details when publish fails', async () => {
      const mockHeaders = { get: sinon.stub() };
      mockHeaders.get.withArgs('x-error-code').returns('');
      mockHeaders.get.withArgs('x-error').returns('throttled');

      const mockTracingFetch = sinon.stub();
      mockTracingFetch.onCall(0).resolves({ ok: true, status: 200, statusText: 'OK' });
      mockTracingFetch.onCall(1).resolves({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: mockHeaders,
        text: sinon.stub().resolves(''),
      });

      const { previewAndPublishQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockTracingFetch,
          },
        },
      );

      try {
        await previewAndPublishQueryIndex('dev/test-com', mockEnv, mockLog);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Publish failed: 503 Service Unavailable');
      }

      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Publish failed.*503/),
      );
    });

    it('should handle text() throwing when reading error body', async () => {
      const mockHeaders = { get: sinon.stub().returns('') };

      const mockTracingFetch = sinon.stub().resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: mockHeaders,
        text: sinon.stub().rejects(new Error('stream error')),
      });

      const { previewAndPublishQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockTracingFetch,
          },
        },
      );

      try {
        await previewAndPublishQueryIndex('dev/test-com', mockEnv, mockLog);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Preview failed: 500 Internal Server Error');
      }

      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Preview failed.*500.*body: $/),
      );
    });

    it('should handle text() throwing when reading publish error body', async () => {
      const mockHeaders = { get: sinon.stub().returns('') };

      const mockTracingFetch = sinon.stub();
      mockTracingFetch.onFirstCall().resolves({ ok: true });
      mockTracingFetch.onSecondCall().resolves({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: mockHeaders,
        text: sinon.stub().rejects(new Error('stream error')),
      });

      const { previewAndPublishQueryIndex } = await esmock(
        '../../../src/controllers/llmo/llmo-onboarding.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockTracingFetch,
          },
        },
      );

      try {
        await previewAndPublishQueryIndex('dev/test-com', mockEnv, mockLog);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Publish failed: 502 Bad Gateway');
      }

      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Publish failed.*502.*body: $/),
      );
    });
  });

  // Round-trip every token the shared Joi schema accepts. Anchored against
  // `@adobe/spacecat-shared-data-access` >= 3.54.0, which aligned the enum
  // with the canonical CDN_TYPES vocabulary (10 tokens) plus the legacy
  // `other` token kept for back-compat with records written by the
  // original Phase-1-only detector. If the detector ever starts emitting a
  // token the schema doesn't know about, the config write at runtime will
  // throw; surfacing that at unit-test time is the whole point of this
  // block.
  describe('detectedCdn Joi round-trip', () => {
    const ACCEPTED_TOKENS = [
      // Detector emits today
      'aem-cs-fastly',
      'commerce-fastly',
      'byocdn-fastly',
      'byocdn-akamai',
      'byocdn-cloudflare',
      'byocdn-imperva',
      'byocdn-other',
      // Reserved CDN_TYPES tokens — not emitted today but accepted so
      // a future detector revision with AMS-aware signatures can land
      // without a coupled shared release.
      'byocdn-cloudfront',
      'ams-cloudfront',
      'ams-frontdoor',
      // Legacy sentinel kept for back-compat; detector no longer emits it.
      'other',
    ];

    let validateConfiguration;

    before(async () => {
      ({ validateConfiguration } = await import('@adobe/spacecat-shared-data-access/src/models/site/config.js'));
    });

    ACCEPTED_TOKENS.forEach((token) => {
      it(`accepts detectedCdn = "${token}" via the shared Joi schema`, () => {
        const config = {
          llmo: {
            dataFolder: '/test',
            brand: 'test',
            detectedCdn: token,
          },
        };
        const validated = validateConfiguration(config);
        expect(validated.llmo.detectedCdn).to.equal(token);
      });
    });

    it('rejects an unknown detectedCdn token (regression guard for future detector additions)', () => {
      const config = {
        llmo: {
          dataFolder: '/test',
          brand: 'test',
          detectedCdn: 'byocdn-unknown-provider',
        },
      };
      expect(() => validateConfiguration(config)).to.throw(/detectedCdn/);
    });
  });
});
