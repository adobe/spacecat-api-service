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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import AccessControlUtil from '../../src/support/access-control-util.js';
import { ErrorWithStatusCode } from '../../src/support/utils.js';

use(chaiAsPromised);
use(sinonChai);

describe('Page Relationships Controller', () => {
  const sandbox = sinon.createSandbox();

  const SITE_ID = 'f964a7f8-5402-4b01-bd5b-1ab499bcf797';
  const SITE_ID_INVALID = 'not-a-uuid';

  let PageRelationshipsController;
  let resolvePageIdsStub;
  let fetchRelationshipsStub;
  let isAEMAuthoredSiteStub;
  let buildCheckPathStub;
  let getIMSPromiseTokenStub;
  let exchangePromiseTokenStub;

  let mockDataAccess;
  let mockSite;
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
    getIMSPromiseTokenStub = sandbox.stub().resolves({
      promise_token: 'test-promise-token',
      expires_in: 60,
      token_type: 'bearer',
    });
    exchangePromiseTokenStub = sandbox.stub().resolves('test-ims-token');

    mockSite = {
      getDeliveryType: sandbox.stub().returns('aem_cs'),
      getDeliveryConfig: sandbox.stub().returns({
        authorURL: 'https://author.example.com',
        metaTagPropertyMap: {},
      }),
      getBaseURL: sandbox.stub().returns('https://example.com'),
    };

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves(mockSite),
      },
    };

    controllerContext = {
      dataAccess: mockDataAccess,
      log,
    };

    requestContext = {
      params: { siteId: SITE_ID },
      data: { pages: [{ key: 'row-1', pageUrl: '/us/en/page1', suggestionType: 'Missing Title' }] },
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
        getIMSPromiseToken: (...args) => getIMSPromiseTokenStub(...args),
        exchangePromiseToken: (...args) => exchangePromiseTokenStub(...args),
        ErrorWithStatusCode,
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

    it('returns 400 when pages is missing or empty', async () => {
      isAEMAuthoredSiteStub.returns(true);
      const controller = PageRelationshipsController(controllerContext);

      requestContext.data = {};
      const response1 = await controller.search(requestContext);
      const body1 = await response1.json();
      expect(response1.status).to.equal(400);
      expect(body1.message).to.equal('pages array required');

      requestContext.data = { pages: [] };
      const response2 = await controller.search(requestContext);
      const body2 = await response2.json();
      expect(response2.status).to.equal(400);
      expect(body2.message).to.equal('pages array required');
    });

    it('returns 400 when pages entry has missing pageUrl', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = { pages: [{ key: 'row-1' }] };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Each page must include a non-empty pageUrl');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 400 when pages entry has missing key', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = { pages: [{ pageUrl: '/us/en/page1' }] };
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Each page must include a non-empty key');
      expect(resolvePageIdsStub).to.not.have.been.called;
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
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
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
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 400 when Authorization header is missing', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(new ErrorWithStatusCode('Missing Authorization header', 400));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Missing Authorization header');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('uses status from ErrorWithStatusCode for token-flow errors', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(new ErrorWithStatusCode('Authentication failed', 401));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(401);
      expect(body.message).to.equal('Authentication failed');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('falls back to 400 when ErrorWithStatusCode has no status', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(new ErrorWithStatusCode('Missing Authorization header'));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(400);
      expect(body.message).to.equal('Missing Authorization header');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 4xx with IMS token problem details when generic error contains a 4xx status', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(Object.assign(new Error('exchange failed'), { status: 401 }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(401);
      expect(body.message).to.equal('Problem getting IMS token: 401 exchange failed');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('uses statusCode when generic error includes statusCode', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(Object.assign(new Error('rate limited'), { statusCode: 429 }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(429);
      expect(body.message).to.equal('Problem getting IMS token: 429 rate limited');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 500 when generic token error has no client status', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(Object.assign(new Error(), { message: '' }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(500);
      expect(body.message).to.equal('Error getting IMS token');
      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include('Problem getting IMS token');
      expect(log.error.firstCall.args[0]).to.include('Unknown error');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns 500 when generic token error has non-4xx status', async () => {
      isAEMAuthoredSiteStub.returns(true);
      getIMSPromiseTokenStub.rejects(Object.assign(new Error('upstream unavailable'), { status: 503 }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(500);
      expect(body.message).to.equal('Error getting IMS token');
      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include('503 upstream unavailable');
      expect(resolvePageIdsStub).to.not.have.been.called;
    });

    it('returns _config error when site has no baseURL', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getBaseURL.returns('');
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg1' }]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
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

    it('passes exchanged IMS token to resolver and normalizes same-host absolute URL for lookup', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [{ key: 'row-abs', pageUrl: 'https://example.com/us/en/page1', suggestionType: 'Missing Title' }],
      };
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-123' }]);
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
      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(getIMSPromiseTokenStub).to.have.been.calledOnceWithExactly(requestContext);
      expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(requestContext, 'test-promise-token');
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/us/en/page1']);
      expect(resolvePageIdsStub.firstCall.args[3]).to.equal('test-ims-token');
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('row-abs');
      expect(body.relationships).to.have.property('row-abs');
      expect(body.relationships['row-abs'].pagePath).to.equal('/us/en/page1');
      expect(body.relationships['row-abs'].pageId).to.equal('pg-123');
    });

    it('maps upstream relationship payload to sourceType and minimal chain shape', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [
          { key: 'row-live', pageUrl: '/us/en/page1', suggestionType: 'Missing Title' },
          { key: 'row-lang', pageUrl: '/us/de/page2', suggestionType: 'Missing Description' },
          { key: 'row-none', pageUrl: '/us/en/page3', suggestionType: 'Missing Description' },
          { key: 'row-plain', pageUrl: '/us/en/page4', suggestionType: 'Missing Description' },
        ],
      };
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-1' },
        { url: '/us/de/page2', pageId: 'pg-2' },
        { url: '/us/en/page3', pageId: 'pg-3' },
        { url: '/us/en/page4', pageId: 'pg-4' },
      ]);
      fetchRelationshipsStub.resolves({
        results: {
          'row-live': {
            upstream: {
              chain: [
                { pageId: 'pg-parent-1', relation: 'liveCopyOf', pagePath: '/language-masters/en/page1' },
                { pageId: 'pg-parent-2', relation: 'unknownRelation', pagePath: '/ignored/path' },
                { relation: 'liveCopyOf', pagePath: '/missing/page-id' },
              ],
            },
          },
          'row-lang': {
            metadata: { sourceType: 'langcopy' },
            chain: [
              { pageId: 'pg-global-de', relation: 'languageCopyOf', path: '/global/de/page2' },
            ],
          },
          'row-none': {},
          'row-plain': {
            chain: [
              { pageId: 'pg-plain', pagePath: '/global/plain/page' },
            ],
          },
        },
        errors: {},
      });

      const controller = PageRelationshipsController(controllerContext);
      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships['row-live']).to.deep.equal({
        pagePath: '/us/en/page1',
        pageId: 'pg-1',
        chain: [
          { pageId: 'pg-parent-1', pagePath: '/language-masters/en/page1', metadata: { sourceType: 'liveCopyOf' } },
          { pageId: 'pg-parent-2', pagePath: '/ignored/path', metadata: { sourceType: 'unknownRelation' } },
        ],
      });
      expect(body.relationships['row-lang']).to.deep.equal({
        pagePath: '/us/de/page2',
        pageId: 'pg-2',
        chain: [{ pageId: 'pg-global-de', pagePath: '/global/de/page2', metadata: { sourceType: 'languageCopyOf' } }],
      });
      expect(body.relationships['row-none']).to.deep.equal({
        pagePath: '/us/en/page3',
        pageId: 'pg-3',
        chain: [],
      });
      expect(body.relationships['row-plain']).to.deep.equal({
        pagePath: '/us/en/page4',
        pageId: 'pg-4',
        chain: [{ pageId: 'pg-plain', pagePath: '/global/plain/page' }],
      });
    });

    it('infers sourceType from edge.type and maps pagePath from edge.page', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({
        results: {
          'row-1': {
            upstream: {
              chain: [
                { pageId: 'pg-parent', type: 'liveCopyOf', page: '/language-masters/en/page1' },
              ],
            },
          },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships['row-1']).to.deep.equal({
        pagePath: '/us/en/page1',
        pageId: 'pg-1',
        chain: [{ pageId: 'pg-parent', pagePath: '/language-masters/en/page1', metadata: { sourceType: 'liveCopyOf' } }],
      });
    });

    it('infers sourceType from edge.sourceType when relation and type are absent', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({
        results: {
          'row-1': {
            upstream: {
              chain: [
                { pageId: 'pg-global-fr', sourceType: 'langcopy', pagePath: '/global/fr/page1' },
              ],
            },
          },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships['row-1']).to.deep.equal({
        pagePath: '/us/en/page1',
        pageId: 'pg-1',
        chain: [{ pageId: 'pg-global-fr', pagePath: '/global/fr/page1', metadata: { sourceType: 'langcopy' } }],
      });
    });

    it('handles missing relationship results payload by returning an empty relationships map', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({ errors: {} });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
    });

    it('ignores relationship results that do not match requested page keys', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({
        results: {
          'unknown-key': {
            pageId: 'pg-external',
            upstream: { chain: [] },
          },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors).to.deep.equal({});
    });

    it('uses caller key for fetch item keys and resolve errors', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [
          { key: 'row-1', pageUrl: '/us/en/page1', suggestionType: 'Missing Title' },
          { key: 'row-2', pageUrl: '/us/en/page2', suggestionType: 'Missing Description' },
        ],
      };
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-1' },
        { url: '/us/en/page2', error: 'HTTP 404' },
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
      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('row-1');
      expect(body.relationships).to.have.property('row-1');
      expect(body.relationships['row-1'].pagePath).to.equal('/us/en/page1');
      expect(body.relationships['row-1'].pageId).to.equal('pg-1');
      expect(body.errors).to.have.property('row-2');
      expect(body.errors['row-2'].error).to.equal('HTTP 404');
    });

    it('keeps absolute URL for lookup when suggestion host differs from site host', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [{ key: 'row-external', pageUrl: 'https://external.example.com/us/en/page1', suggestionType: 'Missing Title' }],
      };
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

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['https://external.example.com/us/en/page1']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('row-external');
      expect(body.relationships).to.have.property('row-external');
      expect(body.relationships['row-external'].pagePath).to.equal('https://external.example.com/us/en/page1');
      expect(body.relationships['row-external'].pageId).to.equal('pg-1');
    });

    it('keeps absolute URL when normalization cannot parse site base URL', async () => {
      isAEMAuthoredSiteStub.returns(true);
      mockSite.getBaseURL.returns('invalid-site-url');
      requestContext.data = {
        pages: [{ key: 'row-invalid-base', pageUrl: 'https://example.com/us/en/page1', suggestionType: 'Missing Title' }],
      };
      resolvePageIdsStub.resolves([{ url: 'https://example.com/us/en/page1', pageId: 'pg-1' }]);
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

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['https://example.com/us/en/page1']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('row-invalid-base');
      expect(body.relationships).to.have.property('row-invalid-base');
      expect(body.relationships['row-invalid-base'].pagePath).to.equal('https://example.com/us/en/page1');
      expect(body.relationships['row-invalid-base'].pageId).to.equal('pg-1');
    });

    it('falls back to root path when normalized absolute URL has empty pathname', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [{ key: 'row-root', pageUrl: 'https://example.com', suggestionType: 'Missing Title' }],
      };
      sandbox.replace(globalThis, 'URL', class URLMock {
        constructor(value) {
          this.host = 'example.com';
          this.pathname = value === 'https://example.com' ? '' : '/';
        }
      });
      resolvePageIdsStub.resolves([{ url: '/', pageId: 'pg-root' }]);
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

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(resolvePageIdsStub.firstCall.args[2]).to.deep.equal(['/']);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('row-root');
      expect(body.relationships).to.have.property('row-root');
      expect(body.relationships['row-root'].pagePath).to.equal('/');
      expect(body.relationships['row-root'].pageId).to.equal('pg-root');
    });

    it('includes checkPath when buildCheckPath returns non-empty value', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns('/properties/jcr:title');
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({ results: {}, errors: {} });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      await response.json();

      expect(fetchRelationshipsStub.firstCall.args[1][0].checkPath).to.equal('/properties/jcr:title');
    });

    it('does not include checkPath when buildCheckPath returns empty string', async () => {
      isAEMAuthoredSiteStub.returns(true);
      buildCheckPathStub.returns('');
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({ results: {}, errors: {} });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      await response.json();

      expect(fetchRelationshipsStub.firstCall.args[1][0]).to.not.have.property('checkPath');
    });

    it('merges resolve and relationship API errors', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [
          { key: 'row-1', pageUrl: '/us/en/page1' },
          { key: 'row-2', pageUrl: '/us/en/page2' },
        ],
      };
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', pageId: 'pg-1' },
        { url: '/us/en/page2', error: 'HTTP 404' },
      ]);
      fetchRelationshipsStub.resolves({
        results: {
          'row-1': { pageId: 'pg-1', upstream: { chain: [] } },
        },
        errors: {
          'row-1': { error: 'NOT_FOUND' },
        },
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.errors).to.have.property('row-2');
      expect(body.errors['row-2'].error).to.equal('HTTP 404');
      expect(body.errors['row-1'].error).to.equal('NOT_FOUND');
    });

    it('returns default resolve error when resolver returns no error and no pageId', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([{ url: '/us/en/page1' }]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors['row-1'].error).to.equal('Could not resolve page');
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('uses fallback resolve item when resolver returns fewer entries than requested pages', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [
          { key: 'row-1', pageUrl: '/us/en/page1', suggestionType: 'Missing Title' },
          { key: 'row-2', pageUrl: '/us/en/page2', suggestionType: 'Missing Title' },
        ],
      };
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.resolves({
        results: {
          'row-1': { pageId: 'pg-1', upstream: { chain: [] } },
        },
        errors: {},
      });
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships).to.have.property('row-1');
      expect(body.errors).to.have.property('row-2');
      expect(body.errors['row-2'].error).to.equal('Could not resolve page');
    });

    it('skips fetchRelationships when all pages fail to resolve', async () => {
      isAEMAuthoredSiteStub.returns(true);
      resolvePageIdsStub.resolves([
        { url: '/us/en/page1', error: 'No content-page-id or content-page-ref' },
      ]);
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body.relationships).to.deep.equal({});
      expect(body.errors['row-1'].error).to.equal('No content-page-id or content-page-ref');
      expect(fetchRelationshipsStub).to.not.have.been.called;
    });

    it('uses caller key when suggestionType is not provided', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: [{ key: 'row-empty-type', pageUrl: '/us/en/page1' }],
      };
      resolvePageIdsStub.resolves([{ url: '/us/en/page1', pageId: 'pg-1' }]);
      fetchRelationshipsStub.callsFake(async (authorURL, items) => ({
        results: {
          [items[0].key]: { pageId: 'pg-1', upstream: { chain: [] } },
        },
        errors: {},
      }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(fetchRelationshipsStub.firstCall.args[1][0].key).to.equal('row-empty-type');
      expect(body.relationships).to.have.property('row-empty-type');
      expect(body.relationships['row-empty-type'].pagePath).to.equal('/us/en/page1');
      expect(body.relationships['row-empty-type'].pageId).to.equal('pg-1');
    });

    it('batches requests in chunks of 50 for more than 50 pages', async () => {
      isAEMAuthoredSiteStub.returns(true);
      requestContext.data = {
        pages: Array.from({ length: 120 }, (_, i) => ({
          key: `row-${i}`,
          pageUrl: `/us/en/page-${i}`,
          suggestionType: 'Missing Title',
        })),
      };
      resolvePageIdsStub.callsFake(async (baseURL, authorURL, pageUrls) => (
        pageUrls.map((pageUrl) => ({ url: pageUrl, pageId: `pg-${pageUrl}` }))
      ));
      fetchRelationshipsStub.callsFake(async (authorURL, items) => ({
        results: Object.fromEntries(
          items.map((item) => [item.key, { pageId: item.pageId, upstream: { chain: [] } }]),
        ),
        errors: {},
      }));
      const controller = PageRelationshipsController(controllerContext);

      const response = await controller.search(requestContext);
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
      expect(body.relationships).to.have.property('row-0');
      expect(body.relationships['row-0'].pagePath).to.equal('/us/en/page-0');
      expect(body.relationships['row-0'].pageId).to.equal('pg-/us/en/page-0');
      expect(body.errors).to.deep.equal({});
    });
  });
});
