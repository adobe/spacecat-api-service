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
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';
import TierClient from '@adobe/spacecat-shared-tier-client';

import EnsureEntitlementSiteCommand from '../../../../src/support/slack/commands/ensure-entitlement-site.js';
import EnsureEntitlementImsOrgCommand from '../../../../src/support/slack/commands/ensure-entitlement-imsorg.js';
import GetEntitlementSiteCommand from '../../../../src/support/slack/commands/get-entitlement-site.js';
import GetEntitlementImsOrgCommand from '../../../../src/support/slack/commands/get-entitlement-imsorg.js';
import RevokeEntitlementSiteCommand from '../../../../src/support/slack/commands/revoke-entitlement-site.js';
import RevokeEntitlementImsOrgCommand from '../../../../src/support/slack/commands/revoke-entitlement-imsorg.js';

use(sinonChai);

describe('Entitlement Slack Commands', () => {
  let context;
  let slackContext;
  let site;
  let organization;
  let tierClientStub;
  let mockEntitlement;
  let mockEnrollment;

  beforeEach(() => {
    site = {
      getId: () => 'site-123',
      getBaseURL: () => 'https://example.com',
    };

    organization = {
      getId: () => 'org-123',
      getName: sinon.stub().returns('Test Org'),
      getImsOrgId: () => 'test-ims-org@AdobeOrg',
    };

    mockEntitlement = {
      getId: () => 'ent-123',
      getTier: () => EntitlementModel.TIERS.FREE_TRIAL,
    };

    mockEnrollment = {
      getId: () => 'enroll-123',
    };

    tierClientStub = {
      createEntitlement: sinon.stub().resolves({
        entitlement: mockEntitlement,
        siteEnrollment: mockEnrollment,
      }),
      checkValidEntitlement: sinon.stub().resolves({
        entitlement: mockEntitlement,
        siteEnrollment: mockEnrollment,
      }),
      revokeSiteEnrollment: sinon.stub().resolves(),
      revokeEntitlement: sinon.stub().resolves(),
    };

    sinon.stub(TierClient, 'createForSite').resolves(tierClientStub);
    sinon.stub(TierClient, 'createForOrg').returns(tierClientStub);

    context = {
      dataAccess: {
        Site: {
          findByBaseURL: sinon.stub().resolves(site),
          findById: sinon.stub().resolves(site),
        },
        Organization: {
          findByImsOrgId: sinon.stub().resolves(organization),
          findById: sinon.stub().resolves(organization),
        },
        SiteEnrollment: {
          allByEntitlementId: sinon.stub().resolves([mockEnrollment]),
        },
      },
      log: { debug: sinon.spy(), error: sinon.spy() },
    };

    slackContext = {
      say: sinon.spy(),
      channelId: 'channel-123',
      threadTs: 'thread-123',
      client: {
        chat: {
          postMessage: sinon.stub().resolves({ ts: 'msg-123' }),
          update: sinon.stub().resolves(),
        },
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('GetEntitlementSiteCommand', () => {
    it('shows entitlement with enrollment', async () => {
      const command = GetEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':mag:'));
      expect(slackContext.say).to.have.been.calledWith(sinon.match('ASO'));
    });

    it('handles site not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);
      const command = GetEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });

    it('does not show entitlement without enrollment', async () => {
      tierClientStub.checkValidEntitlement.resolves({
        entitlement: mockEntitlement,
        siteEnrollment: null,
      });
      const command = GetEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':information_source:'));
    });

    it('shows usage when no URL provided', async () => {
      const command = GetEntitlementSiteCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('handles errors gracefully', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error'));
      const command = GetEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(context.log.error).to.have.been.called;
    });

    it('handles TierClient error gracefully', async () => {
      tierClientStub.checkValidEntitlement.rejects(new Error('Tier error'));
      const command = GetEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(context.log.debug).to.have.been.called;
    });
  });

  describe('GetEntitlementImsOrgCommand', () => {
    it('shows entitlement for organization', async () => {
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':mag:'));
      expect(slackContext.say).to.have.been.calledWith(sinon.match('ASO'));
    });

    it('handles organization not found', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });

    it('shows usage when no IMS Org ID provided', async () => {
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('handles errors gracefully', async () => {
      context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error'));
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(context.log.error).to.have.been.called;
    });

    it('handles TierClient error gracefully', async () => {
      tierClientStub.checkValidEntitlement.rejects(new Error('Tier error'));
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(context.log.debug).to.have.been.called;
    });

    it('shows no entitlements message when none found', async () => {
      tierClientStub.checkValidEntitlement.resolves({ entitlement: null, siteEnrollment: null });
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':information_source:'));
    });

    it('handles null enrollments array gracefully', async () => {
      context.dataAccess.SiteEnrollment.allByEntitlementId.resolves(null);
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.called;
    });

    it('uses IMS Org ID when org name is null', async () => {
      organization.getName.returns(null);
      const command = GetEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.called;
    });
  });

  describe('EnsureEntitlementSiteCommand', () => {
    it('displays button to ensure entitlement', async () => {
      const command = EnsureEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(slackContext.client.chat.update).to.have.been.called;
    });

    it('handles site not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);
      const command = EnsureEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });

    it('shows usage when no URL provided', async () => {
      const command = EnsureEntitlementSiteCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('handles errors gracefully', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error'));
      const command = EnsureEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(context.log.error).to.have.been.called;
    });
  });

  describe('EnsureEntitlementImsOrgCommand', () => {
    it('displays button to ensure entitlement', async () => {
      const command = EnsureEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(slackContext.client.chat.update).to.have.been.called;
    });

    it('handles organization not found', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      const command = EnsureEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });

    it('shows usage when no IMS Org ID provided', async () => {
      const command = EnsureEntitlementImsOrgCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('handles errors gracefully', async () => {
      context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error'));
      const command = EnsureEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(context.log.error).to.have.been.called;
    });

    it('uses IMS Org ID as fallback when organization has no name', async () => {
      organization.getName.returns(null);
      const command = EnsureEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
    });
  });

  describe('RevokeEntitlementSiteCommand', () => {
    it('displays button to revoke entitlement', async () => {
      const command = RevokeEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(slackContext.client.chat.update).to.have.been.called;
    });

    it('handles site not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);
      const command = RevokeEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });

    it('shows usage when no URL provided', async () => {
      const command = RevokeEntitlementSiteCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('handles errors gracefully', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error'));
      const command = RevokeEntitlementSiteCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(context.log.error).to.have.been.called;
    });
  });

  describe('RevokeEntitlementImsOrgCommand', () => {
    it('displays button to revoke entitlement', async () => {
      const command = RevokeEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(slackContext.client.chat.update).to.have.been.called;
    });

    it('handles organization not found', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      const command = RevokeEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });

    it('shows usage when no IMS Org ID provided', async () => {
      const command = RevokeEntitlementImsOrgCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('handles errors gracefully', async () => {
      context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error'));
      const command = RevokeEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(context.log.error).to.have.been.called;
    });

    it('uses IMS Org ID as fallback when organization has no name', async () => {
      organization.getName.returns(null);
      const command = RevokeEntitlementImsOrgCommand(context);
      await command.handleExecution(['test-ims-org@AdobeOrg'], slackContext);

      expect(slackContext.client.chat.postMessage).to.have.been.called;
    });
  });
});
