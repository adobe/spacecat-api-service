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
import { getTop3PagesWithBounceGapTemplate } from '../../../src/controllers/paid/bounce-gap-query-template.js';

describe('Bounce Gap Query Template', () => {
  describe('getTop3PagesWithBounceGapTemplate', () => {
    it('generates query with limit parameter', () => {
      const query = getTop3PagesWithBounceGapTemplate({
        siteId: 'test-site-id',
        tableName: 'test_db.test_table',
        temporalCondition: 'year = 2024 AND week = 23',
        dimensionColumns: 'device',
        groupBy: 'device',
        dimensionColumnsPrefixed: 'a.device',
        pageViewThreshold: 1000,
        limit: 10,
      });

      expect(query).to.be.a('string');
      expect(query).to.include('LIMIT 10');
      expect(query).to.include('test_db.test_table');
      expect(query).to.include('year = 2024 AND week = 23');
      expect(query).to.include('device');
    });

    it('generates query without limit parameter', () => {
      const query = getTop3PagesWithBounceGapTemplate({
        siteId: 'test-site-id',
        tableName: 'test_db.test_table',
        temporalCondition: 'year = 2024 AND week = 23',
        dimensionColumns: 'device',
        groupBy: 'device',
        dimensionColumnsPrefixed: 'a.device',
        pageViewThreshold: 1000,
        limit: null, // No limit
      });

      expect(query).to.be.a('string');
      expect(query).to.not.include('LIMIT');
      expect(query).to.include('test_db.test_table');
      expect(query).to.include('year = 2024 AND week = 23');
      expect(query).to.include('device');
    });

    it('generates query with multiple dimensions', () => {
      const query = getTop3PagesWithBounceGapTemplate({
        siteId: 'test-site-id',
        tableName: 'test_db.test_table',
        temporalCondition: 'year = 2024 AND week = 23',
        dimensionColumns: 'path, device, trf_type',
        groupBy: 'path, device, trf_type',
        dimensionColumnsPrefixed: 'a.path, a.device, a.trf_type',
        pageViewThreshold: 1000,
        limit: 5,
      });

      expect(query).to.include('path');
      expect(query).to.include('device');
      expect(query).to.include('trf_type');
      expect(query).to.include('LIMIT 5');
    });

    it('includes consent in WHERE clause', () => {
      const query = getTop3PagesWithBounceGapTemplate({
        siteId: 'test-site-id',
        tableName: 'test_db.test_table',
        temporalCondition: 'year = 2024 AND week = 23',
        dimensionColumns: 'device',
        groupBy: 'device',
        dimensionColumnsPrefixed: 'a.device',
        pageViewThreshold: 1000,
        limit: 10,
      });

      expect(query).to.include("consent IN ('show', 'hidden')");
    });

    it('includes all required metrics in SELECT clause', () => {
      const query = getTop3PagesWithBounceGapTemplate({
        siteId: 'test-site-id',
        tableName: 'test_db.test_table',
        temporalCondition: 'year = 2024 AND week = 23',
        dimensionColumns: 'device',
        groupBy: 'device',
        dimensionColumnsPrefixed: 'a.device',
        pageViewThreshold: 1000,
        limit: 10,
      });

      // Check for metrics in the agg CTE
      expect(query).to.include('CAST(SUM(pageviews) AS BIGINT)   AS pageviews');
      expect(query).to.include('1 - CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)  AS bounce_rate');
      expect(query).to.include('CAST(a.pageviews AS DOUBLE) / NULLIF(t.total_pv, 0)         AS pct_pageviews');
      expect(query).to.include('CAST(a.clicks AS DOUBLE)      / NULLIF(a.row_count, 0)      AS click_rate');
      expect(query).to.include('CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)      AS engagement_rate');
      expect(query).to.include('approx_percentile(lcp, 0.70)     AS p70_lcp');
      expect(query).to.include('approx_percentile(cls, 0.70)     AS p70_cls');
      expect(query).to.include('approx_percentile(inp, 0.70)     AS p70_inp');
    });

    it('uses min_totals CTE for pre-filtering', () => {
      const query = getTop3PagesWithBounceGapTemplate({
        siteId: 'test-site-id',
        tableName: 'test_db.test_table',
        temporalCondition: 'year = 2024 AND week = 23',
        dimensionColumns: 'device',
        groupBy: 'device',
        dimensionColumnsPrefixed: 'a.device',
        pageViewThreshold: 1000,
        limit: 10,
      });

      expect(query).to.include('WITH min_totals AS');
      expect(query).to.include('SUM(pageviews) >= 1000');
    });
  });
});
