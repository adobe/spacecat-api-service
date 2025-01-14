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
import approveSiteCandidate from '../../../../src/support/slack/actions/approve-site-candidate.js';
import {
  expectedAnnouncedMessage,
  expectedApprovedReply,
  slackActionResponse,
  slackFriendsFamilyResponse,
} from './slack-fixtures.js';

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
      postMessage: sinon.stub().resolves({ channelId: 'channel-id', threadId: 'thread-ts' }),
    };

    context = {
      dataAccess: {
        KeyEvent: {
          create: sinon.stub(),
        },
        Site: {
          create: sinon.stub(),
          findByBaseURL: sinon.stub(),
        },
        SiteCandidate: {
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
        DEFAULT_ORGANIZATION_ID: 'default',
      },
      slackClients: {
        WORKSPACE_INTERNAL_STANDARD: slackClient,
      },
      // If your updated code uses OrgDetectorAgent.fromContext:
      // we can mock it similarly to how we do with other agents/clients
      orgDetectorAgent: {
        detect: sinon.stub(),
      },
    };

    site = {
      getId: () => 'some-site-id',
      getBaseURL: () => baseURL,
      getIsLive: () => true,
      setDeliveryType: sinon.stub(),
      setHlxConfig: sinon.stub(),
      toggleLive: sinon.stub(),
      save: sinon.stub(),
    };

    siteCandidate = {
      getBaseURL: () => baseURL,
      getSource: () => SiteCandidate.SITE_CANDIDATE_SOURCES.CDN,
      getStatus: () => SiteCandidate.SITE_CANDIDATE_STATUS.PENDING,
      getHlxConfig: () => hlxConfig,
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

  it('should approve site candidate (customer) and announce site discovery', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    // Call the function under test
    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.SiteCandidate.findByBaseURL).to.have.been.calledWith(baseURL);
    expect(context.dataAccess.Site.create).to.have.been.calledWith(
      {
        baseURL,
        hlxConfig,
        isLive: true,
        organizationId: 'default',
      },
    );
    expect(site.save.callCount).to.equal(0);
    expect(siteCandidate.setStatus).to.have.been.calledWith('APPROVED');
    expect(siteCandidate.setUpdatedBy).to.have.been.calledWith('approvers-username');
    expect(siteCandidate.save).to.have.been.calledOnce;
    expect(context.dataAccess.KeyEvent.create).to.have.been.called;
    expect(respondMock).to.have.been.calledWith(expectedApprovedReply);
    expect(slackClient.postMessage).to.have.been.calledWith(expectedAnnouncedMessage);
  });

  it('should approve site candidate as friends & family', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock });

    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.Site.create).to.have.been.calledWith(
      {
        baseURL,
        hlxConfig,
        isLive: true,
        organizationId: 'friends-family-org',
      },
    );
    expect(siteCandidate.setStatus).to.have.been.calledWith('APPROVED');
    expect(siteCandidate.setUpdatedBy).to.have.been.calledWith('approvers-username');
    expect(siteCandidate.save).to.have.been.calledOnce;
    expect(respondMock).to.have.been.called; // with appropriate FnF message
  });

  it('should approve previously added non-live site, set aem_edge, then announce', async () => {
    site.getIsLive = () => false;
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(site);
    site.save.resolves(site);

    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    expect(site.toggleLive).to.have.been.calledOnce;
    expect(site.setDeliveryType).to.have.been.calledWith('aem_edge');
    expect(site.setHlxConfig).to.have.been.calledWith(hlxConfig);
    expect(site.save).to.have.been.calledOnce;
    expect(context.dataAccess.KeyEvent.create).to.have.been.called;
    expect(slackClient.postMessage).to.have.been.called; // the announcement
  });

  it('should detect an org if it is not FnF and post a thread message with "approveOrg"/"rejectOrg" buttons', async () => {
    context.orgDetectorAgent.detect.resolves({
      name: 'Some Company',
      imsOrgId: 'Company@AdobeOrg',
    });

    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    expect(context.orgDetectorAgent.detect).to.have.been.calledWith('spacecat.com', 'some-owner');

    expect(slackClient.postMessage).to.have.been.calledTwice;
    const orgDetectionMsg = slackClient.postMessage.secondCall.args[0];
    expect(orgDetectionMsg.blocks[0].text.text).to.contain('Detected IMS organization `Some Company`');
    expect(orgDetectionMsg.blocks[1].text.text).to.contain('Would you approve? @approvers-username');
    expect(orgDetectionMsg.blocks[2].elements.length).to.equal(2);
    expect(orgDetectionMsg.blocks[2].elements[0].action_id).to.equal('approveOrg');
    expect(orgDetectionMsg.blocks[2].elements[1].action_id).to.equal('rejectOrg');
  });

  it('should not post org detection prompt if no org is detected or if it is FnF', async () => {
    // Scenario A: No org detected
    context.orgDetectorAgent.detect.resolves({}); // empty object
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    // postMessage call for site announcement
    expect(slackClient.postMessage).to.have.been.calledOnce;

    sinon.restore();

    clock = sinon.useFakeTimers();
    slackClient.postMessage = sinon.stub().resolves();
    context.orgDetectorAgent.detect = sinon.stub().resolves({
      name: 'Some Company',
      imsOrgId: 'Company@AdobeOrg',
    });
    const approveFnF = approveSiteCandidate(context);
    await approveFnF({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock });

    expect(slackClient.postMessage).to.have.been.calledOnce;
  });

  it('logs and throws the error again if something goes wrong', async () => {
    ackMock.rejects(new Error('processing error'));
    const approveFunction = approveSiteCandidate(context);

    await expect(
      approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock }),
    ).to.be.rejectedWith('processing error');

    expect(context.log.error).to.have.been.calledWith('Error occurred while acknowledging site candidate approval');
  });
});
