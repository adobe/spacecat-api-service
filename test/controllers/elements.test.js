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
import { ErrorWithStatusCode } from '../../src/support/utils.js';
import { parseShowTrends, parseUserIntent } from '../../src/controllers/elements.js';
import { addDaysToDate } from '../../src/support/elements/week-utils.js';
// Real error class (not a mock) so the controller's `instanceof SerenityTransportError`
// check in checkAccess matches errors thrown by these tests — and so this file keeps a
// single mock class (max-classes-per-file).
import { SerenityTransportError } from '../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND_ID = '11111111-2222-3333-4444-555555555555';
const WORKSPACE_ID = 'ws-uuid-123';
const SUB_WORKSPACE_ID = 'sub-ws-uuid-456';
// projectId is UUID-validated (see extractProjectIds), so query-string fixtures
// for that param must be real UUIDs, not the free-form `proj-*` placeholders
// used for stubbed service-return values.
const PROJECT_ID_A = '66666666-1111-2222-3333-444444444444';
const PROJECT_ID_B = '77777777-5555-6666-7777-888888888888';
const IMS_TOKEN = 'test-ims-token';
const ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://www.semrush.com' };

const BRANDS_RESULT = [{ id: 'Adobe', label: 'Adobe', spacecat_brand_id: 'brand-1' }];
const MARKETS_RESULT = [{ id: 'US', label: 'US-en', semrush_project_id: 'proj-1' }];
const URL_INSPECTOR_RESULT = {
  brands: BRANDS_RESULT,
  regions: MARKETS_RESULT,
  topics: [],
  categories: [],
  page_intents: [],
  origins: [],
};
const PROMPTS_RESULT = {
  count: 1,
  prompts: [{
    prompt: 'can i make ai influencer for free',
    prompt_topic: 'AI Instagram Influencers',
    primary_intent: 'informational',
    volume: 2119,
  }],
};
const WEEKS_RESULT = {
  weeks: [{ week: '2026-W27', startDate: '2026-06-29', endDate: '2026-07-05' }],
};
const STATS_RESULT = {
  stats: {
    total_executions: 19528,
    total_mentions: 14635,
    average_visibility_score: 48.77,
    total_citations: 158903,
  },
};
const URL_INSPECTOR_STATS_RESULT = {
  stats: {
    uniqueUrls: 187, totalCitations: 964, totalPromptsCited: 312,
  },
  weeklyTrends: [
    {
      weekStart: '2026-06-25',
      weekEnd: '2026-07-01',
      uniqueUrls: 42,
      totalCitations: 155,
      totalPromptsCited: 48,
    },
  ],
};

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  };
}

// Faithful re-implementation of support/utils.js#resolveSemrushImsToken, wired to
// a controllable exchange stub. The controller now delegates the promise-token
// decode/exchange to that shared helper, so exercising it here (rather than
// stubbing the whole thing away) keeps this suite's fallback-path assertions
// (IMS-type gate, hint message) exercising the REAL `fallback` the controller
// passes in, while still allowing the promise-token exchange itself to be
// controlled per-test. The authoritative unit tests for the decode/error-wrap
// behavior itself live in test/support/utils.test.js.
function makeResolveSemrushImsTokenStub(exchangeStub) {
  return async (ctx, log, logLabel, fallback) => {
    const promiseTokenHeader = ctx?.pathInfo?.headers?.['x-promise-token'];
    if (promiseTokenHeader) {
      let decoded = promiseTokenHeader;
      try {
        decoded = decodeURIComponent(promiseTokenHeader);
      } catch {
        // Bearer-style tokens may contain literal %; use as-is.
      }
      try {
        return await exchangeStub(ctx, decoded);
      } catch (e) {
        log.error(`${logLabel}: promise token exchange failed`, { error: e?.message });
        throw new ErrorWithStatusCode('Invalid or expired promise token', 401);
      }
    }
    return fallback(ctx);
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

// Builds BrandSemrushProject rows for the given ids, for tests asserting a
// caller-supplied projectId passes the brand-ownership check (see
// checkProjectIdsOwnership).
function brandSemrushProjectsFor(ids) {
  return ids.map((id) => makeBrandSemrushProject({ getSemrushProjectId: () => id }));
}

function fakeContext({
  bearer = IMS_TOKEN,
  authType = 'ims',
  params = {},
  url = `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions`,
  org = { getId: () => ORG_ID },
  spacecatBrands = [{ id: 'brand-1', name: 'Adobe' }],
  brandSemrushProjects = [],
  withBrandSemrushProject = false,
  promiseToken = undefined,
  postgrestClient = { from: sinon.stub() },
} = {}) {
  const BrandSemrushProject = withBrandSemrushProject
    ? { allByBrandId: sinon.stub().resolves(brandSemrushProjects) }
    : undefined;
  return {
    params: { spaceCatId: ORG_ID, brandId: BRAND_ID, ...params },
    request: { url },
    pathInfo: {
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(promiseToken ? { 'x-promise-token': promiseToken } : {}),
      },
    },
    attributes: {
      authInfo: { getType: () => authType },
    },
    dataAccess: {
      Organization: { findById: sinon.stub().resolves(org) },
      services: { postgrestClient },
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
  let getBrandIdentityStub;
  let getBrandBySiteStub;
  let resolveBrandWorkspaceStub;
  let accessControlHasAccessStub;
  let serviceStub;
  let createElementsServiceStub;
  let createElementsTransportStub;
  let exchangePromiseTokenStub;
  let resolveBrandUuidStub;
  let MockElementsTransportError;
  let getWorkspaceResourcesStub;
  let createSerenityTransportStub;
  let ElementsController;

  beforeEach(async () => {
    resolveBrandUuidStub = sinon.stub().resolves(BRAND_ID);
    resolveBrandWorkspaceStub = sinon.stub().resolves({
      mode: 'subworkspace', workspaceId: SUB_WORKSPACE_ID, parentWorkspaceId: WORKSPACE_ID,
    });
    accessControlHasAccessStub = sinon.stub().resolves(true);

    getBrandIdentityStub = sinon.stub().resolves({ id: BRAND_ID, name: 'Adobe Brand' });
    getBrandBySiteStub = sinon.stub().resolves(null);

    serviceStub = {
      getUrlInspectorFilterDimensions: sinon.stub().resolves(URL_INSPECTOR_RESULT),
      getPrompts: sinon.stub().resolves(PROMPTS_RESULT),
      getWeeks: sinon.stub().resolves(WEEKS_RESULT),
      getBrandPresenceStats: sinon.stub().resolves(STATS_RESULT),
      getUrlInspectorStats: sinon.stub().resolves(URL_INSPECTOR_STATS_RESULT),
      getDomainUrls: sinon.stub().resolves({ urls: [], totalCount: 0 }),
      getOwnedUrlProjects: sinon.stub().resolves([{ region: 'US', projectId: 'proj-1' }]),
    };
    createElementsServiceStub = sinon.stub().returns(serviceStub);
    createElementsTransportStub = sinon.stub().returns({ fetchElement: sinon.stub() });
    exchangePromiseTokenStub = sinon.stub().resolves('exchanged-ims-token');

    MockElementsTransportError = class ElementsTransportError extends Error {
      constructor(status, message, body) {
        super(message);
        this.name = 'ElementsTransportError';
        this.status = status;
        this.body = body;
      }
    };

    // Serenity (User Manager) transport used by checkAccess for the resource-allowance probe.
    getWorkspaceResourcesStub = sinon.stub().resolves({ product_resources: {} });
    createSerenityTransportStub = sinon.stub().returns({
      getWorkspaceResources: getWorkspaceResourcesStub,
    });

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
        getBrandIdentity: getBrandIdentityStub,
        getBrandBySite: getBrandBySiteStub,
      },
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: resolveBrandUuidStub,
      },
      '../../src/support/serenity/workspace-resolver.js': {
        resolveBrandWorkspace: resolveBrandWorkspaceStub,
      },
      '../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createSerenityTransportStub,
        SerenityTransportError,
      },
      '../../src/support/access-control-util.js': MockAccessControlUtil,
      '../../src/support/utils.js': {
        resolveSemrushImsToken: makeResolveSemrushImsTokenStub(
          (...args) => exchangePromiseTokenStub(...args),
        ),
      },
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

    it('returns 404 when the brand has no resolvable workspace', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null });
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });

    it('hints at the x-promise-token header when a non-IMS caller sends none', async () => {
      const ctx = fakeContext({ authType: 'jwt' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(401);
      const body = await readBody(res);
      expect(body.error).to.equal('promiseTokenRequired');
      expect(body.message).to.match(/x-promise-token/);
    });
  });

  // ─── x-promise-token support ──────────────────────────────────────────────

  describe('x-promise-token support', () => {
    it('exchanges x-promise-token for an IMS token and forwards it upstream, bypassing the IMS-type gate', async () => {
      const ctx = fakeContext({
        authType: 'jwt', bearer: 'spacecat-jwt-abc', promiseToken: 'promise-token-xyz',
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(ctx, 'promise-token-xyz');
      expect(createElementsTransportStub).to.have.been.calledWith(
        sinon.match({ imsToken: 'exchanged-ims-token' }),
      );
    });

    it('decodes a URI-encoded x-promise-token header before exchanging', async () => {
      const ctx = fakeContext({ promiseToken: 'promise%20token%20xyz' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(ctx, 'promise token xyz');
    });

    it('falls back to the raw header value when it is not valid percent-encoding', async () => {
      const ctx = fakeContext({ promiseToken: 'promise%zztoken' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(ctx, 'promise%zztoken');
    });

    it('401s with a generic message (no leaked exchange detail) when the promise token exchange fails', async () => {
      exchangePromiseTokenStub.rejects(new Error('upstream IMS exchange failed: secret detail'));
      const log = fakeLog();
      const ctx = fakeContext({
        authType: 'jwt', bearer: 'spacecat-jwt-abc', promiseToken: 'promise-token-xyz',
      });
      const ctrl = ElementsController(ctx, log, ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(401);
      const body = await readBody(res);
      expect(body.message).to.equal('Invalid or expired promise token');
      expect(log.error).to.have.been.calledWithMatch('elements: promise token exchange failed');
    });

    it('falls back to the Authorization bearer when x-promise-token is absent (existing behavior unchanged)', async () => {
      const ctx = fakeContext({ bearer: 'ims-token-123' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      expect(exchangePromiseTokenStub).to.not.have.been.called;
      expect(createElementsTransportStub).to.have.been.calledWith(
        sinon.match({ imsToken: 'ims-token-123' }),
      );
    });

    it('still 401s a non-IMS caller with no x-promise-token (existing IMS-type gate unaffected)', async () => {
      const ctx = fakeContext({ authType: 'jwt' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(401);
      expect(exchangePromiseTokenStub).to.not.have.been.called;
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
        SUB_WORKSPACE_ID,
        sinon.match.object,
        sinon.match.array,
        sinon.match.array,
      );
    });

    it('passes the resolved brand to the service', async () => {
      const ctx = fakeContext();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, , brands] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(brands).to.deep.equal([{ id: BRAND_ID, name: 'Adobe Brand' }]);
    });

    it('passes brandSemrushProjects for the resolved brand', async () => {
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
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?model=perplexity`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params.model).to.equal('perplexity');
    });

    it('splits a comma-separated projectId query param into projectIds', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?projectId=${PROJECT_ID_A},${PROJECT_ID_B}`,
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A, PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A, PROJECT_ID_B]);
      // The raw unsplit query value is still present alongside it (harmless —
      // buildTopicsPayload prefers projectIds when both are given).
      expect(params.projectId).to.equal(`${PROJECT_ID_A},${PROJECT_ID_B}`);
    });

    it('accepts the project_id snake_case alias', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?project_id=${PROJECT_ID_A}`,
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A]);
    });

    it('returns 403 when a caller-supplied projectId is not owned by this brand', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?projectId=${PROJECT_ID_A}`,
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(403);
      const body = await readBody(res);
      expect(body.message).to.match(new RegExp(PROJECT_ID_A));
      expect(serviceStub.getUrlInspectorFilterDimensions).to.not.have.been.called;
    });

    it('returns 400 when more than 8 comma-separated projectIds are given', async () => {
      const tooMany = Array.from({ length: 9 }, (_, i) => `${i}${PROJECT_ID_A.slice(1)}`).join(',');
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?projectId=${tooMany}`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/at most 8/);
    });

    it('returns 400 when a projectId is not a valid UUID', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?projectId=not-a-uuid`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/must be a comma-separated list of UUIDs/);
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

    it('returns 404 when the brand does not belong to the org', async () => {
      getBrandIdentityStub.resolves(null);
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });

    it('returns 503 (not a masked 404) when the PostgREST client is not available', async () => {
      const ctx = fakeContext({ params: { brandId: BRAND_ID }, postgrestClient: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
      expect(getBrandIdentityStub).to.not.have.been.called;
    });

    it('returns 404 when the brand has no resolvable workspace', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null });
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(404);
    });

    it('calls the service with the brand sub-workspace ID and scopes to that single brand', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'subworkspace', workspaceId: 'sub-ws-uuid-456' });
      const ctx = fakeContext({ params: { brandId: BRAND_ID } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listUrlInspectorFilterDimensions(ctx);
      expect(res.status).to.equal(200);
      expect(resolveBrandWorkspaceStub).to.have.been.calledWith(ctx, ORG_ID, BRAND_ID);
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

  // ─── listPrompts ──────────────────────────────────────────────────────────

  describe('listPrompts', () => {
    const promptsUrl = (qs = '') => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/prompts${qs}`;

    it('returns 200 with the { count, prompts } result', async () => {
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(PROMPTS_RESULT);
    });

    it('calls getPrompts with the brand SUB-workspace ID and parsed filters', async () => {
      const ctx = fakeContext({
        url: promptsUrl('?model=perplexity&tag=type__branded,category__Brand&projectId=proj-a,proj-b'),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listPrompts(ctx);
      expect(serviceStub.getPrompts).to.have.been.calledWith(SUB_WORKSPACE_ID, {
        model: 'perplexity',
        platform: undefined,
        tags: ['type__branded', 'category__Brand'],
        projectIds: ['proj-a', 'proj-b'],
        enrichUserIntent: false,
      });
    });

    it('passes enrichUserIntent: true to getPrompts when ?userIntent=true', async () => {
      const ctx = fakeContext({ url: promptsUrl('?projectId=proj-a&userIntent=true') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listPrompts(ctx);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.enrichUserIntent).to.equal(true);
    });

    it('resolves the brand uuid via resolveBrandUuid before querying', async () => {
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listPrompts(ctx);
      expect(resolveBrandUuidStub).to.have.been.calledWith(ORG_ID, BRAND_ID, sinon.match.object);
      expect(resolveBrandWorkspaceStub)
        .to.have.been.calledWith(sinon.match.object, ORG_ID, BRAND_ID);
    });

    it('defaults tags and projectIds to empty arrays when absent', async () => {
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listPrompts(ctx);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.tags).to.deep.equal([]);
      expect(params.projectIds).to.deep.equal([]);
    });

    it('accepts the project_id snake_case alias for projectId', async () => {
      const ctx = fakeContext({ url: promptsUrl('?project_id=proj-x') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listPrompts(ctx);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.projectIds).to.deep.equal(['proj-x']);
    });

    it('trims blank CSV entries', async () => {
      const ctx = fakeContext({ url: promptsUrl('?tag=type__branded,%20,category__Brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listPrompts(ctx);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.tags).to.deep.equal(['type__branded', 'category__Brand']);
    });

    // ── sub-workspace validation ──
    it('400s when brandId is not a UUID', async () => {
      const ctx = fakeContext({ url: promptsUrl(), params: { brandId: 'not-a-uuid' } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(400);
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('404s when the brand does not resolve for the org', async () => {
      resolveBrandUuidStub.resolves(null);
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(404);
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('503s when the PostgREST client is not available', async () => {
      const ctx = fakeContext({ url: promptsUrl(), postgrestClient: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('404s (subWorkspaceRequired) when the brand is in flat mode (no sub-workspace)', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'flat', workspaceId: WORKSPACE_ID, parentWorkspaceId: WORKSPACE_ID,
      });
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(404);
      const body = await readBody(res);
      expect(body.error).to.equal('subWorkspaceRequired');
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('409s when the brand sub-workspace equals the org parent workspace', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: WORKSPACE_ID, parentWorkspaceId: WORKSPACE_ID,
      });
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(409);
      const body = await readBody(res);
      expect(body.error).to.equal('workspaceMisconfigured');
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('403s when access control denies org access', async () => {
      accessControlHasAccessStub.resolves(false);
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(403);
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('exchanges x-promise-token and reaches getPrompts for a non-IMS caller', async () => {
      const ctx = fakeContext({
        authType: 'jwt',
        bearer: 'spacecat-jwt-abc',
        promiseToken: 'promise-token-xyz',
        url: promptsUrl(),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(200);
      expect(serviceStub.getPrompts).to.have.been.calledOnce;
      expect(createElementsTransportStub).to.have.been.calledWith(
        sinon.match({ imsToken: 'exchanged-ims-token' }),
      );
    });

    it('401s a non-IMS caller with no x-promise-token, without calling getPrompts', async () => {
      const ctx = fakeContext({ authType: 'jwt', url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(401);
      const body = await readBody(res);
      expect(body.error).to.equal('promiseTokenRequired');
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('propagates upstream errors through mapError', async () => {
      serviceStub.getPrompts.rejects(new MockElementsTransportError(503, 'upstream down'));
      const ctx = fakeContext({ url: promptsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listPrompts(ctx);
      expect(res.status).to.equal(502);
    });
  });

  // ─── listWeeks ────────────────────────────────────────────────────────────

  describe('listWeeks', () => {
    const weeksUrl = (qs = '') => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/weeks${qs}`;

    it('returns 200 with the weeks result', async () => {
      const ctx = fakeContext({ url: weeksUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(WEEKS_RESULT);
    });

    // Regression test for the missing-await bug: buildService(ctx) returns a
    // Promise, so `buildService(ctx).getWeeks(...)` (no await) called .getWeeks
    // on the Promise itself and threw `TypeError: ... is not a function` on
    // every real invocation. Asserting the resolved service's getWeeks stub was
    // actually invoked (and that a plain object result comes back) fails if
    // that bug regresses.
    it('awaits buildService before calling getWeeks on the resolved service', async () => {
      const ctx = fakeContext({ url: weeksUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(200);
      expect(serviceStub.getWeeks).to.have.been.calledOnce;
      expect(serviceStub.getWeeks.firstCall.args[0]).to.equal(SUB_WORKSPACE_ID);
    });

    it('calls getWeeks with the resolved workspace ID and query params, without a brand filter', async () => {
      const ctx = fakeContext({ url: weeksUrl('?model=perplexity') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listWeeks(ctx);
      expect(serviceStub.getWeeks).to.have.been.calledWith(SUB_WORKSPACE_ID, { model: 'perplexity' });
      const [, params] = serviceStub.getWeeks.firstCall.args;
      expect(params).to.not.have.property('brand');
    });

    it('returns 503 (not a masked 404) when the PostgREST client is not available', async () => {
      const ctx = fakeContext({ url: weeksUrl(), postgrestClient: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
      expect(serviceStub.getWeeks).to.not.have.been.called;
    });

    it('returns 400 when siteId does not resolve to any brand', async () => {
      getBrandBySiteStub.resolves(null);
      const ctx = fakeContext({ url: weeksUrl('?siteId=site-without-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(400);
      expect(serviceStub.getWeeks).to.not.have.been.called;
    });

    it('returns 400 when siteId resolves to a different brand than :brandId', async () => {
      getBrandBySiteStub.resolves({ id: 'some-other-brand-id', name: 'Other Brand' });
      const ctx = fakeContext({ url: weeksUrl('?siteId=site-of-other-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/siteId does not belong to the specified brand/);
      expect(serviceStub.getWeeks).to.not.have.been.called;
    });

    it('proceeds when siteId resolves to the same brand as :brandId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = fakeContext({ url: weeksUrl('?siteId=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(200);
      expect(serviceStub.getWeeks).to.have.been.calledOnce;
    });

    it('accepts the site_id snake_case alias for siteId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = fakeContext({ url: weeksUrl('?site_id=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(200);
      expect(getBrandBySiteStub).to.have.been.calledWith(ORG_ID, 'site-of-this-brand');
    });

    it('returns the auth error when brandId is not a valid UUID', async () => {
      const ctx = fakeContext({ url: weeksUrl(), params: { brandId: 'not-a-uuid' } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(400);
      expect(serviceStub.getWeeks).to.not.have.been.called;
    });

    it('propagates upstream errors through mapError', async () => {
      serviceStub.getWeeks.rejects(new MockElementsTransportError(503, 'upstream down'));
      const ctx = fakeContext({ url: weeksUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listWeeks(ctx);
      expect(res.status).to.equal(502);
    });
  });

  // ─── checkAccess ──────────────────────────────────────────────────────────

  describe('checkAccess', () => {
    const accessUrl = () => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/access`;

    it('returns 200 { hasAccess: true } when the resource-allowance probe succeeds', async () => {
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal({ hasAccess: true });
      expect(getWorkspaceResourcesStub).to.have.been.calledOnce;
    });

    it('forwards the resolved workspace id and the caller IMS token to the transport', async () => {
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.checkAccess(ctx);
      // Dual-mode resolution → the brand's sub-workspace (see resolveBrandWorkspaceStub).
      expect(getWorkspaceResourcesStub).to.have.been.calledWith(SUB_WORKSPACE_ID);
      const transportArgs = createSerenityTransportStub.firstCall.args[0];
      expect(transportArgs.env).to.equal(ENV);
      expect(transportArgs.imsToken).to.equal(IMS_TOKEN);
    });

    it('returns 200 { hasAccess: false } when upstream returns 401', async () => {
      getWorkspaceResourcesStub.rejects(new SerenityTransportError(401, 'unauthorized'));
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal({ hasAccess: false });
    });

    it('returns 200 { hasAccess: false } when upstream returns 403', async () => {
      getWorkspaceResourcesStub.rejects(new SerenityTransportError(403, 'forbidden'));
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal({ hasAccess: false });
    });

    it('returns 502 (indeterminate, not a denial) when the upstream fails with a 5xx', async () => {
      getWorkspaceResourcesStub.rejects(new SerenityTransportError(500, 'upstream down'));
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(502);
      const body = await readBody(res);
      expect(body.error).to.equal('serenityUpstreamError');
    });

    it('returns 502 when the upstream request times out (504)', async () => {
      getWorkspaceResourcesStub.rejects(new SerenityTransportError(504, 'timed out'));
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(502);
    });

    it('returns 403 (auth error) and never probes upstream when SpaceCat access is denied', async () => {
      accessControlHasAccessStub.resolves(false);
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(403);
      expect(getWorkspaceResourcesStub).to.not.have.been.called;
    });

    it('returns 404 when the brand has no resolvable workspace', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null });
      const ctx = fakeContext({ url: accessUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(404);
      expect(getWorkspaceResourcesStub).to.not.have.been.called;
    });

    it('returns 401 and never probes upstream when the caller is not authenticated', async () => {
      const ctx = fakeContext({ url: accessUrl(), bearer: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.checkAccess(ctx);
      expect(res.status).to.equal(401);
      expect(getWorkspaceResourcesStub).to.not.have.been.called;
    });
  });

  // ─── getStats ─────────────────────────────────────────────────────────────

  describe('getStats', () => {
    const statsUrl = (qs = '') => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/stats${qs}`;

    // Most aggregate-view (no projectId) assertions need the brand to own at
    // least one Semrush project, or getStats 404s (see the dedicated empty-
    // projects test below) before ever reaching the service call.
    const statsCtx = (overrides = {}) => {
      const project = makeBrandSemrushProject({ getSemrushProjectId: () => 'proj-1' });
      return fakeContext({
        url: statsUrl(),
        withBrandSemrushProject: true,
        brandSemrushProjects: [project],
        ...overrides,
      });
    };

    it('returns 200 with the service result by default (aggregate view, no trends)', async () => {
      const ctx = statsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(STATS_RESULT);
      const [workspaceId, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(workspaceId).to.equal(SUB_WORKSPACE_ID);
      expect(params.brandName).to.equal('Adobe Brand');
      expect(params.projectId).to.equal(undefined);
      expect(params.projectIds).to.deep.equal(['proj-1']);
      expect(params.showTrends).to.equal(false);
      expect(params.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(params.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns 404 when the brand has no configured Semrush projects (empty aggregate view)', async () => {
      const ctx = fakeContext({ url: statsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(404);
      const body = await readBody(res);
      expect(body.message).to.match(/No Semrush projects configured for brand/);
      expect(serviceStub.getBrandPresenceStats).to.not.have.been.called;
    });

    it('passes showTrends=true through to the service', async () => {
      const ctx = statsCtx({ url: statsUrl('?showTrends=true') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.showTrends).to.equal(true);
    });

    it('passes showTrends=true through when show_trends=1 (snake_case alias)', async () => {
      const ctx = statsCtx({ url: statsUrl('?show_trends=1') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.getStats(ctx);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.showTrends).to.equal(true);
    });

    it('passes showTrends=false through when showTrends=false', async () => {
      const ctx = statsCtx({ url: statsUrl('?showTrends=false') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.getStats(ctx);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.showTrends).to.equal(false);
    });

    it('passes explicit startDate/endDate/model/platform through to the service', async () => {
      const ctx = statsCtx({
        url: statsUrl('?startDate=2026-07-01&endDate=2026-07-14&model=search-gpt&platform=chatgpt'),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.startDate).to.equal('2026-07-01');
      expect(params.endDate).to.equal('2026-07-14');
      expect(params.model).to.equal('search-gpt');
      expect(params.platform).to.equal('chatgpt');
    });

    it('returns 400 for a malformed startDate', async () => {
      const ctx = fakeContext({ url: statsUrl('?startDate=not-a-date&endDate=2026-07-14') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 for a malformed endDate', async () => {
      const ctx = fakeContext({ url: statsUrl('?startDate=2026-07-01&endDate=not-a-date') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when startDate is after endDate', async () => {
      const ctx = fakeContext({ url: statsUrl('?startDate=2026-07-14&endDate=2026-07-01') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when the explicit date range exceeds 56 days (8 weeks)', async () => {
      const ctx = statsCtx({ url: statsUrl('?startDate=2026-01-01&endDate=2026-12-31') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/Date range must not exceed 56 days/);
      expect(serviceStub.getBrandPresenceStats).to.not.have.been.called;
    });

    it('allows an explicit date range of exactly 56 days', async () => {
      const ctx = statsCtx({ url: statsUrl('?startDate=2026-01-01&endDate=2026-02-26') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
    });

    it('scopes to a single caller-supplied projectId (no lookup/resolution needed)', async () => {
      const ctx = fakeContext({
        url: statsUrl(`?projectId=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A]);
    });

    it('accepts the project_id snake_case alias for projectId', async () => {
      const ctx = fakeContext({
        url: statsUrl(`?project_id=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.getStats(ctx);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A]);
    });

    it('splits a comma-separated projectId into multiple ids', async () => {
      const ctx = fakeContext({
        url: statsUrl(`?projectId=${PROJECT_ID_A},${PROJECT_ID_B}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A, PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A, PROJECT_ID_B]);
    });

    it('returns 403 when a caller-supplied projectId is not owned by this brand', async () => {
      const ctx = fakeContext({
        url: statsUrl(`?projectId=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(403);
      const body = await readBody(res);
      expect(body.message).to.match(new RegExp(PROJECT_ID_A));
      expect(serviceStub.getBrandPresenceStats).to.not.have.been.called;
    });

    it('deduplicates a repeated projectId before scoping (and before the count cap)', async () => {
      const ctx = fakeContext({
        url: statsUrl(`?projectId=${PROJECT_ID_A},${PROJECT_ID_A},${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A]);
    });

    it('returns 400 when more than 8 comma-separated projectIds are given', async () => {
      const tooMany = Array.from({ length: 9 }, (_, i) => `${i}${PROJECT_ID_A.slice(1)}`).join(',');
      const ctx = fakeContext({ url: statsUrl(`?projectId=${tooMany}`) });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/at most 8/);
    });

    it('does not count duplicates toward the 8-id cap (9 repeats of 1 id is fine)', async () => {
      const nineRepeats = Array.from({ length: 9 }, () => PROJECT_ID_A).join(',');
      const ctx = fakeContext({
        url: statsUrl(`?projectId=${nineRepeats}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A]);
    });

    it('returns 400 when a projectId is not a valid UUID', async () => {
      const ctx = fakeContext({ url: statsUrl('?projectId=not-a-uuid') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/must be a comma-separated list of UUIDs/);
    });

    it('resolves projectIds from the brand\'s BrandSemrushProject rows when no projectId is given', async () => {
      const ctx = statsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getBrandPresenceStats.firstCall.args;
      expect(params.projectIds).to.deep.equal(['proj-1']);
      expect(params.projectId).to.equal(undefined);
    });

    it('returns 503 (not a masked 404) when the PostgREST client is not available', async () => {
      const ctx = fakeContext({ url: statsUrl(), postgrestClient: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
    });

    it('returns 400 when siteId does not resolve to any brand', async () => {
      getBrandBySiteStub.resolves(null);
      const ctx = fakeContext({ url: statsUrl('?siteId=site-without-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when siteId resolves to a different brand than :brandId', async () => {
      getBrandBySiteStub.resolves({ id: 'some-other-brand-id', name: 'Other Brand' });
      const ctx = fakeContext({ url: statsUrl('?siteId=site-of-other-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/siteId does not belong to the specified brand/);
    });

    it('proceeds when siteId resolves to the same brand as :brandId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = statsCtx({ url: statsUrl('?siteId=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
    });

    it('accepts the site_id snake_case alias for siteId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = statsCtx({ url: statsUrl('?site_id=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(200);
      expect(getBrandBySiteStub).to.have.been.calledWith(ORG_ID, 'site-of-this-brand');
    });

    it('returns the auth error when brandId is not a valid UUID', async () => {
      const ctx = fakeContext({ url: statsUrl(), params: { brandId: 'not-a-uuid' } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the organization is not found', async () => {
      const ctx = fakeContext({
        url: statsUrl(),
        org: undefined,
      });
      ctx.dataAccess.Organization.findById.resolves(null);
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(404);
    });

    it('propagates upstream errors through mapError', async () => {
      serviceStub.getBrandPresenceStats.rejects(new MockElementsTransportError(503, 'upstream down'));
      const ctx = statsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getStats(ctx);
      expect(res.status).to.equal(502);
    });
  });

  describe('getUrlInspectorStats', () => {
    const urlInspectorStatsUrl = (qs = '') => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/stats${qs}`;

    // Most default-view assertions need the brand to own at least one Semrush
    // project, or getUrlInspectorStats 404s (see the dedicated empty-projects
    // test below) before ever reaching the service call.
    const urlInspectorStatsCtx = (overrides = {}) => {
      const project = makeBrandSemrushProject({ getSemrushProjectId: () => 'proj-1' });
      return fakeContext({
        url: urlInspectorStatsUrl(),
        withBrandSemrushProject: true,
        brandSemrushProjects: [project],
        ...overrides,
      });
    };

    it('returns 200 with the service result by default (aggregate view)', async () => {
      const ctx = urlInspectorStatsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal(URL_INSPECTOR_STATS_RESULT);
      const [workspaceId, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(workspaceId).to.equal(SUB_WORKSPACE_ID);
      expect(params.projects).to.deep.equal([{ region: 'US', projectId: 'proj-1' }]);
      expect(params.startDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(params.endDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns 404 when the brand has no configured Semrush projects (empty aggregate view)', async () => {
      serviceStub.getOwnedUrlProjects.resolves([]);
      const ctx = fakeContext({ url: urlInspectorStatsUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(404);
      const body = await readBody(res);
      expect(body.message).to.match(/No Semrush projects configured for brand/);
      expect(serviceStub.getUrlInspectorStats).to.not.have.been.called;
    });

    it('passes explicit startDate/endDate/model/platform/categoryId through to the service', async () => {
      const ctx = urlInspectorStatsCtx({
        url: urlInspectorStatsUrl('?startDate=2026-07-01&endDate=2026-07-14&model=search-gpt&platform=chatgpt&categoryId=Firefly'),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.startDate).to.equal('2026-07-01');
      expect(params.endDate).to.equal('2026-07-14');
      expect(params.model).to.equal('search-gpt');
      expect(params.category).to.equal('Firefly');
    });

    it('passes model and platform through as separate fields, not pre-merged (matches getStats/prompts-count convention)', async () => {
      const ctx = urlInspectorStatsCtx({
        url: urlInspectorStatsUrl('?platform=chatgpt'),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.model).to.be.undefined;
      expect(params.platform).to.equal('chatgpt');
    });

    it('defaults startDate/endDate to a 28-day trailing window when omitted', async () => {
      const ctx = urlInspectorStatsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.getUrlInspectorStats(ctx);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      const spanDays = (Date.parse(`${params.endDate}T00:00:00Z`)
        - Date.parse(`${params.startDate}T00:00:00Z`)) / 86400000;
      expect(spanDays).to.equal(28);
    });

    it('keeps an explicit startDate and only defaults endDate when endDate alone is omitted', async () => {
      const todayIso = new Date().toISOString().slice(0, 10);
      // Pick an explicit startDate close enough to "today" that the resulting
      // span still passes the 56-day cap, regardless of what "today" is.
      const explicitStart = addDaysToDate(todayIso, -10);
      const ctx = urlInspectorStatsCtx({ url: urlInspectorStatsUrl(`?startDate=${explicitStart}`) });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.startDate).to.equal(explicitStart);
      expect(params.endDate).to.equal(todayIso);
    });

    it('keeps an explicit endDate and only defaults startDate when startDate alone is omitted', async () => {
      const todayIso = new Date().toISOString().slice(0, 10);
      const explicitEnd = addDaysToDate(todayIso, -1);
      const ctx = urlInspectorStatsCtx({ url: urlInspectorStatsUrl(`?endDate=${explicitEnd}`) });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.endDate).to.equal(explicitEnd);
      expect(params.startDate).to.equal(addDaysToDate(todayIso, -28));
    });

    it('derives projects from the resolved Markets-element array, not raw brandSemrushProjects (aggregate view)', async () => {
      // getOwnedUrlProjects (Markets-element-derived) resolves a DIFFERENT set
      // than brandSemrushProjects (DB rows) — the citation KPIs must be scoped
      // to the former, since that's what's actually used to scope Stats-per-URL.
      serviceStub.getOwnedUrlProjects.resolves([
        { region: 'US', projectId: 'proj-from-markets' },
      ]);
      const ctx = urlInspectorStatsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.projects).to.deep.equal([{ region: 'US', projectId: 'proj-from-markets' }]);
    });

    it('returns 400 for a malformed startDate', async () => {
      const ctx = fakeContext({ url: urlInspectorStatsUrl('?startDate=not-a-date') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 for a malformed endDate', async () => {
      const ctx = fakeContext({ url: urlInspectorStatsUrl('?endDate=not-a-date') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when startDate is after endDate', async () => {
      const ctx = fakeContext({ url: urlInspectorStatsUrl('?startDate=2026-07-14&endDate=2026-07-01') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when the explicit date range exceeds 56 days', async () => {
      const ctx = urlInspectorStatsCtx({ url: urlInspectorStatsUrl('?startDate=2026-01-01&endDate=2026-12-31') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/Date range must not exceed 56 days/);
      expect(serviceStub.getUrlInspectorStats).to.not.have.been.called;
    });

    it('allows an explicit date range of exactly 56 days', async () => {
      const ctx = urlInspectorStatsCtx({ url: urlInspectorStatsUrl('?startDate=2026-01-01&endDate=2026-02-26') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
    });

    it('scopes to a single caller-supplied projectId (no lookup/resolution needed)', async () => {
      const ctx = fakeContext({
        url: urlInspectorStatsUrl(`?projectId=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.projects).to.deep.equal([{ projectId: PROJECT_ID_A }]);
    });

    it('splits a comma-separated projectId into multiple scoped projects', async () => {
      const ctx = fakeContext({
        url: urlInspectorStatsUrl(`?projectId=${PROJECT_ID_A},${PROJECT_ID_B}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A, PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getUrlInspectorStats.firstCall.args;
      expect(params.projects).to.deep.equal([
        { projectId: PROJECT_ID_A }, { projectId: PROJECT_ID_B },
      ]);
    });

    it('returns 403 when a caller-supplied projectId is not owned by this brand', async () => {
      const ctx = fakeContext({
        url: urlInspectorStatsUrl(`?projectId=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(403);
      const body = await readBody(res);
      expect(body.message).to.match(new RegExp(PROJECT_ID_A));
      expect(serviceStub.getUrlInspectorStats).to.not.have.been.called;
    });

    it('returns 400 for projectId=all (no more "all" aggregate keyword; must be a UUID)', async () => {
      // Unlike the old `region` param, `projectId` has no "all" special-case — a
      // caller must omit the param entirely to get the aggregate view, and any
      // supplied value must be a real UUID.
      const ctx = fakeContext({ url: urlInspectorStatsUrl('?projectId=all') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
      expect(serviceStub.getOwnedUrlProjects).to.not.have.been.called;
    });

    it('returns 400 when more than 8 comma-separated projectIds are given', async () => {
      const tooMany = Array.from({ length: 9 }, (_, i) => `${i}${PROJECT_ID_A.slice(1)}`).join(',');
      const ctx = fakeContext({ url: urlInspectorStatsUrl(`?projectId=${tooMany}`) });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/at most 8/);
    });

    it('returns 503 (not a masked 404) when the PostgREST client is not available', async () => {
      const ctx = fakeContext({ url: urlInspectorStatsUrl(), postgrestClient: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
    });

    it('returns 400 when siteId does not resolve to any brand', async () => {
      getBrandBySiteStub.resolves(null);
      const ctx = fakeContext({ url: urlInspectorStatsUrl('?siteId=site-without-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 400 when siteId resolves to a different brand than :brandId', async () => {
      getBrandBySiteStub.resolves({ id: 'some-other-brand-id', name: 'Other Brand' });
      const ctx = fakeContext({ url: urlInspectorStatsUrl('?siteId=site-of-other-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
      const body = await readBody(res);
      expect(body.message).to.match(/siteId does not belong to the specified brand/);
    });

    it('proceeds when siteId resolves to the same brand as :brandId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = urlInspectorStatsCtx({ url: urlInspectorStatsUrl('?siteId=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
    });

    it('accepts the site_id snake_case alias for siteId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = urlInspectorStatsCtx({ url: urlInspectorStatsUrl('?site_id=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(200);
      expect(getBrandBySiteStub).to.have.been.calledWith(ORG_ID, 'site-of-this-brand');
    });

    it('returns the auth error when brandId is not a valid UUID', async () => {
      const ctx = fakeContext({ url: urlInspectorStatsUrl(), params: { brandId: 'not-a-uuid' } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the organization is not found', async () => {
      const ctx = fakeContext({ url: urlInspectorStatsUrl(), org: undefined });
      ctx.dataAccess.Organization.findById.resolves(null);
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(404);
    });

    it('propagates upstream errors through mapError', async () => {
      serviceStub.getUrlInspectorStats.rejects(new MockElementsTransportError(503, 'upstream down'));
      const ctx = urlInspectorStatsCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorStats(ctx);
      expect(res.status).to.equal(502);
    });
  });

  describe('listDomainUrls', () => {
    const domainUrlsUrl = (qs = '') => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/domain-urls${qs}`;

    it('allows hostname to be omitted', async () => {
      const ctx = fakeContext({
        url: domainUrlsUrl('?startDate=2026-07-01&endDate=2026-07-14'),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listDomainUrls(ctx);

      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getDomainUrls.firstCall.args;
      expect(params.hostname).to.be.undefined;
    });

    it('keeps a single domain query param as a string', async () => {
      const ctx = fakeContext({
        url: domainUrlsUrl('?startDate=2026-07-01&endDate=2026-07-14&domain=reddit.com'),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.listDomainUrls(ctx);

      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getDomainUrls.firstCall.args;
      expect(params.hostname).to.equal('reddit.com');
    });
  });

  // The 4th URL Inspector KPI card, split out of getUrlInspectorStats — shares
  // that endpoint's auth/projectId-scoping scaffolding (see its tests above
  // for siteId/503/snake_case-alias coverage of that shared logic), calling
  // service.getPrompts instead of service.getUrlInspectorStats.
  describe('getUrlInspectorPromptsCount', () => {
    const promptsCountUrl = (qs = '') => `https://api.example.com/v2/orgs/${ORG_ID}`
      + `/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/prompts/count${qs}`;

    const promptsCountCtx = (overrides = {}) => {
      const project = makeBrandSemrushProject({ getSemrushProjectId: () => 'proj-1' });
      return fakeContext({
        url: promptsCountUrl(),
        withBrandSemrushProject: true,
        brandSemrushProjects: [project],
        ...overrides,
      });
    };

    it('returns 200 with { totalPrompts } scoped to the resolved projects (aggregate view)', async () => {
      const ctx = promptsCountCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(200);
      const body = await readBody(res);
      expect(body).to.deep.equal({ totalPrompts: PROMPTS_RESULT.count });
      const [workspaceId, params] = serviceStub.getPrompts.firstCall.args;
      expect(workspaceId).to.equal(SUB_WORKSPACE_ID);
      expect(params.projectIds).to.deep.equal(['proj-1']);
    });

    it('scopes to a single caller-supplied projectId (no lookup/resolution needed)', async () => {
      const ctx = fakeContext({
        url: promptsCountUrl(`?projectId=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A]);
    });

    it('splits a comma-separated projectId into multiple ids', async () => {
      const ctx = fakeContext({
        url: promptsCountUrl(`?projectId=${PROJECT_ID_A},${PROJECT_ID_B}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_A, PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(200);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.projectIds).to.deep.equal([PROJECT_ID_A, PROJECT_ID_B]);
    });

    it('returns 403 when a caller-supplied projectId is not owned by this brand', async () => {
      const ctx = fakeContext({
        url: promptsCountUrl(`?projectId=${PROJECT_ID_A}`),
        withBrandSemrushProject: true,
        brandSemrushProjects: brandSemrushProjectsFor([PROJECT_ID_B]),
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(403);
      const body = await readBody(res);
      expect(body.message).to.match(new RegExp(PROJECT_ID_A));
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('returns 400 when a projectId is not a valid UUID', async () => {
      const ctx = fakeContext({ url: promptsCountUrl('?projectId=not-a-uuid') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(400);
    });

    it('passes categoryId through as-is (already prefixed by the caller)', async () => {
      const ctx = promptsCountCtx({ url: promptsCountUrl('?categoryId=category__Firefly') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.getUrlInspectorPromptsCount(ctx);
      const [, params] = serviceStub.getPrompts.firstCall.args;
      expect(params.tags).to.deep.equal(['category__Firefly']);
    });

    it('returns 404 when the brand has no configured Semrush projects (empty aggregate view)', async () => {
      serviceStub.getOwnedUrlProjects.resolves([]);
      const ctx = fakeContext({ url: promptsCountUrl() });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(404);
      expect(serviceStub.getPrompts).to.not.have.been.called;
    });

    it('returns 400 when siteId resolves to a different brand than :brandId', async () => {
      getBrandBySiteStub.resolves({ id: 'some-other-brand-id', name: 'Other Brand' });
      const ctx = fakeContext({ url: promptsCountUrl('?siteId=site-of-other-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(400);
    });

    it('proceeds when siteId resolves to the same brand as :brandId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = promptsCountCtx({ url: promptsCountUrl('?siteId=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(200);
    });

    it('accepts the site_id snake_case alias for siteId', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Adobe Brand' });
      const ctx = promptsCountCtx({ url: promptsCountUrl('?site_id=site-of-this-brand') });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(200);
      expect(getBrandBySiteStub).to.have.been.calledWith(ORG_ID, 'site-of-this-brand');
    });

    it('returns 503 (not a masked 404) when the PostgREST client is not available', async () => {
      const ctx = fakeContext({ url: promptsCountUrl(), postgrestClient: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(503);
      const body = await readBody(res);
      expect(body.error).to.equal('configurationError');
    });

    it('returns the auth error when brandId is not a valid UUID', async () => {
      const ctx = fakeContext({ url: promptsCountUrl(), params: { brandId: 'not-a-uuid' } });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(400);
    });

    it('returns 404 when the organization is not found', async () => {
      const ctx = fakeContext({ url: promptsCountUrl(), org: undefined });
      ctx.dataAccess.Organization.findById.resolves(null);
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(404);
    });

    it('propagates upstream errors through mapError', async () => {
      serviceStub.getPrompts.rejects(new MockElementsTransportError(503, 'upstream down'));
      const ctx = promptsCountCtx();
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      const res = await ctrl.getUrlInspectorPromptsCount(ctx);
      expect(res.status).to.equal(502);
    });
  });

  // ─── extractQuery edge cases ──────────────────────────────────────────────

  describe('extractQuery', () => {
    it('returns empty params (plus an empty projectIds) when request URL is missing', async () => {
      const ctx = fakeContext({ url: null });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params).to.deep.equal({ projectIds: [] });
    });

    it('returns empty params (plus an empty projectIds) when request URL is invalid', async () => {
      const ctx = fakeContext({ url: 'not-a-url' });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params).to.deep.equal({ projectIds: [] });
    });

    it('captures multiple query params', async () => {
      const ctx = fakeContext({
        url: `https://api.example.com/v2/orgs/${ORG_ID}/brands/${BRAND_ID}/serenity/brand-presence/url-inspector/filter-dimensions?model=gpt-5&foo=bar`,
      });
      const ctrl = ElementsController(ctx, fakeLog(), ENV);
      await ctrl.listUrlInspectorFilterDimensions(ctx);
      const [, params] = serviceStub.getUrlInspectorFilterDimensions.firstCall.args;
      expect(params.model).to.equal('gpt-5');
      expect(params.foo).to.equal('bar');
    });
  });

  // ─── parseShowTrends ──────────────────────────────────────────────────────
  // Exercised directly (not just through getStats) because extractQuery only
  // ever yields strings from URLSearchParams, so the boolean/number branch
  // below is unreachable via the HTTP query-string path.

  describe('parseShowTrends', () => {
    it('returns true for the boolean true', () => {
      expect(parseShowTrends({ showTrends: true })).to.equal(true);
    });

    it('returns true for the number 1', () => {
      expect(parseShowTrends({ showTrends: 1 })).to.equal(true);
    });

    it('returns true for the string "true" (any case/whitespace)', () => {
      expect(parseShowTrends({ showTrends: 'TRUE' })).to.equal(true);
      expect(parseShowTrends({ showTrends: '  true  ' })).to.equal(true);
    });

    it('returns true for the string "1"', () => {
      expect(parseShowTrends({ showTrends: '1' })).to.equal(true);
    });

    it('falls back to show_trends when showTrends is absent', () => {
      expect(parseShowTrends({ show_trends: '1' })).to.equal(true);
    });

    it('returns false for the string "false"', () => {
      expect(parseShowTrends({ showTrends: 'false' })).to.equal(false);
    });

    it('returns false for an unrelated string', () => {
      expect(parseShowTrends({ showTrends: 'yes' })).to.equal(false);
    });

    it('returns false for the number 0', () => {
      expect(parseShowTrends({ showTrends: 0 })).to.equal(false);
    });

    it('returns false when both keys are absent', () => {
      expect(parseShowTrends({})).to.equal(false);
      expect(parseShowTrends(undefined)).to.equal(false);
    });
  });

  // ─── parseUserIntent ──────────────────────────────────────────────────────
  // Opt-in flag for per-prompt intent enrichment on the brand-presence prompts
  // endpoint. Same boolean-parse semantics as parseShowTrends.

  describe('parseUserIntent', () => {
    it('returns true for the boolean true and the number 1', () => {
      expect(parseUserIntent({ userIntent: true })).to.equal(true);
      expect(parseUserIntent({ userIntent: 1 })).to.equal(true);
    });

    it('returns true for the string "true"/"1" (any case/whitespace)', () => {
      expect(parseUserIntent({ userIntent: 'TRUE' })).to.equal(true);
      expect(parseUserIntent({ userIntent: '  1  ' })).to.equal(true);
    });

    it('falls back to user_intent when userIntent is absent', () => {
      expect(parseUserIntent({ user_intent: 'true' })).to.equal(true);
    });

    it('returns false for "false", unrelated strings, 0, and absent keys', () => {
      expect(parseUserIntent({ userIntent: 'false' })).to.equal(false);
      expect(parseUserIntent({ userIntent: 'yes' })).to.equal(false);
      expect(parseUserIntent({ userIntent: 0 })).to.equal(false);
      expect(parseUserIntent({})).to.equal(false);
      expect(parseUserIntent(undefined)).to.equal(false);
    });
  });
});
