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
      },
      Organization: {
        findByImsOrgId: sinon.stub(),
      },
    };

    // Create mock log
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
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
});
