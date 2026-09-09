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
import { IMPACT_MEASUREMENT_OUTCOME } from '../../../../src/support/geo-experiment-helper.js';

use(sinonChai);

const VALID_GEO_EXP_ID = '11111111-1111-4111-8111-111111111111';

function mockGeoExperiment({
  id = 'geo-exp-1',
  phase = 'impact_measurement_started',
  status = 'COMPLETED',
  siteId = 'site-1',
  insightsLocation,
} = {}) {
  return {
    getId: () => id,
    getPhase: () => phase,
    getStatus: () => status,
    getSiteId: () => siteId,
    getInsightsLocation: () => insightsLocation,
  };
}

describe('CheckImpactMeasurementCommand', () => {
  let CheckImpactMeasurementCommand;
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let extractURLFromSlackInputStub;
  let postErrorMessageStub;
  let postSiteNotFoundMessageStub;
  let checkGeoExperimentImpactMeasurementStub;
  let getImpactMeasurementOutcomeStub;

  beforeEach(async () => {
    extractURLFromSlackInputStub = sinon.stub();
    postErrorMessageStub = sinon.stub().resolves();
    postSiteNotFoundMessageStub = sinon.stub().resolves();
    checkGeoExperimentImpactMeasurementStub = sinon.stub().resolves();
    getImpactMeasurementOutcomeStub = sinon.stub().returns(IMPACT_MEASUREMENT_OUTCOME.IN_FLIGHT);

    CheckImpactMeasurementCommand = (await esmock(
      '../../../../src/support/slack/commands/check-impact-measurement.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
          postSiteNotFoundMessage: postSiteNotFoundMessageStub,
        },
        '../../../../src/support/utils.js': {
          checkGeoExperimentImpactMeasurement: checkGeoExperimentImpactMeasurementStub,
        },
        '../../../../src/support/geo-experiment-helper.js': {
          getImpactMeasurementOutcome: getImpactMeasurementOutcomeStub,
          IMPACT_MEASUREMENT_OUTCOME,
        },
      },
    )).default;

    dataAccessStub = {
      Site: { findByBaseURL: sinon.stub() },
      GeoExperiment: { allBySiteId: sinon.stub(), findById: sinon.stub() },
    };

    sqsStub = { sendMessage: sinon.stub().resolves() };

    context = {
      dataAccess: dataAccessStub,
      env: { LLMO_EXPERIMENTATION_ENGINE_QUEUE_URL: 'queue-url' },
      log: { error: sinon.spy() },
      sqs: sqsStub,
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'C123',
      threadTs: '1712345678.9012',
      user: 'U01USER',
    };
  });

  it('initializes with base command metadata', () => {
    const command = CheckImpactMeasurementCommand(context);
    expect(command.id).to.equal('check-impact-measurement');
    expect(command.name).to.equal('Check Impact Measurement');
    expect(command.phrases).to.deep.equal(['check-impact-measurement']);
  });

  it('shows usage when baseURL is missing/invalid', async () => {
    extractURLFromSlackInputStub.returns(null);
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(command.usage());
  });

  it('notifies when site is not found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(postSiteNotFoundMessageStub).to.have.been.calledOnceWith(
      slackContext.say,
      'https://example.com',
    );
  });

  it('notifies when the site has no geo-experiments', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [] });
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(
      ":x: No geo-experiments found for 'https://example.com'.",
    );
  });

  it('reports success with the insights location when measurement has completed', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({
      phase: 'impact_measurement_done',
      status: 'COMPLETED',
      insightsLocation: 's3://bucket/geo-experiments/geo-exp-1/insights.json',
    });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    getImpactMeasurementOutcomeStub.returns(IMPACT_MEASUREMENT_OUTCOME.SUCCEEDED);
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
    expect(slackContext.say.firstCall.args[0]).to.include('s3://bucket/geo-experiments/geo-exp-1/insights.json');
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('reports a completed-without-insights failure and suggests re-triggering', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({ phase: 'post_analysis_done', status: 'COMPLETED' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    getImpactMeasurementOutcomeStub.returns(IMPACT_MEASUREMENT_OUTCOME.COMPLETED_WITHOUT_INSIGHTS);
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('without insights');
    expect(slackContext.say.firstCall.args[0]).to.include('trigger-impact-measurement');
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('warns and does not check when no task is in flight and nothing has been measured', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({ phase: 'pre_analysis_done', status: 'IN_PROGRESS' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    getImpactMeasurementOutcomeStub.returns(IMPACT_MEASUREMENT_OUTCOME.NOT_APPLICABLE);
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('geo-exp-1');
    expect(slackContext.say.firstCall.args[0]).to.include('pre_analysis_done');
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('fails gracefully when SQS client is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [mockGeoExperiment()] });
    const command = CheckImpactMeasurementCommand({ ...context, sqs: null });

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('missing SQS client');
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('picks the most recently updated experiment and requests a check', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const latest = mockGeoExperiment({ id: 'geo-exp-latest' });
    const older = mockGeoExperiment({ id: 'geo-exp-older' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [latest, older] });
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(checkGeoExperimentImpactMeasurementStub).to.have.been.calledOnceWithExactly(
      'geo-exp-latest',
      'U01USER',
      { sqs: sqsStub, env: context.env },
    );
    expect(slackContext.say.firstCall.args[0]).to.include('geo-exp-latest');
  });

  it('falls back triggeredBy to "unknown" when slackContext.user is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [mockGeoExperiment()] });
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], { ...slackContext, user: undefined });

    expect(checkGeoExperimentImpactMeasurementStub).to.have.been.calledOnceWithExactly(
      'geo-exp-1',
      'unknown',
      { sqs: sqsStub, env: context.env },
    );
  });

  it('checks measurement for an explicitly supplied geoExperimentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(
      mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-1' }),
    );
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(dataAccessStub.GeoExperiment.findById).to.have.been.calledOnceWith(VALID_GEO_EXP_ID);
    expect(dataAccessStub.GeoExperiment.allBySiteId).to.not.have.been.called;
    expect(checkGeoExperimentImpactMeasurementStub).to.have.been.calledOnceWithExactly(
      VALID_GEO_EXP_ID,
      'U01USER',
      { sqs: sqsStub, env: context.env },
    );
  });

  it('rejects an invalid geoExperimentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', 'not-a-uuid'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('not a valid geo-experiment id');
    expect(dataAccessStub.GeoExperiment.findById).to.not.have.been.called;
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('notifies when the supplied geoExperimentId is not found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(null);
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('No geo-experiment found with id');
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('notifies when the supplied geoExperimentId belongs to another site', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(
      mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-2' }),
    );
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('does not belong to');
    expect(checkGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('logs and posts an error message when an exception occurs', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.rejects(new Error('boom'));
    const command = CheckImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
    expect(postErrorMessageStub.firstCall.args[0]).to.equal(slackContext.say);
    expect(postErrorMessageStub.firstCall.args[1]).to.be.instanceOf(Error);
  });
});
