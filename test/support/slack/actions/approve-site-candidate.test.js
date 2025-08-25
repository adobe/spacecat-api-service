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
import approveSiteCandidate, { POLLING_NUM_RETRIES, POLLING_BASE_INTERVAL } from '../../../../src/support/slack/actions/approve-site-candidate.js';
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
  let fetchMock;

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
        MYSTIQUE_API_BASE_URL: 'https://mystique-api.com',
        IGNORED_GITHUB_ORGS: 'ignored-orgs',
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

    fetchMock = sinon.stub(global, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
    clock.restore();
    fetchMock.restore();
  });

  it('should approve site candidate (customer) and announce site discovery', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    // Ensure org detection API call does not wait due to polling
    fetchMock.onFirstCall().resolves({ ok: true, json: async () => ({ uuid: 'job-uuid' }) });
    fetchMock.onSecondCall().resolves({ ok: true, json: async () => ({ status: 'completed', matchedCompany: { name: 'Some Company', imsOrgId: 'Company@AdobeOrg' } }) });

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
    expect(fetchMock).not.to.have.been.called; // FnF should not trigger org detection
  });

  it('should approve previously added non-live site, set aem_edge, then announce', async () => {
    site.getIsLive = () => false;
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(site);
    site.save.resolves(site);

    // Ensure org detection API call does not wait due to polling
    fetchMock.onFirstCall().resolves({ ok: true, json: async () => ({ uuid: 'job-uuid' }) });
    fetchMock.onSecondCall().resolves({ ok: true, json: async () => ({ status: 'completed', matchedCompany: { name: 'Some Company', imsOrgId: 'Company@AdobeOrg' } }) });

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
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    // Ensure org detection API call does not wait due to polling
    fetchMock.onFirstCall().resolves({ ok: true, json: async () => ({ uuid: 'job-uuid' }) });
    fetchMock.onSecondCall().resolves({ ok: true, json: async () => ({ status: 'completed', matchedCompany: { name: 'Some Company', imsOrgId: 'Company@AdobeOrg' } }) });

    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    expect(fetchMock).to.have.been.calledTwice;
    expect(fetchMock.firstCall).to.have.been.calledWith(
      'https://mystique-api.com/v1/org-detector',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: 'spacecat.com',
          githubLogin: 'some-owner',
          ignoredGithubOrgs: 'ignored-orgs',
        }),
      },
    );
    expect(fetchMock.secondCall).to.have.been.calledWith(
      'https://mystique-api.com/v1/org-detector/job-uuid',
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      },
    );

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
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    fetchMock.onFirstCall().resolves({ ok: true, json: async () => ({ uuid: 'job-uuid' }) });
    fetchMock.onSecondCall().resolves({ ok: true, json: async () => ({ status: 'completed', matchedCompany: null }) });

    const approveFunction = approveSiteCandidate(context);
    await approveFunction({ ack: ackMock, body: slackActionResponse, respond: respondMock });

    // postMessage call for site announcement
    expect(slackClient.postMessage).to.have.been.calledOnce;

    // Scenario B: Friends & Family - should not trigger org detection
    sinon.restore();

    clock = sinon.useFakeTimers();
    slackClient.postMessage = sinon.stub().resolves();
    fetchMock = sinon.stub(global, 'fetch');

    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    const approveFnF = approveSiteCandidate(context);
    await approveFnF({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock });

    expect(slackClient.postMessage).to.have.been.calledOnce;
    expect(fetchMock).not.to.have.been.called;
  });

  it('logs and throws the error again if something goes wrong', async () => {
    ackMock.rejects(new Error('processing error'));
    const approveFunction = approveSiteCandidate(context);

    await expect(
      approveFunction({ ack: ackMock, body: slackFriendsFamilyResponse, respond: respondMock }),
    ).to.be.rejectedWith('processing error');

    expect(context.log.error).to.have.been.calledWith('Error occurred while acknowledging site candidate approval');
  });

  it('should throw if org detection start POST request fails', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    fetchMock.onFirstCall().resolves({ ok: false, statusText: 'Bad Request' });

    const approveFunction = approveSiteCandidate(context);
    await expect(
      approveFunction({
        ack: ackMock,
        body: slackActionResponse,
        respond: respondMock,
      }),
    ).to.be.rejectedWith('Failed to start OrgDetectorAgent: Bad Request');
  });

  it('should throw if org detection POST returns invalid response', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    fetchMock.onFirstCall().resolves({ ok: true, json: async () => ({}) });

    const approveFunction = approveSiteCandidate(context);
    const approvePromise = approveFunction({
      ack: ackMock,
      body: slackActionResponse,
      respond: respondMock,
    });
    await expect(approvePromise).to.be.rejectedWith('Invalid response from OrgDetectorAgent start request: missing uuid');
  });

  it('should throw if org detection GET polling exceeds retries', async () => {
    context.dataAccess.SiteCandidate.findByBaseURL.withArgs(baseURL).resolves(siteCandidate);
    context.dataAccess.Site.findByBaseURL.resolves(null);
    context.dataAccess.Site.create.resolves(site);

    fetchMock.onFirstCall().resolves({ ok: true, json: async () => ({ uuid: 'job-uuid' }) });
    for (let i = 1; i <= 11; i += 1) {
      fetchMock.onCall(i).resolves({ ok: true, json: async () => ({ status: 'processing', matchedCompany: null }) });
    }

    const approveFunction = approveSiteCandidate(context);
    const approvePromise = approveFunction({
      ack: ackMock,
      body: slackActionResponse,
      respond: respondMock,
    });

    // Calculate total time for exponential backoff delays
    let totalTime = 0;
    for (let i = 0; i < POLLING_NUM_RETRIES; i += 1) {
      totalTime += (2 ** i) * POLLING_BASE_INTERVAL;
    }

    await clock.tickAsync(totalTime);
    await expect(approvePromise).to.be.rejectedWith('Polling for OrgDetectorAgent job job-uuid exceeded maximum retries (8)');
  });
});
