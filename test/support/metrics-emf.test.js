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
import sinon from 'sinon';
import {
  emitMetric,
  resolveEnvironment,
  resetEnvFallbackWarnedForTest,
} from '../../src/support/metrics-emf.js';

describe('metrics-emf', () => {
  it('resolveEnvironment prefers AWS_ENV, then ENV, then dev', () => {
    expect(resolveEnvironment({ AWS_ENV: 'prod' })).to.equal('prod');
    expect(resolveEnvironment({ ENV: 'stage' })).to.equal('stage');
    expect(resolveEnvironment({})).to.equal('dev');
  });

  describe('resolveEnvironment: default-fallback warn-once', () => {
    beforeEach(() => resetEnvFallbackWarnedForTest());
    afterEach(() => resetEnvFallbackWarnedForTest());

    it('does NOT warn when AWS_ENV is set', () => {
      const log = { warn: sinon.spy() };
      expect(resolveEnvironment({ AWS_ENV: 'prod' }, { log })).to.equal('prod');
      expect(log.warn.called).to.be.false;
    });

    it('does NOT warn when ENV is set (AWS_ENV missing)', () => {
      const log = { warn: sinon.spy() };
      expect(resolveEnvironment({ ENV: 'stage' }, { log })).to.equal('stage');
      expect(log.warn.called).to.be.false;
    });

    it('warns exactly once per Lambda instance when defaulting to dev', () => {
      const log = { warn: sinon.spy() };
      // First call: log.warn fires.
      expect(resolveEnvironment({}, { log })).to.equal('dev');
      expect(log.warn.callCount).to.equal(1);
      expect(log.warn.firstCall.args[0]).to.include('AWS_ENV nor ENV');
      // Second call same instance: still 'dev', but no additional warn — the
      // guard prevents flooding on every request when the manifest is broken.
      expect(resolveEnvironment({}, { log })).to.equal('dev');
      expect(log.warn.callCount).to.equal(1);
    });

    it('is a no-op when no log is passed (backwards compat with old callers)', () => {
      // Legacy callers pass no options; the function must still return 'dev'
      // without throwing, and must not require the log param.
      expect(resolveEnvironment({})).to.equal('dev');
    });
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

  it('honors a custom namespace (LLMO-5587 brand metrics)', () => {
    const lines = [];
    emitMetric(
      { name: 'BrandDemotionBlocked', dimensions: { Operation: 'updateBrand' } },
      { environment: 'prod', sink: (l) => lines.push(l), namespace: 'Mysticat/Brands' },
    );
    const parsed = JSON.parse(lines[0]);
    // eslint-disable-next-line no-underscore-dangle
    expect(parsed._aws.CloudWatchMetrics[0].Namespace).to.equal('Mysticat/Brands');
    expect(parsed.BrandDemotionBlocked).to.equal(1);
    expect(parsed.Operation).to.equal('updateBrand');
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
