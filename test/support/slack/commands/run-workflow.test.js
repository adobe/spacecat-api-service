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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('RunWorkflowCommand', () => {
  let RunWorkflowCommand;
  let slackContext;
  let context;
  let onboardMock;
  let auditMock;
  let postErrorMessageStub;

  beforeEach(async () => {
    onboardMock = {
      handleExecution: sinon.stub().resolves(),
    };
    auditMock = {
      handleExecution: sinon.stub().resolves(),
    };

    postErrorMessageStub = sinon.stub();

    slackContext = {
      say: sinon.stub(),
      files: [],
    };

    context = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    RunWorkflowCommand = await esmock(
      '../../../../src/support/slack/commands/run-workflow.js',
      {
        '../../../../src/support/slack/commands/onboard.js': () => onboardMock,
        '../../../../src/support/slack/commands/run-audit.js': () => auditMock,
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: postErrorMessageStub,
        },
      },
    );
  });
  afterEach(() => {
    sinon.restore();
  });
  it('should call onboard for a valid single site', async () => {
    const args = ['https://www.visualcomfort.com', 'org123', 'default'];
    const command = RunWorkflowCommand(context);
    await command.handleExecution(args, slackContext);
    expect(onboardMock.handleExecution).to.have.been.calledWith(
      ['https://www.visualcomfort.com', 'org123', 'default'],
      slackContext,
    );
    expect(auditMock.handleExecution).to.have.been.calledWith(
      ['https://www.visualcomfort.com', 'all'],
      slackContext,
    );
    expect(slackContext.say).to.have.been.calledWithMatch('Starting onboarding');
    expect(slackContext.say).to.have.been.calledWithMatch('Completed full workflow');
  });

  it('should catch top-level error in handleExecution', async () => {
    const args = ['https://example.com', 'org123', 'default'];
    RunWorkflowCommand(context);

    // Break isValidUrl function to throw
    const brokenCommand = await esmock(
      '../../../../src/support/slack/commands/run-workflow.js',
      {
        '../../../../src/support/slack/commands/onboard.js': () => onboardMock,
        '../../../../src/support/slack/commands/run-audit.js': () => auditMock,
        '@adobe/spacecat-shared-utils': {
          isValidUrl: () => {
            throw new Error('top-level failure');
          },
          isNonEmptyArray: () => false,
        },
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: postErrorMessageStub,
        },
      },
    );

    await brokenCommand(context).handleExecution(args, slackContext);

    expect(context.log.error).to.have.been.called;
    expect(postErrorMessageStub).to.have.been.called;
  });

  it('should catch error from onboard.handleExecution and call postErrorMessage', async () => {
    const error = new Error('Test error');
    onboardMock.handleExecution.rejects(error); // Make it throw when awaited

    const args = ['https://example.com', 'org123', 'profile1'];
    const command = RunWorkflowCommand(context);

    await command.handleExecution(args, slackContext);

    // Check that log.error was called with the error
    expect(context.log.error).to.have.been.calledWith(error);

    // Check that postErrorMessage was called with slackContext.say and the error
    expect(postErrorMessageStub).to.have.been.calledWith(slackContext.say, error);
  });
});
