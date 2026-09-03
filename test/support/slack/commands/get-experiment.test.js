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

function mockGeoExperiment(overrides = {}) {
  const base = {
    id: 'geo-exp-1',
    name: 'Recover content visibility',
    type: 'onsite_opportunity_deployment',
    phase: 'impact_measurement_done',
    status: 'COMPLETED',
    siteId: 'site-1',
    opportunityId: 'opp-1',
    promptsCount: 12,
    suggestionIds: ['sug-1', 'sug-2'],
    insightsLocation: 's3://bucket/geo-experiments/geo-exp-1/insights.json',
    startTime: '2026-08-01T00:00:00.000Z',
    endTime: '2026-08-15T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    updatedBy: 'U01USER',
    metadata: { urls: ['https://example.com'], impactMeasurementTaskId: 'task-1' },
    error: undefined,
    ...overrides,
  };
  return {
    getId: () => base.id,
    getName: () => base.name,
    getType: () => base.type,
    getPhase: () => base.phase,
    getStatus: () => base.status,
    getSiteId: () => base.siteId,
    getOpportunityId: () => base.opportunityId,
    getPromptsCount: () => base.promptsCount,
    getSuggestionIds: () => base.suggestionIds,
    getInsightsLocation: () => base.insightsLocation,
    getStartTime: () => base.startTime,
    getEndTime: () => base.endTime,
    getCreatedAt: () => base.createdAt,
    getUpdatedAt: () => base.updatedAt,
    getUpdatedBy: () => base.updatedBy,
    getMetadata: () => base.metadata,
    getError: () => base.error,
  };
}

describe('GetExperimentCommand', () => {
  let GetExperimentCommand;
  let context;
  let slackContext;
  let dataAccessStub;
  let extractURLFromSlackInputStub;
  let postErrorMessageStub;
  let postSiteNotFoundMessageStub;

  beforeEach(async () => {
    extractURLFromSlackInputStub = sinon.stub();
    postErrorMessageStub = sinon.stub().resolves();
    postSiteNotFoundMessageStub = sinon.stub().resolves();

    GetExperimentCommand = (await esmock(
      '../../../../src/support/slack/commands/get-experiment.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
          postErrorMessage: postErrorMessageStub,
          postSiteNotFoundMessage: postSiteNotFoundMessageStub,
        },
      },
    )).default;

    dataAccessStub = {
      Site: { findByBaseURL: sinon.stub() },
      GeoExperiment: { allBySiteId: sinon.stub(), findById: sinon.stub() },
    };

    context = {
      dataAccess: dataAccessStub,
      env: {},
      log: { error: sinon.spy() },
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'C123',
      user: 'U01USER',
    };
  });

  it('initializes with base command metadata', () => {
    const command = GetExperimentCommand(context);
    expect(command.id).to.equal('get-experiment');
    expect(command.name).to.equal('Get Experiment');
    expect(command.phrases).to.deep.equal(['get-experiment']);
  });

  it('shows usage when baseURL is missing/invalid', async () => {
    extractURLFromSlackInputStub.returns(null);
    const command = GetExperimentCommand(context);

    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(command.usage());
  });

  it('notifies when site is not found', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves(null);
    const command = GetExperimentCommand(context);

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
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say).to.have.been.calledOnceWith(
      ":x: No geo-experiments found for 'https://example.com'.",
    );
  });

  it('renders a concise emoji summary of the most recent experiment', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const latest = mockGeoExperiment({ id: 'geo-exp-latest' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [latest, mockGeoExperiment()] });
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    const msg = slackContext.say.firstCall.args[0];
    expect(msg).to.include(':test_tube:');
    expect(msg).to.include('geo-exp-latest');
    expect(msg).to.include('https://example.com');
    expect(msg).to.include('onsite_opportunity_deployment');
    expect(msg).to.include('impact_measurement_done');
    expect(msg).to.include('COMPLETED');
    expect(msg).to.include('insights.json');
    expect(msg).to.include(':jigsaw:');
    // metadata top-level keys are listed, not dumped
    expect(msg).to.include('urls, impactMeasurementTaskId');
  });

  it('renders em-dash placeholders and an error line when fields are absent', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({
      name: undefined,
      opportunityId: undefined,
      insightsLocation: undefined,
      startTime: undefined,
      endTime: undefined,
      updatedBy: undefined,
      suggestionIds: undefined,
      metadata: undefined,
      error: { message: 'measurement failed' },
    });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    const msg = slackContext.say.firstCall.args[0];
    expect(msg).to.include('—');
    expect(msg).to.include(':rotating_light:');
    expect(msg).to.include('measurement failed');
    expect(msg).to.include(':jigsaw: *Suggestions:* 0');
  });

  it('stringifies a non-message error object on the error line', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({ error: { code: 'E_MYSTIQUE' } });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('E_MYSTIQUE');
  });

  it('renders a plain-string error without extra quoting', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({ error: 'measurement failed' });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include(':rotating_light: *Error:* measurement failed');
  });

  it('renders an em-dash for a missing prompts count instead of "null"/"undefined"', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const geo = mockGeoExperiment({ promptsCount: undefined });
    dataAccessStub.GeoExperiment.allBySiteId.resolves({ data: [geo] });
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    const msg = slackContext.say.firstCall.args[0];
    expect(msg).to.include(':bar_chart: *Prompts:* —');
    expect(msg).to.not.include('*Prompts:* undefined');
    expect(msg).to.not.include('*Prompts:* null');
  });

  it('resolves an explicitly supplied geoExperimentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    dataAccessStub.GeoExperiment.findById.resolves(
      mockGeoExperiment({ id: VALID_GEO_EXP_ID, siteId: 'site-1' }),
    );
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com', VALID_GEO_EXP_ID], slackContext);

    expect(dataAccessStub.GeoExperiment.findById).to.have.been.calledOnceWith(VALID_GEO_EXP_ID);
    expect(dataAccessStub.GeoExperiment.allBySiteId).to.not.have.been.called;
    expect(slackContext.say.firstCall.args[0]).to.include(VALID_GEO_EXP_ID);
  });

  it('rejects an invalid geoExperimentId', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.resolves({ getId: () => 'site-1' });
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com', 'not-a-uuid'], slackContext);

    expect(slackContext.say.firstCall.args[0]).to.include('not a valid geo-experiment id');
    expect(dataAccessStub.GeoExperiment.findById).to.not.have.been.called;
  });

  it('logs and posts an error message when an exception occurs', async () => {
    extractURLFromSlackInputStub.returns('https://example.com');
    dataAccessStub.Site.findByBaseURL.rejects(new Error('boom'));
    const command = GetExperimentCommand(context);

    await command.handleExecution(['example.com'], slackContext);

    expect(context.log.error).to.have.been.calledOnce;
    expect(postErrorMessageStub).to.have.been.calledOnce;
  });
});
