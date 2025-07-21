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

import { expect } from 'chai';
import sinon from 'sinon';
import LlmoController from '../../src/controllers/llmo.js';

async function readStreamToJson(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    // Convert string chunks to Buffer if needed
    const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(bufferChunk);
  }
  const jsonString = Buffer.concat(chunks).toString();
  return JSON.parse(jsonString);
}

describe('LLMO Controller', () => {
  let llmoController;
  let fetchStub;
  let mockSite;
  let mockConfig;
  let mockLlmoConfig;
  let mockContext;

  beforeEach(() => {
    llmoController = LlmoController();

    // Mock fetch
    fetchStub = sinon.stub(global, 'fetch');

    // Mock site and config
    mockLlmoConfig = {
      dataFolder: 'frescopa',
      brand: 'test-brand',
      questions: {
        Human: [
          { key: 'human-1', question: 'What is the main value proposition?' },
          { key: 'human-2', question: 'How does this solve customer problems?' },
        ],
        AI: [
          { key: 'ai-1', question: 'What are the key features?' },
          { key: 'ai-2', question: 'How does this compare to competitors?' },
        ],
      },
    };

    mockConfig = {
      getLlmoConfig: sinon.stub().returns(mockLlmoConfig),
      updateLlmoConfig: sinon.stub(),
      getSlackConfig: sinon.stub().returns({}),
      getHandlers: sinon.stub().returns({}),
      getContentAiConfig: sinon.stub().returns({}),
      getImports: sinon.stub().returns({}),
      getFetchConfig: sinon.stub().returns({}),
      getBrandConfig: sinon.stub().returns({}),
      getCdnLogsConfig: sinon.stub().returns({}),
      toDynamoItem: sinon.stub().returns({}),
    };

    mockSite = {
      getId: sinon.stub().returns('test-site-id'),
      getConfig: sinon.stub().returns(mockConfig),
      setConfig: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    mockContext = {
      params: {
        siteId: 'test-site-id',
        dataFolder: 'frescopa',
        dataSource: 'brandpresence-all-w28-2025',
      },
      body: {},
      log: {
        info: sinon.spy(),
        error: sinon.spy(),
      },
      env: {
        LLMO_HLX_API_KEY: 'hlx_test_api_key',
      },
      dataAccess: {
        Site: {
          findBySiteId: sinon.stub().resolves(mockSite),
        },
      },
    };
  });

  afterEach(() => {
    fetchStub.restore();
    sinon.restore();
  });

  describe('getLlmoSheetData', () => {
    it('should proxy data from external endpoint successfully', async () => {
      const mockData = {
        timestamp: '2025-01-27T10:30:00Z',
        data: {
          metrics: { value: 85.5 },
          features: { enabled: true },
        },
      };

      const mockResponse = {
        ok: true,
        json: async () => mockData,
      };

      fetchStub.resolves(mockResponse);

      const result = await llmoController.getLlmoSheetData(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockData);
      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://main--project-elmo-ui-data--adobe.aem.live/frescopa/brandpresence-all-w28-2025.json');
      expect(mockContext.log.info.calledOnce).to.be.true;
    });

    it('should throw error when LLMO is not enabled for site', async () => {
      mockConfig.getLlmoConfig.returns({});

      try {
        await llmoController.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should throw error when dataFolder does not match', async () => {
      mockContext.params.dataFolder = 'wrong-folder';

      try {
        await llmoController.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('invalid data folder for the site, please use the correct data folder');
      }
    });

    it('should handle fetch errors gracefully', async () => {
      const mockError = new Error('Network error');
      fetchStub.rejects(mockError);

      try {
        await llmoController.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Network error');
        expect(mockContext.log.error.callCount).to.be.greaterThan(0);
      }
    });

    it('should handle non-ok response status', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Not Found' }),
      };

      fetchStub.resolves(mockResponse);

      try {
        await llmoController.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('External API returned 404');
        expect(mockContext.log.error.callCount).to.be.greaterThan(0);
      }
    });

    it('should use default API key when env variable is missing', async () => {
      delete mockContext.env.LLMO_HLX_API_KEY;

      const mockData = { test: 'data' };
      const mockResponse = {
        ok: true,
        json: async () => mockData,
      };

      fetchStub.resolves(mockResponse);

      await llmoController.getLlmoSheetData(mockContext);

      expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal('token hlx_api_key_missing');
    });
  });

  describe('getLlmoConfig', () => {
    it('should return LLMO config successfully', async () => {
      const result = await llmoController.getLlmoConfig(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockLlmoConfig);
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await llmoController.getLlmoConfig(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });
  });

  describe('getLlmoQuestions', () => {
    it('should return questions successfully', async () => {
      const result = await llmoController.getLlmoQuestions(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockLlmoConfig.questions);
    });

    it('should return empty object when no questions exist', async () => {
      mockLlmoConfig.questions = null;
      mockConfig.getLlmoConfig.returns(mockLlmoConfig);

      const result = await llmoController.getLlmoQuestions(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal({});
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await llmoController.getLlmoQuestions(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });
  });

  describe('addLlmoQuestion', () => {
    it('should add questions successfully', async () => {
      const newQuestions = {
        Human: [{ question: 'New human question?' }],
        AI: [{ question: 'New AI question?' }],
      };

      mockContext.body = newQuestions;

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(3);
      expect(body.AI).to.have.length(3);
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should handle empty questions gracefully', async () => {
      mockContext.body = {};

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockLlmoConfig.questions);
      expect(mockSite.save.called).to.be.false;
    });

    it('should handle partial questions (only Human)', async () => {
      const newQuestions = {
        Human: [{ question: 'New human question?' }],
      };

      mockContext.body = newQuestions;

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(3);
      expect(body.AI).to.have.length(2);
    });

    it('should handle partial questions (only AI)', async () => {
      const newQuestions = {
        AI: [{ question: 'New AI question?' }],
      };

      mockContext.body = newQuestions;

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(2);
      expect(body.AI).to.have.length(3);
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await llmoController.addLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should handle save errors gracefully', async () => {
      const newQuestions = {
        Human: [{ question: 'New human question?' }],
      };

      mockContext.body = newQuestions;
      mockSite.save.rejects(new Error('Save failed'));

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(3);
      expect(mockContext.log.error.calledOnce).to.be.true;
    });
  });

  describe('removeLlmoQuestion', () => {
    it('should remove question successfully', async () => {
      mockContext.params.questionKey = 'human-1';

      const result = await llmoController.removeLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(1);
      expect(body.Human[0].key).to.equal('human-2');
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should remove AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-1';

      const result = await llmoController.removeLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.AI).to.have.length(1);
      expect(body.AI[0].key).to.equal('ai-2');
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';

      try {
        await llmoController.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Invalid question key, please provide a valid question key');
      }
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await llmoController.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockContext.params.questionKey = 'human-1';
      mockSite.save.rejects(new Error('Save failed'));

      const result = await llmoController.removeLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(1);
      expect(mockContext.log.error.calledOnce).to.be.true;
    });
  });

  describe('patchLlmoQuestion', () => {
    it('should update Human question successfully', async () => {
      mockContext.params.questionKey = 'human-1';
      mockContext.body = { question: 'Updated question?' };

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human[0].question).to.equal('Updated question?');
      expect(body.Human[0].key).to.equal('human-1');
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should update AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-1';
      mockContext.body = { question: 'Updated AI question?' };

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.AI[0].question).to.equal('Updated AI question?');
      expect(body.AI[0].key).to.equal('ai-1');
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';
      mockContext.body = { question: 'Updated question?' };

      try {
        await llmoController.patchLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Invalid question key, please provide a valid question key');
      }
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await llmoController.patchLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockContext.params.questionKey = 'human-1';
      mockContext.body = { question: 'Updated question?' };
      mockSite.save.rejects(new Error('Save failed'));

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human[0].question).to.equal('Updated question?');
      expect(mockContext.log.error.calledOnce).to.be.true;
    });

    it('should preserve existing properties when updating', async () => {
      mockContext.params.questionKey = 'human-1';
      mockContext.body = { question: 'Updated question?' };

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human[0].question).to.equal('Updated question?');
      expect(body.Human[0].key).to.equal('human-1');
    });
  });
});
