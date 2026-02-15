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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('ResolveUserIdCommand', () => {
  let ResolveUserIdCommand;
  let postErrorMessageStub;
  let context;
  let slackContext;
  let getImsAdminProfileStub;

  const loadModule = async () => {
    postErrorMessageStub = sinon.stub().resolves();

    ({ default: ResolveUserIdCommand } = await esmock(
      '../../../../src/support/slack/commands/resolve-user-id.js',
      {
        '../../../../src/utils/slack/base.js': {
          postErrorMessage: postErrorMessageStub,
        },
      },
    ));
  };

  beforeEach(async function () {
    this.timeout(5000);
    await loadModule();

    getImsAdminProfileStub = sinon.stub();

    context = {
      imsClient: {
        getImsAdminProfile: getImsAdminProfileStub,
      },
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'C123',
      threadTs: '123.456',
    };
  });

  it('displays usage when no userId is provided', async () => {
    const command = ResolveUserIdCommand(context);
    await command.handleExecution([], slackContext);

    expect(slackContext.say).to.have.been.calledWithMatch('Usage:');
    expect(getImsAdminProfileStub).to.not.have.been.called;
  });

  it('resolves a user ID and displays the profile', async () => {
    getImsAdminProfileStub.resolves({
      first_name: 'John',
      last_name: 'Doe',
      email: 'john.doe@adobe.com',
    });

    const command = ResolveUserIdCommand(context);
    await command.handleExecution(['user123@AdobeOrg'], slackContext);

    expect(getImsAdminProfileStub).to.have.been.calledWith('user123@AdobeOrg');
    expect(slackContext.say).to.have.been.calledWithMatch('user123@AdobeOrg');
    expect(slackContext.say).to.have.been.calledWithMatch('John');
    expect(slackContext.say).to.have.been.calledWithMatch('Doe');
    expect(slackContext.say).to.have.been.calledWithMatch('john.doe@adobe.com');
  });

  it('displays dashes for missing profile fields', async () => {
    getImsAdminProfileStub.resolves({});

    const command = ResolveUserIdCommand(context);
    await command.handleExecution(['user456'], slackContext);

    expect(getImsAdminProfileStub).to.have.been.calledWith('user456');
    expect(slackContext.say).to.have.been.calledOnce;

    const message = slackContext.say.firstCall.args[0];
    expect(message).to.include('*First Name:* -');
    expect(message).to.include('*Last Name:* -');
    expect(message).to.include('*Email:* -');
  });

  it('handles errors from getImsAdminProfile', async () => {
    const error = new Error('IMS service unavailable');
    getImsAdminProfileStub.rejects(error);

    const command = ResolveUserIdCommand(context);
    await command.handleExecution(['user789'], slackContext);

    expect(context.log.error).to.have.been.calledWith(
      'Failed to resolve user ID: IMS service unavailable',
    );
    expect(postErrorMessageStub).to.have.been.calledWith(slackContext.say, error);
  });

  it('accepts the "resolve user" phrase', () => {
    const command = ResolveUserIdCommand(context);

    expect(command.accepts('resolve user user123')).to.be.true;
    expect(command.accepts('resolve user')).to.be.true;
    expect(command.accepts('get user')).to.be.false;
  });
});
