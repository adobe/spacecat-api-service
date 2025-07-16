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

  describe('getLlmoData', () => {
    it('should proxy data from external endpoint', async () => {
      const mockExternalData = {
        brandPresence: {
          score: 85.5,
          metrics: {
            visibility: 90,
            engagement: 78,
            reach: 82,
          },
        },
        timestamp: '2025-01-15T10:30:00Z',
        source: 'brandpresence-all-w28-2025',
      };

      const mockResponse = {
        ok: true,
        json: async () => mockExternalData,
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
      };

      const result = await llmoController.getLlmoData(mockContext);
      const body = await readStreamToJson(result.body);

      expect(result).to.have.property('status', 200);
      expect(body).to.deep.equal(mockExternalData);

      // Verify fetch was called with correct parameters
      expect(fetchStub.calledOnce).to.be.true;
      const fetchCall = fetchStub.getCall(0);
      expect(fetchCall.args[0]).to.equal('https://d1vm7168yg1w6d.cloudfront.net/adobe/brandpresence-all-w28-2025.json');
      expect(fetchCall.args[1].headers).to.deep.include({
        Referer: 'https://dev.d2ikwb7s634epv.amplifyapp.com/',
        'User-Agent': 'SpaceCat-API-Service/1.0',
      });

      // Verify logging
      expect(mockContext.log.info.callCount).to.be.greaterThan(0);
      expect(mockContext.log.info.getCall(0).args[0]).to.include('Successfully proxied data');
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
      };

      try {
        await llmoController.getLlmoData(mockContext);
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
      };

      try {
        await llmoController.getLlmoData(mockContext);
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
