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
import { S3Client } from '@aws-sdk/client-s3';
import { llmoConfig } from '@adobe/spacecat-shared-utils';

use(sinonChai);

// Constants
const TEST_SITE_ID = 'test-site-id';
const TEST_ORG_ID = 'test-org-id';
const TEST_IMS_ORG_ID = 'test-ims-org-id';
const TEST_FOLDER = 'test-folder';
const TEST_BRAND = 'test-brand';
const TEST_API_KEY = 'test-api-key';
const TEST_USER_AGENT = 'test-user-agent';
const TEST_BUCKET = 'test-bucket';
const TEST_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/audit-jobs-queue';
const CATEGORY_ID = '123e4567-e89b-12d3-a456-426614174000';
const TOPIC_ID = '456e7890-e89b-12d3-a456-426614174001';
const EXTERNAL_API_BASE_URL = 'https://main--project-elmo-ui-data--adobe.aem.live';

const createMockResponse = (data, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'Not Found',
  json: sinon.stub().resolves(data),
  headers: { entries: sinon.stub().returns([]) },
});

const createMockAccessControlUtil = (accessResult) => ({
  fromContext: (context) => ({
    log: context.log,
    hasAccess: async () => accessResult,
  }),
});

describe('LlmoController', () => {
  let controller;
  let controllerWithAccessDenied;
  let LlmoController;
  let mockContext;
  let mockSite;
  let mockConfig;
  let mockLlmoConfig;
  let mockDataAccess;
  let mockLog;
  let mockEnv;
  let s3Client;
  let tracingFetchStub;
  let readConfigStub;
  let writeConfigStub;
  let llmoConfigSchemaStub;

  before(async () => {
    // Set up esmock once for all tests
    LlmoController = await esmock('../../../src/controllers/llmo/llmo.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: TEST_USER_AGENT,
        tracingFetch: (...args) => tracingFetchStub(...args),
        llmoConfig: {
          defaultConfig: llmoConfig.defaultConfig,
          readConfig: (...args) => readConfigStub(...args),
          writeConfig: (...args) => writeConfigStub(...args),
        },
        schemas: {
          llmoConfig: { safeParse: (...args) => llmoConfigSchemaStub.safeParse(...args) },
        },
        hasText: (str) => typeof str === 'string' && str.trim().length > 0,
        isObject: (obj) => obj !== null && typeof obj === 'object' && !Array.isArray(obj),
        composeBaseURL: (domain) => (domain.startsWith('http') ? domain : `https://${domain}`),
      },
      '../../../src/support/access-control-util.js': {
        default: class MockAccessControlUtil {
          static fromContext(context) {
            return new MockAccessControlUtil(context);
          }

          constructor(context) {
            this.log = context.log;
          }

          // eslint-disable-next-line class-methods-use-this
          async hasAccess() {
            return true;
          }
        },
      },
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem: sinon.stub().returnsArg(0) },
      },
    });

    // Create controller with access denied for access control tests
    const LlmoControllerDenied = await esmock('../../../src/controllers/llmo/llmo.js', {
      '../../../src/support/access-control-util.js': {
        default: createMockAccessControlUtil(false),
      },
    });
    controllerWithAccessDenied = LlmoControllerDenied;
  });

  beforeEach(async () => {
    mockLlmoConfig = {
      dataFolder: TEST_FOLDER,
      brand: TEST_BRAND,
      questions: {
        Human: [{ key: 'test-question', question: 'What is the main goal of this page?' }],
        AI: [{ key: 'ai-question', question: 'Analyze the page content and identify key themes.' }],
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
        bucketName: TEST_BUCKET,
        orgId: TEST_ORG_ID,
        cdnProvider: 'aem-cs-fastly',
      },
    };

    s3Client = sinon.createStubInstance(S3Client);

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
      getLlmoDataFolder: sinon.stub().returns(TEST_FOLDER),
      getLlmoBrand: sinon.stub().returns(TEST_BRAND),
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

    const mockOrganization = {
      getId: sinon.stub().returns(TEST_ORG_ID),
      getImsOrgId: sinon.stub().returns(TEST_IMS_ORG_ID),
    };

    mockSite = {
      getId: sinon.stub().returns(TEST_SITE_ID),
      getConfig: sinon.stub().returns(mockConfig),
      setConfig: sinon.stub(),
      save: sinon.stub().resolves(),
      getOrganization: sinon.stub().resolves(mockOrganization),
    };

    mockDataAccess = {
      Site: { findById: sinon.stub().resolves(mockSite) },
      Entitlement: {
        PRODUCT_CODES: { LLMO: 'llmo' },
        findByOrganizationIdAndProductCode: sinon.stub().resolves({
          getId: sinon.stub().returns('entitlement-123'),
          getProductCode: sinon.stub().returns('llmo'),
          getTier: sinon.stub().returns('premium'),
        }),
        TIERS: { FREE_TRIAL: 'free_trial' },
      },
      SiteEnrollment: {
        allBySiteId: sinon.stub().resolves([{
          getEntitlementId: sinon.stub().returns('entitlement-123'),
        }]),
      },
      TrialUser: {
        findByEmailId: sinon.stub().resolves(null),
        STATUSES: { REGISTERED: 'registered' },
      },
      OrganizationIdentityProvider: {
        allByOrganizationId: sinon.stub().resolves([]),
        create: sinon.stub().resolves({ provider: 'GOOGLE' }),
        PROVIDER_TYPES: { GOOGLE: 'GOOGLE', AZURE: 'AZURE' },
      },
      Configuration: { findLatest: sinon.stub() },
    };

    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
      warn: sinon.stub(),
    };

    mockEnv = {
      LLMO_HLX_API_KEY: TEST_API_KEY,
      AUDIT_JOBS_QUEUE_URL: TEST_QUEUE_URL,
    };

    mockContext = {
      params: {
        siteId: TEST_SITE_ID,
        dataSource: 'test-data',
        configName: 'test-data',
        questionKey: 'test-question',
      },
      data: {
        Human: [{ question: 'New human question?' }],
        AI: [{ question: 'New AI question?' }],
      },
      dataAccess: mockDataAccess,
      log: mockLog,
      env: mockEnv,
      s3: { s3Client, s3Bucket: TEST_BUCKET },
      sqs: { sendMessage: sinon.stub().resolves() },
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
            sub: 'test-user-id',
          }),
        },
      },
      pathInfo: { method: 'GET', suffix: '/llmo/sheet-data' },
    };

    tracingFetchStub = sinon.stub();
    readConfigStub = sinon.stub();
    writeConfigStub = sinon.stub();
    llmoConfigSchemaStub = {
      safeParse: sinon.stub().returns({ success: true, data: {} }),
    };

    // Use the global LlmoController from before hook
    controller = LlmoController(mockContext);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getLlmoSheetData', () => {
    const testUrl = `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/test-data.json`;

    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(testUrl, {
        headers: {
          Authorization: `token ${TEST_API_KEY}`,
          'User-Agent': TEST_USER_AGENT,
          'Accept-Encoding': 'br, gzip, deflate',
        },
      });
    });

    ['limit', 'offset', 'sheet'].forEach((param) => {
      it(`should add ${param} query parameter to URL when provided`, async () => {
        const mockResponse = createMockResponse({ data: 'test-data' });
        tracingFetchStub.resolves(mockResponse);
        mockContext.data[param] = param === 'sheet' ? 'analytics-sheet' : '10';

        await controller.getLlmoSheetData(mockContext);

        const expectedUrl = `${testUrl}?${param}=${mockContext.data[param]}`;
        expect(tracingFetchStub).to.have.been.calledWith(expectedUrl, sinon.match.object);
      });
    });

    it('should add multiple query parameters to URL when provided', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      tracingFetchStub.resolves(mockResponse);
      mockContext.data = { limit: '10', offset: '20', sheet: 'analytics-sheet' };

      await controller.getLlmoSheetData(mockContext);

      expect(tracingFetchStub).to.have.been.calledWith(
        `${testUrl}?limit=10&offset=20&sheet=analytics-sheet`,
        sinon.match.object,
      );
    });

    it('should handle sheetType parameter in URL construction', async () => {
      const mockResponse = createMockResponse({ data: 'analytics-data' });
      tracingFetchStub.resolves(mockResponse);
      mockContext.params.sheetType = 'analytics';

      await controller.getLlmoSheetData(mockContext);

      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/analytics/test-data.json`,
        sinon.match.object,
      );
    });

    [null, '', undefined].forEach((value) => {
      it(`should not add query parameters when they are ${value}`, async () => {
        const mockResponse = createMockResponse({ data: 'test-data' });
        tracingFetchStub.resolves(mockResponse);
        mockContext.data = { limit: value, offset: value, sheet: value };

        await controller.getLlmoSheetData(mockContext);

        expect(tracingFetchStub).to.have.been.calledWith(testUrl, sinon.match.object);
      });
    });

    it('should use fallback API key when env.LLMO_HLX_API_KEY is undefined', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      tracingFetchStub.resolves(mockResponse);
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      await controller.getLlmoSheetData(mockContext);

      expect(tracingFetchStub).to.have.been.calledWith(testUrl, {
        headers: {
          Authorization: 'token hlx_api_key_missing',
          'User-Agent': TEST_USER_AGENT,
          'Accept-Encoding': 'br, gzip, deflate',
        },
      });
    });

    it('should handle external API errors', async () => {
      const mockResponse = createMockResponse(null, false, 404);
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('External API returned 404');
    });

    it('should handle network errors', async () => {
      tracingFetchStub.rejects(new Error('Network error'));

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
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Only users belonging to the organization can view its sites');
    });

    it('should handle response headers correctly', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      mockResponse.headers = {
        entries: sinon.stub().returns([['x-custom-header', 'value']]),
      };
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
    });

    it('should handle missing response headers gracefully', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      mockResponse.headers = null;
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(await result.json()).to.deep.equal({ data: 'test-data' });
    });

    it('should handle week parameter in URL construction', async () => {
      const mockResponse = createMockResponse({ data: 'weekly-data' });
      tracingFetchStub.resolves(mockResponse);
      mockContext.params.sheetType = 'analytics';
      mockContext.params.week = 'w01';

      await controller.getLlmoSheetData(mockContext);

      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/analytics/w01/test-data.json`,
        sinon.match.object,
      );
    });

    it('should handle week parameter with query params', async () => {
      const mockResponse = createMockResponse({ data: 'weekly-data' });
      tracingFetchStub.resolves(mockResponse);
      mockContext.params.sheetType = 'analytics';
      mockContext.params.week = 'w02';
      mockContext.data = { limit: '50', offset: '10' };

      await controller.getLlmoSheetData(mockContext);

      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/analytics/w02/test-data.json?limit=50&offset=10`,
        sinon.match.object,
      );
    });

    it('should ignore week parameter when sheetType is not provided', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      tracingFetchStub.resolves(mockResponse);
      mockContext.params.week = 'w01';
      delete mockContext.params.sheetType;

      await controller.getLlmoSheetData(mockContext);

      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/test-data.json`,
        sinon.match.object,
      );
    });
  });

  describe('getLlmoGlobalSheetData', () => {
    const testUrl = `${EXTERNAL_API_BASE_URL}/llmo-global/test-data.json`;

    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(testUrl, sinon.match.object);
    });

    ['limit', 'offset', 'sheet'].forEach((param) => {
      it(`should add ${param} query parameter to URL when provided`, async () => {
        const mockResponse = createMockResponse({ data: 'test-data' });
        tracingFetchStub.resolves(mockResponse);
        mockContext.data[param] = param === 'sheet' ? 'analytics-sheet' : '10';

        await controller.getLlmoGlobalSheetData(mockContext);

        const expectedUrl = `${testUrl}?${param}=${mockContext.data[param]}`;
        expect(tracingFetchStub).to.have.been.calledWith(expectedUrl, sinon.match.object);
      });
    });

    it('should handle external API errors', async () => {
      const mockResponse = createMockResponse(null, false, 404);
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should use fallback API key when env.LLMO_HLX_API_KEY is undefined', async () => {
      tracingFetchStub.resolves(createMockResponse({ data: 'test-data' }));
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        sinon.match.string,
        sinon.match({ headers: sinon.match({ Authorization: 'token hlx_api_key_missing' }) }),
      );
    });

    it('should handle undefined response headers', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      mockResponse.headers = undefined;
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.getLlmoGlobalSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(await result.json()).to.deep.equal({ data: 'test-data' });
    });
  });

  describe('queryLlmoSheetData', () => {
    const testUrl = `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/test-data.json?limit=1000000`;

    beforeEach(() => {
      mockContext.data = null;
    });

    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = createMockResponse({ data: 'test-data' });
      tracingFetchStub.resolves(mockResponse);

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(tracingFetchStub).to.have.been.calledWith(testUrl, sinon.match.object);
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
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = {
        filters: { status: 'active', category: 'premium' },
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data).to.deep.include({
        id: 1, status: 'active', category: 'premium', name: 'John',
      });
      expect(responseBody.data).to.deep.include({
        id: 3, status: 'active', category: 'premium', name: 'Bob',
      });
    });

    it('should handle POST request with filters on multi-sheet data', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            { id: 1, status: 'active', category: 'premium' },
            { id: 2, status: 'inactive', category: 'basic' },
          ],
        },
        sheet2: {
          data: [
            { id: 3, status: 'active', category: 'basic' },
          ],
        },
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { filters: { status: 'active' } };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.sheet1.data).to.have.length(1);
      expect(responseBody.sheet2.data).to.have.length(1);
    });

    it('should handle filters with null/undefined values correctly', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          { id: 1, status: 'active', category: null },
          { id: 2, status: 'active', category: 'premium' },
          { id: 3, status: null, category: 'basic' },
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { filters: { status: 'active' } };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data.every((item) => item.status === 'active')).to.be.true;
    });

    it('should handle POST request with exclusions successfully', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: 'premium', name: 'John', password: 'secret1',
          },
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { exclude: ['password'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.data[0]).to.not.have.property('password');
    });

    it('should handle POST request with exclusions on multi-sheet data', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            { id: 1, name: 'John', password: 'secret1' },
          ],
        },
        sheet2: {
          data: [
            { id: 2, name: 'Jane', password: 'secret2' },
          ],
        },
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { exclude: ['password'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.sheet1.data[0]).to.not.have.property('password');
      expect(responseBody.sheet2.data[0]).to.not.have.property('password');
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
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { groupBy: ['status'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.data).to.have.length(2);
      expect(responseBody.data.find((g) => g.status === 'active')).to.exist;
    });

    it('should handle POST request with groupBy on multi-sheet data', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            { id: 1, status: 'active', name: 'John' },
            { id: 2, status: 'inactive', name: 'Jane' },
          ],
        },
        sheet2: {
          data: [
            { id: 3, status: 'active', name: 'Bob' },
          ],
        },
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { groupBy: ['status'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.sheet1.data).to.have.length(2);
      expect(responseBody.sheet2.data).to.have.length(1);
    });

    it('should handle groupBy with null/undefined values correctly', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', category: null, name: 'John',
          },
          {
            id: 2, status: 'active', category: 'premium', name: 'Jane',
          },
          {
            id: 3, status: null, category: 'basic', name: 'Bob',
          },
          {
            id: 4, status: 'active', category: null, name: 'Alice',
          },
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { groupBy: ['status', 'category'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.data).to.have.length(3);
      const nullStatusGroup = responseBody.data.find((g) => g.status === null);
      expect(nullStatusGroup).to.exist;
      expect(nullStatusGroup.records).to.have.length(1);
      const activeCategoryNullGroup = responseBody.data.find((g) => g.status === 'active' && g.category === null);
      expect(activeCategoryNullGroup).to.exist;
      expect(activeCategoryNullGroup.records).to.have.length(2);
    });

    ['filters', 'sheets', 'exclude', 'groupBy', 'include'].forEach((field) => {
      it(`should validate that ${field} is the correct type`, async () => {
        mockContext.data = { [field]: 'invalid' };

        const result = await controller.queryLlmoSheetData(mockContext);

        expect(result.status).to.equal(400);
        const responseBody = await result.json();
        expect(responseBody.message).to.include('must be');
      });
    });

    it('should handle brand presence mappings', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        all: {
          data: [{
            Question: 'p1',
            Topic: 'c1',
            Keyword: 't1',
            'Sources Contain Brand Domain': 'c1',
            'Answer Contains Brand Name': 'm1',
            Url: 'u1',
          }],
        },
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.params.dataSource = 'brandpresence-all-w00';

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.all.data[0]).to.have.property('Prompt', 'p1');
      expect(responseBody.all.data[0]).to.have.property('Category', 'c1');
    });

    it('should filter sheets when sheets parameter is provided', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: { data: [{ id: 1 }] },
        sheet2: { data: [{ id: 2 }] },
        sheet3: { data: [{ id: 3 }] },
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { sheets: ['sheet1', 'sheet3'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.sheet1).to.exist;
      expect(responseBody.sheet3).to.exist;
      expect(responseBody.sheet2).to.not.exist;
    });

    it('should handle inclusions parameter', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, name: 'John', email: 'john@example.com', password: 'secret',
          },
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { include: ['id', 'name'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.data[0]).to.have.property('id');
      expect(responseBody.data[0]).to.have.property('name');
      expect(responseBody.data[0]).to.not.have.property('email');
      expect(responseBody.data[0]).to.not.have.property('password');
    });

    it('should handle inclusions parameter on multi-sheet data', async () => {
      const mockResponseData = {
        ':type': 'multi-sheet',
        sheet1: {
          data: [
            { id: 1, name: 'John', email: 'john@example.com' },
          ],
        },
        sheet2: {
          data: [
            { id: 2, name: 'Jane', email: 'jane@example.com' },
          ],
        },
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.data = { include: ['id', 'name'] };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.sheet1.data[0]).to.have.property('id');
      expect(responseBody.sheet1.data[0]).to.have.property('name');
      expect(responseBody.sheet1.data[0]).to.not.have.property('email');
      expect(responseBody.sheet2.data[0]).to.not.have.property('email');
    });

    it('should log error when external API fails', async () => {
      const mockResponse = createMockResponse(null, false, 500);
      mockResponse.statusText = 'Internal Server Error';
      tracingFetchStub.resolves(mockResponse);
      mockContext.data = { filters: { status: 'active' } };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(400);
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to fetch data from external endpoint: 500/),
      );
    });

    it('should handle missing response headers in queryLlmoSheetData', async () => {
      const mockResponse = createMockResponse({ ':type': 'sheet', data: [{ id: 1 }] });
      mockResponse.headers = null;
      tracingFetchStub.resolves(mockResponse);
      mockContext.data = null;

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(await result.json()).to.deep.equal({ ':type': 'sheet', data: [{ id: 1 }] });
    });

    it('should use fallback API key when env.LLMO_HLX_API_KEY is undefined in queryLlmoSheetData', async () => {
      tracingFetchStub.resolves(createMockResponse({ ':type': 'sheet', data: [] }));
      mockContext.env.LLMO_HLX_API_KEY = undefined;
      mockContext.data = null;

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        sinon.match.string,
        sinon.match({ headers: sinon.match({ Authorization: 'token hlx_api_key_missing' }) }),
      );
    });

    it('should construct URL without sheetType when not provided', async () => {
      tracingFetchStub.resolves(createMockResponse({ ':type': 'sheet', data: [] }));
      mockContext.params.sheetType = undefined;
      mockContext.data = null;

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/test-data.json?limit=1000000`,
        sinon.match.object,
      );
    });

    it('should construct URL with sheetType when provided', async () => {
      tracingFetchStub.resolves(createMockResponse({ ':type': 'sheet', data: [] }));
      mockContext.params.sheetType = 'analytics';
      mockContext.data = null;

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/analytics/test-data.json?limit=1000000`,
        sinon.match.object,
      );
    });

    it('should handle week parameter in URL construction', async () => {
      tracingFetchStub.resolves(createMockResponse({ ':type': 'sheet', data: [] }));
      mockContext.params.sheetType = 'analytics';
      mockContext.params.week = 'w01';
      mockContext.data = null;

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/analytics/w01/test-data.json?limit=1000000`,
        sinon.match.object,
      );
    });

    it('should handle week parameter with filters and grouping', async () => {
      const mockResponseData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, status: 'active', week: 'w01', value: 100,
          },
          {
            id: 2, status: 'inactive', week: 'w01', value: 200,
          },
        ],
      };
      tracingFetchStub.resolves(createMockResponse(mockResponseData));
      mockContext.params.sheetType = 'analytics';
      mockContext.params.week = 'w01';
      mockContext.data = {
        filters: { status: 'active' },
        groupBy: ['status'],
      };

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/analytics/w01/test-data.json?limit=1000000`,
        sinon.match.object,
      );
      const responseBody = await result.json();
      expect(responseBody.data).to.have.length(1);
      expect(responseBody.data[0].status).to.equal('active');
    });

    it('should ignore week parameter when sheetType is not provided', async () => {
      tracingFetchStub.resolves(createMockResponse({ ':type': 'sheet', data: [] }));
      mockContext.params.week = 'w01';
      delete mockContext.params.sheetType;
      mockContext.data = null;

      const result = await controller.queryLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      expect(tracingFetchStub).to.have.been.calledWith(
        `${EXTERNAL_API_BASE_URL}/${TEST_FOLDER}/test-data.json?limit=1000000`,
        sinon.match.object,
      );
    });
  });

  describe('getLlmoConfig', () => {
    const expectedConfig = {
      ...llmoConfig.defaultConfig(),
      categories: {
        [CATEGORY_ID]: {
          name: 'test-category',
          region: ['us'],
          urls: [
            { value: 'https://example.com/tech', type: 'url' },
            { value: 'https://example.com/news/*', type: 'prefix' },
          ],
        },
      },
      topics: {
        [TOPIC_ID]: {
          name: 'test-topic',
          category: CATEGORY_ID,
          prompts: [{
            prompt: 'What is the main topic?',
            regions: ['us'],
            origin: 'human',
            source: 'config',
          }],
        },
      },
    };

    it('should return LLMO config from S3 successfully', async () => {
      readConfigStub.resolves({
        config: expectedConfig,
        exists: true,
        version: 'v123',
      });

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ config: expectedConfig, version: 'v123' });
    });

    it('should return bad request when s3 client is missing', async () => {
      delete mockContext.s3;

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('LLMO config storage is not configured for this environment');
    });

    it('should handle S3 errors when getting config', async () => {
      readConfigStub.rejects(new Error('S3 connection failed'));

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should return LLMO config with specific version successfully', async () => {
      readConfigStub.resolves({
        config: expectedConfig,
        exists: true,
        version: 'v123',
      });
      mockContext.data = { version: 'v123' };

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.version).to.equal('v123');
    });

    it('should return 404 when specific version does not exist', async () => {
      readConfigStub.resolves({
        config: llmoConfig.defaultConfig(),
        exists: false,
        version: null,
      });
      mockContext.data = { version: 'nonexistent-version' };

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(404);
      const responseBody = await result.json();
      expect(responseBody.message).to.include('not found');
    });

    it('should return default config when no version specified and config does not exist', async () => {
      readConfigStub.resolves({
        config: llmoConfig.defaultConfig(),
        exists: false,
        version: null,
      });
      mockContext.data = {};

      const result = await controller.getLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.version).to.be.null;
    });
  });

  describe('updateLlmoConfig', () => {
    const testData = {
      entities: {
        [CATEGORY_ID]: { type: 'category', name: 'test-category' },
        [TOPIC_ID]: { type: 'topic', name: 'test-topic' },
      },
      categories: {
        [CATEGORY_ID]: {
          name: 'test-category',
          region: ['us'],
          urls: [
            { value: 'https://example.com/tech', type: 'url' },
            { value: 'https://example.com/news/*', type: 'prefix' },
          ],
        },
      },
      topics: {
        [TOPIC_ID]: {
          name: 'test-topic',
          category: CATEGORY_ID,
          prompts: [{
            prompt: 'What is the main topic?',
            regions: ['us'],
            origin: 'human',
            source: 'config',
          }],
        },
      },
      brands: {
        aliases: [{
          aliases: ['test-brand'],
          category: CATEGORY_ID,
          region: ['us'],
        }],
      },
      competitors: {
        competitors: [{
          name: 'test-competitor',
          category: CATEGORY_ID,
          region: ['us'],
          aliases: ['competitor-alias'],
          urls: [],
        }],
      },
    };

    beforeEach(() => {
      writeConfigStub.resolves({ version: 'v1' });
      readConfigStub.resolves({
        config: llmoConfig.defaultConfig(),
        exists: false,
        version: null,
      });
      llmoConfigSchemaStub.safeParse.returns({ success: true, data: testData });
      mockContext.data = testData;
    });

    it('should write config to S3 successfully', async () => {
      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ version: 'v1' });
      expect(writeConfigStub).to.have.been.calledWith(
        TEST_SITE_ID,
        testData,
        s3Client,
        { s3Bucket: TEST_BUCKET },
      );
    });

    it('should override existing fields in prev config', async () => {
      readConfigStub.resolves({
        config: {
          field1: [1, 2, 3],
          field2: [2, 3],
          field3: [3, 4],
        },
        exists: true,
        version: 'v0',
      });
      mockContext.data = {
        field1: [1, 2, 3],
        field3: null,
        field4: [3, 4],
      };
      const expectedConfig = {
        field1: [1, 2, 3],
        field2: [2, 3],
        field3: null,
        field4: [3, 4],
      };
      llmoConfigSchemaStub.safeParse.returns({ success: true, data: expectedConfig });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
    });

    it('should trigger llmo-customer-analysis audit after writing config', async () => {
      readConfigStub.resolves({
        config: llmoConfig.defaultConfig(),
        exists: true,
        version: 'v0',
      });

      await controller.updateLlmoConfig(mockContext);

      expect(mockContext.sqs.sendMessage).to.have.been.calledWith(
        TEST_QUEUE_URL,
        {
          type: 'llmo-customer-analysis',
          siteId: TEST_SITE_ID,
          auditContext: {
            configVersion: 'v1',
            previousConfigVersion: 'v0',
          },
        },
      );
    });

    it('should return bad request when payload is not an object', async () => {
      mockContext.data = null;

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
      expect(writeConfigStub).to.not.have.been.called;
    });

    it('should return bad request when validation fails', async () => {
      llmoConfigSchemaStub.safeParse.returns({
        success: false,
        error: {
          message: 'Required field missing',
          issues: [{ path: ['categories'], message: 'Required' }],
        },
      });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
      expect(writeConfigStub).to.not.have.been.called;
    });

    it('should return bad request when s3 client is missing', async () => {
      delete mockContext.s3;

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should handle S3 error when writing config', async () => {
      writeConfigStub.rejects(new Error('S3 write failed'));
      readConfigStub.resolves({
        config: llmoConfig.defaultConfig(),
        exists: true,
        version: 'v0',
      });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should log config summary with user ID when updating config successfully', async () => {
      const configWithAllFields = {
        categories: {
          [CATEGORY_ID]: {
            name: 'test-category',
            region: ['us'],
            urls: [
              { value: 'https://example.com/tech', type: 'url' },
              { value: 'https://example.com/news/*', type: 'prefix' },
            ],
          },
        },
        topics: {
          [TOPIC_ID]: {
            name: 'test-topic',
            category: CATEGORY_ID,
            prompts: [
              {
                prompt: 'Prompt 1', regions: ['us'], origin: 'human', source: 'config',
              },
              {
                prompt: 'Prompt 2', regions: ['us'], origin: 'ai', source: 'config',
              },
            ],
          },
        },
        brands: {
          aliases: [
            {
              aliases: ['brand1', 'brand2'], category: CATEGORY_ID, region: ['us'],
            },
          ],
        },
        competitors: {
          competitors: [
            {
              name: 'competitor1', category: CATEGORY_ID, region: ['us'], aliases: [], urls: [],
            },
          ],
        },
        deleted: {
          prompts: {
            'deleted-prompt-1': {
              deletedAt: '2024-01-01',
            },
            'deleted-prompt-2': {
              deletedAt: '2024-01-02',
            },
          },
        },
      };
      mockContext.data = configWithAllFields;
      llmoConfigSchemaStub.safeParse.returns({ success: true, data: configWithAllFields });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/User test-user-id modifying customer configuration/)
          .and(sinon.match(/2 prompts/))
          .and(sinon.match(/1 categories/))
          .and(sinon.match(/1 topics/))
          .and(sinon.match(/1 brand aliases/))
          .and(sinon.match(/1 competitors/))
          .and(sinon.match(/2 deleted prompts/))
          .and(sinon.match(/2 category URLs/)),
      );
    });

    it('should use "unknown" as userId when sub is missing from profile', async () => {
      // Override getProfile to return profile without sub
      mockContext.attributes.authInfo.getProfile = () => ({
        email: 'test@example.com',
        trial_email: 'trial@example.com',
        first_name: 'Test',
        last_name: 'User',
        provider: 'GOOGLE',
        // sub is missing/undefined
      });
      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/User unknown modifying customer configuration/),
      );
    });

    it('should use "unknown" as userId in error when authInfo is missing', async () => {
      // Remove authInfo
      mockContext.attributes = {};
      writeConfigStub.rejects(new Error('S3 write failed'));
      readConfigStub.resolves({
        config: llmoConfig.defaultConfig(),
        exists: true,
        version: 'v0',
      });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(400);
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/User unknown error updating llmo config/),
      );
    });

    it('should correctly count category URLs in config summary', async () => {
      const configWithCategoryUrls = {
        categories: {
          [CATEGORY_ID]: {
            name: 'test-category-1',
            region: ['us'],
            urls: [
              { value: 'https://example.com/tech', type: 'url' },
              { value: 'https://example.com/news/*', type: 'prefix' },
              { value: 'https://example.com/blog/*', type: 'prefix' },
            ],
          },
          '456e7890-e89b-12d3-a456-426614174002': {
            name: 'test-category-2',
            region: ['eu'],
            urls: [
              { value: 'https://example.eu/tech', type: 'url' },
            ],
          },
          '789e1234-e89b-12d3-a456-426614174003': {
            name: 'test-category-3',
            region: ['us'],
            // No URLs property
          },
        },
        topics: {},
        brands: { aliases: [] },
        competitors: { competitors: [] },
      };
      mockContext.data = configWithCategoryUrls;
      llmoConfigSchemaStub.safeParse.returns({ success: true, data: configWithCategoryUrls });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/User test-user-id modifying customer configuration/)
          .and(sinon.match(/4 category URLs/)),
      );
    });

    it('should handle categories with no URLs when calculating URL count', async () => {
      const configWithoutUrls = {
        categories: {
          [CATEGORY_ID]: {
            name: 'test-category',
            region: ['us'],
            // No URLs property
          },
        },
        topics: {},
        brands: { aliases: [] },
        competitors: { competitors: [] },
      };
      mockContext.data = configWithoutUrls;
      llmoConfigSchemaStub.safeParse.returns({ success: true, data: configWithoutUrls });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/User test-user-id modifying customer configuration/)
          .and(sinon.match(/0 category URLs/)),
      );
    });

    it('should handle topics with no prompts when calculating prompt count', async () => {
      const configWithEmptyPrompts = {
        categories: {
          [CATEGORY_ID]: { name: 'test-category', region: ['us'] },
        },
        topics: {
          [TOPIC_ID]: {
            name: 'test-topic-1',
            category: CATEGORY_ID,
            prompts: [],
          },
          '456e7890-e89b-12d3-a456-426614174002': {
            name: 'test-topic-2',
            category: CATEGORY_ID,
          },
        },
      };
      mockContext.data = configWithEmptyPrompts;
      llmoConfigSchemaStub.safeParse.returns({ success: true, data: configWithEmptyPrompts });

      const result = await controller.updateLlmoConfig(mockContext);

      expect(result.status).to.equal(200);
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/0 prompts/),
      );
    });
  });

  describe('getLlmoQuestions', () => {
    it('should return LLMO questions successfully', async () => {
      const result = await controller.getLlmoQuestions(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
    });

    it('should return empty questions when not configured', async () => {
      mockConfig.getLlmoConfig.returns({ dataFolder: TEST_FOLDER, brand: TEST_BRAND });

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
      expect(mockConfig.addLlmoHumanQuestions).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should add AI questions successfully', async () => {
      mockContext.data = { AI: [{ question: 'New AI question?' }] };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoAIQuestions).to.have.been.calledOnce;
    });

    it('should return bad request when no questions provided', async () => {
      mockContext.data = null;

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should not save when no questions are added', async () => {
      mockContext.data = {};

      await controller.addLlmoQuestion(mockContext);

      expect(mockSite.save).to.not.have.been.called;
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Database connection failed'));

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockLog.error).to.have.been.called;
    });
  });

  describe('removeLlmoQuestion', () => {
    it('should remove question successfully', async () => {
      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.removeLlmoQuestion).to.have.been.calledWith('test-question');
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

    it('should handle null human and AI questions gracefully', async () => {
      mockConfig.getLlmoHumanQuestions.returns(null);
      mockConfig.getLlmoAIQuestions.returns(null);
      mockContext.params.questionKey = 'any-key';

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
      expect(mockConfig.updateLlmoQuestion).to.have.been.calledWith('test-question', updateData);
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
      mockConfig.getLlmoConfig.returns({ dataFolder: TEST_FOLDER, brand: TEST_BRAND });

      const result = await controller.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal([]);
    });

    it('should return 403 when user does not have access', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
    });

    it('should return 400 for database errors', async () => {
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const result = await controller.getLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('Database error');
    });
  });

  describe('addLlmoCustomerIntent', () => {
    it('should add customer intent successfully', async () => {
      mockContext.data = [
        { key: 'new_target', value: 'enterprise customers' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.calledWith(mockContext.data);
    });

    ['is not an array', 'item is missing key', 'item is missing value', 'key is not a string', 'value is not a string'].forEach((errorCase) => {
      it(`should return bad request when ${errorCase}`, async () => {
        if (errorCase === 'is not an array') {
          mockContext.data = { key: 'target', value: 'customers' };
        } else if (errorCase === 'item is missing key') {
          mockContext.data = [{ value: 'enterprise customers' }];
        } else if (errorCase === 'item is missing value') {
          mockContext.data = [{ key: 'target_audience' }];
        } else if (errorCase === 'key is not a string') {
          mockContext.data = [{ key: 123, value: 'enterprise customers' }];
        } else {
          mockContext.data = [{ key: 'target_audience', value: 123 }];
        }

        const result = await controller.addLlmoCustomerIntent(mockContext);

        expect(result.status).to.equal(400);
      });
    });

    it('should return bad request when customer intent key already exists', async () => {
      mockContext.data = [{ key: 'target_audience', value: 'new value' }];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should return bad request when duplicate keys in same request', async () => {
      mockContext.data = [
        { key: 'new_key', value: 'value1' },
        { key: 'new_key', value: 'value2' },
      ];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should handle null existing customer intent gracefully', async () => {
      mockConfig.getLlmoCustomerIntent.returns(null);
      mockContext.data = [{ key: 'new_key', value: 'new value' }];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoCustomerIntent).to.have.been.called;
    });

    it(
      'should return empty array when getLlmoConfig().customerIntent is null',
      async () => {
        mockConfig.getLlmoConfig.returns({
          dataFolder: TEST_FOLDER,
          brand: TEST_BRAND,
          customerIntent: null,
        });
        mockContext.data = [{ key: 'new_key', value: 'new value' }];

        const result = await controller.addLlmoCustomerIntent(mockContext);

        expect(result.status).to.equal(200);
        const body = await result.json();
        expect(body).to.be.an('array');
      },
    );

    it('should return 403 when user does not have access', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);
      mockContext.data = [{ key: 'new_target', value: 'enterprise customers' }];

      const result = await deniedController.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
    });

    it('should return 400 for database errors', async () => {
      mockDataAccess.Site.findById.rejects(new Error('Database connection failed'));
      mockContext.data = [{ key: 'new_target', value: 'enterprise customers' }];

      const result = await controller.addLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });
  });

  describe('removeLlmoCustomerIntent', () => {
    beforeEach(() => {
      mockContext.params.intentKey = 'target_audience';
    });

    it('should remove customer intent successfully', async () => {
      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.removeLlmoCustomerIntent).to.have.been.calledWith('target_audience');
    });

    it('should return bad request for invalid customer intent key', async () => {
      mockConfig.getLlmoCustomerIntent.returns([]);

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should handle null customer intent gracefully', async () => {
      mockConfig.getLlmoCustomerIntent.returns(null);

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Invalid customer intent key');
    });

    it(
      'should return empty array when getLlmoConfig().customerIntent is null',
      async () => {
        mockConfig.getLlmoConfig.returns({
          dataFolder: TEST_FOLDER,
          brand: TEST_BRAND,
          customerIntent: null,
        });

        const result = await controller.removeLlmoCustomerIntent(mockContext);

        expect(result.status).to.equal(200);
        const body = await result.json();
        expect(body).to.be.an('array');
      },
    );

    it('should return 403 when user does not have access', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
    });

    it('should return 400 for database errors', async () => {
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const result = await controller.removeLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });
  });

  describe('patchLlmoCustomerIntent', () => {
    beforeEach(() => {
      mockContext.params.intentKey = 'target_audience';
      mockContext.data = { value: 'updated value' };
    });

    it('should update customer intent successfully', async () => {
      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith('target_audience', mockContext.data);
    });

    it('should update customer intent key successfully', async () => {
      mockContext.data = { key: 'updated_target_audience', value: 'updated value' };

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
    });

    it('should return bad request for invalid customer intent key', async () => {
      mockConfig.getLlmoCustomerIntent.returns([]);

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should return bad request when no update data provided', async () => {
      mockContext.data = null;

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should return bad request when value is not a string', async () => {
      mockContext.data = { value: 123 };

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should return 403 when user does not have access', async () => {
      const deniedController = controllerWithAccessDenied(mockContext);

      const result = await deniedController.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(403);
    });

    it('should return 400 for database errors', async () => {
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const result = await controller.patchLlmoCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
    });

    it(
      'should return empty array when getLlmoConfig().customerIntent is null',
      async () => {
        mockConfig.getLlmoConfig.returns({
          dataFolder: TEST_FOLDER,
          brand: TEST_BRAND,
          customerIntent: null,
        });

        const result = await controller.patchLlmoCustomerIntent(mockContext);

        expect(result.status).to.equal(200);
        const body = await result.json();
        expect(body).to.be.an('array');
      },
    );
  });

  describe('patchLlmoCdnLogsFilter', () => {
    beforeEach(() => {
      mockContext.data = {
        cdnlogsFilter: [
          { key: 'user-agent', value: ['bot', 'crawler'], type: 'exclude' },
        ],
      };
    });

    it('should update CDN logs filter successfully', async () => {
      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoCdnlogsFilter).to.have.been.calledWith(
        mockContext.data.cdnlogsFilter,
      );
    });

    it('should return bad request when no data provided', async () => {
      mockContext.data = null;

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should handle errors and log them', async () => {
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const result = await controller.patchLlmoCdnLogsFilter(mockContext);

      expect(result.status).to.equal(400);
      expect(mockLog.error).to.have.been.calledWith(
        `Error updating CDN logs filter for siteId: ${TEST_SITE_ID}, error: Database error`,
      );
    });

    it(
      'should return empty array when getLlmoConfig().cdnlogsFilter is null',
      async () => {
        mockConfig.getLlmoConfig.returns({
          dataFolder: TEST_FOLDER,
          brand: TEST_BRAND,
          cdnlogsFilter: null,
        });

        const result = await controller.patchLlmoCdnLogsFilter(mockContext);

        expect(result.status).to.equal(200);
        const body = await result.json();
        expect(body).to.be.an('array');
      },
    );
  });

  describe('patchLlmoCdnBucketConfig', () => {
    beforeEach(() => {
      mockContext.data = {
        cdnBucketConfig: {
          bucketName: TEST_BUCKET,
          orgId: TEST_ORG_ID,
        },
      };
    });

    it('should update CDN bucket config successfully', async () => {
      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(200);
    });

    it('should return bad request when no data provided', async () => {
      mockContext.data = null;

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(400);
    });

    it('should handle errors and log them', async () => {
      mockDataAccess.Site.findById.rejects(new Error('Database error'));

      const result = await controller.patchLlmoCdnBucketConfig(mockContext);

      expect(result.status).to.equal(400);
      expect(mockLog.error).to.have.been.calledWith(
        `Error updating CDN bucket config for siteId: ${TEST_SITE_ID}, error: Database error`,
      );
    });

    it(
      'should return empty object when getLlmoConfig().cdnBucketConfig is null',
      async () => {
        mockConfig.getLlmoConfig.returns({
          dataFolder: TEST_FOLDER,
          brand: TEST_BRAND,
          cdnBucketConfig: null,
        });

        const result = await controller.patchLlmoCdnBucketConfig(mockContext);

        expect(result.status).to.equal(200);
        const body = await result.json();
        expect(body).to.be.an('object');
      },
    );
  });

  describe('onboardCustomer', () => {
    let mockOrganization;
    let mockNewSite;
    let mockSiteConfig;
    let onboardingContext;
    let validateSiteNotOnboardedStub;
    let performLlmoOnboardingStub;

    beforeEach(() => {
      mockOrganization = {
        getId: sinon.stub().returns('new-org-id'),
        getImsOrgId: sinon.stub().returns('test-ims-org-id@AdobeOrg'),
        getConfig: sinon.stub().returns({
          getSlackConfig: sinon.stub().returns(null),
        }),
      };

      mockSiteConfig = {
        updateLlmoBrand: sinon.stub(),
        updateLlmoDataFolder: sinon.stub(),
        getSlackConfig: sinon.stub().returns(null),
        getHandlers: sinon.stub().returns([]),
        isImportEnabled: sinon.stub().returns(false),
        enableImport: sinon.stub(),
      };

      mockNewSite = {
        getId: sinon.stub().returns('new-site-id'),
        getConfig: sinon.stub().returns(mockSiteConfig),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
        getOrganizationId: sinon.stub().returns('new-org-id'),
      };

      mockDataAccess.Organization = {
        findByImsOrgId: sinon.stub().resolves(null),
        create: sinon.stub().resolves(mockOrganization),
      };
      mockDataAccess.Site.findByBaseURL = sinon.stub().resolves(null);
      mockDataAccess.Site.create = sinon.stub().resolves(mockNewSite);

      const mockConfiguration = {
        enableHandlerForSite: sinon.stub(),
        save: sinon.stub().resolves(),
        getQueues: sinon.stub().returns({ audits: 'audit-queue' }),
      };
      mockDataAccess.Configuration.findLatest.resolves(mockConfiguration);

      mockEnv.ENV = 'dev';
      mockEnv.SHAREPOINT_CLIENT_ID = 'test-client-id';
      mockEnv.SHAREPOINT_CLIENT_SECRET = 'test-client-secret';
      mockEnv.SHAREPOINT_AUTHORITY = 'test-authority';
      mockEnv.SHAREPOINT_DOMAIN_ID = 'test-domain-id';
      mockEnv.LLMO_ONBOARDING_GITHUB_TOKEN = 'test-github-token';
      mockEnv.HLX_ADMIN_TOKEN = 'test-hlx-token';
      mockEnv.DEFAULT_ORGANIZATION_ID = 'default-org-id';

      onboardingContext = {
        ...mockContext,
        data: {
          domain: 'example.com',
          brandName: 'Test Brand',
        },
        attributes: {
          authInfo: {
            getProfile: sinon.stub().returns({
              email: 'test@example.com',
              tenants: [{ id: 'test-tenant-id' }],
            }),
          },
        },
      };

      validateSiteNotOnboardedStub = sinon.stub().resolves({ isValid: true });
      performLlmoOnboardingStub = sinon.stub().resolves({
        siteId: 'new-site-id',
        organizationId: 'new-org-id',
        baseURL: 'https://example.com',
        dataFolder: 'dev/example-com',
        message: 'LLMO onboarding completed successfully',
      });
    });

    it('should successfully onboard a new customer', async () => {
      const LlmoControllerOnboard = await esmock('../../../src/controllers/llmo/llmo.js', {
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          validateSiteNotOnboarded: validateSiteNotOnboardedStub,
          performLlmoOnboarding: performLlmoOnboardingStub,
          generateDataFolder: (baseURL, env) => {
            const url = new URL(baseURL);
            const dataFolderName = url.hostname.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
            return env === 'prod' ? dataFolderName : `dev/${dataFolderName}`;
          },
        },
        '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: sinon.stub().returnsArg(0) },
        },
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: TEST_USER_AGENT,
          tracingFetch: tracingFetchStub,
          hasText: (text) => text && text.trim().length > 0,
          isObject: (obj) => obj !== null && typeof obj === 'object',
          llmoConfig,
          schemas: {},
          composeBaseURL: (domain) => (domain.startsWith('http') ? domain : `https://${domain}`),
        },
      });
      const testController = LlmoControllerOnboard(mockContext);

      const result = await testController.onboardCustomer(onboardingContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody.status).to.equal('completed');
      expect(validateSiteNotOnboardedStub).to.have.been.calledOnce;
      expect(performLlmoOnboardingStub).to.have.been.calledOnce;
    });

    ['data', 'domain', 'brandName', 'authInfo', 'profile', 'tenants', 'tenant ID'].forEach((field) => {
      it(`should return bad request when ${field} is missing`, async () => {
        const contextCopy = { ...onboardingContext, data: { ...onboardingContext.data } };
        if (field === 'data') {
          contextCopy.data = null;
        } else if (field === 'domain') {
          delete contextCopy.data.domain;
        } else if (field === 'brandName') {
          delete contextCopy.data.brandName;
        } else if (field === 'authInfo') {
          contextCopy.attributes = {};
        } else if (field === 'profile') {
          contextCopy.attributes.authInfo.getProfile.returns(null);
        } else if (field === 'tenants') {
          contextCopy.attributes.authInfo.getProfile.returns({ email: 'test@example.com' });
        } else {
          contextCopy.attributes.authInfo.getProfile.returns({
            email: 'test@example.com',
            tenants: [{ name: 'test-tenant' }],
          });
        }

        const LlmoControllerOnboard = await esmock('../../../src/controllers/llmo/llmo.js', {
          '../../../src/controllers/llmo/llmo-onboarding.js': {
            validateSiteNotOnboarded: validateSiteNotOnboardedStub,
            performLlmoOnboarding: performLlmoOnboardingStub,
            generateDataFolder: () => 'dev/example-com',
          },
          '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
          '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
            Config: { toDynamoItem: sinon.stub().returnsArg(0) },
          },
          '@adobe/spacecat-shared-utils': {
            SPACECAT_USER_AGENT: TEST_USER_AGENT,
            tracingFetch: tracingFetchStub,
            hasText: (text) => text && text.trim().length > 0,
            isObject: (obj) => obj !== null && typeof obj === 'object',
            llmoConfig,
            schemas: {},
            composeBaseURL: (domain) => `https://${domain}`,
          },
        });
        const testController = LlmoControllerOnboard(mockContext);

        const result = await testController.onboardCustomer(contextCopy);

        expect(result.status).to.equal(400);
      });
    });

    it('should return bad request when validation fails', async () => {
      validateSiteNotOnboardedStub.reset();
      validateSiteNotOnboardedStub.resolves({
        isValid: false,
        error: 'Site already assigned to different organization',
      });
      const LlmoControllerOnboard = await esmock('../../../src/controllers/llmo/llmo.js', {
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          validateSiteNotOnboarded: validateSiteNotOnboardedStub,
          performLlmoOnboarding: performLlmoOnboardingStub,
          generateDataFolder: () => 'dev/example-com',
        },
        '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: sinon.stub().returnsArg(0) },
        },
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: TEST_USER_AGENT,
          tracingFetch: tracingFetchStub,
          hasText: (text) => text && text.trim().length > 0,
          isObject: (obj) => obj !== null && typeof obj === 'object',
          llmoConfig,
          schemas: {},
          composeBaseURL: (domain) => `https://${domain}`,
        },
      });
      const testController = LlmoControllerOnboard(mockContext);

      const result = await testController.onboardCustomer(onboardingContext);

      expect(result.status).to.equal(400);
      expect(performLlmoOnboardingStub).to.not.have.been.called;
    });

    it('should handle errors and log them', async () => {
      validateSiteNotOnboardedStub.reset();
      validateSiteNotOnboardedStub.rejects(new Error('Validation error'));
      const LlmoControllerOnboard = await esmock('../../../src/controllers/llmo/llmo.js', {
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          validateSiteNotOnboarded: validateSiteNotOnboardedStub,
          performLlmoOnboarding: performLlmoOnboardingStub,
          generateDataFolder: () => 'dev/example-com',
        },
        '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: sinon.stub().returnsArg(0) },
        },
        '@adobe/spacecat-shared-utils': {
          SPACECAT_USER_AGENT: TEST_USER_AGENT,
          tracingFetch: tracingFetchStub,
          hasText: (text) => text && text.trim().length > 0,
          isObject: (obj) => obj !== null && typeof obj === 'object',
          llmoConfig,
          schemas: {},
          composeBaseURL: (domain) => `https://${domain}`,
        },
      });
      const testController = LlmoControllerOnboard(mockContext);

      const result = await testController.onboardCustomer(onboardingContext);

      expect(result.status).to.equal(400);
      expect(mockLog.error).to.have.been.calledWith('Error during LLMO onboarding: Validation error');
    });
  });

  describe('offboardCustomer', () => {
    let offboardingContext;
    let performLlmoOffboardingStub;

    beforeEach(() => {
      const mockSiteConfig = {
        getLlmoConfig: sinon.stub().returns({
          dataFolder: 'dev/example-com',
          brand: 'Test Brand',
        }),
      };

      mockSite.getConfig = sinon.stub().returns(mockSiteConfig);

      offboardingContext = {
        ...mockContext,
        params: {
          siteId: 'site123',
        },
      };

      performLlmoOffboardingStub = sinon.stub().resolves({
        siteId: 'site123',
        baseURL: 'https://example.com',
        dataFolder: 'dev/example-com',
        message: 'LLMO offboarding completed successfully',
      });
    });

    it('should successfully offboard a customer', async () => {
      const LlmoControllerOffboard = await esmock('../../../src/controllers/llmo/llmo.js', {
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          performLlmoOffboarding: performLlmoOffboardingStub,
        },
        '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
      });
      const testController = LlmoControllerOffboard(mockContext);

      const result = await testController.offboardCustomer(offboardingContext);

      expect(performLlmoOffboardingStub).to.have.been.calledOnce;
      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.include({
        message: 'LLMO offboarding completed successfully',
        siteId: 'site123',
        baseURL: 'https://example.com',
        dataFolder: 'dev/example-com',
        status: 'completed',
      });
      expect(responseBody.completedAt).to.be.a('string');
    });

    it('should return bad request when offboarding fails', async () => {
      performLlmoOffboardingStub.rejects(new Error('Offboarding failed'));

      const LlmoControllerOffboard = await esmock('../../../src/controllers/llmo/llmo.js', {
        '../../../src/controllers/llmo/llmo-onboarding.js': {
          performLlmoOffboarding: performLlmoOffboardingStub,
        },
        '../../../src/support/access-control-util.js': createMockAccessControlUtil(true),
      });
      const testController = LlmoControllerOffboard(mockContext);

      const result = await testController.offboardCustomer(offboardingContext);

      expect(result.status).to.equal(400);
      expect(mockLog.error).to.have.been.calledWith(
        'Error during LLMO offboarding for site site123: Offboarding failed',
      );
    });
  });
});
