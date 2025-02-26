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
import { SiteCandidate } from '@adobe/spacecat-shared-data-access';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import approveFriendsFamily from '../../../../src/support/slack/actions/approve-friends-family.js';
import { expectedAnnouncedMessage, expectedApprovedFnFReply, slackFriendsFamilyResponse } from './slack-fixtures.js';

use(chaiAsPromised);
use(sinonChai);

describe('approveSiteCandidate', () => {
  const baseURL = 'https://spacecat.com';
  const hlxConfig = {
    hlxVersion: 4,
    rso: {
      owner: 'some-owner',
      site: 'some-site',
      ref: 'main',
    },
  };
  let context;
  let slackClient;
  let ackMock;
  let respondMock;
  let site;
  let siteCandidate;
  let clock;

  beforeEach(async () => {
    clock = sinon.useFakeTimers();

    slackClient = {
      postMessage: sinon.mock().resolves({ channelId: 'channel-id', threadId: 'thread-ts' }),
    };

    context = {
      dataAccess: {
        KeyEvent: {
          create: sinon.stub(),
        },
        SiteCandidate: {
          findByBaseURL: sinon.stub(),
        },
        Site: {
          create: sinon.stub(),
          findByBaseURL: sinon.stub(),
        },
      },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
      env: {
        SLACK_REPORT_CHANNEL_INTERNAL: 'channel-id',
        ORGANIZATION_ID_FRIENDS_FAMILY: 'friends-family-org',
      },
      slackClients: {
        WORKSPACE_INTERNAL_STANDARD: slackClient,
      },
      orgDetectorAgent: {
        detect: sinon.stub(),
      },
    };

    site = {
      getId: () => 'some-site-id',
      getBaseURL: () => baseURL,
      getIsLive: () => true,
      save: sinon.stub(),
    };

    siteCandidate = {
      getBaseURL: () => baseURL,
      getHlxConfig: () => hlxConfig,
      getSource: () => SiteCandidate.SITE_CANDIDATE_SOURCES.CDN,
      getStatus: () => SiteCandidate.SITE_CANDIDATE_STATUS.PENDING,
      setSiteId: sinon.stub(),
      setStatus: sinon.stub(),
      setUpdatedBy: sinon.stub(),
      save: sinon.stub(),
    };

    ackMock = sinon.stub().resolves();
    respondMock = sinon.stub().resolves();
  });

  afterEach(() => {
    sinon.restore();
    clock.restore();
  });

  it('should approve site candidate, add friends family org and announce site discovery', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    // Call the function under test
    const approveFunction = approveFriendsFamily(context);
    await approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock });

    expect(ackMock.calledOnce).to.be.true;
    expect(context.dataAccess.SiteCandidate.findByBaseURL).to.have.been.calledWithExactly(baseURL);
    expect(context.dataAccess.Site.create.calledOnceWithExactly({
      baseURL,
      hlxConfig,
      isLive: true,
      organizationId: context.env.ORGANIZATION_ID_FRIENDS_FAMILY,
    })).to.be.true;
    expect(respondMock.calledOnceWith(expectedApprovedFnFReply)).to.be.true;
    expect(slackClient.postMessage.calledOnceWith(expectedAnnouncedMessage)).to.be.true;
    expect(context.dataAccess.KeyEvent.create).to.have.been.calledWith({
      name: 'Go Live',
      siteId: site.getId(),
      type: 'STATUS CHANGE',
    });
  });

  it('logs and throws the error again if something goes wrong', async () => {
    ackMock.rejects(new Error('processing error'));

    const approveFunction = approveFriendsFamily(context);

    await expect(
      approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock }),
    ).to.be.rejectedWith('processing error');
    expect;
    expect(context.log.error).to.have.been.calledWith('Error occurred while acknowledging site candidate approval');
  });
});
