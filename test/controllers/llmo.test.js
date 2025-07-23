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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { SPACECAT_USER_AGENT } from '@adobe/spacecat-shared-utils';
import LlmoController from '../../src/controllers/llmo.js';

use(sinonChai);

describe('LLMO Controller', () => {
  let controller;
  let mockContext;
  let mockSite;
  let mockConfig;
  let mockLlmoConfig;

  beforeEach(() => {
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
      getSlackConfig: sinon.stub().returns({}),
      getHandlers: sinon.stub().returns({}),
      getContentAiConfig: sinon.stub().returns({}),
      getImports: sinon.stub().returns([]),
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
        dataFolder: 'test-folder',
        dataSource: 'questions',
        questionKey: 'test-question',
      },
      data: {
        Human: [{ question: 'New human question?' }],
        AI: [{ question: 'New AI question?' }],
      },
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves(mockSite),
        },
      },
      env: {
        LLMO_HLX_API_KEY: 'test-api-key',
      },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    controller = LlmoController();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getLlmoSheetData', () => {
    beforeEach(() => {
      global.fetch = sinon.stub();
    });

    afterEach(() => {
      delete global.fetch;
    });

    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      global.fetch.resolves(mockResponse);

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({ data: 'test-data' });
      expect(global.fetch).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/questions.json',
        {
          headers: {
            Authorization: 'token test-api-key',
            'User-Agent': SPACECAT_USER_AGENT,
          },
        },
      );
    });

    it('should throw error when LLMO is not enabled for site', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should throw error when LLMO config has no dataFolder', async () => {
      mockConfig.getLlmoConfig.returns({});

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should throw error when dataFolder does not match', async () => {
      mockContext.params.dataFolder = 'wrong-folder';

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('invalid data folder for the site, please use the correct data folder');
      }
    });

    it('should handle fetch errors gracefully', async () => {
      global.fetch.rejects(new Error('Network error'));

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Network error');
        expect(mockContext.log.error).to.have.been.calledWith(
          'Error proxying data for siteId: test-site-id, dataSource: questions',
          sinon.match.instanceOf(Error),
        );
      }
    });

    it('should handle non-ok response status', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
      global.fetch.resolves(mockResponse);

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('External API returned 404: Not Found');
        expect(mockContext.log.error).to.have.been.calledWith(
          'Failed to fetch data from external endpoint: 404 Not Found',
        );
      }
    });

    it('should handle non-ok response status with error logging', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      };
      global.fetch.resolves(mockResponse);

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('External API returned 500: Internal Server Error');
      }
    });

    it('should use default API key when env variable is missing', async () => {
      delete mockContext.env.LLMO_HLX_API_KEY;
      const mockResponse = {
        ok: true,
        json: sinon.stub().resolves({ data: 'test-data' }),
      };
      global.fetch.resolves(mockResponse);

      await controller.getLlmoSheetData(mockContext);

      expect(global.fetch).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/questions.json',
        {
          headers: {
            Authorization: 'token hlx_api_key_missing',
            'User-Agent': SPACECAT_USER_AGENT,
          },
        },
      );
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
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });
  });

  describe('getLlmoQuestions', () => {
    it('should return questions successfully', async () => {
      const result = await controller.getLlmoQuestions(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal(mockLlmoConfig.questions);
    });

    it('should return empty object when no questions exist', async () => {
      mockLlmoConfig.questions = null;

      const result = await controller.getLlmoQuestions(mockContext);

      expect(result.status).to.equal(200);
      const responseBody = await result.json();
      expect(responseBody).to.deep.equal({});
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.getLlmoQuestions(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });
  });

  describe('addLlmoQuestion', () => {
    it('should add questions successfully', async () => {
      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.calledOnce).to.be.true;
      expect(mockConfig.addLlmoAIQuestions.calledOnce).to.be.true;
      expect(mockSite.setConfig.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should handle empty questions gracefully', async () => {
      mockContext.data = {};

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.called).to.be.false;
      expect(mockConfig.addLlmoAIQuestions.called).to.be.false;
      expect(mockSite.save.called).to.be.false;
    });

    it('should handle partial questions (only Human)', async () => {
      mockContext.data = { Human: [{ question: 'Only human question?' }] };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.calledOnce).to.be.true;
      expect(mockConfig.addLlmoAIQuestions.called).to.be.false;
    });

    it('should handle partial questions (only AI)', async () => {
      mockContext.data = { AI: [{ question: 'Only AI question?' }] };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.called).to.be.false;
      expect(mockConfig.addLlmoAIQuestions.calledOnce).to.be.true;
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.addLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Save failed'));

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockContext.log.error).to.have.been.calledWith(
        'Error adding new questions for site\'s llmo config test-site-id: Save failed',
      );
    });

    it('should handle null/undefined questions gracefully', async () => {
      mockConfig.getLlmoHumanQuestions.returns(null);
      mockConfig.getLlmoAIQuestions.returns(undefined);

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions).to.have.been.calledWith(sinon.match.array);
      expect(mockConfig.addLlmoAIQuestions).to.have.been.calledWith(sinon.match.array);
    });
  });

  describe('removeLlmoQuestion', () => {
    it('should remove question successfully', async () => {
      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.removeLlmoQuestion).to.have.been.calledWith('test-question');
      expect(mockSite.setConfig.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should remove AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-question';

      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.removeLlmoQuestion).to.have.been.calledWith('ai-question');
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';

      try {
        await controller.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Invalid question key, please provide a valid question key');
      }
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Save failed'));

      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockContext.log.error).to.have.been.calledWith(
        'Error removing question for site\'s llmo config test-site-id: Save failed',
      );
    });

    it('should handle null/undefined questions gracefully', async () => {
      mockConfig.getLlmoHumanQuestions.returns(null);
      mockConfig.getLlmoAIQuestions.returns(undefined);

      try {
        await controller.removeLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Invalid question key, please provide a valid question key');
      }
    });
  });

  describe('patchLlmoQuestion', () => {
    it('should update Human question successfully', async () => {
      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoQuestion).to.have.been.calledWith('test-question', mockContext.data);
      expect(mockSite.setConfig.calledOnce).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
    });

    it('should update AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-question';

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoQuestion).to.have.been.calledWith('ai-question', mockContext.data);
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = 'invalid-key';

      try {
        await controller.patchLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Invalid question key, please provide a valid question key');
      }
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.patchLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('LLM Optimizer is not enabled for this site, add llmo config to the site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Save failed'));

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockContext.log.error).to.have.been.calledWith(
        'Error updating question for site\'s llmo config test-site-id: Save failed',
      );
    });

    it('should preserve existing properties when updating', async () => {
      const updateData = { question: 'Updated question text' };
      mockContext.data = updateData;

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.updateLlmoQuestion).to.have.been.calledWith('test-question', updateData);
    });

    it('should handle null/undefined questions gracefully', async () => {
      mockConfig.getLlmoHumanQuestions.returns(null);
      mockConfig.getLlmoAIQuestions.returns(undefined);

      try {
        await controller.patchLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Invalid question key, please provide a valid question key');
      }
    });
  });

  describe('Edge cases and error scenarios', () => {
    it('should handle site not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      try {
        await controller.getLlmoConfig(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Cannot read properties of null');
      }
    });

    it('should handle empty arrays in questions', async () => {
      mockContext.data = { Human: [], AI: [] };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.called).to.be.false;
      expect(mockConfig.addLlmoAIQuestions.called).to.be.false;
    });

    it('should handle empty body in questions', async () => {
      mockContext.data = null;
      const result = await controller.addLlmoQuestion(mockContext);
      expect(result.status).to.equal(400);
    });

    it('should handle questions with existing keys', async () => {
      mockContext.data = {
        Human: [{ key: 'existing-key', question: 'Question with existing key' }],
      };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.called).to.be.true;
      const callArgs = mockConfig.addLlmoHumanQuestions.getCall(0).args[0];
      expect(callArgs).to.have.lengthOf(1);
      expect(callArgs[0]).to.have.property('question', 'Question with existing key');
      expect(callArgs[0]).to.have.property('key').that.is.a('string');
    });

    it('should handle questions without keys', async () => {
      mockContext.data = {
        Human: [{ question: 'Question without key' }],
      };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result.status).to.equal(200);
      expect(mockConfig.addLlmoHumanQuestions.called).to.be.true;
      const callArgs = mockConfig.addLlmoHumanQuestions.getCall(0).args[0];
      expect(callArgs).to.have.lengthOf(1);
      expect(callArgs[0]).to.have.property('question', 'Question without key');
      expect(callArgs[0]).to.have.property('key').that.is.a('string');
    });
  });
});
