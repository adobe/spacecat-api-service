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

describe('llmo-cache-handler', () => {
  let queryLlmoWithCache;
  let tracingFetchStub;
  let mockContext;
  let mockLlmoConfig;
  let mockLog;
  let mockCache;

  const TEST_SITE_ID = 'test-site-id';
  const TEST_DATA_FOLDER = 'test-data-folder';
  const TEST_DATA_SOURCE = 'test-data-source';
  const TEST_LLMO_API_KEY = 'test-llmo-api-key';

  // Common test data
  const createSheetData = (items) => ({
    ':type': 'sheet',
    data: items,
  });

  const createMultiSheetData = (sheets) => ({
    ':type': 'multi-sheet',
    ...sheets,
  });

  const createMockResponse = (data, ok = true, status = 200) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: sinon.stub().resolves(data),
    headers: new Map([['content-type', 'application/json']]),
  });

  // Helper to setup cache miss and fetch stub
  const setupFetchTest = (data) => {
    mockCache.get.resolves(null);
    tracingFetchStub.resolves(createMockResponse(data));
  };

  // Helper to get fetch URL from stub
  const getFetchUrl = () => tracingFetchStub.getCall(0).args[0];

  // Helper to get fetch options from stub
  const getFetchOptions = () => tracingFetchStub.getCall(0).args[1];

  beforeEach(async () => {
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
      debug: sinon.stub(),
    };

    mockCache = {
      get: sinon.stub().resolves(null),
      set: sinon.stub().resolves(true),
    };

    mockLlmoConfig = {
      dataFolder: TEST_DATA_FOLDER,
    };

    mockContext = {
      log: mockLog,
      env: {
        LLMO_HLX_API_KEY: TEST_LLMO_API_KEY,
      },
      params: {
        siteId: TEST_SITE_ID,
        dataSource: TEST_DATA_SOURCE,
      },
      data: {},
      valkey: {
        cache: mockCache,
      },
    };

    tracingFetchStub = sinon.stub();

    const module = await esmock('../../../src/controllers/llmo/llmo-cache-handler.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: 'test-user-agent',
        tracingFetch: tracingFetchStub,
      },
    });

    queryLlmoWithCache = module.queryLlmoWithCache;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('queryLlmoWithCache - Single File Mode', () => {
    it('should return cached data when cache hit occurs', async () => {
      const cachedData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'Cached Item 1' },
          { id: 2, name: 'Cached Item 2' },
        ],
      };

      mockCache.get.resolves(cachedData);

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(cachedData);
      expect(result.headers).to.be.an('object');
      expect(mockCache.get).to.have.been.calledOnce;
      expect(tracingFetchStub).to.not.have.been.called;
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/Processed result cache HIT/),
      );
    });

    it('should fetch and process data when cache miss occurs', async () => {
      const rawData = createSheetData([
        { id: 1, name: 'Fetched Item 1' },
        { id: 2, name: 'Fetched Item 2' },
      ]);

      setupFetchTest(rawData);

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(rawData);
      expect(tracingFetchStub).to.have.been.calledOnce;
      expect(mockCache.set).to.have.been.calledOnce;
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/Processed result cache MISS/),
      );
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/Fetch from HELIX/),
      );
    });

    it('should construct correct URL for single file', async () => {
      setupFetchTest(createSheetData([]));

      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      const fetchUrl = getFetchUrl();
      expect(fetchUrl).to.include(TEST_DATA_FOLDER);
      expect(fetchUrl).to.include(TEST_DATA_SOURCE);
      expect(fetchUrl).to.include('limit=10000000');
    });

    it('should construct correct URL with sheetType and week', async () => {
      setupFetchTest(createSheetData([]));

      mockContext.params = {
        ...mockContext.params,
        sheetType: 'weekly',
        week: '2025-W01',
      };

      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(getFetchUrl()).to.include('weekly/2025-W01/test-data-source');
    });

    it('should construct correct URL with sheetType only', async () => {
      setupFetchTest(createSheetData([]));

      mockContext.params = {
        ...mockContext.params,
        sheetType: 'monthly',
      };

      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(getFetchUrl()).to.include('monthly/test-data-source');
    });

    it('should include sheet parameter in URL when provided', async () => {
      setupFetchTest(createSheetData([]));

      mockContext.data = {
        sheet: 'products',
      };

      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(getFetchUrl()).to.include('sheet=products');
    });

    it('should handle fetch errors gracefully', async () => {
      mockCache.get.resolves(null);
      tracingFetchStub.rejects(new Error('Network error'));

      await expect(
        queryLlmoWithCache(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('Network error');
    });

    it('should handle non-OK HTTP responses', async () => {
      mockCache.get.resolves(null);
      tracingFetchStub.resolves(createMockResponse({}, false, 500));

      await expect(
        queryLlmoWithCache(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('External API returned 500');
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to fetch data from external endpoint/),
      );
    });

    it('should handle timeout errors', async () => {
      mockCache.get.resolves(null);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      tracingFetchStub.rejects(abortError);

      await expect(
        queryLlmoWithCache(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('Request timeout after 60000ms');
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Request timeout after 60000ms/),
      );
    });

    it('should work without cache (valkey not available)', async () => {
      const rawData = createSheetData([{ id: 1, name: 'Item 1' }]);

      mockContext.valkey = null;
      tracingFetchStub.resolves(createMockResponse(rawData));

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(rawData);
      expect(tracingFetchStub).to.have.been.calledOnce;
    });

    it('should handle cache.set errors gracefully', async () => {
      const rawData = createSheetData([]);
      mockCache.get.resolves(null);
      mockCache.set.rejects(new Error('Cache set failed'));
      tracingFetchStub.resolves(createMockResponse(rawData));

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(rawData);
      // The function should not throw - cache.set errors are logged but not propagated
    });

    it('should include Authorization header with API key', async () => {
      setupFetchTest(createSheetData([]));

      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(getFetchOptions().headers.Authorization).to.equal(`token ${TEST_LLMO_API_KEY}`);
    });

    it('should handle missing API key', async () => {
      setupFetchTest(createSheetData([]));
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(getFetchOptions().headers.Authorization).to.equal('token hlx_api_key_missing');
    });

    it('should handle response without headers', async () => {
      const rawData = createSheetData([{ id: 1 }]);
      mockCache.get.resolves(null);

      const responseWithoutHeaders = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: sinon.stub().resolves(rawData),
        headers: null,
      };

      tracingFetchStub.resolves(responseWithoutHeaders);

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(rawData);
      expect(result.headers).to.deep.equal({});
    });
  });

  describe('queryLlmoWithCache - Query Parameters', () => {
    beforeEach(() => {
      mockCache.get.resolves(null);
    });

    it('should handle include parameter as array', async () => {
      const rawData = createSheetData([
        {
          id: 1, name: 'Item 1', status: 'active', extra: 'data',
        },
        {
          id: 2, name: 'Item 2', status: 'inactive', extra: 'more',
        },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { include: ['id', 'name'] };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0]).to.have.keys(['id', 'name']);
      expect(result.data.data[0]).to.not.have.keys(['status', 'extra']);
    });

    it('should handle sort parameter as array', async () => {
      const rawData = createSheetData([
        { id: 3, name: 'Charlie' },
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { sort: ['name:asc', 'id:desc'] };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0].name).to.equal('Alice');
      expect(result.data.data[1].name).to.equal('Bob');
      expect(result.data.data[2].name).to.equal('Charlie');
    });

    it('should handle offset without limit', async () => {
      const rawData = createSheetData([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
        { id: 3, name: 'Item 3' },
        { id: 4, name: 'Item 4' },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { offset: '2' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data).to.have.length(2);
      expect(result.data.data[0].id).to.equal(3);
      expect(result.data.data[1].id).to.equal(4);
    });

    it('should apply filters to data', async () => {
      const rawData = createSheetData([
        { id: 1, name: 'Item 1', status: 'active' },
        { id: 2, name: 'Item 2', status: 'inactive' },
        { id: 3, name: 'Item 3', status: 'active' },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { 'filter.status': 'active' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data).to.have.length(2);
      expect(result.data.data.every((item) => item.status === 'active')).to.be.true;
    });

    it('should apply inclusions to data', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, name: 'Item 1', status: 'active', extra: 'data',
          },
          {
            id: 2, name: 'Item 2', status: 'inactive', extra: 'more',
          },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        include: 'id,name',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0]).to.have.keys(['id', 'name']);
      expect(result.data.data[0]).to.not.have.keys(['status', 'extra']);
    });

    it('should apply sorting to data', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 3, name: 'Charlie' },
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        sort: 'name:asc',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0].name).to.equal('Alice');
      expect(result.data.data[1].name).to.equal('Bob');
      expect(result.data.data[2].name).to.equal('Charlie');
    });

    it('should apply descending sort to data', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Charlie' },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        sort: 'name:desc',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0].name).to.equal('Charlie');
      expect(result.data.data[1].name).to.equal('Bob');
      expect(result.data.data[2].name).to.equal('Alice');
    });

    it('should apply numeric sorting in ascending order', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 10, score: '100' },
          { id: 2, score: '50' },
          { id: 5, score: '75' },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        sort: 'score:asc',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0].score).to.equal('50');
      expect(result.data.data[1].score).to.equal('75');
      expect(result.data.data[2].score).to.equal('100');
    });

    it('should apply numeric sorting in descending order', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 10, score: '100' },
          { id: 2, score: '50' },
          { id: 5, score: '75' },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        sort: 'score:desc',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data[0].score).to.equal('100');
      expect(result.data.data[1].score).to.equal('75');
      expect(result.data.data[2].score).to.equal('50');
    });

    it('should handle null values in sorting by pushing them to the end', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'Charlie', score: null },
          { id: 2, name: 'Alice', score: '75' },
          { id: 3, name: 'Bob' }, // missing score field becomes undefined
          { id: 4, name: 'Dave', score: '50' },
          { id: 5, name: 'Eve', score: null },
          { id: 6, name: 'Frank', score: '100' },
          { id: 7, name: 'Grace' }, // missing score field becomes undefined
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        sort: 'score:asc',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      // Non-null values should be sorted first
      expect(result.data.data[0].score).to.equal('50');
      expect(result.data.data[1].score).to.equal('75');
      expect(result.data.data[2].score).to.equal('100');
      // Null/undefined values should be at the end (order among nulls doesn't matter)
      const lastFour = result.data.data.slice(3);
      const nullOrUndefinedCount = lastFour.filter((item) => item.score == null).length;
      expect(nullOrUndefinedCount).to.equal(4);
    });

    it('should apply pagination with limit', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
          { id: 3, name: 'Item 3' },
          { id: 4, name: 'Item 4' },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        limit: '2',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data).to.have.length(2);
    });

    it('should apply pagination with limit and offset', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
          { id: 3, name: 'Item 3' },
          { id: 4, name: 'Item 4' },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        limit: '2',
        offset: '2',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data).to.have.length(2);
      expect(result.data.data[0].id).to.equal(3);
      expect(result.data.data[1].id).to.equal(4);
    });

    it('should combine multiple query parameters', async () => {
      const rawData = {
        ':type': 'sheet',
        data: [
          {
            id: 1, name: 'Alice', status: 'active', extra: 'data1',
          },
          {
            id: 2, name: 'Bob', status: 'active', extra: 'data2',
          },
          {
            id: 3, name: 'Charlie', status: 'inactive', extra: 'data3',
          },
          {
            id: 4, name: 'Dave', status: 'active', extra: 'data4',
          },
        ],
      };

      tracingFetchStub.resolves(createMockResponse(rawData));
      mockContext.data = {
        'filter.status': 'active',
        include: 'id,name',
        sort: 'name:desc',
        limit: '2',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.data).to.have.length(2);
      expect(result.data.data[0].name).to.equal('Dave');
      expect(result.data.data[1].name).to.equal('Bob');
      expect(result.data.data[0]).to.have.keys(['id', 'name']);
      expect(result.data.data[0]).to.not.have.keys(['status', 'extra']);
    });
  });

  describe('queryLlmoWithCache - Multi-Sheet Data', () => {
    it('should filter multi-sheet data by sheet names', async () => {
      const rawData = createMultiSheetData({
        sheet1: { data: [{ id: 1 }] },
        sheet2: { data: [{ id: 2 }] },
        sheet3: { data: [{ id: 3 }] },
      });

      setupFetchTest(rawData);
      mockContext.data = { sheets: 'sheet1,sheet3' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.have.property('sheet1');
      expect(result.data).to.have.property('sheet3');
      expect(result.data).to.not.have.property('sheet2');
    });

    it('should handle sheets as array', async () => {
      const rawData = createMultiSheetData({
        sheet1: { data: [{ id: 1 }] },
        sheet2: { data: [{ id: 2 }] },
      });

      setupFetchTest(rawData);
      mockContext.data = { sheets: ['sheet1'] };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.have.property('sheet1');
      expect(result.data).to.not.have.property('sheet2');
    });

    it('should apply filters to multi-sheet data', async () => {
      const rawData = createMultiSheetData({
        sheet1: {
          data: [
            { id: 1, status: 'active' },
            { id: 2, status: 'inactive' },
          ],
        },
        sheet2: {
          data: [
            { id: 3, status: 'active' },
            { id: 4, status: 'inactive' },
          ],
        },
      });

      setupFetchTest(rawData);
      mockContext.data = { 'filter.status': 'active' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.sheet1.data).to.have.length(1);
      expect(result.data.sheet1.data[0].id).to.equal(1);
      expect(result.data.sheet2.data).to.have.length(1);
      expect(result.data.sheet2.data[0].id).to.equal(3);
    });

    it('should apply sorting to multi-sheet data', async () => {
      const rawData = createMultiSheetData({
        sheet1: {
          data: [
            { id: 3, name: 'Charlie' },
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        },
        sheet2: {
          data: [
            { id: 6, name: 'Frank' },
            { id: 4, name: 'Dave' },
            { id: 5, name: 'Eve' },
          ],
        },
      });

      setupFetchTest(rawData);
      mockContext.data = { sort: 'name:asc' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.sheet1.data[0].name).to.equal('Alice');
      expect(result.data.sheet1.data[1].name).to.equal('Bob');
      expect(result.data.sheet1.data[2].name).to.equal('Charlie');
      expect(result.data.sheet2.data[0].name).to.equal('Dave');
      expect(result.data.sheet2.data[1].name).to.equal('Eve');
      expect(result.data.sheet2.data[2].name).to.equal('Frank');
    });

    it('should apply pagination to multi-sheet data', async () => {
      const rawData = createMultiSheetData({
        sheet1: {
          data: [
            { id: 1, name: 'Item 1' },
            { id: 2, name: 'Item 2' },
            { id: 3, name: 'Item 3' },
            { id: 4, name: 'Item 4' },
          ],
        },
        sheet2: {
          data: [
            { id: 5, name: 'Item 5' },
            { id: 6, name: 'Item 6' },
            { id: 7, name: 'Item 7' },
            { id: 8, name: 'Item 8' },
          ],
        },
      });

      setupFetchTest(rawData);
      mockContext.data = { limit: '2', offset: '1' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data.sheet1.data).to.have.length(2);
      expect(result.data.sheet1.data[0].id).to.equal(2);
      expect(result.data.sheet1.data[1].id).to.equal(3);
      expect(result.data.sheet2.data).to.have.length(2);
      expect(result.data.sheet2.data[0].id).to.equal(6);
      expect(result.data.sheet2.data[1].id).to.equal(7);
    });
  });

  describe('queryLlmoWithCache - Multi-File Mode', () => {
    it('should fetch and process multiple files', async () => {
      const file1Data = createSheetData([{ id: 1, name: 'File 1' }]);
      const file2Data = createSheetData([{ id: 2, name: 'File 2' }]);

      mockCache.get.resolves(null);
      tracingFetchStub
        .onFirstCall().resolves(createMockResponse(file1Data))
        .onSecondCall()
        .resolves(createMockResponse(file2Data));

      mockContext.data = { file: ['file1.json', 'file2.json'] };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.be.an('array').with.length(2);
      expect(result.data[0].status).to.equal('success');
      expect(result.data[0].path).to.equal('file1.json');
      expect(result.data[0].data).to.deep.equal(file1Data);
      expect(result.data[1].status).to.equal('success');
      expect(result.data[1].path).to.equal('file2.json');
      expect(result.data[1].data).to.deep.equal(file2Data);
      expect(result.headers).to.deep.equal({ 'Content-Encoding': 'br' });
    });

    it('should handle single file as string in multi-file mode', async () => {
      const fileData = createSheetData([{ id: 1, name: 'File 1' }]);

      mockCache.get.resolves(null);
      tracingFetchStub.resolves(createMockResponse(fileData));

      mockContext.data = { file: 'file1.json' };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.be.an('array').with.length(1);
      expect(result.data[0].status).to.equal('success');
      expect(result.data[0].path).to.equal('file1.json');
    });

    it('should handle file fetch errors in multi-file mode', async () => {
      const file1Data = createSheetData([{ id: 1, name: 'File 1' }]);

      mockCache.get.resolves(null);
      tracingFetchStub
        .onFirstCall().resolves(createMockResponse(file1Data))
        .onSecondCall()
        .rejects(new Error('Network error'));

      mockContext.data = { file: ['file1.json', 'file2.json'] };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data).to.be.an('array').with.length(2);
      expect(result.data[0].status).to.equal('success');
      expect(result.data[1].status).to.equal('error');
      expect(result.data[1].error).to.equal('Network error');
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Error fetching and processing file file2.json/),
      );
    });

    it('should apply query params to each file in multi-file mode', async () => {
      const file1Data = createSheetData([
        { id: 1, name: 'Item 1', status: 'active' },
        { id: 2, name: 'Item 2', status: 'inactive' },
      ]);
      const file2Data = createSheetData([
        { id: 3, name: 'Item 3', status: 'active' },
        { id: 4, name: 'Item 4', status: 'inactive' },
      ]);

      mockCache.get.resolves(null);
      tracingFetchStub
        .onFirstCall().resolves(createMockResponse(file1Data))
        .onSecondCall()
        .resolves(createMockResponse(file2Data));

      mockContext.data = {
        file: ['file1.json', 'file2.json'],
        'filter.status': 'active',
      };

      const result = await queryLlmoWithCache(mockContext, mockLlmoConfig);

      expect(result.data[0].data.data).to.have.length(1);
      expect(result.data[0].data.data[0].id).to.equal(1);
      expect(result.data[1].data.data).to.have.length(1);
      expect(result.data[1].data.data[0].id).to.equal(3);
    });
  });

  describe('queryLlmoWithCache - Cache Key Generation', () => {
    it('should generate different cache keys for different query params', async () => {
      const rawData = createSheetData([]);
      setupFetchTest(rawData);

      // First call with filter
      mockContext.data = { 'filter.status': 'active' };
      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      const firstCacheKey = mockCache.get.getCall(0).args[0];

      // Reset mocks
      mockCache.get.resetHistory();
      mockCache.set.resetHistory();

      // Second call with different filter
      mockContext.data = { 'filter.status': 'inactive' };
      tracingFetchStub.resolves(createMockResponse(rawData));
      await queryLlmoWithCache(mockContext, mockLlmoConfig);

      const secondCacheKey = mockCache.get.getCall(0).args[0];

      expect(firstCacheKey).to.not.equal(secondCacheKey);
    });

    it('should generate the same cache key for the same query params', async () => {
      const rawData = createSheetData([]);
      tracingFetchStub.resolves(createMockResponse(rawData));

      mockContext.data = {
        'filter.status': 'active',
        limit: '10',
      };

      await queryLlmoWithCache(mockContext, mockLlmoConfig);
      const firstCacheKey = mockCache.get.getCall(0).args[0];

      // Reset mocks
      mockCache.get.resetHistory();
      mockCache.set.resetHistory();

      // Second call with same params (but potentially in different order in object)
      mockContext.data = {
        limit: '10',
        'filter.status': 'active',
      };

      await queryLlmoWithCache(mockContext, mockLlmoConfig);
      const secondCacheKey = mockCache.get.getCall(0).args[0];

      expect(firstCacheKey).to.equal(secondCacheKey);
    });
  });
});
