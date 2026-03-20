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

import ListDelegatesCommand from '../../../../src/support/slack/commands/list-delegates.js';

use(sinonChai);

const SITE_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
const ORG_ID = '5f3b3626-029c-476e-924b-0c1bba2e871f';
const TARGET_ORG_ID = '7033554c-de8a-44ac-a356-09b51af8cc28';

function makeGrant(overrides = {}) {
  return {
    getId: () => 'grant-id-001',
    getOrganizationId: () => ORG_ID,
    getTargetOrganizationId: () => TARGET_ORG_ID,
    getProductCode: () => 'LLMO',
    getRole: () => 'agency',
    getExpiresAt: () => undefined,
    ...overrides,
  };
}

describe('ListDelegatesCommand', () => {
  let context;
  let slackContext;
  let mockSite;

  beforeEach(() => {
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://example.com',
    };

    context = {
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves(mockSite),
          findByBaseURL: sinon.stub().resolves(mockSite),
        },
        Organization: {
          findById: sinon.stub().resolves({
            getName: () => 'Test Org',
            getImsOrgId: () => 'ABC@AdobeOrg',
          }),
        },
        SiteImsOrgAccess: {
          allBySiteId: sinon.stub().resolves([makeGrant()]),
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
    };
  });

  describe('Initialization', () => {
    it('initializes with correct base command properties', () => {
      const command = ListDelegatesCommand(context);
      expect(command.id).to.equal('list-delegates');
      expect(command.name).to.equal('List Delegates');
      expect(command.phrases).to.deep.equal(['list delegates']);
    });
  });

  describe('handleExecution', () => {
    let command;

    beforeEach(() => {
      command = ListDelegatesCommand(context);
    });

    it('shows usage when no site arg provided', async () => {
      await command.handleExecution([], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include('list delegates');
    });

    it('returns error when site not found by URL', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':x:');
      expect(slackContext.say.firstCall.args[0]).to.include('Site not found');
    });

    it('resolves site by UUID', async () => {
      await command.handleExecution([SITE_ID], slackContext);
      expect(context.dataAccess.Site.findById).to.have.been.calledWith(SITE_ID);
    });

    it('normalizes bare domain (example.com) to https://example.com before lookup', async () => {
      await command.handleExecution(['example.com'], slackContext);
      expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
    });

    it('shows info message when no grants found', async () => {
      context.dataAccess.SiteImsOrgAccess.allBySiteId.resolves([]);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include(':information_source:');
      expect(slackContext.say.firstCall.args[0]).to.include('No delegate grants found');
    });

    it('lists grants with org names resolved', async () => {
      await command.handleExecution(['https://example.com'], slackContext);
      expect(context.dataAccess.Organization.findById).to.have.been.called;
      const msg = slackContext.say.firstCall.args[0];
      expect(msg).to.include(':clipboard:');
      expect(msg).to.include('1 total');
      expect(msg).to.include('LLMO');
    });

    it('falls back to org id when org name is absent', async () => {
      context.dataAccess.Organization.findById.resolves({
        getName: () => '',
        getImsOrgId: () => '',
      });
      await command.handleExecution(['https://example.com'], slackContext);
      const msg = slackContext.say.firstCall.args[0];
      expect(msg).to.include(ORG_ID);
    });

    it('falls back to org id when Organization.findById returns null', async () => {
      context.dataAccess.Organization.findById.resolves(null);
      await command.handleExecution(['https://example.com'], slackContext);
      const msg = slackContext.say.firstCall.args[0];
      expect(msg).to.include(ORG_ID);
    });

    it('handles org lookup error gracefully', async () => {
      context.dataAccess.Organization.findById.rejects(new Error('lookup failed'));
      await command.handleExecution(['https://example.com'], slackContext);
      expect(context.log.warn).to.have.been.called;
      const msg = slackContext.say.firstCall.args[0];
      expect(msg).to.include(':clipboard:');
    });

    it('marks expired grants', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      context.dataAccess.SiteImsOrgAccess.allBySiteId.resolves([
        makeGrant({ getExpiresAt: () => pastDate }),
      ]);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.firstCall.args[0]).to.include('*(expired)*');
    });

    it('does not mark future-expiry grants as expired', async () => {
      const futureDate = new Date(Date.now() + 100_000).toISOString();
      context.dataAccess.SiteImsOrgAccess.allBySiteId.resolves([
        makeGrant({ getExpiresAt: () => futureDate }),
      ]);
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say.firstCall.args[0]).not.to.include('*(expired)*');
    });

    it('calls postErrorMessage on unexpected error', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('DB down'));
      await command.handleExecution(['https://example.com'], slackContext);
      expect(slackContext.say).to.have.been.calledOnce;
      expect(slackContext.say.firstCall.args[0]).to.include('Oops');
    });
  });
});
