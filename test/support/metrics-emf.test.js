/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';
import { emitMetric, resolveEnvironment } from '../../src/support/metrics-emf.js';

describe('metrics-emf', () => {
  it('resolveEnvironment prefers AWS_ENV, then ENV, then dev', () => {
    expect(resolveEnvironment({ AWS_ENV: 'prod' })).to.equal('prod');
    expect(resolveEnvironment({ ENV: 'stage' })).to.equal('stage');
    expect(resolveEnvironment({})).to.equal('dev');
  });

  it('emits a well-formed EMF envelope to the injected sink', () => {
    const lines = [];
    emitMetric(
      { name: 'WebhookEnqueued', dimensions: { JobType: 'pr-review', TargetId: 'github-public' } },
      { environment: 'dev', sink: (l) => lines.push(l) },
    );
    expect(lines).to.have.length(1);
    const parsed = JSON.parse(lines[0]);
    // eslint-disable-next-line no-underscore-dangle
    const cwm = parsed._aws.CloudWatchMetrics[0];
    expect(cwm.Namespace).to.equal('Mysticat/GitHubService');
    expect(cwm.Metrics[0]).to.deep.equal({ Name: 'WebhookEnqueued', Unit: 'Count' });
    expect(cwm.Dimensions[0]).to.include.members(['Environment', 'JobType', 'TargetId']);
    expect(parsed.Environment).to.equal('dev');
    expect(parsed.JobType).to.equal('pr-review');
    expect(parsed.WebhookEnqueued).to.equal(1);
  });

  it('supports non-Count units and explicit values', () => {
    const lines = [];
    emitMetric(
      {
        name: 'WebhookProcessingMillis', value: 42, unit: 'Milliseconds', dimensions: { Outcome: 'enqueued' },
      },
      { environment: 'dev', sink: (l) => lines.push(l) },
    );
    const parsed = JSON.parse(lines[0]);
    // eslint-disable-next-line no-underscore-dangle
    expect(parsed._aws.CloudWatchMetrics[0].Metrics[0].Unit).to.equal('Milliseconds');
    expect(parsed.WebhookProcessingMillis).to.equal(42);
  });

  it('drops null/undefined dimension values', () => {
    const lines = [];
    emitMetric(
      { name: 'WebhookHandlerError', dimensions: { Nope: undefined } },
      { environment: 'dev', sink: (l) => lines.push(l) },
    );
    const parsed = JSON.parse(lines[0]);
    expect(parsed).to.not.have.property('Nope');
    // The key must also be absent from the Dimensions array, or CloudWatch would
    // reject the line (a dimension key with no matching top-level property). Guards
    // a regression that filters null dims after the dims->Dimensions mapping.
    // eslint-disable-next-line no-underscore-dangle
    expect(parsed._aws.CloudWatchMetrics[0].Dimensions[0]).to.not.include('Nope');
  });

  it('never throws (best-effort) even if the sink throws', () => {
    expect(() => emitMetric(
      { name: 'X' },
      { sink: () => { throw new Error('sink boom'); } },
    )).to.not.throw();
  });
});
