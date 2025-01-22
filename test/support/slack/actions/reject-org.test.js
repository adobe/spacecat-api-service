/*
 * Copyright 2024 Adobe. All rights reserved.
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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import rejectOrg from '../../../../src/support/slack/actions/reject-org.js';

use(chaiAsPromised);
use(sinonChai);

describe('rejectOrg', () => {
  let context;
  let ackMock;
  let respondMock;
  let postMessageMock;
  let body;

  beforeEach(() => {
    ackMock = sinon.stub().resolves();
    respondMock = sinon.stub().resolves();
    postMessageMock = sinon.stub().resolves();

    context = {
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      slackClients: {
        WORKSPACE_INTERNAL_STANDARD: {
          postMessage: postMessageMock,
        },
      },
      env: {
        SLACK_REPORT_CHANNEL_INTERNAL: 'channel-id',
      },
    };

    body = {
      channel: { id: 'some-channel-id' },
      message: {
        ts: 'some-thread-ts',
        blocks: [
          {
            block_id: 'some-block-id',
            text: {
              text: 'IMS org ID `ABC@AdobeOrg` for <https://spacecat.com|spacecat.com>',
            },
          },
        ],
      },
      user: {
        username: 'test-user',
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should reject the organization and prompt for correct details', async () => {
    // Arrange
    const rejectOrgAction = rejectOrg(context);

    // Act
    await rejectOrgAction({ ack: ackMock, body, respond: respondMock });

    // Assert
    expect(ackMock).to.have.been.calledOnce;
    expect(context.log.info).to.have.been.called; // logs input
    expect(respondMock).to.have.been.calledOnce;

    const respondArg = respondMock.firstCall.args[0];
    expect(respondArg.replace_original).to.be.true;
    expect(respondArg.blocks[1].text).to.deep.equal({
      text: 'Rejected by @test-user :cross-x:',
      type: 'mrkdwn',
    });

    expect(postMessageMock).to.have.been.calledOnce;
    const followUpArg = postMessageMock.firstCall.args[0];
    expect(followUpArg.blocks[0].text.text)
      .to.include('Please let me know about the correct organization details');
  });

  it('should log and rethrow if an error occurs', async () => {
    // Arrange
    ackMock.rejects(new Error('Slack ack error'));
    const rejectOrgAction = rejectOrg(context);

    // Act / Assert
    await expect(rejectOrgAction({ ack: ackMock, body, respond: respondMock }))
      .to.be.rejectedWith('Slack ack error');

    expect(context.log.error).to.have.been.calledWith(
      'Error occurred while acknowledging org approval',
      sinon.match.instanceOf(Error),
    );
  });
});
