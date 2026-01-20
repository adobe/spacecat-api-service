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

  const SITE_URL = 'https://example.com';
  const IMS_ORG_ID = 'test-ims-org@AdobeOrg';

  // Helper to test command execution with expectation
  const testCommandExecution = async (CommandClass, args, expectations) => {
    const command = CommandClass(context);
    await command.handleExecution(args, slackContext);
    expectations();
  };

  // Helper to test entity not found scenarios
  const testEntityNotFound = async (CommandClass, args, setupFn) => {
    setupFn();
    await testCommandExecution(CommandClass, args, () => {
      expect(slackContext.say).to.have.been.calledWith(sinon.match(':x:'));
    });
  };

  // Helper to test usage message scenarios
  const testShowsUsage = async (CommandClass) => {
    await testCommandExecution(CommandClass, [], () => {
      expect(slackContext.say).to.have.been.calledOnce;
    });
  };

  // Helper to test error handling scenarios
  const testErrorHandling = async (CommandClass, args, setupFn, logMethod = 'error') => {
    setupFn();
    await testCommandExecution(CommandClass, args, () => {
      expect(context.log[logMethod]).to.have.been.called;
    });
  };

  // Helper to test button display scenarios
  const testDisplaysButton = async (CommandClass, args) => {
    await testCommandExecution(CommandClass, args, () => {
      expect(slackContext.client.chat.postMessage).to.have.been.called;
      expect(slackContext.client.chat.update).to.have.been.called;
    });
  };

  beforeEach(() => {
    site = {
      getId: () => 'site-123',
      getBaseURL: () => SITE_URL,
    };

    organization = {
      getId: () => 'org-123',
      getName: sinon.stub().returns('Test Org'),
      getImsOrgId: () => IMS_ORG_ID,
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
      await testCommandExecution(GetEntitlementSiteCommand, [SITE_URL], () => {
        expect(slackContext.say).to.have.been.calledWith(sinon.match(':mag:'));
        expect(slackContext.say).to.have.been.calledWith(sinon.match('ASO'));
      });
    });

    it('handles site not found', () => testEntityNotFound(
      GetEntitlementSiteCommand,
      [SITE_URL],
      () => { context.dataAccess.Site.findByBaseURL.resolves(null); },
    ));

    it('does not show entitlement without enrollment', async () => {
      tierClientStub.checkValidEntitlement.resolves({
        entitlement: mockEntitlement,
        siteEnrollment: null,
      });
      await testCommandExecution(GetEntitlementSiteCommand, [SITE_URL], () => {
        expect(slackContext.say).to.have.been.calledWith(sinon.match(':information_source:'));
      });
    });

    it('shows usage when no URL provided', () => testShowsUsage(GetEntitlementSiteCommand));

    it('handles errors gracefully', () => testErrorHandling(
      GetEntitlementSiteCommand,
      [SITE_URL],
      () => { context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error')); },
    ));

    it('handles TierClient error gracefully', () => testErrorHandling(
      GetEntitlementSiteCommand,
      [SITE_URL],
      () => { tierClientStub.checkValidEntitlement.rejects(new Error('Tier error')); },
      'debug',
    ));
  });

  describe('GetEntitlementImsOrgCommand', () => {
    it('shows entitlement for organization', async () => {
      await testCommandExecution(GetEntitlementImsOrgCommand, [IMS_ORG_ID], () => {
        expect(slackContext.say).to.have.been.calledWith(sinon.match(':mag:'));
        expect(slackContext.say).to.have.been.calledWith(sinon.match('ASO'));
      });
    });

    it('handles organization not found', () => testEntityNotFound(
      GetEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { context.dataAccess.Organization.findByImsOrgId.resolves(null); },
    ));

    it('shows usage when no IMS Org ID provided', () => testShowsUsage(GetEntitlementImsOrgCommand));

    it('handles errors gracefully', () => testErrorHandling(
      GetEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error')); },
    ));

    it('handles TierClient error gracefully', () => testErrorHandling(
      GetEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { tierClientStub.checkValidEntitlement.rejects(new Error('Tier error')); },
      'debug',
    ));

    it('shows no entitlements message when none found', async () => {
      tierClientStub.checkValidEntitlement.resolves({ entitlement: null, siteEnrollment: null });
      await testCommandExecution(GetEntitlementImsOrgCommand, [IMS_ORG_ID], () => {
        expect(slackContext.say).to.have.been.calledWith(sinon.match(':information_source:'));
      });
    });

    it('handles null enrollments array gracefully', async () => {
      context.dataAccess.SiteEnrollment.allByEntitlementId.resolves(null);
      await testCommandExecution(GetEntitlementImsOrgCommand, [IMS_ORG_ID], () => {
        expect(slackContext.say).to.have.been.called;
      });
    });

    it('uses IMS Org ID when org name is null', async () => {
      organization.getName.returns(null);
      await testCommandExecution(GetEntitlementImsOrgCommand, [IMS_ORG_ID], () => {
        expect(slackContext.say).to.have.been.called;
      });
    });
  });

  describe('EnsureEntitlementSiteCommand', () => {
    it('displays button to ensure entitlement', () => testDisplaysButton(
      EnsureEntitlementSiteCommand,
      [SITE_URL],
    ));

    it('handles site not found', () => testEntityNotFound(
      EnsureEntitlementSiteCommand,
      [SITE_URL],
      () => { context.dataAccess.Site.findByBaseURL.resolves(null); },
    ));

    it('shows usage when no URL provided', () => testShowsUsage(EnsureEntitlementSiteCommand));

    it('handles errors gracefully', () => testErrorHandling(
      EnsureEntitlementSiteCommand,
      [SITE_URL],
      () => { context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error')); },
    ));
  });

  describe('EnsureEntitlementImsOrgCommand', () => {
    it('displays button to ensure entitlement', () => testDisplaysButton(
      EnsureEntitlementImsOrgCommand,
      [IMS_ORG_ID],
    ));

    it('handles organization not found', () => testEntityNotFound(
      EnsureEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { context.dataAccess.Organization.findByImsOrgId.resolves(null); },
    ));

    it('shows usage when no IMS Org ID provided', () => testShowsUsage(EnsureEntitlementImsOrgCommand));

    it('handles errors gracefully', () => testErrorHandling(
      EnsureEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error')); },
    ));

    it('uses IMS Org ID as fallback when organization has no name', async () => {
      organization.getName.returns(null);
      await testDisplaysButton(EnsureEntitlementImsOrgCommand, [IMS_ORG_ID]);
    });
  });

  describe('RevokeEntitlementSiteCommand', () => {
    it('displays button to revoke entitlement', () => testDisplaysButton(
      RevokeEntitlementSiteCommand,
      [SITE_URL],
    ));

    it('handles site not found', () => testEntityNotFound(
      RevokeEntitlementSiteCommand,
      [SITE_URL],
      () => { context.dataAccess.Site.findByBaseURL.resolves(null); },
    ));

    it('shows usage when no URL provided', () => testShowsUsage(RevokeEntitlementSiteCommand));

    it('handles errors gracefully', () => testErrorHandling(
      RevokeEntitlementSiteCommand,
      [SITE_URL],
      () => { context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error')); },
    ));
  });

  describe('RevokeEntitlementImsOrgCommand', () => {
    it('displays button to revoke entitlement', () => testDisplaysButton(
      RevokeEntitlementImsOrgCommand,
      [IMS_ORG_ID],
    ));

    it('handles organization not found', () => testEntityNotFound(
      RevokeEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { context.dataAccess.Organization.findByImsOrgId.resolves(null); },
    ));

    it('shows usage when no IMS Org ID provided', () => testShowsUsage(RevokeEntitlementImsOrgCommand));

    it('handles errors gracefully', () => testErrorHandling(
      RevokeEntitlementImsOrgCommand,
      [IMS_ORG_ID],
      () => { context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error')); },
    ));

    it('uses IMS Org ID as fallback when organization has no name', async () => {
      organization.getName.returns(null);
      await testDisplaysButton(RevokeEntitlementImsOrgCommand, [IMS_ORG_ID]);
    });
  });
});
