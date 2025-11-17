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

describe('llmo-query-handler', () => {
  let queryLlmoFiles;
  let tracingFetchStub;
  let mockContext;
  let mockLlmoConfig;
  let mockLog;

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

  // Helper to setup fetch stub
  const setupFetchTest = (data) => {
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
    };

    tracingFetchStub = sinon.stub();

    const module = await esmock('../../../src/controllers/llmo/llmo-query-handler.js', {
      '@adobe/spacecat-shared-utils': {
        SPACECAT_USER_AGENT: 'test-user-agent',
        tracingFetch: tracingFetchStub,
      },
    });

    queryLlmoFiles = module.queryLlmoFiles;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('queryLlmoFiles - Single File Mode', () => {
    it('should return files data', async () => {
      const filesData = {
        ':type': 'sheet',
        data: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
        ],
      };

      setupFetchTest(filesData);

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(filesData);
      expect(result.headers).to.be.an('object');
      expect(tracingFetchStub).to.have.been.calledOnce;
      expect(mockLog.info).to.have.been.calledWith(
        sinon.match(/Fetch from HELIX/),
      );
    });

    it('should construct correct URL for single file', async () => {
      setupFetchTest(createSheetData([]));

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      const fetchUrl = getFetchUrl();
      expect(fetchUrl).to.include(TEST_DATA_FOLDER);
      expect(fetchUrl).to.include(TEST_DATA_SOURCE);
    });

    it('should construct correct URL with sheetType and week', async () => {
      setupFetchTest(createSheetData([]));

      mockContext.params = {
        ...mockContext.params,
        sheetType: 'weekly',
        week: '2025-W01',
      };

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(getFetchUrl()).to.include('weekly/2025-W01/test-data-source');
    });

    it('should construct correct URL with sheetType only', async () => {
      setupFetchTest(createSheetData([]));

      mockContext.params = {
        ...mockContext.params,
        sheetType: 'monthly',
      };

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(getFetchUrl()).to.include('monthly/test-data-source');
    });

    it('should include sheet parameter in URL when provided', async () => {
      setupFetchTest(createSheetData([]));

      mockContext.data = {
        sheet: 'products',
      };

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(getFetchUrl()).to.include('sheet=products');
    });

    it('should handle fetch errors gracefully', async () => {
      tracingFetchStub.rejects(new Error('Network error'));

      await expect(
        queryLlmoFiles(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('Network error');
    });

    it('should handle non-OK HTTP responses', async () => {
      tracingFetchStub.resolves(createMockResponse({}, false, 500));

      await expect(
        queryLlmoFiles(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('External API returned 500');
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Failed to fetch data from external endpoint/),
      );
    });

    it('should handle timeout errors', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      tracingFetchStub.rejects(abortError);

      await expect(
        queryLlmoFiles(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('Request timeout after 15000ms');
      expect(mockLog.error).to.have.been.calledWith(
        sinon.match(/Request timeout after 15000ms/),
      );
    });

    it('should include Authorization header with API key', async () => {
      setupFetchTest(createSheetData([]));

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(getFetchOptions().headers.Authorization).to.equal(`token ${TEST_LLMO_API_KEY}`);
    });

    it('should handle missing API key', async () => {
      setupFetchTest(createSheetData([]));
      mockContext.env.LLMO_HLX_API_KEY = undefined;

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(getFetchOptions().headers.Authorization).to.equal('token hlx_api_key_missing');
    });

    it('should handle response without headers', async () => {
      const rawData = createSheetData([{ id: 1 }]);

      const responseWithoutHeaders = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: sinon.stub().resolves(rawData),
        headers: null,
      };

      tracingFetchStub.resolves(responseWithoutHeaders);

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data).to.deep.equal(rawData);
      expect(result.headers).to.deep.equal({});
    });
  });

  describe('queryLlmoFiles - Query Parameters', () => {
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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data.data[0].name).to.equal('Alice');
      expect(result.data.data[1].name).to.equal('Bob');
      expect(result.data.data[2].name).to.equal('Charlie');
    });

    it('should apply filters to data', async () => {
      const rawData = createSheetData([
        { id: 1, name: 'Item 1', status: 'active' },
        { id: 2, name: 'Item 2', status: 'inactive' },
        { id: 3, name: 'Item 3', status: 'active' },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { 'filter.status': 'active' };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      // Non-null values should be sorted first
      expect(result.data.data[0].score).to.equal('50');
      expect(result.data.data[1].score).to.equal('75');
      expect(result.data.data[2].score).to.equal('100');
      // Null/undefined values should be at the end (order among nulls doesn't matter)
      const lastFour = result.data.data.slice(3);
      const nullOrUndefinedCount = lastFour.filter((item) => item.score == null).length;
      expect(nullOrUndefinedCount).to.equal(4);
    });

    it('should handle offset parameter', async () => {
      const rawData = createSheetData([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { offset: '5' };

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      const fetchUrl = getFetchUrl();
      expect(fetchUrl).to.include('offset=5');
    });

    it('should handle limit parameter', async () => {
      const rawData = createSheetData([
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ]);

      setupFetchTest(rawData);
      mockContext.data = { limit: '50' };

      await queryLlmoFiles(mockContext, mockLlmoConfig);

      const fetchUrl = getFetchUrl();
      expect(fetchUrl).to.include('limit=50');
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
      };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data.data).to.have.length(3);
      expect(result.data.data[0].name).to.equal('Dave');
      expect(result.data.data[1].name).to.equal('Bob');
      expect(result.data.data[2].name).to.equal('Alice');
      expect(result.data.data[0]).to.have.keys(['id', 'name']);
      expect(result.data.data[0]).to.not.have.keys(['status', 'extra']);
    });
  });

  describe('queryLlmoFiles - Multi-Sheet Data', () => {
    it('should filter multi-sheet data by sheet names', async () => {
      const rawData = createMultiSheetData({
        sheet1: { data: [{ id: 1 }] },
        sheet2: { data: [{ id: 2 }] },
        sheet3: { data: [{ id: 3 }] },
      });

      setupFetchTest(rawData);
      mockContext.data = { sheets: 'sheet1,sheet3' };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data.sheet1.data[0].name).to.equal('Alice');
      expect(result.data.sheet1.data[1].name).to.equal('Bob');
      expect(result.data.sheet1.data[2].name).to.equal('Charlie');
      expect(result.data.sheet2.data[0].name).to.equal('Dave');
      expect(result.data.sheet2.data[1].name).to.equal('Eve');
      expect(result.data.sheet2.data[2].name).to.equal('Frank');
    });
  });

  describe('queryLlmoFiles - Multi-File Mode', () => {
    it('should fetch and process multiple files', async () => {
      const file1Data = createSheetData([{ id: 1, name: 'File 1' }]);
      const file2Data = createSheetData([{ id: 2, name: 'File 2' }]);

      tracingFetchStub
        .onFirstCall().resolves(createMockResponse(file1Data))
        .onSecondCall()
        .resolves(createMockResponse(file2Data));

      // Remove dataSource to enable multi-file mode
      mockContext.params = { siteId: TEST_SITE_ID };
      mockContext.data = { file: ['file1.json', 'file2.json', 'file1.json', 'file2.json', 'file1.json', 'file2.json', 'file1.json', 'file2.json', 'file1.json', 'file2.json', 'file1.json', 'file2.json'] };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data).to.be.an('array').with.length(12);
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

      tracingFetchStub.resolves(createMockResponse(fileData));

      // Remove dataSource to enable multi-file mode
      mockContext.params = { siteId: TEST_SITE_ID };
      mockContext.data = { file: 'file1.json' };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data).to.be.an('array').with.length(1);
      expect(result.data[0].status).to.equal('success');
      expect(result.data[0].path).to.equal('file1.json');
    });

    it('should handle file fetch errors in multi-file mode', async () => {
      const file1Data = createSheetData([{ id: 1, name: 'File 1' }]);

      tracingFetchStub
        .onFirstCall().resolves(createMockResponse(file1Data))
        .onSecondCall()
        .rejects(new Error('Network error'));

      // Remove dataSource to enable multi-file mode
      mockContext.params = { siteId: TEST_SITE_ID };
      mockContext.data = { file: ['file1.json', 'file2.json'] };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

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

      tracingFetchStub
        .onFirstCall().resolves(createMockResponse(file1Data))
        .onSecondCall()
        .resolves(createMockResponse(file2Data));

      // Remove dataSource to enable multi-file mode
      mockContext.params = { siteId: TEST_SITE_ID };
      mockContext.data = {
        file: ['file1.json', 'file2.json'],
        'filter.status': 'active',
      };

      const result = await queryLlmoFiles(mockContext, mockLlmoConfig);

      expect(result.data[0].data.data).to.have.length(1);
      expect(result.data[0].data.data[0].id).to.equal(1);
      expect(result.data[1].data.data).to.have.length(1);
      expect(result.data[1].data.data[0].id).to.equal(3);
    });
  });

  describe('queryLlmoFiles - Error Handling', () => {
    it('should throw error when neither dataSource nor file is provided', async () => {
      // Remove dataSource from params
      mockContext.params = {
        siteId: TEST_SITE_ID,
      };
      // Ensure no file query param
      mockContext.data = {};

      await expect(
        queryLlmoFiles(mockContext, mockLlmoConfig),
      ).to.be.rejectedWith('Either dataSource path parameter or file query parameter must be provided');
    });
  });
});
