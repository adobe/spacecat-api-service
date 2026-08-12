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

function makeJob(initialMetadata = {}) {
  let metadata = { ...initialMetadata };
  let status;
  let error;
  return {
    getId: () => 'job-123',
    getMetadata: () => metadata,
    setMetadata: (m) => { metadata = m; },
    setStatus: (s) => { status = s; },
    getStatus: () => status,
    setError: (e) => { error = e; },
    getError: () => error,
    save: sinon.stub().resolves(),
    remove: sinon.stub().resolves(),
  };
}

describe('async-job-runner', () => {
  let sandbox;
  let exchangeTokenStub;
  let invalidatePromiseTokenStub;
  let getPromiseTokenStub;
  let resolvePromisePairStub;
  let createFromStub;
  let createAndEnqueueJob;
  let exchangeAndPersistPromiseToken;
  let invalidateJobPromiseToken;
  let NeedsReauthError;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    exchangeTokenStub = sandbox.stub();
    invalidatePromiseTokenStub = sandbox.stub().resolves();
    getPromiseTokenStub = sandbox.stub();
    resolvePromisePairStub = sandbox.stub().returns(undefined);
    createFromStub = sandbox.stub().returns({
      exchangeToken: exchangeTokenStub,
      invalidatePromiseToken: invalidatePromiseTokenStub,
    });

    ({
      createAndEnqueueJob,
      exchangeAndPersistPromiseToken,
      invalidateJobPromiseToken,
      NeedsReauthError,
    } = await esmock('../../../src/support/serenity/async-job-runner.js', {
      '@adobe/spacecat-shared-ims-client': {
        ImsPromiseClient: {
          createFrom: createFromStub,
          CLIENT_TYPE: { CONSUMER: 'consumer', EMITTER: 'emitter' },
        },
      },
      '../../../src/support/utils.js': {
        getIMSPromiseToken: getPromiseTokenStub,
        resolvePromisePair: resolvePromisePairStub,
      },
    }));
  });

  afterEach(() => sandbox.restore());

  describe('createAndEnqueueJob', () => {
    it('creates the job with the promise token on metadata and sends only { jobId, type }', async () => {
      getPromiseTokenStub.resolves({ promise_token: 'ptok', expires_in: 14399 });
      const job = makeJob();
      const createStub = sandbox.stub().resolves(job);
      const sendMessageStub = sandbox.stub().resolves();
      const context = {
        dataAccess: { AsyncJob: { create: createStub } },
        sqs: { sendMessage: sendMessageStub },
        env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'queue-url' },
        log: { error: sandbox.stub(), warn: sandbox.stub() },
      };

      const result = await createAndEnqueueJob(context, {
        jobType: 'serenity-classify-prompts',
        metadata: { foo: 'bar' },
      });

      expect(result).to.equal(job);
      expect(createStub).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          foo: 'bar',
          jobType: 'serenity-classify-prompts',
          promiseToken: { promise_token: 'ptok', expires_in: 14399 },
          promisePair: undefined,
        },
      });
      expect(sendMessageStub).to.have.been.calledWith('queue-url', {
        jobId: 'job-123',
        type: 'serenity-classify-prompts',
      });
    });

    it('uses an explicitly-supplied promiseToken instead of minting one, when provided', async () => {
      const job = makeJob();
      const createStub = sandbox.stub().resolves(job);
      const context = {
        dataAccess: { AsyncJob: { create: createStub } },
        sqs: { sendMessage: sandbox.stub().resolves() },
        env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'queue-url' },
        log: { error: sandbox.stub(), warn: sandbox.stub() },
      };

      await createAndEnqueueJob(context, {
        jobType: 'serenity-classify-prompts',
        metadata: { mode: 'reclassify' },
        promiseToken: { promise_token: 'forwarded-ptok' },
      });

      expect(getPromiseTokenStub).to.not.have.been.called;
      expect(createStub).to.have.been.calledWith({
        status: 'IN_PROGRESS',
        metadata: {
          mode: 'reclassify',
          jobType: 'serenity-classify-prompts',
          promiseToken: { promise_token: 'forwarded-ptok' },
          promisePair: undefined,
        },
      });
    });

    it('mints with the audience pair from the request and persists it on metadata', async () => {
      resolvePromisePairStub.returns('SEMRUSH');
      getPromiseTokenStub.resolves({ promise_token: 'ptok' });
      const job = makeJob();
      const createStub = sandbox.stub().resolves(job);
      const context = {
        dataAccess: { AsyncJob: { create: createStub } },
        sqs: { sendMessage: sandbox.stub().resolves() },
        env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'queue-url' },
        log: { error: sandbox.stub(), warn: sandbox.stub() },
      };

      await createAndEnqueueJob(context, { jobType: 'serenity-classify-prompts' });

      expect(getPromiseTokenStub).to.have.been.calledWith(context, 'SEMRUSH');
      const created = createStub.firstCall.args[0];
      expect(created.metadata.promisePair).to.equal('SEMRUSH');
    });

    it('prefers an explicit promisePair over the request header (worker self-requeue)', async () => {
      getPromiseTokenStub.resolves({ promise_token: 'ptok' });
      const job = makeJob();
      const createStub = sandbox.stub().resolves(job);
      const context = {
        dataAccess: { AsyncJob: { create: createStub } },
        sqs: { sendMessage: sandbox.stub().resolves() },
        env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'queue-url' },
        log: { error: sandbox.stub(), warn: sandbox.stub() },
      };

      await createAndEnqueueJob(context, {
        jobType: 'serenity-classify-prompts',
        promisePair: 'SEMRUSH',
      });

      expect(resolvePromisePairStub).to.not.have.been.called;
      expect(getPromiseTokenStub).to.have.been.calledWith(context, 'SEMRUSH');
      expect(createStub.firstCall.args[0].metadata.promisePair).to.equal('SEMRUSH');
    });

    it('rolls back the created job when the SQS send fails', async () => {
      getPromiseTokenStub.resolves({ promise_token: 'ptok' });
      const job = makeJob();
      const context = {
        dataAccess: { AsyncJob: { create: sandbox.stub().resolves(job) } },
        sqs: { sendMessage: sandbox.stub().rejects(new Error('sqs down')) },
        env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'queue-url' },
        log: { error: sandbox.stub(), warn: sandbox.stub() },
      };

      await expect(createAndEnqueueJob(context, { jobType: 'x' }))
        .to.be.rejectedWith('sqs down');

      expect(job.remove).to.have.been.called;
    });

    it('still propagates the original enqueue error when both remove() and the fallback save() fail', async () => {
      getPromiseTokenStub.resolves({ promise_token: 'ptok' });
      const job = makeJob();
      job.remove = sandbox.stub().rejects(new Error('remove failed'));
      job.save = sandbox.stub().rejects(new Error('save failed'));
      const context = {
        dataAccess: { AsyncJob: { create: sandbox.stub().resolves(job) } },
        sqs: { sendMessage: sandbox.stub().rejects(new Error('sqs down')) },
        env: { SERENITY_JOB_RUNNER_QUEUE_URL: 'queue-url' },
        log: { error: sandbox.stub(), warn: sandbox.stub() },
      };

      await expect(createAndEnqueueJob(context, { jobType: 'x' }))
        .to.be.rejectedWith('sqs down');

      expect(job.save).to.have.been.called;
    });
  });

  describe('exchangeAndPersistPromiseToken', () => {
    it('exchanges the token and persists the rolled promise token before returning', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'old-ptok', token_type: 'bearer' } });
      exchangeTokenStub.resolves({
        access_token: 'access-abc',
        promise_token: 'new-ptok',
        promise_token_expires_in: 14399,
      });
      const context = { env: {} };

      const accessToken = await exchangeAndPersistPromiseToken(context, job);

      expect(accessToken).to.equal('access-abc');
      expect(exchangeTokenStub).to.have.been.calledWith('old-ptok', false);
      expect(job.getMetadata().promiseToken).to.deep.equal({
        promise_token: 'new-ptok',
        expires_in: 14399,
        token_type: 'bearer',
      });
      expect(job.save).to.have.been.called;
    });

    it('throws NeedsReauthError when IMS rejects the exchange with 401/403', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'dead-ptok' } });
      exchangeTokenStub.rejects(new Error('IMS exchangeToken request failed with status: 401'));
      const context = { env: {} };

      await expect(exchangeAndPersistPromiseToken(context, job))
        .to.be.rejectedWith(NeedsReauthError);
      expect(job.save).to.not.have.been.called;
    });

    it('rethrows non-reauth errors as-is', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'ptok' } });
      exchangeTokenStub.rejects(new Error('network error'));
      const context = { env: {} };

      await expect(exchangeAndPersistPromiseToken(context, job))
        .to.be.rejectedWith('network error');
    });

    it('exchanges on the pair stored in job metadata and keeps it on the record', async () => {
      const job = makeJob({
        promiseToken: { promise_token: 'old-ptok', token_type: 'bearer' },
        promisePair: 'SEMRUSH',
      });
      exchangeTokenStub.resolves({
        access_token: 'access-abc',
        promise_token: 'new-ptok',
        promise_token_expires_in: 14399,
      });

      await exchangeAndPersistPromiseToken({ env: {} }, job);

      const [, type, opts] = createFromStub.firstCall.args;
      expect(type).to.equal('consumer');
      expect(opts).to.deep.equal({ pair: 'SEMRUSH' });
      expect(job.getMetadata().promisePair).to.equal('SEMRUSH');
    });

    it('exchanges on the default pair when metadata carries no promisePair', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'old-ptok' } });
      exchangeTokenStub.resolves({
        access_token: 'access-abc',
        promise_token: 'new-ptok',
        promise_token_expires_in: 1,
      });

      await exchangeAndPersistPromiseToken({ env: {} }, job);

      expect(createFromStub.firstCall.args[2]).to.deep.equal({ pair: undefined });
    });
  });

  describe('invalidateJobPromiseToken', () => {
    it('invalidates the current promise token', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'ptok' } });
      const context = { env: {}, log: { warn: sandbox.stub() } };

      await invalidateJobPromiseToken(context, job);

      expect(invalidatePromiseTokenStub).to.have.been.calledWith('ptok', false);
      expect(job.getMetadata().promiseToken).to.be.undefined;
    });

    it('scrubs the promise token from metadata even when the invalidate call itself fails', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'ptok' }, other: 'kept' });
      invalidatePromiseTokenStub.rejects(new Error('ims down'));
      const context = { env: {}, log: { warn: sandbox.stub() } };

      await invalidateJobPromiseToken(context, job);

      expect(job.getMetadata().promiseToken).to.be.undefined;
      expect(job.getMetadata().other).to.equal('kept');
    });

    it('is a no-op when the job has no promise token', async () => {
      const job = makeJob({});
      const context = { env: {}, log: { warn: sandbox.stub() } };

      await invalidateJobPromiseToken(context, job);

      expect(invalidatePromiseTokenStub).to.not.have.been.called;
    });

    it('logs and swallows invalidation failures', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'ptok' } });
      invalidatePromiseTokenStub.rejects(new Error('ims down'));
      const warnStub = sandbox.stub();
      const context = { env: {}, log: { warn: warnStub } };

      await expect(invalidateJobPromiseToken(context, job)).to.be.fulfilled;
      expect(warnStub).to.have.been.called;
    });

    it('invalidates on the pair stored in job metadata', async () => {
      const job = makeJob({ promiseToken: { promise_token: 'ptok' }, promisePair: 'SEMRUSH' });
      const context = { env: {}, log: { warn: sandbox.stub() } };

      await invalidateJobPromiseToken(context, job);

      const [, type, opts] = createFromStub.firstCall.args;
      expect(type).to.equal('consumer');
      expect(opts).to.deep.equal({ pair: 'SEMRUSH' });
    });
  });
});
