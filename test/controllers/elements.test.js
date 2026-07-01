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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND_ID = '11111111-2222-3333-4444-555555555555';
const WORKSPACE_ID = 'ws-uuid-123';
const IMS_TOKEN = 'test-ims-token';
const ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://www.semrush.com' };

const BRANDS_RESULT = [{ id: null, label: 'Adobe', spacecat_brand_id: 'brand-1' }];
const MARKETS_RESULT = [{ id: 'US', label: 'US-en', semrush_project_id: 'proj-1' }];
const TOPICS_RESULT = [{ value: 'topic:SEO', type: 'topic', name: 'SEO' }];
const URL_INSPECTOR_RESULT = {
  brands: BRANDS_RESULT,
  regions: MARKETS_RESULT,
  topics: [],
  categories: [],
  page_intents: [],
  origins: [],
};

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  };
}

function makeBrandSemrushProject(overrides = {}) {
  return {
    getBrandId: () => BRAND_ID,
    getSemrushProjectId: () => 'proj-1',
    getGeoTargetId: () => 2840,
    getLanguageCode: () => 'en',
    ...overrides,
  };
}

function fakeContext({
  bearer = IMS_TOKEN,
  authType = 'ims',
  params = {},
  url = `https://api.example.com/v2/orgs/${ORG_ID}/serenity/brands`,
  org = { getId: () => ORG_ID },
  brand = { id: BRAND_ID, name: 'Adobe' },
  spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }],
  brandSemrushProjects = [],
  withBrandSemrushProject = false,
} = {}) {
  const BrandSemrushProject = withBrandSemrushProject
    ? { allByBrandId: sinon.stub().resolves(brandSemrushProjects) }
    : undefined;
  return {
    params: { spaceCatId: ORG_ID, brandId: BRAND_ID, ...params },
    request: { url },
    pathInfo: {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    },
    attributes: {
      authInfo: { getType: () => authType },
    },
    dataAccess: {
      Organization: { findById: sinon.stub().resolves(org) },
      services: { postgrestClient: {} },
      ...(BrandSemrushProject && { BrandSemrushProject }),
    },
    _spacecatBrands: spacecatBrands,
    _brand: brand,
  };
}

async function readBody(response) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}

describe('ElementsController', () => {
  let listSpacecatBrandsStub;
  let getBrandByIdStub;
  let resolveWorkspaceIdStub;
  let accessControlHasAccessStub;
  let serviceStub;
  let createElementsServiceStub;
  let createElementsTransportStub;
  let MockElementsTransportError;
  let ElementsController;

  beforeEach(async () => {
    resolveWorkspaceIdStub = sinon.stub().resolves(WORKSPACE_ID);
    accessControlHasAccessStub = sinon.stub().resolves(true);

    listSpacecatBrandsStub = sinon.stub().resolves([{ id: 'brand-1', name: 'Adobe' }]);
    getBrandByIdStub = sinon.stub().resolves({ id: BRAND_ID, name: 'Adobe' });

    serviceStub = {
      getBrands: sinon.stub().resolves(BRANDS_RESULT),
      getMarkets: sinon.stub().resolves(MARKETS_RESULT),
      getTopics: sinon.stub().resolves(TOPICS_RESULT),
      getUrlInspectorFilterDimensions: sinon.stub().resolves(URL_INSPECTOR_RESULT),
    };
    createElementsServiceStub = sinon.stub().returns(serviceStub);
    createElementsTransportStub = sinon.stub().returns({ fetchElement: sinon.stub() });

    MockElementsTransportError = class ElementsTransportError extends Error {
      constructor(status, message, body) {
        super(message);
        this.name = 'ElementsTransportError';
        this.status = status;
        this.body = body;
      }
    };

    const MockAccessControlUtil = {
      default: {
        fromContext: () => ({ hasAccess: accessControlHasAccessStub }),
      },
    };

    ElementsController = (await esmock('../../src/controllers/elements.js', {
      '../../src/support/elements/elements-transport.js': {
        createElementsTransport: createElementsTransportStub,
      },
      '../../src/support/elements/elements-service.js': {
        createElementsService: createElementsServiceStub,
      },
      '../../src/support/elements/errors.js': {
        ElementsTransportError: MockElementsTransportError,
      },
      '../../src/support/brands-storage.js': {
        listBrands: listSpacecatBrandsStub,
        getBrandById: getBrandByIdStub,
      },
      '../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: resolveWorkspaceIdStub,
      },
      '../../src/support/access-control-util.js': MockAccessControlUtil,
    })).default;
  });

  afterEach(() => sinon.restore());

  // ─── constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws when context is missing', () => {
      expect(() => ElementsController(null, fakeLog(), ENV)).to.throw('Context required');
    });

    it('throws when context is empty', () => {
      expect(() => ElementsController({}, fakeLog(), ENV)).to.throw('Context required');
    });

    it('throws when log is missing', () => {
      expect(() => ElementsController({ env: {} }, null, ENV)).to.throw('Log required');
    });

    it('returns a controller object with the expected methods', () => {
      const ctrl = ElementsController(fakeContext(), fakeLog(), ENV);
      expect(ctrl).to.include.keys(
        'listBrands',
        'listMarkets',
        'listAllMarkets',
        'listTags',
        'listBrandTags',
        'listUrlInspectorFilterDimensions',
      );
    });
  });

  // ─── shared auth/org guards ───────────────────────────────────────────────

  describe('auth and org guards (shared across all handlers)', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const ctrl = ElementsController(fakeContext({ bearer: null }), fakeLog(), ENV);
      const res = await ctrl.listBrands(fakeContext({ bearer: null }));
      expect(res.status).to.equal(401);
    });

    it('returns 401 when caller did not authenticate via IMS', async () => {
      const ctx = fakeContext({ authType: 'jwt' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(401);
    });

    it('returns 500 when Organization data-access is not available', async () => {
      const ctx = fakeContext();
      delete ctx.dataAccess.Organization;
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(500);
    });

    it('returns 404 when the organization is not found', async () => {
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById.resolves(null);
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 403 when access control denies access', async () => {
      accessControlHasAccessStub.resolves(false);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 404 when the org has no workspace ID', async () => {
      resolveWorkspaceIdStub.resolves(null);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(404);
    });
  });

  // ─── mapError ─────────────────────────────────────────────────────────────

  describe('error mapping', () => {
    it('maps ElementsTransportError 401 to 401 with authenticationRequired token', async () => {
      serviceStub.getBrands.rejects(new MockElementsTransportError(401, 'upstream auth failed'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(401);
      const body = await readBody(res);
      expect(body.error).to.equal('authenticationRequired');
    });

    it('maps ElementsTransportError 403 to 403 with forbidden token', async () => {
      serviceStub.getBrands.rejects(new MockElementsTransportError(403, 'forbidden'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(403);
    });

    it('maps other ElementsTransportError statuses to 502', async () => {
      serviceStub.getBrands.rejects(new MockElementsTransportError(503, 'bad gateway'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(502);
      const body = await readBody(res);
      expect(body.error).to.equal('elementsUpstreamError');
    });

    it('maps unknown errors to 500', async () => {
      serviceStub.getBrands.rejects(new Error('unexpected'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(500);
      const body = await readBody(res);
      expect(body.error).to.equal('internalServerError');
    });

    it('logs ElementsTransportError via log.error', async () => {
      serviceStub.getBrands.rejects(new MockElementsTransportError(500, 'upstream'));
      const log = fakeLog();
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, log, ENV);
      await ctrl.listBrands(ctx);
      expect(log.error).to.have.been.called;
    });

    it('maps ErrorWithStatusCode with a code property to that code token', async () => {
      const { ErrorWithStatusCode } = await import('../../src/support/utils.js');
      const err = new ErrorWithStatusCode('config error', 503);
      err.code = 'configurationError';
      serviceStub.getBrands.rejects(err);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
    });
  });

  // ─── listBrands ───────────────────────────────────────────────────────────

  describe('listBrands', () => {
    it('returns 200 with brand filter dimensions', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrands(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(BRANDS_RESULT);
    });

    it('calls getBrands with the workspace ID', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listBrands(ctx);
      expect(serviceStub.getBrands).to.have.been.calledWith(
        WORKSPACE_ID,
        sinon.match.object,
        sinon.match.array,
      );
    });

    it('passes SpaceCat brands to getBrands', async () => {
      const spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }];
      listSpacecatBrandsStub.resolves(spacecatBrands);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listBrands(ctx);
      const [, , brands] = serviceStub.getBrands.firstCall.args;
      expect(brands).to.deep.equal(spacecatBrands);
    });

    it('passes query params from the request URL to getBrands', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/serenity/brands?model=perplexity`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listBrands(ctx);
      const [, params] = serviceStub.getBrands.firstCall.args;
      expect(params.model).to.equal('perplexity');
    });

    it('builds transport with the bearer token from Authorization header', async () => {
      const ctx = fakeContext({ bearer: 'my-ims-token' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listBrands(ctx);
      expect(createElementsTransportStub).to.have.been.calledWith(
        sinon.match({ imsToken: 'my-ims-token' }),
      );
    });
  });

  // ─── listMarkets ──────────────────────────────────────────────────────────

  describe('listMarkets', () => {
    it('returns 200 with market filter dimensions', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listMarkets(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(MARKETS_RESULT);
    });

    it('returns 404 when brand is not found', async () => {
      getBrandByIdStub.resolves(null);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listMarkets(ctx);
      expect(res.status).to.equal(404);
    });

    it('calls getMarkets with brand name as filter', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listMarkets(ctx);
      const [, params] = serviceStub.getMarkets.firstCall.args;
      expect(params.brand).to.equal('Adobe');
    });

    it('passes brandSemrushProjects to getMarkets when available', async () => {
      const project = makeBrandSemrushProject();
      const ctx = fakeContext({ withBrandSemrushProject: true, brandSemrushProjects: [project] });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listMarkets(ctx);
      const [, , projects] = serviceStub.getMarkets.firstCall.args;
      expect(projects).to.have.length(1);
      expect(projects[0].semrushProjectId).to.equal('proj-1');
      expect(projects[0].brandId).to.equal(BRAND_ID);
      expect(projects[0].geoTargetId).to.equal(2840);
      expect(projects[0].languageCode).to.equal('en');
    });

    it('passes empty array for brandSemrushProjects when BrandSemrushProject is unavailable', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listMarkets(ctx);
      const [, , projects] = serviceStub.getMarkets.firstCall.args;
      expect(projects).to.deep.equal([]);
    });
  });

  // ─── listAllMarkets ───────────────────────────────────────────────────────

  describe('listAllMarkets', () => {
    it('returns 200 with all markets', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listAllMarkets(ctx);
      expect(res.status).to.equal(200);
    });

    it('calls getMarkets with empty params (no brand filter)', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listAllMarkets(ctx);
      const [, params] = serviceStub.getMarkets.firstCall.args;
      expect(params).to.deep.equal({});
    });

    it('aggregates BrandSemrushProjects across all SpaceCat brands', async () => {
      const spacecatBrands = [
        { id: 'brand-1', name: 'Adobe' },
        { id: 'brand-2', name: 'Nike' },
      ];
      listSpacecatBrandsStub.resolves(spacecatBrands);
      const project1 = makeBrandSemrushProject({ getBrandId: () => 'brand-1' });
      const project2 = makeBrandSemrushProject({ getBrandId: () => 'brand-2', getSemrushProjectId: () => 'proj-2' });
      const BrandSemrushProject = {
        allByBrandId: sinon.stub()
          .onFirstCall()
          .resolves([project1])
          .onSecondCall()
          .resolves([project2]),
      };
      const ctx = fakeContext();
      ctx.dataAccess.BrandSemrushProject = BrandSemrushProject;
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listAllMarkets(ctx);
      const [, , projects] = serviceStub.getMarkets.firstCall.args;
      expect(projects).to.have.length(2);
    });

    it('passes empty array when BrandSemrushProject is unavailable', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listAllMarkets(ctx);
      const [, , projects] = serviceStub.getMarkets.firstCall.args;
      expect(projects).to.deep.equal([]);
    });
  });

  // ─── listTags ─────────────────────────────────────────────────────────────

  describe('listTags', () => {
    it('returns 200 with topic results', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listTags(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(TOPICS_RESULT);
    });

    it('calls getTopics with the workspace ID', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listTags(ctx);
      expect(serviceStub.getTopics).to.have.been.calledWith(WORKSPACE_ID, sinon.match.object);
    });

    it('passes query params from the request URL', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/serenity/tags?model=gpt-5`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listTags(ctx);
      const [, params] = serviceStub.getTopics.firstCall.args;
      expect(params.model).to.equal('gpt-5');
    });
  });

  // ─── listBrandTags ────────────────────────────────────────────────────────

  describe('listBrandTags', () => {
    it('returns 200 with topics when no semrush projects exist', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrandTags(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(TOPICS_RESULT);
    });

    it('returns 404 when brand is not found', async () => {
      getBrandByIdStub.resolves(null);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrandTags(ctx);
      expect(res.status).to.equal(404);
    });

    it('calls getTopics once without projectId when no semrush projects', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listBrandTags(ctx);
      expect(serviceStub.getTopics).to.have.been.calledOnce;
      const [, params] = serviceStub.getTopics.firstCall.args;
      expect(params).to.not.have.property('projectId');
    });

    it('calls getTopics once per project and deduplicates results', async () => {
      const topicsProject1 = [
        { value: 'topic:SEO', type: 'topic', name: 'SEO' },
        { value: 'topic:AI', type: 'topic', name: 'AI' },
      ];
      const topicsProject2 = [
        { value: 'topic:SEO', type: 'topic', name: 'SEO' },
        { value: 'topic:Ecommerce', type: 'topic', name: 'Ecommerce' },
      ];
      serviceStub.getTopics
        .onFirstCall().resolves(topicsProject1)
        .onSecondCall().resolves(topicsProject2);
      const project1 = makeBrandSemrushProject({ getSemrushProjectId: () => 'proj-1' });
      const project2 = makeBrandSemrushProject({ getSemrushProjectId: () => 'proj-2' });
      const ctx = fakeContext({
        withBrandSemrushProject: true,
        brandSemrushProjects: [project1, project2],
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listBrandTags(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      // 'topic:SEO' appears in both — deduplicated to 3 unique values
      expect(body).to.have.length(3);
      const values = body.map((t) => t.value);
      expect(values).to.include('topic:SEO');
      expect(values).to.include('topic:AI');
      expect(values).to.include('topic:Ecommerce');
    });

    it('calls getTopics with projectId for each semrush project', async () => {
      const project1 = makeBrandSemrushProject({ getSemrushProjectId: () => 'proj-1' });
      const ctx = fakeContext({
        withBrandSemrushProject: true,
        brandSemrushProjects: [project1],
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listBrandTags(ctx);
      expect(serviceStub.getTopics).to.have.been.calledOnce;
      const [, params] = serviceStub.getTopics.firstCall.args;
      expect(params.projectId).to.equal('proj-1');
    });
  });

  // ─── listUrlInspectorFilterDimensions ─────────────────────────────────────

  describe('listUrlInspectorFilterDimensions', () => {
    it('returns 200 with filter dimensions object', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(URL_INSPECTOR_RESULT);
    });

    it('calls getUrlInspectorFilterDimensions with the workspace ID', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(serviceStub.getUrlInspectorFilterDimensions).to.have.been.calledWith(
        WORKSPACE_ID,
        sinon.match.object,
        sinon.match.array,
        sinon.match.array,
      );
    });

    it('passes SpaceCat brands to the service', async () => {
      const spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }];
      listSpacecatBrandsStub.resolves(spacecatBrands);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, , brands] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(brands).to.deep.equal(spacecatBrands);
    });

    it('passes aggregated brandSemrushProjects across all brands', async () => {
      const spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }];
      listSpacecatBrandsStub.resolves(spacecatBrands);
      const project = makeBrandSemrushProject();
      const ctx = fakeContext({ withBrandSemrushProject: true, brandSemrushProjects: [project] });
      ctx.dataAccess.BrandSemrushProject = { allByBrandId: sinon.stub().resolves([project]) };
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, , , projects] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(projects).to.have.length(1);
      expect(projects[0].semrushProjectId).to.equal('proj-1');
    });

    it('passes empty array for brandSemrushProjects when BrandSemrushProject is unavailable', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, , , projects] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(projects).to.deep.equal([]);
    });

    it('passes query params from the request URL', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/serenity/all/brand-presence/url-inspector/filter-dimensions?model=perplexity`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params.model).to.equal('perplexity');
    });
  });

  // ─── extractQuery edge cases ──────────────────────────────────────────────

  describe('extractQuery (via listTags)', () => {
    it('returns empty params when request URL is missing', async () => {
      const ctx = fakeContext({ url: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listTags(ctx);
      const [, params] = serviceStub.getTopics.firstCall.args;
      expect(params).to.deep.equal({});
    });

    it('returns empty params when request URL is invalid', async () => {
      const ctx = fakeContext({ url: 'not-a-url' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listTags(ctx);
      const [, params] = serviceStub.getTopics.firstCall.args;
      expect(params).to.deep.equal({});
    });

    it('captures multiple query params', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/serenity/tags?model=gpt-5&projectId=proj-1`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listTags(ctx);
      const [, params] = serviceStub.getTopics.firstCall.args;
      expect(params.model).to.equal('gpt-5');
      expect(params.projectId).to.equal('proj-1');
    });
  });
});
