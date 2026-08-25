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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('atomic-strategy-helper', () => {
  let sandbox;
  let createAtomicStrategy;
  let deleteAtomicStrategy;
  let readStrategyStub;
  let writeStrategyStub;
  let log;
  let baseArgs;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    readStrategyStub = sandbox.stub();
    writeStrategyStub = sandbox.stub();
    log = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };

    ({ createAtomicStrategy, deleteAtomicStrategy } = await esmock(
      '../../src/support/atomic-strategy-helper.js',
      {
        '@adobe/spacecat-shared-utils': {
          llmoStrategy: {
            readStrategy: readStrategyStub,
            writeStrategy: writeStrategyStub,
          },
        },
      },
    ));

    baseArgs = {
      siteId: '11111111-1111-1111-1111-111111111111',
      geoExperimentId: '22222222-2222-2222-2222-222222222222',
      opportunityId: '33333333-3333-3333-3333-333333333333',
      opportunityType: 'prerender',
      name: 'Recover Content Visibility — Apr 24, 2026',
      profile: { email: 'user@example.com' },
      s3: { s3Client: {}, s3Bucket: 'test-bucket' },
      log,
      sleep: () => Promise.resolve(),
    };
  });

  afterEach(() => sandbox.restore());

  it('appends an Atomic strategy on the first attempt', async () => {
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    writeStrategyStub.resolves({ version: 2 });

    const result = await createAtomicStrategy(baseArgs);

    expect(result).to.deep.include({
      success: true,
      strategyId: baseArgs.geoExperimentId,
      attempts: 1,
    });
    expect(writeStrategyStub).to.have.been.calledOnce;
    const writtenData = writeStrategyStub.firstCall.args[1];
    expect(writtenData.strategies).to.have.lengthOf(1);
    const newStrat = writtenData.strategies[0];
    expect(newStrat).to.include({
      id: baseArgs.geoExperimentId,
      type: 'atomic',
      experimentId: baseArgs.geoExperimentId,
      status: 'in_progress',
      name: baseArgs.name,
      createdBy: 'user@example.com',
      topic: baseArgs.opportunityType,
    });
    expect(newStrat.selectedPrompts).to.be.undefined;
    expect(newStrat.opportunities).to.deep.equal([
      {
        opportunityId: baseArgs.opportunityId,
        link: `/sites/${baseArgs.siteId}/opportunities/${baseArgs.opportunityId}`,
        status: 'in_progress',
        assignee: 'user@example.com',
      },
    ]);
    expect(newStrat.createdAt).to.match(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('retries and succeeds on attempt 2 after a transient write failure', async () => {
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    writeStrategyStub.onFirstCall().rejects(new Error('S3 throttled'));
    writeStrategyStub.onSecondCall().resolves({ version: 2 });

    const result = await createAtomicStrategy(baseArgs);

    expect(result).to.deep.include({ success: true, attempts: 2 });
    expect(writeStrategyStub).to.have.been.calledTwice;
    expect(log.warn).to.have.been.calledWithMatch(/attempt 1\/3 failed/);
  });

  it('treats already-present strategy id as idempotent success (no second write)', async () => {
    // First attempt's write throws (e.g., timeout) but actually persisted.
    // Second attempt sees the strategy already in the blob.
    writeStrategyStub.onFirstCall().rejects(new Error('socket hang up'));
    readStrategyStub.onFirstCall().resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    readStrategyStub.onSecondCall().resolves({
      exists: true,
      data: {
        opportunities: [],
        strategies: [{
          id: baseArgs.geoExperimentId,
          type: 'atomic',
          experimentId: baseArgs.geoExperimentId,
          name: 'X',
          status: 'in_progress',
          url: '',
          description: '',
          topic: 't',
          createdAt: '2026-01-01T00:00:00Z',
          opportunities: [],
        }],
      },
      version: 2,
    });

    const result = await createAtomicStrategy(baseArgs);

    expect(result).to.deep.include({ success: true, attempts: 2 });
    expect(writeStrategyStub).to.have.been.calledOnce;
    expect(log.info).to.have.been.calledWithMatch(/idempotent skip/);
  });

  it('logs [atomic-strategy-create-failed] and throws after 3 attempts fail', async () => {
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    const boom = new Error('persistent S3 failure');
    writeStrategyStub.rejects(boom);

    let thrown;
    try {
      await createAtomicStrategy(baseArgs);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.an('Error');
    expect(thrown.message).to.include('atomic-strategy create failed after 3 attempts');
    expect(thrown.message).to.include('persistent S3 failure');
    expect(thrown.cause).to.equal(boom);

    expect(log.error).to.have.been.calledOnce;
    const [tag, payload] = log.error.firstCall.args;
    expect(tag).to.equal('[atomic-strategy-create-failed]');
    expect(payload).to.include({
      siteId: baseArgs.siteId,
      geoExperimentId: baseArgs.geoExperimentId,
      strategyId: baseArgs.geoExperimentId,
      opportunityId: baseArgs.opportunityId,
      opportunityType: baseArgs.opportunityType,
      error: 'persistent S3 failure',
    });
    expect(payload.intendedStrategy).to.include({ id: baseArgs.geoExperimentId, type: 'atomic' });
  });

  it('defaults missing opportunities/strategies fields when readStrategy returns partial data', async () => {
    // exists:true with a data object that has no opportunities/strategies keys —
    // exercises the nullish-coalescing fallback inside the helper.
    readStrategyStub.resolves({ exists: true, data: {}, version: 1 });
    writeStrategyStub.resolves({ version: 2 });

    const result = await createAtomicStrategy(baseArgs);

    expect(result.success).to.be.true;
    const writtenData = writeStrategyStub.firstCall.args[1];
    expect(writtenData.opportunities).to.deep.equal([]);
    expect(writtenData.strategies).to.have.lengthOf(1);
  });

  it('initializes the blob when readStrategy reports exists:false', async () => {
    readStrategyStub.resolves({ exists: false, data: null, version: null });
    writeStrategyStub.resolves({ version: 1 });

    const result = await createAtomicStrategy(baseArgs);

    expect(result.success).to.be.true;
    const writtenData = writeStrategyStub.firstCall.args[1];
    expect(writtenData).to.deep.equal({
      opportunities: [],
      strategies: [writtenData.strategies[0]],
    });
    expect(writtenData.strategies[0].id).to.equal(baseArgs.geoExperimentId);
  });

  it('falls back to "edge-deploy" creator when profile.email is missing', async () => {
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    writeStrategyStub.resolves({ version: 2 });

    const result = await createAtomicStrategy({ ...baseArgs, profile: undefined });

    expect(result.success).to.be.true;
    const newStrat = writeStrategyStub.firstCall.args[1].strategies[0];
    expect(newStrat.createdBy).to.equal('edge-deploy');
    expect(newStrat.opportunities[0].assignee).to.equal('edge-deploy');
  });

  it('writes data that round-trips through the F1 strategyWorkspaceData schema', async () => {
    // Lock the contract: what writeStrategy receives must parse cleanly via
    // the F1 schema, otherwise the next reader breaks.
    const { llmoStrategy: realLlmoStrategy } = await import('@adobe/spacecat-shared-utils');
    const realSchema = realLlmoStrategy.strategyWorkspaceData;

    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    writeStrategyStub.resolves({ version: 2 });

    // Use real UUIDs so we pass the schema's strict UUID format check on experimentId.
    const { randomUUID } = await import('node:crypto');
    const realArgs = {
      ...baseArgs,
      siteId: randomUUID(),
      geoExperimentId: randomUUID(),
      opportunityId: randomUUID(),
    };

    await createAtomicStrategy(realArgs);

    const writtenData = writeStrategyStub.firstCall.args[1];
    // Should not throw.
    realSchema.parse(writtenData);
  });

  it('uses defaultSleep when no sleep override is provided and a retry is required', async () => {
    // Force a retry so the BACKOFF_MS[1]=250ms path actually invokes
    // defaultSleep (and through it, setTimeout). Without this we'd never
    // exercise defaultSleep at all — attempt 1 has BACKOFF_MS[0]=0 and
    // therefore skips the sleep call.
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    writeStrategyStub.onFirstCall().rejects(new Error('SlowDown'));
    writeStrategyStub.onSecondCall().resolves({ version: 2 });

    const { sleep: _, ...argsNoSleep } = baseArgs;
    const result = await createAtomicStrategy(argsNoSleep);
    expect(result.success).to.be.true;
    expect(result.attempts).to.equal(2);
  }).timeout(2000);

  describe('deleteAtomicStrategy', () => {
    let deleteArgs;

    beforeEach(() => {
      deleteArgs = {
        siteId: '11111111-1111-1111-1111-111111111111',
        strategyId: '22222222-2222-2222-2222-222222222222',
        s3: { s3Client: {}, s3Bucket: 'test-bucket' },
        log,
        sleep: () => Promise.resolve(),
      };
    });

    it('removes the strategy and writes the filtered blob on the first attempt', async () => {
      readStrategyStub.resolves({
        exists: true,
        data: {
          opportunities: [],
          strategies: [
            { id: deleteArgs.strategyId, type: 'atomic' },
            { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', type: 'evolving' },
          ],
        },
        version: 1,
      });
      writeStrategyStub.resolves({ version: 2 });

      const result = await deleteAtomicStrategy(deleteArgs);

      expect(result).to.deep.include({
        success: true,
        strategyId: deleteArgs.strategyId,
        attempts: 1,
        removed: true,
      });
      expect(writeStrategyStub).to.have.been.calledOnce;
      const writtenData = writeStrategyStub.firstCall.args[1];
      expect(writtenData.strategies).to.have.lengthOf(1);
      expect(writtenData.strategies[0].id).to.equal('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('is idempotent when the blob does not exist (returns success without writing)', async () => {
      readStrategyStub.resolves({ exists: false, data: null, version: null });

      const result = await deleteAtomicStrategy(deleteArgs);

      expect(result).to.deep.include({ success: true, removed: false });
      expect(writeStrategyStub).to.not.have.been.called;
      expect(log.info).to.have.been.calledWithMatch(/idempotent skip: blob does not exist/);
    });

    it('is idempotent when the strategy is already absent (returns success without writing)', async () => {
      readStrategyStub.resolves({
        exists: true,
        data: {
          opportunities: [],
          strategies: [{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', type: 'evolving' }],
        },
        version: 1,
      });

      const result = await deleteAtomicStrategy(deleteArgs);

      expect(result).to.deep.include({ success: true, removed: false });
      expect(writeStrategyStub).to.not.have.been.called;
      expect(log.info).to.have.been.calledWithMatch(/idempotent skip: strategy .* not present/);
    });

    it('retries and succeeds on attempt 2 after a transient write failure', async () => {
      readStrategyStub.resolves({
        exists: true,
        data: {
          opportunities: [],
          strategies: [{ id: deleteArgs.strategyId, type: 'atomic' }],
        },
        version: 1,
      });
      writeStrategyStub.onFirstCall().rejects(new Error('SlowDown'));
      writeStrategyStub.onSecondCall().resolves({ version: 2 });

      const result = await deleteAtomicStrategy(deleteArgs);

      expect(result).to.deep.include({ success: true, removed: true, attempts: 2 });
      expect(writeStrategyStub).to.have.been.calledTwice;
    });

    it('re-reads the blob on each retry (handles concurrent inserts gracefully)', async () => {
      // Attempt 1: strategy present, write rejects. Attempt 2: strategy already gone.
      readStrategyStub.onFirstCall().resolves({
        exists: true,
        data: {
          opportunities: [],
          strategies: [{ id: deleteArgs.strategyId, type: 'atomic' }],
        },
        version: 1,
      });
      readStrategyStub.onSecondCall().resolves({
        exists: true,
        data: { opportunities: [], strategies: [] },
        version: 2,
      });
      writeStrategyStub.onFirstCall().rejects(new Error('SlowDown'));

      const result = await deleteAtomicStrategy(deleteArgs);

      expect(result).to.deep.include({ success: true, removed: false, attempts: 2 });
      expect(writeStrategyStub).to.have.been.calledOnce;
    });

    it('logs [atomic-strategy-delete-failed] and throws after 3 attempts fail', async () => {
      readStrategyStub.resolves({
        exists: true,
        data: {
          opportunities: [],
          strategies: [{ id: deleteArgs.strategyId, type: 'atomic' }],
        },
        version: 1,
      });
      const boom = new Error('persistent S3 failure');
      writeStrategyStub.rejects(boom);

      let thrown;
      try {
        await deleteAtomicStrategy(deleteArgs);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).to.be.an('Error');
      expect(thrown.message).to.include('atomic-strategy delete failed after 3 attempts');
      expect(thrown.message).to.include('persistent S3 failure');
      expect(thrown.cause).to.equal(boom);

      expect(log.error).to.have.been.calledOnce;
      const [tag, payload] = log.error.firstCall.args;
      expect(tag).to.equal('[atomic-strategy-delete-failed]');
      expect(payload).to.include({
        siteId: deleteArgs.siteId,
        strategyId: deleteArgs.strategyId,
        error: 'persistent S3 failure',
      });
    });

    it('defaults missing opportunities/strategies fields when readStrategy returns partial data', async () => {
      // exists:true with no strategies key — exercises the nullish-coalescing fallback.
      readStrategyStub.resolves({ exists: true, data: {}, version: 1 });

      const result = await deleteAtomicStrategy(deleteArgs);

      // Strategy not present (no strategies array) → idempotent skip, no write.
      expect(result).to.deep.include({ success: true, removed: false });
      expect(writeStrategyStub).to.not.have.been.called;
    });

    it('defaults missing opportunities key when writing back filtered strategies', async () => {
      // strategies is present (so we DON'T short-circuit on absence) but
      // opportunities is missing — exercises the `data.opportunities ?? []`
      // fallback inside the nextData construction.
      readStrategyStub.resolves({
        exists: true,
        data: { strategies: [{ id: deleteArgs.strategyId, type: 'atomic' }] },
        version: 1,
      });
      writeStrategyStub.resolves({ version: 2 });

      const result = await deleteAtomicStrategy(deleteArgs);

      expect(result).to.deep.include({ success: true, removed: true });
      const written = writeStrategyStub.firstCall.args[1];
      expect(written.opportunities).to.deep.equal([]);
      expect(written.strategies).to.deep.equal([]);
    });

    it('uses defaultSleep when no sleep override is provided and a retry is required', async () => {
      // Force attempt 1 to fail so attempt 2 actually awaits defaultSleep.
      readStrategyStub.onFirstCall().rejects(new Error('SlowDown'));
      readStrategyStub.onSecondCall().resolves({ exists: false, data: null, version: null });
      const { sleep: _, ...argsNoSleep } = deleteArgs;
      const result = await deleteAtomicStrategy(argsNoSleep);
      expect(result.success).to.be.true;
      expect(result.attempts).to.equal(2);
    }).timeout(2000);
  });
});
