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
  url = `https://api.example.com/v2/orgs/${ORG_ID}/serenity/all/brand-presence/url-inspector/filter-dimensions`,
  org = { getId: () => ORG_ID },
  spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }],
  brandSemrushProjects = [],
  withBrandSemrushProject = false,
} = {}) {
  const BrandSemrushProject = withBrandSemrushProject
    ? { allByBrandId: sinon.stub().resolves(brandSemrushProjects) }
    : undefined;
  return {
    params: { spaceCatId: ORG_ID, ...params },
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
  let resolveBrandWorkspaceStub;
  let accessControlHasAccessStub;
  let serviceStub;
  let createElementsServiceStub;
  let createElementsTransportStub;
  let MockElementsTransportError;
  let ElementsController;

  beforeEach(async () => {
    resolveWorkspaceIdStub = sinon.stub().resolves(WORKSPACE_ID);
    resolveBrandWorkspaceStub = sinon.stub().resolves({ mode: 'subworkspace', workspaceId: 'sub-ws-uuid-456' });
    accessControlHasAccessStub = sinon.stub().resolves(true);

    listSpacecatBrandsStub = sinon.stub().resolves([{ id: 'brand-1', name: 'Adobe' }]);
    getBrandByIdStub = sinon.stub().resolves({ id: BRAND_ID, name: 'Adobe Brand' });

    serviceStub = {
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
        resolveBrandWorkspace: resolveBrandWorkspaceStub,
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
      expect(ctrl).to.include.keys('listUrlInspectorFilterDimensions');
    });
  });

  // ─── shared auth/org guards ───────────────────────────────────────────────

  describe('auth and org guards', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const ctx = fakeContext({ bearer: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(401);
    });

    it('returns 401 when caller did not authenticate via IMS', async () => {
      const ctx = fakeContext({ authType: 'jwt' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(401);
    });

    it('returns 500 when Organization data-access is not available', async () => {
      const ctx = fakeContext();
      delete ctx.dataAccess.Organization;
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(500);
    });

    it('returns 404 when the organization is not found', async () => {
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById.resolves(null);
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 403 when access control denies access', async () => {
      accessControlHasAccessStub.resolves(false);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 404 when the org has no workspace ID', async () => {
      resolveWorkspaceIdStub.resolves(null);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });
  });

  // ─── mapError ─────────────────────────────────────────────────────────────

  describe('error mapping', () => {
    it('maps ElementsTransportError 401 to 401 with authenticationRequired token', async () => {
      serviceStub.getUrlInspectorFilterDimensions
        .rejects(new MockElementsTransportError(401, 'upstream auth failed'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(401);
      const body = await readBody(res);
      expect(body.error).to.equal('authenticationRequired');
    });

    it('maps ElementsTransportError 403 to 403 with forbidden token', async () => {
      serviceStub.getUrlInspectorFilterDimensions
        .rejects(new MockElementsTransportError(403, 'forbidden'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(403);
    });

    it('maps other ElementsTransportError statuses to 502', async () => {
      serviceStub.getUrlInspectorFilterDimensions
        .rejects(new MockElementsTransportError(503, 'bad gateway'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(502);
      const body = await readBody(res);
      expect(body.error).to.equal('elementsUpstreamError');
    });

    it('maps a 504 timeout ElementsTransportError to 502', async () => {
      serviceStub.getUrlInspectorFilterDimensions
        .rejects(new MockElementsTransportError(504, 'timed out'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(502);
      const body = await readBody(res);
      expect(body.error).to.equal('elementsUpstreamError');
    });

    it('maps unknown errors to 500', async () => {
      serviceStub.getUrlInspectorFilterDimensions.rejects(new Error('unexpected'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(500);
      const body = await readBody(res);
      expect(body.error).to.equal('internalServerError');
    });

    it('logs ElementsTransportError via log.error', async () => {
      serviceStub.getUrlInspectorFilterDimensions
        .rejects(new MockElementsTransportError(500, 'upstream'));
      const log = fakeLog();
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, log, ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(log.error).to.have.been.called;
    });

    it('maps ErrorWithStatusCode with a code property to that code token', async () => {
      const { ErrorWithStatusCode } = await import('../../src/support/utils.js');
      const err = new ErrorWithStatusCode('config error', 503);
      err.code = 'configurationError';
      serviceStub.getUrlInspectorFilterDimensions.rejects(err);
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
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

    it('builds transport with the bearer token from Authorization header', async () => {
      const ctx = fakeContext({ bearer: 'my-ims-token' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(createElementsTransportStub).to.have.been.calledWith(
        sinon.match({ imsToken: 'my-ims-token' }),
      );
    });

    it('returns auth error when org is not found', async () => {
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById.resolves(null);
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });

    it('propagates service errors through mapError', async () => {
      serviceStub.getUrlInspectorFilterDimensions
        .rejects(new MockElementsTransportError(503, 'upstream down'));
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(502);
    });
  });

  // ─── brand-scoped (:brandId) ──────────────────────────────────────────────

  describe('listUrlInspectorFilterDimensions (brand-scoped)', () => {
    it('returns 400 when brandId is not a valid UUID', async () => {
      const ctx = fakeContext({ params: { brandId: 'not-a-uuid' } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 403 when the brand does not belong to the org', async () => {
      getBrandByIdStub.resolves(null);
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(403);
    });

    it('returns 404 when the brand has no resolvable workspace', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null });
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });

    it('calls the service with the brand sub-workspace ID and scopes to that single brand', async () => {
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      expect(resolveBrandWorkspaceStub).to.have.been.calledWith(ctx, ORG_ID, BRAND_ID);
      expect(listSpacecatBrandsStub).to.not.have.been.called;
      const [workspaceId, , brands] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(workspaceId).to.equal('sub-ws-uuid-456');
      expect(brands).to.deep.equal([{ id: BRAND_ID, name: 'Adobe Brand' }]);
    });

    it('falls back to the org parent workspace when the brand has no sub-workspace yet', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: WORKSPACE_ID });
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [workspaceId] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(workspaceId).to.equal(WORKSPACE_ID);
    });
  });

  // ─── extractQuery edge cases ──────────────────────────────────────────────

  describe('extractQuery', () => {
    it('returns empty params when request URL is missing', async () => {
      const ctx = fakeContext({ url: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params).to.deep.equal({});
    });

    it('returns empty params when request URL is invalid', async () => {
      const ctx = fakeContext({ url: 'not-a-url' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params).to.deep.equal({});
    });

    it('captures multiple query params', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/serenity/all/brand-presence/url-inspector/filter-dimensions?model=gpt-5&foo=bar`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params.model).to.equal('gpt-5');
      expect(params.foo).to.equal('bar');
    });
  });
});
