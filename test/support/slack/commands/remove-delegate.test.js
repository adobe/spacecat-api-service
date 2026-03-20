/*
 * Copyright 2025 Adobe. All rights reserved.
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

import RemoveDelegateCommand from '../../../../src/support/slack/commands/remove-delegate.js';

use(sinonChai);

const SITE_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
const ORG_ID = '5f3b3626-029c-476e-924b-0c1bba2e871f';
const TARGET_ORG_ID = '7033554c-de8a-44ac-a356-09b51af8cc28';
const IMS_ORG_ID = 'ABC123@AdobeOrg';

describe('RemoveDelegateCommand', () => {
  let context;
  let slackContext;
  let mockSite;
  let mockDelegateOrg;
  let mockGrant;
  let mockClient;

  beforeEach(() => {
    mockGrant = {
      getId: () => 'grant-id-001',
      getRole: () => 'agency',
      getTargetOrganizationId: () => TARGET_ORG_ID,
      remove: sinon.stub().resolves(),
    };
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://example.com',
    };
    mockDelegateOrg = {
      getId: () => ORG_ID,
      getName: () => 'Delegate Corp',
    };

    mockClient = {
      users: {
        info: sinon.stub().resolves({
          user: { profile: { display_name: 'Test User' } },
        }),
      },
    };

    context = {
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves(mockSite),
          findByBaseURL: sinon.stub().resolves(mockSite),
        },
        Organization: {
          findByImsOrgId: sinon.stub().resolves(mockDelegateOrg),
        },
        SiteImsOrgAccess: {
          findBySiteIdAndOrganizationIdAndProductCode: sinon.stub().resolves(mockGrant),
        },
        AccessGrantLog: {
          create: sinon.stub().resolves({}),
        },
      },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.spy(),
      user: 'U12345',
      client: mockClient,
    };
  });

  describe('Initialization', () => {
    it('initializes with correct base command properties', () => {
      const command = RemoveDelegateCommand(context);
      expect(command.id).to.equal('remove-delegate');
      expect(command.name).to.equal('Remove Delegate');
      expect(command.phrases).to.deep.equal(['remove delegate']);
    });
  });

  describe('handleExecution', () => {
    let command;

    beforeEach(() => {
      command = RemoveDelegateCommand(context);
    });

    it('shows usage when args are missing', async () => {
      await command.handleExecution([], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include('remove delegate');
    });

    it('shows usage when imsOrgId is missing', async () => {
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('shows usage when productCode is missing', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
    });

    it('returns error when site not found by URL', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
      expect(slackContext.say.firstCall.args[0]).to.include('Site not found');
    });

    it('resolves site by UUID', async () => {
      await command.handleExecution([SITE_ID, IMS_ORG_ID, 'LLMO'], slackContext);
      expect(context.dataAccess.Site.findById).to.have.been.calledWith(SITE_ID);
    });

    it('returns error when delegate org not found', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
      expect(slackContext.say.firstCall.args[0]).to.include('Organization not found');
    });

    it('returns error when grant not found', async () => {
      const { SiteImsOrgAccess } = context.dataAccess;
      SiteImsOrgAccess.findBySiteIdAndOrganizationIdAndProductCode.resolves(null);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
      expect(slackContext.say.firstCall.args[0]).to.include('No delegate grant found');
    });

    it('revokes grant and posts success message', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(mockGrant.remove).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
      expect(slackContext.say.firstCall.args[0]).to.include('Delegate access revoked');
    });

    it('uses slack:userId for performedBy (audit), display name in message', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(mockClient.users.info).to.have.been.calledWith({ user: 'U12345' });
      // audit field uses raw userId
      const logArgs = context.dataAccess.AccessGrantLog.create.firstCall.args[0];
      expect(logArgs.performedBy).to.equal('slack:U12345');
      // message shows resolved display name
      expect(slackContext.say.firstCall.args[0]).to.include('Test User');
      expect(slackContext.say.firstCall.args[0]).to.not.include('slack:Test User');
    });

    it('falls back to real_name in message when display_name absent', async () => {
      mockClient.users.info.resolves({ user: { profile: { real_name: 'Real Name' } } });
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include('Real Name');
    });

    it('falls back to user.name in message when profile names absent', async () => {
      mockClient.users.info.resolves({ user: { name: 'username', profile: {} } });
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include('username');
    });

    it('falls back to userId in message when client.users.info throws', async () => {
      mockClient.users.info.rejects(new Error('API error'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include('U12345');
    });

    it('falls back to userId in message when client is missing', async () => {
      slackContext.client = null;
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include('U12345');
    });

    it('falls back to userId in message when API returns no usable name fields', async () => {
      mockClient.users.info.resolves({ user: { profile: {} } });
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include('U12345');
    });

    it('falls back to imsOrgId in success message when org has no name', async () => {
      mockDelegateOrg.getName = () => null;
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(IMS_ORG_ID);
    });

    it('writes AccessGrantLog with all required fields before removing', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(context.dataAccess.AccessGrantLog.create).to.have.been.calledOnce;
      const logArgs = context.dataAccess.AccessGrantLog.create.firstCall.args[0];
      expect(logArgs.action).to.equal('revoke');
      expect(logArgs.role).to.equal('agency');
      expect(logArgs.targetOrganizationId).to.equal(TARGET_ORG_ID);
      expect(logArgs.performedBy).to.equal('slack:U12345');
    });

    it('logs error when AccessGrantLog.create fails', async () => {
      context.dataAccess.AccessGrantLog.create.rejects(new Error('log fail'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(mockGrant.remove).to.have.been.calledOnce;
      expect(context.log.error).to.have.been.called;
    });

    it('skips AccessGrantLog when not available', async () => {
      context.dataAccess.AccessGrantLog = null;
      const cmd = RemoveDelegateCommand(context);
      await cmd.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(mockGrant.remove).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
    });

    it('calls postErrorMessage on unexpected error', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('DB down'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include('Oops');
    });
  });
});
