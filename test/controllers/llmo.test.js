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
    const LlmoController = await esmock('../../src/controllers/llmo/llmo.js', {
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

  describe('Controller Initialization', () => {
    it('should handle ElastiCache connection error gracefully', async () => {
      const connectionError = new Error('Connection failed');

      // Create mock cache service that fails to connect
      const mockCacheService = {
        connect: sinon.stub().rejects(connectionError),
      };

      // Create controller with failing cache service
      const LlmoControllerWithFailingCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
      });

      // Initialize controller - this should trigger the connection attempt
      const controllerWithFailingCache = LlmoControllerWithFailingCache(mockContext);

      // Wait a bit for the async connection attempt to complete
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      // Verify that the error was logged
      expect(mockLog.error).to.have.been.calledWith('Failed to connect to ElastiCache: Connection failed');

      // Verify controller still works despite cache connection failure
      expect(controllerWithFailingCache).to.be.an('object');
      expect(controllerWithFailingCache.getLlmoConfig).to.be.a('function');
    });
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
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
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

    it('should return cached data when cache hit occurs in getLlmoSheetData', async () => {
      const cachedData = { cached: true, data: [{ id: 1, name: 'cached' }] };

      // Create mock cache service
      const mockCacheService = {
        isReady: sinon.stub().returns(true),
        get: sinon.stub().resolves(cachedData), // Cache hit
        set: sinon.stub().resolves(true),
        connect: sinon.stub().resolves(),
      };

      // Mock ElastiCacheService
      const mockElastiCacheService = {
        generateCacheKey: sinon.stub().returns('test-sheet-cache-key'),
      };

      // Create controller with cache service
      const LlmoControllerWithCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          default: mockElastiCacheService,
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
      });

      const controllerWithCache = LlmoControllerWithCache(mockContext);

      mockContext.data = {
        limit: 10,
        offset: 0,
        sheet: 'test-sheet',
      };

      const result = await controllerWithCache.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(cachedData);
      expect(mockCacheService.get).to.have.been.calledWith('test-sheet-cache-key');
      // Should not call fetch since we got cache hit
      expect(tracingFetchStub).not.to.have.been.called;
    });

    it('should cache data when cacheService is ready and cache miss occurs in getLlmoSheetData', async () => {
      // Create mock cache service
      const mockCacheService = {
        isReady: sinon.stub().returns(true),
        get: sinon.stub().resolves(null), // Cache miss
        set: sinon.stub().resolves(true),
        connect: sinon.stub().resolves(),
      };

      // Mock ElastiCacheService
      const mockElastiCacheService = {
        generateCacheKey: sinon.stub().returns('test-sheet-cache-key'),
      };

      // Create controller with cache service
      const LlmoControllerWithCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          default: mockElastiCacheService,
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
      });

      const controllerWithCache = LlmoControllerWithCache(mockContext);

      const mockResponseData = { sheet: true, data: [{ id: 1, name: 'sheet-test' }] };
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
        headers: new Map([['content-type', 'application/json']]),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        limit: 10,
        offset: 0,
        sheet: 'test-sheet',
      };

      const result = await controllerWithCache.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockResponseData);
      expect(mockCacheService.get).to.have.been.calledWith('test-sheet-cache-key');
      expect(mockCacheService.set).to.have.been.calledWith('test-sheet-cache-key', mockResponseData);
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
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
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

  describe('queryLlmoSheetData', () => {
    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      tracingFetchStub.resolves(mockResponse);
      mockContext.data = null;
      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?limit=1000000',
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

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?limit=1000000',
        {
          headers: {
            Authorization: 'token hlx_api_key_missing',
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

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-data.json?limit=1000000',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle POST request with filters successfully', async () => {
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

      // Use new POST body format
      mockContext.data = {
        filters: {
          status: 'active',
          category: 'premium',
        },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

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

    it('should handle POST request with exclusions successfully', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John', password: 'secret1',
          },
          {
            id: 2, status: 'inactive', category: 'basic', name: 'Jane', password: 'secret2',
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Use new POST body format
      mockContext.data = {
        exclude: ['password'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should exclude password field
      expect(responseBody.data).to.deep.equal([
        {
          id: 1, status: 'active', category: 'premium', name: 'John',
        },
        {
          id: 2, status: 'inactive', category: 'basic', name: 'Jane',
        },
      ]);
    });

    it('should handle POST request with groupBy successfully', async () => {
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
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Use new POST body format
      mockContext.data = {
        groupBy: ['status'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should group by status
      expect(responseBody.data).to.have.length(2);

      const activeGroup = responseBody.data.find((group) => group.status === 'active');
      expect(activeGroup).to.exist;
      expect(activeGroup.records).to.have.length(2);
      expect(activeGroup.records).to.deep.include.members([
        { id: 1, category: 'premium', name: 'John' },
        { id: 3, category: 'premium', name: 'Bob' },
      ]);

      const inactiveGroup = responseBody.data.find((group) => group.status === 'inactive');
      expect(inactiveGroup).to.exist;
      expect(inactiveGroup.records).to.have.length(1);
      expect(inactiveGroup.records[0]).to.deep.equal({
        id: 2, category: 'basic', name: 'Jane',
      });
    });

    it('should validate request body structure', async () => {
      // Test invalid filters
      mockContext.data = {
        filters: 'invalid',
      };

      let result = await controller.queryLlmoSheetData(mockContext);
      expect(result.status).to.equal(400);
      let responseBody = await result.json();
      expect(responseBody.message).to.equal('filters must be an object');

      // Test invalid sheets
      mockContext.data = {
        sheets: 'invalid',
      };

      result = await controller.queryLlmoSheetData(mockContext);
      expect(result.status).to.equal(400);
      responseBody = await result.json();
      expect(responseBody.message).to.equal('sheets must be an array');

      // Test invalid exclude
      mockContext.data = {
        exclude: 'invalid',
      };

      result = await controller.queryLlmoSheetData(mockContext);
      expect(result.status).to.equal(400);
      responseBody = await result.json();
      expect(responseBody.message).to.equal('exclude must be an array');

      // Test invalid groupBy
      mockContext.data = {
        groupBy: 'invalid',
      };

      result = await controller.queryLlmoSheetData(mockContext);
      expect(result.status).to.equal(400);
      responseBody = await result.json();
      expect(responseBody.message).to.equal('groupBy must be an array');

      // Test invalid groupBy
      mockContext.data = {
        include: 'invalid',
      };

      result = await controller.queryLlmoSheetData(mockContext);
      expect(result.status).to.equal(400);
      responseBody = await result.json();
      expect(responseBody.message).to.equal('include must be an array');
    });

    it('should handle POST request with inclusions successfully', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John', password: 'secret1', metadata: { role: 'admin' },
          },
          {
            id: 2, status: 'inactive', category: 'basic', name: 'Jane', password: 'secret2', metadata: { role: 'user' },
          },
          {
            id: 3, status: 'active', category: 'premium', name: 'Bob', password: 'secret3', metadata: { role: 'user' },
          },
          {
            id: 4, status: 'active', category: 'basic', name: 'Alice', password: 'secret4', metadata: { role: 'admin' },
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Apply filters, exclusions, and grouping
      mockContext.data = {
        filters: {
          status: 'active',
        },
        include: ['name', 'status', 'category'],
        groupBy: ['category'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should first filter (only active users), then exclude attributes, then group by category
      expect(responseBody.data).to.have.length(2);

      const premiumGroup = responseBody.data.find((group) => group.category === 'premium');
      expect(premiumGroup).to.exist;
      expect(premiumGroup.records).to.have.length(2);
      expect(premiumGroup.records).to.deep.include.members([
        { name: 'John', status: 'active' },
        { name: 'Bob', status: 'active' },
      ]);

      const basicGroup = responseBody.data.find((group) => group.category === 'basic');
      expect(basicGroup).to.exist;
      expect(basicGroup.records).to.have.length(1);
      expect(basicGroup.records[0]).to.deep.equal({
        name: 'Alice', status: 'active',
      });
    });

    it('should handle combined filters, exclusions, and grouping', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John', password: 'secret1', metadata: { role: 'admin' },
          },
          {
            id: 2, status: 'inactive', category: 'basic', name: 'Jane', password: 'secret2', metadata: { role: 'user' },
          },
          {
            id: 3, status: 'active', category: 'premium', name: 'Bob', password: 'secret3', metadata: { role: 'user' },
          },
          {
            id: 4, status: 'active', category: 'basic', name: 'Alice', password: 'secret4', metadata: { role: 'admin' },
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      // Apply filters, exclusions, and grouping
      mockContext.data = {
        filters: {
          status: 'active',
        },
        exclude: ['password', 'metadata'],
        groupBy: ['category'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should first filter (only active users), then exclude attributes, then group by category
      expect(responseBody.data).to.have.length(2);

      const premiumGroup = responseBody.data.find((group) => group.category === 'premium');
      expect(premiumGroup).to.exist;
      expect(premiumGroup.records).to.have.length(2);
      expect(premiumGroup.records).to.deep.include.members([
        { id: 1, status: 'active', name: 'John' },
        { id: 3, status: 'active', name: 'Bob' },
      ]);

      const basicGroup = responseBody.data.find((group) => group.category === 'basic');
      expect(basicGroup).to.exist;
      expect(basicGroup.records).to.have.length(1);
      expect(basicGroup.records[0]).to.deep.equal({
        id: 4, status: 'active', name: 'Alice',
      });
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

      mockContext.data = {
        filters: {
          status: 'ACTIVE',
        },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should match both 'Active' and 'active' due to case-insensitive matching
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data).to.deep.equal([
        { id: 1, name: 'JOHN', status: 'Active' },
        { id: 3, name: 'Bob', status: 'active' },
      ]);
    });

    it('should filter data with multi-sheet type', async () => {
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

      mockContext.data = {
        filters: {
          status: 'active',
        },
        include: ['id', 'status', 'category'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

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

      mockContext.data = {
        filters: {
          category: 'premium',
        },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should only return items with non-null/undefined matching values
      expect(responseBody.data).to.have.length(1);
      expect(responseBody.data).to.deep.equal([
        { id: 3, status: 'active', category: 'premium' },
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

      mockContext.data = {
        filters: {
          status: 'pending',
        },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should return empty data array
      expect(responseBody[':type']).to.equal('sheet');
      expect(responseBody.data).to.have.length(0);
      expect(responseBody.data).to.deep.equal([]);
    });

    it('should exclude attributes from multi-sheet type data', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            {
              id: 1, status: 'active', category: 'premium', description: 'User 1', metadata: { type: 'user' },
            },
            {
              id: 2, status: 'inactive', category: 'basic', description: 'User 2', metadata: { type: 'admin' },
            },
          ],
        },
        sheet2: {
          data: [
            {
              id: 3, status: 'active', category: 'basic', description: 'User 3', metadata: { type: 'guest' },
            },
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

      mockContext.data = {
        exclude: ['description', 'metadata'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should exclude attributes from all sheets
      expect(responseBody[':type']).to.equal('multi-sheet');
      expect(responseBody.sheet1.data).to.deep.equal([
        { id: 1, status: 'active', category: 'premium' },
        { id: 2, status: 'inactive', category: 'basic' },
      ]);
      expect(responseBody.sheet2.data).to.deep.equal([
        { id: 3, status: 'active', category: 'basic' },
      ]);
      // Metadata should remain unchanged
      expect(responseBody.metadata).to.deep.equal({ totalSheets: 2 });
    });

    it('should exclude multiple attributes from sheet data', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John', description: 'User description', metadata: { created: '2023-01-01' },
          },
          {
            id: 2, status: 'inactive', category: 'basic', name: 'Jane', description: 'Another description', metadata: { created: '2023-01-02' },
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        exclude: ['description', 'metadata'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should exclude description and metadata attributes
      expect(responseBody[':type']).to.equal('sheet');
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data).to.deep.equal([
        {
          id: 1, status: 'active', category: 'premium', name: 'John',
        },
        {
          id: 2, status: 'inactive', category: 'basic', name: 'Jane',
        },
      ]);
    });

    it('should handle exclusions when attributes do not exist in data', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'John', email: 'john@example.com' },
          { id: 2, name: 'Jane', email: 'jane@example.com' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        exclude: ['password', 'metadata', 'nonexistent'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should return data unchanged since attributes don't exist
      expect(responseBody.data).to.deep.equal([
        { id: 1, name: 'John', email: 'john@example.com' },
        { id: 2, name: 'Jane', email: 'jane@example.com' },
      ]);
    });

    it('should group data by multiple attributes', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John', price: 100,
          },
          {
            id: 2, status: 'inactive', category: 'basic', name: 'Jane', price: 50,
          },
          {
            id: 3, status: 'active', category: 'premium', name: 'Bob', price: 150,
          },
          {
            id: 4, status: 'active', category: 'basic', name: 'Alice', price: 75,
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        groupBy: ['status', 'category'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should group by status and category
      expect(responseBody[':type']).to.equal('sheet');
      expect(responseBody.data).to.have.length(3);

      // Find each group and verify structure
      const activeBasicGroup = responseBody.data.find((g) => g.status === 'active' && g.category === 'basic');
      expect(activeBasicGroup).to.exist;
      expect(activeBasicGroup.records).to.have.length(1);
      expect(activeBasicGroup.records[0]).to.deep.equal({
        id: 4, name: 'Alice', price: 75,
      });

      const activePremiumGroup = responseBody.data.find((g) => g.status === 'active' && g.category === 'premium');
      expect(activePremiumGroup).to.exist;
      expect(activePremiumGroup.records).to.have.length(2);
      expect(activePremiumGroup.records).to.deep.include.members([
        { id: 1, name: 'John', price: 100 },
        { id: 3, name: 'Bob', price: 150 },
      ]);

      const inactiveBasicGroup = responseBody.data.find((g) => g.status === 'inactive' && g.category === 'basic');
      expect(inactiveBasicGroup).to.exist;
      expect(inactiveBasicGroup.records).to.have.length(1);
      expect(inactiveBasicGroup.records[0]).to.deep.equal({
        id: 2, name: 'Jane', price: 50,
      });
    });

    it('should group data with multi-sheet type', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
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
          ],
        },
        sheet2: {
          data: [
            {
              id: 4, status: 'active', category: 'basic', name: 'Alice',
            },
            {
              id: 5, status: 'active', category: 'premium', name: 'Charlie',
            },
            {
              id: 6, status: 'inactive', category: 'premium', name: 'David',
            },
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

      mockContext.data = {
        groupBy: ['status'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should group data in all sheets
      expect(responseBody[':type']).to.equal('multi-sheet');

      // Check sheet1 grouping
      expect(responseBody.sheet1.data).to.have.length(2);
      const sheet1ActiveGroup = responseBody.sheet1.data.find((group) => group.status === 'active');
      expect(sheet1ActiveGroup).to.exist;
      expect(sheet1ActiveGroup.records).to.have.length(2);
      expect(sheet1ActiveGroup.records).to.deep.include.members([
        { id: 1, category: 'premium', name: 'John' },
        { id: 3, category: 'premium', name: 'Bob' },
      ]);

      const sheet1InactiveGroup = responseBody.sheet1.data.find((group) => group.status === 'inactive');
      expect(sheet1InactiveGroup).to.exist;
      expect(sheet1InactiveGroup.records).to.have.length(1);
      expect(sheet1InactiveGroup.records[0]).to.deep.equal({
        id: 2, category: 'basic', name: 'Jane',
      });

      // Check sheet2 grouping
      expect(responseBody.sheet2.data).to.have.length(2);
      const sheet2ActiveGroup = responseBody.sheet2.data.find((group) => group.status === 'active');
      expect(sheet2ActiveGroup).to.exist;
      expect(sheet2ActiveGroup.records).to.have.length(2);
      expect(sheet2ActiveGroup.records).to.deep.include.members([
        { id: 4, category: 'basic', name: 'Alice' },
        { id: 5, category: 'premium', name: 'Charlie' },
      ]);

      const sheet2InactiveGroup = responseBody.sheet2.data.find((group) => group.status === 'inactive');
      expect(sheet2InactiveGroup).to.exist;
      expect(sheet2InactiveGroup.records).to.have.length(1);
      expect(sheet2InactiveGroup.records[0]).to.deep.equal({
        id: 6, category: 'premium', name: 'David',
      });

      // Metadata should remain unchanged
      expect(responseBody.metadata).to.deep.equal({ totalSheets: 2 });
    });

    it('should handle grouping when attribute values are null or undefined', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: null, name: 'John',
          },
          {
            id: 2, status: 'active', category: undefined, name: 'Jane',
          },
          {
            id: 3, status: 'active', category: 'premium', name: 'Bob',
          },
          {
            id: 4, status: 'active', category: null, name: 'Alice',
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        groupBy: ['category'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should group null and undefined values together
      expect(responseBody.data).to.have.length(2);

      const nullGroup = responseBody.data.find((group) => group.category === null);
      expect(nullGroup).to.exist;
      expect(nullGroup.records).to.have.length(3);
      expect(nullGroup.records).to.deep.include.members([
        { id: 1, status: 'active', name: 'John' },
        { id: 2, status: 'active', name: 'Jane' },
        { id: 4, status: 'active', name: 'Alice' },
      ]);

      const premiumGroup = responseBody.data.find((group) => group.category === 'premium');
      expect(premiumGroup).to.exist;
      expect(premiumGroup.records).to.have.length(1);
      expect(premiumGroup.records[0]).to.deep.equal({
        id: 3, status: 'active', name: 'Bob',
      });
    });

    it('should handle grouping when attributes do not exist in data', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'John', email: 'john@example.com' },
          { id: 2, name: 'Jane', email: 'jane@example.com' },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        groupBy: ['status', 'category'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should group items with null values for missing attributes
      expect(responseBody.data).to.have.length(1);
      expect(responseBody.data[0]).to.deep.equal({
        status: null,
        category: null,
        records: [
          { id: 1, name: 'John', email: 'john@example.com' },
          { id: 2, name: 'Jane', email: 'jane@example.com' },
        ],
      });
    });

    it('should handle empty data array with all operations', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        filters: { status: 'active' },
        exclude: ['password'],
        groupBy: ['status'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should return empty array unchanged
      expect(responseBody[':type']).to.equal('sheet');
      expect(responseBody.data).to.have.length(0);
      expect(responseBody.data).to.deep.equal([]);
    });

    it('should handle data without :type property', async () => {
      const mockResponseData = {
        someProperty: 'value',
        data: [
          {
            id: 1, name: 'John', status: 'active', password: 'secret123',
          },
        ],
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        filters: { status: 'active' },
        exclude: ['password'],
        groupBy: ['status'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should return data unchanged since it doesn't match expected format
      expect(responseBody).to.deep.equal(mockResponseData);
    });

    it('should filter sheets when sheets parameter is provided for multi-sheet data', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            {
              id: 1, name: 'John', status: 'active',
            },
            {
              id: 2, name: 'Jane', status: 'inactive',
            },
          ],
        },
        sheet2: {
          data: [
            {
              id: 3, name: 'Bob', status: 'active',
            },
          ],
        },
        sheet3: {
          data: [
            {
              id: 4, name: 'Alice', status: 'pending',
            },
          ],
        },
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        sheets: ['sheet1', 'sheet3'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();

      // Should only include sheet1 and sheet3, excluding sheet2
      expect(responseBody[':type']).to.equal('multi-sheet');
      expect(responseBody.sheet1).to.exist;
      expect(responseBody.sheet3).to.exist;
      expect(responseBody.sheet2).to.not.exist;

      expect(responseBody.sheet1.data).to.deep.equal([
        {
          id: 1, name: 'John', status: 'active',
        },
        {
          id: 2, name: 'Jane', status: 'inactive',
        },
      ]);
      expect(responseBody.sheet3.data).to.deep.equal([
        {
          id: 4, name: 'Alice', status: 'pending',
        },
      ]);
    });

    it('should handle sheetType parameter in URL construction', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'analytics-data' }),
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheetType to the context params
      mockContext.params.sheetType = 'analytics';
      mockContext.data = {
        filters: { status: 'active' },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/analytics/test-data.json?limit=1000000',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': 'test-user-agent',
            'Accept-Encoding': 'gzip',
          },
        },
      );
    });

    it('should handle brand presence mappings', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        all: {
          data: [
            {
              Question: 'p1',
              Topic: 'c1',
              Keyword: 't1',
              'Sources Contain Brand Domain': 'c1',
              'Answer Contains Brand Name': 'm1',
              Url: 'u1',
            },
          ],
        },
      };

      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.params.dataSource = 'brandpresence-all-w00';
      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({
        ':type': 'multi-sheet',
        all: {
          data: [
            {
              Prompt: 'p1',
              Category: 'c1',
              Topics: 't1',
              Citations: 'c1',
              Mentions: 'm1',
              URL: 'u1',
            },
          ],
        },
      });
    });

    it('should handle external API errors', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        filters: { status: 'active' },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('External API returned 404: Not Found');
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network error');
      tracingFetchStub.rejects(networkError);

      mockContext.data = {
        filters: { status: 'active' },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Network error');
    });

    it('should handle access denied errors', async () => {
      // Create a new controller instance with a mock that denies access
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      mockContext.data = {
        filters: { status: 'active' },
      };

      const result = await controllerWithAccessDenied.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('LLM Optimizer is not enabled for this site');
    });

    it('should cache raw data when cacheService is ready in queryLlmoSheetData', async () => {
      // Create mock cache service
      const mockCacheService = {
        isReady: sinon.stub().returns(true),
        get: sinon.stub().resolves(null), // Cache miss
        set: sinon.stub().resolves(true),
        connect: sinon.stub().resolves(),
      };

      // Mock ElastiCacheService
      const mockElastiCacheService = {
        generateCacheKey: sinon.stub().returns('test-cache-key'),
      };

      // Create controller with cache service
      const LlmoControllerWithCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          default: mockElastiCacheService,
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
        '../../src/controllers/llmo/llmo-utils.js': {
          applyFilters: sinon.stub().returnsArg(0),
          applyInclusions: sinon.stub().returnsArg(0),
          applyExclusions: sinon.stub().returnsArg(0),
          applyGroups: sinon.stub().returnsArg(0),
          applyMappings: sinon.stub().returnsArg(0),
        },
        '../../src/controllers/llmo/llmo-mappings.js': {
          LLMO_SHEET_MAPPINGS: [],
        },
      });

      const controllerWithCache = LlmoControllerWithCache(mockContext);

      const mockResponseData = { data: [{ id: 1, name: 'test' }] };
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
        headers: new Map([['content-type', 'application/json']]),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        filters: { status: 'active' },
      };

      const result = await controllerWithCache.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(mockCacheService.set).to.have.been.calledWith('test-cache-key', mockResponseData);
    });

    it('should use cached raw data when cache hit occurs in queryLlmoSheetData', async () => {
      const cachedRawData = { cached: true, data: [{ id: 1, name: 'cached-raw' }] };

      // Create mock cache service
      const mockCacheService = {
        isReady: sinon.stub().returns(true),
        get: sinon.stub().resolves(cachedRawData), // Cache hit for raw data
        set: sinon.stub().resolves(true),
        connect: sinon.stub().resolves(),
      };

      // Mock ElastiCacheService
      const mockElastiCacheService = {
        generateCacheKey: sinon.stub().returns('test-raw-cache-key'),
      };

      // Create controller with cache service
      const LlmoControllerWithCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          default: mockElastiCacheService,
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
        '../../src/controllers/llmo/llmo-utils.js': {
          applyFilters: sinon.stub().returnsArg(0),
          applyInclusions: sinon.stub().returnsArg(0),
          applyExclusions: sinon.stub().returnsArg(0),
          applyGroups: sinon.stub().returnsArg(0),
          applyMappings: sinon.stub().returnsArg(0),
        },
        '../../src/controllers/llmo/llmo-mappings.js': {
          LLMO_SHEET_MAPPINGS: [],
        },
      });

      const controllerWithCache = LlmoControllerWithCache(mockContext);

      mockContext.data = {
        filters: { status: 'active' },
      };

      const result = await controllerWithCache.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(cachedRawData);
      expect(mockCacheService.get).to.have.been.calledWith('test-raw-cache-key');
      // Should not call fetch since we got cache hit for raw data
      expect(tracingFetchStub).not.to.have.been.called;
    });
  });

  describe('getLlmoGlobalSheetData - Cache Tests', () => {
    it('should return cached data when cache hit occurs', async () => {
      const cachedData = { cached: true, data: [{ id: 1, name: 'cached' }] };

      // Create mock cache service
      const mockCacheService = {
        isReady: sinon.stub().returns(true),
        get: sinon.stub().resolves(cachedData), // Cache hit
        set: sinon.stub().resolves(true),
        connect: sinon.stub().resolves(),
      };

      // Mock ElastiCacheService
      const mockElastiCacheService = {
        generateGlobalCacheKey: sinon.stub().returns('test-global-cache-key'),
      };

      // Create controller with cache service
      const LlmoControllerWithCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          default: mockElastiCacheService,
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
      });

      const controllerWithCache = LlmoControllerWithCache(mockContext);

      mockContext.data = {
        limit: 10,
        offset: 0,
        sheet: 'test-sheet',
      };

      const result = await controllerWithCache.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(cachedData);
      expect(mockCacheService.get).to.have.been.calledWith('test-global-cache-key');
      // Should not call fetch since we got cache hit
      expect(tracingFetchStub).not.to.have.been.called;
    });

    it('should cache data when cacheService is ready and cache miss occurs', async () => {
      // Create mock cache service
      const mockCacheService = {
        isReady: sinon.stub().returns(true),
        get: sinon.stub().resolves(null), // Cache miss
        set: sinon.stub().resolves(true),
        connect: sinon.stub().resolves(),
      };

      // Mock ElastiCacheService
      const mockElastiCacheService = {
        generateGlobalCacheKey: sinon.stub().returns('test-global-cache-key'),
      };

      // Create controller with cache service
      const LlmoControllerWithCache = await esmock('../../src/controllers/llmo/llmo.js', {
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: 'test-user-agent',
          tracingFetch: tracingFetchStub,
          hasText: (str) => str && str.trim().length > 0,
          isObject: (obj) => obj && typeof obj === 'object' && !Array.isArray(obj),
        },
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(true),
        },
        '../../src/support/elasticache.js': {
          default: mockElastiCacheService,
          createElastiCacheService: sinon.stub().returns(mockCacheService),
        },
      });

      const controllerWithCache = LlmoControllerWithCache(mockContext);

      const mockResponseData = { global: true, data: [{ id: 1, name: 'global-test' }] };
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves(mockResponseData),
        headers: new Map([['content-type', 'application/json']]),
      };
      tracingFetchStub.resolves(mockResponse);

      mockContext.data = {
        limit: 10,
        offset: 0,
        sheet: 'test-sheet',
      };

      const result = await controllerWithCache.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockResponseData);
      expect(mockCacheService.get).to.have.been.calledWith('test-global-cache-key');
      expect(mockCacheService.set).to.have.been.calledWith('test-global-cache-key', mockResponseData);
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

    it('should return 403 when user does not have access to the site', async () => {
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      const result = await controllerWithAccessDenied.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('should return 400 for other errors from getSiteAndValidateLlmo', async () => {
      // Mock Site.findById to throw a generic error
      mockDataAccess.Site.findById.rejects(new Error('Database connection failed'));

      const result = await controller.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Database connection failed');
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

    it('should return 403 when user does not have access to the site', async () => {
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      mockContext.data = [
        { key: 'new_target', value: 'enterprise customers' },
      ];

      const result = await controllerWithAccessDenied.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('should return 400 for other errors from getSiteAndValidateLlmo', async () => {
      // Mock Site.findById to throw a generic error
      mockDataAccess.Site.findById.rejects(new Error('Database connection failed'));

      mockContext.data = [
        { key: 'new_target', value: 'enterprise customers' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Database connection failed');
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

    it('should return bad request for invalid customer intent key', async () => {
      mockConfig.getLlmoCustomerIntent.returns([]);

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Invalid customer intent key');
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

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Invalid customer intent key');
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

    it('should return 403 when user does not have access to the site', async () => {
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      const result = await controllerWithAccessDenied.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('should return 400 for other errors from getSiteAndValidateLlmo', async () => {
      // Mock Site.findById to throw a generic error (not access control or validation error)
      mockDataAccess.Site.findById.rejects(new Error('Database connection failed'));

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Database connection failed');
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

    it('should return bad request for invalid customer intent key', async () => {
      mockConfig.getLlmoCustomerIntent.returns([]);

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('Invalid customer intent key');
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

    it('should return 403 when user does not have access to the site', async () => {
      const LlmoControllerWithAccessDenied = await esmock('../../src/controllers/llmo/llmo.js', {
        '../../src/support/access-control-util.js': {
          default: createMockAccessControlUtil(false),
        },
      });

      const controllerWithAccessDenied = LlmoControllerWithAccessDenied(mockContext);

      const result = await controllerWithAccessDenied.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('should return 400 for other errors from getSiteAndValidateLlmo', async () => {
      // Mock Site.findById to throw a generic error (not access control or validation error)
      mockDataAccess.Site.findById.rejects(new Error('Database connection failed'));

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Database connection failed');
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
