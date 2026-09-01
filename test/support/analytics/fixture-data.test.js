/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';
import { generateWeeks, generateAnalyticsRows } from '../../../src/support/analytics/fixture-data.js';

describe('fixture-data', () => {
  describe('generateWeeks', () => {
    it('returns Monday-aligned weeks covering the range', () => {
      const weeks = generateWeeks('2026-01-05', '2026-01-20');
      expect(weeks).to.deep.equal(['2026-01-05', '2026-01-12', '2026-01-19']);
    });

    it('aligns a mid-week start date back to its Monday', () => {
      const weeks = generateWeeks('2026-01-07', '2026-01-07');
      expect(weeks).to.deep.equal(['2026-01-05']);
    });
  });

  describe('generateAnalyticsRows', () => {
    const baseParams = {
      orgId: 'org-1',
      brandId: 'brand-1',
      metricId: 'visibilityScore',
      dateFrom: '2026-01-05',
      dateTo: '2026-01-19',
    };

    it('is deterministic for the same request', () => {
      const first = generateAnalyticsRows({ ...baseParams, dimensionIds: ['platform'] });
      const second = generateAnalyticsRows({ ...baseParams, dimensionIds: ['platform'] });
      expect(first).to.deep.equal(second);
    });

    it('produces one row per combination of requested dimension values', () => {
      const rows = generateAnalyticsRows({ ...baseParams, dimensionIds: ['week'] });
      expect(rows).to.have.lengthOf(3);
      expect(rows.map((r) => r.week)).to.deep.equal(['2026-01-05', '2026-01-12', '2026-01-19']);
      rows.forEach((row) => {
        expect(row.visibilityScore).to.be.a('number');
        expect(row.visibilityScore).to.be.within(8, 92);
      });
    });

    it('produces the cartesian product across multiple dimensions', () => {
      const rows = generateAnalyticsRows({ ...baseParams, dimensionIds: ['week', 'platform'] });
      // 3 weeks x 6 platforms
      expect(rows).to.have.lengthOf(18);
    });

    it('narrows candidate values before generating, per an equals/in filter', () => {
      const rows = generateAnalyticsRows({
        ...baseParams,
        dimensionIds: ['platform'],
        filters: [{ dimension: 'platform', operator: 'in', values: ['chatgpt-paid', 'gemini'] }],
      });
      expect(rows.map((r) => r.platform).sort()).to.deep.equal(['chatgpt-paid', 'gemini']);
    });

    it('returns a single row with no requested dimensions', () => {
      const rows = generateAnalyticsRows({ ...baseParams, dimensionIds: [] });
      expect(rows).to.have.lengthOf(1);
      expect(rows[0]).to.have.property('visibilityScore');
    });

    it('rounds sentimentScore to two decimals and other metrics to whole numbers', () => {
      const [row] = generateAnalyticsRows({
        ...baseParams, metricId: 'sentimentScore', dimensionIds: [],
      });
      expect(row.sentimentScore).to.equal(Math.round(row.sentimentScore * 100) / 100);
      const [countRow] = generateAnalyticsRows({
        ...baseParams, metricId: 'brandMentions', dimensionIds: [],
      });
      expect(countRow.brandMentions).to.equal(Math.round(countRow.brandMentions));
    });
  });
});
