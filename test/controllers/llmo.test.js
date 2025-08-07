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
      customerIntent: {
        adobeProduct: 'test-adobe-product',
        cdnProvider: ['test-cdn-provider'],
        referralProvider: 'test-referral-provider',
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
      setLlmoCustomerIntent: sinon.stub(),
      removeLlmoCustomerIntent: sinon.stub(),
      updateLlmoCustomerIntent: sinon.stub(),
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
      updateSlackConfig: sinon.stub(),
      updateLlmoDataFolder: sinon.stub(),
      updateLlmoBrand: sinon.stub(),
      updateImports: sinon.stub(),
    };

    // Create mock site
    mockSite = {
      getId: sinon.stub().returns('test-site-id'),
      getConfig: sinon.stub().returns(mockConfig),
      setConfig: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    // Create mock data access
    mockDataAccess = {
      Site: {
        findById: sinon.stub().resolves(mockSite),
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
    };

    // Create tracingFetch stub
    tracingFetchStub = sinon.stub();

    // Mock the controller with the tracingFetch stub
    const LlmoController = await esmock('../../src/controllers/llmo.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: 'test-user-agent',
        tracingFetch: tracingFetchStub,
      },
    });

    controller = LlmoController();
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

    it('should handle external API errors with sheetType parameter', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      tracingFetchStub.resolves(mockResponse);

      // Add sheetType to the context params
      mockContext.data.sheetType = 'analytics';

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('External API returned 404: Not Found');
      }
    });

    it('should handle network errors with sheetType parameter', async () => {
      const networkError = new Error('Network error');
      tracingFetchStub.rejects(networkError);

      // Add sheetType to the context params
      mockContext.data.sheetType = 'analytics';

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Network error');
      }
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

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('External API returned 404: Not Found');
      }
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network error');
      tracingFetchStub.rejects(networkError);

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Network error');
      }
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
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

      try {
        await controller.getLlmoConfig(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
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

  describe('getCustomerIntent', () => {
    it('should return customer intent successfully when it exists', async () => {
      const mockCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare', 'fastly'],
        referralProvider: 'google',
      };
      mockConfig.getLlmoCustomerIntent.returns(mockCustomerIntent);

      const result = await controller.getCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockCustomerIntent);
      expect(mockConfig.getLlmoCustomerIntent).to.have.been.calledOnce;
    });

    it('should return null when customer intent does not exist', async () => {
      mockConfig.getLlmoCustomerIntent.returns(null);

      const result = await controller.getCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.be.null;
      expect(mockConfig.getLlmoCustomerIntent).to.have.been.calledOnce;
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.getCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });
  });

  describe('addCustomerIntent', () => {
    it('should create customer intent with all fields successfully', async () => {
      const customerIntentData = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare', 'fastly'],
        referralProvider: 'google',
      };
      mockContext.data = customerIntentData;
      mockConfig.getLlmoCustomerIntent.returns(customerIntentData);

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(customerIntentData);
      expect(mockConfig.setLlmoCustomerIntent).to.have.been.calledWith(customerIntentData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should create customer intent with partial fields successfully', async () => {
      const customerIntentData = {
        adobeProduct: 'Target',
      };
      mockContext.data = customerIntentData;
      mockConfig.getLlmoCustomerIntent.returns(customerIntentData);

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(customerIntentData);
      expect(mockConfig.setLlmoCustomerIntent).to.have.been.calledWith(customerIntentData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should create customer intent with only cdnProvider', async () => {
      const customerIntentData = {
        cdnProvider: ['akamai'],
      };
      mockContext.data = customerIntentData;
      mockConfig.getLlmoCustomerIntent.returns(customerIntentData);

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(customerIntentData);
      expect(mockConfig.setLlmoCustomerIntent).to.have.been.calledWith(customerIntentData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should create customer intent with only referralProvider', async () => {
      const customerIntentData = {
        referralProvider: 'bing',
      };
      mockContext.data = customerIntentData;
      mockConfig.getLlmoCustomerIntent.returns(customerIntentData);

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(customerIntentData);
      expect(mockConfig.setLlmoCustomerIntent).to.have.been.calledWith(customerIntentData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should return bad request when no data provided', async () => {
      mockContext.data = null;

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('No customer intent data provided in the request body');
      expect(mockConfig.setLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should return bad request when adobeProduct is not a string', async () => {
      mockContext.data = {
        adobeProduct: 123,
        cdnProvider: ['cloudflare'],
      };

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('adobeProduct must be a string');
      expect(mockConfig.setLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should return bad request when cdnProvider is not an array', async () => {
      mockContext.data = {
        adobeProduct: 'Analytics',
        cdnProvider: 'cloudflare',
      };

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('cdnProvider must be an array');
      expect(mockConfig.setLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should return bad request when referralProvider is not a string', async () => {
      mockContext.data = {
        adobeProduct: 'Analytics',
        referralProvider: ['google'],
      };

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('referralProvider must be a string');
      expect(mockConfig.setLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should handle site save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);
      const customerIntentData = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
      };
      mockContext.data = customerIntentData;
      mockConfig.getLlmoCustomerIntent.returns(customerIntentData);

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(customerIntentData);
      expect(mockConfig.setLlmoCustomerIntent).to.have.been.calledWith(customerIntentData);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error setting customer intent for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should exclude undefined fields from customer intent object', async () => {
      mockContext.data = {
        adobeProduct: 'Analytics',
        cdnProvider: undefined,
        referralProvider: 'google',
      };
      const expectedCustomerIntent = {
        adobeProduct: 'Analytics',
        referralProvider: 'google',
      };
      mockConfig.getLlmoCustomerIntent.returns(expectedCustomerIntent);

      const result = await controller.addCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(expectedCustomerIntent);
      expect(mockConfig.setLlmoCustomerIntent).to.have.been.calledWith(expectedCustomerIntent);
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);
      mockContext.data = { adobeProduct: 'Analytics' };

      try {
        await controller.addCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });
  });

  describe('removeCustomerIntent', () => {
    it('should remove customer intent successfully', async () => {
      const result = await controller.removeCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.be.null;
      expect(mockConfig.removeLlmoCustomerIntent).to.have.been.calledOnce;
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should handle site save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);

      const result = await controller.removeCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.be.null;
      expect(mockConfig.removeLlmoCustomerIntent).to.have.been.calledOnce;
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error removing customer intent for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.removeCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });
  });

  describe('patchCustomerIntent', () => {
    it('should update customer intent successfully', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
        referralProvider: 'google',
      };
      const updateData = {
        adobeProduct: 'Target',
        cdnProvider: ['akamai', 'fastly'],
      };
      const expectedUpdatedIntent = {
        adobeProduct: 'Target',
        cdnProvider: ['akamai', 'fastly'],
        referralProvider: 'google',
      };

      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = updateData;

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(existingCustomerIntent);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith(expectedUpdatedIntent);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('should update only adobeProduct field', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
        referralProvider: 'google',
      };
      const updateData = {
        adobeProduct: 'Experience Platform',
      };
      const expectedUpdatedIntent = {
        adobeProduct: 'Experience Platform',
        cdnProvider: ['cloudflare'],
        referralProvider: 'google',
      };

      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = updateData;

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith(expectedUpdatedIntent);
    });

    it('should update only cdnProvider field', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
        referralProvider: 'google',
      };
      const updateData = {
        cdnProvider: ['akamai', 'cloudflare'],
      };
      const expectedUpdatedIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['akamai', 'cloudflare'],
        referralProvider: 'google',
      };

      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = updateData;

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith(expectedUpdatedIntent);
    });

    it('should update only referralProvider field', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
        referralProvider: 'google',
      };
      const updateData = {
        referralProvider: 'bing',
      };
      const expectedUpdatedIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
        referralProvider: 'bing',
      };

      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = updateData;

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledWith(expectedUpdatedIntent);
    });

    it('should return bad request when no customer intent exists', async () => {
      mockConfig.getLlmoCustomerIntent.returns(null);
      mockContext.data = { adobeProduct: 'Target' };

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('No customer intent exists to patch. Use POST to create one first.');
      expect(mockConfig.updateLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should return bad request when adobeProduct is not a string', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
      };
      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = {
        adobeProduct: 123,
      };

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('adobeProduct must be a string');
      expect(mockConfig.updateLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should return bad request when cdnProvider is not an array', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
      };
      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = {
        cdnProvider: 'not-an-array',
      };

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('cdnProvider must be an array');
      expect(mockConfig.updateLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should return bad request when referralProvider is not a string', async () => {
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        referralProvider: 'google',
      };
      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = {
        referralProvider: 123,
      };

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(400);
      const responseBody = await result.json();
      expect(responseBody.message).to.equal('referralProvider must be a string');
      expect(mockConfig.updateLlmoCustomerIntent).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
    });

    it('should handle site save errors gracefully', async () => {
      const saveError = new Error('Database connection failed');
      mockSite.save.rejects(saveError);
      const existingCustomerIntent = {
        adobeProduct: 'Analytics',
        cdnProvider: ['cloudflare'],
      };
      const updateData = {
        adobeProduct: 'Target',
      };
      mockConfig.getLlmoCustomerIntent.returns(existingCustomerIntent);
      mockContext.data = updateData;

      const result = await controller.patchCustomerIntent(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(existingCustomerIntent);
      expect(mockConfig.updateLlmoCustomerIntent).to.have.been.calledOnce;
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockLog.error).to.have.been.calledWith(
        'Error updating customer intent for site\'s llmo config test-site-id: Database connection failed',
      );
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);
      mockContext.data = { adobeProduct: 'Target' };

      try {
        await controller.patchCustomerIntent(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });
  });
});
