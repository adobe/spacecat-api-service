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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { AWSAthenaClient, TrafficDataWithCWVDto } from '@adobe/spacecat-shared-athena-client';
import TopPaidOpportunitiesController from '../../../src/controllers/paid/top-paid-opportunities.js';
import { matchOpportunitiesWithPaidUrls } from '../../../src/controllers/paid/opportunity-matcher.js';

use(chaiAsPromised);
use(sinonChai);

const SITE_ID = 'test-site-id';

// Simplified factory functions - projectedTrafficValue defaults to 1000
const createOpportunity = (overrides = {}) => {
  const desc = overrides.description !== undefined ? overrides.description : 'Test Description';
  const data = overrides.data === null ? null : { projectedTrafficValue: 1000, ...overrides.data };
  return {
    getId: () => overrides.id || 'oppty-1',
    getSiteId: () => SITE_ID,
    getTitle: () => overrides.title || 'Test Opportunity',
    getDescription: () => desc,
    getType: () => overrides.type || 'broken-backlinks',
    getStatus: () => 'NEW',
    getTags: () => overrides.tags || [],
    getData: () => data,
  };
};

const createSuggestion = (url, overrides = {}) => ({
  getOpportunityId: () => overrides.opportunityId || 'oppty-1',
  getData: () => ({ url, ...overrides.data }),
  getRank: () => overrides.rank || 0,
});

const createTrafficData = (overrides = {}) => ({
  url: overrides.url || 'https://example.com/page',
  pageviews: overrides.pageviews || '1000',
  overall_cwv_score: overrides.overall_cwv_score || 'poor',
  lcp_score: overrides.lcp_score || 'poor',
  inp_score: overrides.inp_score || 'good',
  cls_score: overrides.cls_score || 'good',
});

const createMockSite = (overrides = {}) => ({
  getId: () => overrides.id || SITE_ID,
  getBaseURL: async () => overrides.baseURL || 'https://example.com',
  getOrganizationId: () => overrides.organizationId || null,
});

// Helper to set up opportunity mocks with proper status filtering
function setupOpportunityMocks(mockOpportunity, opportunities = []) {
  mockOpportunity.allBySiteIdAndStatus
    .withArgs(SITE_ID, 'NEW').resolves(opportunities)
    .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);
}

describe('TopPaidOpportunitiesController', () => {
  let sandbox;
  let mockContext;
  let mockEnv;
  let mockAthenaClient;
  let controller;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(AWSAthenaClient, 'fromContext');
    sandbox.stub(TrafficDataWithCWVDto, 'toJSON').callsFake((row, _thresholdConfig, baseURL) => {
      const url = row.path ? `${baseURL}${row.path}` : row.url;
      return { ...row, url };
    });

    mockAthenaClient = { query: sandbox.stub().resolves([]) };
    AWSAthenaClient.fromContext.returns(mockAthenaClient);

    mockContext = {
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
        debug: sandbox.stub(),
      },
      dataAccess: {
        Site: { findById: sandbox.stub().resolves(createMockSite()) },
        Opportunity: { allBySiteIdAndStatus: sandbox.stub().resolves([]) },
        Suggestion: { allByOpportunityIdAndStatus: sandbox.stub().resolves([]) },
      },
      attributes: {
        authInfo: {
          profile: { email: 'admin@example.com' },
          isAdmin: () => true,
          getType: () => 'jwt',
          getScopes: () => [{ name: 'admin' }],
          hasOrganization: () => true,
        },
      },
      pathInfo: { headers: {} },
    };

    mockEnv = {
      PAID_DATA_THRESHOLD: '100',
      CWV_THRESHOLDS: JSON.stringify({
        LCP_GOOD: 2500,
        LCP_NEEDS_IMPROVEMENT: 4000,
        CLS_GOOD: 0.1,
        CLS_NEEDS_IMPROVEMENT: 0.25,
        INP_GOOD: 200,
        INP_NEEDS_IMPROVEMENT: 500,
      }),
    };

    controller = TopPaidOpportunitiesController(mockContext, mockEnv);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('TopPaidOpportunitiesController', () => {
    it('returns 404 when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);
      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });
      expect(response.status).to.equal(404);
    });

    it('returns 403 when user does not have access to site', async () => {
      mockContext.dataAccess.Site.findById.resolves(
        createMockSite({ organizationId: 'test-org-id' }),
      );
      const restrictedContext = {
        ...mockContext,
        attributes: {
          authInfo: {
            profile: { email: 'user@example.com' },
            isAdmin: () => false,
            getType: () => 'jwt',
            getScopes: () => [],
            getOrganizations: () => [],
            hasOrganization: () => false,
          },
        },
      };
      const restrictedController = TopPaidOpportunitiesController(restrictedContext, mockEnv);
      const response = await restrictedController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });
      expect(response.status).to.equal(403);
    });

    it('filters out opportunities with zero projectedTrafficValue', async () => {
      const validOppty = createOpportunity({ id: 'oppty-1', tags: ['paid media'] });
      const zeroValueOppty = createOpportunity({
        id: 'oppty-2', tags: ['paid media'], data: { projectedTrafficValue: 0 },
      });
      const nullValopt = createOpportunity({
        id: 'oppty-2', tags: ['paid media'], data: { projectedTrafficValue: null },
      });
      setupOpportunityMocks(
        mockContext.dataAccess.Opportunity,
        [validOppty, zeroValueOppty, nullValopt],
      );

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('returns paid media opportunities (with paid media tag)', async () => {
      const paidOppty = createOpportunity({ id: 'oppty-1', tags: ['paid media'] });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [paidOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('returns consent-banner opportunities in top paid opportunities', async () => {
      const consentOppty = createOpportunity({ id: 'consent-1', type: 'consent-banner' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [consentOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities[0].system_type).to.equal('consent-banner');
    });

    it('returns no-cta-above-the-fold opportunities in top paid opportunities', async () => {
      const noctaOppty = createOpportunity({
        id: 'nocta-1',
        type: 'generic-opportunity',
        data: { opportunityType: 'no-cta-above-the-fold' },
      });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [noctaOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('sorts opportunities by projectedTrafficValue and projectedConversionValue descending', async () => {
      // CWV opportunities use projectedTrafficValue
      const cwvOppty1 = createOpportunity({
        id: 'cwv-1', type: 'cwv', data: { projectedTrafficValue: 2000 },
      });
      const cwvOppty2 = createOpportunity({
        id: 'cwv-2', type: 'cwv', data: { projectedTrafficValue: 4000 },
      });
      // Forms opportunities use projectedConversionValue (not projectedTrafficValue)
      const formsOppty1 = createOpportunity({
        id: 'forms-1',
        type: 'form-accessibility',
        data: { projectedTrafficValue: 0, projectedConversionValue: 3000, form: 'https://example.com/form1' },
      });
      const formsOppty2 = createOpportunity({
        id: 'forms-2',
        type: 'high-form-views-low-conversions',
        data: { projectedTrafficValue: 0, projectedConversionValue: 1000, form: 'https://example.com/form2' },
      });
      setupOpportunityMocks(
        mockContext.dataAccess.Opportunity,
        [cwvOppty1, cwvOppty2, formsOppty1, formsOppty2],
      );
      // CWV opportunities match by suggestion URL
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus
        .withArgs('cwv-1', 'NEW')
        .resolves([createSuggestion('https://example.com/page1')])
        .withArgs('cwv-2', 'NEW')
        .resolves([createSuggestion('https://example.com/page2')])
        // Forms opportunities match by form URL in suggestion
        .withArgs('forms-1', 'NEW')
        .resolves([createSuggestion('https://example.com/form1')])
        .withArgs('forms-2', 'NEW')
        .resolves([createSuggestion('https://example.com/form2')]);
      // Mock Athena to return paid traffic data for all URLs
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1', pageviews: '1000' }),
        createTrafficData({ url: 'https://example.com/page2', pageviews: '1000' }),
        createTrafficData({ url: 'https://example.com/form1', pageviews: '1000' }),
        createTrafficData({ url: 'https://example.com/form2', pageviews: '1000' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      // Should be sorted by value descending:
      // 4000 (cwv-2), 3000 (forms-1), 2000 (cwv-1), 1000 (forms-2)
      expect(opportunities).to.have.lengthOf(4);
      expect(opportunities[0].opportunityId).to.equal('cwv-2');
      expect(opportunities[1].opportunityId).to.equal('forms-1');
      expect(opportunities[2].opportunityId).to.equal('cwv-1');
      expect(opportunities[3].opportunityId).to.equal('forms-2');
    });

    it('filters out opportunities with "report" in title', async () => {
      const validOppty = createOpportunity({
        id: 'oppty-1', title: 'Valid Opportunity', tags: ['paid media'],
      });
      const reportOppty = createOpportunity({
        id: 'oppty-2', title: 'Monthly Report', tags: ['paid media'],
      });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [validOppty, reportOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('oppty-1');
    });

    it('filters out opportunities without description', async () => {
      const validOppty = createOpportunity({ id: 'oppty-1', tags: ['paid media'] });
      const noDescOppty = createOpportunity({
        id: 'oppty-2', description: null, tags: ['paid media'],
      });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [validOppty, noDescOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });
  });

  describe('CWV opportunity filtering', () => {
    it('returns CWV opportunities when URLs match poor CWV from paid traffic', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' }), createTrafficData({ url: 'https://example.com/not-matching' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
      expect(opportunities[0].urls).to.not.include('https://example.com/not-matching');
      expect(opportunities[0].urls).to.include('https://example.com/page1');
    });

    it('excludes CWV opportunities when Athena returns no poor CWV URLs', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockAthenaClient.query.resolves([]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(0);
    });

    it('continues without CWV filtering when Athena query fails', async () => {
      const paidOppty = createOpportunity({ id: 'paid-1', tags: ['paid media'] });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [paidOppty]);
      mockAthenaClient.query.rejects(new Error('Athena query failed'));

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('excludes CWV opportunities when URLs do not match paid traffic', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/different-page'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(0);
    });

    it('sums pageviews correctly for CWV opportunities with multiple URLs', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
        createSuggestion('https://example.com/page2'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1', pageviews: '3000' }),
        createTrafficData({ url: 'https://example.com/page2', pageviews: '2000' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities[0].pageViews).to.equal(5000);
    });

    it('uses default year and week when not provided', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      expect(response.status).to.equal(200);
    });

    it('handles context.data being null', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: null,
      });
      expect(response.status).to.equal(200);
    });

    it('handles invalid CWV_THRESHOLDS gracefully', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const envWithInvalidThresholds = { ...mockEnv, CWV_THRESHOLDS: 'invalid-json{' };
      const ctrl = TopPaidOpportunitiesController(mockContext, envWithInvalidThresholds);

      const response = await ctrl.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      expect(response.status).to.equal(200);
    });

    it('handles null CWV_THRESHOLDS gracefully', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const envWithNullThresholds = { ...mockEnv, CWV_THRESHOLDS: null };
      const ctrl = TopPaidOpportunitiesController(mockContext, envWithNullThresholds);

      const response = await ctrl.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      expect(response.status).to.equal(200);
    });

    it('includes CWV opportunities with "needs improvement" score', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({
          url: 'https://example.com/page1',
          overall_cwv_score: 'needs improvement',
        }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('does not fetch suggestions twice for CWV opportunities', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });

      expect(mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.callCount).to.equal(1);
    });
  });

  describe('Forms opportunity filtering', () => {
    it('returns forms opportunities when URLs match paid traffic', async () => {
      const formsOppty = createOpportunity({
        id: 'forms-1',
        type: 'form-accessibility',
        data: { projectedConversionValue: 22888.14, form: 'https://example.com/form-page' },
      });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [formsOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/form-page'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/form-page', pageviews: '3000' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('does not return forms opportunities when URLs do not match', async () => {
      const formsOppty = createOpportunity({
        id: 'forms-1',
        type: 'high-form-views-low-conversions',
        data: { projectedConversionValue: 15000 },
      });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [formsOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/different-page'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/form-page' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(0);
    });

    it('handles multiple forms opportunity types', async () => {
      const formsOppty1 = createOpportunity({
        id: 'forms-1',
        type: 'high-page-views-low-form-nav',
        data: { projectedConversionValue: 18500 },
      });
      const formsOppty2 = createOpportunity({
        id: 'forms-2',
        type: 'high-page-views-low-form-views',
        data: { projectedConversionValue: 12000 },
      });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [formsOppty1, formsOppty2]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus
        .withArgs('forms-1', 'NEW').resolves([createSuggestion('https://example.com/form1')])
        .withArgs('forms-2', 'NEW').resolves([createSuggestion('https://example.com/form2')]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/form1', pageviews: '2500' }),
        createTrafficData({ url: 'https://example.com/form2', pageviews: '1800' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(2);
    });
  });

  describe('URL matching', () => {
    it('matches URLs with www prefix differences', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://www.example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('matches URLs with trailing slash differences', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1/'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('matches URLs with both www and trailing slash differences', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://www.example.com/page1/'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('does not match partial URLs (exact match required)', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(0);
    });
  });

  describe('Threshold and score filtering', () => {
    it('excludes CWV URLs below pageview threshold even if poor score', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      // pageviews below threshold (100) - Athena returns empty
      mockAthenaClient.query.resolves([]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(0);
    });

    it('excludes CWV URLs with good score even if high traffic', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      // CWV scores are good - Athena query with CWV filter returns empty
      mockAthenaClient.query.resolves([
        createTrafficData({
          url: 'https://example.com/page1',
          overall_cwv_score: 'good',
          lcp_score: 'good',
        }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(0);
    });

    it('uses default PAGE_VIEW_THRESHOLD when PAID_DATA_THRESHOLD is not set', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
        createSuggestion('https://example.com/page2'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1', pageviews: '1000' }), // at threshold
        createTrafficData({ url: 'https://example.com/page2', pageviews: '999' }), // below threshold
      ]);

      const envWithoutThreshold = { ...mockEnv };
      delete envWithoutThreshold.PAID_DATA_THRESHOLD;
      const ctrl = TopPaidOpportunitiesController(mockContext, envWithoutThreshold);

      const response = await ctrl.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
      expect(opportunities[0].urls).to.include('https://example.com/page1');
      expect(opportunities[0].urls).to.not.include('https://example.com/page2');
    });
  });

  describe('Temporal parameters', () => {
    it('uses month parameter when provided', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, month: 6 },
      });
      expect(response.status).to.equal(200);

      // Verify month was used in the Athena query
      const queryArg = mockAthenaClient.query.firstCall.args[0];
      expect(queryArg).to.include('month=6');
      expect(queryArg).to.include('year=2025');
    });

    it('uses provided week when year and week are both provided', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 25 },
      });
      // Verify week was used in the Athena query
      const queryArg = mockAthenaClient.query.firstCall.args[0];
      expect(queryArg).to.include('week=25');
      expect(queryArg).to.include('year=2025');
    });

    it('uses default week when temporal params are not provided', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025 },
      });
      expect(response.status).to.equal(200);
      const queryArg = mockAthenaClient.query.firstCall.args[0];
      expect(queryArg).to.include('week');
    });
  });

  describe('Edge cases and error handling', () => {
    it('handles multiple CWV opportunities in processOpportunityMatching', async () => {
      const cwvOppty1 = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      const cwvOppty2 = createOpportunity({ id: 'cwv-2', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty1, cwvOppty2]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      expect(response.status).to.equal(200);
    });

    it('handles suggestions with multiple URL fields (url_from, urlTo)', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      // Suggestion with url_from field
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([{
        getOpportunityId: () => 'cwv-1',
        getData: () => ({ url_from: 'https://example.com/page1' }),
        getRank: () => 0,
      }]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('skips Athena query when no opportunities require URL matching', async () => {
      const paidOppty = createOpportunity({ id: 'paid-1', tags: ['paid media'] });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [paidOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
      // Athena should not be queried since no CWV/forms opportunities
      expect(mockAthenaClient.query.called).to.be.false;
    });

    it('handles IN_PROGRESS opportunities along with NEW', async () => {
      const newOppty = createOpportunity({ id: 'new-1', tags: ['paid media'] });
      const inProgressOppty = createOpportunity({
        id: 'progress-1',
        tags: ['paid media'],
        data: { projectedTrafficValue: 2000 },
      });
      // Modify inProgressOppty to have IN_PROGRESS status
      inProgressOppty.getStatus = () => 'IN_PROGRESS';

      mockContext.dataAccess.Opportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([newOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([inProgressOppty]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: {},
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(2);
    });

    it('uses cache when available (cache hit)', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);

      // Add S3 mock to context for cache testing - proper structure with s3Client
      const s3SendStub = sandbox.stub();
      // HeadObjectCommand succeeds (file exists)
      s3SendStub.onFirstCall().resolves({});
      // GetObjectCommand returns cached data (async iterator for gzipped data)
      const { gzip } = await import('zlib');
      const { promisify } = await import('util');
      const gzipAsync = promisify(gzip);
      const cachedData = [createTrafficData({ url: 'https://example.com/page1' })];
      const compressedData = await gzipAsync(JSON.stringify(cachedData));
      s3SendStub.onSecondCall().resolves({
        Body: {
          async* [Symbol.asyncIterator]() { yield compressedData; },
        },
      });

      mockContext.s3 = { s3Client: { send: s3SendStub } };
      mockEnv.S3_BUCKET_NAME = 'test-bucket';
      controller = TopPaidOpportunitiesController(mockContext, mockEnv);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      expect(response.status).to.equal(200);
    });

    it('writes to cache after Athena query (cache miss)', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);

      // Add S3 mock to context for cache testing - simulate cache miss
      const s3SendStub = sandbox.stub();
      // HeadObjectCommand throws NotFound (cache miss)
      s3SendStub.onFirstCall().rejects({ name: 'NotFound' });
      // PutObjectCommand succeeds (cache write)
      s3SendStub.onSecondCall().resolves({});

      mockContext.s3 = { s3Client: { send: s3SendStub } };
      mockEnv.S3_BUCKET_NAME = 'test-bucket';
      controller = TopPaidOpportunitiesController(mockContext, mockEnv);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      expect(response.status).to.equal(200);
      // Verify s3Client.send was called for cache write (second call)
      expect(s3SendStub.callCount).to.be.at.least(2);
    });

    it('handles CWV opportunity matching with multiple suggestions', async () => {
      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      // Multiple suggestions with different URLs
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
        createSuggestion('https://example.com/page2'),
        createSuggestion('https://example.com/page3'),
      ]);
      mockAthenaClient.query.resolves([
        createTrafficData({ url: 'https://example.com/page1', pageviews: '3000' }),
        createTrafficData({ url: 'https://example.com/page2', pageviews: '1000' }),
      ]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
      // Verify URLs are sorted by pageviews (uses 'urls' field in response)
      expect(opportunities[0].urls[0]).to.equal('https://example.com/page1');
    });

    it('handles forms opportunity with url_to field', async () => {
      const formsOppty = createOpportunity({ id: 'forms-1', type: 'high-form-views-low-conversions' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [formsOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([{
        getOpportunityId: () => 'forms-1',
        getData: () => ({ url_to: 'https://example.com/form-page' }),
        getRank: () => 0,
      }]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/form-page' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      const opportunities = await response.json();
      expect(opportunities).to.have.lengthOf(1);
    });

    it('handles CWV_THRESHOLDS as object (not string)', async () => {
      // Use object instead of JSON string for CWV_THRESHOLDS
      mockEnv.CWV_THRESHOLDS = {
        LCP_GOOD: 2500,
        LCP_NEEDS_IMPROVEMENT: 4000,
        CLS_GOOD: 0.1,
        CLS_NEEDS_IMPROVEMENT: 0.25,
        INP_GOOD: 200,
        INP_NEEDS_IMPROVEMENT: 500,
      };
      controller = TopPaidOpportunitiesController(mockContext, mockEnv);

      const cwvOppty = createOpportunity({ id: 'cwv-1', type: 'cwv' });
      setupOpportunityMocks(mockContext.dataAccess.Opportunity, [cwvOppty]);
      mockContext.dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
        createSuggestion('https://example.com/page1'),
      ]);
      mockAthenaClient.query.resolves([createTrafficData({ url: 'https://example.com/page1' })]);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID }, data: { year: 2025, week: 1 },
      });
      expect(response.status).to.equal(200);
    });
  });
});

describe('matchOpportunitiesWithPaidUrls', () => {
  let mockLog;
  let mockSuggestion;

  beforeEach(() => {
    mockLog = { info: sinon.stub() };
    mockSuggestion = { allByOpportunityIdAndStatus: sinon.stub() };
  });

  it('returns empty results when no opportunities', async () => {
    const result = await matchOpportunitiesWithPaidUrls(
      [],
      [{ url: 'https://example.com/page1', pageviews: '1000' }],
      mockSuggestion,
      mockLog,
    );
    expect(result.matched).to.have.lengthOf(0);
    expect(result.paidUrlsMap.size).to.equal(0);
  });

  it('returns empty results when no paid traffic data', async () => {
    const opportunity = createOpportunity({ id: 'opp-1', type: 'cwv' });
    const result = await matchOpportunitiesWithPaidUrls(
      [opportunity],
      [],
      mockSuggestion,
      mockLog,
    );
    expect(result.matched).to.have.lengthOf(0);
    expect(result.paidUrlsMap.size).to.equal(0);
  });

  it('matches opportunities with paid URLs from suggestions', async () => {
    const opportunity = createOpportunity({ id: 'opp-1', type: 'cwv' });
    mockSuggestion.allByOpportunityIdAndStatus.resolves([
      { getData: () => ({ url: 'https://example.com/page1' }) },
    ]);

    const result = await matchOpportunitiesWithPaidUrls(
      [opportunity],
      [{ url: 'https://example.com/page1', pageviews: '1000' }],
      mockSuggestion,
      mockLog,
    );

    expect(result.matched).to.have.lengthOf(1);
    expect(result.paidUrlsMap.get('opp-1')).to.deep.include({ pageViews: 1000 });
  });

  it('handles multiple URL fields in suggestions', async () => {
    const opportunity = createOpportunity({ id: 'opp-1', type: 'cwv' });
    mockSuggestion.allByOpportunityIdAndStatus.resolves([
      { getData: () => ({ url_from: 'https://example.com/page1', url_to: 'https://example.com/page2' }) },
    ]);

    const result = await matchOpportunitiesWithPaidUrls(
      [opportunity],
      [
        { url: 'https://example.com/page1', pageviews: '1000' },
        { url: 'https://example.com/page2', pageviews: '2000' },
      ],
      mockSuggestion,
      mockLog,
    );

    expect(result.matched).to.have.lengthOf(1);
    expect(result.paidUrlsMap.get('opp-1').pageViews).to.equal(3000);
    // URLs should be sorted by pageviews descending
    expect(result.paidUrlsMap.get('opp-1').urls[0]).to.equal('https://example.com/page2');
  });

  it('does not match when suggestion URLs are not in paid traffic', async () => {
    const opportunity = createOpportunity({ id: 'opp-1', type: 'cwv' });
    mockSuggestion.allByOpportunityIdAndStatus.resolves([
      { getData: () => ({ url: 'https://example.com/different-page' }) },
    ]);

    const result = await matchOpportunitiesWithPaidUrls(
      [opportunity],
      [{ url: 'https://example.com/page1', pageviews: '1000' }],
      mockSuggestion,
      mockLog,
    );

    expect(result.matched).to.have.lengthOf(0);
  });

  it('normalizes URLs for matching (www prefix)', async () => {
    const opportunity = createOpportunity({ id: 'opp-1', type: 'cwv' });
    mockSuggestion.allByOpportunityIdAndStatus.resolves([
      { getData: () => ({ url: 'https://www.example.com/page1' }) },
    ]);

    const result = await matchOpportunitiesWithPaidUrls(
      [opportunity],
      [{ url: 'https://example.com/page1', pageviews: '1000' }],
      mockSuggestion,
      mockLog,
    );

    expect(result.matched).to.have.lengthOf(1);
  });
});
