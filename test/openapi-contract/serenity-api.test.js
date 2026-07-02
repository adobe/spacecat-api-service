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

/* eslint-disable max-len -- OpenAPI contract tests for /serenity/* endpoints */

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
const WORKSPACE = '22222222-3333-4444-5555-666666666666';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function fakeContext({ params = {}, data = undefined, query = {} } = {}) {
  return {
    env: {},
    pathInfo: { headers: { authorization: 'Bearer ims-token' } },
    attributes: { authInfo: { getType: () => 'ims' } },
    dataAccess: {
      Organization: { findById: sinon.stub().resolves({ getId: () => ORG }) },
      Brand: {
        findById: sinon.stub().resolves({
          getId: () => BRAND,
          getName: () => 'Test Brand',
          getOrganizationId: () => ORG,
          getSemrushSubWorkspaceId: () => null,
          setSemrushSubWorkspaceId: sinon.stub(),
          setStatus: sinon.stub(),
          save: sinon.stub().resolves(),
        }),
      },
      services: { postgrestClient: { from: () => ({}) } },
    },
    params: { spaceCatId: ORG, brandId: BRAND, ...params },
    data,
    query,
  };
}

async function readJsonBody(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Fixtures: deterministic handler responses for each operationId in
 * docs/openapi/serenity-api.yaml. The contract test stubs the handler to
 * return these, calls the controller, and AJV-validates the response body
 * against the documented OpenAPI response schema.
 *
 * Schema drift (handler adds an undocumented field, omits a required one,
 * uses a wrong type) trips this immediately.
 *
 * `controllerMethod` is the function exported by `SerenityController(...)`;
 * `handlerName` is the underlying handler stubbed via esmock; both match
 * the surface introduced by LLMO-5190 (no `id`, no `semrushLocationId`).
 * `expectedStatus` is the documented success status (deleteSerenityMarket
 * is 204 no-body).
 */
const FIXTURES = {
  listSerenityPrompts: {
    expectedStatus: 200,
    controllerMethod: 'listPrompts',
    handlerName: 'handleListPrompts',
    handlerResult: {
      items: [{
        semrushPromptId: 'sem-1',
        geoTargetId: 2840,
        languageCode: 'en',
        text: 'sample',
        tagMap: { 'topic-a': 't-1' },
      }],
      total: 1,
      page: 1,
      limit: 50,
    },
    query: { geoTargetId: '2840', languageCode: 'en', tagIds: ['t-1'] },
  },
  createSerenityPrompts: {
    expectedStatus: 200,
    controllerMethod: 'createPrompts',
    handlerName: 'handleCreatePrompts',
    handlerResult: {
      created: [{
        semrushPromptId: 'sem-1',
        geoTargetId: 2840,
        languageCode: 'en',
        text: 'sample',
      }],
      skipped: [],
      failed: [],
    },
    data: {
      prompts: [{
        text: 'sample', tags: ['topic-a'], geoTargetId: 2840, languageCode: 'en',
      }],
    },
  },
  updateSerenityPrompt: {
    expectedStatus: 200,
    controllerMethod: 'updatePrompt',
    handlerName: 'handleUpdatePrompt',
    handlerResult: {
      status: 200,
      body: {
        semrushPromptId: 'sem-new',
        geoTargetId: 2840,
        languageCode: 'en',
        text: 'new text',
      },
    },
    params: { semrushPromptId: 'sem-1' },
    data: { geoTargetId: 2840, languageCode: 'en', text: 'new text' },
  },
  bulkDeleteSerenityPrompts: {
    expectedStatus: 200,
    controllerMethod: 'bulkDeletePrompts',
    handlerName: 'handleBulkDeletePrompts',
    handlerResult: { deleted: 1, failed: [] },
    data: {
      prompts: [{ semrushPromptId: 'sem-1', geoTargetId: 2840, languageCode: 'en' }],
    },
  },
  listSerenityMarkets: {
    expectedStatus: 200,
    controllerMethod: 'listMarkets',
    handlerName: 'handleListMarkets',
    handlerResult: {
      items: [{
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
      }],
    },
  },
  createSerenityMarket: {
    expectedStatus: 201,
    controllerMethod: 'createMarket',
    handlerName: 'handleCreateMarket',
    handlerResult: {
      status: 201,
      body: {
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
      },
    },
    data: {
      market: 'US', languageCode: 'en', brandDomain: 'adobe.com', brandNames: ['Adobe'],
    },
  },
  getSerenityMarket: {
    expectedStatus: 200,
    controllerMethod: 'getMarket',
    handlerName: 'handleGetMarket',
    handlerResult: {
      brandId: BRAND,
      geoTargetId: 2840,
      languageCode: 'en',
      semrushProjectId: 'proj-us-en',
    },
    params: { geoTargetId: '2840', languageCode: 'en' },
  },
  deleteSerenityMarket: {
    expectedStatus: 204,
    controllerMethod: 'deleteMarket',
    handlerName: 'handleDeleteMarket',
    handlerResult: { status: 204 },
    params: { geoTargetId: '2840', languageCode: 'en' },
  },
  listSerenityTags: {
    expectedStatus: 200,
    controllerMethod: 'listTags',
    handlerName: 'handleListTags',
    handlerResult: { items: [{ id: 't1', name: 'Topic A' }] },
    query: { geoTargetId: '2840', languageCode: 'en' },
  },
  createSerenityTag: {
    expectedStatus: 201,
    controllerMethod: 'createTag',
    handlerName: 'handleCreateTag',
    handlerResult: {
      status: 201,
      body: {
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
        type: 'category',
        name: 'Running Shoes',
        tag: 'category:Running Shoes',
      },
    },
    data: {
      type: 'category', name: 'Running Shoes', geoTargetId: 2840, languageCode: 'en',
    },
  },
  listSerenityModels: {
    expectedStatus: 200,
    controllerMethod: 'listModels',
    handlerName: 'handleListModels',
    handlerResult: {
      items: [{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: 'icon-url',
      }],
    },
    query: { geoTargetId: '2840', languageCode: 'en' },
  },
  updateSerenityModels: {
    expectedStatus: 200,
    controllerMethod: 'updateModels',
    handlerName: 'handleUpdateModels',
    handlerResult: {
      items: [{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: 'icon-url',
      }],
    },
    data: { geoTargetId: 2840, languageCode: 'en', modelIds: ['m1'] },
  },
  activateSerenityBrand: {
    expectedStatus: 200,
    controllerMethod: 'activate',
    // activate orchestrates per-market subworkspace creates; stubbing the subworkspace
    // market handler is enough to drive the documented 200 (≥1 live) shape.
    handlerName: 'handleCreateMarketSubworkspace',
    handlerResult: {
      status: 201,
      body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' },
    },
    data: {
      brandDomain: 'adobe.com',
      brandNames: ['Adobe'],
      brandDisplayName: 'Adobe',
      markets: [{ market: 'US', languageCode: 'en' }],
    },
  },
  deactivateSerenityBrand: {
    expectedStatus: 200,
    controllerMethod: 'deactivate',
    handlerName: 'decommissionBrandWorkspace',
    handlerResult: undefined,
  },
  listSerenityOrgModels: {
    expectedStatus: 200,
    controllerMethod: 'listOrgModels',
    handlerName: 'listGlobalModelCatalog',
    handlerResult: {
      items: [{
        id: 'm1', key: 'gpt-4o', name: 'GPT-4o', icon: 'icon-url',
      }],
    },
  },
  listSerenityOrgLanguages: {
    expectedStatus: 200,
    controllerMethod: 'listOrgLanguages',
    handlerName: 'listLanguageCatalog',
    handlerResult: {
      items: [{ id: 'lang-en', name: 'English' }],
    },
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

describe('OpenAPI contract — /serenity/* endpoints', function specSuite() {
  // First esmock load of the controller takes ~2s in isolation, more under
  // mocha --parallel where the worker process is contended. Bump the per-test
  // timeout so the cold-start first run doesn't flake the suite.
  this.timeout(30000);

  const spec = loadBundledSpec();
  const ops = operationsForTag(spec, 'serenity');
  const opsByOperationId = new Map(ops.map((o) => [o.operationId, o]));

  it('every operationId in serenity-api.yaml has a fixture in this test file', () => {
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
   * The 204 deleteMarket path has no response body — the AJV step is skipped.
   */
  Object.entries(FIXTURES).forEach(([operationId, fx]) => {
    it(`${operationId} response conforms to OpenAPI schema`, async () => {
      const op = opsByOperationId.get(operationId);
      expect(op, `operation ${operationId} not found in spec`).to.exist;

      const handlerStubs = {
        handleListPrompts: sinon.stub(),
        handleCreatePrompts: sinon.stub(),
        handleUpdatePrompt: sinon.stub(),
        handleBulkDeletePrompts: sinon.stub(),
        handleListMarkets: sinon.stub(),
        handleGetMarket: sinon.stub(),
        handleCreateMarket: sinon.stub(),
        handleDeleteMarket: sinon.stub(),
        handleListTags: sinon.stub(),
        handleCreateTag: sinon.stub(),
        handleListModels: sinon.stub(),
        handleUpdateModels: sinon.stub(),
        handleCreateMarketSubworkspace: sinon.stub(),
        ensureSubworkspace: sinon.stub().resolves(WORKSPACE),
        decommissionBrandWorkspace: sinon.stub(),
        listGlobalModelCatalog: sinon.stub(),
        listLanguageCatalog: sinon.stub(),
      };
      handlerStubs[fx.handlerName].resolves(fx.handlerResult);

      const SerenityController = (await esmock(
        '../../src/controllers/serenity.js',
        {
          '../../src/support/serenity/rest-transport.js': {
            createSerenityTransport: () => ({}),
            SerenityTransportError: class extends Error {},
          },
          '../../src/support/serenity/workspace-resolver.js': {
            resolveWorkspaceId: () => Promise.resolve(WORKSPACE),
            resolveBrandWorkspace: () => Promise.resolve({
              mode: 'flat', workspaceId: WORKSPACE, parentWorkspaceId: WORKSPACE,
            }),
          },
          '../../src/support/access-control-util.js': {
            default: { fromContext: () => ({ hasAccess: () => Promise.resolve(true) }) },
          },
          '../../src/support/prompts-storage.js': {
            resolveBrandUuid: () => Promise.resolve(BRAND),
          },
          '../../src/support/serenity/handlers/prompts.js': {
            handleListPrompts: handlerStubs.handleListPrompts,
            handleCreatePrompts: handlerStubs.handleCreatePrompts,
            handleUpdatePrompt: handlerStubs.handleUpdatePrompt,
            handleBulkDeletePrompts: handlerStubs.handleBulkDeletePrompts,
          },
          '../../src/support/serenity/handlers/markets.js': {
            handleListMarkets: handlerStubs.handleListMarkets,
            handleGetMarket: handlerStubs.handleGetMarket,
            handleCreateMarket: handlerStubs.handleCreateMarket,
            handleDeleteMarket: handlerStubs.handleDeleteMarket,
            handleListTags: handlerStubs.handleListTags,
            handleListModels: handlerStubs.handleListModels,
            handleUpdateModels: handlerStubs.handleUpdateModels,
            listGlobalModelCatalog: handlerStubs.listGlobalModelCatalog,
            listLanguageCatalog: handlerStubs.listLanguageCatalog,
          },
          '../../src/support/serenity/handlers/tags.js': {
            handleCreateTag: handlerStubs.handleCreateTag,
            handleCreateTagSubworkspace: sinon.stub(),
          },
          '../../src/support/serenity/handlers/markets-subworkspace.js': {
            handleListMarketsSubworkspace: sinon.stub(),
            handleGetMarketSubworkspace: sinon.stub(),
            handleCreateMarketSubworkspace: handlerStubs.handleCreateMarketSubworkspace,
            handleDeleteMarketSubworkspace: sinon.stub(),
            handleListTagsSubworkspace: sinon.stub(),
            handleListModelsSubworkspace: sinon.stub(),
            handleUpdateModelsSubworkspace: sinon.stub(),
          },
          '../../src/support/serenity/handlers/prompts-subworkspace.js': {
            handleListPromptsSubworkspace: sinon.stub(),
            handleCreatePromptsSubworkspace: sinon.stub(),
            handleUpdatePromptSubworkspace: sinon.stub(),
            handleBulkDeletePromptsSubworkspace: sinon.stub(),
          },
          '../../src/support/serenity/workspace-lifecycle.js': {
            ensureSubworkspace: handlerStubs.ensureSubworkspace,
            decommissionBrandWorkspace: handlerStubs.decommissionBrandWorkspace,
          },
          // Serenity is active for the org (org-wide LLMO/serenity flag ON) so
          // the documented success shapes are exercised rather than the
          // inactive-org 404.
          '../../src/support/serenity/serenity-active.js': {
            isSerenityActiveForOrg: () => Promise.resolve(true),
          },
          // activate reads brand-level aliases/URLs/competitors once per batch;
          // stub them so the contract test doesn't hit the fake postgrest client.
          '../../src/support/brands-storage.js': {
            getBrandAliases: () => Promise.resolve([]),
            getBrandUrlSources: () => Promise.resolve({
              urls: [], socialAccounts: [], earnedContent: [],
            }),
            getBrandCompetitors: () => Promise.resolve([]),
          },
          // activate's all-or-nothing flip REQUIRES the brand_sites mirror to
          // succeed; stub it to a site id so the documented 200 (full success)
          // shape is exercised rather than the 207/502 partial-failure paths.
          '../../src/support/serenity/site-linkage.js': {
            ensureMarketSite: () => Promise.resolve('site-x'),
          },
        },
      )).default;

      const ctx = fakeContext({
        params: fx.params || {},
        data: fx.data,
        query: fx.query || {},
      });
      const controller = SerenityController(ctx, fakeLog());
      const response = await controller[fx.controllerMethod](ctx);

      expect(response.status).to.equal(fx.expectedStatus);

      // 204 No Content → no body to validate. The contract is just the status.
      if (fx.expectedStatus === 204) {
        return;
      }

      const responseSchema = op.responseSchema(fx.expectedStatus);
      expect(responseSchema, `no ${fx.expectedStatus} schema for ${operationId}`).to.exist;

      const body = await readJsonBody(response);
      const ajv = makeAjv();
      const validate = ajv.compile(responseSchema);
      const validBody = validate(body);
      if (!validBody) {
        const detail = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message} (${JSON.stringify(e.params)})`).join('\n  ');
        throw new Error(`AJV validation failed for ${operationId} ${fx.expectedStatus} response:\n  ${detail}\nbody: ${JSON.stringify(body, null, 2)}`);
      }
      expect(validBody).to.equal(true);
    });
  });
});
