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
      postMessage: sinon.mock(),
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
      },
      slackClients: {
        WORKSPACE_INTERNAL_STANDARD: slackClient,
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

  it('should approve site candidate and announce site discovery', async () => {
    const expectedSiteCandidate = {
      baseURL,
      source: SiteCandidate.SITE_CANDIDATE_SOURCES.CDN,
      status: SiteCandidate.SITE_CANDIDATE_STATUS.APPROVED,
      updatedBy: 'approvers-username',
      siteId: site.getId(),
      hlxConfig,
    };

    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    // Call the function under test
    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.SiteCandidate.findByBaseURL).to.have.been.calledWith(baseURL);
    expect(context.dataAccess.Site.create).to.have.been.calledWith(
      { baseURL, hlxConfig, isLive: true },
    );
    expect(site.save).to.have.been.callCount(0);
    expect(siteCandidate.getBaseURL()).to.equal(expectedSiteCandidate.baseURL);
    expect(siteCandidate.getHlxConfig()).to.eql(expectedSiteCandidate.hlxConfig);
    expect(siteCandidate.getSource()).to.equal(expectedSiteCandidate.source);
    expect(siteCandidate.setSiteId).to.have.been.calledWith(expectedSiteCandidate.siteId);
    expect(siteCandidate.setStatus).to.have.been.calledWith(expectedSiteCandidate.status);
    expect(siteCandidate.setUpdatedBy).to.have.been.calledWith(expectedSiteCandidate.updatedBy);
    expect(siteCandidate.save).to.have.been.calledOnce;
    expect(respondMock).to.have.been.calledWith(expectedApprovedReply);
    expect(slackClient.postMessage).to.have.been.calledWith(expectedAnnouncedMessage);
    expect(context.dataAccess.KeyEvent.create).to.have.been.calledWith({
      name: 'Go Live',
      siteId: site.getId(),
      type: 'STATUS CHANGE',
    });
  });

  it('should approve previously added non aem_edge sites then announce the discovery', async () => {
    const expectedSiteCandidate = {
      baseURL,
      source: SiteCandidate.SITE_CANDIDATE_SOURCES.CDN,
      status: SiteCandidate.SITE_CANDIDATE_STATUS.APPROVED,
      updatedBy: 'approvers-username',
      siteId: site.getId(),
      hlxConfig,
    };
    site.getIsLive = () => false;

    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(site);
    site.save.resolves(site);

    // Call the function under test
    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.SiteCandidate.findByBaseURL).to.have.been.calledWith(baseURL);
    expect(context.dataAccess.Site.create).to.not.have.been.called;

    expect(site.save).to.have.been.calledOnce;
    expect(site.toggleLive).to.have.been.calledOnce;
    expect(site.setDeliveryType).to.have.been.calledWith('aem_edge');
    expect(site.setHlxConfig).to.have.been.calledWith(expectedSiteCandidate.hlxConfig);
    expect(respondMock).to.have.been.calledWith(expectedApprovedReply);
    expect(slackClient.postMessage).to.have.been.calledWith(expectedAnnouncedMessage);
    expect(context.dataAccess.KeyEvent.create).to.have.been.calledWith({
      name: 'Go Live',
      siteId: site.getId(),
      type: 'STATUS CHANGE',
    });
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
