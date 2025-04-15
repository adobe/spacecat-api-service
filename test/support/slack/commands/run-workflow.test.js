/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('RunWorkflowCommand', () => {
  let context;
  let slackContext;
  let say;
  let onboardMock;
  let RunWorkflowCommand;

  beforeEach(async () => {
    say = sinon.stub();
    slackContext = {
      say,
      files: [],
    };

    onboardMock = {
      handleExecution: sinon.stub(),
    };

    context = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    RunWorkflowCommand = await esmock('../../../../src/support/slack/commands/run-workflow.js', {
      '../../../../src/support/slack/commands/onboard.js': sinon.stub().returns(onboardMock),
    });
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(RunWorkflowCommand);
  });

  it('should call onboard.handleExecution for a single valid site', async () => {
    const args = ['https://example.com', 'org123', 'default'];
    const command = RunWorkflowCommand(context);

    await command.handleExecution(args, slackContext);

    expect(onboardMock.handleExecution).to.have.been.calledWith(
      ['https://example.com', 'org123', 'default'],
      slackContext,
    );

    expect(say).to.have.been.calledWithMatch(/Starting onboarding/);
    expect(say).to.have.been.calledWithMatch(/Completed full workflow/);
  });

  it('should warn when both URL and CSV are provided', async () => {
    const args = ['https://example.com', 'org123', 'default'];
    slackContext.files = [{ name: 'sites.csv' }];
    const command = RunWorkflowCommand(context);

    await command.handleExecution(args, slackContext);

    expect(say).to.have.been.calledWith(':warning: Provide either a URL or a CSV file, not both.');
    expect(onboardMock.handleExecution).not.to.have.been.called;
  });

  it('should show usage when neither URL nor CSV is provided', async () => {
    const args = ['invalid-url', 'org123', 'default'];
    const command = RunWorkflowCommand(context);

    await command.handleExecution(args, slackContext);

    expect(say).to.have.been.calledWith(command.usage());
    expect(onboardMock.handleExecution).not.to.have.been.called;
  });

  it('should log error when onboard.handleExecution throws', async () => {
    onboardMock.handleExecution.rejects(new Error('onboard error'));

    const args = ['https://example.com', 'org123', 'default'];
    const command = RunWorkflowCommand(context);

    await command.handleExecution(args, slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'Can not call handleExecution from onboard command',
      sinon.match.instanceOf(Error),
    );
  });
});
