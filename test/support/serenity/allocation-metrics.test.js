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

  it('recordRejection dimensions by the quota-exceeded reason', () => {
    metrics.recordRejection('quotaExceeded');
    expect(emitMetricStub.firstCall.args[0]).to.deep.equal({
      name: 'AllocationRejection', dimensions: { Reason: 'quotaExceeded' },
    });
  });

  it('recordMeteredQuotaClassifier dimensions by match/no-match', () => {
    metrics.recordMeteredQuotaClassifier(true);
    metrics.recordMeteredQuotaClassifier(false);
    expect(emitMetricStub.firstCall.args[0].dimensions).to.deep.equal({ Matched: true });
    expect(emitMetricStub.secondCall.args[0].dimensions).to.deep.equal({ Matched: false });
  });

  it('always passes the Mysticat/SerenityAllocation namespace and a resolved environment', () => {
    metrics.recordRejection('quotaExceeded');
    const opts = emitMetricStub.firstCall.args[1];
    expect(opts.namespace).to.equal('Mysticat/SerenityAllocation');
    expect(opts.environment).to.be.a('string');
  });
});
