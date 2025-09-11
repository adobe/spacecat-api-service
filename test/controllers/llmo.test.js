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

describe('LlmoController', () => {
  let controller;
  let mockContext;
  let mockSite;
  let mockConfig;
  let mockLlmoConfig;
  let mockDataAccess;
  let mockLog;
  let mockEnv;
  let tracingFetchStub;

  // Helper function to create mock objects
  const createMockAccessControlUtil = (accessResult) => ({
    fromContext: (context) => ({
      log: context.log,
      hasAccess: async () => accessResult,
    }),
  });

  beforeEach(async () => {
    // Create mock LLMO config
    mockLlmoConfig = {
      dataFolder: 'test-folder',
      brand: 'test-brand',
      questions: {
        Human: [
          { key: 'test-question', question: 'What is the main goal of this page?' },
        ],
        AI: [
          { key: 'ai-question', question: 'Analyze the page content and identify key themes.' },
        ],
      },
      customerIntent: [
        { key: 'target_audience', value: 'small business owners' },
        { key: 'primary_goal', value: 'increase conversions' },
      ],
      cdnlogsFilter: [
        { key: 'host', value: ['www.example.com', 'abc.com'], type: 'exclude' },
        { key: 'host', value: ['www.example.com', 'abc.com'], type: 'include' },
      ],
      cdnBucketConfig: {
        bucketName: 'test-bucket',
        orgId: 'test-org-id',
        cdnProvider: 'aem-cs-fastly',
      },
    };

    // Create mock config
    mockConfig = {
      getLlmoConfig: sinon.stub().returns(mockLlmoConfig),
      updateLlmoConfig: sinon.stub(),
      addLlmoHumanQuestions: sinon.stub(),
      addLlmoAIQuestions: sinon.stub(),
      removeLlmoQuestion: sinon.stub(),
      updateLlmoQuestion: sinon.stub(),
      getLlmoHumanQuestions: sinon.stub().returns(mockLlmoConfig.questions.Human),
      getLlmoAIQuestions: sinon.stub().returns(mockLlmoConfig.questions.AI),
      getLlmoCustomerIntent: sinon.stub().returns(mockLlmoConfig.customerIntent),
      addLlmoCustomerIntent: sinon.stub(),
      removeLlmoCustomerIntent: sinon.stub(),
      updateLlmoCustomerIntent: sinon.stub(),
      updateLlmoCdnlogsFilter: sinon.stub(),
      updateLlmoCdnBucketConfig: sinon.stub(),
      getSlackConfig: sinon.stub().returns(null),
      getHandlers: sinon.stub().returns({}),
      getLlmoDataFolder: sinon.stub().returns('test-folder'),
      getLlmoBrand: sinon.stub().returns('test-brand'),
      isInternalCustomer: sinon.stub().returns(false),
      getSlackMentions: sinon.stub().returns([]),
      getHandlerConfig: sinon.stub().returns({}),
      getContentAiConfig: sinon.stub().returns({}),
      getImports: sinon.stub().returns([]),
      getExcludedURLs: sinon.stub().returns([]),
      getManualOverwrites: sinon.stub().returns([]),
      getFixedURLs: sinon.stub().returns([]),
      getIncludedURLs: sinon.stub().returns([]),
      getGroupedURLs: sinon.stub().returns([]),
      getLatestMetrics: sinon.stub().returns({}),
      getFetchConfig: sinon.stub().returns({}),
      getBrandConfig: sinon.stub().returns({}),
      getCdnLogsConfig: sinon.stub().returns({}),
      getCdnBucketConfig: sinon.stub().returns({}),
      updateSlackConfig: sinon.stub(),
      updateLlmoDataFolder: sinon.stub(),
      updateLlmoBrand: sinon.stub(),
      updateImports: sinon.stub(),
    };

    // Create mock organization
    const mockOrganization = {
      getId: sinon.stub().returns('test-org-id'),
      getImsOrgId: sinon.stub().returns('test-ims-org-id'),
    };

    // Create mock site
    mockSite = {
      getId: sinon.stub().returns('test-site-id'),
      getConfig: sinon.stub().returns(mockConfig),
      setConfig: sinon.stub(),
      save: sinon.stub().resolves(),
      getOrganization: sinon.stub().resolves(mockOrganization),
    };

    // Create mock data access
    mockDataAccess = {
      Site: {
        findById: sinon.stub().resolves(mockSite),
      },
      Entitlement: {
        PRODUCT_CODES: {
          LLMO: 'llmo',
        },
        findByOrganizationIdAndProductCode: sinon.stub().resolves({
          getId: sinon.stub().returns('entitlement-123'),
          getProductCode: sinon.stub().returns('llmo'),
          getTier: sinon.stub().returns('premium'),
        }),
        TIERS: {
          FREE_TRIAL: 'free_trial',
        },
      },
      SiteEnrollment: {
        allBySiteId: sinon.stub().resolves([{
          getEntitlementId: sinon.stub().returns('entitlement-123'),
        }]),
      },
      TrialUser: {
        findByEmailId: sinon.stub().resolves(null),
        STATUSES: {
          REGISTERED: 'registered',
        },
      },
      OrganizationIdentityProvider: {
        allByOrganizationId: sinon.stub().resolves([]),
        create: sinon.stub().resolves({
          provider: 'GOOGLE',
        }),
        PROVIDER_TYPES: {
          GOOGLE: 'GOOGLE',
          AZURE: 'AZURE',
        },
      },
    };

    // Create mock log
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    // Create mock environment
    mockEnv = {
      LLMO_HLX_API_KEY: 'test-api-key',
    };

    // Create mock context
    mockContext = {
      params: {
        siteId: 'test-site-id',
        dataSource: 'test-data',
        configName: 'test-data',
        questionKey: 'test-question',
      },
      data: {
        Human: [
          { question: 'New human question?' },
        ],
        AI: [
          { question: 'New AI question?' },
        ],
      },
      dataAccess: mockDataAccess,
      log: mockLog,
      env: mockEnv,
      attributes: {
        authInfo: {
          getType: () => 'jwt',
          isAdmin: () => false,
          hasOrganization: () => true,
          hasScope: () => true,
          getScopes: () => [{ name: 'user' }],
          getProfile: () => ({
            email: 'test@example.com',
            trial_email: 'trial@example.com',
            first_name: 'Test',
            last_name: 'User',
            provider: 'GOOGLE',
          }),
        },
      },
      pathInfo: {
        method: 'GET',
        suffix: '/llmo/sheet-data',
      },
    };

    // Create tracingFetch stub
    tracingFetchStub = sinon.stub();

    // Mock the controller with the tracingFetch stub
    const LlmoController = await esmock('../../src/controllers/llmo.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: 'test-user-agent',
        tracingFetch: tracingFetchStub,
      },
      '../../src/support/access-control-util.js': {
        default: class MockAccessControlUtil {
          static fromContext(context) {
            return new MockAccessControlUtil(context);
          }

          constructor(context) {
            this.log = context.log;
          }

          // eslint-disable-next-line class-methods-use-this
          async hasAccess() {
            // Mock successful access for tests
            return true;
          }
        },
      },
    });

    controller = LlmoController(mockContext);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getLlmoSheetData', () => {
    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add limit query parameter to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add limit to the context params
      mockContext.data.limit = '10';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?limit=10',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add offset query parameter to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add offset to the context params
      mockContext.data.offset = '20';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?offset=20',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add sheet query parameter to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheet to the context params
      mockContext.data.sheet = 'analytics-sheet';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?sheet=analytics-sheet',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add multiple query parameters to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add multiple query parameters to the context params
      mockContext.data.limit = '10';
      mockContext.data.offset = '20';
      mockContext.data.sheet = 'analytics-sheet';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?limit=10&offset=20&sheet=analytics-sheet',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should not add query parameters when they are not provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Ensure no query parameters are set
      delete mockContext.data.limit;
      delete mockContext.data.offset;
      delete mockContext.data.sheet;

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle response with empty headers gracefully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
        headers: {
          entries: sinon.stub().returns([]), // Empty headers
        },
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add query parameters with sheetType parameter', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'analytics-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheetType and query parameters to the context params
      mockContext.params.sheetType = 'analytics';
      mockContext.data.limit = '5';
      mockContext.data.offset = '10';
      mockContext.data.sheet = 'performance-sheet';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'analytics-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/analytics/test-data.json?limit=5&offset=10&sheet=performance-sheet',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle empty string query parameters', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add empty string query parameters
      mockContext.data.limit = '';
      mockContext.data.offset = '';
      mockContext.data.sheet = '';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      // Empty strings should be treated as falsy and not added to URL
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle null query parameters', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add null query parameters
      mockContext.data.limit = null;
      mockContext.data.offset = null;
      mockContext.data.sheet = null;

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      // Null values should be treated as falsy and not added to URL
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should proxy data with sheetType parameter successfully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'analytics-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheetType to the context params
      mockContext.params.sheetType = 'analytics';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'analytics-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/analytics/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should filter data with sheet type when filter parameters are provided', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John',
          },
          {
            id: 2, status: 'inactive', category: 'basic', name: 'Jane',
          },
          {
            id: 3, status: 'active', category: 'premium', name: 'Bob',
          },
          {
            id: 4, status: 'active', category: 'basic', name: 'Alice',
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add filter parameters
      mockContext.data.filter_status = 'active';
      mockContext.data.filter_category = 'premium';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should only return items matching both filters
      expect(responseBody[':type']).to.equal('sheet');
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data).to.deep.equal([
        {
          id: 1, status: 'active', category: 'premium', name: 'John',
        },
        {
          id: 3, status: 'active', category: 'premium', name: 'Bob',
        },
      ]);
    });

    it('should filter data with multi-sheet type when filter parameters are provided', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            { id: 1, status: 'active', category: 'premium' },
            { id: 2, status: 'inactive', category: 'basic' },
            { id: 3, status: 'active', category: 'premium' },
          ],
        },
        sheet2: {
          data: [
            { id: 4, status: 'active', category: 'basic' },
            { id: 5, status: 'active', category: 'premium' },
            { id: 6, status: 'inactive', category: 'premium' },
          ],
        },
        metadata: {
          totalSheets: 2,
        },
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add filter parameters
      mockContext.data.filter_status = 'active';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should filter data in all sheets
      expect(responseBody[':type']).to.equal('multi-sheet');
      expect(responseBody.sheet1.data).to.have.length(2);
      expect(responseBody.sheet1.data).to.deep.equal([
        { id: 1, status: 'active', category: 'premium' },
        { id: 3, status: 'active', category: 'premium' },
      ]);
      expect(responseBody.sheet2.data).to.have.length(2);
      expect(responseBody.sheet2.data).to.deep.equal([
        { id: 4, status: 'active', category: 'basic' },
        { id: 5, status: 'active', category: 'premium' },
      ]);
      // Metadata should remain unchanged
      expect(responseBody.metadata).to.deep.equal({ totalSheets: 2 });
    });

    it('should perform case-insensitive filtering', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'JOHN', status: 'Active' },
          { id: 2, name: 'jane', status: 'INACTIVE' },
          { id: 3, name: 'Bob', status: 'active' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add filter with different case
      mockContext.data.filter_status = 'ACTIVE';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should match both 'Active' and 'active' due to case-insensitive matching
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data).to.deep.equal([
        { id: 1, name: 'JOHN', status: 'Active' },
        { id: 3, name: 'Bob', status: 'active' },
      ]);
    });

    it('should handle multiple filters with AND logic', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', region: 'US',
          },
          {
            id: 2, status: 'active', category: 'basic', region: 'US',
          },
          {
            id: 3, status: 'active', category: 'premium', region: 'EU',
          },
          {
            id: 4, status: 'inactive', category: 'premium', region: 'US',
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add multiple filter parameters
      mockContext.data.filter_status = 'active';
      mockContext.data.filter_category = 'premium';
      mockContext.data.filter_region = 'US';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should only return item matching ALL filters
      expect(responseBody.data).to.have.length(1);
      expect(responseBody.data).to.deep.equal([
        {
          id: 1, status: 'active', category: 'premium', region: 'US',
        },
      ]);
    });

    it('should return empty array when no items match filters', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, status: 'active', category: 'basic' },
          { id: 2, status: 'inactive', category: 'premium' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add filter that won't match any items
      mockContext.data.filter_status = 'pending';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should return empty data array
      expect(responseBody[':type']).to.equal('sheet');
      expect(responseBody.data).to.have.length(0);
      expect(responseBody.data).to.deep.equal([]);
    });

    it('should handle filtering when attribute value is null or undefined', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, status: 'active', category: null },
          { id: 2, status: 'active', category: undefined },
          { id: 3, status: 'active', category: 'premium' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Filter by category
      mockContext.data.filter_category = 'premium';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should only return items with non-null/undefined matching values
      expect(responseBody.data).to.have.length(1);
      expect(responseBody.data).to.deep.equal([
        { id: 3, status: 'active', category: 'premium' },
      ]);
    });

    it('should not apply filters when no filter parameters are provided (backwards compatibility)', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, status: 'active', category: 'premium' },
          { id: 2, status: 'inactive', category: 'basic' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Ensure no filter parameters are set
      delete mockContext.data.filter_status;
      delete mockContext.data.filter_category;

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should return all data unchanged
      expect(responseBody).to.deep.equal(mockResponseData);
    });

    it('should handle filtering with non-filter parameters present', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, status: 'active', category: 'premium' },
          { id: 2, status: 'inactive', category: 'basic' },
          { id: 3, status: 'active', category: 'basic' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Mix filter and non-filter parameters
      mockContext.data.limit = '10';
      mockContext.data.offset = '0';
      mockContext.data.sheet = 'test-sheet';
      mockContext.data.filter_status = 'active';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should only apply filter parameters, ignoring others
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data).to.deep.equal([
        { id: 1, status: 'active', category: 'premium' },
        { id: 3, status: 'active', category: 'basic' },
      ]);

      // Should still pass non-filter parameters to the API URL
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?limit=10&offset=0&sheet=test-sheet',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle external API errors with sheetType parameter', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheetType to the context params
      mockContext.data.sheetType = 'analytics';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('External API returned 404: Not Found');
    });

    it('should handle network errors with sheetType parameter', async () => {
      const networkError = new Error('Network error');
      tracingFetchStub.rejects(networkError);

      // Add sheetType to the context params
      mockContext.data.sheetType = 'analytics';

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Network error');
    });

    it('should use fallback API key when env.LLMO_HLX_API_KEY is undefined', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json',
        {
          headers: {
            Authorization: 'token hlx_api_key_missing',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle external API errors', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('External API returned 404: Not Found');
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network error');
      tracingFetchStub.rejects(networkError);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Network error');
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('LLM Optimizer is not enabled for this site');
    });

    it('should throw error when access is denied', async () => {
      // Create a new controller instance with a mock that denies access
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      const result = await controllerWithAccessDenied.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });
  });

  describe('getLlmoGlobalSheetData', () => {
    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add limit query parameter to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add limit to the context params
      mockContext.data.limit = '10';

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json?limit=10',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add offset query parameter to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add offset to the context params
      mockContext.data.offset = '20';

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json?offset=20',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add sheet query parameter to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheet to the context params
      mockContext.data.sheet = 'analytics-sheet';

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json?sheet=analytics-sheet',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should add multiple query parameters to URL when provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add multiple query parameters to the context params
      mockContext.data.limit = '10';
      mockContext.data.offset = '20';
      mockContext.data.sheet = 'analytics-sheet';

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json?limit=10&offset=20&sheet=analytics-sheet',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should not add query parameters when they are not provided', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Ensure no query parameters are set
      delete mockContext.data.limit;
      delete mockContext.data.offset;
      delete mockContext.data.sheet;

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle response with empty headers gracefully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
        headers: {
          entries: sinon.stub().returns([]), // Empty headers
        },
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle empty string query parameters', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add empty string query parameters
      mockContext.data.limit = '';
      mockContext.data.offset = '';
      mockContext.data.sheet = '';

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      // Empty strings should be treated as falsy and not added to URL
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle null query parameters', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add null query parameters
      mockContext.data.limit = null;
      mockContext.data.offset = null;
      mockContext.data.sheet = null;

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      // Null values should be treated as falsy and not added to URL
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should use fallback API key when env.LLMO_HLX_API_KEY is undefined', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/llmo-global/test-data.json',
        {
          headers: {
            Authorization: 'token hlx_api_key_missing',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle external API errors', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('External API returned 404: Not Found');
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network error');
      tracingFetchStub.rejects(networkError);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Network error');
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('LLM Optimizer is not enabled for this site');
    });

    it('should throw error when access is denied', async () => {
      // Create a new controller instance with a mock that denies access
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      const result = await controllerWithAccessDenied.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });
  });

  describe('getLlmoConfig', () => {
    it('should return LLMO config successfully', async () => {
      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig);
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('LLM Optimizer is not enabled for this site');
    });
  });

  describe('getLlmoQuestions', () => {
    it('should return LLMO questions successfully', async () => {
      const result = await controller.getLlmoQuestions(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
    });

    it('should return empty questions when questions are not configured', async () => {
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
      });

      const result = await controller.getLlmoQuestions(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({});
    });
  });

  describe('addLlmoQuestion', () => {
    it('should add human questions successfully', async () => {
      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.addLlmoHumanQuestions).to.have.been.calledOnce;
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should add AI questions successfully', async () => {
      mockContext.data = {
        AI: [{ question: 'New AI question?' }],
      };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.addLlmoAIQuestions).to.have.been.calledOnce;
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should return bad request when no questions provided', async () => {
      mockContext.data = null;

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('No questions provided in the request body');
    });

    it('should not save when no questions are added', async () => {
      mockContext.data = {};

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should handle site save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error adding new questions for site\'s llmo config test-site-id: Database connection failed',
      );
    });
  });

  describe('removeLlmoQuestion', () => {
    it('should remove question successfully', async () => {
      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.removeLlmoQuestion).to.have.been.calledWith('test-question');
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';

      try {
        await controller.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid question key');
      }
    });

    it('should handle site save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.removeLlmoQuestion).to.have.been.calledWith('test-question');
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error removing question for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should handle null/undefined questions gracefully', async () => {
      mockConfig.getLlmoHumanQuestions.returns(null);
      mockConfig.getLlmoAIQuestions.returns(undefined);

      // Use an invalid question key so the validation will fail
      mockContext.params.questionKey = 'invalid-question-key';

      try {
        await controller.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid question key');
      }
    });
  });

  describe('patchLlmoQuestion', () => {
    it('should update question successfully', async () => {
      const updateData = { question: 'Updated question?' };
      mockContext.data = updateData;

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.updateLlmoQuestion).to.have.been.calledWith('test-question', updateData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';

      try {
        await controller.patchLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid question key');
      }
    });

    it('should handle site save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);
      const updateData = { question: 'Updated question?' };
      mockContext.data = updateData;

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.updateLlmoQuestion).to.have.been.calledWith('test-question', updateData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error updating question for site\'s llmo config test-site-id: Database connection failed',
      );
    });
  });

  describe('getLlmoCustomerIntent', () => {
    it('should return LLMO customer intent successfully', async () => {
      const result = await controller.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
    });

    it('should return empty array when customer intent is not set', async () => {
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
      });

      const result = await controller.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
    });

    it('should return empty array when customer intent is null in config', async () => {
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
        customerIntent: null,
      });

      const result = await controller.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
    });
  });

  describe('addLlmoCustomerIntent', () => {
    it('should add customer intent successfully', async () => {
      mockContext.data = [
        { key: 'new_target', value: 'enterprise customers' },
        { key: 'new_goal', value: 'lead generation' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.calledOnce;
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.calledWith(mockContext.data);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should return bad request when no customer intent provided', async () => {
      mockContext.data = null;

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Customer intent must be provided as an array');
    });

    it('should return bad request when customer intent is not an array', async () => {
      mockContext.data = { key: 'target', value: 'customers' };

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Customer intent must be provided as an array');
    });

    it('should return bad request when customer intent item is missing key', async () => {
      mockContext.data = [
        { value: 'enterprise customers' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Each customer intent item must have both key and value properties');
    });

    it('should return bad request when customer intent item is missing value', async () => {
      mockContext.data = [
        { key: 'target_audience' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Each customer intent item must have both key and value properties');
    });

    it('should return bad request when customer intent key is not a string', async () => {
      mockContext.data = [
        { key: 123, value: 'enterprise customers' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Each customer intent item must have both key and value properties');
    });

    it('should return bad request when customer intent value is not a string', async () => {
      mockContext.data = [
        { key: 'target_audience', value: 123 },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Each customer intent item must have both key and value properties');
    });

    it('should handle save errors gracefully', async () => {
      mockContext.data = [
        { key: 'new_unique_key', value: 'enterprise customers' },
      ];
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.calledWith(mockContext.data);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error adding customer intent for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should handle null customer intent in response', async () => {
      mockContext.data = [
        { key: 'another_unique_key', value: 'enterprise customers' },
      ];

      // Mock getLlmoConfig to return null customerIntent after adding
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
        customerIntent: null,
      });

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.calledWith(mockContext.data);
    });

    it('should return bad request when customer intent key already exists', async () => {
      mockContext.data = [
        { key: 'target_audience', value: 'new value' }, // This key already exists in mockLlmoConfig
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal("Customer intent key 'target_audience' already exists");
    });

    it('should return bad request when duplicate keys in same request', async () => {
      mockContext.data = [
        { key: 'new_key', value: 'value1' },
        { key: 'new_key', value: 'value2' }, // Duplicate key in same request
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal("Duplicate customer intent key 'new_key' in request");
    });

    it('should handle null customer intent when checking for duplicates', async () => {
      // Mock getLlmoCustomerIntent to return null to test the || [] fallback
      mockConfig.getLlmoCustomerIntent.returns(null);

      mockContext.data = [
        { key: 'new_key', value: 'new value' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.calledWith(mockContext.data);
    });
  });

  describe('removeLlmoCustomerIntent', () => {
    beforeEach(() => {
      mockContext.params.intentKey = 'target_audience';
    });

    it('should remove customer intent successfully', async () => {
      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.removeLlmoCustomerIntent).to.have.been.calledWith('target_audience');
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should throw error for invalid customer intent key', async () => {
      mockConfig.getLlmoCustomerIntent.returns([]);

      try {
        await controller.removeLlmoCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid customer intent key');
      }
    });

    it('should handle save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.removeLlmoCustomerIntent).to.have.been.calledWith('target_audience');
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error removing customer intent for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should handle null/undefined customer intent gracefully', async () => {
      mockConfig.getLlmoCustomerIntent.returns(null);

      // Use an invalid intent key so the validation will fail
      mockContext.params.intentKey = 'invalid-intent-key';

      try {
        await controller.removeLlmoCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid customer intent key');
      }
    });

    it('should handle null customer intent in response after removal', async () => {
      // Mock getLlmoConfig to return null customerIntent after removal
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
        customerIntent: null,
      });

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
      expect(mockConfig.removeLlmoCustomerIntent).to.have.been.calledWith('target_audience');
    });
  });

  describe('patchLlmoCustomerIntent', () => {
    beforeEach(() => {
      mockContext.params.intentKey = 'target_audience';
      mockContext.data = { value: 'updated value' };
    });

    it('should update customer intent successfully', async () => {
      const updateData = { value: 'updated value' };
      mockContext.data = updateData;

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith('target_audience', updateData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should update customer intent key successfully', async () => {
      const updateData = { key: 'updated_target_audience', value: 'updated value' };
      mockContext.data = updateData;

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith('target_audience', updateData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should throw error for invalid customer intent key', async () => {
      mockConfig.getLlmoCustomerIntent.returns([]);

      try {
        await controller.patchLlmoCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid customer intent key');
      }
    });

    it('should return bad request when no update data provided', async () => {
      mockContext.data = null;

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Update data must be provided as an object');
    });

    it('should return bad request when update data is not an object', async () => {
      mockContext.data = 'invalid data';

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Update data must be provided as an object');
    });

    it('should return bad request when value is not a string', async () => {
      mockContext.data = { value: 123 };

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Customer intent value must be a non-empty string');
    });

    it('should handle save errors gracefully', async () => {
      const updateData = { value: 'updated value' };
      mockContext.data = updateData;
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.customerIntent);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith('target_audience', updateData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error updating customer intent for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should handle null customer intent in response after update', async () => {
      const updateData = { value: 'updated value' };
      mockContext.data = updateData;

      // Mock getLlmoConfig to return null customerIntent after update
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
        customerIntent: null,
      });

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith('target_audience', updateData);
    });
  });

  describe('patchLlmoCdnLogsFilter', () => {
    beforeEach(() => {
      mockContext.data = {
        cdnlogsFilter: [
          { key: 'user-agent', value: ['bot', 'crawler'], type: 'exclude' },
          { key: 'content-type', value: ['text/html'], type: 'include' },
        ],
      };
    });

    it('should update CDN logs filter successfully', async () => {
      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.cdnlogsFilter);
      expect(mockConfig.updateLlmoCdnlogsFilter).to.have.been
        .calledWith(mockContext.data.cdnlogsFilter);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should return bad request when no data provided', async () => {
      mockContext.data = null;

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Update data must be provided as an object');
    });

    it('should return bad request when data is not an object', async () => {
      mockContext.data = 'invalid data';

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Update data must be provided as an object');
    });

    it('should handle cdnlogsFilter being undefined', async () => {
      mockContext.data = { otherProperty: 'value' };

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.cdnlogsFilter);
      expect(mockConfig.updateLlmoCdnlogsFilter).to.have.been.calledWith(undefined);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should handle save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.cdnlogsFilter);
      expect(mockConfig.updateLlmoCdnlogsFilter).to.have.been
        .calledWith(mockContext.data.cdnlogsFilter);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error updating CDN logs filter for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should handle null cdnlogsFilter in response', async () => {
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
        cdnlogsFilter: null,
      });

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
      expect(mockConfig.updateLlmoCdnlogsFilter).to.have.been
        .calledWith(mockContext.data.cdnlogsFilter);
    });

    it('should return bad request when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('LLM Optimizer is not enabled for this site');
    });
  });

  describe('patchLlmoCdnBucketConfig', () => {
    beforeEach(() => {
      mockContext.data = {
        cdnBucketConfig: {
          bucketName: 'test-bucket',
          orgId: 'test-org-id',
        },
      };
    });

    it('should update CDN bucket config successfully', async () => {
      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.cdnBucketConfig);
    });

    it('should return bad request when no data provided', async () => {
      mockContext.data = null;

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Update data must be provided as an object');
    });

    it('should return bad request when data is not an object', async () => {
      mockContext.data = 'invalid data';

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Update data must be provided as an object');
    });

    it('should handle save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.cdnBucketConfig);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error updating CDN logs bucket config for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should handle null cdnBucketConfig in response', async () => {
      mockConfig.getLlmoConfig.returns({
        dataFolder: 'test-folder',
        brand: 'test-brand',
        cdnBucketConfig: null,
      });

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({});
    });

    it('should return bad request when getSiteAndValidateLlmo throws an error', async () => {
      const error = new Error('Site not found');
      mockDataAccess.Site.findById.rejects(error);

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Site not found');
      expect(mockLog.error).to.have.been.calledWith(
        'Error updating CDN bucket config for siteId: test-site-id, error: Site not found',
      );
    });
  });
});
