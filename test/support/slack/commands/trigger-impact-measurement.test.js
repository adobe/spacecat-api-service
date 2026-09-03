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

const VALID_GEO_EXP_ID = '11111111-1111-4111-8111-111111111111';

function mockGeoExperiment({
  id = 'geo-exp-1',
  phase = 'post_analysis_done',
  status = 'COMPLETED',
  siteId = 'site-1',
} = {}) {
  return {
    getId: () => id,
    getPhase: () => phase,
    getStatus: () => status,
    getSiteId: () => siteId,
  };
}

describe('TriggerImpactMeasurementCommand', () => {
  let TriggerImpactMeasurementCommand;
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let extractURLFromSlackInputStub;
  let postErrorMessageStub;
  let postSiteNotFoundMessageStub;
  let triggerGeoExperimentImpactMeasurementStub;
  let isImpactMeasurementEligibleStub;

  beforeEach(async () => {
    extractURLFromSlackInputStub = sinon.stub();
    postErrorMessageStub = sinon.stub().resolves();
    postSiteNotFoundMessageStub = sinon.stub().resolves();
    triggerGeoExperimentImpactMeasurementStub = sinon.stub().resolves();
    isImpactMeasurementEligibleStub = sinon.stub().returns(true);

    TriggerImpactMeasurementCommand = (await esmock(
      '../../../../src/support/slack/commands/trigger-impact-measurement.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
          postSiteNotFoundMessage: postSiteNotFoundMessageStub,
        },
        '../../../../src/support/utils.js': {
          triggerGeoExperimentImpactMeasurement: triggerGeoExperimentImpactMeasurementStub,
        },
        '../../../../src/support/geo-experiment-helper.js': {
          isImpactMeasurementEligible: isImpactMeasurementEligibleStub,
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
    const command = TriggerImpactMeasurementCommand(context);
    expect(command.id).to.equal('trigger-impact-measurement');
    expect(command.name).to.equal('Trigger Impact Measurement');
    expect(command.phrases).to.deep.equal(['trigger-impact-measurement']);
  });

  it('shows usage when baseURL is missing/invalid', async () => {
    extractURLFromSlackInputStub.returns(null);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(command.usage());
  });

  it('notifies when site is not found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = TriggerImpactMeasurementCommand(context);

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
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(
      ":x: No geo-experiments found for 'https://example.com'.",
    );
  });

  it('warns and does not trigger when the experiment is not eligible', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({ phase: 'pre_analysis_started', status: 'GENERATING_BASELINE' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    isImpactMeasurementEligibleStub.returns(false);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('geo-exp-1');
    expect(slackContext.say.firstCall.args[0]).to.include('pre_analysis_started');
    expect(triggerGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('fails gracefully when SQS client is missing', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [mockGeoExperiment()] });
    const command = TriggerImpactMeasurementCommand({ ...context, sqs: null });

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('missing SQS client');
    expect(triggerGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('picks the most recently updated experiment and triggers measurement', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const latest = mockGeoExperiment({ id: 'geo-exp-latest' });
    const older = mockGeoExperiment({ id: 'geo-exp-older' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [latest, older] });
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(triggerGeoExperimentImpactMeasurementStub).to.have.been.calledOnceWithExactly(
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
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], { ...slackContext, user: undefined });

    expect(triggerGeoExperimentImpactMeasurementStub).to.have.been.calledOnceWithExactly(
      'geo-exp-1',
      'unknown',
      { sqs: sqsStub, env: context.env },
    );
  });

  it('triggers measurement for an explicitly supplied geoExperimentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(
      mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-1' }),
    );
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(dataAccessStub.GeoExperiment.findById).to.have.been.calledOnceWith(VALID_GEO_EXP_ID);
    expect(dataAccessStub.GeoExperiment.allBySiteId).to.not.have.been.called;
    expect(triggerGeoExperimentImpactMeasurementStub).to.have.been.calledOnceWithExactly(
      VALID_GEO_EXP_ID,
      'U01USER',
      { sqs: sqsStub, env: context.env },
    );
  });

  it('rejects an invalid geoExperimentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', 'not-a-uuid'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('not a valid geo-experiment id');
    expect(dataAccessStub.GeoExperiment.findById).to.not.have.been.called;
    expect(triggerGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('notifies when the supplied geoExperimentId is not found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(null);
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('No geo-experiment found with id');
    expect(triggerGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('notifies when the supplied geoExperimentId belongs to another site', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(
      mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-2' }),
    );
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('does not belong to');
    expect(triggerGeoExperimentImpactMeasurementStub).to.not.have.been.called;
  });

  it('logs and posts an error message when an exception occurs', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.rejects(new Error('boom'));
    const command = TriggerImpactMeasurementCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
    expect(postErrorMessageStub.firstCall.args[0]).to.equal(slackContext.say);
    expect(postErrorMessageStub.firstCall.args[1]).to.be.instanceOf(Error);
  });
});
