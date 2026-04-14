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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

describe('email-traffic-data', () => {
  let sandbox;
  let mockLog;
  let mockAthenaQuery;
  let fetchEmailTrafficData;
  let filterHighTrafficPoorCwv;
  let getCwvThresholds;
  let getTemporalParameters;
  let getCacheKey;
  let mockFileExists;
  let mockGetCachedJsonData;
  let mockAddResultJsonToCache;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockLog = {
      info: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    mockAthenaQuery = sandbox.stub();
    mockFileExists = sandbox.stub();
    mockGetCachedJsonData = sandbox.stub();
    mockAddResultJsonToCache = sandbox.stub();

    const mod = await esmock(
      '../../../src/controllers/email/email-traffic-data.js',
      {
        '../../../src/controllers/paid/caching-helper.js': {
          fileExists: mockFileExists,
          getCachedJsonData: mockGetCachedJsonData,
          addResultJsonToCache: mockAddResultJsonToCache,
        },
      },
    );

    fetchEmailTrafficData = mod.fetchEmailTrafficData;
    filterHighTrafficPoorCwv = mod.filterHighTrafficPoorCwv;
    getCwvThresholds = mod.getCwvThresholds;
    getTemporalParameters = mod.getTemporalParameters;
    getCacheKey = mod.getCacheKey;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getCwvThresholds', () => {
    it('returns empty object for null input', () => {
      expect(getCwvThresholds(null, mockLog)).to.deep.equal({});
    });

    it('returns empty object for undefined input', () => {
      expect(getCwvThresholds(undefined, mockLog)).to.deep.equal({});
    });

    it('parses JSON string', () => {
      expect(getCwvThresholds('{"lcp":2500}', mockLog)).to.deep.equal({ lcp: 2500 });
    });

    it('returns object as-is', () => {
      const obj = { lcp: 2500 };
      expect(getCwvThresholds(obj, mockLog)).to.equal(obj);
    });

    it('returns empty object for invalid JSON', () => {
      expect(getCwvThresholds('bad-json', mockLog)).to.deep.equal({});
      expect(mockLog.warn).to.have.been.calledOnce;
    });
  });

  describe('getTemporalParameters', () => {
    it('returns provided year and week', () => {
      const result = getTemporalParameters({ year: 2024, week: 23 }, mockLog);
      expect(result.yearInt).to.equal(2024);
      expect(result.weekInt).to.equal(23);
      expect(result.monthInt).to.equal(0);
    });

    it('returns provided year and month', () => {
      const result = getTemporalParameters({ year: 2024, month: 6 }, mockLog);
      expect(result.yearInt).to.equal(2024);
      expect(result.weekInt).to.equal(0);
      expect(result.monthInt).to.equal(6);
    });

    it('uses defaults when no year/week/month provided', () => {
      const result = getTemporalParameters({}, mockLog);
      expect(result.yearInt).to.be.a('number');
      expect(mockLog.warn).to.have.been.called;
    });

    it('uses defaults for null contextData', () => {
      const result = getTemporalParameters(null, mockLog);
      expect(result.yearInt).to.be.a('number');
    });
  });

  describe('getCacheKey', () => {
    it('generates unique cache key with email suffix', () => {
      const result1 = getCacheKey('site1', 'query1', 's3://bucket/cache', 1000);
      const result2 = getCacheKey('site1', 'query2', 's3://bucket/cache', 1000);
      expect(result1.cacheKey).to.not.equal(result2.cacheKey);
      expect(result1.cacheKey).to.include('site1');
    });
  });

  describe('fetchEmailTrafficData', () => {
    let mockSite;
    let mockContext;

    beforeEach(() => {
      mockSite = {
        getId: () => 'site-123',
        getBaseURL: sandbox.stub().resolves('https://www.example.com'),
      };
      mockContext = {
        env: {
          RUM_METRICS_DATABASE: 'test-db',
          RUM_METRICS_COMPACT_TABLE: 'test-table',
          S3_BUCKET_NAME: 'test-bucket',
          EMAIL_DATA_THRESHOLD: 500,
        },
        s3: {
          s3Client: sandbox.stub(),
        },
        data: { year: 2024, week: 23 },
        athenaClient: { query: mockAthenaQuery },
      };
    });

    it('returns filtered email traffic data from Athena', async () => {
      mockFileExists.resolves(false);
      mockAddResultJsonToCache.resolves(true);
      mockAthenaQuery.resolves([
        { path: '/page1', utm_medium: 'email', pageviews: '500' },
        { path: '/page2', utm_medium: 'social', pageviews: '300' },
        { path: '/page3', utm_medium: 'email', pageviews: '200' },
      ]);

      const result = await fetchEmailTrafficData(mockContext, mockSite, mockLog);
      // Only email rows returned
      expect(result).to.have.length(2);
    });

    it('returns cached data when available', async () => {
      const cachedData = [{ path: '/cached', pageviews: '100' }];
      mockFileExists.resolves(true);
      mockGetCachedJsonData.resolves(cachedData);

      const result = await fetchEmailTrafficData(mockContext, mockSite, mockLog);
      expect(result).to.deep.equal(cachedData);
      expect(mockAthenaQuery).to.not.have.been.called;
    });

    it('queries Athena when no cache and no S3', async () => {
      mockContext.s3 = null;
      mockAthenaQuery.resolves([
        { path: '/page1', utm_medium: 'email', pageviews: '500' },
      ]);

      const result = await fetchEmailTrafficData(mockContext, mockSite, mockLog);
      expect(result).to.have.length(1);
      expect(mockAthenaQuery).to.have.been.calledOnce;
    });

    it('caches result after Athena query', async () => {
      mockFileExists.resolves(false);
      mockAddResultJsonToCache.resolves(true);
      mockAthenaQuery.resolves([
        { path: '/page1', utm_medium: 'email', pageviews: '500' },
      ]);

      await fetchEmailTrafficData(mockContext, mockSite, mockLog);
      expect(mockAddResultJsonToCache).to.have.been.calledOnce;
    });

    it('does not cache empty results', async () => {
      mockFileExists.resolves(false);
      mockAthenaQuery.resolves([]);

      await fetchEmailTrafficData(mockContext, mockSite, mockLog);
      expect(mockAddResultJsonToCache).to.not.have.been.called;
    });
  });

  describe('filterHighTrafficPoorCwv', () => {
    it('filters for high traffic and poor CWV', () => {
      const data = [
        { pageviews: '1500', overall_cwv_score: 'poor' },
        { pageviews: '500', overall_cwv_score: 'poor' },
        { pageviews: '2000', overall_cwv_score: 'good' },
        { pageviews: '1200', overall_cwv_score: 'needs improvement' },
      ];
      const result = filterHighTrafficPoorCwv(data, 1000, mockLog);
      expect(result).to.have.length(2);
      // Sorted by pageviews descending
      expect(Number(result[0].pageviews)).to.equal(1500);
      expect(Number(result[1].pageviews)).to.equal(1200);
    });

    it('returns empty array when no matches', () => {
      const data = [
        { pageviews: '500', overall_cwv_score: 'good' },
      ];
      const result = filterHighTrafficPoorCwv(data, 1000, mockLog);
      expect(result).to.deep.equal([]);
    });

    it('returns empty array for empty input', () => {
      const result = filterHighTrafficPoorCwv([], 1000, mockLog);
      expect(result).to.deep.equal([]);
    });
  });
});
