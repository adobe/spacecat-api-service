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
import {
  normalizeUrl,
  isValidOpportunity,
  categorizeOpportunities,
  processOpportunityMatching,
  combineAndSortOpportunities,
  OPPORTUNITY_TYPE_CONFIGS,
} from '../../../src/controllers/email/opportunity-matcher.js';

use(chaiAsPromised);
use(sinonChai);

function createMockOpportunity(overrides = {}) {
  const defaults = {
    id: `opp-${Math.random().toString(36).substr(2, 9)}`,
    type: 'cwv',
    title: 'Test Opportunity',
    description: 'A test opportunity',
    tags: [],
    data: { projectedTrafficValue: 100 },
    guidance: null,
    status: 'NEW',
  };
  const merged = { ...defaults, ...overrides };
  return {
    getId: () => merged.id,
    getType: () => merged.type,
    getTitle: () => merged.title,
    getDescription: () => merged.description,
    getTags: () => merged.tags,
    getData: () => merged.data,
    getGuidance: () => merged.guidance,
    getStatus: () => merged.status,
  };
}

describe('Email opportunity-matcher', () => {
  let sandbox;
  let mockLog;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockLog = {
      info: sandbox.stub(),
      debug: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('normalizeUrl', () => {
    it('removes www prefix', () => {
      expect(normalizeUrl('https://www.example.com/page')).to.equal('https://example.com/page');
    });

    it('removes trailing slash', () => {
      expect(normalizeUrl('https://example.com/page/')).to.equal('https://example.com/page');
    });

    it('handles http protocol', () => {
      expect(normalizeUrl('http://www.example.com/page')).to.equal('https://example.com/page');
    });
  });

  describe('isValidOpportunity', () => {
    it('returns true for valid opportunity', () => {
      const oppData = {
        title: 'Valid',
        description: 'Has description',
        data: { projectedTrafficValue: 100 },
        type: 'cwv',
        original: { getGuidance: () => null },
      };
      expect(isValidOpportunity(oppData)).to.be.true;
    });

    it('returns false when no description', () => {
      const oppData = {
        title: 'Test',
        description: null,
        data: { projectedTrafficValue: 100 },
        type: 'cwv',
        original: {},
      };
      expect(isValidOpportunity(oppData)).to.be.false;
    });

    it('returns false when title includes report', () => {
      const oppData = {
        title: 'Monthly Report',
        description: 'Has description',
        data: { projectedTrafficValue: 100 },
        type: 'cwv',
        original: {},
      };
      expect(isValidOpportunity(oppData)).to.be.false;
    });

    it('returns false when no value metrics', () => {
      const oppData = {
        title: 'Test',
        description: 'Has description',
        data: {},
        type: 'cwv',
        original: {},
      };
      expect(isValidOpportunity(oppData)).to.be.false;
    });

    it('accepts projectedConversionValue', () => {
      const oppData = {
        title: 'Test',
        description: 'Has description',
        data: { projectedConversionValue: 50 },
        type: 'cwv',
        original: {},
      };
      expect(isValidOpportunity(oppData)).to.be.true;
    });

    it('accepts projectedEngagementValue', () => {
      const oppData = {
        title: 'Test',
        description: 'Has description',
        data: { projectedEngagementValue: 30 },
        type: 'cwv',
        original: {},
      };
      expect(isValidOpportunity(oppData)).to.be.true;
    });

    it('returns false for forms with scrapedStatus=false', () => {
      const oppData = {
        title: 'Test',
        description: 'Has description',
        data: { projectedConversionValue: 50, scrapedStatus: false },
        type: 'high-form-views-low-conversions',
        original: {},
      };
      expect(isValidOpportunity(oppData)).to.be.false;
    });

    it('returns false for forms with null brief in guidance', () => {
      const oppData = {
        title: 'Test',
        description: 'Has description',
        data: { projectedConversionValue: 50 },
        type: 'high-form-views-low-conversions',
        original: {
          getGuidance: () => ({
            recommendations: [{ brief: null }],
          }),
        },
      };
      expect(isValidOpportunity(oppData)).to.be.false;
    });
  });

  describe('OPPORTUNITY_TYPE_CONFIGS', () => {
    it('has emailCampaign, cwv, and forms categories', () => {
      const categories = OPPORTUNITY_TYPE_CONFIGS.map((c) => c.category);
      expect(categories).to.include('emailCampaign');
      expect(categories).to.include('cwv');
      expect(categories).to.include('forms');
    });

    it('emailCampaign matcher matches email traffic tags', () => {
      const config = OPPORTUNITY_TYPE_CONFIGS.find((c) => c.category === 'emailCampaign');
      expect(config.matcher({ tags: ['email traffic'] })).to.be.true;
      expect(config.matcher({ tags: ['email campaign'] })).to.be.true;
      expect(config.matcher({ tags: [], data: { opportunityType: 'email-traffic' } })).to.be.true;
      expect(config.matcher({ tags: ['other'], data: {} })).to.be.false;
    });

    it('cwv matcher matches cwv type', () => {
      const config = OPPORTUNITY_TYPE_CONFIGS.find((c) => c.category === 'cwv');
      expect(config.matcher({ type: 'cwv' })).to.be.true;
      expect(config.matcher({ type: 'other' })).to.be.false;
    });

    it('forms matcher matches form types', () => {
      const config = OPPORTUNITY_TYPE_CONFIGS.find((c) => c.category === 'forms');
      expect(config.matcher({ type: 'high-form-views-low-conversions' })).to.be.true;
      expect(config.matcher({ type: 'high-page-views-low-form-nav' })).to.be.true;
      expect(config.matcher({ type: 'other' })).to.be.false;
    });
  });

  describe('categorizeOpportunities', () => {
    it('categorizes opportunities by type', () => {
      const opportunities = [
        createMockOpportunity({
          type: 'cwv',
          description: 'CWV issue',
          data: { projectedTrafficValue: 100 },
        }),
        createMockOpportunity({
          type: 'other',
          tags: ['email traffic'],
          description: 'Email issue',
          data: { projectedTrafficValue: 50 },
        }),
      ];

      const result = categorizeOpportunities(opportunities);
      expect(result.get('cwv')).to.have.length(1);
      expect(result.get('emailCampaign')).to.have.length(1);
      expect(result.get('forms')).to.have.length(0);
    });

    it('filters out invalid opportunities', () => {
      const opportunities = [
        createMockOpportunity({
          type: 'cwv',
          description: null,
          data: { projectedTrafficValue: 100 },
        }),
      ];

      const result = categorizeOpportunities(opportunities);
      expect(result.get('cwv')).to.have.length(0);
    });
  });

  describe('processOpportunityMatching', () => {
    it('returns empty maps when no opportunities need matching', async () => {
      const categorized = new Map();
      categorized.set('emailCampaign', []);
      categorized.set('cwv', []);
      categorized.set('forms', []);

      const result = await processOpportunityMatching(
        categorized,
        [],
        1000,
        new Map(),
        mockLog,
      );

      expect(result.matchResults.size).to.equal(0);
      expect(result.emailUrlsMap.size).to.equal(0);
    });

    it('returns empty maps when no email traffic data', async () => {
      const cwvOpp = createMockOpportunity({
        id: 'opp-1',
        type: 'cwv',
        description: 'CWV issue',
        data: { projectedTrafficValue: 100 },
      });
      const oppData = {
        id: 'opp-1',
        type: 'cwv',
        title: 'Test',
        description: 'CWV issue',
        tags: [],
        data: { projectedTrafficValue: 100 },
        original: cwvOpp,
      };

      const categorized = new Map();
      categorized.set('emailCampaign', []);
      categorized.set('cwv', [oppData]);
      categorized.set('forms', []);

      const result = await processOpportunityMatching(
        categorized,
        [],
        1000,
        new Map(),
        mockLog,
      );

      expect(result.matchResults.size).to.equal(0);
      expect(result.emailUrlsMap.size).to.equal(0);
    });

    it('matches CWV opportunities with email URLs via suggestions', async () => {
      const cwvOpp = createMockOpportunity({
        id: 'opp-1',
        type: 'cwv',
        description: 'CWV issue',
        data: { projectedTrafficValue: 100 },
      });
      const oppData = {
        id: 'opp-1',
        type: 'cwv',
        title: 'Test',
        description: 'CWV issue',
        tags: [],
        data: { projectedTrafficValue: 100 },
        original: cwvOpp,
      };

      const categorized = new Map();
      categorized.set('emailCampaign', []);
      categorized.set('cwv', [oppData]);
      categorized.set('forms', []);

      const emailTrafficData = [
        { url: 'https://www.example.com/page1', pageviews: '2000', overall_cwv_score: 'poor' },
      ];

      const mockSuggestion = {
        getData: () => ({ url: 'https://www.example.com/page1' }),
      };

      const suggestionsByOpportunityId = new Map();
      suggestionsByOpportunityId.set('opp-1', {
        newSuggestions: [mockSuggestion],
        hasPendingValidation: false,
      });

      const result = await processOpportunityMatching(
        categorized,
        emailTrafficData,
        1000,
        suggestionsByOpportunityId,
        mockLog,
      );

      expect(result.matchResults.get('cwv')).to.have.length(1);
      expect(result.emailUrlsMap.has('opp-1')).to.be.true;
    });

    it('matches forms opportunities via data.form field', async () => {
      const formOpp = createMockOpportunity({
        id: 'opp-2',
        type: 'high-form-views-low-conversions',
        description: 'Form issue',
        data: { projectedConversionValue: 50, form: 'https://www.example.com/contact' },
      });
      const oppData = {
        id: 'opp-2',
        type: 'high-form-views-low-conversions',
        title: 'Form Test',
        description: 'Form issue',
        tags: [],
        data: { projectedConversionValue: 50, form: 'https://www.example.com/contact' },
        original: formOpp,
      };

      const categorized = new Map();
      categorized.set('emailCampaign', []);
      categorized.set('cwv', []);
      categorized.set('forms', [oppData]);

      const emailTrafficData = [
        { url: 'https://www.example.com/contact', pageviews: '1000' },
      ];

      const suggestionsByOpportunityId = new Map();
      suggestionsByOpportunityId.set('opp-2', {
        newSuggestions: [],
        hasPendingValidation: false,
      });

      const result = await processOpportunityMatching(
        categorized,
        emailTrafficData,
        500,
        suggestionsByOpportunityId,
        mockLog,
      );

      expect(result.matchResults.get('forms')).to.have.length(1);
      expect(result.emailUrlsMap.has('opp-2')).to.be.true;
    });
  });

  describe('combineAndSortOpportunities', () => {
    it('combines and sorts opportunities by value', () => {
      const opp1 = createMockOpportunity({
        type: 'cwv',
        data: { projectedTrafficValue: 100 },
        description: 'CWV 1',
      });
      const opp2 = createMockOpportunity({
        type: 'other',
        tags: ['email traffic'],
        data: { projectedTrafficValue: 200 },
        description: 'Email 1',
      });

      const oppData1 = {
        id: opp1.getId(),
        type: 'cwv',
        title: opp1.getTitle(),
        description: opp1.getDescription(),
        tags: opp1.getTags(),
        data: opp1.getData(),
        original: opp1,
      };
      const oppData2 = {
        id: opp2.getId(),
        type: 'other',
        title: opp2.getTitle(),
        description: opp2.getDescription(),
        tags: opp2.getTags(),
        data: opp2.getData(),
        original: opp2,
      };

      const categorized = new Map();
      categorized.set('emailCampaign', [oppData2]);
      categorized.set('cwv', []);
      categorized.set('forms', []);

      const matchResults = new Map();
      matchResults.set('cwv', [oppData1]);
      matchResults.set('forms', []);

      const result = combineAndSortOpportunities(categorized, matchResults);
      expect(result).to.have.length(2);
      // Higher value first
      expect(result[0].getData().projectedTrafficValue).to.equal(200);
    });

    it('limits to max 2 per type and 10 total', () => {
      const opportunities = [];
      for (let i = 0; i < 5; i += 1) {
        const opp = createMockOpportunity({
          type: 'cwv',
          data: { projectedTrafficValue: 100 - i },
          description: `CWV ${i}`,
        });
        opportunities.push({
          id: opp.getId(),
          type: 'cwv',
          title: opp.getTitle(),
          description: opp.getDescription(),
          tags: opp.getTags(),
          data: opp.getData(),
          original: opp,
        });
      }

      const categorized = new Map();
      categorized.set('emailCampaign', []);
      categorized.set('cwv', []);
      categorized.set('forms', []);

      const matchResults = new Map();
      matchResults.set('cwv', opportunities);
      matchResults.set('forms', []);

      const result = combineAndSortOpportunities(categorized, matchResults);
      expect(result).to.have.length(2); // Max 2 per type
    });
  });
});
