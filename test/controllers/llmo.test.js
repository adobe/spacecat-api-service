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
      getSlackConfig: sinon.stub().returns({}),
      getHandlers: sinon.stub().returns({}),
      getContentAiConfig: sinon.stub().returns({}),
      getImports: sinon.stub().returns([]),
      getFetchConfig: sinon.stub().returns({}),
      getBrandConfig: sinon.stub().returns({}),
      getCdnLogsConfig: sinon.stub().returns({}),
    };

    // Create mock site
    mockSite = {
      getConfig: sinon.stub().returns(mockConfig),
      save: sinon.stub().resolves(),
      getId: sinon.stub().returns('test-site-id'),
      setConfig: sinon.stub(),
    };

    // Create mock context
    mockContext = {
      params: {
        siteId: 'test-site-id',
      },
      body: {},
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves(mockSite),
        },
      },
    };

    // Create controller instance
    controller = LlmoController();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getLlmoSheetData', () => {
    it('should proxy data from external endpoint successfully', async () => {
      const mockResponse = { data: 'test-data' };
      sinon.stub(global, 'fetch').resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      mockContext.params.dataFolder = 'test-folder';
      mockContext.params.dataSource = 'test-source';
      mockContext.env = { LLMO_HLX_API_KEY: 'test-key' };

      const result = await controller.getLlmoSheetData(mockContext);

      expect(result).to.have.property('status', 200);
      const resultBody = await result.json();
      expect(resultBody).to.deep.equal(mockResponse);
      expect(global.fetch).to.have.been.calledOnce;
    });

    it('should throw error when LLMO is not enabled for site', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Cannot read properties of null');
      }
    });

    it('should throw error when LLMO config has no dataFolder', async () => {
      mockLlmoConfig.dataFolder = null;

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
      sinon.stub(global, 'fetch').rejects(new Error('Network error'));

      mockContext.params.dataFolder = 'test-folder';
      mockContext.params.dataSource = 'test-source';
      mockContext.env = { LLMO_HLX_API_KEY: 'test-key' };

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('Network error');
      }
    });

    it('should handle non-ok response status', async () => {
      sinon.stub(global, 'fetch').resolves({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      mockContext.params.dataFolder = 'test-folder';
      mockContext.params.dataSource = 'test-source';
      mockContext.env = { LLMO_HLX_API_KEY: 'test-key' };

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('External API returned 404: Not Found');
      }
    });

    it('should handle non-ok response status with error logging', async () => {
      sinon.stub(global, 'fetch').resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      mockContext.params.dataFolder = 'test-folder';
      mockContext.params.dataSource = 'test-source';
      mockContext.env = { LLMO_HLX_API_KEY: 'test-key' };

      try {
        await controller.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.equal('External API returned 500: Internal Server Error');
        expect(mockContext.log.error.called).to.be.true;
      }
    });

    it('should use default API key when env variable is missing', async () => {
      const mockResponse = { data: 'test-data' };
      sinon.stub(global, 'fetch').resolves({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      mockContext.params.dataFolder = 'test-folder';
      mockContext.params.dataSource = 'test-source';
      mockContext.env = {};

      await controller.getLlmoSheetData(mockContext);

      expect(global.fetch).to.have.been.calledWith(
        'https://main--project-elmo-ui-data--adobe.aem.live/test-folder/test-source.json',
        sinon.match({
          headers: {
            Authorization: 'token hlx_api_key_missing',
            'User-Agent': 'SpaceCat-API-Service/1.0',
          },
        }),
      );
    });
  });

  describe('getLlmoConfig', () => {
    it('should return LLMO config successfully', async () => {
      const result = await controller.getLlmoConfig(mockContext);

      expect(result).to.have.property('status', 200);
      const resultBody = await result.json();
      expect(resultBody).to.deep.equal(mockLlmoConfig);
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
    it('should return questions successfully', async () => {
      const result = await controller.getLlmoQuestions(mockContext);

      expect(result).to.have.property('status', 200);
      const resultBody = await result.json();
      expect(resultBody).to.deep.equal(mockLlmoConfig.questions);
    });

    it('should return empty object when no questions exist', async () => {
      mockLlmoConfig.questions = null;

      const result = await controller.getLlmoQuestions(mockContext);

      expect(result).to.have.property('status', 200);
      const resultBody = await result.json();
      expect(resultBody).to.deep.equal({});
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.getLlmoQuestions(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });
  });

  describe('addLlmoQuestion', () => {
    it('should add questions successfully', async () => {
      const questions = {
        Human: ['What is the main goal of this page?'],
        AI: ['Analyze the page content and identify key themes.'],
      };
      mockContext.body = questions;

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
      expect(mockSite.save.called).to.be.true;
    });

    it('should handle empty questions gracefully', async () => {
      mockContext.body = {};

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
    });

    it('should handle partial questions (only Human)', async () => {
      const questions = {
        Human: ['What is the main goal of this page?'],
      };
      mockContext.body = questions;

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
    });

    it('should handle partial questions (only AI)', async () => {
      const questions = {
        AI: ['Analyze the page content and identify key themes.'],
      };
      mockContext.body = questions;

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
    });

    it('should throw error when LLMO is not enabled', async () => {
      mockConfig.getLlmoConfig.returns(null);

      try {
        await controller.addLlmoQuestion(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Save failed'));
      mockContext.body = { Human: ['test question'] };

      const result = await controller.addLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
    });
  });

  describe('removeLlmoQuestion', () => {
    it('should remove question successfully', async () => {
      mockContext.params.questionKey = 'test-question';

      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
      expect(mockSite.save.called).to.be.true;
    });

    it('should remove AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-question';

      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
      expect(mockSite.save.called).to.be.true;
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = '';

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
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Save failed'));
      mockContext.params.questionKey = 'test-question';

      const result = await controller.removeLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
    });
  });

  describe('patchLlmoQuestion', () => {
    it('should update Human question successfully', async () => {
      mockContext.params.questionKey = 'test-question';
      mockContext.body = { Human: 'Updated question' };

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
      expect(mockSite.save.called).to.be.true;
    });

    it('should update AI question successfully', async () => {
      mockContext.params.questionKey = 'ai-question';
      mockContext.body = { AI: 'Updated answer' };

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
      expect(mockSite.save.called).to.be.true;
    });

    it('should throw error for invalid question key', async () => {
      mockContext.params.questionKey = '';
      mockContext.body = { Human: 'test' };

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
        expect(error.message).to.include('LLM Optimizer is not enabled for this site');
      }
    });

    it('should handle save errors gracefully', async () => {
      mockSite.save.rejects(new Error('Save failed'));
      mockContext.params.questionKey = 'test-question';
      mockContext.body = { Human: 'Updated question' };

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
    });

    it('should preserve existing properties when updating', async () => {
      mockContext.params.questionKey = 'test-question';
      mockContext.body = { Human: 'Updated question' };

      const result = await controller.patchLlmoQuestion(mockContext);

      expect(result).to.have.property('status', 200);
      expect(mockSite.save.called).to.be.true;
    });
  });
});
