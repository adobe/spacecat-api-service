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

import { expect } from 'chai';
import { OpportunitySummaryDto } from '../../src/dto/opportunity-summary.js';

describe('OpportunitySummaryDto', () => {
  describe('toJSON', () => {
    it('calculates pageViews from suggestion rank', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficLost: 1000,
          projectedTrafficValue: 5000,
        }),
      };

      const suggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 100,
        },
        {
          getData: () => ({ url: 'https://example.com/page2' }),
          getRank: () => 200,
        },
      ];

      const result = OpportunitySummaryDto.toJSON(opportunity, suggestions);

      expect(result.pageViews).to.equal(300);
    });

    it('calculates pageViews from traffic_domain field', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficLost: 1000,
          projectedTrafficValue: 5000,
        }),
      };

      const suggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1', traffic_domain: 150 }),
          getRank: () => 0,
        },
      ];

      const result = OpportunitySummaryDto.toJSON(opportunity, suggestions);

      expect(result.pageViews).to.equal(150);
    });

    it('calculates pageViews from trafficDomain field', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficLost: 1000,
          projectedTrafficValue: 5000,
        }),
      };

      const suggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1', trafficDomain: 250 }),
          getRank: () => 0,
        },
      ];

      const result = OpportunitySummaryDto.toJSON(opportunity, suggestions);

      expect(result.pageViews).to.equal(250);
    });

    it('uses paidUrlsData when provided', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficLost: 1000,
          projectedTrafficValue: 5000,
        }),
      };

      const paidUrlsData = {
        urls: ['https://example.com/page1', 'https://example.com/page2'],
        pageViews: 3000,
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, [], paidUrlsData);

      expect(result.urls).to.deep.equal(['https://example.com/page1', 'https://example.com/page2']);
      expect(result.pageViews).to.equal(3000);
    });

    it('extracts URLs from different suggestion fields', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficLost: 1000,
          projectedTrafficValue: 5000,
        }),
      };

      const suggestions = [
        {
          getData: () => ({ url_from: 'https://example.com/from' }),
          getRank: () => 0,
        },
        {
          getData: () => ({ url_to: 'https://example.com/to' }),
          getRank: () => 0,
        },
        {
          getData: () => ({ urlFrom: 'https://example.com/urlFrom' }),
          getRank: () => 0,
        },
        {
          getData: () => ({ urlTo: 'https://example.com/urlTo' }),
          getRank: () => 0,
        },
      ];

      const result = OpportunitySummaryDto.toJSON(opportunity, suggestions);

      expect(result.urls).to.include('https://example.com/from');
      expect(result.urls).to.include('https://example.com/to');
      expect(result.urls).to.include('https://example.com/urlFrom');
      expect(result.urls).to.include('https://example.com/urlTo');
    });

    it('handles opportunity with null getData', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getData: () => null,
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, []);

      expect(result.projectedTrafficLost).to.equal(0);
      expect(result.projectedTrafficValue).to.equal(0);
    });

    it('defaults pageViews to 0 when paidUrlsData has no pageViews', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficLost: 1000,
          projectedTrafficValue: 5000,
        }),
      };

      const paidUrlsData = {
        urls: ['https://example.com/page1'],
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, [], paidUrlsData);

      expect(result.pageViews).to.equal(0);
    });

    it('sets impact for conversion value', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'form-accessibility',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedConversionValue: 69314.31,
        }),
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, []);

      expect(result.impact).to.equal(69314.31);
    });

    it('sets impact for traffic value', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedTrafficValue: 13200,
        }),
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, []);

      expect(result.impact).to.equal(13200);
    });

    it('prioritizes higher impact irrigadless of source, traffic or conversion', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'form-accessibility',
        getStatus: () => 'NEW',
        getData: () => ({
          projectedConversionValue: 5000,
          projectedTrafficValue: 3000,
        }),
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, []);

      expect(result.impact).to.equal(5000);
    });

    it('sets impact to 0 when no values are present', () => {
      const opportunity = {
        getId: () => 'oppty-1',
        getTitle: () => 'Test Opportunity',
        getDescription: () => 'Test Description',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getData: () => ({}),
      };

      const result = OpportunitySummaryDto.toJSON(opportunity, []);

      expect(result.impact).to.equal(0);
    });
  });
});
