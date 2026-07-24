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
import {
  derivePreviousPeriod,
  buildKpiHeadlinePayload,
  buildBrandUrlsPayload,
  transformBrandUrlsResponse,
  buildSourceVisibilityPayload,
  transformKpiHeadlineResponse,
} from '../../../../src/support/elements/definitions/kpi-headlines.js';

describe('kpi-headlines definitions', () => {
  describe('derivePreviousPeriod', () => {
    it('derives the immediately preceding period of equal length', () => {
      expect(derivePreviousPeriod('2026-06-25', '2026-07-24')).to.deep.equal({
        comparisonStartDate: '2026-05-26',
        comparisonEndDate: '2026-06-24',
      });
    });

    it('handles a single-day range', () => {
      expect(derivePreviousPeriod('2026-07-24', '2026-07-24')).to.deep.equal({
        comparisonStartDate: '2026-07-23',
        comparisonEndDate: '2026-07-23',
      });
    });
  });

  describe('buildKpiHeadlinePayload', () => {
    it('builds a brand-name-scoped payload with the derived comparison period', () => {
      const payload = buildKpiHeadlinePayload({
        brandName: 'Lovesac',
        model: 'chatgpt',
        startDate: '2026-06-25',
        endDate: '2026-07-24',
        projectIds: ['proj-1', 'proj-2'],
      });
      expect(payload).to.deep.equal({
        comparison_data_formatting: 'union',
        auto_bucketing: 'date',
        filters: {
          simple: {
            start_date: '2026-06-25',
            end_date: '2026-07-24',
            comparison_start_date: '2026-05-26',
            comparison_end_date: '2026-06-24',
          },
          advanced: {
            op: 'and',
            filters: [
              { op: 'eq', val: 'Lovesac', col: 'CBF_ws_brand' },
              { op: 'or', filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }] },
              {
                op: 'or',
                filters: [
                  { op: 'eq', val: 'proj-1', col: 'CBF_project' },
                  { op: 'eq', val: 'proj-2', col: 'CBF_project' },
                ],
              },
            ],
          },
        },
      });
    });

    it('omits the project filter when no projectIds are given', () => {
      const payload = buildKpiHeadlinePayload({
        brandName: 'Lovesac', startDate: '2026-06-25', endDate: '2026-07-24',
      });
      expect(payload.filters.advanced.filters).to.have.lengthOf(2);
    });
  });

  describe('buildBrandUrlsPayload', () => {
    it('builds a CBF_brand-scoped payload with no date/model/project filters', () => {
      expect(buildBrandUrlsPayload({ brandName: 'Lovesac' })).to.deep.equal({
        filters: {
          simple: {},
          advanced: { op: 'and', filters: [{ op: 'eq', val: 'Lovesac', col: 'CBF_brand' }] },
        },
      });
    });
  });

  describe('transformBrandUrlsResponse', () => {
    it('extracts the URL list from blocks.value', () => {
      const raw = {
        blocks: {
          value: [
            { faviconDomain: 'lovesac.com', value: 'lovesac.com' },
            { faviconDomain: 'instagram.com/lovesac', value: 'instagram.com/lovesac' },
          ],
        },
      };
      expect(transformBrandUrlsResponse(raw)).to.deep.equal(['lovesac.com', 'instagram.com/lovesac']);
    });

    it('filters out non-string / empty values and returns [] when blocks.value is missing', () => {
      expect(transformBrandUrlsResponse({ blocks: { value: [{ value: '' }, { notValue: 1 }, {}] } }))
        .to.deep.equal([]);
      expect(transformBrandUrlsResponse(undefined)).to.deep.equal([]);
      expect(transformBrandUrlsResponse({ blocks: {} })).to.deep.equal([]);
    });
  });

  describe('buildSourceVisibilityPayload', () => {
    it('builds a CBF_brand_urls url_match payload with the derived comparison period', () => {
      const payload = buildSourceVisibilityPayload({
        brandUrls: ['lovesac.com', 'instagram.com/lovesac'],
        model: 'chatgpt',
        startDate: '2026-06-25',
        endDate: '2026-07-24',
        projectIds: ['proj-1'],
      });
      expect(payload).to.deep.equal({
        comparison_data_formatting: 'union',
        auto_bucketing: 'date',
        filters: {
          simple: {
            start_date: '2026-06-25',
            end_date: '2026-07-24',
            comparison_start_date: '2026-05-26',
            comparison_end_date: '2026-06-24',
          },
          advanced: {
            op: 'and',
            filters: [
              {
                op: 'or',
                filters: [
                  { op: 'url_match', val: 'lovesac.com', col: 'CBF_brand_urls' },
                  { op: 'url_match', val: 'instagram.com/lovesac', col: 'CBF_brand_urls' },
                ],
              },
              { op: 'or', filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }] },
              { op: 'or', filters: [{ op: 'eq', val: 'proj-1', col: 'CBF_project' }] },
            ],
          },
        },
      });
    });

    it('builds an empty CBF_brand_urls OR-block when brandUrls is empty (caller is expected to guard before calling)', () => {
      const payload = buildSourceVisibilityPayload({
        brandUrls: [], startDate: '2026-06-25', endDate: '2026-07-24',
      });
      expect(payload.filters.advanced.filters[0]).to.deep.equal({ op: 'or', filters: [] });
    });
  });

  describe('transformKpiHeadlineResponse', () => {
    it('extracts mainValue/secondaryValue from a kpiLineChart response', () => {
      const raw = {
        type: 'kpiLineChart',
        blocks: {
          lineData: [{ x: '2026-07-18T00:00:00Z', y: 0.35 }],
          mainValue: [{ mainValue: 0.3628 }],
          secondaryValue: [
            { period: 'current', secondaryValue: 0.3927 },
            { period: 'previous', secondaryValue: 0.3927 },
          ],
        },
      };
      expect(transformKpiHeadlineResponse(raw)).to.deep.equal({
        value: 0.3628,
        comparisonValue: 0.3927,
      });
    });

    it('defaults to 0 when mainValue/secondaryValue are missing', () => {
      const zeroed = { value: 0, comparisonValue: 0 };
      expect(transformKpiHeadlineResponse({ blocks: {} })).to.deep.equal(zeroed);
      expect(transformKpiHeadlineResponse(undefined)).to.deep.equal(zeroed);
    });

    it('defaults to 0 for a non-numeric mainValue/secondaryValue', () => {
      const raw = {
        blocks: {
          mainValue: [{ mainValue: 'not-a-number' }],
          secondaryValue: [{ secondaryValue: null }],
        },
      };
      expect(transformKpiHeadlineResponse(raw)).to.deep.equal({ value: 0, comparisonValue: 0 });
    });
  });
});
