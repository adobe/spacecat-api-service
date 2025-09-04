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

      await onboardSite(input, lambdaCtx, slackCtx);

      expect(lambdaCtx.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(lambdaCtx.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC123@AdobeOrg');
      expect(existingSite.setOrganizationId).to.have.been.calledWith('new-org-456');
      expect(existingSite.save).to.have.been.called;
      expect(lambdaCtx.dataAccess.Site.create).to.not.have.been.called;
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

      expect(lambdaCtx.log.info).to.have.been.calledWith('Starting onboarding process...');
      expect(lambdaCtx.log.info).to.have.been.calledWith('Onboarding request with parameters:', {
        brandName: 'Test Brand',
        imsOrgId: 'ABC123@AdobeOrg',
        deliveryType: 'aem_edge',
        brandURL: 'https://example.com',
        originalChannel: 'C1234567890',
        originalThreadTs: '1234567890.123456',
      });
      expect(lambdaCtx.log.info).to.have.been.calledWith('Onboard LLMO modal processed for user U1234567890, site https://example.com');
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
      expect(lambdaCtx.log.info).to.have.been.calledWith('Starting onboarding process...');
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
});
