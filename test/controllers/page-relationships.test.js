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
  let resolveAemAccessTokenStub;

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
    resolveAemAccessTokenStub = sandbox.stub().resolves('test-ims-token');

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
      getType: sandbox.stub().returns('meta-tags'),
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
      '../../src/support/utils.js': {
        resolveAemAccessToken: (...args) => resolveAemAccessTokenStub(...args),
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

    it('returns controller with getForOpportunity function', () => {
      const controller = PageRelationshipsController(controllerContext);
      expect(controller).to.have.property('getForOpportunity').that.is.a('function');
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

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(404);
      expect(body.message).to.equal('Site not found');
      expect(mockDataAccess.Opportunity.findById).to.not.have.been.called;
    });

    it('returns 403 when user does not have access to the site', async () => {
      AccessControlUtil.fromContext.returns({ hasAccess: sandbox.stub().resolves(false) });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(403);
      expect(body.message).to.equal('Only users belonging to the organization can access this site');
      expect(mockDataAccess.Opportunity.findById).to.not.have.been.called;
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

    it('returns supported: false for unsupported opportunity type', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockOpportunity.getType.returns('broken-backlinks');
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(false);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.have.property('_opportunity');
      const { _opportunity: unsupportedTypeError } = body.errors;
      expect(unsupportedTypeError.error).to.equal('Unsupported opportunity type: broken-backlinks');
      expect(mockDataAccess.Suggestion.allByOpportunityId).to.not.have.been.called;
      expect(resolvePageIdsStub).to.not.have.been.called;
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('returns supported: false with unknown type when opportunity type is missing', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockOpportunity.getType.returns(undefined);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(false);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.have.property('_opportunity');
      const { _opportunity: unknownTypeError } = body.errors;
      expect(unknownTypeError.error).to.equal('Unsupported opportunity type: unknown');
      expect(mockDataAccess.Suggestion.allByOpportunityId).to.not.have.been.called;
      expect(resolvePageIdsStub).to.not.have.been.called;
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('returns 400 when AEM token cannot be resolved', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolveAemAccessTokenStub.rejects(Object.assign(new Error('Missing Authorization header'), { status: 400 }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Missing Authorization header');
    });

    it('returns default 400 message when AEM token error has no message', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolveAemAccessTokenStub.rejects(Object.assign(new Error(), { message: '', status: 400 }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Missing Authorization header');
    });

    it('returns 401 when AEM token exchange fails', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolveAemAccessTokenStub.rejects(Object.assign(new Error('Authentication failed with upstream IMS service'), { status: 401 }));
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(401);
      expect(body.message).to.equal('Authentication failed with upstream IMS service');
      expect(resolvePageIdsStub).to.not.have.been.called;
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('uses resolved AEM token for relationship lookup', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-1' },
      ]);
      fetchRelationshipsStub.resolves({
        results: {
          '/us/en/page1:Missing Title': { pageId: 'pg-1', upstream: { chain: [] } },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolveAemAccessTokenStub).to.have.been.calledOnceWithExactly(requestContext);
      expect(resolvePageIdsStub.firstCall.args[3]).to.equal('test-ims-token');
      expect(body.relationships).to.have.property('/us/en/page1:Missing Title');
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

    it('returns supported: false when authorURL is missing', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getDeliveryConfig.returns({});
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(false);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
      expect(mockDataAccess.Suggestion.allByOpportunityId).to.not.have.been.called;
      expect(resolvePageIdsStub).to.not.have.been.called;
      expect(fetchRelationshipsStub).to.not.have.been.called;
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

    it('returns _config error when site has no baseURL', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getBaseURL.returns('');
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.have.property('_config');
      // eslint-disable-next-line dot-notation -- _config needs bracket notation
      expect(body.errors['_config'].error).to.equal('Site has no baseURL');
      expect(resolvePageIdsStub).to.not.have.been.called;
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('returns empty relationships when suggestions payload is not an array', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves({ suggestions: [] });
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

    it('skips suggestion entries that do not implement getData', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        null,
        {},
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({
        results: {
          '/us/en/page1:Missing Title': { pageId: 'pg-1', upstream: { chain: [] } },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page1']);
      expect(fetchRelationshipsStub.firstCall.args[1]).to.have.lengthOf(1);
      expect(body.relationships).to.have.property('/us/en/page1:Missing Title');
    });

    it('returns resolve error details when a page cannot be resolved', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', error: 'HTTP 404' },
      ]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors['/us/en/page1'].error).to.equal('HTTP 404');
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('returns default resolve error when no pageId and no resolve error are returned', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1' },
      ]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors['/us/en/page1'].error).to.equal('Could not resolve page');
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('returns default resolve error when resolver returns fewer entries than requested pages', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.getForOpportunity(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.supported).to.equal(true);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors['/us/en/page1'].error).to.equal('Could not resolve page');
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

    it('includes derived checkPath when buildCheckPath returns a non-empty value', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns('/properties/jcr:title');
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: '/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-1' },
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
      expect(fetchRelationshipsStub.firstCall.args[1][0].checkPath).to.equal('/properties/jcr:title');
      expect(body.relationships).to.have.property('/us/en/page1:Missing Title');
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

    it('keeps absolute URL for lookup when suggestion host differs from site host', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: 'https://external.example.com/us/en/page1',
          suggestionType: 'Missing Title',
        }),
      ]);
      resolvePageIdsStub.resolves([
        { url: 'https://external.example.com/us/en/page1', pageId: 'pg-1' },
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
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['https://external.example.com/us/en/page1']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key)
        .to.equal('https://external.example.com/us/en/page1:Missing Title');
      expect(body.relationships).to.have.property('https://external.example.com/us/en/page1:Missing Title');
    });

    it('keeps absolute URL when normalization cannot parse site base URL', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getBaseURL.returns('invalid-site-url');
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
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['https://example.com/us/en/page1']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key)
        .to.equal('https://example.com/us/en/page1:Missing Title');
      expect(body.relationships).to.have.property('https://example.com/us/en/page1:Missing Title');
    });

    it('falls back to root path when normalized absolute URL has empty pathname', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockDataAccess.Suggestion.allByOpportunityId.resolves([
        createSuggestion({
          pageUrl: 'https://example.com',
          suggestionType: 'Missing Title',
        }),
      ]);
      sandbox.replace(globalThis, 'URL', class URLMock {
        constructor(value) {
          this.host = 'example.com';
          this.pathname = value === 'https://example.com' ? '' : '/';
        }
      });
      resolvePageIdsStub.resolves([
        { url: '/', pageId: 'pg-root' },
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
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('/:Missing Title');
      expect(body.relationships).to.have.property('/:Missing Title');
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
