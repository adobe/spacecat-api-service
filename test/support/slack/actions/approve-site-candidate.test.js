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
import approveSiteCandidate from '../../../../src/support/slack/actions/approve-site-candidate.js';
import {
  expectedAnnouncedMessage,
  expectedApprovedReply,
  slackActionResponse,
  slackFriendsFamilyResponse,
} from './slack-fixtures.js';

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
        getSiteCandidateByBaseURL: sinon.stub(),
        getSiteByBaseURL: sinon.stub(),
        addSite: sinon.stub(),
        updateSite: sinon.stub(),
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

  it('should approve site candidate and announce site discovery', async () => {
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
    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    const actualUpdatedSiteCandidate = context.dataAccess.updateSiteCandidate.getCall(0).args[0];

    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.getSiteCandidateByBaseURL).to.have.been.calledWith(baseURL);
    expect(context.dataAccess.addSite).to.have.been.calledWith({ baseURL, isLive: true });
    expect(context.dataAccess.updateSite).to.have.been.callCount(0);
    expect(expectedSiteCandidate.state).to.eql(actualUpdatedSiteCandidate.state);
    expect(respondMock).to.have.been.calledWith(expectedApprovedReply);
    expect(slackClient.postMessage).to.have.been.calledWith(expectedAnnouncedMessage);
  });

  it('should approve previously added non aem_edge sites then announce the discovery', async () => {
    const expectedSiteCandidate = createSiteCandidate({
      baseURL,
      source: SITE_CANDIDATE_SOURCES.CDN,
      status: SITE_CANDIDATE_STATUS.APPROVED,
      updatedBy: 'approvers-username',
      siteId: site.getId(),
    });
    site.toggleLive();
    site.updateDeliveryType('aem_cs');

    context.dataAccess.getSiteCandidateByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.getSiteByBaseURL.resolves(site);
    context.dataAccess.updateSite.resolvesArg(0);

    // Call the function under test
    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    const actualUpdatedSiteCandidate = context.dataAccess.updateSiteCandidate.getCall(0).args[0];

    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.getSiteCandidateByBaseURL).to.have.been.calledWith(baseURL);
    expect(context.dataAccess.addSite).to.have.been.callCount(0);

    expect(context.dataAccess.updateSite).to.have.been.calledOnce;
    const updatedSite = context.dataAccess.updateSite.getCalls()[0].args[0];
    expect(updatedSite.isLive()).to.be.true;
    expect(updatedSite.getDeliveryType()).to.equal('aem_edge');
    expect(expectedSiteCandidate.state).to.eql(actualUpdatedSiteCandidate.state);
    expect(respondMock).to.have.been.calledWith(expectedApprovedReply);
    expect(slackClient.postMessage).to.have.been.calledWith(expectedAnnouncedMessage);
  });

  it('logs and throws the error again if something goes wrong', async () => {
    ackMock.rejects(new Error('processing error'));

    const approveFunction = approveSiteCandidate(context);

    await expect(
      approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock }),
    ).to.be.rejectedWith('processing error');
    expect;
    expect(context.log.error).to.have.been.calledWith('Error occurred while acknowledging site candidate approval');
  });
});
