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

function makeJob() {
  let status;
  let error;
  let result;
  return {
    getId: () => 'job-123',
    getMetadata: () => ({ promiseToken: { promise_token: 'ptok' } }),
    setMetadata: sinon.stub(),
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
  let NeedsReauthError;
  let run;

  let classifyPromptsHandlerStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    exchangeAndPersistStub = sandbox.stub();
    invalidateStub = sandbox.stub().resolves();
    classifyPromptsHandlerStub = sandbox.stub().resolves({ created: [] });

    ({ NeedsReauthError } = await import('../../src/support/serenity/async-job-runner.js'));

    ({ run } = await esmock('../../src/serenity-prompt-classification/index.js', {
      '../../src/support/serenity/async-job-runner.js': {
        exchangeAndPersistPromiseToken: exchangeAndPersistStub,
        invalidateJobPromiseToken: invalidateStub,
        NeedsReauthError,
      },
      '../../src/support/serenity/handlers/classify-prompts-job.js': {
        classifyPromptsHandler: classifyPromptsHandlerStub,
        CLASSIFY_PROMPTS_JOB_TYPE: 'serenity-classify-prompts',
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
    const job = makeJob();
    const context = makeContext(job);
    exchangeAndPersistStub.resolves('access-token');

    await run({ jobId: 'job-123', type: 'not-a-real-type' }, context);

    expect(job.getStatus()).to.equal('FAILED');
    expect(job.getError().code).to.equal('UNKNOWN_JOB_TYPE');
    expect(invalidateStub).to.have.been.called;
    expect(job.save).to.have.been.called;
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
});
