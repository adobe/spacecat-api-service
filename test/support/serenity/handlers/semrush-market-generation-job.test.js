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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

import {
  reservationJobId,
  boundCatalogueSeeds,
  DEFAULT_TOPIC_CAP,
} from '../../../../src/support/serenity/handlers/semrush-market-generation-job.js';
import { isRetryableJobError } from '../../../../src/support/serenity/async-job-runner.js';

use(chaiAsPromised);
use(sinonChai);

function makeJob(metadata = {}) {
  let meta = { ...metadata };
  let status = 'IN_PROGRESS';
  return {
    getId: () => 'job-1',
    getMetadata: () => meta,
    setMetadata: (m) => { meta = m; },
    getStatus: () => status,
    setStatus: (s) => { status = s; },
    save: sinon.stub().resolves(),
    remove: sinon.stub().resolves(),
  };
}

describe('semrush-market-generation-job — pure helpers', () => {
  it('reservationJobId is deterministic per slice and a valid v4-shaped UUID', () => {
    const a = reservationJobId('brand-1', 2840, 'en');
    const b = reservationJobId('brand-1', 2840, 'en');
    const c = reservationJobId('brand-1', 2840, 'fr');
    expect(a).to.equal(b);
    expect(a).to.not.equal(c);
    expect(a).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('boundCatalogueSeeds ranks by volume, caps topics + examples, drops empties', () => {
    const raw = {
      items: [
        { topic: 'low', volume: 1, prompts: ['a', 'b'] },
        { topic: 'high', volume: 100, prompts: ['x', '', 'y', 'z'] },
        { topic: '', volume: 999, prompts: ['ignored'] },
      ],
    };
    const seeds = boundCatalogueSeeds(raw, { topicCap: 1, exampleCap: 2 });
    expect(seeds).to.have.length(1);
    expect(seeds[0].topic).to.equal('high');
    expect(seeds[0].examplePrompts).to.deep.equal(['x', 'y']);
  });

  it('boundCatalogueSeeds tolerates a bare array and keeps all when cap is 0', () => {
    const seeds = boundCatalogueSeeds([{ topic: 't', volume: 5, prompts: [] }], { topicCap: 0 });
    expect(seeds).to.have.length(1);
    expect(DEFAULT_TOPIC_CAP).to.be.a('number');
  });
});

describe('semrush-market-generation-job — producer', () => {
  let sandbox;
  let createAndEnqueueJobStub;
  let isMarketConsumerReadyStub;
  let enqueueSemrushMarketGeneration;
  let PROMISE_PAIR_SEMRUSH;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    createAndEnqueueJobStub = sandbox.stub().resolves(makeJob());
    isMarketConsumerReadyStub = sandbox.stub().resolves(true);
    ({ PROMISE_PAIR_SEMRUSH } = await import('../../../../src/support/serenity/async-job-runner.js'));

    ({ enqueueSemrushMarketGeneration } = await esmock(
      '../../../../src/support/serenity/handlers/semrush-market-generation-job.js',
      {
        '../../../../src/support/serenity/async-job-runner.js': {
          createAndEnqueueJob: createAndEnqueueJobStub,
          PROMISE_PAIR_SEMRUSH,
        },
        '../../../../src/support/serenity/market-worker-readiness.js': {
          isMarketConsumerReady: isMarketConsumerReadyStub,
        },
      },
    ));
  });

  afterEach(() => sandbox.restore());

  function baseParams(overrides = {}) {
    return {
      transport: { getBrandTopics: sandbox.stub().resolves([{ topic: 't', volume: 3, prompts: ['ex'] }]) },
      brandId: 'brand-1',
      siteId: 'site-1',
      imsOrgId: 'org-1',
      workspaceId: 'ws-1',
      geoTargetId: 2840,
      languageCode: 'en',
      market: 'US',
      brandDomain: 'acme.com',
      baseUrl: 'https://acme.com',
      brand: 'Acme',
      aliases: ['Acme Inc'],
      count: 5,
      callerId: 'user-1',
      ...overrides,
    };
  }

  function context(existing = null) {
    return {
      dataAccess: { AsyncJob: { findById: sandbox.stub().resolves(existing) } },
      env: { SERENITY_MARKET_JOBS_QUEUE_URL: 'market-queue-url' },
      log: { info: sandbox.stub(), warn: sandbox.stub() },
    };
  }

  it('does NOT enqueue when the consumer readiness gate is closed (fail-closed)', async () => {
    isMarketConsumerReadyStub.resolves(false);
    const result = await enqueueSemrushMarketGeneration(context(), baseParams());
    expect(result).to.deep.equal({ enqueued: false, reason: 'consumer-not-ready' });
    expect(createAndEnqueueJobStub).to.not.have.been.called;
  });

  it('is a clean no-op when the catalogue yields no seeds', async () => {
    const params = baseParams({ transport: { getBrandTopics: sandbox.stub().resolves([]) } });
    const result = await enqueueSemrushMarketGeneration(context(), params);
    expect(result).to.deep.equal({ enqueued: false, reason: 'no-seeds' });
    expect(createAndEnqueueJobStub).to.not.have.been.called;
  });

  it('reuses a live (IN_PROGRESS) reservation rather than enqueuing again', async () => {
    const live = makeJob();
    const result = await enqueueSemrushMarketGeneration(context(live), baseParams());
    expect(result.reused).to.equal(true);
    expect(result.jobId).to.equal(reservationJobId('brand-1', 2840, 'en'));
    expect(createAndEnqueueJobStub).to.not.have.been.called;
  });

  it('clears a stale terminal reservation and enqueues fresh', async () => {
    const stale = makeJob();
    stale.setStatus('FAILED');
    const result = await enqueueSemrushMarketGeneration(context(stale), baseParams());
    expect(stale.remove).to.have.been.calledOnce;
    expect(createAndEnqueueJobStub).to.have.been.calledOnce;
    expect(result.enqueued).to.equal(true);
  });

  it('enqueues bound to the Semrush pair, with seeds and NO token in metadata', async () => {
    await enqueueSemrushMarketGeneration(context(), baseParams());

    const [, opts] = createAndEnqueueJobStub.firstCall.args;
    expect(opts.jobType).to.equal('serenity-generate-semrush-market');
    expect(opts.jobId).to.equal(reservationJobId('brand-1', 2840, 'en'));
    expect(opts.requirePair).to.equal(PROMISE_PAIR_SEMRUSH);
    expect(opts.promisePair).to.equal(PROMISE_PAIR_SEMRUSH);
    // Enqueued onto the DEDICATED market queue, not the shared runner queue.
    expect(opts.queueUrl).to.equal('market-queue-url');
    expect(opts.metadata.seeds).to.have.length(1);
    expect(opts.metadata.siteId).to.equal('site-1');
    const serialized = JSON.stringify(opts.metadata).toLowerCase();
    expect(serialized).to.not.contain('promise_token');
    expect(serialized).to.not.contain('access_token');
  });
});

describe('semrush-market-generation-job — worker handler', () => {
  let sandbox;
  let exchangeStub;
  let provisionStub;
  let ensureServerOwnedValueStub;
  let resolveProjectStub;
  let publishAffectedStub;
  let semrushMarketGenerationHandler;
  let fakeTransport;
  let invokeDrsStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    exchangeStub = sandbox.stub().resolves('write-access-token');
    provisionStub = sandbox.stub().resolves({ values: new Map() });
    ensureServerOwnedValueStub = sandbox.stub();
    ensureServerOwnedValueStub.withArgs(sinon.match.any, sinon.match.any, sinon.match.any, 'source').resolves({ id: 'source-id' });
    ensureServerOwnedValueStub.withArgs(sinon.match.any, sinon.match.any, sinon.match.any, 'origin').resolves({ id: 'origin-id' });
    resolveProjectStub = sandbox.stub().resolves({ id: 'project-9' });
    publishAffectedStub = sandbox.stub().resolves([]);
    fakeTransport = { createPromptsWithMetadata: sandbox.stub().resolves() };
    invokeDrsStub = sandbox.stub().resolves({
      prompts: [{ prompt: 'p1' }, { prompt: 'p2' }, { prompt: 'p1' }],
      shipSummary: { verdict: 'ship' },
    });

    ({ semrushMarketGenerationHandler } = await esmock(
      '../../../../src/support/serenity/handlers/semrush-market-generation-job.js',
      {
        '../../../../src/support/serenity/async-job-runner.js': {
          exchangeAndPersistPromiseToken: exchangeStub,
        },
        '../../../../src/support/serenity/tag-tree.js': {
          provisionDimensionTree: provisionStub,
          ensureServerOwnedValue: ensureServerOwnedValueStub,
        },
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
        '../../../../src/support/serenity/handlers/prompts.js': {
          publishAffected: publishAffectedStub,
          buildCreateMetadata: () => ({ created_by: 'user-1' }),
        },
      },
    ));
  });

  afterEach(() => sandbox.restore());

  function baseMeta(overrides = {}) {
    return {
      jobType: 'serenity-generate-semrush-market',
      workspaceId: 'ws-1',
      geoTargetId: 2840,
      languageCode: 'en',
      market: 'US',
      brand: 'Acme',
      baseUrl: 'https://acme.com',
      seeds: [{ topic: 't', volume: 1, examplePrompts: [] }],
      siteId: 'site-1',
      imsOrgId: 'org-1',
      callerId: 'user-1',
      promiseToken: { promise_token: 'ptok' },
      ...overrides,
    };
  }

  const deps = () => ({ invokeDrs: invokeDrsStub, buildTransport: () => fakeTransport });
  const runCtx = () => ({ env: {}, log: { info: sandbox.stub() } });

  it('invokes DRS, persists the batch BEFORE the write, exchanges the token AFTER DRS, writes + publishes', async () => {
    const job = makeJob(baseMeta());

    const result = await semrushMarketGenerationHandler(runCtx(), job, null, deps());

    // Generation happened before token exchange (token exchanged after DRS).
    sinon.assert.callOrder(invokeDrsStub, exchangeStub);
    // Batch checkpointed onto the job before writes.
    expect(job.getMetadata().generatedBatch.prompts).to.have.length(3);
    // De-duped write: p1 appears twice in the batch, once in the write.
    const [, , items, tagIds] = fakeTransport.createPromptsWithMetadata.firstCall.args;
    expect(items.map((i) => i.name)).to.deep.equal(['p1', 'p2']);
    // Server-owned source=semrush + origin=ai tags only.
    expect(tagIds).to.deep.equal(['source-id', 'origin-id']);
    expect(publishAffectedStub).to.have.been.calledOnceWith(fakeTransport, 'ws-1', ['project-9']);
    expect(result.published).to.equal(true);
    expect(result.promptCount).to.equal(3);
  });

  it('does NOT re-invoke DRS on resume (batch already persisted)', async () => {
    const job = makeJob(baseMeta({ generatedBatch: { prompts: [{ prompt: 'kept' }] } }));

    await semrushMarketGenerationHandler(runCtx(), job, null, deps());

    expect(invokeDrsStub).to.not.have.been.called;
    const [, , items] = fakeTransport.createPromptsWithMetadata.firstCall.args;
    expect(items.map((i) => i.name)).to.deep.equal(['kept']);
  });

  it('does NOT re-write prompts when the write phase is already checkpointed (publish retry)', async () => {
    const job = makeJob(baseMeta({
      generatedBatch: { prompts: [{ prompt: 'p1' }] }, promptsWritten: true, projectId: 'project-9',
    }));

    await semrushMarketGenerationHandler(runCtx(), job, null, deps());

    expect(fakeTransport.createPromptsWithMetadata).to.not.have.been.called;
    expect(resolveProjectStub).to.not.have.been.called;
    expect(publishAffectedStub).to.have.been.calledOnceWith(fakeTransport, 'ws-1', ['project-9']);
  });

  it('throws TERMINAL and never publishes when DRS ships zero prompts', async () => {
    invokeDrsStub.resolves({ prompts: [], shipSummary: { verdict: 'ship' } });
    const job = makeJob(baseMeta());

    await expect(semrushMarketGenerationHandler(runCtx(), job, null, deps()))
      .to.be.rejectedWith(/zero prompts/);
    expect(publishAffectedStub).to.not.have.been.called;
  });

  it('is retryable when the project cannot be resolved yet', async () => {
    resolveProjectStub.resolves(null);
    const job = makeJob(baseMeta());

    const err = await semrushMarketGenerationHandler(runCtx(), job, null, deps())
      .catch((e) => e);
    expect(isRetryableJobError(err)).to.equal(true);
    expect(publishAffectedStub).to.not.have.been.called;
  });

  it('is retryable when publish fails', async () => {
    publishAffectedStub.resolves([{ message: 'upstream 503' }]);
    const job = makeJob(baseMeta());

    const err = await semrushMarketGenerationHandler(runCtx(), job, null, deps())
      .catch((e) => e);
    expect(isRetryableJobError(err)).to.equal(true);
  });
});
