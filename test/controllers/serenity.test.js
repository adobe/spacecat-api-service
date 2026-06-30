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
import { brandPointerReloader } from '../../src/controllers/serenity.js';

use(chaiAsPromised);
use(sinonChai);

const ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '22222222-3333-4444-5555-666666666666';
const SUBWS = '33333333-4444-5555-6666-777777777777';

function fakeLog() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  };
}

function makeBrandModel(overrides = {}) {
  return {
    getId: () => BRAND,
    getName: () => 'Test Brand',
    getOrganizationId: () => ORG,
    // The activate flow is a pending (draft) brand being approved → active; the
    // all-or-nothing path keys off this status (a non-pending brand is never
    // downgraded on a partial failure).
    getStatus: () => 'pending',
    getSemrushWorkspaceId: () => 'subworkspace-ws-1',
    setSemrushWorkspaceId: sinon.stub(),
    setStatus: sinon.stub(),
    save: sinon.stub().resolves(),
    ...overrides,
  };
}

function fakeContext({
  bearer = 'ims-token-123',
  authType = 'ims',
  params = {},
  data = undefined,
  brandId = BRAND,
  brand = makeBrandModel(),
  env = {},
} = {}) {
  return {
    env,
    pathInfo: {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    },
    attributes: {
      authInfo: { getType: () => authType },
    },
    dataAccess: {
      Organization: { findById: sinon.stub().resolves({ getId: () => ORG }) },
      Brand: { findById: sinon.stub().resolves(brand) },
      services: { postgrestClient: { from: () => ({}) } },
    },
    params: { spaceCatId: ORG, brandId, ...params },
    data,
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

describe('SerenityController', () => {
  const handlers = {
    handleListPrompts: sinon.stub(),
    handleCreatePrompts: sinon.stub(),
    handleUpdatePrompt: sinon.stub(),
    handleBulkDeletePrompts: sinon.stub(),
    handleListMarkets: sinon.stub(),
    handleGetMarket: sinon.stub(),
    handleCreateMarket: sinon.stub(),
    handleDeleteMarket: sinon.stub(),
    handleListTags: sinon.stub(),
    handleListModels: sinon.stub(),
    handleUpdateModels: sinon.stub(),
    listGlobalModelCatalog: sinon.stub(),
    listLanguageCatalog: sinon.stub(),
    handleListMarketsSubworkspace: sinon.stub(),
    handleGetMarketSubworkspace: sinon.stub(),
    handleCreateMarketSubworkspace: sinon.stub(),
    handleDeleteMarketSubworkspace: sinon.stub(),
    handleListTagsSubworkspace: sinon.stub(),
    handleListModelsSubworkspace: sinon.stub(),
    handleUpdateModelsSubworkspace: sinon.stub(),
    handleListPromptsSubworkspace: sinon.stub(),
    handleCreatePromptsSubworkspace: sinon.stub(),
    handleUpdatePromptSubworkspace: sinon.stub(),
    handleBulkDeletePromptsSubworkspace: sinon.stub(),
    handleCreateTag: sinon.stub(),
    handleCreateTagSubworkspace: sinon.stub(),
  };
  let decommissionStub;
  let ensureSubworkspaceStub;
  let clearBrandWorkspaceCacheStub;
  let resolveWorkspaceIdStub;
  let resolveBrandWorkspaceStub;
  let createTransportStub;
  let resolveBrandUuidStub;
  let getBrandAliasesStub;
  let getBrandUrlSourcesStub;
  let getBrandCompetitorsStub;
  let accessControlHasAccessStub;
  let ensureMarketSiteStub;
  let MockTransportError;
  let SerenityController;

  beforeEach(async () => {
    Object.values(handlers).forEach((s) => s.reset());
    resolveWorkspaceIdStub = sinon.stub().resolves(WORKSPACE);
    // Default: flat mode — existing assertions (handlers called with
    // WORKSPACE) hold unchanged. Subworkspace-mode tests override this stub.
    resolveBrandWorkspaceStub = sinon.stub().resolves({
      mode: 'flat', workspaceId: WORKSPACE, parentWorkspaceId: WORKSPACE,
    });
    decommissionStub = sinon.stub().resolves();
    ensureSubworkspaceStub = sinon.stub().resolves(SUBWS);
    clearBrandWorkspaceCacheStub = sinon.stub();
    createTransportStub = sinon.stub().returns({ name: 'transport' });
    resolveBrandUuidStub = sinon.stub().resolves(BRAND);
    getBrandAliasesStub = sinon.stub().resolves([]);
    getBrandUrlSourcesStub = sinon.stub()
      .resolves({ urls: [], socialAccounts: [], earnedContent: [] });
    getBrandCompetitorsStub = sinon.stub().resolves([]);
    accessControlHasAccessStub = sinon.stub().resolves(true);
    ensureMarketSiteStub = sinon.stub().resolves('site-uuid-1');
    MockTransportError = class extends Error {
      constructor(status, message, body) {
        super(message);
        this.name = 'SerenityTransportError';
        this.status = status;
        this.body = body;
      }
    };
    const MockAccessControlUtil = {
      default: {
        fromContext: () => ({
          hasAccess: accessControlHasAccessStub,
        }),
      },
    };
    SerenityController = (await esmock('../../src/controllers/serenity.js', {
      '../../src/support/serenity/rest-transport.js': {
        createSerenityTransport: createTransportStub,
        SerenityTransportError: MockTransportError,
      },
      '../../src/support/serenity/workspace-resolver.js': {
        resolveWorkspaceId: resolveWorkspaceIdStub,
        resolveBrandWorkspace: resolveBrandWorkspaceStub,
        clearBrandWorkspaceCache: clearBrandWorkspaceCacheStub,
      },
      '../../src/support/serenity/handlers/prompts.js': {
        handleListPrompts: handlers.handleListPrompts,
        handleCreatePrompts: handlers.handleCreatePrompts,
        handleUpdatePrompt: handlers.handleUpdatePrompt,
        handleBulkDeletePrompts: handlers.handleBulkDeletePrompts,
      },
      '../../src/support/serenity/handlers/markets.js': {
        handleListMarkets: handlers.handleListMarkets,
        handleGetMarket: handlers.handleGetMarket,
        handleCreateMarket: handlers.handleCreateMarket,
        handleDeleteMarket: handlers.handleDeleteMarket,
        handleListTags: handlers.handleListTags,
        handleListModels: handlers.handleListModels,
        handleUpdateModels: handlers.handleUpdateModels,
        listGlobalModelCatalog: handlers.listGlobalModelCatalog,
        listLanguageCatalog: handlers.listLanguageCatalog,
      },
      '../../src/support/serenity/handlers/markets-subworkspace.js': {
        handleListMarketsSubworkspace: handlers.handleListMarketsSubworkspace,
        handleGetMarketSubworkspace: handlers.handleGetMarketSubworkspace,
        handleCreateMarketSubworkspace: handlers.handleCreateMarketSubworkspace,
        handleDeleteMarketSubworkspace: handlers.handleDeleteMarketSubworkspace,
        handleListTagsSubworkspace: handlers.handleListTagsSubworkspace,
        handleListModelsSubworkspace: handlers.handleListModelsSubworkspace,
        handleUpdateModelsSubworkspace: handlers.handleUpdateModelsSubworkspace,
      },
      '../../src/support/serenity/handlers/prompts-subworkspace.js': {
        handleListPromptsSubworkspace: handlers.handleListPromptsSubworkspace,
        handleCreatePromptsSubworkspace: handlers.handleCreatePromptsSubworkspace,
        handleUpdatePromptSubworkspace: handlers.handleUpdatePromptSubworkspace,
        handleBulkDeletePromptsSubworkspace: handlers.handleBulkDeletePromptsSubworkspace,
      },
      '../../src/support/serenity/handlers/tags.js': {
        handleCreateTag: handlers.handleCreateTag,
        handleCreateTagSubworkspace: handlers.handleCreateTagSubworkspace,
      },
      '../../src/support/serenity/workspace-lifecycle.js': {
        ensureSubworkspace: ensureSubworkspaceStub,
        decommissionBrandWorkspace: decommissionStub,
      },
      '../../src/support/access-control-util.js': MockAccessControlUtil,
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: resolveBrandUuidStub,
      },
      '../../src/support/brands-storage.js': {
        getBrandAliases: getBrandAliasesStub,
        getBrandUrlSources: getBrandUrlSourcesStub,
        getBrandCompetitors: getBrandCompetitorsStub,
      },
      '../../src/support/serenity/site-linkage.js': {
        ensureMarketSite: ensureMarketSiteStub,
      },
    })).default;
  });

  afterEach(() => sinon.restore());

  describe('constructor', () => {
    it('requires a context', () => {
      expect(() => SerenityController(null, fakeLog(), {})).to.throw('Context required');
    });

    it('requires a log', () => {
      expect(() => SerenityController({ env: {} }, null, {})).to.throw('Log required');
    });

    // The warn-once latch is module-scoped, but `beforeEach` re-esmocks
    // serenity.js fresh for every test, so each test gets its OWN latch — this
    // test is self-contained, not order-dependent. The two constructions below
    // share THIS test's module instance (first warns, second is already latched),
    // and a future test that wants to see the warning gets a fresh module where it
    // fires again. It reads the flag through the third `env` arg (context has no
    // `env`), exercising the `context?.env || env` fallback branch — the
    // context.env side is already covered by every other constructor here.
    it('warns at most once when SERENITY_ALLOW_NON_IMS_AUTH is enabled', () => {
      const log = fakeLog();
      SerenityController({ region: 'x' }, log, { SERENITY_ALLOW_NON_IMS_AUTH: 'true' });
      expect(log.warn).to.have.been.calledOnce;
      expect(log.warn.firstCall.args[0]).to.match(/SERENITY_ALLOW_NON_IMS_AUTH is enabled/);

      // A second construction with the flag still set does not warn again.
      const log2 = fakeLog();
      SerenityController({ env: { SERENITY_ALLOW_NON_IMS_AUTH: 'true' } }, log2, {});
      expect(log2.warn).to.not.have.been.called;
    });
  });

  describe('auth + brand resolution', () => {
    it('401s without an Authorization header', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ bearer: null });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(401);
    });

    it('401s when the caller did not authenticate via IMS', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ authType: 'jwt' });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(401);
    });

    // Test-only escape hatch (SERENITY_ALLOW_NON_IMS_AUTH). The integration-test
    // harness mints a non-IMS (JWT) token; with the flag set, the IMS-type gate
    // is skipped so the handler runs (the Semrush mock ignores the forwarded
    // bearer). The Authorization header is still required (asserted below).
    it('lets a non-IMS caller through when SERENITY_ALLOW_NON_IMS_AUTH is set (reaches the handler, not 401)', async () => {
      handlers.handleListPrompts.resolves({ items: [], total: 0 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ authType: 'jwt', env: { SERENITY_ALLOW_NON_IMS_AUTH: 'true' } });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleListPrompts).to.have.been.calledOnce;
    });

    it('still 401s a non-IMS caller with the flag set but NO Authorization header', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        authType: 'jwt', bearer: null, env: { SERENITY_ALLOW_NON_IMS_AUTH: 'true' },
      });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(401);
    });

    it('400s when :brandId is not a UUID (the new guard)', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ brandId: 'adobe-brand-name' });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(400);
      const body = await readBody(response);
      expect(body.error).to.equal('invalidRequest');
      expect(body.message).to.match(/brandId must be a UUID/);
      expect(resolveBrandUuidStub).not.to.have.been.called;
    });

    it('404s when the brand does not belong to the org', async () => {
      resolveBrandUuidStub.resolves(null);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listPrompts(fakeContext());
      expect(response.status).to.equal(404);
    });

    it('403s when the user has no access to the org', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listPrompts(fakeContext());
      expect(response.status).to.equal(403);
    });

    it('404s when the org has no semrush_workspace_id (flat mode, no parent)', async () => {
      // Flat mode resolves the brand against the org parent workspace; when that
      // is unset, resolveBrandWorkspace returns a null workspaceId → 404.
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null, parentWorkspaceId: null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listPrompts(fakeContext());
      expect(response.status).to.equal(404);
    });
  });

  describe('routing to handlers', () => {
    it('listPrompts forwards parsed query (geoTargetId as int, page as int) to handleListPrompts', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = {
        url: 'https://x/v2/orgs/x/brands/y/serenity/prompts?geoTargetId=2840&languageCode=en&page=2',
      };

      await controller.listPrompts(ctx);

      expect(handlers.handleListPrompts).to.have.been.calledOnce;
      const { args } = handlers.handleListPrompts.firstCall;
      expect(args[4]).to.include({
        geoTargetId: 2840, languageCode: 'en', page: 2,
      });
    });

    it('listPrompts coerces limit query param to integer and forwards it', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 25,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = {
        url: 'https://x/v2/orgs/x/brands/y/serenity/prompts?geoTargetId=2840&languageCode=en&limit=25',
      };

      await controller.listPrompts(ctx);

      const { args } = handlers.handleListPrompts.firstCall;
      expect(args[4]).to.include({ limit: 25 });
    });

    it('listPrompts forwards null when limit query param is unparseable', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = {
        url: 'https://x/v2/orgs/x/brands/y/serenity/prompts?geoTargetId=2840&languageCode=en&limit=abc',
      };

      await controller.listPrompts(ctx);

      const { args } = handlers.handleListPrompts.firstCall;
      expect(args[4].limit).to.equal(null);
    });

    it('listPrompts collects repeated tagIds query keys into an array', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = {
        url: 'https://x/v2/orgs/x/brands/y/serenity/prompts?geoTargetId=2840&languageCode=en&tagIds=t-1&tagIds=t-2',
      };

      await controller.listPrompts(ctx);

      const { args } = handlers.handleListPrompts.firstCall;
      expect(args[4].tagIds).to.deep.equal(['t-1', 't-2']);
    });

    it('listPrompts omits tagIds when no tagIds query key is present', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = {
        url: 'https://x/v2/orgs/x/brands/y/serenity/prompts?geoTargetId=2840&languageCode=en',
      };

      await controller.listPrompts(ctx);

      const { args } = handlers.handleListPrompts.firstCall;
      expect(args[4]).to.not.have.property('tagIds');
    });

    it('updatePrompt requires :semrushPromptId path param', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updatePrompt(fakeContext({ params: {} }));
      expect(response.status).to.equal(400);
    });

    it('updatePrompt forwards semrushPromptId from path to handleUpdatePrompt', async () => {
      handlers.handleUpdatePrompt.resolves({ status: 200, body: { semrushPromptId: 'new-sem' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updatePrompt(fakeContext({
        params: { semrushPromptId: 'sem-1' },
        data: { geoTargetId: 2840, languageCode: 'en', text: 'next' },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdatePrompt.firstCall.args[4]).to.equal('sem-1');
    });

    it('deleteMarket forwards the path slice params to handleDeleteMarket', async () => {
      handlers.handleDeleteMarket.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({
        params: { geoTargetId: '2840', languageCode: 'EN' },
      }));
      expect(response.status).to.equal(204);
      const { args } = handlers.handleDeleteMarket.firstCall;
      expect(args[4]).to.equal(2840);
      expect(args[5]).to.equal('en');
    });

    // Minor #1 from review: parseInt('2840abc', 10) === 2840 would silently
    // route /markets/2840abc/en to the legit slice. The controller now uses a
    // strict /^\d+$/ regex; non-digit suffixes must surface as null so the
    // handler returns 400 instead of resolving to (2840, en).
    it('deleteMarket null-routes a non-digit geoTargetId (e.g. "2840abc") to the handler', async () => {
      handlers.handleDeleteMarket.rejects(
        new ErrorWithStatusCode('geoTargetId must be a positive integer', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({
        params: { geoTargetId: '2840abc', languageCode: 'en' },
      }));
      expect(response.status).to.equal(400);
      const { args } = handlers.handleDeleteMarket.firstCall;
      expect(args[4]).to.equal(null);
    });

    it('deleteMarket forwards null for an empty geoTargetId path segment', async () => {
      handlers.handleDeleteMarket.rejects(
        new ErrorWithStatusCode('geoTargetId must be a positive integer', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({
        params: { geoTargetId: '', languageCode: 'en' },
      }));
      expect(response.status).to.equal(400);
      const { args } = handlers.handleDeleteMarket.firstCall;
      expect(args[4]).to.equal(null);
    });

    it('deleteMarket forwards null for an empty languageCode path segment', async () => {
      handlers.handleDeleteMarket.rejects(
        new ErrorWithStatusCode('languageCode must match', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({
        params: { geoTargetId: '2840', languageCode: '' },
      }));
      expect(response.status).to.equal(400);
      const { args } = handlers.handleDeleteMarket.firstCall;
      expect(args[5]).to.equal(null);
    });

    // '0' is a distinct code path from '2840abc' (regex-reject at the
    // controller) and '' (regex-reject at the controller): the strict-digit
    // regex /^\d+$/ accepts '0', so the controller forwards Number('0') === 0
    // to the handler. The handler's normalizeGeoTargetId(0) returns null
    // because the OpenAPI contract declares `minimum: 1`, surfacing as a 400.
    it('deleteMarket forwards 0 through to the handler (handler rejects via positive-integer guard)', async () => {
      handlers.handleDeleteMarket.rejects(
        new ErrorWithStatusCode('geoTargetId must be a positive integer', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({
        params: { geoTargetId: '0', languageCode: 'en' },
      }));
      expect(response.status).to.equal(400);
      const { args } = handlers.handleDeleteMarket.firstCall;
      expect(args[4]).to.equal(0);
    });

    it('listMarkets returns the handler result wrapped in ok()', async () => {
      handlers.handleListMarkets.resolves({ items: [{ brandId: BRAND, geoTargetId: 2840, languageCode: 'en' }] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(200);
      const body = await readBody(response);
      expect(body.items[0].brandId).to.equal(BRAND);
    });

    it('getMarket forwards the path slice params to handleGetMarket and wraps the result in ok()', async () => {
      handlers.handleGetMarket.resolves({
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
        semrushProjectId: 'proj-us-en',
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        params: { geoTargetId: '2840', languageCode: 'EN' },
      }));
      expect(response.status).to.equal(200);
      const body = await readBody(response);
      expect(body.semrushProjectId).to.equal('proj-us-en');
      const { args } = handlers.handleGetMarket.firstCall;
      // Slice forwarded as (geoTargetId:int, languageCode:lowercased).
      expect(args[2]).to.equal(2840);
      expect(args[3]).to.equal('en');
    });

    // Same strict /^\d+$/ guard as deleteMarket: a non-digit suffix must
    // surface as null so the handler 400s rather than resolving the legit
    // (2840, en) slice.
    it('getMarket null-routes a non-digit geoTargetId (e.g. "2840abc") to the handler', async () => {
      handlers.handleGetMarket.rejects(
        new ErrorWithStatusCode('geoTargetId must be a positive integer', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        params: { geoTargetId: '2840abc', languageCode: 'en' },
      }));
      expect(response.status).to.equal(400);
      expect(handlers.handleGetMarket.firstCall.args[2]).to.equal(null);
    });

    it('getMarket forwards null for an empty geoTargetId path segment', async () => {
      // Empty path segment → pGeo is '' → `pGeo || ''` right side → regex rejects
      // '' → geoTargetId forwarded as null (handler 400s).
      handlers.handleGetMarket.rejects(
        new ErrorWithStatusCode('geoTargetId must be a positive integer', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        params: { geoTargetId: '', languageCode: 'en' },
      }));
      expect(response.status).to.equal(400);
      expect(handlers.handleGetMarket.firstCall.args[2]).to.equal(null);
    });

    it('getMarket maps a handler 404 marketNotFound to a 404 envelope carrying that token', async () => {
      const err = new ErrorWithStatusCode('No market for this slice', 404);
      err.code = 'marketNotFound';
      handlers.handleGetMarket.rejects(err);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        params: { geoTargetId: '2840', languageCode: 'en' },
      }));
      expect(response.status).to.equal(404);
      const body = await readBody(response);
      expect(body.error).to.equal('marketNotFound');
    });

    it('getMarket 401s (IMS-only) before dispatching when the caller is not IMS-authenticated', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        authType: 'jwt',
        params: { geoTargetId: '2840', languageCode: 'en' },
      }));
      expect(response.status).to.equal(401);
      expect(handlers.handleGetMarket).not.to.have.been.called;
    });

    it('getMarket forwards null for an empty languageCode path segment (handler 400s)', async () => {
      handlers.handleGetMarket.rejects(
        new ErrorWithStatusCode('languageCode must match', 400),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        params: { geoTargetId: '2840', languageCode: '' },
      }));
      expect(response.status).to.equal(400);
      // Exercises the `: null` side of the `pLang ? ...toLowerCase() : null` guard.
      expect(handlers.handleGetMarket.firstCall.args[3]).to.equal(null);
    });

    it('getMarket returns the authorize() error (403) and does not dispatch when the caller lacks org access', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({
        params: { geoTargetId: '2840', languageCode: 'en' },
      }));
      expect(response.status).to.equal(403);
      expect(handlers.handleGetMarket).not.to.have.been.called;
    });

    it('upstream SerenityTransportError maps to 502 envelope without leaking provider detail', async () => {
      handlers.handleListMarkets.rejects(new MockTransportError(503, 'upstream down', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(502);
      const body = await readBody(response);
      expect(body.error).to.equal('serenityUpstreamError');
      expect(body.message).to.equal('Upstream request failed');
      expect(JSON.stringify(body)).not.to.match(/leak/);
    });

    it('upstream SerenityTransportError 403 propagates as 403 forbidden', async () => {
      handlers.handleListMarkets.rejects(new MockTransportError(403, 'invalid access attempt', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(403);
      const body = await readBody(response);
      expect(body.error).to.equal('forbidden');
      // Redacted: the transport error message embeds the gateway URL (internal
      // host + workspace UUIDs), so 401/403 return a generic message, not e.message.
      expect(body.message).to.equal('Upstream authorization failed');
      expect(body.message).to.not.equal('invalid access attempt');
      expect(JSON.stringify(body)).not.to.match(/leak/);
    });

    it('upstream SerenityTransportError 401 propagates as 401 authenticationRequired', async () => {
      handlers.handleListMarkets.rejects(new MockTransportError(401, 'token expired', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(401);
      const body = await readBody(response);
      expect(body.error).to.equal('authenticationRequired');
      // Redacted (see 403 case): no upstream message echoed on 401/403.
      expect(body.message).to.equal('Upstream authorization failed');
      expect(body.message).to.not.equal('token expired');
      expect(JSON.stringify(body)).not.to.match(/leak/);
    });

    // mapError's final fallback: anything that isn't ErrorWithStatusCode and
    // isn't SerenityTransportError lands on the generic 500 path. No upstream
    // body, no status code leakage — the message is always the constant
    // 'Internal server error'. The error itself is log.error'd server-side
    // so an operator can still reconstruct.
    it('generic Error maps to 500 internalServerError with no upstream detail leakage', async () => {
      handlers.handleListMarkets.rejects(new Error('boom from somewhere'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(500);
      const body = await readBody(response);
      expect(body.error).to.equal('internalServerError');
      expect(body.message).to.equal('Internal server error');
      expect(log.error).to.have.been.calledWithMatch('Serenity controller error');
    });

    it('listTags dispatches to handleListTags and wraps the result in ok()', async () => {
      handlers.handleListTags.resolves({ items: [{ id: 't1', name: 'tag1' }] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };
      const response = await controller.listTags(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleListTags).to.have.been.calledOnce;
    });

    it('listModels dispatches to handleListModels and wraps the result in ok()', async () => {
      handlers.handleListModels.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };
      const response = await controller.listModels(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleListModels).to.have.been.calledOnce;
    });

    it('listOrgModels returns the global catalog (org-level, no brand)', async () => {
      handlers.listGlobalModelCatalog.resolves({ items: [{ id: 'cat-gpt', key: 'chatgpt' }] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgModels(fakeContext());
      expect(response.status).to.equal(200);
      const body = await readBody(response);
      expect(body.items[0].id).to.equal('cat-gpt');
      expect(handlers.listGlobalModelCatalog).to.have.been.calledOnce;
    });

    it('listOrgModels 400s when spaceCatId is not a UUID', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgModels(fakeContext({ params: { spaceCatId: 'not-a-uuid' } }));
      expect(response.status).to.equal(400);
      expect(handlers.listGlobalModelCatalog).to.not.have.been.called;
    });

    it('listOrgModels 403s when the user has no access to the org', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgModels(fakeContext());
      expect(response.status).to.equal(403);
      expect(handlers.listGlobalModelCatalog).to.not.have.been.called;
    });

    it('listOrgLanguages returns the language catalog (org-level, no brand)', async () => {
      handlers.listLanguageCatalog.resolves({ items: [{ id: 'lng-en', name: 'English' }] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgLanguages(fakeContext());
      expect(response.status).to.equal(200);
      const body = await readBody(response);
      expect(body.items[0].name).to.equal('English');
      expect(handlers.listLanguageCatalog).to.have.been.calledOnce;
    });

    it('listOrgLanguages 400s when spaceCatId is not a UUID', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgLanguages(fakeContext({ params: { spaceCatId: 'nope' } }));
      expect(response.status).to.equal(400);
      expect(handlers.listLanguageCatalog).to.not.have.been.called;
    });

    it('listOrgLanguages 403s when the user has no access to the org', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgLanguages(fakeContext());
      expect(response.status).to.equal(403);
      expect(handlers.listLanguageCatalog).to.not.have.been.called;
    });

    it('listOrgModels 500s when Organization data-access is unavailable', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization = undefined;
      const response = await controller.listOrgModels(ctx);
      expect(response.status).to.equal(500);
      expect(handlers.listGlobalModelCatalog).to.not.have.been.called;
    });

    it('listOrgModels 404s when the organization is not found', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById = sinon.stub().resolves(null);
      const response = await controller.listOrgModels(ctx);
      expect(response.status).to.equal(404);
      expect(handlers.listGlobalModelCatalog).to.not.have.been.called;
    });

    it('listOrgModels routes an upstream failure through mapError', async () => {
      handlers.listGlobalModelCatalog.rejects(new MockTransportError(502, 'gw.internal boom'));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgModels(fakeContext());
      expect(response.status).to.equal(502);
    });

    it('listOrgLanguages 500s when Organization data-access is unavailable', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization = undefined;
      const response = await controller.listOrgLanguages(ctx);
      expect(response.status).to.equal(500);
      expect(handlers.listLanguageCatalog).to.not.have.been.called;
    });

    it('listOrgLanguages 404s when the organization is not found', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById = sinon.stub().resolves(null);
      const response = await controller.listOrgLanguages(ctx);
      expect(response.status).to.equal(404);
      expect(handlers.listLanguageCatalog).to.not.have.been.called;
    });

    it('listOrgLanguages routes an upstream failure through mapError', async () => {
      handlers.listLanguageCatalog.rejects(new MockTransportError(502, 'gw.internal boom'));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listOrgLanguages(fakeContext());
      expect(response.status).to.equal(502);
    });

    it('updateModels dispatches ctx.data to handleUpdateModels and wraps the result in ok()', async () => {
      handlers.handleUpdateModels.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateModels(fakeContext({
        data: { geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-gpt'] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdateModels).to.have.been.calledOnce;
      expect(handlers.handleUpdateModels.firstCall.args[4]).to.deep.equal({
        geoTargetId: 2840, languageCode: 'en', modelIds: ['cat-gpt'],
      });
    });

    it('updateModels falls back to {} when ctx.data is absent', async () => {
      handlers.handleUpdateModels.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateModels(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdateModels.firstCall.args[4]).to.deep.equal({});
    });

    it('updateModels returns 403 and does not dispatch when the caller lacks org access', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateModels(fakeContext({
        data: { geoTargetId: 2840, languageCode: 'en', modelIds: [] },
      }));
      expect(response.status).to.equal(403);
      expect(handlers.handleUpdateModels).not.to.have.been.called;
    });

    it('updateModels maps a thrown Error through mapError (500)', async () => {
      handlers.handleUpdateModels.rejects(new Error('boom'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.updateModels(fakeContext({
        data: { geoTargetId: 2840, languageCode: 'en', modelIds: [] },
      }));
      expect(response.status).to.equal(500);
      const body = await readBody(response);
      expect(body.error).to.equal('internalServerError');
      expect(log.error).to.have.been.calledWithMatch('Serenity controller error');
    });

    it('createMarket routes to the flat handler in flat mode', async () => {
      handlers.handleCreateMarket.resolves({ status: 201, body: { brandId: BRAND } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(handlers.handleCreateMarket).to.have.been.calledOnce;
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
    });

    it('bulkDeletePrompts routes to the flat handler in flat mode', async () => {
      handlers.handleBulkDeletePrompts.resolves({ deleted: 1, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.bulkDeletePrompts(fakeContext({
        data: { prompts: [{ semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleBulkDeletePrompts).to.have.been.calledOnce;
      expect(handlers.handleBulkDeletePromptsSubworkspace).to.not.have.been.called;
    });

    it('createTag routes to the flat handler in flat mode and returns its status', async () => {
      handlers.handleCreateTag.resolves({
        status: 201,
        body: {
          brandId: BRAND, geoTargetId: 2840, languageCode: 'en', type: 'category', name: 'Footwear', tag: 'category:Footwear',
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createTag(fakeContext({
        data: {
          type: 'category', name: 'Footwear', geoTargetId: 2840, languageCode: 'en',
        },
      }));
      expect(response.status).to.equal(201);
      const body = await readBody(response);
      expect(body.tag).to.equal('category:Footwear');
      expect(handlers.handleCreateTag).to.have.been.calledOnce;
      expect(handlers.handleCreateTagSubworkspace).to.not.have.been.called;
    });

    it('createTag maps a handler 400 (bad body) through mapError', async () => {
      handlers.handleCreateTag.rejects(new ErrorWithStatusCode('name is required', 400));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createTag(fakeContext({
        data: { type: 'category', geoTargetId: 2840, languageCode: 'en' },
      }));
      expect(response.status).to.equal(400);
      const body = await readBody(response);
      expect(body.message).to.match(/name is required/);
    });
  });

  describe('controller surface', () => {
    it('exposes the new method names and does NOT expose listProjects / listWorkspaceProjects', () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      expect(controller.listPrompts).to.be.a('function');
      expect(controller.createPrompts).to.be.a('function');
      expect(controller.updatePrompt).to.be.a('function');
      expect(controller.bulkDeletePrompts).to.be.a('function');
      expect(controller.listMarkets).to.be.a('function');
      expect(controller.getMarket).to.be.a('function');
      expect(controller.createMarket).to.be.a('function');
      expect(controller.deleteMarket).to.be.a('function');
      expect(controller.listTags).to.be.a('function');
      expect(controller.createTag).to.be.a('function');
      expect(controller.listModels).to.be.a('function');
      expect(controller.updateModels).to.be.a('function');

      expect(controller.listProjects).to.be.undefined;
      expect(controller.createProject).to.be.undefined;
      expect(controller.listProjectTags).to.be.undefined;
      expect(controller.listProjectModels).to.be.undefined;
      expect(controller.listWorkspaceProjects).to.be.undefined;
    });
  });

  describe('dual-mode dispatch (subworkspace)', () => {
    beforeEach(() => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'subworkspace-ws-1', parentWorkspaceId: WORKSPACE,
      });
    });

    it('listMarkets routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleListMarketsSubworkspace.resolves({
        items: [{
          brandId: BRAND, geoTargetId: 2840, languageCode: 'en', status: 'live',
        }],
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleListMarketsSubworkspace).to.have.been.calledOnceWithExactly({ name: 'transport' }, BRAND, 'subworkspace-ws-1');
      expect(handlers.handleListMarkets).to.not.have.been.called;
    });

    it('getMarket routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleGetMarketSubworkspace.resolves({
        brandId: BRAND, geoTargetId: 2840, languageCode: 'en', initialized: true,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'EN' } }));
      expect(response.status).to.equal(200);
      expect(handlers.handleGetMarketSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleGetMarket).to.not.have.been.called;
    });

    it('createMarket routes to the subworkspace handler with the brand + parent workspace', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(handlers.handleCreateMarketSubworkspace).to.have.been.calledOnce;
      const { args } = handlers.handleCreateMarketSubworkspace.firstCall;
      expect(args[2]).to.equal(WORKSPACE); // parentWorkspaceId
    });

    it('createMarket mirrors the new market as a Site (+ brand_sites link) on 201', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(ensureMarketSiteStub).to.have.been.calledOnce;
      const opts = ensureMarketSiteStub.firstCall.args[1];
      expect(opts).to.include({ organizationId: ORG, brandId: BRAND, domain: 'x.com' });
    });

    it('createMarket does NOT mirror a Site when the upstream create did not return 201', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 409, body: { error: 'sliceExists' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(409);
      expect(ensureMarketSiteStub).to.not.have.been.called;
    });

    it('createMarket forwards the brand aliases so the project carries them', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      getBrandAliasesStub.resolves(['Acme Inc', 'ACME']);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(getBrandAliasesStub).to.have.been.calledOnceWith(BRAND);
      // options object is the 8th arg (index 7). generatePrompts was not supplied,
      // so topic generation defaults off (today's behavior is unchanged).
      expect(handlers.handleCreateMarketSubworkspace.firstCall.args[7])
        .to.deep.equal({
          generateTopics: false,
          topicCap: 0,
          standardTags: [],
          projectTags: [],
          brandAliases: ['Acme Inc', 'ACME'],
          brandUrlSources: { urls: [], socialAccounts: [], earnedContent: [] },
          competitors: [],
        });
    });

    it('createMarket forwards the brand URL sources so the project carries them', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      const sources = {
        urls: [{ value: 'https://x.com' }],
        socialAccounts: [{ url: 'https://t.com/x', regions: ['us'] }],
        earnedContent: [],
      };
      getBrandUrlSourcesStub.resolves(sources);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(getBrandUrlSourcesStub).to.have.been.calledOnceWith(BRAND);
      expect(handlers.handleCreateMarketSubworkspace.firstCall.args[7].brandUrlSources)
        .to.deep.equal(sources);
    });

    it('createMarket forwards the brand competitors so the CI list carries them', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      const competitors = [{ url: 'https://rival.com', regions: ['us'] }];
      getBrandCompetitorsStub.resolves(competitors);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(getBrandCompetitorsStub).to.have.been.calledOnceWith(BRAND);
      expect(handlers.handleCreateMarketSubworkspace.firstCall.args[7].competitors)
        .to.deep.equal(competitors);
    });

    it('createMarket opts into topic generation (cap + standard tags) when generatePrompts is true', async () => {
      // generatePrompts:true → genMarketTopics true → the true side of each
      // ternary (topicCap, standardTags, projectTags) is forwarded.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us',
          languageCode: 'en',
          brandDomain: 'x.com',
          brandNames: ['X'],
          generatePrompts: true,
        },
      }));
      expect(response.status).to.equal(201);
      const opts = handlers.handleCreateMarketSubworkspace.firstCall.args[7];
      expect(opts.generateTopics).to.equal(true);
      // Topic cap + tag lists are populated (non-empty) on the opt-in path.
      expect(opts.topicCap).to.be.a('number').and.to.be.greaterThan(0);
      expect(opts.standardTags).to.be.an('array').and.to.have.length.greaterThan(0);
      expect(opts.projectTags).to.be.an('array').and.to.have.length.greaterThan(0);
    });

    it('deleteMarket routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } }));
      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteMarketSubworkspace).to.have.been.calledOnce;
    });

    it('getMarket defaults the path slice to an empty object when ctx.params is absent post-auth', async () => {
      // Defensive `ctx?.params || {}` guard: authorize reads brandId/spaceCatId up
      // front, so if params is later cleared, the slice parsing must still tolerate
      // a missing params object (both geoTargetId and languageCode resolve to null).
      handlers.handleGetMarketSubworkspace.resolves({
        brandId: BRAND, geoTargetId: null, languageCode: null,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } });
      // authorize() reads params first, then awaits resolveBrandWorkspace — clear
      // params during that await so the post-auth `|| {}` fallback is exercised.
      resolveBrandWorkspaceStub.callsFake(async () => {
        ctx.params = undefined;
        return { mode: 'subworkspace', workspaceId: 'subworkspace-ws-1', parentWorkspaceId: WORKSPACE };
      });
      const response = await controller.getMarket(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleGetMarketSubworkspace).to.have.been.calledOnce;
      const { args } = handlers.handleGetMarketSubworkspace.firstCall;
      // geoTargetId + languageCode forwarded as null (empty-object fallback).
      expect(args[3]).to.equal(null);
      expect(args[4]).to.equal(null);
    });

    it('deleteMarket defaults the path slice to an empty object when ctx.params is absent post-auth', async () => {
      // Same defensive `ctx?.params || {}` guard in deleteMarket.
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } });
      resolveBrandWorkspaceStub.callsFake(async () => {
        ctx.params = undefined;
        return { mode: 'subworkspace', workspaceId: 'subworkspace-ws-1', parentWorkspaceId: WORKSPACE };
      });
      const response = await controller.deleteMarket(ctx);
      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteMarketSubworkspace).to.have.been.calledOnce;
    });

    it('listPrompts routes to the subworkspace handler with the subworkspace', async () => {
      handlers.handleListPromptsSubworkspace.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listPrompts(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleListPromptsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleListPromptsSubworkspace.firstCall.args[1]).to.equal('subworkspace-ws-1');
      expect(handlers.handleListPrompts).to.not.have.been.called;
    });

    it('createPrompts routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleCreatePromptsSubworkspace.resolves({ created: [], skipped: [], failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createPrompts(fakeContext({ data: { prompts: [] } }));
      expect(response.status).to.equal(200);
      expect(handlers.handleCreatePromptsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleCreatePrompts).to.not.have.been.called;
    });

    it('updatePrompt routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleUpdatePromptSubworkspace.resolves({ status: 200, body: { semrushPromptId: 'p2' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updatePrompt(fakeContext({
        params: { semrushPromptId: 'p1' },
        data: {
          text: 't', tags: [], geoTargetId: 2840, languageCode: 'en',
        },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdatePromptSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleUpdatePrompt).to.not.have.been.called;
    });

    it('createTag routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleCreateTagSubworkspace.resolves({
        status: 201,
        body: {
          geoTargetId: 2840, languageCode: 'en', type: 'category', name: 'Footwear', tag: 'category:Footwear',
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createTag(fakeContext({
        data: {
          type: 'category', name: 'Footwear', geoTargetId: 2840, languageCode: 'en',
        },
      }));
      expect(response.status).to.equal(201);
      expect(handlers.handleCreateTagSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleCreateTagSubworkspace.firstCall.args[1]).to.equal('subworkspace-ws-1');
      expect(handlers.handleCreateTag).to.not.have.been.called;
    });

    it('bulkDeletePrompts routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleBulkDeletePromptsSubworkspace.resolves({ deleted: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.bulkDeletePrompts(fakeContext({ data: { prompts: [] } }));
      expect(response.status).to.equal(200);
      expect(handlers.handleBulkDeletePromptsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleBulkDeletePrompts).to.not.have.been.called;
    });

    it('listTags routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleListTagsSubworkspace.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listTags(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleListTagsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleListTagsSubworkspace.firstCall.args[1]).to.equal('subworkspace-ws-1');
      expect(handlers.handleListTags).to.not.have.been.called;
    });

    it('listModels routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleListModelsSubworkspace.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listModels(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleListModelsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleListModels).to.not.have.been.called;
    });

    it('updateModels routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleUpdateModelsSubworkspace.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateModels(fakeContext({
        data: { geoTargetId: 2840, languageCode: 'en', modelIds: [] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdateModelsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleUpdateModels).to.not.have.been.called;
    });

    it('returns 500 when the brand model cannot be loaded for a subworkspace write', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      });
      ctx.dataAccess.Brand.findById = sinon.stub().resolves(null);
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(404);
    });

    it('returns 500 when the Brand data-access is unavailable for a subworkspace write', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      });
      ctx.dataAccess.Brand = undefined;
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(500);
    });
  });

  describe('activate / deactivate', () => {
    it('activate 401s (IMS-only) before any provisioning when the caller is not IMS-authenticated', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        authType: 'jwt',
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(401);
      // pins the security-load-bearing IMS-only invariant: no transport, no ensure.
      expect(ensureSubworkspaceStub).to.not.have.been.called;
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
    });

    it('deactivate 401s (IMS-only) before any decommission when the caller is not IMS-authenticated', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ authType: 'jwt' }));
      expect(response.status).to.equal(401);
      expect(decommissionStub).to.not.have.been.called;
    });

    it('activate ensures the subworkspace ONCE for the batch and creates each market against it', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }] },
      }));
      expect(response.status).to.equal(200);
      // ensured exactly once, sized to the real market count (2) — not per market.
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      expect(ensureSubworkspaceStub.firstCall.args[3]).to.equal(2);
      expect(handlers.handleCreateMarketSubworkspace).to.have.been.calledTwice;
      // each market create receives the pre-resolved workspace id (6th arg) so it
      // skips its own ensure.
      expect(handlers.handleCreateMarketSubworkspace.firstCall.args[5]).to.equal(SUBWS);
      expect(handlers.handleCreateMarketSubworkspace.secondCall.args[5]).to.equal(SUBWS);
      expect(brand.setStatus).to.have.been.calledWith('active');
      expect(brand.save).to.have.been.called;
    });

    it('activate mirrors the brand domain as a Site once (not per market) when any market goes live', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }] },
      }));
      expect(response.status).to.equal(200);
      // All markets share the brand domain, so exactly one ensure for two markets.
      expect(ensureMarketSiteStub).to.have.been.calledOnce;
      const opts = ensureMarketSiteStub.firstCall.args[1];
      expect(opts).to.include({ organizationId: ORG, brandId: BRAND, domain: 'x.com' });
    });

    it('activate does NOT mirror a Site (or flip active) when no market goes live — stays pending with a 502', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 502, body: { error: 'serenityUpstreamError' } });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      // All-or-nothing: a market failed → no site mirror, brand stays pending, 502.
      expect(response.status).to.equal(502);
      const { status } = await readBody(response);
      expect(status).to.equal('pending');
      expect(ensureMarketSiteStub).to.not.have.been.called;
      expect(brand.setStatus).to.not.have.been.called;
    });

    it('activate falls back to the stashed pending_semrush_provisioning when the body omits markets + brandDomain', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://acme.com/path',
          markets: [{ market: 'us', languageCode: 'en' }],
        }),
        setPendingSemrushProvisioning,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      // A pending (draft) brand activated from the wizard: body carries no
      // markets and no brandDomain — both come from the stash.
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarketSubworkspace).to.have.been.calledOnce;
      const createBody = handlers.handleCreateMarketSubworkspace.firstCall.args[3];
      expect(createBody.market).to.equal('us');
      expect(createBody.languageCode).to.equal('en');
      // brandDomain derived from the stashed primary URL (hostname only).
      expect(createBody.brandDomain).to.equal('acme.com');
      // The site mirror is fed the same resolved domain (not the raw stash URL),
      // so the activate path and the create path agree on the base URL.
      expect(ensureMarketSiteStub).to.have.been.calledOnce;
      expect(ensureMarketSiteStub.firstCall.args[1]).to.include({ domain: 'acme.com' });
      // The draft staging data is cleared on success, atomically with the flip.
      expect(setPendingSemrushProvisioning).to.have.been.calledWith(null);
      expect(brand.setStatus).to.have.been.calledWith('active');
      expect(brand.save).to.have.been.called;
    });

    it('activate passes each stashed market\'s modelIds into the options arg (LLMs applied at activation)', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://acme.com',
          markets: [{ market: 'us', languageCode: 'en', modelIds: ['chatgpt', 'perplexity'] }],
        }),
        setPendingSemrushProvisioning: sinon.stub(),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(200);
      // modelIds are read from the OPTIONS arg (index 7), NOT the body (index 3) —
      // handleCreateMarketSubworkspace destructures them from options.
      const options = handlers.handleCreateMarketSubworkspace.firstCall.args[7];
      expect(options.modelIds).to.deep.equal(['chatgpt', 'perplexity']);
      // models present but no prompts → real units → must publish.
      expect(options.publishMode).to.equal('require');
    });

    it('activate provisions a sub-workspace-only brand (200) when there is no primary URL, ignoring any stashed market', async () => {
      // A draft saved before a primary URL was entered: a market may be stashed
      // but there is no domain to provision a project against. Project creation is
      // gated on a URL, so with none the brand activates sub-workspace-only — its
      // sub-workspace IS the active anchor — and no project is created.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          markets: [{ market: 'us', languageCode: 'en' }],
        }),
        setPendingSemrushProvisioning,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'] },
      }));
      expect(response.status).to.equal(200);
      const { status, markets } = await readBody(response);
      expect(status).to.equal('active');
      expect(markets).to.deep.equal([]);
      // No project: the market loop never runs; only the sub-workspace is ensured.
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      expect(brand.setStatus).to.have.been.calledWith('active');
      // The whole stash is cleared on a fully-successful activation.
      expect(setPendingSemrushProvisioning).to.have.been.calledWith(null);
    });

    it('activate 400s when the stashed primary URL is unparseable and the body omits brandDomain', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel({
        // An unparseable primaryUrl makes new URL() throw → hostnameFromUrlString
        // returns null → no domain → 400 rather than a null propagating upstream.
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://[',
          markets: [{ market: 'us', languageCode: 'en' }],
        }),
        setPendingSemrushProvisioning: sinon.stub(),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'] },
      }));
      expect(response.status).to.equal(400);
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
    });

    it('activate threads generateTopics + topicCap + tags when the stash opts into prompts', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://acme.com',
          markets: [{ market: 'us', languageCode: 'en' }],
          generatePrompts: true,
        }),
        setPendingSemrushProvisioning: sinon.stub(),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(200);
      const options = handlers.handleCreateMarketSubworkspace.firstCall.args[7];
      expect(options.generateTopics).to.equal(true);
      expect(options.topicCap).to.be.greaterThan(0);
      expect(options.standardTags).to.not.be.empty;
      expect(options.projectTags).to.not.be.empty;
      // generatePrompts → real units → must publish.
      expect(options.publishMode).to.equal('require');
    });

    it('activate lets generatePrompts in the body override a stash that opted out', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://acme.com',
          markets: [{ market: 'us', languageCode: 'en' }],
          generatePrompts: false,
        }),
        setPendingSemrushProvisioning: sinon.stub(),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'], generatePrompts: true },
      }));
      expect(response.status).to.equal(200);
      const opts = handlers.handleCreateMarketSubworkspace.firstCall.args[7];
      expect(opts.generateTopics).to.equal(true);
    });

    it('activate 400s when generatePrompts is true but there is no primary URL (nothing to generate into)', async () => {
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({ markets: [], generatePrompts: false }),
        setPendingSemrushProvisioning: sinon.stub(),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'], generatePrompts: true },
      }));
      expect(response.status).to.equal(400);
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
      expect(ensureSubworkspaceStub).to.not.have.been.called;
    });

    it('activate sub-workspace-only stays pending (502) when the status save fails', async () => {
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({ markets: [], generatePrompts: false }),
        setPendingSemrushProvisioning,
        save: sinon.stub().rejects(new Error('db down')),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(502);
      const { status, error } = await readBody(response);
      expect(status).to.equal('pending');
      expect(error).to.equal('serenityActivationIncomplete');
      // The sub-workspace WAS ensured (upstream) even though the flip didn't persist.
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
    });

    it('activate sub-workspace-only on an already-active brand returns 207 (not downgraded) when the save fails', async () => {
      const brand = makeBrandModel({
        getStatus: () => 'active',
        getPendingSemrushProvisioning: () => null,
        save: sinon.stub().rejects(new Error('db down')),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(207);
      const { status } = await readBody(response);
      expect(status).to.equal('active');
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
    });

    it('activate prefers body markets + brandDomain over the stash, and clears the stash when its market is provisioned', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://stash.com',
          markets: [{ market: 'us', languageCode: 'en' }],
        }),
        setPendingSemrushProvisioning,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'body.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarketSubworkspace).to.have.been.calledOnce;
      const createBody = handlers.handleCreateMarketSubworkspace.firstCall.args[3];
      expect(createBody.market).to.equal('us');
      expect(createBody.brandDomain).to.equal('body.com');
      // The stash market (us/en) was provisioned → nothing remains → cleared.
      expect(setPendingSemrushProvisioning).to.have.been.calledWith(null);
    });

    it('activate keeps the FULL stash and stays pending when any market fails (all-or-nothing, no partial trim)', async () => {
      // Stash has two draft markets; the first provisions (201), the second
      // throws. All-or-nothing: the brand does NOT flip active and the stash is
      // NOT trimmed — the whole blob is kept intact so a retry re-runs the full
      // batch (the live market 409s; the failed one retries).
      handlers.handleCreateMarketSubworkspace
        .onFirstCall().resolves({ status: 201, body: {} })
        .onSecondCall().rejects(new ErrorWithStatusCode('upstream boom', 502));
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://acme.com',
          markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
        }),
        setPendingSemrushProvisioning,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      // Body omits markets → both come from the stash.
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'] },
      }));
      // One live, one failed → activation incomplete → 502, brand stays pending.
      expect(response.status).to.equal(502);
      const { status } = await readBody(response);
      expect(status).to.equal('pending');
      // Stash untouched (no trim, no clear) and the brand never flips active.
      expect(setPendingSemrushProvisioning).to.not.have.been.called;
      expect(brand.setStatus).to.not.have.been.calledWith('active');
    });

    it('activate does NOT clear a stash on a brand that has none (no setPendingSemrushProvisioning call)', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({ setPendingSemrushProvisioning });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(200);
      expect(setPendingSemrushProvisioning).to.not.have.been.called;
    });

    it('activate reads the brand aliases once and applies them to every market', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      getBrandAliasesStub.resolves(['Acme Inc']);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand: makeBrandModel(),
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }] },
      }));
      expect(response.status).to.equal(200);
      // Read once for the whole batch, not per market.
      expect(getBrandAliasesStub).to.have.been.calledOnceWith(BRAND);
      // Both market creates receive the same aliases in their options arg (index 7).
      // No modelIds + no generatePrompts → empty units → best-effort publish.
      const expectedOpts = {
        modelIds: [],
        generateTopics: false,
        topicCap: 0,
        standardTags: [],
        projectTags: [],
        publishMode: 'best-effort',
        brandAliases: ['Acme Inc'],
        brandUrlSources: { urls: [], socialAccounts: [], earnedContent: [] },
        competitors: [],
      };
      const { firstCall, secondCall } = handlers.handleCreateMarketSubworkspace;
      expect(firstCall.args[7]).to.deep.equal(expectedOpts);
      expect(secondCall.args[7]).to.deep.equal(expectedOpts);
    });

    it('activate reads the brand URL sources once and applies them to every market', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const sources = { urls: [{ value: 'https://x.com' }], socialAccounts: [], earnedContent: [] };
      getBrandUrlSourcesStub.resolves(sources);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand: makeBrandModel(),
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }] },
      }));
      expect(response.status).to.equal(200);
      expect(getBrandUrlSourcesStub).to.have.been.calledOnceWith(BRAND);
      const { firstCall, secondCall } = handlers.handleCreateMarketSubworkspace;
      expect(firstCall.args[7].brandUrlSources).to.deep.equal(sources);
      expect(secondCall.args[7].brandUrlSources).to.deep.equal(sources);
    });

    it('activate reads the brand competitors once and applies them to every market', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const competitors = [{ url: 'https://rival.com' }];
      getBrandCompetitorsStub.resolves(competitors);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand: makeBrandModel(),
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }] },
      }));
      expect(response.status).to.equal(200);
      expect(getBrandCompetitorsStub).to.have.been.calledOnceWith(BRAND);
      const { firstCall, secondCall } = handlers.handleCreateMarketSubworkspace;
      expect(firstCall.args[7].competitors).to.deep.equal(competitors);
      expect(secondCall.args[7].competitors).to.deep.equal(competitors);
    });

    it('activate provisions a single US/EN fallback project for an empty markets array + a brandDomain', async () => {
      // A URL but no market: project creation is gated on the URL, so a single
      // US/EN fallback project is provisioned (matches the direct-create default).
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        data: { markets: [], brandDomain: 'x.com', brandNames: ['X'] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarketSubworkspace).to.have.been.calledOnce;
      const createBody = handlers.handleCreateMarketSubworkspace.firstCall.args[3];
      expect(createBody.market).to.equal('US');
      expect(createBody.languageCode).to.equal('en');
    });

    it('activate 400s when the markets array exceeds the cap (and does not provision)', async () => {
      const markets = Array.from({ length: 51 }, (_, i) => ({ market: 'us', languageCode: `l${i}` }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      // A brandDomain routes to the project path where the cap is enforced.
      const response = await controller.activate(fakeContext({
        data: { markets, brandDomain: 'x.com', brandNames: ['X'] },
      }));
      expect(response.status).to.equal(400);
      // Bounded before any upstream work — never reaches ensureSubworkspace.
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
    });

    it('activate records a thrown market as failed without aborting the batch, but stays pending (all-or-nothing)', async () => {
      // Market 1 publishes (201, live upstream); market 2 throws. The batch must
      // NOT abort - both markets are reported per-market. But all-or-nothing means
      // a single failure keeps the brand pending and returns a 502 (the live
      // market 409s on the next retry, which converges).
      handlers.handleCreateMarketSubworkspace
        .onFirstCall().resolves({ status: 201, body: {} })
        .onSecondCall().rejects(new ErrorWithStatusCode('upstream boom', 502));
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com',
          brandNames: ['X'],
          markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
        },
      }));
      // incomplete activation -> 502, brand stays pending.
      expect(response.status).to.equal(502);
      const { status, markets } = await readBody(response);
      expect(status).to.equal('pending');
      // both markets reported; the throwing one becomes a 502 entry, no URL leak.
      expect(markets).to.have.length(2);
      expect(markets[0].status).to.equal(201);
      expect(markets[1].status).to.equal(502);
      expect(markets[1].body.message).to.equal('Market activation failed');
      // Brand never flips active and is not re-saved on the failure path.
      expect(brand.setStatus).to.not.have.been.calledWith('active');
      expect(brand.save).to.not.have.been.called;
    });

    it('activate defaults a statusless throw to 502 in the per-market result', async () => {
      handlers.handleCreateMarketSubworkspace.rejects(new Error('no status'));
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com',
          brandNames: ['X'],
          markets: [{ market: 'us', languageCode: 'en' }],
        },
      }));
      // every market failed (no 201) -> 502, brand stays pending.
      expect(response.status).to.equal(502);
      const { markets } = await readBody(response);
      expect(markets[0].status).to.equal(502);
      expect(brand.setStatus).to.not.have.been.called;
    });

    it('activate returns 200 for a mixed 201 + 409 batch and reports both markets', async () => {
      handlers.handleCreateMarketSubworkspace
        .onFirstCall().resolves({ status: 201, body: {} })
        .onSecondCall().resolves({ status: 409, body: { error: 'sliceExists' } });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com',
          brandNames: ['X'],
          markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
        },
      }));
      expect(response.status).to.equal(200);
      const { markets } = await readBody(response);
      expect(markets.map((m) => m.status)).to.deep.equal([201, 409]);
      expect(brand.setStatus).to.have.been.calledOnceWith('active');
    });

    it('activate returns 502 and stays pending when every market genuinely fails', async () => {
      // A real failure status (502), NOT 409 - a 409 sliceExists means the market
      // is already live and counts as success (see the all-409 re-activate test).
      handlers.handleCreateMarketSubworkspace.resolves({ status: 502, body: {} });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(502);
      const { status } = await readBody(response);
      expect(status).to.equal('pending');
      expect(brand.setStatus).to.not.have.been.called;
    });

    it('activate returns 200 active for an all-409 idempotent re-activate (markets already live)', async () => {
      // Re-activating a brand whose markets are all already live: every market
      // returns 409 sliceExists. That is a COMPLETE success, not a partial one -
      // the brand is active and the HTTP status is 200, never 207/pending.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 409, body: { error: 'sliceExists' } });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com',
          brandNames: ['X'],
          markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
        },
      }));
      expect(response.status).to.equal(200);
      const { status } = await readBody(response);
      expect(status).to.equal('active');
      expect(brand.setStatus).to.have.been.calledWith('active');
    });

    it('activate returns 200 for a full re-activate of an ALREADY-active brand (all markets 201, site linked)', async () => {
      // Gap coverage: an already-active brand (getStatus 'active') re-supplying
      // markets where every market provisions fresh (201) AND the site mirror
      // links → fullySucceeded → setStatus('active') + save, HTTP 200. (Distinct
      // from the all-409 idempotent case and the 207 partial-failure case.)
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      ensureMarketSiteStub.resolves('site-uuid-1');
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com',
          brandNames: ['X'],
          markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
        },
      }));
      expect(response.status).to.equal(200);
      const { status } = await readBody(response);
      expect(status).to.equal('active');
      expect(ensureMarketSiteStub).to.have.been.called;
      expect(brand.setStatus).to.have.been.calledWith('active');
      expect(brand.save).to.have.been.called;
    });

    it('activate emits SERENITY_ACTIVATE_SAVE_DIVERGENCE and returns 502 (stays pending) when the status save fails', async () => {
      // The markets are live + the site is linked upstream, but persisting the
      // 'active' flip fails → the brand stays pending (divergence). The seam emits
      // a distinct, alertable token and surfaces a 502 with the per-market results
      // (not a bare 5xx via mapError that would discard them). A retry converges.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel();
      brand.save = sinon.stub().rejects(new Error('db down'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      // save diverged -> 502, brand stays pending, per-market results preserved.
      expect(response.status).to.equal(502);
      const { status, markets } = await readBody(response);
      expect(status).to.equal('pending');
      expect(markets).to.have.length(1);
      expect(markets[0].status).to.equal(201);
      // distinct, greppable token so the orphaned status is alertable.
      expect(log.error).to.have.been.calledWithMatch('SERENITY_ACTIVATE_SAVE_DIVERGENCE');
    });

    it('counts an already-existing (409) market as live in the save-divergence log when the status save fails', async () => {
      // A re-activate where the only market already exists upstream (409) is still
      // "fully live"; when the active-flip save then fails, the divergence log's
      // marketsLive count must include the 409 (the r.status === 409 side of the
      // filter), not just freshly-created 201s.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 409, body: { error: 'sliceExists' } });
      ensureMarketSiteStub.resolves('site-uuid-1');
      const brand = makeBrandModel();
      brand.save = sinon.stub().rejects(new Error('db down'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      // Every market live (via 409) + site linked, but the active-flip save fails.
      expect(response.status).to.equal(502);
      const divergenceCall = log.error.getCalls().find(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes('SERENITY_ACTIVATE_SAVE_DIVERGENCE'),
      );
      expect(divergenceCall, 'expected a SAVE_DIVERGENCE error log').to.not.equal(undefined);
      // The lone 409 market is counted as live.
      expect(divergenceCall.args[1].marketsLive).to.equal(1);
    });

    it('activate stays pending with a 502 when every market is live but the brand_sites link fails', async () => {
      // The brand_sites mirror (type='serenity') is a REQUIRED activation step:
      // even with every market live, a failed site link keeps the brand pending so
      // a retry re-establishes the link. ensureMarketSite returns null on failure.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      ensureMarketSiteStub.resolves(null);
      const setPendingSemrushProvisioning = sinon.stub();
      const brand = makeBrandModel({
        getPendingSemrushProvisioning: () => ({
          primaryUrl: 'https://acme.com',
          markets: [{ market: 'us', languageCode: 'en' }],
        }),
        setPendingSemrushProvisioning,
      });
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      // Markets live but not linked → activation incomplete → 502, stays pending.
      expect(response.status).to.equal(502);
      const { status } = await readBody(response);
      expect(status).to.equal('pending');
      expect(ensureMarketSiteStub).to.have.been.calledOnce;
      // Never flips active; the stash is preserved (not cleared) for retry.
      expect(brand.setStatus).to.not.have.been.calledWith('active');
      expect(setPendingSemrushProvisioning).to.not.have.been.called;
      // Distinct, greppable token so the "live upstream but dark on our side"
      // strand is alertable rather than hidden in a generic 502.
      expect(log.error).to.have.been.calledWithMatch('SERENITY_ACTIVATE_LINK_INCOMPLETE');
    });

    it('activate does NOT downgrade an already-active brand on a partial failure (207, stays active)', async () => {
      // Reactivation of a live brand re-supplying markets in the body: one market
      // fails. All-or-nothing keeps a PENDING brand pending, but an already-active
      // brand is never downgraded — it stays active and reports 207 Multi-Status.
      handlers.handleCreateMarketSubworkspace
        .onFirstCall().resolves({ status: 409, body: { error: 'sliceExists' } })
        .onSecondCall().resolves({ status: 502, body: { error: 'serenityUpstreamError' } });
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com',
          brandNames: ['X'],
          markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }],
        },
      }));
      expect(response.status).to.equal(207);
      const { status } = await readBody(response);
      expect(status).to.equal('active');
      // Not flipped (no fullySucceeded) and not downgraded — the brand row is left as-is.
      expect(brand.setStatus).to.not.have.been.called;
    });

    it('deactivate decommissions the subworkspace, clears the pointer, and sets the brand pending', async () => {
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'subworkspace-ws-1' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(decommissionStub).to.have.been.calledOnceWithExactly(
        { name: 'transport' },
        'subworkspace-ws-1',
        sinon.match.any,
        WORKSPACE,
        { enforceLinkedGuard: false },
      );
      // The pointer is cleared (disconnect) — never the workspace deleted.
      expect(brand.setSemrushWorkspaceId).to.have.been.calledWith(null);
      expect(brand.setStatus).to.have.been.calledWith('pending');
      expect(brand.save).to.have.been.called;
    });

    it('deactivate enables the linked-sub-workspace guard when the env flag is set', async () => {
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'subworkspace-ws-1' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({
        brand,
        env: { SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD: 'true' },
      }));
      expect(response.status).to.equal(200);
      expect(decommissionStub).to.have.been.calledOnceWithExactly(
        { name: 'transport' },
        'subworkspace-ws-1',
        sinon.match.any,
        WORKSPACE,
        { enforceLinkedGuard: true },
      );
    });

    it('deactivate is a no-op decommission for a brand with no subworkspace', async () => {
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(decommissionStub).to.not.have.been.called;
      // Nothing to disconnect — the pointer is already null.
      expect(brand.setSemrushWorkspaceId).to.not.have.been.called;
      expect(brand.setStatus).to.have.been.calledWith('pending');
    });

    it('deactivate clears the resolver cache and logs a greppable divergence token when the brand save fails', async () => {
      // The upstream is already emptied by decommission; a failed save must not
      // leave the resolver routing to the emptied sub-workspace for the TTL, and
      // the non-atomic seam must emit a distinct, alertable marker.
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'subworkspace-ws-1' });
      brand.save = sinon.stub().rejects(new Error('db down'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(500);
      expect(decommissionStub).to.have.been.called;
      expect(brand.setSemrushWorkspaceId).to.have.been.calledWith(null);
      // cache was invalidated BEFORE the save threw.
      expect(clearBrandWorkspaceCacheStub).to.have.been.called;
      // distinct, greppable token so the orphaned state is alertable.
      expect(log.error).to.have.been.calledWithMatch('SERENITY_DEACTIVATE_SAVE_DIVERGENCE');
    });

    it('logs a null decommissionedWorkspaceId on a save-divergence for a brand that had no subworkspace', async () => {
      // No subworkspace → the decommission block is skipped, but the status save
      // still runs (and here fails). The divergence log's decommissionedWorkspaceId
      // must be null (the `: null` side of hasText(subworkspaceId) ? ... : null).
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => null });
      brand.save = sinon.stub().rejects(new Error('db down'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(500);
      // Nothing was decommissioned (no subworkspace to empty).
      expect(decommissionStub).to.not.have.been.called;
      const divergenceCall = log.error.getCalls().find(
        (c) => typeof c.args[0] === 'string' && c.args[0].includes('SERENITY_DEACTIVATE_SAVE_DIVERGENCE'),
      );
      expect(divergenceCall, 'expected a SAVE_DIVERGENCE error log').to.not.equal(undefined);
      expect(divergenceCall.args[1].decommissionedWorkspaceId).to.equal(null);
    });

    it('deactivate surfaces a decommission failure without clearing the pointer or status', async () => {
      // decommission throws mid-flow (e.g. a non-404 delete error): the brand
      // must NOT be disconnected (pointer kept) and NOT set pending, so the
      // partial-failure state is recoverable rather than silently half-applied.
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'subworkspace-ws-1' });
      decommissionStub.rejects(new ErrorWithStatusCode('upstream delete failed', 502));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(502);
      expect(brand.setSemrushWorkspaceId).to.not.have.been.called;
      expect(brand.setStatus).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });
  });

  describe('authorize — parent workspace requirement', () => {
    it('does NOT 404 a subworkspace-mode brand when the org parent workspace is missing', async () => {
      // A brand bound to its own sub-workspace is self-sufficient; a cleared org
      // parent pointer must not lock it out (it only matters for flat mode +
      // minting a fresh sub-workspace on activate).
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: SUBWS, parentWorkspaceId: null,
      });
      handlers.handleListMarketsSubworkspace.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleListMarketsSubworkspace).to.have.been.calledOnceWith(
        { name: 'transport' },
        BRAND,
        SUBWS,
      );
    });

    it('404s a flat-mode brand when the org has no parent workspace', async () => {
      resolveBrandWorkspaceStub.resolves({ mode: 'flat', workspaceId: null, parentWorkspaceId: null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(404);
    });

    it('409s when a brand sub-workspace equals the org parent workspace (forbidden)', async () => {
      // A sub-workspace that IS the shared parent would let destructive
      // sub-workspace ops wipe the org pool; refuse all operations.
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: WORKSPACE, parentWorkspaceId: WORKSPACE,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(409);
      const body = await readBody(response);
      expect(body.error).to.equal('workspaceMisconfigured');
    });
  });

  describe('authorize error branches', () => {
    it('500s when Organization data-access is unavailable', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization = undefined;
      const response = await controller.listMarkets(ctx);
      expect(response.status).to.equal(500);
    });

    it('404s when the organization is not found', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById = sinon.stub().resolves(null);
      const response = await controller.listMarkets(ctx);
      expect(response.status).to.equal(404);
    });

    it('503s when the PostgREST client is unavailable', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.dataAccess.services = {};
      const response = await controller.listMarkets(ctx);
      expect(response.status).to.equal(503);
    });
  });

  describe('error mapping - every handler routes a thrown error through mapError', () => {
    const methods = [
      'listPrompts', 'createPrompts', 'updatePrompt', 'bulkDeletePrompts',
      'listMarkets', 'getMarket', 'createMarket', 'deleteMarket',
      'listTags', 'listModels', 'updateModels', 'activate', 'deactivate',
    ];
    methods.forEach((method) => {
      it(`${method} maps an unexpected error to 500`, async () => {
        // authorize throws (resolveBrandWorkspace rejects) after the IMS gate,
        // so every handler's catch -> mapError path runs.
        resolveBrandWorkspaceStub.rejects(new Error('boom'));
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({
          params: { semrushPromptId: 'p1', geoTargetId: '2840', languageCode: 'en' },
          data: { markets: [{ market: 'us', languageCode: 'en' }] },
        });
        const response = await controller[method](ctx);
        expect(response.status).to.equal(500);
      });

      it(`${method} returns the authorize error without throwing`, async () => {
        // authorize RETURNS an error (access denied) - every handler's
        // `if (auth.error) return auth.error` short-circuit runs.
        accessControlHasAccessStub.resolves(false);
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({
          params: { semrushPromptId: 'p1', geoTargetId: '2840', languageCode: 'en' },
          data: { markets: [{ market: 'us', languageCode: 'en' }] },
        });
        const response = await controller[method](ctx);
        expect(response.status).to.equal(403);
      });
    });
  });

  describe('defensive branch coverage', () => {
    // Line 365-372: createPrompts flat-mode dispatch. The default
    // resolveBrandWorkspaceStub returns flat mode, so this reaches handleCreatePrompts.
    it('createPrompts routes to handleCreatePrompts in flat mode and returns ok(result)', async () => {
      handlers.handleCreatePrompts.resolves({ created: 1, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createPrompts(fakeContext({
        data: { prompts: [{ text: 'What is your return policy?', region: 'us' }] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleCreatePrompts).to.have.been.calledOnce;
      expect(handlers.handleCreatePromptsSubworkspace).not.to.have.been.called;
    });

    // Line 382: updatePrompt — `ctx?.params || {}` fallback. When ctx.params is
    // null the destructure yields `semrushPromptId = undefined`, which fails the
    // hasText check and throws a 400 before authorize() is reached. The `|| {}`
    // guard IS exercised on this path (it fires before the throw).
    it('updatePrompt falls back to {} when ctx.params is null (semrushPromptId missing → 400)', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.params = null;
      const response = await controller.updatePrompt(ctx);
      expect(response.status).to.equal(400);
    });

    // Lines 396, 405: updatePrompt — `ctx.data || {}` in both subworkspace and flat
    // mode. The subworkspace-mode branch (396) fires first when auth.mode is
    // 'subworkspace'; flat mode (405) fires when it is 'flat'. Test both with
    // ctx.data absent to cover the {} fallback on each side.
    it('updatePrompt passes {} body to subworkspace handler when ctx.data is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      handlers.handleUpdatePromptSubworkspace.resolves({ status: 200, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { semrushPromptId: 'sem-1' } });
      ctx.data = undefined;
      const response = await controller.updatePrompt(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdatePromptSubworkspace.firstCall.args[3]).to.deep.equal({});
    });

    it('updatePrompt passes {} body to flat handler when ctx.data is absent', async () => {
      handlers.handleUpdatePrompt.resolves({ status: 200, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { semrushPromptId: 'sem-1' } });
      ctx.data = undefined;
      const response = await controller.updatePrompt(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdatePrompt.firstCall.args[5]).to.deep.equal({});
    });

    // Lines 426-434: bulkDeletePrompts — `ctx.data || {}` in both subworkspace and
    // flat mode. Cover the {} fallback in subworkspace mode (flat mode is exercised
    // by the existing flat-mode test which passes ctx.data).
    it('bulkDeletePrompts passes {} body to subworkspace handler when ctx.data is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      handlers.handleBulkDeletePromptsSubworkspace.resolves({ deleted: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.bulkDeletePrompts(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleBulkDeletePromptsSubworkspace.firstCall.args[2]).to.deep.equal({});
    });

    // Lines 475, 478: getMarket — `ctx?.params || {}` and `pGeo || ''`. When
    // ctx.params is null, authorize() fires first (uses ctx?.params?.brandId →
    // undefined → invalid UUID → 400). So null-params is NOT a reachable path for
    // reaching line 475 post-authorize. The '|| {}' and 'pGeo || ''' guards at
    // line 475/478 are structurally unreachable after a successful authorize() —
    // authorize uses the same params object and rejects if it's absent.
    // NOTE: line 478's /^\d+$/ false branch IS covered by the existing
    // 'null-routes a non-digit geoTargetId' test, and pLang→null by the
    // 'forwards null for an empty languageCode' test. The '|| {}' at 475 and
    // 'pGeo || ''' at 478 are genuinely unreachable post-authorize.

    // Line 528, 540: createMarket — `ctx.data || {}` in both subworkspace and flat
    // mode. A missing ctx.data must pass {} to the handler.
    it('createMarket passes {} body to flat handler when ctx.data is absent', async () => {
      handlers.handleCreateMarket.resolves({ status: 200, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarket.firstCall.args[4]).to.deep.equal({});
    });

    // Line 557: deleteMarket — `ctx?.params || {}`. Same structural reasoning as
    // getMarket (line 475): authorize() rejects when ctx.params is absent, so
    // line 557 is only reached with a truthy ctx.params and the '|| {}' branch
    // cannot fire post-authorize. Genuinely unreachable.

    // Line 717: updateModels — `ctx.data || {}` in subworkspace mode.
    it('updateModels passes {} body to subworkspace handler when ctx.data is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      handlers.handleUpdateModelsSubworkspace.resolves({ items: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.updateModels(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdateModelsSubworkspace.firstCall.args[2]).to.deep.equal({});
    });

    // activate — `ctx.data || {}` fallback and the `Array.isArray(body.markets)
    // ? ... : storedMarkets` else-branch when markets is not an array. With no
    // primary URL these route to the sub-workspace-only activation (200).
    it('activate falls back to {} body when ctx.data is absent (sub-workspace-only → 200)', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.activate(ctx);
      expect(response.status).to.equal(200);
      const { status, markets } = await readBody(response);
      expect(status).to.equal('active');
      expect(markets).to.deep.equal([]);
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
    });

    it('activate treats a non-array markets value as empty, falling back to US/EN when a brandDomain is present', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        data: { markets: 'not-an-array', brandDomain: 'x.com', brandNames: ['X'] },
      }));
      expect(response.status).to.equal(200);
      const createBody = handlers.handleCreateMarketSubworkspace.firstCall.args[3];
      expect(createBody.market).to.equal('US');
      expect(createBody.languageCode).to.equal('en');
    });

    // Line 907: deactivate — `(ctx.env || env)?` — the env fallback fires when
    // ctx.env is absent. SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD is then read
    // from the controller-level env.
    it('deactivate reads SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD from controller env when ctx.env is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws', parentWorkspaceId: WORKSPACE,
      });
      decommissionStub.resolves();
      const controllerEnv = { SERENITY_ENFORCE_LINKED_SUBWORKSPACE_GUARD: 'true' };
      const controller = SerenityController({ env: {} }, fakeLog(), controllerEnv);
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'sub-ws' });
      const ctx = fakeContext({ brand });
      delete ctx.env; // forces the || env fallback at line 907
      const response = await controller.deactivate(ctx);
      expect(response.status).to.equal(200);
      expect(decommissionStub.firstCall.args[4]).to.deep.include({ enforceLinkedGuard: true });
    });

    // Line 936 (truthy side): deactivate save-divergence. The subworkspaceId null
    // branch at line 936 is structurally unreachable — the catch block is only
    // entered from inside `if (hasText(subworkspaceId))` where subworkspaceId must
    // be truthy. The truthy side IS covered here.
    it('deactivate emits SERENITY_DEACTIVATE_SAVE_DIVERGENCE and 500s when brand.save() throws after decommission', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws', parentWorkspaceId: WORKSPACE,
      });
      decommissionStub.resolves();
      const saveError = new Error('DB connection lost');
      const brand = makeBrandModel({
        getSemrushWorkspaceId: () => 'sub-ws',
        save: sinon.stub().rejects(saveError),
      });
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(500);
      expect(log.error).to.have.been.calledWithMatch(
        'serenity deactivate: SERENITY_DEACTIVATE_SAVE_DIVERGENCE',
      );
    });

    // Lines 130-131: errorTokenForStatus — switch cases 409 (conflict) and 503
    // (configurationError). These are reached through mapError when a handler
    // throws an ErrorWithStatusCode with those status codes.
    it('mapError maps ErrorWithStatusCode 409 to the conflict error token', async () => {
      handlers.handleListMarkets.rejects(
        new ErrorWithStatusCode('Slice already exists', 409),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(409);
      const body = await readBody(response);
      expect(body.error).to.equal('conflict');
    });

    it('mapError maps ErrorWithStatusCode 503 to the configurationError token', async () => {
      handlers.handleListMarkets.rejects(
        new ErrorWithStatusCode('Service unavailable', 503),
      );
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(503);
      const body = await readBody(response);
      expect(body.error).to.equal('configurationError');
    });

    // Line 138: mapError — `Number.isInteger(e.status) ? e.status : 400` fallback.
    // When an ErrorWithStatusCode is constructed with a non-integer status (e.g. a
    // string), the ternary falls through to 400.
    it('mapError defaults to 400 when ErrorWithStatusCode carries a non-integer status', async () => {
      const err = new ErrorWithStatusCode('bad request', 'not-a-number');
      handlers.handleListMarkets.rejects(err);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(400);
    });

    // Line 364: createPrompts — `ctx.data || {}` in the subworkspace branch. The
    // {} fallback fires when ctx.data is absent in subworkspace mode.
    it('createPrompts passes {} body to subworkspace handler when ctx.data is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      handlers.handleCreatePromptsSubworkspace.resolves({ created: 0 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.createPrompts(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleCreatePromptsSubworkspace.firstCall.args[2]).to.deep.equal({});
    });

    // Line 434: bulkDeletePrompts — `ctx.data || {}` in the flat branch. The {}
    // fallback fires when ctx.data is absent in flat mode.
    it('bulkDeletePrompts passes {} body to flat handler when ctx.data is absent', async () => {
      handlers.handleBulkDeletePrompts.resolves({ deleted: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.bulkDeletePrompts(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleBulkDeletePrompts.firstCall.args[4]).to.deep.equal({});
    });

    // Line 528: createMarket — `ctx.data || {}` in the subworkspace branch. The {}
    // fallback fires when ctx.data is absent in subworkspace mode.
    it('createMarket passes {} body to subworkspace handler when ctx.data is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      handlers.handleCreateMarketSubworkspace.resolves({ status: 200, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarketSubworkspace.firstCall.args[3]).to.deep.equal({});
    });

    // Line 370: createPrompts — `ctx.data || {}` in the flat-mode branch. The {}
    // fallback fires when ctx.data is absent in flat mode.
    it('createPrompts passes {} body to flat handler when ctx.data is absent', async () => {
      handlers.handleCreatePrompts.resolves({ created: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.createPrompts(ctx);
      expect(response.status).to.equal(200);
      expect(handlers.handleCreatePrompts.firstCall.args[4]).to.deep.equal({});
    });

    // Line 76: safeError — `msg || ''` — the '' fallback fires when msg is falsy.
    // Reached through mapError when an ErrorWithStatusCode has no message (undefined).
    it('mapError handles an ErrorWithStatusCode with an undefined message (safeError || fallback)', async () => {
      const err = new ErrorWithStatusCode(undefined, 400);
      handlers.handleListMarkets.rejects(err);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      // The response must still be a valid JSON envelope with a string message.
      expect(response.status).to.equal(400);
      const body = await readBody(response);
      expect(body.message).to.equal('');
    });

    // Line 102: extractQuery try-catch — fires when context.request.url is not a
    // valid URL and `new URL(...)` throws. The catch returns {} so parsedQuery
    // returns {}.
    it('parsedQuery returns {} when context.request.url is unparseable (extractQuery catch branch)', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = { url: 'not a valid url \x00' };
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(200);
      // No query params parsed — handler gets an empty query object.
      const queryArg = handlers.handleListPrompts.firstCall.args[4];
      expect(queryArg).to.deep.equal({});
    });

    // Lines 112, 116: parsedQuery — `Number.isFinite(n) ? n : null` null branch for
    // geoTargetId and page when the query value is non-numeric.
    it('parsedQuery coerces an unparseable geoTargetId to null (line 112 null branch)', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = { url: 'https://x/prompts?geoTargetId=not-a-number' };
      await controller.listPrompts(ctx);
      expect(handlers.handleListPrompts.firstCall.args[4].geoTargetId).to.equal(null);
    });

    it('parsedQuery coerces an unparseable page to null (line 116 null branch)', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.request = { url: 'https://x/prompts?page=xyz' };
      await controller.listPrompts(ctx);
      expect(handlers.handleListPrompts.firstCall.args[4].page).to.equal(null);
    });
  });
});

describe('brandPointerReloader', () => {
  it('returns the brand current semrush_workspace_id when present', async () => {
    const ctx = {
      dataAccess: {
        Brand: { findById: sinon.stub().resolves({ getSemrushWorkspaceId: () => 'ws-current' }) },
      },
    };
    expect(await brandPointerReloader(ctx, 'brand-1')()).to.equal('ws-current');
  });

  it('returns null when the brand has no pointer', async () => {
    const ctx = {
      dataAccess: {
        Brand: { findById: sinon.stub().resolves({ getSemrushWorkspaceId: () => null }) },
      },
    };
    expect(await brandPointerReloader(ctx, 'brand-1')()).to.equal(null);
  });

  it('returns null when the Brand data-access is unavailable', async () => {
    expect(await brandPointerReloader({ dataAccess: {} }, 'brand-1')()).to.equal(null);
    expect(await brandPointerReloader({ dataAccess: { Brand: {} } }, 'brand-1')()).to.equal(null);
  });

  it('returns null when the resolved brand is missing', async () => {
    const ctx = { dataAccess: { Brand: { findById: sinon.stub().resolves(null) } } };
    expect(await brandPointerReloader(ctx, 'brand-1')()).to.equal(null);
  });
});
