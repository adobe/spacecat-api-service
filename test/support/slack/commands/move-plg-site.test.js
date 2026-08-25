/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('MovePlgSiteCommand', () => {
  let context;
  let slackContext;
  let siteStub;
  let organizationStub;
  let entitlementStub;
  let MovePlgSiteCommand;
  let isInternalOrgStub;

  beforeEach(async () => {
    siteStub = { findByBaseURL: sinon.stub() };
    organizationStub = { findByImsOrgId: sinon.stub(), findById: sinon.stub() };
    entitlementStub = { allByOrganizationId: sinon.stub().resolves([]) };

    isInternalOrgStub = sinon.stub().returns(false);

    MovePlgSiteCommand = (await esmock('../../../../src/support/slack/commands/move-plg-site.js', {
      '../../../../src/support/utils.js': { isInternalOrg: isInternalOrgStub },
    })).default;

    context = {
      dataAccess: {
        Site: siteStub,
        Organization: organizationStub,
        Entitlement: entitlementStub,
      },
      log: { error: sinon.spy() },
      env: {},
    };

    slackContext = {
      say: sinon.spy(),
      channelId: 'C123',
      threadTs: '111.222',
      client: {
        chat: {
          postMessage: sinon.stub().resolves({ ts: '111.333' }),
          update: sinon.stub().resolves(),
        },
      },
    };
  });

  const makeSite = (overrides = {}) => ({
    getId: () => 'site-123',
    getOrganizationId: () => 'org-old',
    getSiteEnrollments: sinon.stub().resolves([]),
    ...overrides,
  });

  const makeOrg = (overrides = {}) => ({
    getId: () => 'org-new',
    getName: () => 'Customer Org',
    ...overrides,
  });

  it('initializes with correct base command properties', () => {
    const command = MovePlgSiteCommand(context);
    expect(command.id).to.equal('move-plg-site');
    expect(command.phrases).to.deep.equal(['move plg site']);
  });

  it('warns on invalid base URL', async () => {
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['', 'ims@AdobeOrg'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(':warning: Please provide a valid site base URL.');
  });

  it('warns on missing/invalid IMS org id', async () => {
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', 'not-valid'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(':warning: Please provide a valid target IMS Org ID.');
  });

  it('reports site not found', async () => {
    siteStub.findByBaseURL.resolves(null);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);
    expect(slackContext.say).to.have.been.called;
    expect(organizationStub.findByImsOrgId).to.not.have.been.called;
  });

  it('reports missing target organization', async () => {
    siteStub.findByBaseURL.resolves(makeSite());
    organizationStub.findByImsOrgId.resolves(null);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/No Spacecat organization found/);
  });

  it('rejects when target org is internal', async () => {
    siteStub.findByBaseURL.resolves(makeSite());
    organizationStub.findByImsOrgId.resolves(makeOrg());
    isInternalOrgStub.returns(true);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/Cannot move a PLG site into an internal organization/);
  });

  it('rejects when target org has a PAID entitlement', async () => {
    siteStub.findByBaseURL.resolves(makeSite());
    organizationStub.findByImsOrgId.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PAID' },
    ]);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);
    expect(slackContext.say).to.have.been.calledWithMatch(/Cannot move a PLG site into an organization with a PAID entitlement/);
  });

  it('warns (but does not block) when the site has an active non-ASO enrollment', async () => {
    siteStub.findByBaseURL.resolves(makeSite({
      getSiteEnrollments: sinon.stub().resolves([
        { getEntitlement: sinon.stub().resolves({ getProductCode: () => 'LLMO' }) },
      ]),
    }));
    organizationStub.findByImsOrgId.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);

    expect(slackContext.client.chat.postMessage).to.have.been.calledOnce;
    const postCall = slackContext.client.chat.postMessage.getCall(0);
    expect(postCall.args[0].blocks[0].text.text).to.include('LLMO enrollment(s) — these will be revoked too');
  });

  it('warns about existing ASO enrollments too, not just non-ASO ones', async () => {
    siteStub.findByBaseURL.resolves(makeSite({
      getSiteEnrollments: sinon.stub().resolves([
        { getEntitlement: sinon.stub().resolves({ getProductCode: () => 'ASO' }) },
      ]),
    }));
    organizationStub.findByImsOrgId.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);

    expect(slackContext.client.chat.postMessage).to.have.been.calledOnce;
    const postCall = slackContext.client.chat.postMessage.getCall(0);
    expect(postCall.args[0].blocks[0].text.text).to.include('ASO enrollment(s) — these will be revoked too');
  });

  it('omits the enrollment warning entirely when the site has no enrollments', async () => {
    siteStub.findByBaseURL.resolves(makeSite());
    organizationStub.findByImsOrgId.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);

    const postCall = slackContext.client.chat.postMessage.getCall(0);
    expect(postCall.args[0].blocks[0].text.text).to.not.include('will be revoked too');
  });

  it('posts a confirm button on the happy path (PRE_ONBOARD target)', async () => {
    siteStub.findByBaseURL.resolves(makeSite());
    organizationStub.findByImsOrgId.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);

    expect(slackContext.client.chat.postMessage).to.have.been.calledOnce;
    const postCall = slackContext.client.chat.postMessage.getCall(0);
    expect(postCall.args[0].blocks[1].elements[0].action_id).to.equal('open_move_plg_site_modal');

    expect(slackContext.client.chat.update).to.have.been.calledOnce;
    const updateCall = slackContext.client.chat.update.getCall(0);
    const buttonValue = JSON.parse(updateCall.args[0].blocks[1].elements[0].value);
    expect(buttonValue.siteId).to.equal('site-123');
    expect(buttonValue.organizationId).to.equal('org-new');
    expect(buttonValue.imsOrgId).to.equal('123456789012345678901234@AdobeOrg');
    expect(buttonValue.messageTs).to.equal('111.333');
  });

  it('posts a confirm button on the happy path (FREE_TRIAL target)', async () => {
    siteStub.findByBaseURL.resolves(makeSite());
    organizationStub.findByImsOrgId.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'FREE_TRIAL' },
    ]);
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);

    expect(slackContext.client.chat.postMessage).to.have.been.calledOnce;
    const postCall = slackContext.client.chat.postMessage.getCall(0);
    expect(postCall.args[0].blocks[0].text.text).to.include('FREE_TRIAL');
  });

  it('handles unexpected errors via postErrorMessage', async () => {
    siteStub.findByBaseURL.rejects(new Error('boom'));
    const command = MovePlgSiteCommand(context);
    await command.handleExecution(['example.com', '123456789012345678901234@AdobeOrg'], slackContext);
    expect(context.log.error).to.have.been.called;
    expect(slackContext.say).to.have.been.calledWithMatch(/Oops! Something went wrong/);
  });
});
