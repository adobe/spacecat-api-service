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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { AWSAthenaClient } from '@adobe/spacecat-shared-athena-client';
import { Site } from '@adobe/spacecat-shared-data-access';
import TopPaidOpportunitiesController from '../../../src/controllers/paid/top-paid-opportunities.js';

use(chaiAsPromised);
use(sinonChai);

const SITE_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('TopPaidOpportunitiesController', () => {
  let sandbox;
  let mockContext;
  let mockEnv;
  let mockOpportunity;
  let mockSuggestion;
  let mockSite;
  let topPaidController;
  let mockLogger;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    // Stub AWSAthenaClient.fromContext
    sandbox.stub(AWSAthenaClient, 'fromContext');

    mockLogger = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };

    mockOpportunity = {
      allBySiteIdAndStatus: sandbox.stub().resolves([]),
    };

    mockSuggestion = {
      allByOpportunityId: sandbox.stub().resolves([]),
      allByOpportunityIdAndStatus: sandbox.stub().resolves([]),
    };

    mockSite = {
      findById: sandbox.stub().resolves({
        id: SITE_ID,
        getBaseURL: async () => 'https://example.com',
      }),
    };

    mockContext = {
      dataAccess: {
        Opportunity: mockOpportunity,
        Suggestion: mockSuggestion,
        Site: mockSite,
      },
      log: mockLogger,
      s3: {},
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    mockEnv = {
      RUM_METRICS_DATABASE: 'test_db',
      RUM_METRICS_COMPACT_TABLE: 'test_table',
      S3_BUCKET_NAME: 'test-bucket',
      PAID_DATA_THRESHOLD: 1000,
      CWV_THRESHOLDS: {},
    };

    topPaidController = TopPaidOpportunitiesController(mockContext, mockEnv);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getTopPaidOpportunities', () => {
    it('returns 404 when site is not found', async () => {
      const nonExistentSiteId = '00000000-0000-0000-0000-000000000000';
      mockSite.findById.resolves(null);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: nonExistentSiteId },
        data: {},
      });

      expect(response.status).to.equal(404);
    });

    it('returns 403 when user does not have access to site', async () => {
      const mockOrg = {
        getImsOrgId: () => 'test-org-id',
      };

      const mockSiteWithOrg = {
        id: SITE_ID,
        getOrganization: async () => mockOrg,
        getBaseURL: async () => 'https://example.com',
      };
      Object.setPrototypeOf(mockSiteWithOrg, Site.prototype);
      mockSite.findById.resolves(mockSiteWithOrg);

      const restrictedAuthInfo = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'user' }])
        .withProfile({ is_admin: false })
        .withAuthenticated(true);

      restrictedAuthInfo.claims = {
        organizations: [],
      };

      const restrictedContext = {
        ...mockContext,
        attributes: {
          authInfo: restrictedAuthInfo,
        },
      };

      const controller = TopPaidOpportunitiesController(restrictedContext, mockEnv);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(403);
    });

    it('filters out opportunities with zero projectedTrafficValue', async () => {
      const validOppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Valid Opportunity',
        getDescription: () => 'Valid Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 1000 }),
      };

      const zeroValueOppty = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Zero Value',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 0 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([validOppty, zeroValueOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('oppty-1');
    });

    it('returns paid media opportunities (with paid media tag)', async () => {
      const paidOppty1 = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Paid Media Opportunity',
        getDescription: () => 'Description for paid media',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([paidOppty1])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url_from: 'https://example.com/page1' }),
          getRank: () => 100,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('oppty-1');
      expect(opportunities[0].pageViews).to.equal(100);
    });

    it('returns consent-banner opportunities as paid media', async () => {
      const consentBannerOppty = {
        getId: () => 'consent-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Consent Banner',
        getDescription: () => 'Fix consent banner',
        getType: () => 'consent-banner',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 500, projectedTrafficValue: 2000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([consentBannerOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('consent-1');
      expect(opportunities[0].system_type).to.equal('consent-banner');
    });

    it('returns no-cta-above-the-fold opportunities as paid media', async () => {
      const noctaOppty = {
        getId: () => 'nocta-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'No CTA Above Fold',
        getDescription: () => 'Fix CTA placement',
        getType: () => 'generic-opportunity',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({
          opportunityType: 'no-cta-above-the-fold',
          projectedTrafficLost: 300,
          projectedTrafficValue: 1500,
        }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([noctaOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('nocta-1');
    });
  });

  describe('CWV opportunity filtering', () => {
    it('returns CWV opportunities only when URLs match poor CWV from paid traffic', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('cwv-1');
      expect(opportunities[0].pageViews).to.equal(5000);
      expect(opportunities[0].urls).to.deep.equal(['https://example.com/page1']);
    });

    it('excludes CWV opportunities when Athena returns no poor CWV URLs', async () => {
      const cwvOppty = {
        getId: () => 'cwv-good',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      // Athena returns empty array (no poor CWV URLs)
      const mockAthenaClient = {
        query: sandbox.stub().resolves([]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      // Should be empty because Athena returned no poor CWV URLs
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('excludes CWV opportunities when URLs do not match paid traffic', async () => {
      const cwvOppty = {
        getId: () => 'cwv-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/different-page' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('sums pageviews correctly for CWV opportunities with multiple matching URLs', async () => {
      const cwvOppty = {
        getId: () => 'cwv-3',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
        {
          getData: () => ({ url: 'https://example.com/page2' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '3000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
          {
            url: 'https://example.com/page2',
            pageviews: '2000',
            overall_cwv_score: 'poor',
            lcp_score: 'good',
            inp_score: 'poor',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].pageViews).to.equal(5000);
    });

    it('does not fetch suggestions twice for CWV opportunities', async () => {
      const cwvOppty = {
        getId: () => 'cwv-4',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      // Should only be called once during matching, not again during DTO conversion
      expect(mockSuggestion.allByOpportunityIdAndStatus.callCount).to.equal(1);
    });

    it('continues without CWV filtering when Athena query fails', async () => {
      const cwvOppty = {
        getId: () => 'cwv-5',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      const paidOppty = {
        getId: () => 'paid-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Paid Media Opportunity',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 5000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty, paidOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const mockAthenaClient = {
        query: sandbox.stub().rejects(new Error('Athena query failed')),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      // Should only return paid media opportunity, not CWV
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('paid-1');
    });

    it('sorts opportunities by projectedTrafficValue descending', async () => {
      const oppty1 = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Low Value',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 1000 }),
      };

      const oppty2 = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'High Value',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 5000 }),
      };

      const oppty3 = {
        getId: () => 'oppty-3',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Medium Value',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 3000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([oppty1, oppty2, oppty3])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(3);
      // Should be sorted: 5000, 3000, 1000
      expect(opportunities[0].opportunityId).to.equal('oppty-2');
      expect(opportunities[1].opportunityId).to.equal('oppty-3');
      expect(opportunities[2].opportunityId).to.equal('oppty-1');
    });

    it('uses default year and week when not provided', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      expect(mockLogger.warn).to.have.been.calledWith(sinon.match(/No year provided/));
      expect(mockLogger.warn).to.have.been.calledWith(sinon.match(/No week or month provided/));
    });

    it('uses default week when only year is provided', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025 },
      });

      expect(response.status).to.equal(200);
      expect(mockLogger.warn).to.have.been.calledWith(sinon.match(/No week or month provided/));
      expect(mockLogger.warn).to.not.have.been.calledWith(sinon.match(/No year provided/));
    });

    it('filters out opportunities without description', async () => {
      const validOppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Valid Opportunity',
        getDescription: () => 'Valid Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 1000 }),
      };

      const noDescOppty = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'No Description',
        getDescription: () => null,
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 2000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([validOppty, noDescOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('oppty-1');
    });

    it('handles invalid CWV_THRESHOLDS gracefully', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      // Create controller with invalid CWV_THRESHOLDS
      const envWithInvalidThresholds = {
        ...mockEnv,
        CWV_THRESHOLDS: 'invalid-json{',
      };

      const controller = TopPaidOpportunitiesController(mockContext, envWithInvalidThresholds);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      expect(mockLogger.warn).to.have.been.calledWith(sinon.match(/Failed to parse CWV_THRESHOLDS/));
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
    });

    it('handles null CWV_THRESHOLDS gracefully', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      // Create controller with null CWV_THRESHOLDS
      const envWithNullThresholds = {
        ...mockEnv,
        CWV_THRESHOLDS: null,
      };

      const controller = TopPaidOpportunitiesController(mockContext, envWithNullThresholds);

      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
    });

    it('filters out opportunities with "report" in title', async () => {
      const validOppty = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Valid Opportunity',
        getDescription: () => 'Valid Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 1000 }),
      };

      const reportOppty = {
        getId: () => 'oppty-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Monthly Report',
        getDescription: () => 'Report Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => ({ projectedTrafficValue: 2000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([validOppty, reportOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('oppty-1');
    });

    it('handles opportunities with null getTags()', async () => {
      const opptyWithNullTags = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Opportunity',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => null,
        getData: () => ({ projectedTrafficValue: 1000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([opptyWithNullTags])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('handles opportunities with null getData()', async () => {
      const opptyWithNullData = {
        getId: () => 'oppty-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Opportunity',
        getDescription: () => 'Description',
        getType: () => 'broken-backlinks',
        getStatus: () => 'NEW',
        getTags: () => ['paid media'],
        getData: () => null,
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([opptyWithNullData])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus.resolves([]);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: {},
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('handles context.data being null', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: null,
      });

      expect(response.status).to.equal(200);
    });

    it('uses month parameter when provided', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, month: 6 },
      });

      expect(response.status).to.equal(200);
    });

    it('uses provided week when year and week are both provided', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 10 },
      });

      expect(response.status).to.equal(200);
      expect(mockLogger.warn).to.not.have.been.calledWith(sinon.match(/No year provided/));
      expect(mockLogger.warn).to.not.have.been.calledWith(sinon.match(/No week or month provided/));
    });

    it('uses default PAGE_VIEW_THRESHOLD when PAID_DATA_THRESHOLD is not set', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '1500',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const envWithoutThreshold = {
        ...mockEnv,
        PAID_DATA_THRESHOLD: undefined,
      };

      const controller = TopPaidOpportunitiesController(mockContext, envWithoutThreshold);
      const response = await controller.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
    });

    it('includes CWV opportunities with "needs improvement" score', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '3000',
            overall_cwv_score: 'needs improvement',
            lcp_score: 'needs improvement',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('cwv-1');
      expect(opportunities[0].pageViews).to.equal(3000);
    });

    it('excludes CWV URLs below pageview threshold even if poor score', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '500',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('excludes CWV URLs with good score even if high traffic', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1' }),
          getRank: () => 0,
        },
        {
          getData: () => ({ url: 'https://example.com/page2' }),
          getRank: () => 1,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            path: '/page1',
            pageviews: '5000',
            p70_lcp: 1500,
            p70_cls: 0.05,
            p70_inp: 100,
          },
          {
            path: '/page2',
            pageviews: '3000',
            p70_lcp: 5000,
            p70_cls: 0.3,
            p70_inp: 600,
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('cwv-1');
      // Should only include page2 (poor score), not page1 (good score)
      expect(opportunities[0].urls).to.deep.equal(['https://example.com/page2']);
      expect(opportunities[0].urls).to.not.include('https://example.com/page1');
    });
  });

  describe('URL normalization for matching', () => {
    it('does not match partial URLs (exact match required)', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://www.bulk.com/de/products/pure-whey-protein-de' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            path: '/de/products/pure-whey-protein-de/bpb-wpc8-0000',
            pageviews: '5000',
            p70_lcp: 5000,
            p70_cls: 0.3,
            p70_inp: 600,
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      // Should return 0 opportunities because URLs don't match exactly
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('matches URLs with www prefix differences', async () => {
      const cwvOppty = {
        getId: () => 'cwv-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://www.example.com/page1' }),
          getRank: () => 100,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
    });

    it('matches URLs with trailing slash differences', async () => {
      const cwvOppty = {
        getId: () => 'cwv-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/page1/' }),
          getRank: () => 100,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
    });

    it('matches URLs with both www and trailing slash differences', async () => {
      const cwvOppty = {
        getId: () => 'cwv-3',
        getSiteId: () => SITE_ID,
        getTitle: () => 'CWV Opportunity',
        getDescription: () => 'Fix CWV issues',
        getType: () => 'cwv',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 3000, projectedTrafficValue: 10000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([cwvOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://www.example.com/page1/' }),
          getRank: () => 100,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/page1',
            pageviews: '5000',
            overall_cwv_score: 'poor',
            lcp_score: 'poor',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
    });
  });

  describe('Forms opportunity filtering', () => {
    it('returns forms opportunities when URLs match paid traffic', async () => {
      const formsOppty = {
        getId: () => 'forms-1',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Forms Opportunity',
        getDescription: () => 'Fix form accessibility issues',
        getType: () => 'form-accessibility',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 2000, projectedTrafficValue: 8000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([formsOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/contact-form' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/contact-form',
            pageviews: '3000',
            overall_cwv_score: 'good',
            lcp_score: 'good',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(1);
      expect(opportunities[0].opportunityId).to.equal('forms-1');
      expect(opportunities[0].system_type).to.equal('form-accessibility');
      expect(opportunities[0].pageViews).to.equal(3000);
    });

    it('does not return forms opportunities when URLs do not match paid traffic', async () => {
      const formsOppty = {
        getId: () => 'forms-2',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Forms Opportunity',
        getDescription: () => 'Fix form conversion issues',
        getType: () => 'high-form-views-low-conversions',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 1500, projectedTrafficValue: 6000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([formsOppty])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      const mockSuggestions = [
        {
          getData: () => ({ url: 'https://example.com/signup-form' }),
          getRank: () => 0,
        },
      ];

      mockSuggestion.allByOpportunityIdAndStatus.resolves(mockSuggestions);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/different-page',
            pageviews: '2000',
            overall_cwv_score: 'good',
            lcp_score: 'good',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(0);
    });

    it('handles multiple forms opportunity types', async () => {
      const formsOppty1 = {
        getId: () => 'forms-3',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Low Form Navigation',
        getDescription: () => 'Improve form navigation',
        getType: () => 'high-page-views-low-form-nav',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 1000, projectedTrafficValue: 4000 }),
      };

      const formsOppty2 = {
        getId: () => 'forms-4',
        getSiteId: () => SITE_ID,
        getTitle: () => 'Low Form Views',
        getDescription: () => 'Increase form visibility',
        getType: () => 'high-page-views-low-form-views',
        getStatus: () => 'NEW',
        getTags: () => [],
        getData: () => ({ projectedTrafficLost: 800, projectedTrafficValue: 3000 }),
      };

      mockOpportunity.allBySiteIdAndStatus
        .withArgs(SITE_ID, 'NEW').resolves([formsOppty1, formsOppty2])
        .withArgs(SITE_ID, 'IN_PROGRESS').resolves([]);

      mockSuggestion.allByOpportunityIdAndStatus
        .withArgs('forms-3', 'NEW').resolves([
          { getData: () => ({ url: 'https://example.com/form1' }), getRank: () => 0 },
        ])
        .withArgs('forms-4', 'NEW').resolves([
          { getData: () => ({ url: 'https://example.com/form2' }), getRank: () => 0 },
        ]);

      const mockAthenaClient = {
        query: sandbox.stub().resolves([
          {
            url: 'https://example.com/form1',
            pageviews: '2500',
            overall_cwv_score: 'good',
            lcp_score: 'good',
            inp_score: 'good',
            cls_score: 'good',
          },
          {
            url: 'https://example.com/form2',
            pageviews: '1800',
            overall_cwv_score: 'good',
            lcp_score: 'good',
            inp_score: 'good',
            cls_score: 'good',
          },
        ]),
      };

      AWSAthenaClient.fromContext.returns(mockAthenaClient);

      const response = await topPaidController.getTopPaidOpportunities({
        params: { siteId: SITE_ID },
        data: { year: 2025, week: 1 },
      });

      expect(response.status).to.equal(200);
      const opportunities = await response.json();
      expect(opportunities).to.be.an('array').with.lengthOf(2);
      // Should be sorted by projectedTrafficValue descending
      expect(opportunities[0].opportunityId).to.equal('forms-3');
      expect(opportunities[1].opportunityId).to.equal('forms-4');
    });
  });
});
