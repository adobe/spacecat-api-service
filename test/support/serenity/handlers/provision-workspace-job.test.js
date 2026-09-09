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
import {
  MAX_PROVISION_REQUEUE_DEPTH,
  computeProvisioningBackoffSeconds,
  TERMINAL_FAILURE_MESSAGE,
  REQUEUE_EXHAUSTED_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
} from '../../../../src/support/serenity/handlers/provision-workspace-job.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND_ID = 'brand-1';
const ATTEMPT_ID = 'attempt-1';
const PARENT_WS = 'parent-ws-1';
const TITLE = 'Acme';
const CANDIDATE_WS = 'candidate-ws-1';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function makeJob(metadata) {
  return { getId: () => 'job-1', getMetadata: () => metadata };
}

function pendingState(overrides = {}) {
  return {
    id: BRAND_ID,
    status: 'pending',
    semrushSubWorkspaceId: null,
    provisioningStatus: 'pending',
    provisioningAttemptId: ATTEMPT_ID,
    provisioningJobId: 'job-1',
    provisioningCandidateWorkspaceId: null,
    ...overrides,
  };
}

async function load({
  getBrandProvisioningStateStub,
  persistProvisioningCandidateStub,
  updateProvisioningJobIdStub,
  promoteProvisioningReadyStub,
  promoteProvisioningFailedStub,
  createOrAdoptSubworkspaceCandidateStub,
  emptyWorkspaceBestEffortStub,
  createAndEnqueueJobStub,
  transport,
}) {
  return esmock('../../../../src/support/serenity/handlers/provision-workspace-job.js', {
    '../../../../src/support/serenity/rest-transport.js': {
      createSerenityTransport: sinon.stub().returns(transport),
    },
    '../../../../src/support/serenity/async-job-runner.js': {
      createAndEnqueueJob: createAndEnqueueJobStub,
    },
    '../../../../src/support/serenity/workspace-lifecycle.js': {
      createOrAdoptSubworkspaceCandidate: createOrAdoptSubworkspaceCandidateStub,
      emptyWorkspaceBestEffort: emptyWorkspaceBestEffortStub,
      isWorkspaceReady: (status) => ['created', 'active', 'ready'].includes(status),
      isWorkspaceTerminalFailure: (status) => ['creation_failed', 'failed', 'error'].includes(status),
    },
    '../../../../src/support/brands-storage.js': {
      getBrandProvisioningState: getBrandProvisioningStateStub,
      persistProvisioningCandidate: persistProvisioningCandidateStub,
      updateProvisioningJobId: updateProvisioningJobIdStub,
      promoteProvisioningReady: promoteProvisioningReadyStub,
      promoteProvisioningFailed: promoteProvisioningFailedStub,
    },
  });
}

describe('handlers/provision-workspace-job.js (LLMO-7352 / LLMO-7418)', () => {
  let transport;
  let getBrandProvisioningStateStub;
  let persistProvisioningCandidateStub;
  let updateProvisioningJobIdStub;
  let promoteProvisioningReadyStub;
  let promoteProvisioningFailedStub;
  let createOrAdoptSubworkspaceCandidateStub;
  let emptyWorkspaceBestEffortStub;
  let createAndEnqueueJobStub;
  let postgrestClient;
  let context;

  beforeEach(() => {
    transport = { getWorkspaceStatus: sinon.stub() };
    postgrestClient = {};
    getBrandProvisioningStateStub = sinon.stub().resolves(pendingState());
    persistProvisioningCandidateStub = sinon.stub().resolves(true);
    updateProvisioningJobIdStub = sinon.stub().resolves(true);
    promoteProvisioningReadyStub = sinon.stub().resolves(true);
    promoteProvisioningFailedStub = sinon.stub().resolves(true);
    createOrAdoptSubworkspaceCandidateStub = sinon.stub().resolves({
      workspaceId: CANDIDATE_WS, freshlyCreated: true,
    });
    emptyWorkspaceBestEffortStub = sinon.stub().resolves();
    createAndEnqueueJobStub = sinon.stub().resolves({ getId: () => 'job-followup' });

    context = {
      env: {},
      log: fakeLog(),
      dataAccess: { Brand: {}, services: { postgrestClient } },
    };
  });

  async function loadHandler() {
    return load({
      getBrandProvisioningStateStub,
      persistProvisioningCandidateStub,
      updateProvisioningJobIdStub,
      promoteProvisioningReadyStub,
      promoteProvisioningFailedStub,
      createOrAdoptSubworkspaceCandidateStub,
      emptyWorkspaceBestEffortStub,
      createAndEnqueueJobStub,
      transport,
    });
  }

  function makeMetadata(overrides = {}) {
    return {
      brandId: BRAND_ID,
      attemptId: ATTEMPT_ID,
      parentWorkspaceId: PARENT_WS,
      title: TITLE,
      promiseToken: { promise_token: 'ptok-current' },
      ...overrides,
    };
  }

  describe('currency check (attempt superseded before any Semrush work)', () => {
    it('stands down when the brand no longer exists', async () => {
      getBrandProvisioningStateStub.resolves(null);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      expect(transport.getWorkspaceStatus).to.not.have.been.called;
      expect(createOrAdoptSubworkspaceCandidateStub).to.not.have.been.called;
    });

    it('stands down when a newer attempt id has already superseded this one', async () => {
      getBrandProvisioningStateStub.resolves(pendingState({ provisioningAttemptId: 'attempt-2' }));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      expect(createOrAdoptSubworkspaceCandidateStub).to.not.have.been.called;
    });

    it('stands down when the attempt already reached a terminal status', async () => {
      getBrandProvisioningStateStub.resolves(pendingState({ provisioningStatus: 'ready' }));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
    });
  });

  describe('first hop — no persisted candidate yet', () => {
    it('runs create-or-adopt, persists the candidate, and polls it', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'not_ready' });
      createAndEnqueueJobStub.resolves({ getId: () => 'job-followup' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await provisionWorkspaceHandler(context, job, 'token');

      expect(createOrAdoptSubworkspaceCandidateStub).to.have.been.calledOnceWith(
        transport,
        PARENT_WS,
        TITLE,
        context.log,
        { brandCollection: context.dataAccess.Brand, selfBrandId: BRAND_ID },
      );
      expect(persistProvisioningCandidateStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        candidateWorkspaceId: CANDIDATE_WS,
        postgrestClient,
      });
      expect(transport.getWorkspaceStatus).to.have.been.calledOnceWith(CANDIDATE_WS);
    });

    it('cleans up a freshly-created candidate when the persist CAS is rejected (superseded mid-flight)', async () => {
      persistProvisioningCandidateStub.resolves(false);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      expect(emptyWorkspaceBestEffortStub).to.have.been.calledOnceWith(
        transport,
        CANDIDATE_WS,
        PARENT_WS,
        context.log,
        'provision-worker-superseded-pre-poll',
      );
      expect(transport.getWorkspaceStatus).to.not.have.been.called;
    });

    it('does NOT clean up an ADOPTED candidate when the persist CAS is rejected', async () => {
      createOrAdoptSubworkspaceCandidateStub.resolves({
        workspaceId: CANDIDATE_WS,
        freshlyCreated: false,
      });
      persistProvisioningCandidateStub.resolves(false);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await provisionWorkspaceHandler(context, job, 'token');

      expect(emptyWorkspaceBestEffortStub).to.not.have.been.called;
    });
  });

  describe('resuming a self-requeued hop — candidate already persisted', () => {
    it('polls the SAME candidate (from job metadata, not re-read from the DB) without re-running create-or-adopt', async () => {
      getBrandProvisioningStateStub.resolves(
        pendingState({ provisioningCandidateWorkspaceId: CANDIDATE_WS }),
      );
      transport.getWorkspaceStatus.resolves({ status: 'not_ready' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({
        requeueDepth: 1, candidateWorkspaceId: CANDIDATE_WS, freshlyCreated: true,
      }));

      await provisionWorkspaceHandler(context, job, 'token');

      expect(createOrAdoptSubworkspaceCandidateStub).to.not.have.been.called;
      expect(persistProvisioningCandidateStub).to.not.have.been.called;
      expect(transport.getWorkspaceStatus).to.have.been.calledOnceWith(CANDIDATE_WS);
    });

    it('carries the candidate id AND its freshlyCreated provenance across another self-requeue hop', async () => {
      getBrandProvisioningStateStub.resolves(
        pendingState({ provisioningCandidateWorkspaceId: CANDIDATE_WS }),
      );
      transport.getWorkspaceStatus.resolves({ status: 'not_ready' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({
        requeueDepth: 1, candidateWorkspaceId: CANDIDATE_WS, freshlyCreated: true,
      }));

      await provisionWorkspaceHandler(context, job, 'token');

      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.metadata).to.deep.equal({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        parentWorkspaceId: PARENT_WS,
        title: TITLE,
        requeueDepth: 2,
        candidateWorkspaceId: CANDIDATE_WS,
        freshlyCreated: true,
      });
    });

    it('cleans up ITS OWN freshly-created candidate on stand-down, even though the DB row now reflects a NEWER attempt', async () => {
      // The winning attempt's row no longer carries OUR candidate id at all — it's a
      // different attempt entirely. Only our own job metadata still knows we created it.
      getBrandProvisioningStateStub.resolves(pendingState({
        provisioningAttemptId: 'attempt-2',
        provisioningCandidateWorkspaceId: 'some-other-candidate',
      }));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({
        requeueDepth: 1, candidateWorkspaceId: CANDIDATE_WS, freshlyCreated: true,
      }));

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      expect(emptyWorkspaceBestEffortStub).to.have.been.calledOnceWith(
        transport,
        CANDIDATE_WS,
        PARENT_WS,
        context.log,
        'provision-worker-superseded-stand-down',
      );
    });

    it('does NOT clean up an ADOPTED candidate on stand-down (never ours to tear down)', async () => {
      getBrandProvisioningStateStub.resolves(pendingState({ provisioningAttemptId: 'attempt-2' }));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({
        requeueDepth: 1, candidateWorkspaceId: CANDIDATE_WS, freshlyCreated: false,
      }));

      await provisionWorkspaceHandler(context, job, 'token');

      expect(emptyWorkspaceBestEffortStub).to.not.have.been.called;
    });
  });

  describe('poll result: ready', () => {
    it('promotes to ready and returns provisioningStatus ready', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(promoteProvisioningReadyStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        workspaceId: CANDIDATE_WS,
        hasSiteAnchor: false,
        postgrestClient,
        updatedBy: 'serenity-provision-worker',
      });
      expect(result).to.deep.equal({ provisioningStatus: 'ready' });
      expect(createAndEnqueueJobStub).to.not.have.been.called;
    });

    it('passes hasSiteAnchor: true through to promoteProvisioningReady when the brand already has a site_id (LLMO-7418 external-review Finding 5)', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      getBrandProvisioningStateStub.resolves(pendingState({ siteId: 'a-site-id' }));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await provisionWorkspaceHandler(context, job, 'token');

      expect(promoteProvisioningReadyStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        workspaceId: CANDIDATE_WS,
        hasSiteAnchor: true,
        postgrestClient,
        updatedBy: 'serenity-provision-worker',
      });
    });

    it('cleans up a freshly-created candidate when the promotion write fails for a reason other than the handled UNIQUE conflict (LLMO-7418 external-review Finding 5)', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      const checkViolation = new Error('new row for relation "brands" violates check constraint "chk_active_brand_has_site_id"');
      checkViolation.code = '23514';
      promoteProvisioningReadyStub.rejects(checkViolation);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await expect(provisionWorkspaceHandler(context, job, 'token')).to.be.rejectedWith(checkViolation.message);

      expect(emptyWorkspaceBestEffortStub).to.have.been.calledOnceWith(
        transport,
        CANDIDATE_WS,
        PARENT_WS,
        context.log,
        'provision-worker-ready-promotion-failed',
      );
      expect(promoteProvisioningFailedStub).to.have.been.calledOnce;
    });

    it('cleans up a freshly-created candidate when the ready-promotion CAS is lost', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      promoteProvisioningReadyStub.resolves(false);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      expect(emptyWorkspaceBestEffortStub).to.have.been.calledOnceWith(
        transport,
        CANDIDATE_WS,
        PARENT_WS,
        context.log,
        'provision-worker-cas-lost-ready',
      );
    });

    it('does NOT clean up an ADOPTED candidate when the ready-promotion CAS is lost', async () => {
      createOrAdoptSubworkspaceCandidateStub.resolves({
        workspaceId: CANDIDATE_WS,
        freshlyCreated: false,
      });
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      promoteProvisioningReadyStub.resolves(false);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await provisionWorkspaceHandler(context, job, 'token');

      expect(emptyWorkspaceBestEffortStub).to.not.have.been.called;
    });

    it('empties a freshly-created candidate on a UNIQUE-conflict 409 (a duplicate raced to the same id)', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      const conflictErr = new Error('conflict');
      conflictErr.code = 'semrush_workspace_id_conflict';
      promoteProvisioningReadyStub.rejects(conflictErr);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      expect(emptyWorkspaceBestEffortStub).to.have.been.calledOnceWith(
        transport,
        CANDIDATE_WS,
        PARENT_WS,
        context.log,
        'provision-worker-workspace-id-conflict',
      );
    });

    it('rethrows a non-conflict error from promoteProvisioningReady, and best-effort records it as failed via the generic catch', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      promoteProvisioningReadyStub.rejects(new Error('db blew up'));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await expect(provisionWorkspaceHandler(context, job, 'token')).to.be.rejectedWith('db blew up');

      expect(promoteProvisioningFailedStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        error: UNEXPECTED_ERROR_MESSAGE,
        postgrestClient,
      });
    });
  });

  describe('poll result: terminal failure', () => {
    it('promotes to failed WITHOUT attempting cleanup (a failed shell cannot be deleted)', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'creation_failed' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(promoteProvisioningFailedStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        error: TERMINAL_FAILURE_MESSAGE,
        postgrestClient,
      });
      expect(result).to.deep.equal({ provisioningStatus: 'failed' });
      expect(emptyWorkspaceBestEffortStub).to.not.have.been.called;
    });
  });

  describe('poll result: not ready — bounded self-requeue with backoff', () => {
    it('self-requeues with the SAME candidate id and depth+1, forwarding the promise token', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'not_ready' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({ requeueDepth: 0 }));

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(createAndEnqueueJobStub).to.have.been.calledOnce;
      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.jobType).to.equal('serenity-provision-workspace');
      expect(enqueueArgs.promiseToken).to.deep.equal({ promise_token: 'ptok-current' });
      expect(enqueueArgs.metadata).to.deep.equal({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        parentWorkspaceId: PARENT_WS,
        title: TITLE,
        requeueDepth: 1,
        candidateWorkspaceId: CANDIDATE_WS,
        freshlyCreated: true,
      });
      expect(enqueueArgs.delaySeconds).to.equal(5);
      expect(updateProvisioningJobIdStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        jobId: 'job-followup',
        postgrestClient,
      });
      expect(result).to.deep.equal({ requeuedJobId: 'job-followup' });
    });

    it('doubles the backoff on each successive hop', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'not_ready' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({ requeueDepth: 2 }));

      await provisionWorkspaceHandler(context, job, 'token');

      const [, enqueueArgs] = createAndEnqueueJobStub.firstCall.args;
      expect(enqueueArgs.metadata.requeueDepth).to.equal(3);
      expect(enqueueArgs.delaySeconds).to.equal(20);
    });

    it('fails the attempt outright once the requeue depth cap is reached, without requeuing again', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'not_ready' });
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata({ requeueDepth: MAX_PROVISION_REQUEUE_DEPTH }));

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(createAndEnqueueJobStub).to.not.have.been.called;
      expect(promoteProvisioningFailedStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        error: REQUEUE_EXHAUSTED_MESSAGE,
        postgrestClient,
      });
      expect(result).to.deep.equal({ provisioningStatus: 'failed' });
    });
  });

  describe('computeProvisioningBackoffSeconds (pure function)', () => {
    it('doubles for every requeue depth, exhaustively for every allowed hop', () => {
      expect(computeProvisioningBackoffSeconds(0)).to.equal(5);
      expect(computeProvisioningBackoffSeconds(1)).to.equal(10);
      expect(computeProvisioningBackoffSeconds(2)).to.equal(20);
      expect(computeProvisioningBackoffSeconds(3)).to.equal(40);
      expect(computeProvisioningBackoffSeconds(4)).to.equal(80);
    });
  });

  describe('unexpected errors (LLMO-7418 adversarial-review finding)', () => {
    it('records a sanitized failure reason and RE-THROWS the original error when getBrandProvisioningState itself throws', async () => {
      getBrandProvisioningStateStub.rejects(new Error('connection timeout'));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await expect(provisionWorkspaceHandler(context, job, 'token')).to.be.rejectedWith('connection timeout');

      expect(promoteProvisioningFailedStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        error: UNEXPECTED_ERROR_MESSAGE,
        postgrestClient,
      });
    });

    it('records a sanitized failure reason and RE-THROWS when create-or-adopt throws mid-flow', async () => {
      createOrAdoptSubworkspaceCandidateStub.rejects(new Error('upstream 502'));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await expect(provisionWorkspaceHandler(context, job, 'token')).to.be.rejectedWith('upstream 502');

      expect(promoteProvisioningFailedStub).to.have.been.calledOnceWith({
        brandId: BRAND_ID,
        attemptId: ATTEMPT_ID,
        error: UNEXPECTED_ERROR_MESSAGE,
        postgrestClient,
      });
    });

    it('still re-throws the ORIGINAL error even if the best-effort failure-recording call itself throws', async () => {
      getBrandProvisioningStateStub.rejects(new Error('original failure'));
      promoteProvisioningFailedStub.rejects(new Error('DB is also down'));
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      await expect(provisionWorkspaceHandler(context, job, 'token')).to.be.rejectedWith('original failure');
    });

    it('does NOT run the generic catch-all for the already-handled semrush_workspace_id_conflict shape', async () => {
      transport.getWorkspaceStatus.resolves({ status: 'active' });
      const conflictErr = new Error('conflict');
      conflictErr.code = 'semrush_workspace_id_conflict';
      promoteProvisioningReadyStub.rejects(conflictErr);
      const { provisionWorkspaceHandler } = await loadHandler();
      const job = makeJob(makeMetadata());

      const result = await provisionWorkspaceHandler(context, job, 'token');

      expect(result).to.deep.equal({ provisioningStatus: 'superseded' });
      // promoteProvisioningFailedStub must NOT have been called with the generic
      // unexpected-error message — this shape is already fully handled inline.
      expect(promoteProvisioningFailedStub).to.not.have.been.called;
    });
  });
});
