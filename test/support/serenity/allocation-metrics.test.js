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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('serenity allocation-metrics', () => {
  let sandbox;
  let emitMetricStub;
  let metrics;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    emitMetricStub = sandbox.stub();
    metrics = await esmock('../../../src/support/serenity/allocation-metrics.js', {
      '../../../src/support/metrics-emf.js': {
        emitMetric: emitMetricStub,
        resolveEnvironment: (env) => env?.AWS_ENV || env?.ENV || 'dev',
      },
    });
  });

  afterEach(() => sandbox.restore());

  it('recordHeadroomCheck dimensions by hot-path vs topped-up', () => {
    metrics.recordHeadroomCheck(false);
    metrics.recordHeadroomCheck(true);
    expect(emitMetricStub).to.have.been.calledTwice;
    expect(emitMetricStub.firstCall.args[0]).to.deep.include({ name: 'HeadroomCheck' });
    expect(emitMetricStub.firstCall.args[0].dimensions).to.deep.equal({ Outcome: 'hot-path' });
    expect(emitMetricStub.secondCall.args[0].dimensions).to.deep.equal({ Outcome: 'topped-up' });
  });

  it('recordTopUpLatency emits a Milliseconds metric dimensioned by Path (settle vs fail-fast)', () => {
    metrics.recordTopUpLatency(42, 'settle');
    metrics.recordTopUpLatency(7, 'fail-fast');
    expect(emitMetricStub).to.have.been.calledTwice;
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({
      name: 'TopUpLatencyMs', value: 42, unit: 'Milliseconds', dimensions: { Path: 'settle' },
    });
    expect(emitMetricStub.secondCall.args[0]).to.deep.equal({
      name: 'TopUpLatencyMs', value: 7, unit: 'Milliseconds', dimensions: { Path: 'fail-fast' },
    });
  });

  it('recordPoolFreeRatio emits a Percent metric dimensioned by dim', () => {
    metrics.recordPoolFreeRatio('projects', 25, 100);
    expect(emitMetricStub).to.have.been.calledOnce;
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({
      name: 'PoolFreeRatio', value: 25, unit: 'Percent', dimensions: { Dim: 'projects' },
    });
  });

  it('recordPoolFreeRatio is a no-op for an unset (0-total) pool — avoids a meaningless ratio', () => {
    metrics.recordPoolFreeRatio('projects', 0, 0);
    expect(emitMetricStub).to.not.have.been.called;
  });

  it('recordRejection dimensions by the typed rejection reason', () => {
    metrics.recordRejection('orgPoolExhausted');
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({
      name: 'AllocationRejection', dimensions: { Reason: 'orgPoolExhausted' },
    });
  });

  it('recordNotReadyRetry emits a bare counter', () => {
    metrics.recordNotReadyRetry();
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({ name: 'NotReadyRetry' });
  });

  it('recordReleaseOutcome dimensions by outcome reason', () => {
    metrics.recordReleaseOutcome('requires-decommission');
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({
      name: 'ReleaseOutcome', dimensions: { Reason: 'requires-decommission' },
    });
  });

  it('recordReleaseOutcome accepts dry-run as a reason (sweep preview visibility)', () => {
    metrics.recordReleaseOutcome('dry-run');
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({
      name: 'ReleaseOutcome', dimensions: { Reason: 'dry-run' },
    });
  });

  it('recordMeteredQuotaClassifier dimensions by match/no-match', () => {
    metrics.recordMeteredQuotaClassifier(true);
    metrics.recordMeteredQuotaClassifier(false);
    expect(emitMetricStub.firstCall.args[0].dimensions).to.deep.equal({ Matched: true });
    expect(emitMetricStub.secondCall.args[0].dimensions).to.deep.equal({ Matched: false });
  });

  it('always passes the Mysticat/SerenityAllocation namespace and a resolved environment', () => {
    metrics.recordNotReadyRetry();
    const opts = emitMetricStub.firstCall.args[1];
    expect(opts.namespace).to.equal('Mysticat/SerenityAllocation');
    expect(opts.environment).to.be.a('string');
  });
});
