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

    ({ createAtomicStrategy } = await esmock(
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
      { opportunityId: baseArgs.opportunityId, status: 'in_progress', assignee: 'user@example.com' },
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

  it('logs [atomic-strategy-create-failed] and returns success:false after 3 attempts fail', async () => {
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    const boom = new Error('persistent S3 failure');
    writeStrategyStub.rejects(boom);

    const result = await createAtomicStrategy(baseArgs);

    expect(result).to.deep.include({ success: false, attempts: 3 });
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

  it('uses defaultSleep when no sleep override is provided (smoke check)', async () => {
    // Re-mount without overriding sleep; assert that the loop still resolves.
    readStrategyStub.resolves({
      exists: true,
      data: { opportunities: [], strategies: [] },
      version: 1,
    });
    writeStrategyStub.resolves({ version: 2 });

    const { sleep: _, ...argsNoSleep } = baseArgs;
    const result = await createAtomicStrategy(argsNoSleep);
    expect(result.success).to.be.true;
    expect(result.attempts).to.equal(1); // no backoff path triggered on attempt 1
  });
});
