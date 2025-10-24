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

import SetSiteOrganizationCommand from '../../../../src/support/slack/commands/set-ims-org.js';

use(sinonChai);

describe('SetSiteOrganizationCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let siteStub;
  let organizationStub;
  let imsClientStub;

  beforeEach(() => {
    siteStub = {
      findByBaseURL: sinon.stub(),
    };
    organizationStub = {
      findByImsOrgId: sinon.stub(),
      create: sinon.stub(),
    };
    imsClientStub = {
      getImsOrganizationDetails: sinon.stub(),
    };
    dataAccessStub = {
      Site: siteStub,
      Organization: organizationStub,
    };
    context = {
      dataAccess: dataAccessStub,
      imsClient: imsClientStub,
      log: console,
    };
    slackContext = {
      say: sinon.spy(),
      channelId: 'C123456',
      threadTs: '1234567890.123456',
      client: {
        chat: {
          postMessage: sinon.stub().resolves({ ts: '1234567890.123457' }),
          update: sinon.stub().resolves(),
        },
      },
    };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = SetSiteOrganizationCommand(context);
      expect(command.id).to.equal('set-ims-org');
      expect(command.name).to.equal('Set IMS Organization');
      expect(command.description).to.equal('Sets (or creates) a Spacecat org for a site by IMS Org ID.');
      expect(command.phrases).to.deep.equal(['set imsorg']);
    });
  });

  describe('Handle Execution Method', () => {
    let command;

    beforeEach(() => {
      command = SetSiteOrganizationCommand(context);
    });

    it('warns when an invalid site base URL is provided', async () => {
      const args = ['', 'someImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site base URL.')).to.be.true;
      expect(siteStub.findByBaseURL.notCalled).to.be.true;
      expect(organizationStub.findByImsOrgId.notCalled).to.be.true;
    });

    it('warns when IMS Org ID is not provided', async () => {
      const args = ['example.com'];
      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid IMS Org ID.')).to.be.true;
      expect(siteStub.findByBaseURL.notCalled).to.be.true;
      expect(organizationStub.findByImsOrgId.notCalled).to.be.true;
    });

    it('informs user if no site is found with the given base URL', async () => {
      siteStub.findByBaseURL.resolves(null);

      const args = ['example.com', 'someImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(siteStub.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(slackContext.say.called).to.be.true;
    });

    it('shows button to select products when site is found', async () => {
      const mockSite = {
        getId: () => 'site123',
      };
      siteStub.findByBaseURL.resolves(mockSite);

      const args = ['example.com', 'existingImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(siteStub.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(slackContext.client.chat.postMessage.calledOnce).to.be.true;

      const postMessageCall = slackContext.client.chat.postMessage.getCall(0);
      expect(postMessageCall.args[0].channel).to.equal('C123456');
      expect(postMessageCall.args[0].text).to.include('Ready to set IMS Org');
      expect(postMessageCall.args[0].blocks).to.be.an('array');
      expect(postMessageCall.args[0].blocks[1].elements[0].action_id).to.equal('open_set_ims_org_modal');

      // Verify the button updates with the correct messageTs
      expect(slackContext.client.chat.update.calledOnce).to.be.true;
    });

    it('passes correct data in button value including messageTs', async () => {
      const mockSite = {
        getId: () => 'site456',
      };
      siteStub.findByBaseURL.resolves(mockSite);

      const args = ['example.com', 'newImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(siteStub.findByBaseURL.calledWith('https://example.com')).to.be.true;

      // Check the update call contains the correct button value with messageTs
      const updateCall = slackContext.client.chat.update.getCall(0);
      const buttonValue = JSON.parse(updateCall.args[0].blocks[1].elements[0].value);

      expect(buttonValue.baseURL).to.equal('https://example.com');
      expect(buttonValue.imsOrgId).to.equal('newImsOrgId');
      expect(buttonValue.channelId).to.equal('C123456');
      expect(buttonValue.threadTs).to.equal('1234567890.123456');
      expect(buttonValue.messageTs).to.equal('1234567890.123457');
    });

    it('shows button with correct action_id for modal', async () => {
      const mockSite = {
        getId: () => 'site789',
      };
      siteStub.findByBaseURL.resolves(mockSite);

      const args = ['example.com', 'unknownImsOrgId'];
      await command.handleExecution(args, slackContext);

      const updateCall = slackContext.client.chat.update.getCall(0);
      const actionId = updateCall.args[0].blocks[1].elements[0].action_id;

      expect(actionId).to.equal('open_set_ims_org_modal');
      expect(slackContext.client.chat.postMessage.calledOnce).to.be.true;
    });

    it('shows button text "Choose Products & Continue"', async () => {
      const mockSite = {
        getId: () => 'site999',
      };
      siteStub.findByBaseURL.resolves(mockSite);

      const args = ['example.com', 'badImsOrgId'];
      await command.handleExecution(args, slackContext);

      const postMessageCall = slackContext.client.chat.postMessage.getCall(0);
      const buttonText = postMessageCall.args[0].blocks[1].elements[0].text.text;

      expect(buttonText).to.equal('Choose Products & Continue');
    });

    it('handles unknown errors and calls postErrorMessage', async () => {
      const errorStub = sinon.stub(console, 'error');
      siteStub.findByBaseURL.throws(new Error('Test Unknown Error'));

      const args = ['example.com', 'someImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(errorStub.called).to.be.true;
      expect(slackContext.say.calledWithMatch(/Oops! Something went wrong/)).to.be.true;

      errorStub.restore();
    });
  });
});
