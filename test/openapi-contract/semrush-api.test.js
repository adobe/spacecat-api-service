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

/* eslint-disable max-len -- OpenAPI contract tests for /semrush/* endpoints */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { loadBundledSpec, operationsForTag } from './_lib/openapi-loader.js';

use(chaiAsPromised);
use(sinonChai);

const ORG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BRAND = '11111111-2222-3333-4444-555555555555';
// Semrush workspace IDs are UUIDs per SemrushProjectRow.workspaceId schema;
// use a v4 UUID so AJV's `format: uuid` validator accepts the fixtures.
const WORKSPACE = '22222222-3333-4444-5555-666666666666';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function fakeContext({ params = {}, data = undefined } = {}) {
  return {
    env: {},
    pathInfo: { headers: { authorization: 'Bearer ims-token' } },
    dataAccess: {},
    params: { spaceCatId: ORG, brandId: BRAND, ...params },
    data,
  };
}

async function readJsonBody(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Fixtures: deterministic, OpenAPI-compliant handler responses for each
 * operation. The contract test stubs the handler to return these, calls the
 * controller, and validates the body against the OpenAPI response schema.
 *
 * Per-operation `expectedStatus` lets the bulk runner pick the right schema
 * (createSemrushProject is 201, everything else is 200).
 */
const FIXTURES = {
  listSemrushPrompts: {
    expectedStatus: 200,
    controllerMethod: 'listPrompts',
    handlerName: 'handleListPrompts',
    handlerResult: {
      items: [
        {
          id: 'eyJiIjoiYSIsImwiOjI4NDAsImxhbmciOiJlbiIsInQiOiJzYW1wbGUifQ',
          semrushId: 'sem-1',
          semrushProjectId: 'proj-1',
          semrushLocationId: 2840,
          language: 'en',
          text: 'sample',
          tags: ['topic-a'],
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    },
  },
  createSemrushPrompts: {
    expectedStatus: 200,
    controllerMethod: 'createPrompts',
    handlerName: 'handleCreatePrompts',
    handlerResult: {
      created: [{
        id: 'eyJiIjoiYSIsImwiOjI4NDAsImxhbmciOiJlbiIsInQiOiJzYW1wbGUifQ',
        semrushId: 'sem-1',
        semrushProjectId: 'proj-1',
        semrushLocationId: 2840,
        language: 'en',
        text: 'sample',
        tags: [],
      }],
      skipped: [{ text: 'dup', reason: 'duplicate within batch' }],
      failed: [{
        text: 'bad', semrushProjectId: 'proj-1', status: 502, message: 'upstream',
      }],
    },
  },
  updateSemrushPrompt: {
    expectedStatus: 200,
    controllerMethod: 'updatePrompt',
    handlerName: 'handleUpdatePrompt',
    handlerResult: {
      status: 200,
      body: {
        id: 'eyJiIjoiYSIsImwiOjI4NDAsImxhbmciOiJlbiIsInQiOiJzYW1wbGUifQ',
        semrushId: 'sem-2',
        semrushProjectId: 'proj-1',
        semrushLocationId: 2840,
        language: 'en',
        text: 'new text',
        tags: [],
      },
    },
    params: { promptId: 'eyJiIjoiYSIsImwiOjI4NDAsImxhbmciOiJlbiIsInQiOiJzYW1wbGUifQ' },
  },
  bulkDeleteSemrushPrompts: {
    expectedStatus: 200,
    controllerMethod: 'bulkDeletePrompts',
    handlerName: 'handleBulkDeletePrompts',
    handlerResult: {
      deleted: 2,
      failed: [{
        semrushProjectId: 'proj-x', semrushPromptId: 's-y', status: 502, message: 'oh',
      }],
    },
  },
  listSemrushProjects: {
    expectedStatus: 200,
    controllerMethod: 'listProjects',
    handlerName: 'handleListProjects',
    handlerResult: {
      items: [{
        brandId: BRAND,
        semrushProjectId: 'proj-1',
        semrushLocationId: 2840,
        language: 'en',
        name: 'Adobe',
        domain: 'adobe.com',
        workspaceId: WORKSPACE,
      }],
    },
  },
  createSemrushProject: {
    expectedStatus: 201,
    controllerMethod: 'createProject',
    handlerName: 'handleCreateProject',
    handlerResult: {
      status: 201,
      body: {
        semrushProjectId: 'new-1',
        semrushLocationId: 2840,
        language: 'en',
        name: 'X',
        workspaceId: WORKSPACE,
      },
    },
  },
  listSemrushProjectTags: {
    expectedStatus: 200,
    controllerMethod: 'listProjectTags',
    handlerName: 'handleListProjectTags',
    handlerResult: { items: [{ id: 't1', name: 'Topic A' }] },
    params: { workspaceId: WORKSPACE, projectId: 'p' },
  },
  listSemrushProjectModels: {
    expectedStatus: 200,
    controllerMethod: 'listProjectModels',
    handlerName: 'handleListProjectModels',
    handlerResult: {
      models: [{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: 'icon-url',
      }],
    },
    params: { workspaceId: WORKSPACE, projectId: 'p' },
  },
  listSemrushWorkspaceProjects: {
    expectedStatus: 200,
    controllerMethod: 'listWorkspaceProjects',
    handlerName: 'handleListWorkspaceProjects',
    handlerResult: { projects: [{ id: 'p1', name: 'Adobe', domain: 'adobe.com' }] },
    params: { workspaceId: WORKSPACE },
  },
};

function makeAjv() {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
  });
  addFormats(ajv);
  return ajv;
}

describe('OpenAPI contract — /semrush/* endpoints', () => {
  const spec = loadBundledSpec();
  const ops = operationsForTag(spec, 'semrush');
  const opsByOperationId = new Map(ops.map((o) => [o.operationId, o]));

  it('every operationId in semrush-api.yaml has a fixture in this test file', () => {
    const ids = ops.map((o) => o.operationId).sort();
    const fixtureKeys = Object.keys(FIXTURES).sort();
    expect(ids).to.deep.equal(fixtureKeys);
  });

  /**
   * Each operationId in the spec gets a generated test that:
   * 1. stubs the handler to return the fixture
   * 2. calls the controller
   * 3. asserts the response status matches what OpenAPI declares
   * 4. AJV-validates the response body against the operation's response schema
   *
   * Schema drift (handler adds an undocumented field, omits a required one,
   * uses a wrong type) trips this immediately.
   */
  Object.entries(FIXTURES).forEach(([operationId, fx]) => {
    it(`${operationId} response conforms to OpenAPI schema`, async () => {
      const op = opsByOperationId.get(operationId);
      expect(op, `operation ${operationId} not found in spec`).to.exist;

      const responseSchema = op.responseSchema(fx.expectedStatus);
      expect(responseSchema, `no ${fx.expectedStatus} schema for ${operationId}`).to.exist;

      const handlerStubs = {
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
      handlerStubs[fx.handlerName].resolves(fx.handlerResult);

      const SemrushController = (await esmock(
        '../../src/controllers/semrush.js',
        {
          '../../src/support/semrush/rest-transport.js': {
            createSemrushTransport: () => ({}),
            SemrushTransportError: class extends Error {},
          },
          '../../src/support/semrush/workspace-resolver.js': {
            resolveWorkspaceId: () => Promise.resolve(WORKSPACE),
          },
          '../../src/support/semrush/handlers/prompts.js': {
            handleListPrompts: handlerStubs.handleListPrompts,
            handleCreatePrompts: handlerStubs.handleCreatePrompts,
            handleUpdatePrompt: handlerStubs.handleUpdatePrompt,
            handleBulkDeletePrompts: handlerStubs.handleBulkDeletePrompts,
          },
          '../../src/support/semrush/handlers/projects.js': {
            handleListProjects: handlerStubs.handleListProjects,
            handleCreateProject: handlerStubs.handleCreateProject,
            handleListProjectTags: handlerStubs.handleListProjectTags,
            handleListProjectModels: handlerStubs.handleListProjectModels,
            handleListWorkspaceProjects: handlerStubs.handleListWorkspaceProjects,
          },
        },
      )).default;

      const ctx = fakeContext({ params: fx.params || {}, data: fx.data });
      const controller = SemrushController(ctx, fakeLog());
      const response = await controller[fx.controllerMethod](ctx);

      expect(response.status).to.equal(fx.expectedStatus);

      const body = await readJsonBody(response);
      const ajv = makeAjv();
      const validate = ajv.compile(responseSchema);
      const ok = validate(body);
      if (!ok) {
        const detail = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message} (${JSON.stringify(e.params)})`).join('\n  ');
        throw new Error(`AJV validation failed for ${operationId} ${fx.expectedStatus} response:\n  ${detail}\nbody: ${JSON.stringify(body, null, 2)}`);
      }
      expect(ok).to.equal(true);
    });
  });
});
