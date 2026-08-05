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
  return {
    getId: () => GEO_EXPERIMENT_ID,
    getPhase: () => phase,
    getStatus: () => status,
    getMetadata: () => metadata,
  };
}

describe('TriggerImpactMeasurementCommand', () => {
  let context;
  let slackContext;
  let findByIdStub;
  let sendMessageStub;

  beforeEach(() => {
    findByIdStub = sinon.stub();
    sendMessageStub = sinon.stub().resolves();
    context = {
      dataAccess: {
        GeoExperiment: { findById: findByIdStub },
      },
      log: {
        info: sinon.spy(),
        error: sinon.spy(),
        warn: sinon.spy(),
      },
      sqs: { sendMessage: sendMessageStub },
      env: { LLMO_EXPERIMENTATION_ENGINE_QUEUE_URL: 'testQueueUrl' },
    };
    slackContext = { say: sinon.spy(), userId: 'U123' };
  });

  afterEach(() => sinon.restore());

  it('replies with usage when no geoExperimentId is given', async () => {
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(findByIdStub).to.not.have.been.called;
    expect(sendMessageStub).to.not.have.been.called;
  });

  it('replies with usage when the id is not a valid UUID', async () => {
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['not-a-uuid'], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(sendMessageStub).to.not.have.been.called;
  });

  it('replies not found when the experiment does not exist', async () => {
    findByIdStub.resolves(null);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('not found');
    expect(sendMessageStub).to.not.have.been.called;
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
    expect(sendMessageStub).to.not.have.been.called;
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
    expect(sendMessageStub).to.not.have.been.called;
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
    expect(sendMessageStub).to.not.have.been.called;
  });

  it('sends a TRIGGER_IMPACT_MEASUREMENT message for an experiment ready for measurement', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.POST_ANALYSIS_DONE,
      status: STATUSES.IN_PROGRESS,
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(sendMessageStub).to.have.been.calledOnceWithExactly('testQueueUrl', {
      type: 'TRIGGER_IMPACT_MEASUREMENT',
      geoExperimentId: GEO_EXPERIMENT_ID,
      triggeredBy: 'slack:U123',
    });
    expect(slackContext.say).to.have.been.calledWithMatch('Triggered impact measurement');
  });

  it('sends the message to re-arm a failed in-flight experiment', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_STARTED,
      status: STATUSES.FAILED,
      metadata: { [METADATA_KEYS.IMPACT_MEASUREMENT_TASK_ID]: 'old-task' },
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(sendMessageStub).to.have.been.calledOnce;
    expect(slackContext.say).to.have.been.calledWithMatch('Triggered impact measurement');
  });

  it('sends the message to re-arm a completed experiment for re-measurement', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.IMPACT_MEASUREMENT_DONE,
      status: STATUSES.COMPLETED,
      metadata: { [METADATA_KEYS.IMPACT_MEASUREMENT_TASK_ID]: 'old-task' },
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(sendMessageStub).to.have.been.calledOnce;
  });

  it('defaults triggeredBy to "slack" when the slack context has no userId', async () => {
    const geo = createMockGeoExperiment({
      phase: PHASES.POST_ANALYSIS_DONE,
      status: STATUSES.IN_PROGRESS,
    });
    findByIdStub.resolves(geo);
    const command = TriggerImpactMeasurementCommand(context);
    const anonymousSlackContext = { say: sinon.spy() };

    await command.handleExecution([GEO_EXPERIMENT_ID], anonymousSlackContext);

    expect(sendMessageStub).to.have.been.calledOnceWithExactly('testQueueUrl', {
      type: 'TRIGGER_IMPACT_MEASUREMENT',
      geoExperimentId: GEO_EXPERIMENT_ID,
      triggeredBy: 'slack',
    });
  });

  it('posts an error message when an unexpected error is thrown', async () => {
    findByIdStub.rejects(new Error('db down'));
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([GEO_EXPERIMENT_ID], slackContext);

    expect(context.log.error).to.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });
});
