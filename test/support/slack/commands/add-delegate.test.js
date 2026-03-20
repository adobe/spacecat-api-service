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

import AddDelegateCommand from '../../../../src/support/slack/commands/add-delegate.js';

use(sinonChai);

const SITE_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
const ORG_ID = '5f3b3626-029c-476e-924b-0c1bba2e871f';
const TARGET_ORG_ID = '7033554c-de8a-44ac-a356-09b51af8cc28';
const IMS_ORG_ID = 'ABC123@AdobeOrg';

describe('AddDelegateCommand', () => {
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
    };
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://example.com',
      getOrganization: sinon.stub().resolves({ getId: () => TARGET_ORG_ID }),
    };
    mockDelegateOrg = {
      getId: () => ORG_ID,
      getName: () => 'Delegate Corp',
      save: sinon.stub().resolves(),
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
          create: sinon.stub().resolves(mockDelegateOrg),
        },
        SiteImsOrgAccess: {
          create: sinon.stub().resolves(mockGrant),
        },
        AccessGrantLog: {
          create: sinon.stub().resolves({}),
        },
      },
      imsClient: {
        getImsOrganizationDetails: sinon.stub().resolves({ orgName: 'Delegate Corp' }),
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
      const command = AddDelegateCommand(context);
      expect(command.id).to.equal('add-delegate');
      expect(command.name).to.equal('Add Delegate');
      expect(command.phrases).to.deep.equal(['add delegate']);
    });
  });

  describe('handleExecution', () => {
    let command;

    beforeEach(() => {
      command = AddDelegateCommand(context);
    });

    it('shows usage when args are missing', async () => {
      await command.handleExecution([], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include('add delegate');
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
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
    });

    it('grants access when delegate org already exists', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(context.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith(IMS_ORG_ID);
      expect(context.dataAccess.Organization.create).not.to.have.been.called;
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
      expect(slackContext.say.firstCall.args[0]).to.include('grant-id-001');
    });

    it('creates delegate org on the fly when not found', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(context.imsClient.getImsOrganizationDetails).to.have.been.calledWith(IMS_ORG_ID);
      expect(context.dataAccess.Organization.create).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
    });

    it('returns error when IMS org lookup fails', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      context.imsClient.getImsOrganizationDetails.rejects(new Error('IMS unavailable'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
    });

    it('returns error when IMS org details are null', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);
      context.imsClient.getImsOrganizationDetails.resolves(null);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
    });

    it('returns error when site has no owning organization', async () => {
      mockSite.getOrganization.resolves(null);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
      expect(slackContext.say.firstCall.args[0]).to.include('no owning organization');
    });

    it('resolves Slack username via client.users.info', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(mockClient.users.info).to.have.been.calledWith({ user: 'U12345' });
      const createArgs = context.dataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('slack:Test User');
    });

    it('falls back to real_name when display_name absent', async () => {
      mockClient.users.info.resolves({ user: { profile: { real_name: 'Real Name' } } });
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      const createArgs = context.dataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('slack:Real Name');
    });

    it('falls back to user.name when profile names absent', async () => {
      mockClient.users.info.resolves({ user: { name: 'username', profile: {} } });
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      const createArgs = context.dataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('slack:username');
    });

    it('falls back to userId when client.users.info throws', async () => {
      mockClient.users.info.rejects(new Error('API error'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      const createArgs = context.dataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('slack:U12345');
    });

    it('falls back to userId when client is missing', async () => {
      slackContext.client = null;
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      const createArgs = context.dataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('slack:U12345');
    });

    it('falls back to userId when API returns no usable name fields', async () => {
      mockClient.users.info.resolves({ user: { profile: {} } });
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      const createArgs = context.dataAccess.SiteImsOrgAccess.create.firstCall.args[0];
      expect(createArgs.grantedBy).to.equal('slack:U12345');
    });

    it('falls back to imsOrgId in success message when org has no name', async () => {
      mockDelegateOrg.getName = () => null;
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(IMS_ORG_ID);
    });

    it('writes AccessGrantLog after creating grant', async () => {
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(context.dataAccess.AccessGrantLog.create).to.have.been.calledOnce;
      const logArgs = context.dataAccess.AccessGrantLog.create.firstCall.args[0];
      expect(logArgs.action).to.equal('grant');
      expect(logArgs.role).to.equal('agency');
    });

    it('does not throw when AccessGrantLog.create fails', async () => {
      context.dataAccess.AccessGrantLog.create.rejects(new Error('log fail'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
    });

    it('skips AccessGrantLog when not available', async () => {
      context.dataAccess.AccessGrantLog = null;
      const cmd = AddDelegateCommand(context);
      await cmd.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':white_check_mark:');
    });

    it('shows info message on 409 conflict', async () => {
      const conflictErr = new Error('Grant already exists');
      conflictErr.status = 409;
      context.dataAccess.SiteImsOrgAccess.create.rejects(conflictErr);
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':information_source:');
    });

    it('calls postErrorMessage on unexpected error', async () => {
      context.dataAccess.SiteImsOrgAccess.create.rejects(new Error('DB down'));
      await command.handleExecution(['https://example.com', IMS_ORG_ID, 'LLMO'], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include('Oops');
    });
  });
});
