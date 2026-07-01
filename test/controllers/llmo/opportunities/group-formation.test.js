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
const PATTERN = '/products/*';

function makeUrls(count, prefix = '/products/page-') {
  return Array.from({ length: count }, (_, i) => `https://example.com${prefix}${i}`);
}

function makeContext(urls = makeUrls(60)) {
  const mockSite = { getId: () => VALID_SITE_ID };
  const makeSuggestion = (url, metrics = {}) => ({
    getData: () => ({
      url,
      agenticTraffic: metrics.agenticTraffic ?? null,
      contentGainRatio: metrics.contentGainRatio ?? null,
      contentVisibility: metrics.contentVisibility ?? null,
    }),
  });

  return {
    dataAccess: {
      Site: { findById: sinon.stub().resolves(mockSite) },
      Opportunity: {
        allBySiteId: sinon.stub().resolves([
          { getId: () => 'opp-1', getType: () => 'faq' },
        ]),
      },
      Suggestion: {
        allByOpportunityId: sinon.stub().resolves(
          urls.map((url) => makeSuggestion(url)),
        ),
      },
    },
    log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
  };
}

describe('GroupFormationController', () => {
  let GroupFormationController;

  before(async () => {
    GroupFormationController = await esmock('../../../../src/controllers/llmo/opportunities/group-formation.js', {
      '../../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: sinon.stub().resolves(true) }),
        },
      },
    });
  });

  describe('createGroupings', () => {
    it('returns 400 for missing siteId', async () => {
      const ctx = makeContext();
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: {},
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for missing pageGroupPattern', async () => {
      const ctx = makeContext();
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { testGroupCount: 2 },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when testGroupCount < 1', async () => {
      const ctx = makeContext();
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 0 },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 404 when site not found', async () => {
      const ctx = makeContext();
      ctx.dataAccess.Site.findById = sinon.stub().resolves(null);
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      expect(res.status).to.equal(404);
    });

    it('returns control + N test groups + holdout', async () => {
      const ctx = makeContext(makeUrls(60));
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      expect(res.status).to.equal(200);
      const body = await res.json();
      const roles = body.map((g) => g.role);
      expect(roles).to.include('control');
      expect(roles).to.include('test');
      expect(roles).to.include('holdout');
      expect(body.filter((g) => g.role === 'test').length).to.equal(2);
    });

    it('reserves 20% for holdout (min 20)', async () => {
      const ctx = makeContext(makeUrls(60));
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      const body = await res.json();
      const holdout = body.find((g) => g.role === 'holdout');
      expect(holdout.pageCount).to.equal(Math.max(20, Math.round(60 * 0.2)));
    });

    it('URLs sum to total (no pages lost or duplicated)', async () => {
      const urls = makeUrls(60);
      const ctx = makeContext(urls);
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      const body = await res.json();
      const totalPages = body.reduce((sum, g) => sum + g.pageCount, 0);
      expect(totalPages).to.equal(60);
    });

    it('filters suggestions to matching path pattern', async () => {
      const urls = [
        'https://example.com/products/photoshop',
        'https://example.com/blog/article', // should be excluded
        'https://example.com/products/illustrator',
      ];
      const ctx = makeContext(urls);
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: '/products/*', testGroupCount: 1 },
      });
      const body = await res.json();
      const total = body.reduce((sum, g) => sum + g.pageCount, 0);
      expect(total).to.equal(2); // only /products/* URLs
    });

    it('returns empty groups when no matching URLs found', async () => {
      const ctx = makeContext([]);
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: '/nonexistent/*', testGroupCount: 2 },
      });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal([]);
    });

    it('includes personas aggregated from suggestion.data.personas', async () => {
      const urls = makeUrls(60);
      const ctx = makeContext(urls);
      ctx.dataAccess.Suggestion.allByOpportunityId = sinon.stub().resolves(
        urls.map((url) => ({
          getData: () => ({
            url,
            personas: [
              {
                id: 'tech', name: 'Technical', trafficShare: 0.6, focus: 'APIs', samplePrompts: [],
              },
            ],
          }),
        })),
      );
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      const body = await res.json();
      const testGroup = body.find((g) => g.role === 'test');
      expect(testGroup.personas).to.have.length.greaterThan(0);
      expect(testGroup.personas[0].name).to.equal('Technical');
    });

    it('returns empty personas when W6 has not run yet', async () => {
      const ctx = makeContext(makeUrls(60));
      const controller = GroupFormationController(ctx);
      const res = await controller.createGroupings({
        params: { siteId: VALID_SITE_ID },
        data: { pageGroupPattern: PATTERN, testGroupCount: 2 },
      });
      const body = await res.json();
      expect(body[0].personas).to.deep.equal([]);
    });
  });
});
