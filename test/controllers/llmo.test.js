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
  let data = '';
  for await (const chunk of stream) {
    data += chunk;
  }
  return JSON.parse(data);
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
    fetchStub = sinon.stub(global, 'fetch');

    // Create mock LLMO config
    mockLlmoConfig = {
      dataFolder: 'frescopa',
      brand: 'Frescopa',
      questions: {
        Human: [
          { key: 'human-1', text: 'What is the brand voice?' },
          { key: 'human-2', text: 'What are the key features?' },
        ],
        AI: [
          { key: 'ai-1', text: 'Analyze the content structure' },
          { key: 'ai-2', text: 'Identify brand elements' },
        ],
      },
    };

    // Create mock config
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

    // Create mock site
    mockSite = {
      getId: sinon.stub().returns('test-site-id'),
      getConfig: sinon.stub().returns(mockConfig),
      setConfig: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    // Create mock context
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
      siteCollection: {
        findBySiteId: sinon.stub().resolves(mockSite),
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

      expect(fetchStub.calledOnce).to.be.true;
      const fetchCall = fetchStub.firstCall;
      expect(fetchCall.args[1].headers.Authorization).to.equal('token hlx_api_key_missing');
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
    beforeEach(() => {
      mockContext.body = {
        Human: [
          { text: 'New human question 1' },
          { text: 'New human question 2' },
        ],
        AI: [
          { text: 'New AI question 1' },
        ],
      };
    });

    it('should add questions successfully', async () => {
      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(4); // 2 original + 2 new
      expect(body.AI).to.have.length(3); // 2 original + 1 new

      // Check that new questions have keys
      const newHumanQuestions = body.Human.filter((q) => q.text.includes('New human question'));
      const newAIQuestions = body.AI.filter((q) => q.text.includes('New AI question'));

      expect(newHumanQuestions).to.have.length(2);
      expect(newAIQuestions).to.have.length(1);

      newHumanQuestions.forEach((q) => expect(q).to.have.property('key'));
      newAIQuestions.forEach((q) => expect(q).to.have.property('key'));

      expect(mockConfig.updateLlmoConfig.calledOnce).to.be.true;
      expect(mockSite.setConfig.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should handle empty questions gracefully', async () => {
      mockContext.body = {};

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockLlmoConfig.questions);
      expect(mockConfig.updateLlmoConfig.called).to.be.false;
      expect(mockSite.setConfig.called).to.be.false;
      expect(mockSite.save.called).to.be.false;
    });

    it('should handle partial questions (only Human)', async () => {
      mockContext.body = {
        Human: [{ text: 'New human question' }],
      };

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(3); // 2 original + 1 new
      expect(body.AI).to.have.length(2); // unchanged
    });

    it('should handle partial questions (only AI)', async () => {
      mockContext.body = {
        AI: [{ text: 'New AI question' }],
      };

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(2); // unchanged
      expect(body.AI).to.have.length(3); // 2 original + 1 new
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
      mockSite.save.rejects(new Error('Database error'));

      const result = await llmoController.addLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockLlmoConfig.questions);
      expect(mockContext.log.error.calledOnce).to.be.true;
      expect(mockContext.log.error.firstCall.args[0]).to.include('Error adding new questions for site\'s llmo config');
    });
  });

  describe('removeLlmoQuestion', () => {
    beforeEach(() => {
      mockContext.params.questionKey = 'human-1';
    });

    it('should remove question successfully', async () => {
      const result = await llmoController.removeLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(1); // removed one
      expect(body.AI).to.have.length(2); // unchanged
      expect(body.Human.find((q) => q.key === 'human-1')).to.be.undefined;

      expect(mockConfig.updateLlmoConfig.calledOnce).to.be.true;
      expect(mockSite.setConfig.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should remove AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-1';

      const result = await llmoController.removeLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(2); // unchanged
      expect(body.AI).to.have.length(1); // removed one
      expect(body.AI.find((q) => q.key === 'ai-1')).to.be.undefined;
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
      mockSite.save.rejects(new Error('Database error'));

      const result = await llmoController.removeLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body.Human).to.have.length(1); // question was removed
      expect(mockContext.log.error.calledOnce).to.be.true;
      expect(mockContext.log.error.firstCall.args[0]).to.include('Error removing question for site\'s llmo config');
    });
  });

  describe('patchLlmoQuestion', () => {
    beforeEach(() => {
      mockContext.params.questionKey = 'human-1';
      mockContext.body = {
        text: 'Updated question text',
        priority: 'high',
      };
    });

    it('should update Human question successfully', async () => {
      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);

      const updatedQuestion = body.Human.find((q) => q.key === 'human-1');
      expect(updatedQuestion).to.exist;
      expect(updatedQuestion.text).to.equal('Updated question text');
      expect(updatedQuestion.priority).to.equal('high');

      expect(mockConfig.updateLlmoConfig.calledOnce).to.be.true;
      expect(mockSite.setConfig.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should update AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-1';

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);

      const updatedQuestion = body.AI.find((q) => q.key === 'ai-1');
      expect(updatedQuestion).to.exist;
      expect(updatedQuestion.text).to.equal('Updated question text');
      expect(updatedQuestion.priority).to.equal('high');
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';

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
      mockSite.save.rejects(new Error('Database error'));

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);

      const updatedQuestion = body.Human.find((q) => q.key === 'human-1');
      expect(updatedQuestion.text).to.equal('Updated question text');

      expect(mockContext.log.error.calledOnce).to.be.true;
      expect(mockContext.log.error.firstCall.args[0]).to.include('Error updating question for site\'s llmo config');
    });

    it('should preserve existing properties when updating', async () => {
      mockContext.body = { text: 'Updated text only' };

      const result = await llmoController.patchLlmoQuestion(mockContext);
      const body = await readStreamToJson(result.body);

      const updatedQuestion = body.Human.find((q) => q.key === 'human-1');
      expect(updatedQuestion.text).to.equal('Updated text only');
      // Should preserve other properties that weren't in the update
      expect(updatedQuestion).to.have.property('key', 'human-1');
    });
  });
});
