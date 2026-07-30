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

import RunImpactMeasurementCommand from '../../../../src/support/slack/commands/run-impact-measurement.js';

use(sinonChai);

const QUEUE = 'engineQueueUrl';

describe('RunImpactMeasurementCommand', () => {
  let context;
  let slackContext;
  let dataAccess;
  let sqs;

  const makeSite = (id = 'site-1') => ({ getId: () => id });
  const makeExperiment = (overrides = {}) => ({
    getId: () => 'exp-1',
    getSiteId: () => 'site-1',
    getName: () => 'Exp One',
    getStatus: () => 'IN_PROGRESS',
    ...overrides,
  });

  beforeEach(() => {
    dataAccess = {
      Site: { findByBaseURL: sinon.stub() },
      GeoExperiment: { findById: sinon.stub(), allBySiteId: sinon.stub() },
    };
    sqs = { sendMessage: sinon.stub().resolves() };
    context = {
      dataAccess,
      sqs,
      env: { LLMO_EXPERIMENTATION_ENGINE_QUEUE_URL: QUEUE },
      log: { info: sinon.stub(), error: sinon.stub() },
    };
    slackContext = { say: sinon.stub().resolves() };
  });

  afterEach(() => sinon.restore());

  it('accepts its trigger phrase', () => {
    const cmd = RunImpactMeasurementCommand(context);
    expect(cmd.accepts('run impact measurement https://example.com')).to.be.true;
    expect(cmd.accepts('run something else')).to.be.false;
  });

  it('shows usage when the URL is invalid', async () => {
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['not-a-url'], slackContext);
    expect(sqs.sendMessage).to.not.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });

  it('warns when the engine queue is not configured', async () => {
    context.env = {};
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/queue is not configured/);
    expect(sqs.sendMessage).to.not.have.been.called;
  });

  it('reports when the site is not found', async () => {
    dataAccess.Site.findByBaseURL.resolves(null);
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(sqs.sendMessage).to.not.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });

  it('warns when an explicit experiment id is not found for the site', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.findById.resolves(null);
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com', 'missing-id'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/No geo-experiment `missing-id`/);
    expect(sqs.sendMessage).to.not.have.been.called;
  });

  it('warns when the explicit experiment belongs to a different site', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.findById.resolves(makeExperiment({ getSiteId: () => 'other-site' }));
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com', 'exp-1'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/No geo-experiment `exp-1`/);
    expect(sqs.sendMessage).to.not.have.been.called;
  });

  it('warns when the site has no experiments', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.allBySiteId.resolves({ data: [] });
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/No geo-experiments found/);
    expect(sqs.sendMessage).to.not.have.been.called;
  });

  it('lists experiments and asks for an id when the site has multiple', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.allBySiteId.resolves({
      data: [makeExperiment(), makeExperiment({ getId: () => 'exp-2' })],
    });
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/Multiple geo-experiments/);
    expect(sqs.sendMessage).to.not.have.been.called;
  });

  it('dispatches to the engine queue for the single experiment', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.allBySiteId.resolves({ data: [makeExperiment()] });
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(sqs.sendMessage).to.have.been.calledOnceWith(QUEUE, {
      type: 'run-impact-measurement',
      siteId: 'site-1',
      geoExperimentId: 'exp-1',
    });
    expect(slackContext.say).to.have.been.calledWithMatch(/Impact measurement triggered/);
  });

  it('dispatches for an explicitly-provided experiment id', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.findById.resolves(makeExperiment());
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com', 'exp-1'], slackContext);
    expect(dataAccess.GeoExperiment.allBySiteId).to.not.have.been.called;
    expect(sqs.sendMessage).to.have.been.calledOnceWith(QUEUE, {
      type: 'run-impact-measurement',
      siteId: 'site-1',
      geoExperimentId: 'exp-1',
    });
  });

  it('handles experiments without name/status accessors in the multi list', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.allBySiteId.resolves({
      data: [
        { getId: () => 'exp-1' },
        { getId: () => 'exp-2' },
      ],
    });
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/Multiple geo-experiments/);
  });

  it('posts an error message when dispatch throws', async () => {
    dataAccess.Site.findByBaseURL.resolves(makeSite());
    dataAccess.GeoExperiment.allBySiteId.resolves({ data: [makeExperiment()] });
    sqs.sendMessage.rejects(new Error('sqs down'));
    const cmd = RunImpactMeasurementCommand(context);
    await cmd.handleExecution(['https://www.example.com'], slackContext);
    expect(context.log.error).to.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });
});
