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
const JOB_ID = '99999999-8888-7777-6666-555555555555';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

/**
 * The generation-job polling + reauth endpoints exercise the shared SEC-5
 * `loadJobScopedToCaller` primitive and the Gap-6 reauth authorization. This
 * suite mocks only the auth/dependency seams and drives the two endpoints
 * directly.
 */
describe('SerenityController — Semrush-market generation endpoints', () => {
  let SerenityController;
  let loadJobScopedToCallerStub;
  let getIMSPromiseTokenStub;
  let resolvePromisePairStub;
  let hasAccessStub;
  let claimJobForReauthStub;

  async function build() {
    loadJobScopedToCallerStub = sinon.stub();
    getIMSPromiseTokenStub = sinon.stub().resolves({ promise_token: 'fresh-ptok', expires_in: 300 });
    resolvePromisePairStub = sinon.stub().returns('SEMRUSH');
    hasAccessStub = sinon.stub().resolves(true);
    claimJobForReauthStub = sinon.stub().resolves(true);

    SerenityController = (await esmock('../../src/controllers/serenity.js', {
      '../../src/support/async-job-access.js': {
        loadJobScopedToCaller: loadJobScopedToCallerStub,
      },
      '../../src/support/serenity/job-lease.js': {
        claimJobForReauth: claimJobForReauthStub,
      },
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
      },
      '../../src/support/prompts-storage.js': {
        resolveBrandUuid: sinon.stub().resolves(BRAND),
      },
      '../../src/support/serenity/serenity-active.js': {
        isSerenityActiveForBrand: sinon.stub().resolves(true),
      },
      '../../src/support/serenity/workspace-resolver.js': {
        resolveBrandWorkspace: sinon.stub().resolves({
          mode: 'subworkspace', workspaceId: 'ws-1', parentWorkspaceId: 'pws-1',
        }),
        clearBrandWorkspaceCache: sinon.stub(),
      },
      '../../src/support/utils.js': {
        getIMSPromiseToken: getIMSPromiseTokenStub,
        resolvePromisePair: resolvePromisePairStub,
      },
    })).default;
  }

  beforeEach(build);
  afterEach(() => sinon.restore());

  function baseCtx(overrides = {}) {
    return {
      env: { SERENITY_MARKET_JOBS_QUEUE_URL: 'market-queue-url' },
      params: { spaceCatId: ORG, brandId: BRAND, jobId: JOB_ID },
      dataAccess: {
        Organization: { findById: sinon.stub().resolves({ getId: () => ORG }) },
        services: { postgrestClient: { from: () => ({}) } },
      },
      attributes: { authInfo: { getProfile: () => ({ user_id: 'U1' }) } },
      pathInfo: { headers: {} },
      sqs: { sendMessage: sinon.stub().resolves() },
      ...overrides,
    };
  }

  function jobStub({
    status = 'IN_PROGRESS', metadata = {}, result, error, setters = {},
  } = {}) {
    return {
      getId: () => JOB_ID,
      getStatus: () => status,
      getMetadata: () => ({ jobType: 'serenity-generate-semrush-market', brandId: BRAND, ...metadata }),
      getResult: () => result,
      getError: () => error,
      getCreatedAt: () => '2026-09-01T00:00:00.000Z',
      getUpdatedAt: () => '2026-09-02T00:00:00.000Z',
      setStatus: setters.setStatus ?? sinon.stub(),
      setMetadata: setters.setMetadata ?? sinon.stub(),
      setError: setters.setError ?? sinon.stub(),
      save: setters.save ?? sinon.stub().resolves(),
    };
  }

  describe('getSemrushMarketGenerationJobStatus (polling)', () => {
    it('returns a token-safe DTO for an owned job', async () => {
      const job = jobStub({
        status: 'COMPLETED',
        metadata: { promiseToken: { promise_token: 'SECRET' } },
        result: {
          promptCount: 4, projectId: 'p1', published: true, verdict: 'ship',
        },
      });
      loadJobScopedToCallerStub.resolves({ job });
      const controller = SerenityController(baseCtx(), fakeLog(), {});

      const res = await controller.getSemrushMarketGenerationJobStatus(baseCtx());

      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(JSON.stringify(body)).to.not.contain('SECRET');
      expect(body.jobType).to.equal('generateSemrushMarket');
      expect(body.result.promptCount).to.equal(4);
      // The polling endpoint MUST route through the SEC-5 primitive.
      expect(loadJobScopedToCallerStub).to.have.been.calledOnce;
      const args = loadJobScopedToCallerStub.firstCall.args[1];
      expect(args.allowedJobTypes).to.deep.equal(['serenity-generate-semrush-market']);
    });

    it('404s a job belonging to another brand', async () => {
      loadJobScopedToCallerStub.resolves({ job: jobStub({ metadata: { brandId: 'other-brand' } }) });
      const controller = SerenityController(baseCtx(), fakeLog(), {});
      const res = await controller.getSemrushMarketGenerationJobStatus(baseCtx());
      expect(res.status).to.equal(404);
    });

    it('passes through the primitive access error', async () => {
      loadJobScopedToCallerStub.resolves({ error: { status: 404 } });
      const controller = SerenityController(baseCtx(), fakeLog(), {});
      const res = await controller.getSemrushMarketGenerationJobStatus(baseCtx());
      expect(res.status).to.equal(404);
    });

    it('returns a siteless job to its owning brand (brand-scoping is the sole control when metadata.siteId is absent)', async () => {
      // A generation job on a brand with no linked site carries no metadata.siteId;
      // the primitive scopes it by jobType, and the controller's brand-match is the
      // sole ownership control. Owned by the caller's brand → returned.
      const siteless = jobStub({ status: 'IN_PROGRESS', metadata: { brandId: BRAND } });
      expect(siteless.getMetadata().siteId).to.equal(undefined);
      loadJobScopedToCallerStub.resolves({ job: siteless });
      const controller = SerenityController(baseCtx(), fakeLog(), {});
      const res = await controller.getSemrushMarketGenerationJobStatus(baseCtx());
      expect(res.status).to.equal(200);
    });

    it('400s an invalid jobId', async () => {
      const controller = SerenityController(baseCtx(), fakeLog(), {});
      const ctx = baseCtx({ params: { spaceCatId: ORG, brandId: BRAND, jobId: 'not-a-uuid' } });
      const res = await controller.getSemrushMarketGenerationJobStatus(ctx);
      expect(res.status).to.equal(400);
    });
  });

  describe('reauthSemrushMarketGenerationJob (Gap 6)', () => {
    function reauthJob(setters) {
      return jobStub({
        status: 'FAILED',
        error: { code: 'NEEDS_REAUTH', message: 'dead token' },
        metadata: { imsUserId: 'U1', promiseToken: { promise_token: 'old' } },
        setters,
      });
    }

    it('re-authenticates, swaps the token, flips to IN_PROGRESS, and re-enqueues the same job id', async () => {
      const setStatus = sinon.stub();
      const setMetadata = sinon.stub();
      const setError = sinon.stub();
      const save = sinon.stub().resolves();
      loadJobScopedToCallerStub.resolves({
        job: reauthJob({
          setStatus, setMetadata, setError, save,
        }),
      });
      const ctx = baseCtx();
      const controller = SerenityController(ctx, fakeLog(), {});

      const res = await controller.reauthSemrushMarketGenerationJob(ctx);

      expect(res.status).to.equal(202);
      expect(getIMSPromiseTokenStub).to.have.been.calledWith(ctx, 'SEMRUSH');
      expect(setStatus).to.have.been.calledWith('IN_PROGRESS');
      expect(setError).to.have.been.calledWith(null);
      const persisted = setMetadata.firstCall.args[0];
      expect(persisted.promiseToken).to.deep.equal({ promise_token: 'fresh-ptok', expires_in: 300 });
      expect(persisted.promisePair).to.equal('SEMRUSH');
      expect(save).to.have.been.calledOnce;
      expect(claimJobForReauthStub).to.have.been.calledOnceWith(ctx, JOB_ID);
      expect(ctx.sqs.sendMessage).to.have.been.calledOnceWith('market-queue-url', {
        jobId: JOB_ID, type: 'serenity-generate-semrush-market',
      });
    });

    it('409s and never mints a second token when it loses the atomic reauth claim (TOCTOU)', async () => {
      // Two racing reauth requests: this one loses the PostgREST compare-and-set.
      claimJobForReauthStub.resolves(false);
      loadJobScopedToCallerStub.resolves({ job: reauthJob() });
      const ctx = baseCtx();
      const controller = SerenityController(ctx, fakeLog(), {});
      const res = await controller.reauthSemrushMarketGenerationJob(ctx);
      expect(res.status).to.equal(409);
      // The loser must NOT mint a second promise token.
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
      expect(ctx.sqs.sendMessage).to.not.have.been.called;
    });

    it('403s a different IMS user (fail-closed strict claim)', async () => {
      loadJobScopedToCallerStub.resolves({ job: reauthJob() });
      const ctx = baseCtx({ attributes: { authInfo: { getProfile: () => ({ user_id: 'U2' }) } } });
      const controller = SerenityController(ctx, fakeLog(), {});
      const res = await controller.reauthSemrushMarketGenerationJob(ctx);
      expect(res.status).to.equal(403);
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
    });

    it('403s when the original user id is unresolvable (fail-closed)', async () => {
      loadJobScopedToCallerStub.resolves({
        job: jobStub({
          status: 'FAILED',
          error: { code: 'NEEDS_REAUTH', message: 'x' },
          metadata: { promiseToken: { promise_token: 'old' } }, // no imsUserId
        }),
      });
      const ctx = baseCtx();
      const controller = SerenityController(ctx, fakeLog(), {});
      const res = await controller.reauthSemrushMarketGenerationJob(ctx);
      expect(res.status).to.equal(403);
    });

    it('409s a job not awaiting re-authentication', async () => {
      loadJobScopedToCallerStub.resolves({ job: jobStub({ status: 'IN_PROGRESS', metadata: { imsUserId: 'U1' } }) });
      const ctx = baseCtx();
      const controller = SerenityController(ctx, fakeLog(), {});
      const res = await controller.reauthSemrushMarketGenerationJob(ctx);
      expect(res.status).to.equal(409);
    });

    it('400s when the Semrush promise pair is not presented', async () => {
      resolvePromisePairStub.returns(undefined);
      loadJobScopedToCallerStub.resolves({ job: reauthJob() });
      const ctx = baseCtx();
      const controller = SerenityController(ctx, fakeLog(), {});
      const res = await controller.reauthSemrushMarketGenerationJob(ctx);
      expect(res.status).to.equal(400);
      expect(getIMSPromiseTokenStub).to.not.have.been.called;
    });
  });
});
