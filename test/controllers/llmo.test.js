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

  beforeEach(() => {
    llmoController = LlmoController();
    fetchStub = sinon.stub(global, 'fetch');
  });

  afterEach(() => {
    fetchStub.restore();
  });

  describe('getLlmoSheetData', () => {
    it('should proxy data from external endpoint', async () => {
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

      const mockContext = {
        params: {
          siteId: 'test-site-id',
          dataFolder: 'frescopa',
          dataSource: 'brandpresence-all-w28-2025',
        },
        log: {
          info: sinon.spy(),
          error: sinon.spy(),
        },
        env: {
          LLMO_HLX_API_KEY: 'hlx_test_api_key',
        },
      };

      const result = await llmoController.getLlmoSheetData(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockData);
      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://main--project-elmo-ui-data--adobe.aem.live/frescopa/brandpresence-all-w28-2025.json');
      expect(mockContext.log.info.calledOnce).to.be.true;
    });

    it('should handle fetch errors gracefully', async () => {
      const mockError = new Error('Network error');
      fetchStub.rejects(mockError);

      const mockContext = {
        params: {
          siteId: 'test-site-id',
          dataSource: 'test-data-source',
        },
        log: {
          info: sinon.spy(),
          error: sinon.spy(),
        },
        env: {},
      };

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

      const mockContext = {
        params: {
          siteId: 'test-site-id',
          dataSource: 'test-data-source',
        },
        log: {
          info: sinon.spy(),
          error: sinon.spy(),
        },
        env: {
          LLMO_HLX_API_KEY: 'hlx_test_api_key',
        },
      };

      try {
        await llmoController.getLlmoSheetData(mockContext);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('External API returned 404');
        expect(mockContext.log.error.callCount).to.be.greaterThan(0);
        const errorCallArgs = mockContext.log.error.getCall(0).args[0];
        expect(errorCallArgs).to.include('Failed to fetch data from external endpoint: 404 Not Found');
      }
    });
  });
});
