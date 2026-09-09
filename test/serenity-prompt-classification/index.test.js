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
import { SerenityTransportError } from '../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

function makeJob(initialStatus = 'IN_PROGRESS', jobType = 'serenity-classify-prompts') {
  let status = initialStatus;
  let error;
  let result;
  let metadata = { jobType, promiseToken: { promise_token: 'ptok' } };
  return {
    getId: () => 'job-123',
    getMetadata: () => metadata,
    setMetadata: (m) => { metadata = m; },
    setStatus: (s) => { status = s; },
    getStatus: () => status,
    setError: (e) => { error = e; },
    getError: () => error,
    setResult: (r) => { result = r; },
    getResult: () => result,
    save: sinon.stub().resolves(),
  };
}

describe('serenity-prompt-classification worker entry', () => {
  let sandbox;
  let exchangeAndPersistStub;
  let invalidateStub;
  let isRetryableJobError;
  let NeedsReauthError;
  let retryableJobError;
  let run;

  let classifyPromptsHandlerStub;
  let bulkTagsHandlerStub;
  let semrushMarketGenerationHandlerStub;
  let claimJobLeaseStub;
  let clearJobLeaseStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    exchangeAndPersistStub = sandbox.stub();
    invalidateStub = sandbox.stub().resolves();
    classifyPromptsHandlerStub = sandbox.stub().resolves({ created: [] });
    bulkTagsHandlerStub = sandbox.stub().resolves({ outcome: 'SUCCEEDED' });
    semrushMarketGenerationHandlerStub = sandbox.stub()
      .resolves({ promptCount: 3, published: true });
    claimJobLeaseStub = sandbox.stub().resolves(true);
    clearJobLeaseStub = sandbox.stub();

    ({
      NeedsReauthError,
      isRetryableJobError,
      retryableJobError,
    } = await import('../../src/support/serenity/async-job-runner.js'));

    ({ run } = await esmock('../../src/serenity-prompt-classification/index.js', {
      '../../src/support/serenity/async-job-runner.js': {
        exchangeAndPersistPromiseToken: exchangeAndPersistStub,
        invalidateJobPromiseToken: invalidateStub,
        isRetryableJobError,
        NeedsReauthError,
      },
      '../../src/support/serenity/job-lease.js': {
        claimJobLease: claimJobLeaseStub,
        clearJobLease: clearJobLeaseStub,
        newLeaseToken: () => 'lease-token-abc',
      },
      '../../src/support/serenity/handlers/classify-prompts-job.js': {
        classifyPromptsHandler: classifyPromptsHandlerStub,
        CLASSIFY_PROMPTS_JOB_TYPE: 'serenity-classify-prompts',
      },
      '../../src/support/serenity/handlers/bulk-tags-job.js': {
        bulkTagsHandler: bulkTagsHandlerStub,
        BULK_TAGS_JOB_TYPE: 'serenity-bulk-tags',
      },
      '../../src/support/serenity/handlers/semrush-market-generation-job.js': {
        semrushMarketGenerationHandler: semrushMarketGenerationHandlerStub,
        SEMRUSH_MARKET_GENERATION_JOB_TYPE: 'serenity-generate-semrush-market',
      },
    }));
  });

  afterEach(() => sandbox.restore());

  function makeContext(job) {
    return {
      log: {
        info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(),
      },
      dataAccess: { AsyncJob: { findById: sandbox.stub().resolves(job) } },
    };
  }

  it('drops the message when the job cannot be found', async () => {
    const context = makeContext(null);

    await run({ jobId: 'missing' }, context);

    expect(exchangeAndPersistStub).to.not.have.been.called;
  });

  it('marks the job FAILED with NEEDS_REAUTH and does not dispatch when the exchange needs reauth', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.rejects(new NeedsReauthError('dead token'));

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(job.getStatus()).to.equal('FAILED');
    expect(job.getError().code).to.equal('NEEDS_REAUTH');
    expect(invalidateStub).to.not.have.been.called;
    expect(job.save).to.have.been.called;
  });

  it('rethrows non-reauth exchange errors', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.rejects(new Error('network blip'));

    await expect(run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context))
      .to.be.rejectedWith('network blip');
  });

  it('marks the job FAILED with UNKNOWN_JOB_TYPE and invalidates the token for an unregistered type', async () => {
    // The STORED jobType (not the message type) drives dispatch.
    const job = makeJob('IN_PROGRESS', 'not-a-real-type');
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');

    await run({ jobId: 'job-123', type: 'not-a-real-type' }, context);

    expect(job.getStatus()).to.equal('FAILED');
    expect(job.getError().code).to.equal('UNKNOWN_JOB_TYPE');
    expect(invalidateStub).to.have.been.called;
    expect(job.save).to.have.been.called;
  });

  it('dispatches on the STORED jobType and drops a message whose type contradicts it', async () => {
    // Stored jobType is classify; a spoofed/poisoned message claims bulk-tags.
    const job = makeJob('IN_PROGRESS', 'serenity-classify-prompts');
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');

    await run({ jobId: 'job-123', type: 'serenity-bulk-tags' }, context);

    // The mismatched message is dropped; neither handler runs, the job is untouched.
    expect(classifyPromptsHandlerStub).to.not.have.been.called;
    expect(bulkTagsHandlerStub).to.not.have.been.called;
    expect(exchangeAndPersistStub).to.not.have.been.called;
    expect(job.getStatus()).to.equal('IN_PROGRESS');
  });

  it('dispatches serenity-classify-prompts to classifyPromptsHandler (serenity-docs#33)', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(classifyPromptsHandlerStub).to.have.been.calledOnceWith(context, job, 'access-token');
    expect(job.getStatus()).to.equal('COMPLETED');
    expect(job.getResult()).to.deep.equal({ created: [] });
    expect(invalidateStub).to.have.been.called;
  });

  it('does not invalidate the promise token when the handler self-requeued (token ownership transferred)', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');
    classifyPromptsHandlerStub.resolves({ created: [], requeuedJobId: 'job-followup' });

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(job.getStatus()).to.equal('COMPLETED');
    expect(invalidateStub).to.not.have.been.called;
    expect(job.save).to.have.been.called;
  });

  it('leaves a bulk job IN_PROGRESS and rethrows when the handler requests SQS retry', async () => {
    const job = makeJob('IN_PROGRESS', 'serenity-bulk-tags');
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');
    bulkTagsHandlerStub.rejects(retryableJobError('retry publish'));

    await expect(run({ jobId: 'job-123', type: 'serenity-bulk-tags' }, context))
      .to.be.rejectedWith('retry publish');

    expect(bulkTagsHandlerStub).to.have.been.calledOnceWith(context, job, 'access-token');
    expect(job.getStatus()).to.equal('IN_PROGRESS');
    expect(job.getResult()).to.equal(undefined);
    expect(invalidateStub).not.to.have.been.called;
  });

  it('marks unknown application errors non-retryable', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');
    classifyPromptsHandlerStub.rejects(new Error('classification blew up'));

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(job.getStatus()).to.equal('FAILED');
    expect(job.getError()).to.deep.equal({
      code: 'JOB_FAILED', message: 'classification blew up', retryable: false,
    });
    expect(invalidateStub).to.have.been.called;
    expect(job.save).to.have.been.called;
  });

  it('marks plain TypeError and RangeError application bugs non-retryable', async () => {
    exchangeAndPersistStub.resolves('access-token');
    classifyPromptsHandlerStub.onFirstCall().rejects(new TypeError('bad property access'));
    classifyPromptsHandlerStub.onSecondCall().rejects(new RangeError('bad range'));
    const typeJob = makeJob();
    const rangeJob = makeJob();

    await run(
      { jobId: 'job-123', type: 'serenity-classify-prompts' },
      makeContext(typeJob),
    );
    await run(
      { jobId: 'job-123', type: 'serenity-classify-prompts' },
      makeContext(rangeJob),
    );

    expect(typeJob.getError().retryable).to.equal(false);
    expect(rangeJob.getError().retryable).to.equal(false);
  });

  it('marks a known network failure retryable', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');
    classifyPromptsHandlerStub.rejects(
      Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    );

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(job.getError()).to.deep.equal({
      code: 'ECONNRESET', message: 'socket reset', retryable: true,
    });
  });

  it('marks typed upstream 5xx retryable and 4xx non-retryable', async () => {
    exchangeAndPersistStub.resolves('access-token');
    classifyPromptsHandlerStub.onFirstCall()
      .rejects(new SerenityTransportError(503, 'upstream unavailable'));
    classifyPromptsHandlerStub.onSecondCall()
      .rejects(new SerenityTransportError(400, 'bad upstream request'));
    const serverJob = makeJob();
    const clientJob = makeJob();

    await run(
      { jobId: 'job-123', type: 'serenity-classify-prompts' },
      makeContext(serverJob),
    );
    await run(
      { jobId: 'job-123', type: 'serenity-classify-prompts' },
      makeContext(clientJob),
    );

    expect(serverJob.getError().retryable).to.equal(true);
    expect(clientJob.getError().retryable).to.equal(false);
  });

  it('marks a wrapped upstream timeout retryable', async () => {
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');
    classifyPromptsHandlerStub.rejects(new ProjectEngineApiError(
      undefined,
      'GET',
      null,
      { cause: new SerenityTransportError(504, 'request timed out') },
    ));

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(job.getError().retryable).to.equal(true);
  });

  it('drops a duplicate delivery for a job already in a terminal state, without re-exchanging the token', async () => {
    const job = makeJob('COMPLETED');
    const context = makeContext(job);

    await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

    expect(exchangeAndPersistStub).to.not.have.been.called;
    expect(classifyPromptsHandlerStub).to.not.have.been.called;
    expect(job.getStatus()).to.equal('COMPLETED');
  });

  describe('Semrush-market generation (lease-required, deferred-exchange)', () => {
    it('claims the lease and dispatches WITHOUT exchanging the token up front (handler exchanges after DRS)', async () => {
      const job = makeJob('IN_PROGRESS', 'serenity-generate-semrush-market');
      const context = makeContext(job);

      await run({ jobId: 'job-123', type: 'serenity-generate-semrush-market' }, context);

      expect(claimJobLeaseStub).to.have.been.calledOnce;
      // Deferred exchange: the runner does NOT exchange; the handler gets a null token.
      expect(exchangeAndPersistStub).to.not.have.been.called;
      expect(semrushMarketGenerationHandlerStub).to.have.been.calledOnceWith(context, job, null);
      expect(job.getStatus()).to.equal('COMPLETED');
      expect(invalidateStub).to.have.been.called;
      expect(clearJobLeaseStub).to.have.been.called;
    });

    it('drops the duplicate delivery when the lease is held by another delivery (one set of writes)', async () => {
      claimJobLeaseStub.resolves(false);
      const job = makeJob('IN_PROGRESS', 'serenity-generate-semrush-market');
      const context = makeContext(job);

      await run({ jobId: 'job-123', type: 'serenity-generate-semrush-market' }, context);

      expect(semrushMarketGenerationHandlerStub).to.not.have.been.called;
      expect(exchangeAndPersistStub).to.not.have.been.called;
      expect(job.getStatus()).to.equal('IN_PROGRESS');
    });

    it('fails closed (rethrows for redelivery) when the lease claim query errors', async () => {
      claimJobLeaseStub.rejects(new Error('postgrest down'));
      const job = makeJob('IN_PROGRESS', 'serenity-generate-semrush-market');
      const context = makeContext(job);

      await expect(run({ jobId: 'job-123', type: 'serenity-generate-semrush-market' }, context))
        .to.be.rejectedWith('postgrest down');
      expect(semrushMarketGenerationHandlerStub).to.not.have.been.called;
    });

    it('releases the lease and rethrows on a retryable handler failure (redelivery re-claims)', async () => {
      semrushMarketGenerationHandlerStub.rejects(retryableJobError('DRS throttled'));
      const job = makeJob('IN_PROGRESS', 'serenity-generate-semrush-market');
      const context = makeContext(job);

      await expect(run({ jobId: 'job-123', type: 'serenity-generate-semrush-market' }, context))
        .to.be.rejectedWith('DRS throttled');
      expect(clearJobLeaseStub).to.have.been.called;
      expect(job.getStatus()).to.equal('IN_PROGRESS');
      expect(invalidateStub).to.not.have.been.called;
    });

    it('does not claim a lease for the classify job type (unchanged path)', async () => {
      const job = makeJob('IN_PROGRESS', 'serenity-classify-prompts');
      const context = makeContext(job);
      exchangeAndPersistStub.resolves('access-token');

      await run({ jobId: 'job-123', type: 'serenity-classify-prompts' }, context);

      expect(claimJobLeaseStub).to.not.have.been.called;
      expect(exchangeAndPersistStub).to.have.been.called;
    });
  });
});

describe('serenity-prompt-classification vault config', () => {
  let vaultOpts;

  before(async () => {
    ({ vaultOpts } = await import('../../src/serenity-prompt-classification/index.js'));
  });

  it('reuses api-service\'s Secrets Manager bootstrap secret (no dedicated worker bootstrap)', () => {
    expect(vaultOpts.bootstrapPath).to.equal('/mysticat/bootstrap/api-service');
  });

  it('reads api-service\'s env-scoped Vault path, resolving env from AWS_ENV', () => {
    expect(vaultOpts.name({ env: { AWS_ENV: 'prod' } })).to.equal('prod/api-service');
    expect(vaultOpts.name({ env: { AWS_ENV: 'stage' } })).to.equal('stage/api-service');
    expect(vaultOpts.name({ env: { AWS_ENV: 'dev' } })).to.equal('dev/api-service');
  });

  it('throws an actionable error when AWS_ENV is unset (no silent default, no generic ENV fallback)', () => {
    expect(() => vaultOpts.name({ env: { ENV: 'stage' } })).to.throw('AWS_ENV must be set');
    expect(() => vaultOpts.name({ env: {} })).to.throw('AWS_ENV must be set');
    expect(() => vaultOpts.name({})).to.throw('AWS_ENV must be set');
  });
});
