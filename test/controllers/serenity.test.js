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
  };
  let decommissionStub;
  let ensureSubworkspaceStub;
  let clearBrandWorkspaceCacheStub;
  let resolveWorkspaceIdStub;
  let resolveBrandWorkspaceStub;
  let createTransportStub;
  let resolveBrandUuidStub;
  let accessControlHasAccessStub;
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
    accessControlHasAccessStub = sinon.stub().resolves(true);
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
      '../../src/support/serenity/workspace-lifecycle.js': {
        ensureSubworkspace: ensureSubworkspaceStub,
        decommissionBrandWorkspace: decommissionStub,
      },
      '../../src/support/access-control-util.js': MockAccessControlUtil,
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: resolveBrandUuidStub,
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
      expect(body.message).to.equal('invalid access attempt');
      expect(JSON.stringify(body)).not.to.match(/leak/);
    });

    it('upstream SerenityTransportError 401 propagates as 401 authenticationRequired', async () => {
      handlers.handleListMarkets.rejects(new MockTransportError(401, 'token expired', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(401);
      const body = await readBody(response);
      expect(body.error).to.equal('authenticationRequired');
      expect(body.message).to.equal('token expired');
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

    it('deleteMarket routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } }));
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

    it('activate 400s on an empty markets array', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ data: { markets: [] } }));
      expect(response.status).to.equal(400);
    });

    it('activate records a thrown market as failed and keeps the published one live (no abort)', async () => {
      // Market 1 publishes (201, live upstream); market 2 throws. The batch must
      // NOT abort - the brand goes active (≥1 live) but the HTTP status is 207
      // because ≥1 market failed, surfacing the partial failure to the caller.
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
      // partial failure -> 207, even though the brand is active (one market live).
      expect(response.status).to.equal(207);
      const { markets } = await readBody(response);
      // both markets reported; the throwing one becomes a 502 entry, no URL leak.
      expect(markets).to.have.length(2);
      expect(markets[0].status).to.equal(201);
      expect(markets[1].status).to.equal(502);
      expect(markets[1].body.message).to.equal('Market activation failed');
      expect(brand.setStatus).to.have.been.calledWith('active');
      expect(brand.save).to.have.been.called;
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
      // every market failed (no 201) -> 207 multi-status, brand stays pending.
      expect(response.status).to.equal(207);
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

    it('activate returns 207 and stays pending when every market genuinely fails', async () => {
      // A real failure status (502), NOT 409 - a 409 sliceExists means the market
      // is already live and counts as success (see the all-409 re-activate test).
      handlers.handleCreateMarketSubworkspace.resolves({ status: 502, body: {} });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(207);
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

    it('deactivate clears the resolver cache even when the brand save fails', async () => {
      // The upstream is already emptied by decommission; a failed save must not
      // leave the resolver routing to the emptied sub-workspace for the TTL.
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'subworkspace-ws-1' });
      brand.save = sinon.stub().rejects(new Error('db down'));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(500);
      expect(decommissionStub).to.have.been.called;
      expect(brand.setSemrushWorkspaceId).to.have.been.calledWith(null);
      // cache was invalidated BEFORE the save threw.
      expect(clearBrandWorkspaceCacheStub).to.have.been.called;
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
