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

use(chaiAsPromised);
use(sinonChai);

const ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '22222222-3333-4444-5555-666666666666';

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
    getSemrushWorkspaceId: () => 'child-ws-1',
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
} = {}) {
  return {
    env: {},
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
    handleListMarketsChild: sinon.stub(),
    handleGetMarketChild: sinon.stub(),
    handleCreateMarketChild: sinon.stub(),
    handleDeleteMarketChild: sinon.stub(),
  };
  let decommissionStub;
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
    // Default: legacy mode — existing assertions (handlers called with
    // WORKSPACE) hold unchanged. Child-mode tests override this stub.
    resolveBrandWorkspaceStub = sinon.stub().resolves({ mode: 'legacy', workspaceId: WORKSPACE });
    decommissionStub = sinon.stub().resolves();
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
      },
      '../../src/support/serenity/handlers/markets-child.js': {
        handleListMarketsChild: handlers.handleListMarketsChild,
        handleGetMarketChild: handlers.handleGetMarketChild,
        handleCreateMarketChild: handlers.handleCreateMarketChild,
        handleDeleteMarketChild: handlers.handleDeleteMarketChild,
      },
      '../../src/support/serenity/workspace-lifecycle.js': {
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

    it('404s when the org has no semrush_workspace_id', async () => {
      resolveWorkspaceIdStub.resolves(null);
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

  describe('dual-mode dispatch (child)', () => {
    beforeEach(() => {
      resolveBrandWorkspaceStub.resolves({ mode: 'child', workspaceId: 'child-ws-1' });
    });

    it('listMarkets routes to the child handler in child mode', async () => {
      handlers.handleListMarketsChild.resolves({
        items: [{
          brandId: BRAND, geoTargetId: 2840, languageCode: 'en', status: 'live',
        }],
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(200);
      expect(handlers.handleListMarketsChild).to.have.been.calledOnceWithExactly({ name: 'transport' }, BRAND, 'child-ws-1');
      expect(handlers.handleListMarkets).to.not.have.been.called;
    });

    it('getMarket routes to the child handler in child mode', async () => {
      handlers.handleGetMarketChild.resolves({
        brandId: BRAND, geoTargetId: 2840, languageCode: 'en', initialized: true,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.getMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'EN' } }));
      expect(response.status).to.equal(200);
      expect(handlers.handleGetMarketChild).to.have.been.calledOnce;
      expect(handlers.handleGetMarket).to.not.have.been.called;
    });

    it('createMarket routes to the child handler with the brand + parent workspace', async () => {
      handlers.handleCreateMarketChild.resolves({ status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' } });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(201);
      expect(handlers.handleCreateMarketChild).to.have.been.calledOnce;
      const { args } = handlers.handleCreateMarketChild.firstCall;
      expect(args[2]).to.equal(WORKSPACE); // parentWorkspaceId
    });

    it('deleteMarket routes to the child handler in child mode', async () => {
      handlers.handleDeleteMarketChild.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } }));
      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteMarketChild).to.have.been.calledOnce;
    });

    it('501s prompts/tags/models for child-mode brands', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      for (const method of ['listPrompts', 'createPrompts', 'bulkDeletePrompts', 'listTags', 'listModels', 'updateModels']) {
        // eslint-disable-next-line no-await-in-loop
        const response = await controller[method](fakeContext({ data: {} }));
        expect(response.status, method).to.equal(501);
      }
    });

    it('returns 500 when the brand model cannot be loaded for a child write', async () => {
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
  });

  describe('activate / deactivate', () => {
    it('activate creates each market and sets the brand active', async () => {
      handlers.handleCreateMarketChild.resolves({ status: 201, body: {} });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }, { market: 'de', languageCode: 'de' }] },
      }));
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarketChild).to.have.been.calledTwice;
      expect(brand.setStatus).to.have.been.calledWith('active');
      expect(brand.save).to.have.been.called;
    });

    it('activate 400s on an empty markets array', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ data: { markets: [] } }));
      expect(response.status).to.equal(400);
    });

    it('activate returns 207 and stays pending when every market fails', async () => {
      handlers.handleCreateMarketChild.resolves({ status: 409, body: {} });
      const brand = makeBrandModel();
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(207);
      expect(brand.setStatus).to.not.have.been.called;
    });

    it('deactivate decommissions the child workspace and sets the brand pending', async () => {
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => 'child-ws-1' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(decommissionStub).to.have.been.calledOnceWithExactly({ name: 'transport' }, 'child-ws-1', sinon.match.any);
      expect(brand.setStatus).to.have.been.calledWith('pending');
    });

    it('deactivate is a no-op decommission for a brand with no child workspace', async () => {
      const brand = makeBrandModel({ getSemrushWorkspaceId: () => null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(decommissionStub).to.not.have.been.called;
      expect(brand.setStatus).to.have.been.calledWith('pending');
    });
  });
});
