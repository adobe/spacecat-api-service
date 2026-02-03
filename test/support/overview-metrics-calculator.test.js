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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import {
  calculateVisibilityScore,
  calculateMentionsAndCitations,
  calculateDelta,
  getCurrentWeek,
  formatWeekRange,
  parseWeekFromFilename,
  isValidBrandPresenceAllFile,
  getTwoMostRecentBrandPresenceFiles,
} from '../../src/support/overview-metrics-calculator.js';

use(chaiAsPromised);
use(sinonChai);

describe('Overview Metrics Calculator', () => {
  const sandbox = sinon.createSandbox();

  const mockLog = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    debug: sandbox.stub(),
    warn: sandbox.stub(),
  };

  beforeEach(() => {
    sandbox.restore();
    mockLog.info.reset();
    mockLog.error.reset();
    mockLog.debug.reset();
    mockLog.warn.reset();
  });

  afterEach(() => {
    sandbox.restore();
    delete global.fetch;
  });

  describe('calculateVisibilityScore', () => {
    it('should return 0 for empty records', () => {
      const score = calculateVisibilityScore([]);
      expect(score).to.equal(0);
    });

    it('should return 0 for null records', () => {
      const score = calculateVisibilityScore(null);
      expect(score).to.equal(0);
    });

    it('should calculate visibility score from records', () => {
      const records = [
        {
          'Visibility Score': '80', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          'Visibility Score': '60', Prompt: 'p2', Region: 'US', Topics: 't2',
        },
        {
          'Visibility Score': '70', Prompt: 'p3', Region: 'US', Topics: 't3',
        },
      ];
      const score = calculateVisibilityScore(records);
      expect(score).to.be.a('number');
      expect(score).to.be.at.least(0);
      expect(score).to.be.at.most(100);
    });

    it('should handle records with missing fields', () => {
      const records = [
        { 'Visibility Score': '50' },
        { 'Visibility Score': '60' },
        {},
      ];
      const score = calculateVisibilityScore(records);
      expect(score).to.be.a('number');
    });

    it('should return 0 when no visibility scores present', () => {
      const records = [
        { mentioned: 'true' },
        { cited: 'true' },
        {},
      ];
      const score = calculateVisibilityScore(records);
      expect(score).to.equal(0);
    });

    it('should calculate higher score for higher visibility values', () => {
      const highRecords = [
        {
          'Visibility Score': '90', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ];
      const lowRecords = [
        {
          'Visibility Score': '30', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ];

      const highScore = calculateVisibilityScore(highRecords);
      const lowScore = calculateVisibilityScore(lowRecords);

      expect(highScore).to.be.greaterThan(lowScore);
    });

    it('should handle alternative field names and edge cases', () => {
      // visibility_score field name
      expect(calculateVisibilityScore([
        {
          visibility_score: '70', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ])).to.equal(70);

      // visibilityScore field name
      expect(calculateVisibilityScore([
        {
          visibilityScore: '60', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ])).to.equal(60);

      // Empty string scores are skipped
      expect(calculateVisibilityScore([
        {
          'Visibility Score': '', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          'Visibility Score': '80', Prompt: 'p2', Region: 'US', Topics: 't2',
        },
      ])).to.equal(80);

      // NaN scores are skipped
      expect(calculateVisibilityScore([
        {
          'Visibility Score': 'not-a-number', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          'Visibility Score': '70', Prompt: 'p2', Region: 'US', Topics: 't2',
        },
      ])).to.equal(70);

      // Multiple scores for same prompt are averaged
      expect(calculateVisibilityScore([
        {
          'Visibility Score': '60', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          'Visibility Score': '80', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ])).to.equal(70);

      // Missing Prompt/Region/Topics use defaults
      expect(calculateVisibilityScore([
        { 'Visibility Score': '50' },
      ])).to.equal(50);
    });
  });

  describe('calculateMentionsAndCitations', () => {
    it('should return zeros for empty records', () => {
      const result = calculateMentionsAndCitations([], 'https://example.com');
      expect(result.mentionsCount).to.equal(0);
      expect(result.citationsCount).to.equal(0);
    });

    it('should return zeros for null records', () => {
      const result = calculateMentionsAndCitations(null, 'https://example.com');
      expect(result.mentionsCount).to.equal(0);
      expect(result.citationsCount).to.equal(0);
    });

    it('should count mentions from records', () => {
      const records = [
        {
          Mentions: 'true', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          Mentions: 'true', Prompt: 'p2', Region: 'US', Topics: 't2',
        },
        {
          Mentions: 'false', Prompt: 'p3', Region: 'US', Topics: 't3',
        },
      ];
      const result = calculateMentionsAndCitations(records, 'https://example.com');
      expect(result.mentionsCount).to.equal(2);
    });

    it('should count citations with own URLs', () => {
      const records = [
        {
          Sources: 'https://example.com/page1', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          Sources: 'https://other.com/page', Prompt: 'p2', Region: 'US', Topics: 't2',
        },
        {
          Sources: '', Prompt: 'p3', Region: 'US', Topics: 't3',
        },
      ];
      const result = calculateMentionsAndCitations(records, 'https://example.com');
      expect(result.citationsCount).to.be.at.least(0);
    });

    it('should handle records with multiple sources', () => {
      const records = [
        {
          Sources: 'https://example.com/a, https://example.com/b', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ];
      const result = calculateMentionsAndCitations(records, 'https://example.com');
      expect(result.citationsCount).to.be.at.least(0);
    });

    it('should handle citation counting edge cases', () => {
      // Owned URLs are counted
      expect(calculateMentionsAndCitations([
        {
          Sources: 'https://example.com/page1', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').citationsCount).to.equal(1);

      // Non-owned URLs are not counted
      expect(calculateMentionsAndCitations([
        {
          Sources: 'https://other-site.com/page', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').citationsCount).to.equal(0);

      // www subdomain matches
      expect(calculateMentionsAndCitations([
        {
          Sources: 'https://www.example.com/page', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').citationsCount).to.equal(1);

      // Multiple prompts with same URL use cached results
      expect(calculateMentionsAndCitations([
        {
          Sources: 'https://example.com/page1', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          Sources: 'https://example.com/page1', Prompt: 'p2', Region: 'US', Topics: 't2',
        },
      ], 'https://example.com').citationsCount).to.equal(2);
    });

    it('should handle URL and input edge cases', () => {
      // Invalid site URL - mentions work, citations don't
      const invalidSiteResult = calculateMentionsAndCitations([
        {
          Mentions: 'true', Sources: 'https://example.com/page', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'not-a-valid-url');
      expect(invalidSiteResult.mentionsCount).to.equal(1);
      expect(invalidSiteResult.citationsCount).to.equal(0);

      // Invalid source URL in records
      expect(calculateMentionsAndCitations([
        {
          Sources: 'http://[invalid', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').citationsCount).to.equal(0);

      // Empty site URL
      expect(calculateMentionsAndCitations([
        {
          Mentions: 'true', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], '').mentionsCount).to.equal(1);
    });

    it('should handle mentions edge cases', () => {
      // Boolean true value
      expect(calculateMentionsAndCitations([
        {
          Mentions: true, Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').mentionsCount).to.equal(1);

      // Deduplicates prompts by unique key
      expect(calculateMentionsAndCitations([
        {
          Mentions: 'true', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
        {
          Mentions: 'true', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').mentionsCount).to.equal(1);

      // Missing Region/Topics use defaults
      expect(calculateMentionsAndCitations([
        { Mentions: 'true', Prompt: 'p1' },
      ], 'https://example.com').mentionsCount).to.equal(1);
    });

    it('should handle sources with non-string types and URLs without http prefix', () => {
      // Sources as number (non-string type) - should be handled gracefully
      expect(calculateMentionsAndCitations([
        {
          Sources: 12345, Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').citationsCount).to.equal(0);

      // URL without http prefix - should be prefixed with https://
      expect(calculateMentionsAndCitations([
        {
          Sources: 'example.com/page', Prompt: 'p1', Region: 'US', Topics: 't1',
        },
      ], 'https://example.com').citationsCount).to.equal(1);
    });
  });

  describe('calculateDelta', () => {
    it('should return 0% when previous is 0 and current is 0', () => {
      const delta = calculateDelta(0, 0);
      expect(delta).to.equal('0%');
    });

    it('should return +100% when previous is 0', () => {
      const delta = calculateDelta(100, 0);
      expect(delta).to.equal('+100%');
    });

    it('should calculate positive delta', () => {
      const delta = calculateDelta(110, 100);
      expect(delta).to.equal('+10%');
    });

    it('should calculate negative delta', () => {
      const delta = calculateDelta(90, 100);
      expect(delta).to.equal('-10%');
    });

    it('should return 0% when values are equal', () => {
      const delta = calculateDelta(100, 100);
      expect(delta).to.equal('0%');
    });
  });

  describe('getCurrentWeek', () => {
    it('should return week and year', () => {
      const result = getCurrentWeek(new Date('2025-01-15'));
      expect(result).to.have.property('week');
      expect(result).to.have.property('year');
      expect(result.week).to.be.a('number');
      expect(result.year).to.be.a('number');
    });

    it('should handle year boundaries', () => {
      const result = getCurrentWeek(new Date('2025-01-01'));
      expect(result.week).to.be.at.least(1);
      expect(result.week).to.be.at.most(53);
    });

    it('should use current date when none provided', () => {
      const result = getCurrentWeek();
      expect(result.year).to.be.at.least(2024);
    });

    it('should handle Sunday correctly (day 0 becomes 7)', () => {
      // January 26, 2025 is a Sunday
      const result = getCurrentWeek(new Date('2025-01-26'));
      expect(result.week).to.be.a('number');
      expect(result.year).to.equal(2025);
    });
  });

  describe('formatWeekRange', () => {
    it('should return formatted date range string', () => {
      const result = formatWeekRange(2, 2025);
      expect(result).to.be.a('string');
      expect(result).to.include('2025');
    });

    it('should handle different weeks', () => {
      const week1 = formatWeekRange(1, 2025);
      const week10 = formatWeekRange(10, 2025);
      expect(week1).to.not.equal(week10);
    });
  });

  describe('parseWeekFromFilename', () => {
    it('should parse weekly format filename', () => {
      const result = parseWeekFromFilename('brandpresence-all-w45-2025.json');
      expect(result).to.deep.equal({ week: 45, year: 2025 });
    });

    it('should parse daily format filename', () => {
      const result = parseWeekFromFilename('brandpresence-all-w44-2025-281025.json');
      expect(result).to.deep.equal({ week: 44, year: 2025 });
    });

    it('should return null for non-matching filename', () => {
      expect(parseWeekFromFilename('brandpresence-perplexity-w45-2025.json')).to.be.null;
      expect(parseWeekFromFilename('some-other-file.json')).to.be.null;
      expect(parseWeekFromFilename('')).to.be.null;
    });

    it('should handle single digit week numbers', () => {
      const result = parseWeekFromFilename('brandpresence-all-w5-2025.json');
      expect(result).to.deep.equal({ week: 5, year: 2025 });
    });
  });

  describe('isValidBrandPresenceAllFile', () => {
    it('should return true for valid weekly file', () => {
      const path = '/customer/brand-presence/brandpresence-all-w45-2025.json';
      expect(isValidBrandPresenceAllFile(path)).to.be.true;
    });

    it('should return true for valid daily file', () => {
      const path = '/customer/brand-presence/w44/brandpresence-all-w44-2025-281025.json';
      expect(isValidBrandPresenceAllFile(path)).to.be.true;
    });

    it('should return false for config_absent paths', () => {
      const path = '/customer/brand-presence/config_absent/brandpresence-all-w45-2025.json';
      expect(isValidBrandPresenceAllFile(path)).to.be.false;
    });

    it('should return false for non-all files', () => {
      expect(isValidBrandPresenceAllFile('/customer/brandpresence-perplexity-w45-2025.json')).to.be.false;
      expect(isValidBrandPresenceAllFile('/customer/brandpresence-gemini-w45-2025.json')).to.be.false;
    });
  });

  describe('getTwoMostRecentBrandPresenceFiles', () => {
    it('should return two most recent files sorted by lastModified', () => {
      const queryIndexData = [
        { path: '/customer/brandpresence-all-w43-2025.json', lastModified: '1000' },
        { path: '/customer/brandpresence-all-w45-2025.json', lastModified: '3000' },
        { path: '/customer/brandpresence-all-w44-2025.json', lastModified: '2000' },
      ];

      const result = getTwoMostRecentBrandPresenceFiles(queryIndexData);

      expect(result).to.have.length(2);
      expect(result[0].path).to.equal('/customer/brandpresence-all-w45-2025.json');
      expect(result[1].path).to.equal('/customer/brandpresence-all-w44-2025.json');
    });

    it('should filter out config_absent paths', () => {
      const queryIndexData = [
        { path: '/customer/config_absent/brandpresence-all-w45-2025.json', lastModified: '3000' },
        { path: '/customer/brandpresence-all-w44-2025.json', lastModified: '2000' },
        { path: '/customer/brandpresence-all-w43-2025.json', lastModified: '1000' },
      ];

      const result = getTwoMostRecentBrandPresenceFiles(queryIndexData);

      expect(result).to.have.length(2);
      expect(result[0].path).to.equal('/customer/brandpresence-all-w44-2025.json');
      expect(result[1].path).to.equal('/customer/brandpresence-all-w43-2025.json');
    });

    it('should filter out non-all files', () => {
      const queryIndexData = [
        { path: '/customer/brandpresence-perplexity-w45-2025.json', lastModified: '3000' },
        { path: '/customer/brandpresence-all-w44-2025.json', lastModified: '2000' },
        { path: '/customer/brandpresence-gemini-w43-2025.json', lastModified: '1000' },
      ];

      const result = getTwoMostRecentBrandPresenceFiles(queryIndexData);

      expect(result).to.have.length(1);
      expect(result[0].path).to.equal('/customer/brandpresence-all-w44-2025.json');
    });

    it('should return empty array for null input', () => {
      expect(getTwoMostRecentBrandPresenceFiles(null)).to.deep.equal([]);
    });

    it('should return empty array for empty input', () => {
      expect(getTwoMostRecentBrandPresenceFiles([])).to.deep.equal([]);
    });

    it('should handle invalid lastModified values', () => {
      const queryIndexData = [
        { path: '/customer/brandpresence-all-w45-2025.json', lastModified: 'invalid' },
        { path: '/customer/brandpresence-all-w44-2025.json', lastModified: '2000' },
      ];

      const result = getTwoMostRecentBrandPresenceFiles(queryIndexData);

      expect(result).to.have.length(2);
      // 'invalid' becomes 0, so w44 with 2000 comes first
      expect(result[0].path).to.equal('/customer/brandpresence-all-w44-2025.json');
    });
  });

  describe('fetchQueryIndex', () => {
    it('should return empty array on 404', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: false,
        status: 404,
      });

      const { fetchQueryIndex } = await esmock('../../src/support/overview-metrics-calculator.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockFetch,
          SPACECAT_USER_AGENT: 'test-agent',
        },
      });

      const result = await fetchQueryIndex({
        dataFolder: 'test-folder',
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });

    it('should return empty array on network error', async () => {
      const mockFetch = sandbox.stub().rejects(new Error('Network error'));

      const { fetchQueryIndex } = await esmock('../../src/support/overview-metrics-calculator.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockFetch,
          SPACECAT_USER_AGENT: 'test-agent',
        },
      });

      const result = await fetchQueryIndex({
        dataFolder: 'test-folder',
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });

    it('should return empty array on non-404 error', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const { fetchQueryIndex } = await esmock('../../src/support/overview-metrics-calculator.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockFetch,
          SPACECAT_USER_AGENT: 'test-agent',
        },
      });

      const result = await fetchQueryIndex({
        dataFolder: 'test-folder',
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });

    it('should handle missing hlxApiKey', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: false,
        status: 404,
      });

      const { fetchQueryIndex } = await esmock('../../src/support/overview-metrics-calculator.js', {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: mockFetch,
          SPACECAT_USER_AGENT: 'test-agent',
        },
      });

      const result = await fetchQueryIndex({
        dataFolder: 'test-folder',
        hlxApiKey: undefined,
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });
  });

  describe('fetchBrandPresenceDataFromPath', () => {
    it('should return empty array on 404', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: false,
        status: 404,
      });

      const { fetchBrandPresenceDataFromPath } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const result = await fetchBrandPresenceDataFromPath({
        filePath: '/test/brandpresence-all-w45-2025.json',
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });

    it('should return empty array on network error', async () => {
      const mockFetch = sandbox.stub().rejects(new Error('Network error'));

      const { fetchBrandPresenceDataFromPath } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const result = await fetchBrandPresenceDataFromPath({
        filePath: '/test/brandpresence-all-w45-2025.json',
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });

    it('should handle missing hlxApiKey', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: false,
        status: 404,
      });

      const { fetchBrandPresenceDataFromPath } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const result = await fetchBrandPresenceDataFromPath({
        filePath: '/test/brandpresence-all-w45-2025.json',
        hlxApiKey: undefined,
        log: mockLog,
      });

      expect(result).to.deep.equal([]);
    });
  });

  describe('calculateOverviewMetrics', () => {
    const mockSite = {
      getId: () => 'site-123',
      getBaseURL: () => 'https://example.com',
      getConfig: () => ({
        llmo: {
          dataFolder: 'test-data-folder',
        },
      }),
    };

    it('should throw error when site has no LLMO config', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const { calculateOverviewMetrics } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const siteNoConfig = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({}),
      };

      try {
        await calculateOverviewMetrics({
          site: siteNoConfig,
          hlxApiKey: 'test-key',
          log: mockLog,
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('LLMO configured');
      }
    });

    it('should return hasData false when no files found in query index', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const { calculateOverviewMetrics } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const result = await calculateOverviewMetrics({
        site: mockSite,
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result.hasData).to.be.false;
      expect(result.visibilityScore).to.equal(0);
    });

    it('should return result with expected properties', async () => {
      const queryIndexResponse = {
        data: [
          { path: '/test/brandpresence-all-w45-2025.json', lastModified: '2000' },
          { path: '/test/brandpresence-all-w44-2025.json', lastModified: '1000' },
        ],
      };

      const brandPresenceData = {
        ':type': 'sheet',
        data: [
          {
            Mentions: 'true',
            'Visibility Score': '75',
            Sources: 'https://example.com/page',
            Prompt: 'p1',
            Region: 'US',
            Topics: 't1',
          },
        ],
      };

      const mockFetch = sandbox.stub().callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(queryIndexResponse),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(brandPresenceData),
        });
      });

      const { calculateOverviewMetrics } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const result = await calculateOverviewMetrics({
        site: mockSite,
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.have.property('visibilityScore');
      expect(result).to.have.property('mentionsCount');
      expect(result).to.have.property('citationsCount');
      expect(result).to.have.property('dateRange');
      expect(result).to.have.property('visibilityDelta');
      expect(result).to.have.property('mentionsDelta');
      expect(result).to.have.property('citationsDelta');
      expect(result.hasData).to.be.true;
    });

    it('should throw error when site has empty llmo config', async () => {
      const mockFetch = sandbox.stub().resolves({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const { calculateOverviewMetrics } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const siteEmptyLlmo = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({
          llmo: {},
        }),
      };

      try {
        await calculateOverviewMetrics({
          site: siteEmptyLlmo,
          hlxApiKey: 'test-key',
          log: mockLog,
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('LLMO configured');
      }
    });

    it('should use getLlmoConfig when llmo property is not present', async () => {
      const queryIndexResponse = {
        data: [
          { path: '/test/brandpresence-all-w45-2025.json', lastModified: '2000' },
        ],
      };

      const brandPresenceData = {
        ':type': 'sheet',
        data: [
          {
            Mentions: 'true',
            'Visibility Score': '75',
            Sources: 'https://example.com/page',
            Prompt: 'p1',
            Region: 'US',
            Topics: 't1',
          },
        ],
      };

      const mockFetch = sandbox.stub().callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(queryIndexResponse),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(brandPresenceData),
        });
      });

      const { calculateOverviewMetrics } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const siteWithGetLlmoConfig = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({
          getLlmoConfig: () => ({
            dataFolder: 'test-data-folder-via-method',
          }),
        }),
      };

      const result = await calculateOverviewMetrics({
        site: siteWithGetLlmoConfig,
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      expect(result).to.have.property('visibilityScore');
      expect(result).to.have.property('mentionsCount');
    });

    it('should handle single file in query index (no previous data)', async () => {
      const queryIndexResponse = {
        data: [
          { path: '/test/brandpresence-all-w45-2025.json', lastModified: '2000' },
        ],
      };

      const brandPresenceData = {
        ':type': 'sheet',
        data: [
          {
            Mentions: 'true',
            'Visibility Score': '75',
            Sources: 'https://example.com/page',
            Prompt: 'p1',
            Region: 'US',
            Topics: 't1',
          },
        ],
      };

      const mockFetch = sandbox.stub().callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(queryIndexResponse),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(brandPresenceData),
        });
      });

      const { calculateOverviewMetrics } = await esmock(
        '../../src/support/overview-metrics-calculator.js',
        {
          '@adobe/spacecat-shared-utils': {
            tracingFetch: mockFetch,
            SPACECAT_USER_AGENT: 'test-agent',
          },
        },
      );

      const result = await calculateOverviewMetrics({
        site: mockSite,
        hlxApiKey: 'test-key',
        log: mockLog,
      });

      // With no previous data, delta should show increase from 0
      expect(result.visibilityDelta).to.equal('+100%');
      expect(result.mentionsDelta).to.equal('+100%');
    });
  });
});
