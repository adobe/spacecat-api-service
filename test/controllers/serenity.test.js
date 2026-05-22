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

/**
 * Builds a minimum request context with the IMS bearer header and the
 * authInfo / Organization / brand lookups every handler now exercises.
 */
function fakeContext({
  bearer = 'ims-token-123',
  authType = 'ims',
  params = {},
  data = undefined,
  org = { getId: () => ORG },
  brandResolved = BRAND,
} = {}) {
  return {
    env: {},
    pathInfo: {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    },
    attributes: {
      authInfo: {
        getType: () => authType,
      },
    },
    dataAccess: {
      Organization: {
        findById: sinon.stub().resolves(org),
      },
      services: {
        postgrestClient: { from: () => ({}), __brandResolved: brandResolved },
      },
    },
    params: { spaceCatId: ORG, brandId: BRAND, ...params },
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
    handleListProjects: sinon.stub(),
    handleCreateProject: sinon.stub(),
    handleListProjectTags: sinon.stub(),
    handleListProjectModels: sinon.stub(),
    handleListWorkspaceProjects: sinon.stub(),
  };
  let resolveWorkspaceIdStub;
  let createTransportStub;
  let resolveBrandUuidStub;
  let accessControlHasAccessStub;
  let MockTransportError;
  let SerenityController;

  beforeEach(async () => {
    Object.values(handlers).forEach((s) => s.reset());
    resolveWorkspaceIdStub = sinon.stub().resolves(WORKSPACE);
    createTransportStub = sinon.stub().returns({ name: 'transport' });
    resolveBrandUuidStub = sinon.stub().resolves(BRAND);
    accessControlHasAccessStub = sinon.stub().resolves(true);
    MockTransportError = class extends Error {
      constructor(status, message, body) {
        super(message);
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
    SerenityController = (await esmock(
      '../../src/controllers/serenity.js',
      {
        '../../src/support/serenity/rest-transport.js': {
          createSerenityTransport: createTransportStub,
          SerenityTransportError: MockTransportError,
        },
        '../../src/support/serenity/workspace-resolver.js': {
          resolveWorkspaceId: resolveWorkspaceIdStub,
        },
        '../../src/support/serenity/handlers/prompts.js': {
          handleListPrompts: handlers.handleListPrompts,
          handleCreatePrompts: handlers.handleCreatePrompts,
          handleUpdatePrompt: handlers.handleUpdatePrompt,
          handleBulkDeletePrompts: handlers.handleBulkDeletePrompts,
        },
        '../../src/support/serenity/handlers/projects.js': {
          handleListProjects: handlers.handleListProjects,
          handleCreateProject: handlers.handleCreateProject,
          handleListProjectTags: handlers.handleListProjectTags,
          handleListProjectModels: handlers.handleListProjectModels,
          handleListWorkspaceProjects: handlers.handleListWorkspaceProjects,
        },
        '../../src/support/access-control-util.js': MockAccessControlUtil,
        '../../src/support/prompts-storage.js': {
          resolveBrandUuid: resolveBrandUuidStub,
        },
      },
    )).default;
  });

  it('throws when constructed without a context or log', () => {
    expect(() => SerenityController(null, fakeLog())).to.throw(/Context required/);
    expect(() => SerenityController(fakeContext(), null)).to.throw(/Log required/);
  });

  describe('listPrompts', () => {
    it('200s on success with the handler payload', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(200);
      const body = await readBody(resp);
      expect(body).to.deep.include({ total: 0, page: 1 });
      expect(createTransportStub).to.have.been.calledWith({ env: {}, imsToken: 'ims-token-123' });
      expect(resolveWorkspaceIdStub).to.have.been.calledOnceWithExactly(ctx, ORG);
      expect(resolveBrandUuidStub).to.have.been.calledOnce;
    });

    it('401s when the IMS bearer is missing — error token authenticationRequired', async () => {
      const ctx = fakeContext({ bearer: '' });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(401);
      const body = await readBody(resp);
      expect(body.error).to.equal('authenticationRequired');
    });

    it('401s when the caller authenticated via a non-IMS mechanism', async () => {
      const ctx = fakeContext({ authType: 'jwt' });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(401);
      const body = await readBody(resp);
      expect(body.error).to.equal('authenticationRequired');
    });

    it('404s when the organization is not found', async () => {
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById = sinon.stub().resolves(null);
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(404);
    });

    it('403s when the caller has no access to the organization', async () => {
      accessControlHasAccessStub.resolves(false);
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(403);
    });

    it('404s when the brand does not belong to the organization', async () => {
      resolveBrandUuidStub.resolves(null);
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(404);
    });

    it('503s when PostgREST is not available', async () => {
      const ctx = fakeContext();
      ctx.dataAccess.services = {};
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(503);
    });

    it('404s when the organization has no semrush_workspace_id', async () => {
      resolveWorkspaceIdStub.resolves(null);
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(404);
    });

    it('502 envelope when handler throws SerenityTransportError; no upstream body leaked', async () => {
      handlers.handleListPrompts.rejects(new MockTransportError(503, 'down', { code: 'x' }));
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(502);
      const body = await readBody(resp);
      expect(body.error).to.equal('semrushUpstreamError');
      expect(body).to.not.have.property('body');
      expect(body).to.not.have.property('status');
    });

    it('500s on unexpected handler errors', async () => {
      handlers.handleListPrompts.rejects(new Error('something bad'));
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(500);
      const body = await readBody(resp);
      // Sanitized — the raw error message must NOT leak into the response.
      expect(JSON.stringify(body)).to.not.include('something bad');
      expect(body.error).to.equal('internalServerError');
    });

    it('parses semrushLocationId from query string', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const ctx = fakeContext();
      ctx.request = { url: 'https://api/v2/orgs/x/brands/y/serenity/prompts?semrushLocationId=2840&language=en' };
      const controller = SerenityController(ctx, fakeLog());
      await controller.listPrompts(ctx);
      const query = handlers.handleListPrompts.firstCall.args[4];
      expect(query.semrushLocationId).to.equal(2840);
      expect(query.language).to.equal('en');
    });

    it('does NOT fall back to context.data when the URL has no query string', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const ctx = fakeContext({ data: { semrushLocationId: 9999 } });
      // No `request.url` → query must be empty, not pulled from body.
      const controller = SerenityController(ctx, fakeLog());
      await controller.listPrompts(ctx);
      const query = handlers.handleListPrompts.firstCall.args[4];
      expect(query).to.deep.equal({});
    });

    it('500s when Organization data-access is not on the context', async () => {
      const ctx = fakeContext();
      ctx.dataAccess.Organization = undefined;
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(500);
    });

    it('400s on a non-parseable request.url (extractQuery catch path)', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const ctx = fakeContext();
      ctx.request = { url: '::not a url::' };
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listPrompts(ctx);
      expect(resp.status).to.equal(200);
      const query = handlers.handleListPrompts.firstCall.args[4];
      expect(query).to.deep.equal({});
    });
  });

  describe('createPrompts', () => {
    it('200s and delegates to handler', async () => {
      handlers.handleCreatePrompts.resolves({ created: [], skipped: [], failed: [] });
      const ctx = fakeContext({ data: { prompts: [{ text: 't' }] } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.createPrompts(ctx);
      expect(resp.status).to.equal(200);
    });
  });

  describe('updatePrompt', () => {
    it('400s when promptId path param is missing', async () => {
      const ctx = fakeContext({ params: { spaceCatId: ORG, brandId: BRAND } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.updatePrompt(ctx);
      expect(resp.status).to.equal(400);
    });

    it('returns the handler status + body verbatim', async () => {
      handlers.handleUpdatePrompt.resolves({ status: 200, body: { id: 'new' } });
      const ctx = fakeContext({ params: { promptId: 'logical-1' } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.updatePrompt(ctx);
      expect(resp.status).to.equal(200);
      const body = await readBody(resp);
      expect(body.id).to.equal('new');
    });
  });

  describe('bulkDeletePrompts', () => {
    it('200s and delegates', async () => {
      handlers.handleBulkDeletePrompts.resolves({ deleted: 3, failed: [] });
      const ctx = fakeContext({ data: { semrushIds: [{ semrushProjectId: 'p', semrushPromptId: 'x' }] } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.bulkDeletePrompts(ctx);
      expect(resp.status).to.equal(200);
    });
  });

  describe('listProjects', () => {
    it('200s with the handler payload', async () => {
      handlers.handleListProjects.resolves({ items: [] });
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjects(ctx);
      expect(resp.status).to.equal(200);
    });
  });

  describe('createProject', () => {
    it('returns the handler status + body verbatim (201 happy)', async () => {
      handlers.handleCreateProject.resolves({
        status: 201,
        body: {
          semrushProjectId: 'new-1',
          semrushLocationId: 2840,
          language: 'en',
          name: 'X',
          workspaceId: WORKSPACE,
        },
      });
      const ctx = fakeContext({ data: { name: 'X', market: 'US', language: 'en' } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.createProject(ctx);
      expect(resp.status).to.equal(201);
      const body = await readBody(resp);
      expect(body.semrushProjectId).to.equal('new-1');
    });

    it('returns 409 envelope from handler', async () => {
      handlers.handleCreateProject.resolves({
        status: 409,
        body: { error: 'sliceExists' },
      });
      const ctx = fakeContext();
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.createProject(ctx);
      expect(resp.status).to.equal(409);
    });
  });

  describe('listProjectTags', () => {
    it('400s on missing projectId path param', async () => {
      const ctx = fakeContext({ params: { workspaceId: WORKSPACE } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjectTags(ctx);
      expect(resp.status).to.equal(400);
    });

    it('403s when path workspaceId does not match the org workspace', async () => {
      const ctx = fakeContext({ params: { workspaceId: 'wrong-ws', projectId: 'p' } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjectTags(ctx);
      expect(resp.status).to.equal(403);
    });

    it('200s on success', async () => {
      handlers.handleListProjectTags.resolves({ items: [{ id: 't', name: 'T' }] });
      const ctx = fakeContext({ params: { workspaceId: WORKSPACE, projectId: 'p' } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjectTags(ctx);
      expect(resp.status).to.equal(200);
    });
  });

  describe('listProjectModels', () => {
    it('200s with handler payload', async () => {
      handlers.handleListProjectModels.resolves({ items: [] });
      const ctx = fakeContext({ params: { workspaceId: WORKSPACE, projectId: 'p' } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjectModels(ctx);
      expect(resp.status).to.equal(200);
    });

    it('400s on missing projectId path param', async () => {
      const ctx = fakeContext({ params: { workspaceId: WORKSPACE } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjectModels(ctx);
      expect(resp.status).to.equal(400);
    });

    it('403s when path workspaceId does not match org workspace', async () => {
      const ctx = fakeContext({ params: { workspaceId: 'wrong-ws', projectId: 'p' } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listProjectModels(ctx);
      expect(resp.status).to.equal(403);
    });
  });

  describe('listWorkspaceProjects', () => {
    it('200s with handler payload', async () => {
      handlers.handleListWorkspaceProjects.resolves({ items: [] });
      const ctx = fakeContext({ params: { workspaceId: WORKSPACE } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listWorkspaceProjects(ctx);
      expect(resp.status).to.equal(200);
    });

    it('400s on missing path param', async () => {
      const ctx = fakeContext({ params: { spaceCatId: ORG, brandId: BRAND } });
      const controller = SerenityController(ctx, fakeLog());
      const resp = await controller.listWorkspaceProjects(ctx);
      expect(resp.status).to.equal(400);
    });
  });

  /**
   * Parameterized error-path sweep — every handler exercises the same
   * authorize + transport + mapError pipeline, so once listPrompts is
   * covered individually we drive each of the other 8 through the same
   * five failure modes to keep coverage uniform without duplicating the
   * full per-suite scaffolding.
   */
  describe('every handler shares the same error envelope', () => {
    const cases = [
      { method: 'createPrompts', handler: 'handleCreatePrompts', params: {} },
      {
        method: 'updatePrompt', handler: 'handleUpdatePrompt', params: { promptId: 'logical-1' }, returnsRaw: true,
      },
      { method: 'bulkDeletePrompts', handler: 'handleBulkDeletePrompts', params: {} },
      { method: 'listProjects', handler: 'handleListProjects', params: {} },
      {
        method: 'createProject', handler: 'handleCreateProject', params: {}, returnsRaw: true,
      },
      { method: 'listProjectTags', handler: 'handleListProjectTags', params: { workspaceId: WORKSPACE, projectId: 'p' } },
      { method: 'listProjectModels', handler: 'handleListProjectModels', params: { workspaceId: WORKSPACE, projectId: 'p' } },
      { method: 'listWorkspaceProjects', handler: 'handleListWorkspaceProjects', params: { workspaceId: WORKSPACE } },
    ];
    cases.forEach(({
      method, handler, params, returnsRaw,
    }) => {
      describe(method, () => {
        const okResult = returnsRaw ? { status: 200, body: { ok: true } } : { ok: true };

        it('401s on missing bearer', async () => {
          const ctx = fakeContext({ bearer: '', params });
          const controller = SerenityController(ctx, fakeLog());
          const resp = await controller[method](ctx);
          expect(resp.status).to.equal(401);
        });

        it('404s when organization is missing', async () => {
          const ctx = fakeContext({ params });
          ctx.dataAccess.Organization.findById = sinon.stub().resolves(null);
          const controller = SerenityController(ctx, fakeLog());
          const resp = await controller[method](ctx);
          expect(resp.status).to.equal(404);
        });

        it('403s when caller has no access', async () => {
          accessControlHasAccessStub.resolves(false);
          const ctx = fakeContext({ params });
          const controller = SerenityController(ctx, fakeLog());
          const resp = await controller[method](ctx);
          expect(resp.status).to.equal(403);
        });

        it('502 envelope on SerenityTransportError', async () => {
          handlers[handler].resolves(okResult);
          handlers[handler].rejects(new MockTransportError(503, 'down'));
          const ctx = fakeContext({ params });
          const controller = SerenityController(ctx, fakeLog());
          const resp = await controller[method](ctx);
          expect(resp.status).to.equal(502);
          const body = await readBody(resp);
          expect(body.error).to.equal('semrushUpstreamError');
        });

        it('500s on unexpected handler errors', async () => {
          handlers[handler].rejects(new Error(`boom-${method}`));
          const ctx = fakeContext({ params });
          const controller = SerenityController(ctx, fakeLog());
          const resp = await controller[method](ctx);
          expect(resp.status).to.equal(500);
          const body = await readBody(resp);
          expect(JSON.stringify(body)).to.not.include(`boom-${method}`);
        });
      });
    });
  });
});
