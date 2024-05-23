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

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { createSite } from '@adobe/spacecat-shared-data-access/src/models/site.js';
import { createSiteCandidate, SITE_CANDIDATE_STATUS, SITE_CANDIDATE_SOURCES } from '@adobe/spacecat-shared-data-access/src/models/site-candidate.js';
import approveFriendsFamily from '../../../../src/support/slack/actions/approve-friends-family.js';
import { expectedAnnouncedMessage, expectedApprovedFnFReply, slackFriendsFamilyResponse } from './slack-fixtures.js';

chai.use(chaiAsPromised);
chai.use(sinonChai);
const { expect } = chai;

describe('approveSiteCandidate', () => {
  const baseURL = 'https://spacecat.com';
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
      postMessage: sinon.mock(),
    };

    context = {
      dataAccess: {
        createKeyEvent: sinon.stub(),
        getSiteCandidateByBaseURL: sinon.stub(),
        getSiteByBaseURL: sinon.stub(),
        addSite: sinon.stub(),
        updateSiteCandidate: sinon.stub(),
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
    };

    site = createSite({
      baseURL,
      isLive: true,
    });

    siteCandidate = createSiteCandidate({
      baseURL,
      source: SITE_CANDIDATE_SOURCES.CDN,
      status: SITE_CANDIDATE_STATUS.PENDING,
    });

    ackMock = sinon.stub().resolves();
    respondMock = sinon.stub().resolves();
  });

  afterEach(() => {
    sinon.restore();
    clock.restore();
  });

  it('should approve site candidate, add friends family org and announce site discovery', async () => {
    const expectedSiteCandidate = createSiteCandidate({
      baseURL,
      source: SITE_CANDIDATE_SOURCES.CDN,
      status: SITE_CANDIDATE_STATUS.APPROVED,
      updatedBy: 'approvers-username',
      siteId: site.getId(),
    });

    context.dataAccess.getSiteCandidateByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.getSiteByBaseURL.resolves(null);
    context.dataAccess.addSite.resolves(site);

    // Call the function under test
    const approveFunction = approveFriendsFamily(context);
    await approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock });

    const actualUpdatedSiteCandidate = context.dataAccess.updateSiteCandidate.getCall(0).args[0];

    expect(ackMock.calledOnce).to.be.true;
    expect(context.dataAccess.getSiteCandidateByBaseURL.calledOnceWithExactly(baseURL)).to.be.true;
    expect(context.dataAccess.addSite.calledOnceWithExactly({
      baseURL,
      isLive: true,
      organizationId: context.env.ORGANIZATION_ID_FRIENDS_FAMILY,
    })).to.be.true;
    expect(expectedSiteCandidate.state).to.eql(actualUpdatedSiteCandidate.state);
    expect(respondMock.calledOnceWith(expectedApprovedFnFReply)).to.be.true;
    expect(slackClient.postMessage.calledOnceWith(expectedAnnouncedMessage)).to.be.true;
    expect(context.dataAccess.createKeyEvent).to.have.been.calledWith({
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
