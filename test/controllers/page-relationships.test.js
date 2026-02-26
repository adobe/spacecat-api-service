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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Page Relationships Controller', () => {
  const sandbox = sinon.createSandbox();

  const SITE_ID = 'f964a7f8-5402-4b01-bd5b-1ab499bcf797';
  const OPPORTUNITY_ID = '71b8f3a4-8c5f-4966-bc67-a933760de5c9';
  const SITE_ID_INVALID = 'not-a-uuid';
  const OPPORTUNITY_ID_INVALID = 'invalid-opportunity-id';
  const ANOTHER_SITE_ID = '3a7ef7f6-ae34-4ec4-94f0-4e9707a406da';

  let PageRelationshipsController;
  let resolvePageIdsStub;
  let fetchRelationshipsStub;
  let isAEMAuthoredSiteStub;
  let buildCheckPathStub;

  let mockDataAccess;
  let mockSite;
  let mockOpportunity;
  let controllerContext;
  let requestContext;
  let log;

  beforeEach(async () => {
    log = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    resolvePageIdsStub = sandbox.stub();
    fetchRelationshipsStub = sandbox.stub();
    isAEMAuthoredSiteStub = sandbox.stub();
    buildCheckPathStub = sandbox.stub();

    mockSite = {
      getDeliveryType: sandbox.stub().returns('aem_cs'),
      getDeliveryConfig: sandbox.stub().returns({
        authorURL: 'https://author.example.com',
        metaTagPropertyMap: {},
      }),
      getBaseURL: sandbox.stub().returns('https://example.com'),
    };

    mockOpportunity = {
      getSiteId: sandbox.stub().returns(SITE_ID),
      getType: sandbox.stub().returns('invalid-or-missing-metadata'),
    };

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves(mockSite),
      },
      Opportunity: {
        findById: sandbox.stub().resolves(mockOpportunity),
      },
      Suggestion: {
        allByOpportunityId: sandbox.stub().resolves([]),
      },
    };

    controllerContext = {
      dataAccess: mockDataAccess,
      log,
    };

    requestContext = {
      params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID },
      data: { pages: [{ pageUrl: '/us/en/page1', suggestionType: 'Missing Title' }] },
      pathInfo: {
        headers: { authorization: 'Bearer test-ims-token' },
      },
    };

    sandbox.stub(AccessControlUtil, 'fromContext').returns({ hasAccess: sandbox.stub().resolves(true) });

    PageRelationshipsController = (await esmock('../../src/controllers/page-relationships.js', {
      '../../src/support/aem-content-api.js': {
        isAEMAuthoredSite: isAEMAuthoredSiteStub,
        resolvePageIds: resolvePageIdsStub,
        fetchRelationships: fetchRelationshipsStub,
        buildCheckPath: buildCheckPathStub,
      },
    })).default;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('throws if dataAccess is missing', () => {
      expect(() => PageRelationshipsController({ log })).to.throw('Data access required');
    });

    it('returns controller with search function', () => {
      const controller = PageRelationshipsController(controllerContext);
      expect(controller).to.have.property('search').that.is.a('function');
      expect(controller).to.have.property('getForOpportunity').that.is.a('function');
    });
  });

  describe('search', () => {
    it('returns 400 for invalid siteId', async () => {
      const controller = PageRelationshipsController(controllerContext);
      requestContext.params.siteId = SITE_ID_INVALID;

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Site ID required');
      expect(mockDataAccess.Site.findById).to.not.have.been.called;
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(404);
      expect(body.message).to.equal('Site not found');
      expect(mockDataAccess.Site.findById).to.have.been.calledOnceWith(SITE_ID);
    });

    it('returns 403 when user does not have access', async () => {
      AccessControlUtil.fromContext.returns({ hasAccess: sandbox.stub().resolves(false) });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(403);
      expect(body.message).to.equal('Only users belonging to the organization can access this site');
    });

    it('returns supported: false when delivery type is not AEM-authored', async () => {
      isAEMAuthoredSiteStub.returns(false);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(false);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns supported: false when authorURL is missing', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getDeliveryConfig.returns({});

      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(false);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 400 when pages is missing or empty', async () => {
      isAEMAuthoredSiteStub.returns(true);
      const controller = PageRelationshipsController(controllerContext);

      requestContext.data = {};
      const response1 = await controller.search(requestContext);
      const body1 = await response1.json();
      expect(response1.status).to.equal(400);
      expect(body1.message).to.include('pages array required');

      requestContext.data = { pages: [] };
      const response2 = await controller.search(requestContext);
      const body2 = await response2.json();
      expect(response2.status).to.equal(400);
      expect(body2.message).to.include('pages array required');
    });

    it('returns 400 when pages entry has missing pageUrl', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = { pages: [{}] };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Each page must include a non-empty pageUrl');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 400 when pages exceeds max size', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: Array(51).fill({ pageUrl: '/p', suggestionType: 'x' }),
      };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.include('max 50');
    });

    it('returns 400 when Authorization header is missing', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.pathInfo = { headers: {} };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Missing Authorization header');
    });

    it('returns supported: true with _config error when site has no baseURL', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getBaseURL.returns('');
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg1' }]);

      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.errors).to.have.property('_config');
      // eslint-disable-next-line dot-notation -- _config needs bracket notation
      expect(body.errors['_config'].error).to.equal('Site has no baseURL');
    });

    it('returns supported: true with relationships when resolve and fetch succeed', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      const resultKey = '/us/en/page1:Missing Title';
      fetchRelationshipsStub.resolves({
        results: {
          [resultKey]: {
            pageId: 'pg-123',
            upstream: { chain: [{ relation: 'liveCopyOf', pageId: 'pg-blueprint', pagePath: '/content/blueprint/en/page1' }] },
          },
        },
        errors: {},
      });

      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.have.property(resultKey);
      expect(body.relationships[resultKey].upstream.chain).to.have.lengthOf(1);
      expect(body.errors).to.deep.equal({});

      expect(resolvePageIdsStub).to.have.been.calledOnce;
      expect(resolvePageIdsStub.firstCall.args[0]).to.equal('https://example.com');
      expect(resolvePageIdsStub.firstCall.args[1]).to.equal('https://author.example.com');
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page1']);
      expect(resolvePageIdsStub.firstCall.args[3]).to.equal('test-ims-token');

      expect(fetchRelationshipsStub).to.have.been.calledOnce;
      expect(fetchRelationshipsStub.firstCall.args[0]).to.equal('https://author.example.com');
      expect(fetchRelationshipsStub.firstCall.args[1]).to.have.lengthOf(1);
      expect(fetchRelationshipsStub.firstCall.args[1][0]).to.include({ key: resultKey, pageId: 'pg-123' });
      expect(fetchRelationshipsStub.firstCall.args[1][0].include).to.deep.equal(['upstream']);
      expect(fetchRelationshipsStub.firstCall.args[2]).to.equal('test-ims-token');
    });

    it('merges resolve errors and AEM API errors in response', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-123' },
        { url: '/us/en/page2', error: 'HTTP 404' },
      ]);
      fetchRelationshipsStub.resolves({
        results: {
          '/us/en/page1:': { pageId: 'pg-123', upstream: { chain: [] } },
        },
        errors: {
          '/us/en/page1:': { error: 'NOT_FOUND' },
        },
      });

      requestContext.data = {
        pages: [
          { pageUrl: '/us/en/page1' },
          { pageUrl: '/us/en/page2' },
        ],
      };

      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.errors).to.include.keys('/us/en/page2');
      expect(body.errors['/us/en/page2'].error).to.equal('HTTP 404');
      expect(body.errors['/us/en/page1:'].error).to.equal('NOT_FOUND');
    });

    it('calls buildCheckPath with suggestionType and delivery config', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns('/properties/jcr:title');
      const deliveryConfig = { authorURL: 'https://author.example.com', metaTagPropertyMap: { title: 'jcr:title' } };
      mockSite.getDeliveryConfig.returns(deliveryConfig);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      fetchRelationshipsStub.resolves({ results: { k1: { upstream: { chain: [] } } }, errors: {} });

      const controller = PageRelationshipsController(controllerContext);

      await controller.search(requestContext);

      expect(buildCheckPathStub).to.have.been.calledWith('Missing Title', deliveryConfig);
      expect(fetchRelationshipsStub.firstCall.args[1][0].checkPath).to.equal('/properties/jcr:title');
    });

    it('does not include checkPath when derived checkPath is an empty string', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns('');
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      fetchRelationshipsStub.resolves({ results: {}, errors: {} });

      const controller = PageRelationshipsController(controllerContext);

      await controller.search(requestContext);

      expect(fetchRelationshipsStub.firstCall.args[1][0]).to.not.have.property('checkPath');
    });

    it('uses checkPath from page spec when provided instead of deriving it', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      fetchRelationshipsStub.resolves({ results: {}, errors: {} });
      requestContext.data = {
        pages: [{
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
          checkPath: '/properties/custom-prop',
        }],
      };

      const controller = PageRelationshipsController(controllerContext);

      await controller.search(requestContext);

      expect(buildCheckPathStub).to.not.have.been.called;
      expect(fetchRelationshipsStub.firstCall.args[1][0].checkPath).to.equal('/properties/custom-prop');
    });

    it('does not derive checkPath when an explicit empty checkPath is provided', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      fetchRelationshipsStub.resolves({ results: {}, errors: {} });
      requestContext.data = {
        pages: [{
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
          checkPath: '',
        }],
      };

      const controller = PageRelationshipsController(controllerContext);

      await controller.search(requestContext);

      expect(buildCheckPathStub).to.not.have.been.called;
      expect(fetchRelationshipsStub.firstCall.args[1][0]).to.not.have.property('checkPath');
    });

    it('uses page key from request when provided', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns(undefined);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      fetchRelationshipsStub.resolves({ results: { 'page-1': { upstream: { chain: [] } } }, errors: {} });
      requestContext.data = {
        pages: [{ key: 'page-1', pageUrl: '/us/en/page1', suggestionType: 'Missing Title' }],
      };

      const controller = PageRelationshipsController(controllerContext);

      await controller.search(requestContext);

      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('page-1');
    });

    it('passes delivery config without metaTagPropertyMap when config has no map', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns(undefined);
      const deliveryConfig = { authorURL: 'https://author.example.com' };
      mockSite.getDeliveryConfig.returns(deliveryConfig);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
      fetchRelationshipsStub.resolves({ results: { k1: { upstream: { chain: [] } } }, errors: {} });
      const controller = PageRelationshipsController(controllerContext);

      await controller.search(requestContext);

      expect(buildCheckPathStub).to.have.been.calledWith('Missing Title', deliveryConfig);
    });

    it('returns supported: true with empty relationships when all pages fail to resolve', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', error: 'No content-page-id or content-page-ref' },
      ]);

      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.have.property('/us/en/page1');
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('uses default resolve error message when resolve result has no pageId and no error', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1' }]);

      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.errors['/us/en/page1'].error).to.equal('Could not resolve page');
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('uses resolved url as error key when resolved item has no page spec match', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-123' },
        { url: '/us/en/page2', error: 'HTTP 404' },
      ]);
      fetchRelationshipsStub.resolves({
        results: { '/us/en/page1:Missing Title': { pageId: 'pg-123', upstream: { chain: [] } } },
        errors: {},
      });
      requestContext.data = {
        pages: [{ pageUrl: '/us/en/page1', suggestionType: 'Missing Title' }],
      };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.errors['/us/en/page2'].error).to.equal('HTTP 404');
    });
  });

  describe('getForOpportunity', () => {
    const createSuggestion = (data = {}, type = 'CONTENT_UPDATE') => ({
      getData: sandbox.stub().returns(data),
      getType: sandbox.stub().returns(type),
    });

    it('returns 400 for invalid siteId', async () => {
      const controller = PageRelationshipsController(controllerContext);
      requestContext.params.siteId = SITE_ID_INVALID;

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Site ID required');
      expect(mockDataAccess.Site.findById).to.not.have.been.called;
    });

    it('returns 400 for invalid opportunityId', async () => {
      const controller = PageRelationshipsController(controllerContext);
      requestContext.params.opportunityId = OPPORTUNITY_ID_INVALID;

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Opportunity ID required');
      expect(mockDataAccess.Site.findById).to.not.have.been.called;
    });

    it('returns 404 when opportunity is not found', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Opportunity.findById.resolves(null);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(404);
      expect(body.message).to.equal('Opportunity not found');
      expect(mockDataAccess.Suggestion.allByOpportunityId).to.not.have.been.called;
    });

    it('returns 404 when opportunity belongs to another site', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockOpportunity.getSiteId.returns(ANOTHER_SITE_ID);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(404);
      expect(body.message).to.equal('Opportunity not found');
      expect(mockDataAccess.Suggestion.allByOpportunityId).to.not.have.been.called;
    });

    it('returns 400 when Authorization header is missing', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.pathInfo = { headers: {} };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Missing Authorization header');
    });

    it('returns supported: false when site is not AEM-authored', async () => {
      isAEMAuthoredSiteStub.returns(false);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(false);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns empty relationships when opportunity has no suggestions', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
      expect(resolvePageIdsStub).to.not.have.been.called;
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('extracts unique pageUrl + suggestionType pairs from suggestions', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({ url: 'https://example.com/us/en/page1', suggestionType: 'Missing Title' }),
        createSuggestion({ url: 'https://example.com/us/en/page1', suggestionType: 'Missing Title' }),
        createSuggestion({
          issue: 'Missing Description',
          recommendations: [{ pageUrl: 'https://example.com/us/en/page2' }],
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-1' },
        { url: '/us/en/page2', pageId: 'pg-2' },
      ]);
      fetchRelationshipsStub.resolves({
        results: {
          '/us/en/page1:Missing Title': { pageId: 'pg-1', upstream: { chain: [] } },
          '/us/en/page2:Missing Description': { pageId: 'pg-2', upstream: { chain: [] } },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(resolvePageIdsStub).to.have.been.calledOnce;
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page1', '/us/en/page2']);
      expect(fetchRelationshipsStub).to.have.been.calledOnce;
      expect(fetchRelationshipsStub.firstCall.args[1]).to.have.lengthOf(2);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('/us/en/page1:Missing Title');
      expect(fetchRelationshipsStub.firstCall.args[1][1].key).to.equal('/us/en/page2:Missing Description');
      expect(body.relationships).to.have.property('/us/en/page1:Missing Title');
      expect(body.relationships).to.have.property('/us/en/page2:Missing Description');
    });

    it('uses normalized path key when suggestion URL is absolute', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: 'https://example.com/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: 'https://example.com/us/en/page1', pageId: 'pg-1' },
      ]);
      fetchRelationshipsStub.callsFake(async (authorURL, items) => ({
        results: {
          [items[0].key]: {
            pageId: items[0].pageId,
            upstream: { chain: [] },
          },
        },
        errors: {},
      }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page1']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('/us/en/page1:Missing Title');
      expect(body.relationships).to.have.property('/us/en/page1:Missing Title');
    });

    it('does not derive suggestion type from title or opportunity type', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion(
          {
            pageUrl: '/us/en/page1',
            title: 'Marketing Page',
          },
          'CONTENT_UPDATE',
        ),
      ]);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.callsFake(async (authorURL, items) => ({
        results: {
          [items[0].key]: {
            pageId: items[0].pageId,
            upstream: { chain: [] },
          },
        },
        errors: {},
      }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('/us/en/page1:');
      expect(body.relationships).to.have.property('/us/en/page1:');
    });

    it('uses url_to/urlTo for broken-link opportunities and ignores url_from/urlFrom', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockOpportunity.getType.returns('broken-backlinks');
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          url_from: '/us/en/referrer-page-a',
          urlFrom: '/us/en/referrer-page-b',
          url_to: '/us/en/page-with-issue',
          urlTo: '/us/en/page-with-issue-camel',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page-with-issue', pageId: 'pg-1' },
        { url: '/us/en/page-with-issue-camel', pageId: 'pg-2' },
      ]);
      fetchRelationshipsStub.resolves({
        results: {
          '/us/en/page-with-issue:Missing Title': { pageId: 'pg-1', upstream: { chain: [] } },
          '/us/en/page-with-issue-camel:Missing Title': { pageId: 'pg-2', upstream: { chain: [] } },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page-with-issue', '/us/en/page-with-issue-camel']);
      expect(body.relationships).to.have.property('/us/en/page-with-issue:Missing Title');
      expect(body.relationships).to.have.property('/us/en/page-with-issue-camel:Missing Title');
    });

    it('deduplicates suggestions by normalized pageUrl + suggestionType', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          url: 'https://example.com/us/en/page-dup',
          suggestionType: 'Missing Title',
        }),
        createSuggestion({
          pageUrl: '/us/en/page-dup',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([{ url: '/us/en/page-dup', pageId: 'pg-dup' }]);
      fetchRelationshipsStub.resolves({
        results: {
          '/us/en/page-dup:Missing Title': { pageId: 'pg-dup', upstream: { chain: [] } },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub).to.have.been.calledOnce;
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page-dup']);
      expect(fetchRelationshipsStub.firstCall.args[1]).to.have.lengthOf(1);
      expect(body.relationships).to.have.property('/us/en/page-dup:Missing Title');
    });

    it('batches requests in chunks of 50 for more than 50 unique pages', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves(
        Array.from({ length: 120 }, (_, i) => createSuggestion({
          url: `/us/en/page-${i}`,
          suggestionType: 'Missing Title',
        })),
      );
      resolvePageIdsStub.callsFake(async (baseUrl, authorURL, pageUrls) => (
        pageUrls.map((pageUrl) => ({ url: pageUrl, pageId: `pg-${pageUrl}` }))
      ));
      fetchRelationshipsStub.callsFake(async (authorURL, items) => ({
        results: Object.fromEntries(
          items.map((item) => [item.key, { pageId: item.pageId, upstream: { chain: [] } }]),
        ),
        errors: {},
      }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(resolvePageIdsStub).to.have.callCount(3);
      expect(resolvePageIdsStub.firstCall.args[2]).to.have.lengthOf(50);
      expect(resolvePageIdsStub.secondCall.args[2]).to.have.lengthOf(50);
      expect(resolvePageIdsStub.thirdCall.args[2]).to.have.lengthOf(20);
      expect(fetchRelationshipsStub).to.have.callCount(3);
      expect(fetchRelationshipsStub.firstCall.args[1]).to.have.lengthOf(50);
      expect(fetchRelationshipsStub.secondCall.args[1]).to.have.lengthOf(50);
      expect(fetchRelationshipsStub.thirdCall.args[1]).to.have.lengthOf(20);
      expect(Object.keys(body.relationships)).to.have.lengthOf(120);
    });
  });
});
