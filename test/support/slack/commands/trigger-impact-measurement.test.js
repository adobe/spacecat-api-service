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

import { GeoExperiment } from '@adobe/spacecat-shared-data-access';
import TriggerImpactMeasurementCommand from '../../../../src/support/slack/commands/trigger-impact-measurement.js';

use(sinonChai);

const { STATUSES, PHASES, METADATA_KEYS } = GeoExperiment;
const GEO_EXPERIMENT_ID = '3c1a6e2e-7b3a-4a3e-9e2a-2f6b6a2b5a11';

function createMockGeoExperiment({
  phase = PHASES.POST_ANALYSIS_DONE,
  status = STATUSES.IN_PROGRESS,
  metadata = {},
} = {}) {
  let currentPhase = phase;
  let currentStatus = status;
  let currentMetadata = metadata;
  let currentError;
  let currentEndTime;
  let currentInsightsLocation;
  return {
    getId: () => GEO_EXPERIMENT_ID,
    getPhase: () => currentPhase,
    getStatus: () => currentStatus,
    getMetadata: () => currentMetadata,
    getError: () => currentError,
    getEndTime: () => currentEndTime,
    getInsightsLocation: () => currentInsightsLocation,
    setPhase: (v) => { currentPhase = v; },
    setStatus: (v) => { currentStatus = v; },
    setMetadata: (v) => { currentMetadata = v; },
    setError: (v) => { currentError = v; },
    setEndTime: (v) => { currentEndTime = v; },
    setInsightsLocation: (v) => { currentInsightsLocation = v; },
    setUpdatedBy: sinon.stub(),
    save: sinon.stub().resolves(),
  };
}

describe('TriggerImpactMeasurementCommand', () => {
  let context;
  let slackContext;
  let findByIdStub;

  beforeEach(() => {
    findByIdStub = sinon.stub();
    context = {
      dataAccess: {
        GeoExperiment: { findById: findByIdStub },
      },
      log: {
        info: sinon.spy(),
        error: sinon.spy(),
        warn: sinon.spy(),
      },
    };
    slackContext = { say: sinon.spy(), userId: 'U123' };
  });

  afterEach(() => sinon.restore());

  it('replies with usage when no geoExperimentId is given', async () => {
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(findByIdStub).to.not.have.been.called;
  });

  it('replies with usage when the id is not a valid UUID', async () => {
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['not-a-uuid'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(findByIdStub).to.not.have.been.called;
  });

  it('replies not found when the experiment does not exist', async () => {
    findByIdStub.resolves(null);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('not found');
  });

  it('refuses to trigger when the experiment has not reached post-analysis', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.PRE_ANALYSIS_STARTED,
      status: STATUSES.GENERATING_BASELINE,
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('has not');
    expect(geo.save).to.not.have.been.called;
  });

  it('refuses to resubmit while a measurement task is already in flight', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_STARTED,
      status: STATUSES.IN_PROGRESS,
      metadata: { [METADATA_KEYS.IMPACT_MEASUREMENT_TASK_ID]: 'task-123' },
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('task-123');
    expect(geo.save).to.not.have.been.called;
  });

  it('falls back to "unknown" when an in-flight experiment has no recorded task ID', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_STARTED,
      status: STATUSES.IN_PROGRESS,
      metadata: {},
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('unknown');
    expect(geo.save).to.not.have.been.called;
  });

  it('does not touch an experiment that is already armed (POST_ANALYSIS_DONE / IN_PROGRESS)', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.POST_ANALYSIS_DONE,
      status: STATUSES.IN_PROGRESS,
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(geo.save).to.not.have.been.called;
    expect(slackContext.say).to.have.been.calledWithMatch('Triggered impact measurement');
  });

  it('re-arms a failed in-flight experiment, clearing stale measurement state', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_STARTED,
      status: STATUSES.FAILED,
      metadata: {
        [METADATA_KEYS.IMPACT_MEASUREMENT_TASK_ID]: 'old-task',
        impact_measurement_retry_count: 6,
        scheduleConfig: { pre: {}, post: {} },
      },
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(geo.getPhase()).to.equal(PHASES.POST_ANALYSIS_DONE);
    expect(geo.getStatus()).to.equal(STATUSES.IN_PROGRESS);
    expect(geo.getMetadata()).to.deep.equal({ scheduleConfig: { pre: {}, post: {} } });
    expect(geo.getError()).to.be.null;
    expect(geo.getEndTime()).to.be.null;
    expect(geo.getInsightsLocation()).to.be.null;
    expect(geo.save).to.have.been.calledOnce;
    expect(slackContext.say).to.have.been.calledWithMatch('Triggered impact measurement');
  });

  it('re-arms a completed experiment for re-measurement', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_DONE,
      status: STATUSES.COMPLETED,
      metadata: { [METADATA_KEYS.IMPACT_MEASUREMENT_TASK_ID]: 'old-task' },
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(geo.getPhase()).to.equal(PHASES.POST_ANALYSIS_DONE);
    expect(geo.getStatus()).to.equal(STATUSES.IN_PROGRESS);
    expect(geo.getMetadata()).to.deep.equal({});
    expect(geo.save).to.have.been.calledOnce;
  });

  it('falls back to a generic updatedBy label when the slack context has no userId', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_DONE,
      status: STATUSES.COMPLETED,
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);
    const anonymousSlackContext = { say: sinon.spy() };

    await command.handleExecution([GEO_EXPERIMENT_ID], anonymousSlackContext);

    expect(geo.setUpdatedBy).to.have.been.calledWith('slack:trigger-impact-measurement');
  });

  it('posts an error message when an unexpected error is thrown', async () => {
    findByIdStub.rejects(new Error('db down'));
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(context.log.error).to.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });
});
