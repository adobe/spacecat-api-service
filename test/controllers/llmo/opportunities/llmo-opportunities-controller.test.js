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

/* eslint-env mocha */
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

// Helper to create a mock opportunity
function createMockOpportunity({
  id = 'opp-1', siteId = 'site-1', tags = ['isElmo'], type = 'content', status = 'NEW',
} = {}) {
  return {
    getId: () => id,
    getSiteId: () => siteId,
    getAuditId: () => null,
    getRunbook: () => null,
    getType: () => type,
    getData: () => ({}),
    getOrigin: () => 'AI',
    getTitle: () => 'Test Opportunity',
    getDescription: () => 'Test',
    getGuidance: () => ({}),
    getTags: () => new Set(tags),
    getStatus: () => status,
    getCreatedAt: () => '2026-01-01',
    getUpdatedAt: () => '2026-01-02',
    getUpdatedBy: () => 'system',
  };
}

// Helper to create a mock site
function createMockSite({ id = 'site-1', baseURL = 'https://example.com', orgId = 'org-1' } = {}) {
  return {
    getId: () => id,
    getBaseURL: () => baseURL,
    getOrganizationId: () => orgId,
  };
}

describe('LlmoOpportunitiesController', () => {
  let sandbox;
  let LlmoOpportunitiesController;
  let mockContext;
  let mockOrganization;

  const defaultMocks = (accessStub) => ({
    '../../../../src/support/access-control-util.js': {
      default: {
        fromContext: () => ({
          hasAccess: accessStub,
        }),
      },
    },
    '../../../../src/support/brands-storage.js': {
      getBrandById: sandbox.stub().resolves(null),
    },
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockOrganization = { getId: sandbox.stub().returns('org-1') };

    mockContext = {
      params: { spaceCatId: 'org-1' },
      dataAccess: {
        Organization: {
          findById: sandbox.stub().resolves(mockOrganization),
        },
        Site: {
          allByOrganizationId: sandbox.stub().resolves([]),
          findById: sandbox.stub().resolves(null),
        },
        Opportunity: {
          allBySiteId: sandbox.stub().resolves([]),
        },
        services: {
          postgrestClient: {
            from: sandbox.stub(),
          },
        },
      },
      log: {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
    };

    LlmoOpportunitiesController = await esmock(
      '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
      defaultMocks(sandbox.stub().resolves(true)),
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getOpportunityCount', () => {
    it('returns 404 when organization is not found', async () => {
      mockContext.dataAccess.Organization.findById.resolves(null);

      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        defaultMocks(sandbox.stub().resolves(true)),
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      const accessStub = sandbox.stub().rejects(
        new Error('Only users belonging to the organization can view opportunity data'),
      );
      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        defaultMocks(accessStub),
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns zero count when org has no sites', async () => {
      mockContext.dataAccess.Site.allByOrganizationId.resolves([]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(0);
      expect(body.bySite).to.deep.equal([]);
    });

    it('counts only LLMO opportunities with valid statuses', async () => {
      const site1 = createMockSite({ id: 'site-1', baseURL: 'https://a.com' });
      const site2 = createMockSite({ id: 'site-2', baseURL: 'https://b.com' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site1, site2]);

      const oppElmo = createMockOpportunity({ id: 'o1', tags: ['isElmo'], status: 'NEW' });
      const oppPrerender = createMockOpportunity({
        id: 'o2', tags: [], type: 'prerender', status: 'IN_PROGRESS',
      });
      const oppLlmBlocked = createMockOpportunity({
        id: 'o3', tags: [], type: 'llm-blocked', status: 'NEW',
      });
      const oppNonElmo = createMockOpportunity({
        id: 'o4', tags: ['other'], type: 'seo', status: 'NEW',
      });
      const oppIgnored = createMockOpportunity({ id: 'o5', tags: ['isElmo'], status: 'IGNORED' });
      const oppResolved = createMockOpportunity({ id: 'o6', tags: ['isElmo'], status: 'RESOLVED' });

      mockContext.dataAccess.Opportunity.allBySiteId
        .withArgs('site-1').resolves([oppElmo, oppPrerender, oppNonElmo, oppIgnored])
        .withArgs('site-2').resolves([oppLlmBlocked, oppResolved]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(3); // oppElmo + oppPrerender + oppLlmBlocked
      expect(body.bySite).to.have.length(2);
      expect(body.bySite.find((s) => s.siteId === 'site-1').count).to.equal(2);
      expect(body.bySite.find((s) => s.siteId === 'site-2').count).to.equal(1);
    });

    it('handles individual site failures gracefully', async () => {
      const site1 = createMockSite({ id: 'site-1', baseURL: 'https://a.com' });
      const site2 = createMockSite({ id: 'site-2', baseURL: 'https://b.com' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site1, site2]);

      mockContext.dataAccess.Opportunity.allBySiteId
        .withArgs('site-1').rejects(new Error('DB error'))
        .withArgs('site-2').resolves([createMockOpportunity({ id: 'o1' })]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(1);
      expect(body.bySite.find((s) => s.siteId === 'site-1').count).to.equal(0);
      expect(body.bySite.find((s) => s.siteId === 'site-2').count).to.equal(1);
      expect(mockContext.log.warn).to.have.been.called;
    });

    it('returns 403 when hasAccess returns false', async () => {
      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        {
          ...defaultMocks(sandbox.stub().resolves(false)),
        },
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(403);
    });

    it('handles concurrency batching with many sites', async () => {
      // Create 7 sites to exceed MAX_CONCURRENT_SITES (5) and trigger batching
      const sites = Array.from({ length: 7 }, (_, i) => createMockSite({ id: `site-${i}`, baseURL: `https://site${i}.com` }));
      mockContext.dataAccess.Site.allByOrganizationId.resolves(sites);

      sites.forEach((site) => {
        mockContext.dataAccess.Opportunity.allBySiteId
          .withArgs(site.getId())
          .resolves([createMockOpportunity({ id: `opp-${site.getId()}`, siteId: site.getId() })]);
      });

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(7);
      expect(body.bySite).to.have.length(7);
    });

    it('handles opportunities with null type', async () => {
      const site = createMockSite({ id: 'site-1' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site]);

      const oppNullType = createMockOpportunity({
        id: 'o1', tags: ['isElmo'], type: null, status: 'NEW',
      });
      const oppNullTypeNoElmo = createMockOpportunity({
        id: 'o2', tags: [], type: null, status: 'NEW',
      });

      mockContext.dataAccess.Opportunity.allBySiteId
        .withArgs('site-1').resolves([oppNullType, oppNullTypeNoElmo]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      // oppNullType matches via isElmo tag, oppNullTypeNoElmo has no matching tag or type
      expect(body.total).to.equal(1);
    });

    it('returns 500 when site listing fails', async () => {
      mockContext.dataAccess.Site.allByOrganizationId.rejects(new Error('DB connection failed'));

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(500);
    });

    it('returns badRequest for unexpected auth errors', async () => {
      mockContext.dataAccess.Organization.findById.rejects(new Error('Unexpected error'));

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getOpportunityCount(mockContext);

      expect(result.status).to.equal(400);
    });
  });

  describe('getBrandOpportunities', () => {
    it('returns 404 when organization is not found', async () => {
      mockContext.dataAccess.Organization.findById.resolves(null);
      mockContext.params.brandId = 'all';

      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        defaultMocks(sandbox.stub().resolves(true)),
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(404);
    });

    it('returns 403 when user lacks access', async () => {
      mockContext.params.brandId = 'all';
      const accessStub = sandbox.stub().rejects(
        new Error('Only users belonging to the organization can view opportunity data'),
      );
      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        defaultMocks(accessStub),
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(403);
    });

    it('returns all org opportunities when brandId is "all"', async () => {
      mockContext.params.brandId = 'all';
      const site = createMockSite({ id: 'site-1', baseURL: 'https://example.com' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site]);
      mockContext.dataAccess.Site.findById.withArgs('site-1').resolves(site);

      const opp = createMockOpportunity({ id: 'opp-1', siteId: 'site-1' });
      mockContext.dataAccess.Opportunity.allBySiteId.withArgs('site-1').resolves([opp]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brandId).to.equal('all');
      expect(body.brandName).to.equal('All');
      expect(body.total).to.equal(1);
      expect(body.opportunities).to.have.length(1);
      expect(body.opportunities[0].siteBaseURL).to.equal('https://example.com');
    });

    it('returns 404 when brand is not found', async () => {
      mockContext.params.brandId = 'brand-uuid';

      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        {
          ...defaultMocks(sandbox.stub().resolves(true)),
          '../../../../src/support/brands-storage.js': {
            getBrandById: sandbox.stub().resolves(null),
          },
        },
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(404);
    });

    it('returns 400 when postgrestClient is not available for brand lookup', async () => {
      mockContext.params.brandId = 'brand-uuid';
      mockContext.dataAccess.services = {};

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(400);
    });

    it('returns empty when brand has no sites', async () => {
      mockContext.params.brandId = 'brand-uuid';

      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        {
          ...defaultMocks(sandbox.stub().resolves(true)),
          '../../../../src/support/brands-storage.js': {
            getBrandById: sandbox.stub().resolves({ name: 'TestBrand', siteIds: [] }),
          },
        },
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(0);
      expect(body.opportunities).to.deep.equal([]);
      expect(body.brandName).to.equal('TestBrand');
    });

    it('returns opportunities for a specific brand', async () => {
      mockContext.params.brandId = 'brand-uuid';
      const site = createMockSite({ id: 'site-1', baseURL: 'https://brand.com' });
      mockContext.dataAccess.Site.findById.withArgs('site-1').resolves(site);

      const opp = createMockOpportunity({ id: 'opp-1', siteId: 'site-1' });
      mockContext.dataAccess.Opportunity.allBySiteId.withArgs('site-1').resolves([opp]);

      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        {
          ...defaultMocks(sandbox.stub().resolves(true)),
          '../../../../src/support/brands-storage.js': {
            getBrandById: sandbox.stub().resolves({ name: 'MyBrand', siteIds: ['site-1'] }),
          },
        },
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brandId).to.equal('brand-uuid');
      expect(body.brandName).to.equal('MyBrand');
      expect(body.total).to.equal(1);
      expect(body.opportunities[0].id).to.equal('opp-1');
      expect(body.opportunities[0].siteBaseURL).to.equal('https://brand.com');
    });

    it('filters out non-LLMO and invalid-status opportunities', async () => {
      mockContext.params.brandId = 'all';
      const site = createMockSite({ id: 'site-1' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site]);
      mockContext.dataAccess.Site.findById.withArgs('site-1').resolves(site);

      const oppValid = createMockOpportunity({ id: 'o1', tags: ['isElmo'], status: 'NEW' });
      const oppInvalidStatus = createMockOpportunity({ id: 'o2', tags: ['isElmo'], status: 'RESOLVED' });
      const oppNonLlmo = createMockOpportunity({
        id: 'o3', tags: ['other'], type: 'seo', status: 'NEW',
      });

      mockContext.dataAccess.Opportunity.allBySiteId.withArgs('site-1').resolves([
        oppValid, oppInvalidStatus, oppNonLlmo,
      ]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      const body = await result.json();
      expect(body.total).to.equal(1);
      expect(body.opportunities[0].id).to.equal('o1');
    });

    it('handles individual site failures gracefully', async () => {
      mockContext.params.brandId = 'all';
      const site1 = createMockSite({ id: 'site-1', baseURL: 'https://a.com' });
      const site2 = createMockSite({ id: 'site-2', baseURL: 'https://b.com' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site1, site2]);
      mockContext.dataAccess.Site.findById
        .withArgs('site-1').resolves(site1)
        .withArgs('site-2').resolves(site2);

      mockContext.dataAccess.Opportunity.allBySiteId
        .withArgs('site-1').rejects(new Error('Timeout'))
        .withArgs('site-2').resolves([createMockOpportunity({ id: 'o1', siteId: 'site-2' })]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(1);
      expect(mockContext.log.warn).to.have.been.called;
    });

    it('skips sites that are not found', async () => {
      mockContext.params.brandId = 'all';
      const site1 = createMockSite({ id: 'site-1' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site1]);
      mockContext.dataAccess.Site.findById.withArgs('site-1').resolves(null);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(0);
    });

    it('defaults brandId to "all" when params.brandId is undefined (static /brands/all/ route)', async () => {
      // brandId is not set in params for the static /brands/all/opportunities route
      delete mockContext.params.brandId;
      const site = createMockSite({ id: 'site-1' });
      mockContext.dataAccess.Site.allByOrganizationId.resolves([site]);
      mockContext.dataAccess.Site.findById.withArgs('site-1').resolves(site);
      mockContext.dataAccess.Opportunity.allBySiteId.withArgs('site-1').resolves([]);

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.brandId).to.equal('all');
      expect(body.total).to.equal(0);
    });

    it('returns 500 when site listing fails', async () => {
      mockContext.params.brandId = 'all';
      mockContext.dataAccess.Site.allByOrganizationId.rejects(new Error('DB error'));

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(500);
    });

    it('returns badRequest for unexpected auth errors', async () => {
      mockContext.params.brandId = 'all';
      mockContext.dataAccess.Organization.findById.rejects(new Error('Unexpected'));

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(400);
    });

    it('handles brand with undefined siteIds', async () => {
      mockContext.params.brandId = 'brand-uuid';

      LlmoOpportunitiesController = await esmock(
        '../../../../src/controllers/llmo/opportunities/llmo-opportunities-controller.js',
        {
          ...defaultMocks(sandbox.stub().resolves(true)),
          '../../../../src/support/brands-storage.js': {
            getBrandById: sandbox.stub().resolves({ name: 'EmptyBrand' }),
          },
        },
      );

      const controller = LlmoOpportunitiesController(mockContext);
      const result = await controller.getBrandOpportunities(mockContext);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.total).to.equal(0);
      expect(body.opportunities).to.deep.equal([]);
    });
  });
});
