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
import { ProjectEngineApiError } from '@adobe/spacecat-shared-project-engine-client';
import { ErrorWithStatusCode } from '../../src/support/utils.js';
import {
  ERROR_CODES,
  MainBrandBenchmarkInvariantError,
} from '../../src/support/serenity/errors.js';
import { brandPointerReloader } from '../../src/controllers/serenity.js';
// The REAL transport error type: since LLMO-6386 the controller's mapError classifies via
// errors.js (isSemrushTransportError), which recognises the real SerenityTransportError /
// ProjectEngineApiError by `instanceof`. The mapError tests below must feed those real types
// (a bare mock class would not be recognised → would wrongly fall through to the generic 500).
import { SerenityTransportError as RealSerenityTransportError } from '../../src/support/serenity/serenity-transport-error.js';
import { assertCreatePromptTagLimits } from '../../src/support/serenity/handlers/prompts.js';

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

function makeBrandModel(overrides = {}) {
  return {
    getId: () => BRAND,
    getName: () => 'Test Brand',
    getOrganizationId: () => ORG,
    // The activate flow is a pending (draft) brand being approved → active; the
    // all-or-nothing path keys off this status (a non-pending brand is never
    // downgraded on a partial failure).
    getStatus: () => 'pending',
    getSemrushSubWorkspaceId: () => 'subworkspace-ws-1',
    setSemrushSubWorkspaceId: sinon.stub(),
    setStatus: sinon.stub(),
    save: sinon.stub().resolves(),
    ...overrides,
  };
}

// Chainable no-op postgrestClient: resolves any `.eq(...).maybeSingle()`-shaped read to
// `{ data: null, error: null }` so guardAgainstConcurrentProvisioning's read (introduced by
// PR-C, LLMO-7418) sees "no brand row" and no-ops, matching this suite's existing convention of
// stubbing dataAccess collections directly rather than exercising real postgrest queries.
function makeNoOpPostgrestClient() {
  const handler = {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve) => resolve({ data: null, error: null });
      }
      return sinon.stub().returns(new Proxy({}, handler));
    },
  };
  return { from: sinon.stub().callsFake(() => new Proxy({}, handler)) };
}

function fakeContext({
  bearer = 'ims-token-123',
  authType = 'ims',
  params = {},
  data = undefined,
  brandId = BRAND,
  brand = makeBrandModel(),
  // LLMO-7418: the global async-provisioning master switch is DEFAULT OFF in production, so an
  // `async: true` request falls through to the synchronous branch unless it is enabled. Default it
  // ON here so the existing async-path tests exercise the async branch they were written for; the
  // OFF behaviour is covered by its own dedicated tests, which pass an env without this flag.
  env = { SERENITY_ASYNC_PROVISIONING_ENABLED: 'true' },
  promiseToken = undefined,
  headers = {},
} = {}) {
  return {
    env,
    pathInfo: {
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(promiseToken ? { 'x-promise-token': promiseToken } : {}),
        ...headers,
      },
    },
    attributes: {
      authInfo: { getType: () => authType },
    },
    dataAccess: {
      Organization: { findById: sinon.stub().resolves({ getId: () => ORG }) },
      Brand: { findById: sinon.stub().resolves(brand) },
      services: { postgrestClient: makeNoOpPostgrestClient() },
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
    handleUpdateTag: sinon.stub(),
    handleUpdateTagSubworkspace: sinon.stub(),
    handleDeleteTag: sinon.stub(),
    handleDeleteTagSubworkspace: sinon.stub(),
    handleTagImpact: sinon.stub(),
    handleTagImpactSubworkspace: sinon.stub(),
    handleBulkTags: sinon.stub(),
    handleBulkTagsSubworkspace: sinon.stub(),
  };
  let decommissionStub;
  let ensureSubworkspaceStub;
  let clearBrandWorkspaceCacheStub;
  let resolveWorkspaceIdStub;
  let resolveBrandWorkspaceStub;
  let isSerenityActiveStub;
  let isAsyncProvisioningKillSwitchedStub;
  let createTransportStub;
  let resolveBrandUuidStub;
  let getBrandAliasesStub;
  let getBrandUrlSourcesStub;
  let getBrandCompetitorsStub;
  let updateBrandStub;
  let cancelProvisioningAttemptStub;
  let accessControlHasAccessStub;
  let ensureMarketSiteStub;
  let resolveSiteIdentityStub;
  let unlinkMarketSiteIfOrphanedStub;
  let getBrandBaseSiteIdStub;
  let guardAgainstConcurrentProvisioningStub;
  let beginProvisioningAttemptStub;
  let updateProvisioningJobIdStub;
  let getBrandProvisioningStateStub;
  let orchestrateCreateMarketSubworkspaceStub;
  let orchestrateActivateMarketsStub;
  let exchangePromiseTokenStub;
  let linkSiteToLiveRowsStub;
  let linkSiteToRowStub;
  let tombstoneAllForBrandStub;
  let createAndEnqueueJobStub;
  let MockTransportError;
  let SerenityController;

  beforeEach(async function setupSerenityController() {
    this.timeout(10000);
    Object.values(handlers).forEach((s) => s.reset());
    resolveWorkspaceIdStub = sinon.stub().resolves(WORKSPACE);
    // Default: flat mode — existing assertions (handlers called with
    // WORKSPACE) hold unchanged. Subworkspace-mode tests override this stub.
    resolveBrandWorkspaceStub = sinon.stub().resolves({
      mode: 'flat', workspaceId: WORKSPACE, parentWorkspaceId: WORKSPACE,
    });
    // Default: serenity active (org-wide LLMO/serenity flag ON) so every
    // existing assertion that drives a brand-level route reaches its handler.
    // The "serenity inactive" describe overrides this to false.
    isSerenityActiveStub = sinon.stub().resolves(true);
    // LLMO-7418 external-review Finding 15: kill switch off by default (async provisioning
    // available); specific tests override it to resolve(true) to exercise the 503 gate.
    isAsyncProvisioningKillSwitchedStub = sinon.stub().resolves(false);
    decommissionStub = sinon.stub().resolves();
    ensureSubworkspaceStub = sinon.stub().resolves(SUBWS);
    clearBrandWorkspaceCacheStub = sinon.stub();
    createTransportStub = sinon.stub().returns({ name: 'transport' });
    resolveBrandUuidStub = sinon.stub().resolves(BRAND);
    getBrandAliasesStub = sinon.stub().resolves([]);
    getBrandUrlSourcesStub = sinon.stub()
      .resolves({ urls: [], socialAccounts: [], earnedContent: [] });
    getBrandCompetitorsStub = sinon.stub().resolves([]);
    // Serenity activate persists the status flip + primary site via updateBrand
    // (the Brand model has no site_id setter). Resolves by default; specific
    // tests override it to reject (409 conflict / transient divergence).
    updateBrandStub = sinon.stub().resolves({ getId: () => BRAND, getStatus: () => 'active' });
    cancelProvisioningAttemptStub = sinon.stub().resolves(false);
    accessControlHasAccessStub = sinon.stub().resolves(true);
    ensureMarketSiteStub = sinon.stub().resolves('site-uuid-1');
    resolveSiteIdentityStub = sinon.stub().resolves({ domain: 'resolved.example.com', primaryUrl: 'resolved.example.com' });
    unlinkMarketSiteIfOrphanedStub = sinon.stub().resolves(true);
    getBrandBaseSiteIdStub = sinon.stub().resolves(null);
    // PR-C (LLMO-7352/LLMO-7418): no-op by default (no concurrent async attempt);
    // specific tests override it to reject with a 409 to exercise the guard.
    guardAgainstConcurrentProvisioningStub = sinon.stub().resolves();
    // PR-C: createMarket's subworkspace branch now mints a provisioning attempt and hands the
    // whole create off to the provision-workspace-job -> serenity-create-market job chain
    // (async, 202) instead of orchestrating synchronously. Default: no attempt already in
    // flight (mirrors beginProvisioningAttempt's real CAS succeeding); specific tests override
    // it to resolve(false) to exercise the 409 "already in progress" branch.
    beginProvisioningAttemptStub = sinon.stub().resolves(true);
    // LLMO-7418 external-review Finding 17: records the first-hop job id, best-effort.
    updateProvisioningJobIdStub = sinon.stub().resolves(true);
    // Default: no provisioning attempt tracked (a genuinely flat brand).
    getBrandProvisioningStateStub = sinon.stub().resolves(null);
    // PR-C: `async: true` opts into the job-chain branch above; absent/false runs this
    // (unchanged) synchronous orchestration call — the default, no-flag behavior every
    // existing caller gets.
    orchestrateCreateMarketSubworkspaceStub = sinon.stub();
    // PR-C: activate's project-activation batch mirrors the same opt-in shape — `async: true`
    // enqueues the provision->activate-markets job chain; absent/false runs this (unchanged)
    // synchronous orchestration call.
    orchestrateActivateMarketsStub = sinon.stub();
    exchangePromiseTokenStub = sinon.stub().resolves('exchanged-ims-token');
    linkSiteToLiveRowsStub = sinon.stub().resolves();
    linkSiteToRowStub = sinon.stub().resolves();
    tombstoneAllForBrandStub = sinon.stub().resolves();
    createAndEnqueueJobStub = sinon.stub().resolves({
      getId: () => 'job-abc', getStatus: () => 'IN_PROGRESS',
    });
    // Alias the REAL SerenityTransportError so instances are recognised by errors.js's
    // isSemrushTransportError (which mapError now delegates to). Same (status, message, body)
    // constructor signature the tests already use.
    MockTransportError = RealSerenityTransportError;
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
        assertCreatePromptTagLimits,
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
        handleUpdateTag: handlers.handleUpdateTag,
        handleUpdateTagSubworkspace: handlers.handleUpdateTagSubworkspace,
        handleDeleteTag: handlers.handleDeleteTag,
        handleDeleteTagSubworkspace: handlers.handleDeleteTagSubworkspace,
        handleTagImpact: handlers.handleTagImpact,
        handleTagImpactSubworkspace: handlers.handleTagImpactSubworkspace,
      },
      '../../src/support/serenity/workspace-lifecycle.js': {
        ensureSubworkspace: ensureSubworkspaceStub,
        decommissionBrandWorkspace: decommissionStub,
      },
      '../../src/support/serenity/serenity-active.js': {
        isSerenityActiveForBrand: isSerenityActiveStub,
        isAsyncProvisioningKillSwitched: isAsyncProvisioningKillSwitchedStub,
      },
      '../../src/support/access-control-util.js': MockAccessControlUtil,
      '../../src/support/prompts-storage.js': {
        // isServicePrincipal is NOT mocked -- the real predicate's fail-safe
        // shape (isS2SConsumer()/isS2SAdmin() absent -> false, falls through
        // to a non-jwt/non-ims authType) is exactly what the fake context's
        // authInfo ({ getType: () => authType }, no S2S methods) exercises,
        // so the controller-level assertions cover the real function rather
        // than a stand-in that could silently drift from it.
        resolveBrandUuid: resolveBrandUuidStub,
      },
      '../../src/support/brands-storage.js': {
        getBrandAliases: getBrandAliasesStub,
        getBrandUrlSources: getBrandUrlSourcesStub,
        getBrandCompetitors: getBrandCompetitorsStub,
        updateBrand: updateBrandStub,
        getBrandBaseSiteId: getBrandBaseSiteIdStub,
        cancelProvisioningAttempt: cancelProvisioningAttemptStub,
        guardAgainstConcurrentProvisioning: guardAgainstConcurrentProvisioningStub,
        beginProvisioningAttempt: beginProvisioningAttemptStub,
        updateProvisioningJobId: updateProvisioningJobIdStub,
        getBrandProvisioningState: getBrandProvisioningStateStub,
      },
      '../../src/support/serenity/handlers/create-market-orchestration.js': {
        orchestrateCreateMarketSubworkspace: orchestrateCreateMarketSubworkspaceStub,
      },
      '../../src/support/serenity/handlers/activate-markets-orchestration.js': {
        orchestrateActivateMarkets: orchestrateActivateMarketsStub,
      },
      '../../src/support/serenity/site-linkage.js': {
        ensureMarketSite: ensureMarketSiteStub,
        resolveSiteIdentity: resolveSiteIdentityStub,
        unlinkMarketSiteIfOrphaned: unlinkMarketSiteIfOrphanedStub,
      },
      '../../src/support/utils.js': {
        resolveSemrushImsToken: makeResolveSemrushImsTokenStub(
          (...args) => exchangePromiseTokenStub(...args),
        ),
      },
      '../../src/support/serenity/mapping-rows.js': {
        linkSiteToLiveRows: linkSiteToLiveRowsStub,
        linkSiteToRow: linkSiteToRowStub,
        tombstoneAllForBrand: tombstoneAllForBrandStub,
      },
      '../../src/support/serenity/async-job-runner.js': {
        createAndEnqueueJob: createAndEnqueueJobStub,
      },
      '../../src/support/serenity/handlers/classify-prompts-job.js': {
        CLASSIFY_PROMPTS_JOB_TYPE: 'serenity-classify-prompts',
      },
      '../../src/support/serenity/handlers/bulk-tags-job.js': {
        BULK_TAGS_JOB_TYPE: 'serenity-bulk-tags',
        BULK_TAGS_PUBLIC_JOB_TYPE: 'bulkTags',
        handleBulkTags: handlers.handleBulkTags,
        handleBulkTagsSubworkspace: handlers.handleBulkTagsSubworkspace,
        pageBulkFailures: (result) => result,
      },
      '../../src/support/serenity/handlers/provision-workspace-job.js': {
        PROVISION_WORKSPACE_JOB_TYPE: 'serenity-provision-workspace',
      },
      '../../src/support/serenity/handlers/create-market-job.js': {
        CREATE_MARKET_JOB_TYPE: 'serenity-create-market',
      },
      '../../src/support/serenity/handlers/activate-markets-job.js': {
        ACTIVATE_MARKETS_JOB_TYPE: 'serenity-activate-markets',
      },
      '../../src/support/serenity/handlers/activate-brand-workspace-job.js': {
        ACTIVATE_BRAND_WORKSPACE_JOB_TYPE: 'serenity-activate-brand-workspace',
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

    // The escape hatch is hard-disabled in production (AWS_ENV or ENV === 'prod'),
    // mirroring getImsUserTokenStrict — a non-IMS caller must never slip through
    // even if SERENITY_ALLOW_NON_IMS_AUTH were somehow set in a prod env.
    it('401s a non-IMS caller with the flag set when AWS_ENV is prod', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        authType: 'jwt', env: { SERENITY_ALLOW_NON_IMS_AUTH: 'true', AWS_ENV: 'prod' },
      });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(401);
    });

    it('401s a non-IMS caller with the flag set when ENV is prod', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        authType: 'jwt', env: { SERENITY_ALLOW_NON_IMS_AUTH: 'true', ENV: 'prod' },
      });
      const response = await controller.listPrompts(ctx);
      expect(response.status).to.equal(401);
    });

    describe('x-promise-token support', () => {
      it('exchanges x-promise-token for an IMS token and forwards it upstream, bypassing the IMS-type gate', async () => {
        handlers.handleListPrompts.resolves({ items: [], total: 0 });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        // Authorization carries a spacecat JWT (not IMS) — would 401 via
        // requireImsBearer alone, but the promise-token path never calls it.
        const ctx = fakeContext({
          authType: 'jwt',
          bearer: 'spacecat-jwt-abc',
          promiseToken: 'promise-token-xyz',
        });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(200);
        expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(ctx, 'promise-token-xyz');
        expect(createTransportStub).to.have.been.calledWithMatch({ imsToken: 'exchanged-ims-token' });
      });

      it('decodes a URI-encoded x-promise-token header before exchanging', async () => {
        handlers.handleListPrompts.resolves({ items: [], total: 0 });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({ promiseToken: 'promise%20token%20xyz' });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(200);
        expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(ctx, 'promise token xyz');
      });

      it('falls back to the raw header value when it is not valid percent-encoding', async () => {
        handlers.handleListPrompts.resolves({ items: [], total: 0 });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({ promiseToken: 'promise%zztoken' });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(200);
        expect(exchangePromiseTokenStub).to.have.been.calledOnceWithExactly(ctx, 'promise%zztoken');
      });

      it('401s with a generic message (no leaked exchange detail) when the promise token exchange fails', async () => {
        exchangePromiseTokenStub.rejects(new Error('upstream IMS exchange failed: secret detail'));
        const log = fakeLog();
        const controller = SerenityController({ env: {} }, log, {});
        const ctx = fakeContext({
          authType: 'jwt', bearer: 'spacecat-jwt-abc', promiseToken: 'promise-token-xyz',
        });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(401);
        const body = await readBody(response);
        expect(body.message).to.equal('Invalid or expired promise token');
        expect(log.error).to.have.been.calledWithMatch('serenity: promise token exchange failed');
      });

      it('falls back to the Authorization bearer when x-promise-token is absent (existing behavior unchanged)', async () => {
        handlers.handleListPrompts.resolves({ items: [], total: 0 });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({ bearer: 'ims-token-123' });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(200);
        expect(exchangePromiseTokenStub).to.not.have.been.called;
        expect(createTransportStub).to.have.been.calledWithMatch({ imsToken: 'ims-token-123' });
      });

      it('still 401s a non-IMS caller with no x-promise-token (existing IMS-type gate unaffected)', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({ authType: 'jwt' });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(401);
        expect(exchangePromiseTokenStub).to.not.have.been.called;
      });

      it('hints at the x-promise-token header when a non-IMS caller sends none', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const ctx = fakeContext({ authType: 'jwt' });
        const response = await controller.listPrompts(ctx);
        expect(response.status).to.equal(401);
        const body = await readBody(response);
        expect(body.error).to.equal('promiseTokenRequired');
        expect(body.message).to.match(/x-promise-token/);
      });
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

    it('404s when serenity is not active for the BRAND, without resolving a workspace', async () => {
      // The brand resolves LLMO/serenity OFF — its own override, or the org's row
      // in the absence of one — so the serenity surface is inactive for it and the
      // UI falls back to the normal backend. A sibling brand in the same org can
      // resolve ON, which is what a migration wave looks like mid-flight.
      isSerenityActiveStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listPrompts(fakeContext());
      expect(response.status).to.equal(404);
      const body = await readBody(response);
      expect(body.message).to.match(/serenity is not active/i);
      expect(resolveBrandWorkspaceStub).to.not.have.been.called;
    });

    it('gates on the RESOLVED brand uuid, not the org alone', async () => {
      // The brand must be resolved first and its uuid passed to the predicate:
      // gating on the org alone would give all of an org's brands one answer.
      isSerenityActiveStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      await controller.listPrompts(fakeContext());
      expect(resolveBrandUuidStub).to.have.been.calledOnce;
      expect(isSerenityActiveStub).to.have.been.calledWith(sinon.match.any, ORG, BRAND);
    });

    it('reaches the handler when serenity is active for the brand and a workspace resolves', async () => {
      // The happy-path composition: brand resolves ON (default stub) + a resolved
      // workspace ⇒ the route is served.
      handlers.handleListPrompts.resolves({ items: [], total: 0 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listPrompts(fakeContext());
      expect(response.status).to.equal(200);
      expect(isSerenityActiveStub).to.have.been.calledOnce;
      expect(handlers.handleListPrompts).to.have.been.calledOnce;
    });
  });

  describe('routing to handlers', () => {
    it('listPrompts forwards parsed query (geoTargetId as int, page as int) to handleListPrompts', async () => {
      handlers.handleListPrompts.resolves({
        items: [], total: 0, page: 1, limit: 50,
      });
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
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
      expect(args[5]).to.equal(log);
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

    // An upstream 409 (e.g. a prompt rename onto a sibling prompt's exact text
    // — serenity-docs#63) is the caller's to act on, not an outage: it keeps
    // its status and the `conflict` token instead of flattening into the
    // generic 502. Message stays redacted like every transport-error branch.
    it('upstream SerenityTransportError 409 propagates as 409 conflict with a redacted message', async () => {
      handlers.handleUpdatePrompt.rejects(new MockTransportError(409, 'gateway-url-with-uuids', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updatePrompt(fakeContext({
        params: { semrushPromptId: 'sem-1' },
        data: {
          geoTargetId: 2840, languageCode: 'en', text: 'x', tagIds: ['t1'],
        },
      }));
      expect(response.status).to.equal(409);
      const body = await readBody(response);
      expect(body.error).to.equal('conflict');
      expect(body.message).to.equal('Upstream rejected the request as a conflict');
      expect(body.message).to.not.match(/gateway-url-with-uuids/);
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

    // SITES-49993: when authorize() itself throws (before returning), the
    // hoisted `auth` is still undefined — the fallback log line must still
    // carry the route ids from params, with brandUuid/workspaceId left
    // undefined rather than populated with stale/wrong values.
    it('logs route ids on the fallback when authorize throws before resolving', async () => {
      const boom = new Error('db down');
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const ctx = fakeContext();
      ctx.dataAccess.Organization.findById = sinon.stub().rejects(boom);
      const response = await controller.listMarkets(ctx);
      expect(response.status).to.equal(500);
      const call = log.error.getCalls().find(
        (c) => c.args[0] === 'Serenity controller error',
      );
      expect(call).to.exist;
      const { reqCtx, error } = call.args[1];
      expect(reqCtx.spaceCatId).to.equal(ORG);
      expect(reqCtx.brandId).to.equal(BRAND);
      expect(reqCtx.brandUuid).to.be.undefined;
      expect(reqCtx.workspaceId).to.be.undefined;
      expect(error).to.equal(boom);
    });

    // LLMO-6386: a Project Engine call now throws ProjectEngineApiError directly (adaptPE gone).
    // mapError's widened branch must map it to the SAME HTTP envelope the old transport error
    // produced, redacting the body/message. ProjectEngineApiError does NOT extend
    // ErrorWithStatusCode, so it correctly reaches the widened branch.
    it('upstream ProjectEngineApiError (HTTP status) maps to 502 without leaking provider detail', async () => {
      handlers.handleListMarkets.rejects(new ProjectEngineApiError(503, 'GET', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(502);
      const body = await readBody(response);
      expect(body.error).to.equal('serenityUpstreamError');
      expect(body.message).to.equal('Upstream request failed');
      expect(JSON.stringify(body)).not.to.match(/leak/);
      // The raw "Project Engine ..." message must never reach the client.
      expect(JSON.stringify(body)).not.to.match(/Project Engine/);
    });

    // SITES-49993: a Semrush upstream failure logs ONE structured line — the
    // JSON payload embedded in the message carries the upstream status/method/
    // body plus the tenant ids threaded from the route (ProjectEngineApiError
    // itself carries no ids), so Logs Insights can group failures by tenant
    // and upstream reason.
    it('logs one structured line with upstream status/method/body and tenant ids (SITES-49993)', async () => {
      handlers.handleListMarkets.rejects(
        new ProjectEngineApiError(403, 'GET', { detail: 'workspace role missing' }),
      );
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      await controller.listMarkets(fakeContext());
      const call = log.error.getCalls().find(
        (c) => typeof c.args[0] === 'string' && c.args[0].startsWith('Serenity upstream error {'),
      );
      expect(call).to.exist;
      const payload = JSON.parse(call.args[0].slice('Serenity upstream error '.length));
      expect(payload.status).to.equal(403);
      expect(payload.method).to.equal('GET');
      expect(payload.spaceCatId).to.equal(ORG);
      expect(payload.brandId).to.equal(BRAND);
      expect(payload.workspaceId).to.equal(WORKSPACE);
      expect(payload.body).to.include('workspace role missing');
    });

    it('upstream ProjectEngineApiError 401 propagates as 401 authenticationRequired (redacted)', async () => {
      handlers.handleListMarkets.rejects(new ProjectEngineApiError(401, 'GET', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(401);
      const body = await readBody(response);
      expect(body.error).to.equal('authenticationRequired');
      expect(body.message).to.equal('Upstream authorization failed');
    });

    it('upstream ProjectEngineApiError 409 propagates as 409 conflict (redacted)', async () => {
      handlers.handleUpdatePrompt.rejects(new ProjectEngineApiError(409, 'POST', { secret: 'leak' }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updatePrompt(fakeContext({
        params: { semrushPromptId: 'sem-1' },
        data: {
          geoTargetId: 2840, languageCode: 'en', text: 'x', tagIds: ['t1'],
        },
      }));
      expect(response.status).to.equal(409);
      const body = await readBody(response);
      expect(body.error).to.equal('conflict');
      expect(body.message).to.equal('Upstream rejected the request as a conflict');
    });

    // The behaviour-preservation crux (LLMO-6386): a no-HTTP-response Project Engine failure is a
    // ProjectEngineApiError with status undefined wrapping the original throw as `.cause`. mapError
    // must unwrap it so the auth-401 keeps mapping to 401 (NOT flattening to 502) and a timeout 504
    // still maps to 502 — exactly what the retired adaptPE boundary produced.
    it('unwraps a status-undefined ProjectEngineApiError to preserve the auth 401 (not 502)', async () => {
      const authCause = new RealSerenityTransportError(401, 'Missing IMS bearer token');
      handlers.handleListMarkets.rejects(new ProjectEngineApiError(undefined, 'POST', null, { cause: authCause }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(401);
      const body = await readBody(response);
      expect(body.error).to.equal('authenticationRequired');
      expect(body.message).to.equal('Upstream authorization failed');
    });

    it('maps a status-undefined ProjectEngineApiError wrapping a 504 timeout cause to 502', async () => {
      const timeoutCause = new RealSerenityTransportError(504, 'Semrush request timed out');
      handlers.handleListMarkets.rejects(new ProjectEngineApiError(undefined, 'GET', null, { cause: timeoutCause }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(502);
      const body = await readBody(response);
      expect(body.error).to.equal('serenityUpstreamError');
    });

    it('maps a status-undefined ProjectEngineApiError wrapping a raw network cause to the generic 500', async () => {
      const netCause = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      handlers.handleListMarkets.rejects(new ProjectEngineApiError(undefined, 'GET', null, { cause: netCause }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.listMarkets(fakeContext());
      expect(response.status).to.equal(500);
      const body = await readBody(response);
      expect(body.error).to.equal('internalServerError');
      expect(body.message).to.equal('Internal server error');
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

    it('createMarket REFUSES rather than writing to the org parent workspace when the brand is mid-provisioning (LLMO-7418 external-review B1)', async () => {
      // A brand whose sub-workspace pointer is not yet written resolves to mode 'flat' with
      // workspaceId = THE ORG'S SHARED PARENT. For a genuinely flat brand that is correct; for a
      // Semrush brand that is merely mid-provisioning it is not — falling through would create and
      // publish a project in the shared org workspace, bound to this brand, which becomes an
      // orphan the moment the real pointer lands. Async creation makes this window reachable.
      handlers.handleCreateMarket.resolves({ status: 201, body: { brandId: BRAND } });
      getBrandProvisioningStateStub.resolves({ provisioningStatus: 'pending' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});

      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));

      expect(response.status).to.equal(409);
      // The load-bearing assertion: nothing was written to the parent workspace.
      expect(handlers.handleCreateMarket).to.not.have.been.called;
    });

    it('createMarket refuses a mid-provisioning brand whose attempt FAILED (no workspace of its own yet)', async () => {
      handlers.handleCreateMarket.resolves({ status: 201, body: { brandId: BRAND } });
      getBrandProvisioningStateStub.resolves({ provisioningStatus: 'failed' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});

      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));

      expect(response.status).to.equal(409);
      expect(handlers.handleCreateMarket).to.not.have.been.called;
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

    it('createMarket maps MainBrandBenchmarkInvariantError to a generic 502 and logs server-side (MysticatBot review)', async () => {
      // Simulates the sub-workspace path: nothing upstream of mapError sets
      // `serenityLogged`, so this is the error's only log.
      const err = new MainBrandBenchmarkInvariantError('ws-1', 'proj-1', { count: 0 });
      handlers.handleCreateMarket.rejects(err);
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(502);
      const body = await readBody(response);
      expect(body.error).to.equal('mainBrandBenchmarkInvariant');
      // Client-facing message stays generic — no workspace/project id leak.
      expect(body.message).to.not.include('ws-1');
      expect(body.message).to.not.include('proj-1');
      expect(log.error).to.have.been.calledOnce;
      expect(log.error).to.have.been.calledWithMatch(
        'Serenity controller error',
        sinon.match({ error: sinon.match({ workspaceId: 'ws-1', projectId: 'proj-1', count: 0 }) }),
      );
    });

    it('createMarket does not double-log MainBrandBenchmarkInvariantError already logged upstream (flat path cleanup)', async () => {
      // Simulates the flat path: project-provisioning.js's cleanupAndRethrow
      // already logged this exact failure (and marked it) before rethrowing.
      const err = new MainBrandBenchmarkInvariantError('ws-1', 'proj-1', { count: 2 });
      err.serenityLogged = true;
      handlers.handleCreateMarket.rejects(err);
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(502);
      expect(log.error).to.not.have.been.called;
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

    // SITES-50099: the delete audit log needs a requester identity threaded
    // through, resolved via resolveCallerId — the same mechanism createPrompts/
    // updatePrompt already use, never the forwarded upstream bearer.
    it('bulkDeletePrompts threads the resolved callerId into the flat handler options', async () => {
      handlers.handleBulkDeletePrompts.resolves({ deleted: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      await controller.bulkDeletePrompts(fakeContext({
        data: { prompts: [{ semrushPromptId: 'q1', geoTargetId: 2840, languageCode: 'en' }] },
      }));
      const options = handlers.handleBulkDeletePrompts.firstCall.args[6];
      expect(options.callerId).to.equal('unknown');
    });

    it('bulkTagPrompts dispatches flat arguments and reads Idempotency-Key case-insensitively', async () => {
      const data = {
        geoTargetId: 2840,
        languageCode: 'en',
        operation: 'assign',
        tagIds: ['tag-1'],
        filter: { tagIds: [], tagFilterMode: 'faceted-v1' },
      };
      handlers.handleBulkTags.resolves({
        status: 202,
        body: {
          jobId: 'job-1', jobType: 'bulkTags', status: 'IN_PROGRESS', replayed: false,
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data,
        headers: { 'iDeMpOtEnCy-KeY': 'flat-key' },
      });

      const response = await controller.bulkTagPrompts(ctx);

      expect(response.status).to.equal(202);
      expect(handlers.handleBulkTags).to.have.been.calledOnceWith(
        ctx,
        { name: 'transport' },
        ctx.dataAccess,
        BRAND,
        ORG,
        WORKSPACE,
        data,
        'unknown',
        'flat-key',
        sinon.match.object,
      );
      expect(handlers.handleBulkTagsSubworkspace).not.to.have.been.called;
    });

    it('createTag routes to the flat handler in flat mode and returns its status', async () => {
      handlers.handleCreateTag.resolves({
        status: 201,
        body: {
          brandId: BRAND, geoTargetId: 2840, languageCode: 'en', type: 'category', name: 'Footwear', tag: 'category:Footwear',
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      // No ctx.data → exercises the `ctx.data || {}` body-defaulting fallback.
      const response = await controller.createTag(fakeContext());
      expect(response.status).to.equal(201);
      const body = await readBody(response);
      expect(body.tag).to.equal('category:Footwear');
      expect(handlers.handleCreateTag).to.have.been.calledOnce;
      expect(handlers.handleCreateTag.firstCall.args[4]).to.deep.equal({});
      expect(handlers.handleCreateTagSubworkspace).to.not.have.been.called;
    });

    it('createTag returns the authorize() error (403) and does not dispatch when the caller lacks org access', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createTag(fakeContext({
        data: {
          type: 'category', name: 'Footwear', geoTargetId: 2840, languageCode: 'en',
        },
      }));
      expect(response.status).to.equal(403);
      expect(handlers.handleCreateTag).to.not.have.been.called;
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

    it('updateTag requires the :tagId path param', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateTag(fakeContext({ params: {} }));
      expect(response.status).to.equal(400);
      expect(handlers.handleUpdateTag).to.not.have.been.called;
    });

    it('updateTag forwards tagId + body to the flat handler and returns its status', async () => {
      handlers.handleUpdateTag.resolves({
        status: 200,
        body: {
          brandId: BRAND, tagId: 'tag-1', tag: 'category:Footwear', parentId: 'root-1',
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateTag(fakeContext({
        params: { tagId: 'tag-1' },
        data: {
          name: 'category:Footwear', parentId: 'root-1', geoTargetId: 2840, languageCode: 'en',
        },
      }));
      expect(response.status).to.equal(200);
      const body = await readBody(response);
      expect(body).to.include({ tagId: 'tag-1', parentId: 'root-1' });
      expect(handlers.handleUpdateTag).to.have.been.calledOnce;
      expect(handlers.handleUpdateTag.firstCall.args[4]).to.equal('tag-1');
      expect(handlers.handleUpdateTagSubworkspace).to.not.have.been.called;
    });

    it('updateTag returns the authorize error without throwing (auth.error short-circuit)', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateTag(fakeContext({ params: { tagId: 'tag-1' } }));
      expect(response.status).to.equal(403);
      expect(handlers.handleUpdateTag).to.not.have.been.called;
      expect(handlers.handleUpdateTagSubworkspace).to.not.have.been.called;
    });

    it('getTagImpact dispatches flat arguments and returns the revision as ETag', async () => {
      handlers.handleTagImpact.resolves({
        status: 200,
        body: {
          tagId: 'tag-1',
          revision: '"impact-revision"',
          affectedPromptCount: 2,
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { tagId: 'tag-1' } });
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };

      const response = await controller.getTagImpact(ctx);

      expect(response.status).to.equal(200);
      expect(response.headers.get('etag')).to.equal('"impact-revision"');
      expect(handlers.handleTagImpact).to.have.been.calledOnceWith(
        { name: 'transport' },
        ctx.dataAccess,
        BRAND,
        WORKSPACE,
        'tag-1',
        { geoTargetId: 2840, languageCode: 'en' },
        sinon.match.object,
      );
      expect(handlers.handleTagImpactSubworkspace).not.to.have.been.called;
    });

    it('deleteTag requires the :tagId path param', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteTag(fakeContext({ params: {} }));
      expect(response.status).to.equal(400);
      expect(handlers.handleDeleteTag).to.not.have.been.called;
    });

    it('deleteTag forwards tagId + query slice to the flat handler and returns 204', async () => {
      handlers.handleDeleteTag.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { tagId: 'tag-1' } });
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };
      const response = await controller.deleteTag(ctx);
      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteTag).to.have.been.calledOnce;
      expect(handlers.handleDeleteTag.firstCall.args[4]).to.equal('tag-1');
      expect(handlers.handleDeleteTagSubworkspace).to.not.have.been.called;
    });

    it('deleteTag resolves If-Match case-insensitively', async () => {
      handlers.handleDeleteTag.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { tagId: 'tag-1' } });
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };
      ctx.pathInfo.headers['iF-mAtCh'] = '"impact-revision"';

      const response = await controller.deleteTag(ctx);

      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteTag.firstCall.args[7]).to.equal('"impact-revision"');
    });

    it('deleteTag returns the authorize error without throwing (auth.error short-circuit)', async () => {
      accessControlHasAccessStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteTag(fakeContext({ params: { tagId: 'tag-1' } }));
      expect(response.status).to.equal(403);
      expect(handlers.handleDeleteTag).to.not.have.been.called;
      expect(handlers.handleDeleteTagSubworkspace).to.not.have.been.called;
    });

    it('deleteTag maps a handler 400 (server-owned dimension) through mapError', async () => {
      handlers.handleDeleteTag.rejects(new ErrorWithStatusCode(
        'a value of the server-owned "intent" dimension cannot be deleted',
        400,
      ));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { tagId: 'tag-1' } });
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };
      const response = await controller.deleteTag(ctx);
      expect(response.status).to.equal(400);
      const body = await readBody(response);
      expect(body.message).to.match(/server-owned "intent" dimension cannot be deleted/);
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
      expect(controller.deleteTag).to.be.a('function');
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
      // transport, brandId, workspaceId, then dataAccess + log (siteId enrichment).
      expect(handlers.handleListMarketsSubworkspace).to.have.been.calledOnce;
      const listArgs = handlers.handleListMarketsSubworkspace.firstCall.args;
      expect(listArgs[0]).to.deep.equal({ name: 'transport' });
      expect(listArgs[1]).to.equal(BRAND);
      expect(listArgs[2]).to.equal('subworkspace-ws-1');
      expect(listArgs[3]).to.exist; // ctx.dataAccess passed for siteId enrichment
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

    it('createMarket runs the SYNCHRONOUS branch when the global async switch is off, even with async: true (LLMO-7418 master switch)', async () => {
      // The master switch is DEFAULT OFF in production. An `async: true` request must then fall
      // through to the synchronous branch — NOT error — so this whole stack can merge inert and
      // async is turned on deliberately. This is what makes shipping safe by default.
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        env: {}, // switch absent => off
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: true,
        },
      });

      const response = await controller.createMarket(ctx);

      // Synchronous path: not a 202, and no provisioning attempt or job was created.
      expect(response.status).to.not.equal(202);
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('createMarket (PR-C) mints a provisioning attempt and enqueues the provision->create-market job chain, answering 202', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: true,
        },
      });
      const response = await controller.createMarket(ctx);
      const body = await readBody(response);

      expect(response.status).to.equal(202);
      expect(body).to.include({ jobId: 'job-abc', status: 'IN_PROGRESS' });
      // LLMO-7418 external-review Finding 9: reconciles a stale in-flight attempt (reusing the
      // sync guard's own logic) before minting a new one — beginProvisioningAttempt's own CAS
      // has no staleness awareness on its own.
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnceWith(BRAND);
      expect(beginProvisioningAttemptStub).to.have.been.calledOnce;
      expect(beginProvisioningAttemptStub.firstCall.args[0]).to.include({
        brandId: BRAND, updatedBy: 'serenity-create-market',
      });
      expect(createAndEnqueueJobStub).to.have.been.calledOnce;
      // LLMO-7418 external-review Finding 17: the first hop's job id is recorded, not left
      // permanently NULL — only the worker's own self-requeue path used to write this.
      expect(updateProvisioningJobIdStub).to.have.been.calledOnceWith({
        brandId: BRAND,
        attemptId: beginProvisioningAttemptStub.firstCall.args[0].attemptId,
        jobId: 'job-abc',
        postgrestClient: sinon.match.any,
      });
      const [enqueueCtx, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueCtx).to.equal(ctx);
      expect(enqueueArgs.jobType).to.equal('serenity-provision-workspace');
      expect(enqueueArgs.metadata.brandId).to.equal(BRAND);
      expect(enqueueArgs.metadata.attemptId).to.equal(
        beginProvisioningAttemptStub.firstCall.args[0].attemptId,
      );
      expect(enqueueArgs.metadata.parentWorkspaceId).to.equal(WORKSPACE);
      expect(enqueueArgs.metadata.chainedJobType).to.equal('serenity-create-market');
      const { chainedJobMetadata } = enqueueArgs.metadata;
      expect(chainedJobMetadata.brandId).to.equal(BRAND);
      expect(chainedJobMetadata.parentWorkspaceId).to.equal(WORKSPACE);
      expect(chainedJobMetadata.orgId).to.equal(ORG);
      expect(chainedJobMetadata.requestBody).to.include({ market: 'us', languageCode: 'en', brandDomain: 'x.com' });
      expect(chainedJobMetadata.suppliedSiteIdentity).to.equal(null);
      expect(chainedJobMetadata.suppliedSiteId).to.equal(null);
    });

    it('createMarket answers 409 without enqueuing anything when a provisioning attempt is already in flight', async () => {
      beginProvisioningAttemptStub.resolves(false);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: true,
        },
      }));
      expect(response.status).to.equal(409);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('createMarket answers 503 without enqueuing anything when the async kill switch is on (LLMO-7418 external-review Finding 15)', async () => {
      isAsyncProvisioningKillSwitchedStub.resolves(true);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: true,
        },
      }));
      expect(response.status).to.equal(503);
      expect(guardAgainstConcurrentProvisioningStub).to.not.have.been.called;
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('createMarket runs the SAME synchronous orchestration it always has when async is absent (regression: default behavior unchanged)', async () => {
      orchestrateCreateMarketSubworkspaceStub.resolves({
        status: 201, body: { brandId: BRAND, geoTargetId: 2840, languageCode: 'en' },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      });
      const response = await controller.createMarket(ctx);

      expect(response.status).to.equal(201);
      // PR-C: a concurrent async activate (or async createMarket) attempt for the same
      // brand must be checked before this sync branch touches the workspace.
      expect(guardAgainstConcurrentProvisioningStub)
        .to.have.been.calledOnceWith(BRAND, sinon.match.any, sinon.match.any);
      expect(orchestrateCreateMarketSubworkspaceStub).to.have.been.calledOnce;
      expect(guardAgainstConcurrentProvisioningStub)
        .to.have.been.calledBefore(orchestrateCreateMarketSubworkspaceStub);
      const params = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
      expect(params.brandUuid).to.equal(BRAND);
      expect(params.parentWorkspaceId).to.equal(WORKSPACE);
      expect(params.requestBody).to.include({ market: 'us', languageCode: 'en', brandDomain: 'x.com' });
      // No provisioning attempt is minted and nothing is enqueued on the default path.
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('PR-C: createMarket 409s (no orchestration call) when a concurrent async provisioning attempt is in flight', async () => {
      const conflictErr = new ErrorWithStatusCode(
        'A Semrush sub-workspace provisioning attempt is already in progress for this brand; please retry shortly.',
        409,
      );
      conflictErr.code = 'semrush_provisioning_in_progress';
      guardAgainstConcurrentProvisioningStub.rejects(conflictErr);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(409);
      expect(orchestrateCreateMarketSubworkspaceStub).to.not.have.been.called;
    });

    it('createMarket runs synchronously when async is explicitly false', async () => {
      orchestrateCreateMarketSubworkspaceStub.resolves({ status: 201, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: false,
        },
      }));
      expect(response.status).to.equal(201);
      expect(orchestrateCreateMarketSubworkspaceStub).to.have.been.calledOnce;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('createMarket 400s when async is not a boolean', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: 'yes',
        },
      }));
      expect(response.status).to.equal(400);
      expect(orchestrateCreateMarketSubworkspaceStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('createMarket 400s on a siteId the caller does not own, even alongside a brandDomain', async () => {
      // The unguarded shape: with brandDomain present nothing used to read the
      // Site, so a foreign UUID was recorded verbatim as the market's own — and
      // that value decides what the project analyses. The org check runs on every
      // supplied siteId now, before either mode dispatches.
      resolveSiteIdentityStub.resolves(null);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data: {
          market: 'us',
          languageCode: 'en',
          brandDomain: 'x.com',
          siteId: '00000000-0000-4000-8000-00000000f0f0',
          brandNames: ['X'],
        },
      });
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(400);
      // The organization is what makes the check possible, so it must be passed.
      expect(resolveSiteIdentityStub).to.have.been.calledWith(ctx.dataAccess, '00000000-0000-4000-8000-00000000f0f0', sinon.match.any, ORG);
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('createMarket threads a resolved supplied-siteId identity through to the job chain (LLMO-6405)', async () => {
      resolveSiteIdentityStub.resolves({ domain: 'acme.com', primaryUrl: 'acme.com/markets' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        data: {
          market: 'us', languageCode: 'en', siteId: 'site-onboarded', brandNames: ['X'], async: true,
        },
      });
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(202);
      expect(resolveSiteIdentityStub).to.have.been.calledOnceWith(ctx.dataAccess, 'site-onboarded');
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      const { chainedJobMetadata } = enqueueArgs.metadata;
      expect(chainedJobMetadata.suppliedSiteIdentity).to.deep.equal({ domain: 'acme.com', primaryUrl: 'acme.com/markets' });
      expect(chainedJobMetadata.suppliedSiteId).to.equal('site-onboarded');
    });

    it('createMarket does NOT resolve siteId when brandDomain is supplied (regression: unchanged)', async () => {
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', brandDomain: 'x.com', brandNames: ['X'], async: true,
        },
      }));
      expect(resolveSiteIdentityStub).to.not.have.been.called;
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      const { chainedJobMetadata } = enqueueArgs.metadata;
      expect(chainedJobMetadata.suppliedSiteIdentity).to.equal(null);
      expect(chainedJobMetadata.suppliedSiteId).to.equal(null);
    });

    it('createMarket 400s when a supplied siteId does not resolve to a domain', async () => {
      resolveSiteIdentityStub.resolves(null);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createMarket(fakeContext({
        data: {
          market: 'us', languageCode: 'en', siteId: 'site-bad', brandNames: ['X'],
        },
      }));
      expect(response.status).to.equal(400);
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
      expect(ensureMarketSiteStub).to.not.have.been.called;
    });

    it('deleteMarket routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } }));
      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteMarketSubworkspace).to.have.been.calledOnce;
    });

    it('deleteMarket unlinks the orphaned market site when the handler reports a deletedSiteId (LLMO-6405 R12)', async () => {
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204, deletedSiteId: 'site-x' });
      getBrandBaseSiteIdStub.resolves('primary-site'); // different from the deleted market site
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } });
      const response = await controller.deleteMarket(ctx);
      expect(response.status).to.equal(204);
      expect(getBrandBaseSiteIdStub).to.have.been.calledOnceWith(ORG, BRAND);
      expect(unlinkMarketSiteIfOrphanedStub).to.have.been.calledOnce;
      const [passedCtx, args] = unlinkMarketSiteIfOrphanedStub.firstCall.args;
      expect(passedCtx).to.equal(ctx);
      expect(args).to.deep.equal({ brandId: BRAND, siteId: 'site-x', primarySiteId: 'primary-site' });
    });

    it('deleteMarket does NOT attempt an unlink when the handler reports no deletedSiteId', async () => {
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204, deletedSiteId: null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } }));
      expect(response.status).to.equal(204);
      expect(getBrandBaseSiteIdStub).to.not.have.been.called;
      expect(unlinkMarketSiteIfOrphanedStub).to.not.have.been.called;
    });

    it('deleteMarket skips the unlink (fail-safe) when the primary-site lookup fails', async () => {
      handlers.handleDeleteMarketSubworkspace.resolves({ status: 204, deletedSiteId: 'site-x' });
      getBrandBaseSiteIdStub.rejects(new Error('db down'));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deleteMarket(fakeContext({ params: { geoTargetId: '2840', languageCode: 'en' } }));
      // Still a clean 204 (best-effort); the orphan link is left rather than risk
      // removing the primary on an unknown primary-site.
      expect(response.status).to.equal(204);
      expect(unlinkMarketSiteIfOrphanedStub).to.not.have.been.called;
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
      // .lastArg (the options object) rather than a positional index: the
      // assertion then survives a signature change that adds/removes an
      // earlier positional param, instead of silently checking the wrong arg.
      expect(handlers.handleCreatePromptsSubworkspace.firstCall.lastArg)
        .to.include({ originValue: 'human' });
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
      // No ctx.data → exercises the `ctx.data || {}` body-defaulting fallback.
      const response = await controller.createTag(fakeContext());
      expect(response.status).to.equal(201);
      expect(handlers.handleCreateTagSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleCreateTagSubworkspace.firstCall.args[1]).to.equal('subworkspace-ws-1');
      expect(handlers.handleCreateTagSubworkspace.firstCall.args[2]).to.deep.equal({});
      expect(handlers.handleCreateTag).to.not.have.been.called;
    });

    it('updateTag routes to the subworkspace handler with the brand workspace + tagId', async () => {
      handlers.handleUpdateTagSubworkspace.resolves({
        status: 200,
        body: {
          geoTargetId: 2840, languageCode: 'en', tagId: 'tag-1', tag: 'category:Footwear', parentId: null,
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.updateTag(fakeContext({ params: { tagId: 'tag-1' } }));
      expect(response.status).to.equal(200);
      expect(handlers.handleUpdateTagSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleUpdateTagSubworkspace.firstCall.args[1]).to.equal('subworkspace-ws-1');
      expect(handlers.handleUpdateTagSubworkspace.firstCall.args[2]).to.equal('tag-1');
      expect(handlers.handleUpdateTag).to.not.have.been.called;
    });

    it('deleteTag routes to the subworkspace handler with the brand workspace + tagId', async () => {
      handlers.handleDeleteTagSubworkspace.resolves({ status: 204 });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { tagId: 'tag-1' } });
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };
      const response = await controller.deleteTag(ctx);
      expect(response.status).to.equal(204);
      expect(handlers.handleDeleteTagSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleDeleteTagSubworkspace.firstCall.args[1]).to.equal('subworkspace-ws-1');
      expect(handlers.handleDeleteTagSubworkspace.firstCall.args[2]).to.equal('tag-1');
      expect(handlers.handleDeleteTag).to.not.have.been.called;
    });

    it('getTagImpact dispatches subworkspace arguments', async () => {
      handlers.handleTagImpactSubworkspace.resolves({
        status: 200,
        body: { tagId: 'tag-1', revision: '"subworkspace-revision"' },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ params: { tagId: 'tag-1' } });
      ctx.request = { url: 'https://x?geoTargetId=2840&languageCode=en' };

      const response = await controller.getTagImpact(ctx);

      expect(response.status).to.equal(200);
      expect(handlers.handleTagImpactSubworkspace).to.have.been.calledOnceWith(
        { name: 'transport' },
        'subworkspace-ws-1',
        'tag-1',
        { geoTargetId: 2840, languageCode: 'en' },
        sinon.match.object,
      );
      expect(handlers.handleTagImpact).not.to.have.been.called;
    });

    it('bulkDeletePrompts routes to the subworkspace handler in subworkspace mode', async () => {
      handlers.handleBulkDeletePromptsSubworkspace.resolves({ deleted: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.bulkDeletePrompts(fakeContext({ data: { prompts: [] } }));
      expect(response.status).to.equal(200);
      expect(handlers.handleBulkDeletePromptsSubworkspace).to.have.been.calledOnce;
      expect(handlers.handleBulkDeletePrompts).to.not.have.been.called;
    });

    it('bulkDeletePrompts threads the resolved callerId into the subworkspace handler options', async () => {
      handlers.handleBulkDeletePromptsSubworkspace.resolves({ deleted: 0, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      await controller.bulkDeletePrompts(fakeContext({ data: { prompts: [] } }));
      const options = handlers.handleBulkDeletePromptsSubworkspace.firstCall.args[4];
      expect(options.callerId).to.equal('unknown');
    });

    it('bulkTagPrompts reads Idempotency-Key from Headers-like objects in subworkspace mode', async () => {
      const data = {
        geoTargetId: 2840,
        languageCode: 'en',
        operation: 'remove',
        tagIds: ['tag-1'],
        filter: { tagIds: [], tagFilterMode: 'faceted-v1' },
      };
      handlers.handleBulkTagsSubworkspace.resolves({
        status: 202,
        body: {
          jobId: 'job-2', jobType: 'bulkTags', status: 'IN_PROGRESS', replayed: false,
        },
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const headers = {
        get: sinon.stub().callsFake((name) => (
          name.toLowerCase() === 'idempotency-key' ? 'headers-key' : null
        )),
      };
      const ctx = fakeContext({ data, headers });

      const response = await controller.bulkTagPrompts(ctx);

      expect(response.status).to.equal(202);
      expect(handlers.handleBulkTagsSubworkspace).to.have.been.calledOnceWith(
        ctx,
        { name: 'transport' },
        BRAND,
        ORG,
        'subworkspace-ws-1',
        data,
        'unknown',
        'headers-key',
        sinon.match.object,
      );
      expect(handlers.handleBulkTags).not.to.have.been.called;
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

    // The brand-lookup 404/500 checks that used to live here moved into
    // orchestrateCreateMarketSubworkspace itself (PR-C) — covered by
    // create-market-orchestration.test.js's "throws 404 when the brand does not exist" /
    // "throws 500 when Brand data-access is unavailable".
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

    // PR-C (LLMO-7352/LLMO-7418): the project-activation batch (ensureSubworkspace-once,
    // per-market handleCreateMarketSubworkspace, brand aliases/URLs/competitors read-once,
    // all-or-nothing site-link + status flip) moved VERBATIM into
    // `orchestrateActivateMarkets` (activate-markets-orchestration.js) — covered exhaustively by
    // activate-markets-orchestration.test.js. The controller-level tests below only verify
    // WIRING: the default (async absent/false) branch calls that orchestration with the right
    // params and passes its result straight through; `async: true` mints an attempt and enqueues
    // the job chain instead.
    it('activate (default, async absent) calls orchestrateActivateMarkets and passes its result straight through', async () => {
      orchestrateActivateMarketsStub.resolves({
        status: 200, body: { brandId: BRAND, status: 'active', markets: [] },
      });
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({
        brand,
        data: { brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }] },
      });
      const response = await controller.activate(ctx);

      expect(response.status).to.equal(200);
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnce;
      expect(orchestrateActivateMarketsStub).to.have.been.calledOnce;
      const params = orchestrateActivateMarketsStub.firstCall.args[0];
      expect(params.brandUuid).to.equal(BRAND);
      expect(params.parentWorkspaceId).to.equal(WORKSPACE);
      expect(params.orgId).to.equal(ORG);
      expect(params.requestBody).to.include({ brandDomain: 'x.com' });
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('activate maps a terminal subworkspace creation failure to its stable 502 token', async () => {
      const error = new ErrorWithStatusCode('Subworkspace creation failed', 502);
      error.code = ERROR_CODES.SUBWORKSPACE_CREATION_FAILED;
      ensureSubworkspaceStub.rejects(error);
      getBrandBaseSiteIdStub.resolves('primary-site');
      const controller = SerenityController({ env: {} }, fakeLog(), {});

      const response = await controller.activate(fakeContext());
      const body = await readBody(response);

      expect(response.status).to.equal(502);
      expect(body.error).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_FAILED);
      expect(body.message).to.equal('Subworkspace creation failed');
    });

    it('activate maps a workspace readiness timeout without exposing its workspace id', async () => {
      const error = new ErrorWithStatusCode('Subworkspace creation timed out', 504);
      error.code = ERROR_CODES.SUBWORKSPACE_CREATION_TIMEOUT;
      ensureSubworkspaceStub.rejects(error);
      getBrandBaseSiteIdStub.resolves('primary-site');
      const controller = SerenityController({ env: {} }, fakeLog(), {});

      const response = await controller.activate(fakeContext());
      const body = await readBody(response);

      expect(response.status).to.equal(504);
      expect(body.error).to.equal(ERROR_CODES.SUBWORKSPACE_CREATION_TIMEOUT);
      expect(body.message).to.equal('Subworkspace creation timed out');
      expect(JSON.stringify(body)).to.not.include(SUBWS);
    });

    it('activate mints a provisioning attempt and enqueues the provision->activate-markets job chain when async: true', async () => {
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }], async: true,
        },
      }));

      expect(response.status).to.equal(202);
      expect(orchestrateActivateMarketsStub).to.not.have.been.called;
      // LLMO-7418 external-review Finding 9: the async begin-site now reconciles a stale
      // in-flight attempt first, reusing the sync guard's own logic, before minting a new one.
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnceWith(BRAND);
      expect(beginProvisioningAttemptStub).to.have.been.calledOnce;
      expect(beginProvisioningAttemptStub.firstCall.args[0]).to.include({
        brandId: BRAND, updatedBy: 'serenity-activate',
      });
      expect(createAndEnqueueJobStub).to.have.been.calledOnce;
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.jobType).to.equal('serenity-provision-workspace');
      // LLMO-7418 external-review Finding N2: the brand's name is passed as the sub-workspace
      // title, so a flat-mode active brand reaching the worker's create path yields a titled,
      // adoptable workspace instead of the no-title fail-fast.
      expect(enqueueArgs.metadata.title).to.equal('Test Brand');
      expect(enqueueArgs.metadata.chainedJobType).to.equal('serenity-activate-markets');
      expect(enqueueArgs.metadata.chainedJobMetadata.brandId).to.equal(BRAND);
      expect(enqueueArgs.metadata.chainedJobMetadata.orgId).to.equal(ORG);
      // LLMO-7418 external-review Finding 17: the first hop's job id is recorded, not left
      // permanently NULL — only the worker's own self-requeue path used to write this.
      expect(updateProvisioningJobIdStub).to.have.been.calledOnceWith({
        brandId: BRAND,
        attemptId: beginProvisioningAttemptStub.firstCall.args[0].attemptId,
        jobId: 'job-abc',
        postgrestClient: sinon.match.any,
      });
    });

    it('activate answers 409 without enqueuing when async: true and a provisioning attempt is already in flight', async () => {
      beginProvisioningAttemptStub.resolves(false);
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }], async: true,
        },
      }));
      expect(response.status).to.equal(409);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('activate answers 503 without enqueuing when async: true and the async kill switch is on (LLMO-7418 external-review Finding 15)', async () => {
      isAsyncProvisioningKillSwitchedStub.resolves(true);
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }], async: true,
        },
      }));
      expect(response.status).to.equal(503);
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('activate 400s when async is present but not a boolean', async () => {
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }], async: 'yes',
        },
      }));
      expect(response.status).to.equal(400);
      expect(orchestrateActivateMarketsStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('activate runs the same synchronous path as an absent flag when async is explicitly false', async () => {
      orchestrateActivateMarketsStub.resolves({
        status: 200, body: { brandId: BRAND, status: 'active', markets: [] },
      });
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: {
          brandDomain: 'x.com', brandNames: ['X'], markets: [{ market: 'us', languageCode: 'en' }], async: false,
        },
      }));
      expect(response.status).to.equal(200);
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnce;
      expect(orchestrateActivateMarketsStub).to.have.been.calledOnce;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('activate 400s when generatePrompts is true but there is no primary URL (nothing to generate into)', async () => {
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand,
        data: { brandNames: ['X'], generatePrompts: true },
      }));
      expect(response.status).to.equal(400);
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
      expect(ensureSubworkspaceStub).to.not.have.been.called;
    });

    it('activate 400s a pending brand with no primary site instead of provisioning a doomed sub-workspace (SITES-49449)', async () => {
      // getBrandBaseSiteIdStub defaults to resolves(null) — a legacy pre-LLMO-6405
      // pending brand that never got a site_id. chk_active_brand_has_site_id now
      // requires site_id unconditionally, so ensureSubworkspace must never run:
      // a live sub-workspace would provision upstream and then the active-flip
      // save would still fail with a raw DB constraint violation.
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(400);
      expect(ensureSubworkspaceStub).to.not.have.been.called;
      expect(brand.setStatus).to.not.have.been.called;
      expect(brand.save).to.not.have.been.called;
    });

    it('activate of a pending brand with an empty body is sub-workspace-only (200, no project)', async () => {
      // LLMO-6405: a pending brand activates to just its sub-workspace + a status
      // flip. The wizard supplies no markets/URL; none are needed — no project is
      // created.
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      // SITES-49449: chk_active_brand_has_site_id requires site_id unconditionally —
      // the brand's primary site was set at create (LLMO-6405), verified upfront.
      getBrandBaseSiteIdStub.resolves('primary-site');
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(200);
      const { status, markets } = await readBody(response);
      expect(status).to.equal('active');
      expect(markets).to.deep.equal([]);
      // Sub-workspace ensured once; NO project, NO body-driven market path.
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      // Sub-workspace-only → skips the settle poll (LLMO-6569).
      expect(ensureSubworkspaceStub.firstCall.args[6]).to.have.property('createReadiness', 'skip');
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
      expect(updateBrandStub).to.not.have.been.called;
      expect(brand.setStatus).to.have.been.calledWith('active');
      expect(brand.save).to.have.been.calledOnce;
    });

    it('activate of a pending brand returns 502 (stays pending) when the sub-workspace flip fails to persist', async () => {
      // Sub-workspace ensured upstream but the active-status save diverges → the
      // brand stays pending; a retry converges (the sub-workspace 409s idempotently).
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      getBrandBaseSiteIdStub.resolves('primary-site');
      const brand = makeBrandModel({ save: sinon.stub().rejects(new Error('db down')) });
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(502);
      const { status, error, markets } = await readBody(response);
      expect(status).to.equal('pending');
      expect(error).to.equal('serenityActivationIncomplete');
      expect(markets).to.deep.equal([]);
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
      // Distinct, greppable token so the orphaned status is alertable.
      expect(log.error).to.have.been.calledWithMatch('SERENITY_ACTIVATE_SAVE_DIVERGENCE');
    });

    it('activate sub-workspace-only on an already-active brand returns 207 (not downgraded) when the save fails', async () => {
      const brand = makeBrandModel({
        getStatus: () => 'active',
        save: sinon.stub().rejects(new Error('db down')),
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(207);
      const { status } = await readBody(response);
      expect(status).to.equal('active');
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      // Bare reactivation is sub-workspace-only → skips the settle poll (LLMO-6569).
      expect(ensureSubworkspaceStub.firstCall.args[6]).to.have.property('createReadiness', 'skip');
    });

    it('PR-C: pending→active activation 409s (no workspace call) when a concurrent async provisioning attempt is in flight', async () => {
      const conflictErr = new ErrorWithStatusCode(
        'A Semrush sub-workspace provisioning attempt is already in progress for this brand; please retry shortly.',
        409,
      );
      conflictErr.code = 'semrush_provisioning_in_progress';
      guardAgainstConcurrentProvisioningStub.rejects(conflictErr);
      getBrandBaseSiteIdStub.resolves('primary-site');
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(409);
      const { error } = await readBody(response);
      expect(error).to.equal('semrush_provisioning_in_progress');
      expect(ensureSubworkspaceStub).to.not.have.been.called;
      expect(brand.setStatus).to.not.have.been.called;
    });

    it('PR-C: bare reactivation 409s (no workspace call) when a concurrent async provisioning attempt is in flight', async () => {
      const conflictErr = new ErrorWithStatusCode(
        'A Semrush sub-workspace provisioning attempt is already in progress for this brand; please retry shortly.',
        409,
      );
      conflictErr.code = 'semrush_provisioning_in_progress';
      guardAgainstConcurrentProvisioningStub.rejects(conflictErr);
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({ brand, data: { brandNames: ['X'] } }));
      expect(response.status).to.equal(409);
      expect(ensureSubworkspaceStub).to.not.have.been.called;
    });

    it('Phase 4: pending→active activation mints a provisioning attempt and enqueues the provision->activate-brand-workspace job chain when async: true', async () => {
      getBrandBaseSiteIdStub.resolves('primary-site');
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: true },
      }));

      expect(response.status).to.equal(202);
      expect(ensureSubworkspaceStub).to.not.have.been.called;
      // LLMO-7418 external-review Finding 9: reconciles a stale in-flight attempt first.
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnceWith(BRAND);
      expect(brand.setStatus).to.not.have.been.called;
      expect(beginProvisioningAttemptStub).to.have.been.calledOnce;
      expect(beginProvisioningAttemptStub.firstCall.args[0]).to.include({
        brandId: BRAND, updatedBy: 'serenity-activate',
      });
      expect(createAndEnqueueJobStub).to.have.been.calledOnce;
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.jobType).to.equal('serenity-provision-workspace');
      expect(enqueueArgs.metadata.chainedJobType).to.equal('serenity-activate-brand-workspace');
      expect(enqueueArgs.metadata.chainedJobMetadata)
        .to.deep.equal({ brandId: BRAND, wasPending: true });
      // LLMO-7418 external-review Finding 4: a pending brand is GUARANTEED pointer-less, so the
      // worker always takes the create path here — omitting title would create an untitled
      // sub-workspace on every single async pending->active activation.
      expect(enqueueArgs.metadata.title).to.equal('Test Brand');
      // LLMO-7418 external-review Finding 17: the first hop's job id is recorded, not left
      // permanently NULL — only the worker's own self-requeue path used to write this.
      expect(updateProvisioningJobIdStub).to.have.been.calledOnceWith({
        brandId: BRAND,
        attemptId: beginProvisioningAttemptStub.firstCall.args[0].attemptId,
        jobId: 'job-abc',
        postgrestClient: sinon.match.any,
      });
    });

    it('Phase 4: pending→active activation answers 409 without enqueuing when async: true and a provisioning attempt is already in flight', async () => {
      getBrandBaseSiteIdStub.resolves('primary-site');
      beginProvisioningAttemptStub.resolves(false);
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: true },
      }));
      expect(response.status).to.equal(409);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('Phase 4: pending→active activation answers 503 without enqueuing when the async kill switch is on (LLMO-7418 external-review Finding 15)', async () => {
      getBrandBaseSiteIdStub.resolves('primary-site');
      isAsyncProvisioningKillSwitchedStub.resolves(true);
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: true },
      }));
      expect(response.status).to.equal(503);
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('Phase 4: pending→active activation 400s when async is present but not a boolean', async () => {
      getBrandBaseSiteIdStub.resolves('primary-site');
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: 'yes' },
      }));
      expect(response.status).to.equal(400);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
      expect(ensureSubworkspaceStub).to.not.have.been.called;
    });

    it('Phase 4: pending→active activation runs the same synchronous flip as an absent flag when async is explicitly false', async () => {
      getBrandBaseSiteIdStub.resolves('primary-site');
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      const brand = makeBrandModel({});
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: false },
      }));
      expect(response.status).to.equal(200);
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnce;
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('Phase 4: bare reactivation mints a provisioning attempt and enqueues the provision->activate-brand-workspace job chain when async: true', async () => {
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: true },
      }));

      expect(response.status).to.equal(202);
      expect(ensureSubworkspaceStub).to.not.have.been.called;
      // LLMO-7418 external-review Finding 9: reconciles a stale in-flight attempt first.
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnceWith(BRAND);
      expect(createAndEnqueueJobStub).to.have.been.calledOnce;
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.metadata.chainedJobType).to.equal('serenity-activate-brand-workspace');
      expect(enqueueArgs.metadata.chainedJobMetadata)
        .to.deep.equal({ brandId: BRAND, wasPending: false });
      // LLMO-7418 external-review Finding 4: this branch's own synchronous twin defensively
      // handles a pointer-less brand via ensureSubworkspace, so the async path needs a real
      // title too rather than assuming a pointer always exists.
      expect(enqueueArgs.metadata.title).to.equal('Test Brand');
      // LLMO-7418 external-review Finding 17: the first hop's job id is recorded, not left
      // permanently NULL — only the worker's own self-requeue path used to write this.
      expect(updateProvisioningJobIdStub).to.have.been.calledOnceWith({
        brandId: BRAND,
        attemptId: beginProvisioningAttemptStub.firstCall.args[0].attemptId,
        jobId: 'job-abc',
        postgrestClient: sinon.match.any,
      });
    });

    it('Phase 4: bare reactivation answers 409 without enqueuing when async: true and a provisioning attempt is already in flight', async () => {
      beginProvisioningAttemptStub.resolves(false);
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: true },
      }));
      expect(response.status).to.equal(409);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('Phase 4: bare reactivation answers 503 without enqueuing when the async kill switch is on (LLMO-7418 external-review Finding 15)', async () => {
      isAsyncProvisioningKillSwitchedStub.resolves(true);
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: true },
      }));
      expect(response.status).to.equal(503);
      expect(beginProvisioningAttemptStub).to.not.have.been.called;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('Phase 4: bare reactivation 400s when async is present but not a boolean', async () => {
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: 'yes' },
      }));
      expect(response.status).to.equal(400);
      expect(createAndEnqueueJobStub).to.not.have.been.called;
      expect(ensureSubworkspaceStub).to.not.have.been.called;
    });

    it('Phase 4: bare reactivation runs the same synchronous flip as an absent flag when async is explicitly false', async () => {
      const brand = makeBrandModel({ getStatus: () => 'active' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand, data: { brandNames: ['X'], async: false },
      }));
      expect(response.status).to.equal(200);
      expect(guardAgainstConcurrentProvisioningStub).to.have.been.calledOnce;
      expect(ensureSubworkspaceStub).to.have.been.calledOnce;
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('activate 400s when the markets array exceeds the cap (validated before either branch dispatches)', async () => {
      const markets = Array.from({ length: 51 }, (_, i) => ({ market: 'us', languageCode: `l${i}` }));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      // An active brand + a brandDomain routes to the project path where the cap is enforced.
      const response = await controller.activate(fakeContext({
        brand: makeBrandModel({ getStatus: () => 'active' }),
        data: { markets, brandDomain: 'x.com', brandNames: ['X'] },
      }));
      expect(response.status).to.equal(400);
      // Bounded before any upstream work — never reaches orchestration or the guard.
      expect(orchestrateActivateMarketsStub).to.not.have.been.called;
      expect(guardAgainstConcurrentProvisioningStub).to.not.have.been.called;
    });

    it('deactivate decommissions the subworkspace, clears the pointer, and sets the brand pending', async () => {
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'subworkspace-ws-1' });
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
      // The pointer is cleared (disconnect) — the workspace itself is never deleted.
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledWith(null);
      expect(brand.setStatus).to.have.been.calledWith('pending');
      expect(brand.save).to.have.been.called;
      // LLMO-7418 external-review Finding 3: cancels any in-flight async provisioning attempt so
      // a late worker hop can't resurrect this brand back to active.
      expect(cancelProvisioningAttemptStub).to.have.been.calledOnceWith({
        brandId: BRAND,
        postgrestClient: sinon.match.any,
      });
    });

    it('deactivate does not fail when cancelling an in-flight provisioning attempt itself throws (best-effort)', async () => {
      cancelProvisioningAttemptStub.rejects(new Error('db blip'));
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'subworkspace-ws-1' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(brand.save).to.have.been.called;
    });

    it('deactivate tombstones the brand\'s mapping rows after decommission', async () => {
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'subworkspace-ws-1' });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ brand });
      const response = await controller.deactivate(ctx);
      expect(response.status).to.equal(200);
      expect(tombstoneAllForBrandStub).to.have.been.calledOnceWith(ctx.dataAccess, BRAND);
    });

    it('deactivate does NOT tombstone when the brand has no subworkspace (no-op decommission)', async () => {
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(tombstoneAllForBrandStub).to.not.have.been.called;
    });

    it('deactivate enables the linked-sub-workspace guard when the env flag is set', async () => {
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'subworkspace-ws-1' });
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
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => null });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(200);
      expect(decommissionStub).to.not.have.been.called;
      // Nothing to disconnect — the pointer is already null.
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
      expect(brand.setStatus).to.have.been.calledWith('pending');
    });

    it('deactivate re-reads the pointer after cancelling, so a promote that landed mid-flight is still decommissioned (LLMO-7418 external-review, adversarial)', async () => {
      // The brand is loaded BEFORE cancelProvisioningAttempt, so its in-memory pointer is a
      // pre-cancel snapshot. A worker hop whose promoteProvisioningReady committed in the
      // loadBrand -> cancel window has since written a canonical pointer this object cannot see.
      // Acting on the stale null would skip decommission entirely and leave that workspace live
      // behind a "successful" deactivate.
      const snapshot = makeBrandModel({ getSemrushSubWorkspaceId: () => null });
      const promoted = makeBrandModel({ getSemrushSubWorkspaceId: () => 'ws-late-promote' });
      const ctx = fakeContext({ brand: snapshot });
      // 1st read = loadBrand (stale), 2nd = brandPointerReloader after the cancel (fresh).
      ctx.dataAccess.Brand.findById = sinon.stub();
      ctx.dataAccess.Brand.findById.onFirstCall().resolves(snapshot);
      ctx.dataAccess.Brand.findById.resolves(promoted);

      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(ctx);

      expect(response.status).to.equal(200);
      // The freshly-promoted workspace is decommissioned, not silently skipped.
      expect(decommissionStub).to.have.been.calledOnce;
      expect(decommissionStub.firstCall.args[1]).to.equal('ws-late-promote');
      expect(snapshot.setStatus).to.have.been.calledWith('pending');
    });

    it('deactivate clears the resolver cache and logs a greppable divergence token when the brand save fails', async () => {
      // The upstream is already emptied by decommission; a failed save must not
      // leave the resolver routing to the emptied sub-workspace for the TTL, and
      // the non-atomic seam must emit a distinct, alertable marker.
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'subworkspace-ws-1' });
      brand.save = sinon.stub().rejects(new Error('db down'));
      const log = fakeLog();
      const controller = SerenityController({ env: {} }, log, {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(500);
      expect(decommissionStub).to.have.been.called;
      expect(brand.setSemrushSubWorkspaceId).to.have.been.calledWith(null);
      // cache was invalidated BEFORE the save threw.
      expect(clearBrandWorkspaceCacheStub).to.have.been.called;
      // distinct, greppable token so the orphaned state is alertable.
      expect(log.error).to.have.been.calledWithMatch('SERENITY_DEACTIVATE_SAVE_DIVERGENCE');
    });

    it('logs a null decommissionedWorkspaceId on a save-divergence for a brand that had no subworkspace', async () => {
      // No subworkspace → the decommission block is skipped, but the status save
      // still runs (and here fails). The divergence log's decommissionedWorkspaceId
      // must be null (the `: null` side of hasText(subworkspaceId) ? ... : null).
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => null });
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
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'subworkspace-ws-1' });
      decommissionStub.rejects(new ErrorWithStatusCode('upstream delete failed', 502));
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.deactivate(fakeContext({ brand }));
      expect(response.status).to.equal(502);
      expect(brand.setSemrushSubWorkspaceId).to.not.have.been.called;
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
      // .lastArg, not a positional index -- signature-independent (see the
      // sibling assertion above).
      expect(handlers.handleCreatePrompts.firstCall.lastArg)
        .to.include({ originValue: 'human' });
      expect(handlers.handleCreatePromptsSubworkspace).not.to.have.been.called;
    });

    it('passes ai origin to synchronous creates from a service principal', async () => {
      handlers.handleCreatePrompts.resolves({ created: 1, failed: [] });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createPrompts(fakeContext({
        authType: 'api-key',
        promiseToken: 'promise-token',
        data: { prompts: [{ text: 'generated prompt', region: 'us' }] },
      }));

      expect(response.status).to.equal(200);
      expect(handlers.handleCreatePrompts.firstCall.lastArg)
        .to.include({ originValue: 'ai' });
    });

    // serenity-docs#33 (+#2/#3): bulk import routes to the async job runner via a
    // DEDICATED `async: true` flag — NOT `deferPublish`. `deferPublish` stays a
    // synchronous publish-batching hint; keying async off its own flag keeps the
    // sync CSV-chunking client (which sets deferPublish on non-final chunks)
    // working synchronously and untouched.
    describe('async bulk routing (serenity-docs#33)', () => {
      it('enqueues a serenity-classify-prompts job and returns 202 when async is true (flat mode)', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const prompts = [{
          text: 'What is your return policy?', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
        }];
        const response = await controller.createPrompts(fakeContext({
          data: { async: true, prompts },
        }));

        expect(response.status).to.equal(202);
        const body = await readBody(response);
        expect(body).to.deep.equal({
          jobId: 'job-abc', jobType: 'classifyPrompts', status: 'IN_PROGRESS',
        });
        expect(createAndEnqueueJobStub).to.have.been.calledOnce;
        const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
        expect(enqueueArgs.jobType).to.equal('serenity-classify-prompts');
        expect(enqueueArgs.metadata).to.deep.equal({
          // callerId captured at enqueue time (LLMO-6289) — no auth profile on the
          // test context, so it resolves to the `unknown` sentinel. The default
          // resolveBrandWorkspaceStub is flat mode, so authMode is 'flat' and both
          // workspace ids are the org parent WORKSPACE.
          mode: 'create',
          brandId: BRAND,
          semrushWorkspaceId: WORKSPACE,
          authMode: 'flat',
          workspaceId: WORKSPACE,
          parentWorkspaceId: WORKSPACE,
          prompts,
          originValue: 'human',
          callerId: 'unknown',
        });
        // The synchronous path never runs.
        expect(handlers.handleCreatePrompts).to.not.have.been.called;
      });

      it('enqueues a serenity-classify-prompts job and returns 202 for subworkspace-mode async import, carrying authMode + parentWorkspaceId', async () => {
        resolveBrandWorkspaceStub.resolves({
          mode: 'subworkspace', workspaceId: SUBWS, parentWorkspaceId: WORKSPACE,
        });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const prompts = [{
          text: 'What is your return policy?', geoTargetId: 2840, languageCode: 'en', tagIds: ['tag-1'],
        }];
        const response = await controller.createPrompts(fakeContext({
          data: { async: true, prompts },
        }));

        expect(response.status).to.equal(202);
        const body = await readBody(response);
        expect(body).to.deep.equal({
          jobId: 'job-abc', jobType: 'classifyPrompts', status: 'IN_PROGRESS',
        });
        expect(createAndEnqueueJobStub).to.have.been.calledOnce;
        const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
        expect(enqueueArgs.jobType).to.equal('serenity-classify-prompts');
        expect(enqueueArgs.metadata).to.deep.equal({
          mode: 'create',
          brandId: BRAND,
          // In subworkspace mode `auth.workspaceId` IS the sub-workspace, and it is
          // carried under both `semrushWorkspaceId` (backwards-compatible worker
          // key) and the explicit `workspaceId`. `parentWorkspaceId` is the org
          // parent; `authMode` selects the worker's subworkspace create branch.
          semrushWorkspaceId: SUBWS,
          authMode: 'subworkspace',
          workspaceId: SUBWS,
          parentWorkspaceId: WORKSPACE,
          prompts,
          originValue: 'human',
          callerId: 'unknown',
        });
        // Neither synchronous create handler runs.
        expect(handlers.handleCreatePromptsSubworkspace).to.not.have.been.called;
        expect(handlers.handleCreatePrompts).to.not.have.been.called;
      });

      // Regression guard for the #2 collision (the whole point of this fix):
      // deferPublish alone MUST stay synchronous now that it no longer triggers
      // async — the sync CSV-chunking client sets it on every non-final chunk and
      // must never receive a 202 it does not handle.
      it('stays synchronous when deferPublish is true but async is absent (collision guard)', async () => {
        handlers.handleCreatePrompts.resolves({ created: 1, failed: [] });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.createPrompts(fakeContext({
          data: { deferPublish: true, prompts: [{ text: 'x', geoTargetId: 2840, languageCode: 'en' }] },
        }));

        expect(response.status).to.equal(200);
        expect(createAndEnqueueJobStub).to.not.have.been.called;
        expect(handlers.handleCreatePrompts).to.have.been.calledOnce;
      });

      it('records ai origin in async job metadata for a service principal', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        await controller.createPrompts(fakeContext({
          authType: 'api-key',
          promiseToken: 'promise-token',
          data: {
            async: true,
            prompts: [{ text: 'generated prompt', geoTargetId: 2840, languageCode: 'en' }],
          },
        }));

        const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
        expect(enqueueArgs.metadata.originValue).to.equal('ai');
      });

      it('stays synchronous (no enqueue) when async is absent, even for a large batch', async () => {
        handlers.handleCreatePrompts.resolves({ created: 1, failed: [] });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.createPrompts(fakeContext({
          data: { prompts: [{ text: 'x', geoTargetId: 2840, languageCode: 'en' }] },
        }));

        expect(response.status).to.equal(200);
        expect(createAndEnqueueJobStub).to.not.have.been.called;
        expect(handlers.handleCreatePrompts).to.have.been.calledOnce;
      });

      it('stays synchronous for subworkspace-mode brands when async is absent', async () => {
        resolveBrandWorkspaceStub.resolves({
          mode: 'subworkspace', workspaceId: SUBWS, parentWorkspaceId: WORKSPACE,
        });
        handlers.handleCreatePromptsSubworkspace.resolves({ created: 1, failed: [] });
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.createPrompts(fakeContext({
          data: { prompts: [{ text: 'x', geoTargetId: 2840, languageCode: 'en' }] },
        }));

        expect(response.status).to.equal(200);
        expect(createAndEnqueueJobStub).to.not.have.been.called;
        expect(handlers.handleCreatePromptsSubworkspace).to.have.been.calledOnce;
      });

      it('400s when async is not a boolean', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.createPrompts(fakeContext({
          data: { async: 'yes', prompts: [{ text: 'x', geoTargetId: 2840, languageCode: 'en' }] },
        }));

        expect(response.status).to.equal(400);
        expect(createAndEnqueueJobStub).to.not.have.been.called;
      });

      it('400s without enqueueing when async is true but prompts is empty', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.createPrompts(fakeContext({
          data: { async: true, prompts: [] },
        }));

        expect(response.status).to.equal(400);
        expect(createAndEnqueueJobStub).to.not.have.been.called;
      });

      it('400s without enqueueing when async is true and prompts exceeds the max item cap', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const tooMany = Array.from({ length: 501 }, (_, i) => ({
          text: `p${i}`, geoTargetId: 2840, languageCode: 'en',
        }));
        const response = await controller.createPrompts(fakeContext({
          data: { async: true, prompts: tooMany },
        }));

        expect(response.status).to.equal(400);
        expect(createAndEnqueueJobStub).to.not.have.been.called;
      });

      it('409s without enqueueing an async create whose caller tag set exceeds 50', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.createPrompts(fakeContext({
          data: {
            async: true,
            prompts: [{
              text: 'over limit',
              geoTargetId: 2840,
              languageCode: 'en',
              tagIds: Array.from({ length: 51 }, (_, index) => `tag-${index}`),
            }],
          },
        }));

        expect(response.status).to.equal(409);
        expect(await readBody(response)).to.deep.include({
          error: 'tagLimitExceeded',
          details: { attemptedCount: 51, maxPromptTagIds: 50 },
        });
        expect(createAndEnqueueJobStub).not.to.have.been.called;
      });
    });

    describe('getPromptsJobStatus — async job polling (serenity-docs#33 Layer 1)', () => {
      const JOB = '99999999-8888-7777-6666-555555555555';

      function makeAsyncJob({
        id = JOB,
        status = 'COMPLETED',
        result = null,
        error = null,
        brandId = BRAND,
        jobType = undefined,
      } = {}) {
        return {
          getId: () => id,
          getStatus: () => status,
          getResult: () => result,
          getError: () => error,
          getMetadata: () => ({
            brandId,
            promiseToken: { promise_token: 'secret' },
            ...(jobType ? { jobType } : {}),
          }),
        };
      }

      function ctxWithJob(job, { jobId = JOB } = {}) {
        const ctx = fakeContext({ params: { jobId } });
        ctx.dataAccess.AsyncJob = { findById: sinon.stub().resolves(job) };
        return ctx;
      }

      it('returns 200 with the stable {jobId,status,result,error} contract for a COMPLETED job', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const result = { created: [{ semrushPromptId: 'p1' }], published: true };
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob({ status: 'COMPLETED', result })),
        );
        expect(response.status).to.equal(200);
        const body = await readBody(response);
        expect(body).to.deep.equal({
          jobId: JOB, jobType: 'classifyPrompts', status: 'COMPLETED', result, error: null,
        });
        // Secrets on the job metadata are never exposed.
        expect(body).to.not.have.property('metadata');
      });

      it('exposes an explicit partial-failure outcome for a completed bulk-tags job', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const result = {
          outcome: 'PARTIAL_FAILURE',
          matchedCount: 2,
          updatedCount: 1,
          unchangedCount: 0,
          failureCount: 1,
          failures: [{
            semrushPromptId: 'p-2',
            code: 'serenityUpstreamError',
            message: 'The prompt could not be updated',
            retryable: true,
          }],
          publish: { state: 'SUCCEEDED', error: null },
        };
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob({
            status: 'COMPLETED',
            result,
            jobType: 'serenity-bulk-tags',
          })),
        );
        const body = await readBody(response);

        expect(body.jobType).to.equal('bulkTags');
        expect(body.status).to.equal('COMPLETED');
        expect(body.result.outcome).to.equal('PARTIAL_FAILURE');
        expect(body.error).to.equal(null);
      });

      it('sanitizes a FAILED job error to the documented public envelope', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const error = {
          code: 'NEEDS_REAUTH',
          message: 'Promise token exchange rejected',
          details: { promiseToken: 'secret', upstreamStatus: 401 },
        };
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob({ status: 'FAILED', result: null, error })),
        );
        expect(response.status).to.equal(200);
        const body = await readBody(response);
        expect(body).to.deep.equal({
          jobId: JOB,
          jobType: 'classifyPrompts',
          status: 'FAILED',
          result: null,
          error: {
            code: 'jobFailed',
            message: 'The background job failed',
            retryable: false,
          },
        });
        expect(JSON.stringify(body)).not.to.include('NEEDS_REAUTH');
        expect(JSON.stringify(body)).not.to.include('promiseToken');
      });

      it('surfaces promptCorpusIncomplete as a retryable public worker failure', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob({
            status: 'FAILED',
            jobType: 'serenity-bulk-tags',
            error: {
              code: 'promptCorpusIncomplete',
              message: 'Unable to read the complete prompt cohort',
              retryable: true,
            },
          })),
        );

        expect(await readBody(response)).to.deep.equal({
          jobId: JOB,
          jobType: 'bulkTags',
          status: 'FAILED',
          result: null,
          error: {
            code: 'promptCorpusIncomplete',
            message: 'Unable to read the complete prompt cohort',
            retryable: true,
          },
        });
      });

      it('does not expose an upstream URL from a FAILED job error', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob({
            status: 'FAILED',
            error: {
              code: 'serenityUpstreamError',
              message: 'POST https://internal.example/workspaces/secret failed',
              retryable: true,
            },
          })),
        );
        const body = await readBody(response);
        expect(body.error).to.deep.equal({
          code: 'serenityUpstreamError',
          message: 'Upstream request failed',
          retryable: true,
        });
      });

      it('404s when the job does not exist', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.getPromptsJobStatus(ctxWithJob(null));
        expect(response.status).to.equal(404);
      });

      it('404s (does not leak) when the job belongs to another brand', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob({ brandId: 'some-other-brand' })),
        );
        expect(response.status).to.equal(404);
      });

      it('400s on a non-UUID jobId', async () => {
        const controller = SerenityController({ env: {} }, fakeLog(), {});
        const response = await controller.getPromptsJobStatus(
          ctxWithJob(makeAsyncJob(), { jobId: 'not-a-uuid' }),
        );
        expect(response.status).to.equal(400);
      });

      // LLMO-7418 external-review Finding 8: a self-requeue or chained hand-off marks the FIRST
      // hop COMPLETED immediately, even though the real work hasn't run yet. These tests confirm
      // the endpoint follows the chain to its effective terminal status instead.
      describe('chain/requeue following (LLMO-7418 external-review Finding 8)', () => {
        const CHAINED_JOB = 'aaaaaaaa-1111-2222-3333-444444444444';
        const FINAL_JOB = 'bbbbbbbb-1111-2222-3333-444444444444';

        function ctxWithChain(jobsById, { jobId = JOB } = {}) {
          const ctx = fakeContext({ params: { jobId } });
          ctx.dataAccess.AsyncJob = {
            findById: sinon.stub().callsFake((id) => Promise.resolve(jobsById[id] ?? null)),
          };
          return ctx;
        }

        it('follows a chainedJobId to the market-create job\'s own terminal status, not the provisioning job\'s premature COMPLETED', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const finalResult = { status: 201, body: { projectId: 'proj-1' } };
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB,
              status: 'COMPLETED',
              jobType: 'serenity-provision-workspace',
              result: { provisioningStatus: 'ready', chainedJobId: CHAINED_JOB },
            }),
            [CHAINED_JOB]: makeAsyncJob({
              id: CHAINED_JOB, status: 'COMPLETED', result: finalResult,
            }),
          });

          const response = await controller.getPromptsJobStatus(ctx);
          const body = await readBody(response);

          // The ORIGINALLY-requested id is echoed back, not the chained job's.
          expect(body.jobId).to.equal(JOB);
          expect(body.status).to.equal('COMPLETED');
          expect(body.result).to.deep.equal(finalResult);
        });

        it('follows a requeuedJobId and reports IN_PROGRESS while the chain is still settling', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB, status: 'COMPLETED', jobType: 'serenity-provision-workspace', result: { requeuedJobId: CHAINED_JOB },
            }),
            [CHAINED_JOB]: makeAsyncJob({ id: CHAINED_JOB, status: 'IN_PROGRESS', result: null }),
          });

          const response = await controller.getPromptsJobStatus(ctx);
          const body = await readBody(response);

          expect(body.jobId).to.equal(JOB);
          expect(body.status).to.equal('IN_PROGRESS');
          expect(body.result).to.equal(null);
        });

        it('follows a multi-hop chain (requeue then chained job) to its final terminal status', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const finalResult = { status: 201, body: {} };
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB, status: 'COMPLETED', jobType: 'serenity-provision-workspace', result: { requeuedJobId: CHAINED_JOB },
            }),
            [CHAINED_JOB]: makeAsyncJob({
              id: CHAINED_JOB,
              status: 'COMPLETED',
              result: { provisioningStatus: 'ready', chainedJobId: FINAL_JOB },
            }),
            [FINAL_JOB]: makeAsyncJob({ id: FINAL_JOB, status: 'COMPLETED', result: finalResult }),
          });

          const response = await controller.getPromptsJobStatus(ctx);
          const body = await readBody(response);

          expect(body.status).to.equal('COMPLETED');
          expect(body.result).to.deep.equal(finalResult);
        });

        it('reports the last hop actually found when the chain names a dangling job id', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB, status: 'COMPLETED', jobType: 'serenity-provision-workspace', result: { chainedJobId: 'does-not-exist' },
            }),
          });

          const response = await controller.getPromptsJobStatus(ctx);
          const body = await readBody(response);

          expect(response.status).to.equal(200);
          expect(body.jobId).to.equal(JOB);
          expect(body.status).to.equal('COMPLETED');
          expect(body.result).to.deep.equal({ chainedJobId: 'does-not-exist' });
        });

        it('does not follow a chain when the first hop is not COMPLETED', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({ id: JOB, status: 'IN_PROGRESS', result: null }),
            [CHAINED_JOB]: makeAsyncJob({ id: CHAINED_JOB, status: 'COMPLETED', result: {} }),
          });

          const response = await controller.getPromptsJobStatus(ctx);
          const body = await readBody(response);

          expect(body.status).to.equal('IN_PROGRESS');
        });

        it('stops following after the hop cap, never loops forever on a cyclic chain', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const jobA = 'cccccccc-1111-2222-3333-444444444444';
          const jobB = 'dddddddd-1111-2222-3333-444444444444';
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB, status: 'COMPLETED', jobType: 'serenity-provision-workspace', result: { chainedJobId: jobA },
            }),
            [jobA]: makeAsyncJob({ id: jobA, status: 'COMPLETED', result: { chainedJobId: jobB } }),
            [jobB]: makeAsyncJob({ id: jobB, status: 'COMPLETED', result: { chainedJobId: jobA } }),
          });

          const response = await controller.getPromptsJobStatus(ctx);

          // Must resolve (not hang) and still answer 200 with SOME terminal status.
          expect(response.status).to.equal(200);
        });

        it('labels a provisioning job as provisionWorkspace, not the classifyPrompts default (LLMO-7418 external-review N4)', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB,
              status: 'COMPLETED',
              jobType: 'serenity-provision-workspace',
              result: { provisioningStatus: 'ready' },
            }),
          });

          const body = await readBody(await controller.getPromptsJobStatus(ctx));

          expect(body.jobType).to.equal('provisionWorkspace');
        });

        it('does NOT follow a classifyPrompts requeue chain — restores the pre-stack polling contract (LLMO-7418 external-review N5)', async () => {
          const controller = SerenityController({ env: {} }, fakeLog(), {});
          // A classify job self-requeues and returns requeuedJobId, but its shipped contract
          // returns the FIRST hop's result. The chain-follow must NOT reach into hop 2.
          const hopOneResult = { requeuedJobId: CHAINED_JOB, created: 3, skipped: 1 };
          const ctx = ctxWithChain({
            [JOB]: makeAsyncJob({
              id: JOB,
              status: 'COMPLETED',
              jobType: 'serenity-classify-prompts',
              result: hopOneResult,
            }),
            [CHAINED_JOB]: makeAsyncJob({
              id: CHAINED_JOB, status: 'IN_PROGRESS', result: null,
            }),
          });

          const body = await readBody(await controller.getPromptsJobStatus(ctx));

          // Reports the classify job's OWN first-hop COMPLETED + result, not the requeued hop's.
          expect(body.jobType).to.equal('classifyPrompts');
          expect(body.status).to.equal('COMPLETED');
          expect(body.result).to.deep.equal(hopOneResult);
        });
      });
    });

    it('builds a working type classifier from the brand name + aliases and passes it to the handler (serenity-docs#31)', async () => {
      handlers.handleCreatePrompts.resolves({ created: 1, failed: [] });
      // Brand name 'Test Brand' + a US-clamped alias 'Acme'.
      getBrandAliasesStub.resolves([{ name: 'Acme', regions: ['us'] }]);
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.createPrompts(fakeContext({
        data: { prompts: [{ text: 'x', geoTargetId: 2840, languageCode: 'en' }] },
      }));
      expect(response.status).to.equal(200);
      expect(getBrandAliasesStub).to.have.been.calledOnce;
      // The 7th positional arg to handleCreatePrompts is the classifier closure.
      const classify = handlers.handleCreatePrompts.firstCall.args[6];
      expect(classify).to.be.a('function');
      // US market (geoTargetId 2840): brand name and the US alias both classify.
      // The classifier yields a BARE `type` value; the dimension is the tag's root.
      expect(classify('do you sell Test Brand shoes?', 2840)).to.equal('branded');
      expect(classify('is Acme any good?', 2840)).to.equal('branded');
      expect(classify('best running shoes?', 2840)).to.equal('non-branded');
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
    it('activate falls back to {} body when ctx.data is absent (pending brand → sub-workspace-only 200)', async () => {
      handlers.handleCreateMarketSubworkspace.resolves({ status: 201, body: {} });
      getBrandBaseSiteIdStub.resolves('primary-site');
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.activate(ctx);
      // ctx.data undefined is handled as {} (no crash); a pending brand activates
      // sub-workspace-only regardless of body → 200, no project created.
      expect(response.status).to.equal(200);
      expect(handlers.handleCreateMarketSubworkspace).to.not.have.been.called;
    });

    // Line 907 (old): the non-array `markets` -> US/EN fallback derivation itself now lives
    // (and is re-derived) inside orchestrateActivateMarkets — covered by
    // activate-markets-orchestration.test.js. This only pins that a non-array value doesn't
    // trip the controller's own pre-dispatch MAX_MARKETS derivation/validation.
    it('activate treats a non-array markets value as empty (does not trip the pre-dispatch cap check)', async () => {
      orchestrateActivateMarketsStub.resolves({ status: 200, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const response = await controller.activate(fakeContext({
        brand: makeBrandModel({ getStatus: () => 'active' }),
        data: { markets: 'not-an-array', brandDomain: 'x.com', brandNames: ['X'] },
      }));
      expect(response.status).to.equal(200);
      expect(orchestrateActivateMarketsStub).to.have.been.calledOnce;
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
      const brand = makeBrandModel({ getSemrushSubWorkspaceId: () => 'sub-ws' });
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
        getSemrushSubWorkspaceId: () => 'sub-ws',
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
    // fallback fires when ctx.data is absent in subworkspace mode. With no data at all
    // there is no `async` field either, so this exercises the SYNCHRONOUS default branch
    // (the resulting brandDomain/primaryUrl null/null derivation is orchestration-internal —
    // covered by create-market-orchestration.test.js).
    it('createMarket passes an empty body ({}) to the synchronous orchestration when ctx.data is absent', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      orchestrateCreateMarketSubworkspaceStub.resolves({ status: 200, body: {} });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext();
      ctx.data = undefined;
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(200);
      const { requestBody } = orchestrateCreateMarketSubworkspaceStub.firstCall.args[0];
      expect(requestBody).to.deep.equal({});
    });

    it('createMarket enqueues an empty body ({}) as the chained job requestBody when ctx.data carries only async:true', async () => {
      resolveBrandWorkspaceStub.resolves({
        mode: 'subworkspace', workspaceId: 'sub-ws-1', parentWorkspaceId: WORKSPACE,
      });
      const controller = SerenityController({ env: {} }, fakeLog(), {});
      const ctx = fakeContext({ data: { async: true } });
      const response = await controller.createMarket(ctx);
      expect(response.status).to.equal(202);
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.metadata.chainedJobMetadata.requestBody).to.deep.equal({ async: true });
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
  it('returns the brand current semrush_sub_workspace_id when present', async () => {
    const ctx = {
      dataAccess: {
        Brand: { findById: sinon.stub().resolves({ getSemrushSubWorkspaceId: () => 'ws-current' }) },
      },
    };
    expect(await brandPointerReloader(ctx, 'brand-1')()).to.equal('ws-current');
  });

  it('returns null when the brand has no pointer', async () => {
    const ctx = {
      dataAccess: {
        Brand: { findById: sinon.stub().resolves({ getSemrushSubWorkspaceId: () => null }) },
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
