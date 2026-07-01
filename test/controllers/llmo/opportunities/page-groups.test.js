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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

const VALID_SITE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeContext(overrides = {}) {
  const mockSite = { getId: () => VALID_SITE_ID };
  const mockOpportunity = (type, id) => ({
    getId: () => id,
    getType: () => type,
  });
  const makeSuggestion = (url, locked = false) => ({
    getData: () => ({
      url,
      edgeOptimizeStatus: locked ? 'EXPERIMENT_IN_PROGRESS' : undefined,
    }),
  });

  return {
    dataAccess: {
      Site: { findById: sinon.stub().resolves(mockSite) },
      Opportunity: {
        allBySiteId: sinon.stub().resolves([
          mockOpportunity('faq', 'opp-1'),
          mockOpportunity('summarization', 'opp-2'),
          mockOpportunity('headings', 'opp-3'), // should be excluded
        ]),
      },
      Suggestion: {
        allByOpportunityId: sinon.stub().callsFake((oppId) => {
          if (oppId === 'opp-1') {
            return Promise.resolve([
              makeSuggestion('https://example.com/products/photoshop'),
              makeSuggestion('https://example.com/products/illustrator'),
              makeSuggestion('https://example.com/products/premiere', true), // locked
            ]);
          }
          if (oppId === 'opp-2') {
            return Promise.resolve([
              makeSuggestion('https://example.com/blog/design-tips'),
            ]);
          }
          return Promise.resolve([]);
        }),
      },
    },
    log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    ...overrides,
  };
}

describe('PageGroupsController', () => {
  let PageGroupsController;

  before(async () => {
    PageGroupsController = await esmock('../../../../src/controllers/llmo/opportunities/page-groups.js', {
      '../../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: sinon.stub().resolves(true) }),
        },
      },
      '@adobe/spacecat-shared-rum-api-client': {
        default: {},
        resolveRumDomainKey: sinon.stub().resolves({}),
        RUM_BUNDLER_API_HOST: 'https://rum.fastly-insights.com',
      },
    });
  });

  describe('getPageGroups', () => {
    it('returns 400 when siteId is missing', async () => {
      const ctx = makeContext();
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: {} });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when siteId is not a valid UUID', async () => {
      const ctx = makeContext();
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: 'not-a-uuid' } });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when site is not found', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Site.findById = sinon.stub().resolves(null);
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      expect(res.status).to.equal(404);
    });

    it('clusters suggestion URLs by first path segment', async () => {
      const ctx = makeContext();
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.be.an('array');
      const patterns = body.map((g) => g.pattern);
      expect(patterns).to.include('/products/*');
      expect(patterns).to.include('/blog/*');
    });

    it('excludes non-experimentable opportunity types', async () => {
      const ctx = makeContext();
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      const body = await res.json();
      // headings opp has no URLs (returns []) so only products + blog appear
      expect(body.length).to.equal(2);
    });

    it('counts locked pages correctly', async () => {
      const ctx = makeContext();
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      const body = await res.json();
      const products = body.find((g) => g.pattern === '/products/*');
      expect(products.pageCount).to.equal(3);
      expect(products.lockedPages).to.equal(1);
    });

    it('assigns high trafficLevel for 80+ pages', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Suggestion.allByOpportunityId = sinon.stub().callsFake((oppId) => {
        if (oppId === 'opp-1') {
          return Promise.resolve(
            Array.from({ length: 85 }, (_, i) => ({ getData: () => ({ url: `https://example.com/products/page-${i}` }) })),
          );
        }
        return Promise.resolve([]);
      });
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      const body = await res.json();
      expect(body[0].trafficLevel).to.equal('high');
    });

    it('returns empty array when no experimentable suggestions exist', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Opportunity.allBySiteId = sinon.stub().resolves([]);
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([]);
    });

    it('sorts groups by pageCount descending', async () => {
      const ctx = makeContext();
      const controller = PageGroupsController(ctx);
      const res = await controller.getPageGroups({ params: { siteId: VALID_SITE_ID } });
      const body = await res.json();
      expect(body[0].pageCount).to.be.gte(body[body.length - 1].pageCount);
    });
  });
});
