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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import LlmoOnboardCommand from '../../../../src/support/slack/commands/llmo-onboard.js';

use(sinonChai);

describe('LlmoOnboardCommand', () => {
  let command;
  let mockContext;
  let mockLog;
  let mockDataAccess;
  let slackContext;

  beforeEach(() => {
    // Create mock log
    mockLog = {
      info: sinon.stub(),
      error: sinon.stub(),
    };

    // Create mock data access
    mockDataAccess = {
      Site: {
        findByBaseURL: sinon.stub(),
      },
    };

    // Create mock context
    mockContext = {
      log: mockLog,
      dataAccess: mockDataAccess,
    };

    // Create slack context
    slackContext = {
      say: sinon.stub(),
      threadTs: '1234567890.123456',
    };

    command = LlmoOnboardCommand(mockContext);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Command Properties', () => {
    it('should have correct id and phrases', () => {
      expect(command.id).to.equal('onboard-llmo');
      expect(command.phrases).to.deep.equal(['onboard-llmo']);
      expect(command.name).to.equal('Onboard LLMO');
    });

    it('should accept the onboard-llmo phrase', () => {
      expect(command.accepts('onboard-llmo')).to.be.true;
      expect(command.accepts('onboard-llmo https://example.com')).to.be.true;
      expect(command.accepts('other command')).to.be.false;
    });
  });

  describe('Handle Execution Method', () => {
    it('should show IMS org onboarding button when no parameter provided', async () => {
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      const message = slackContext.say.getCall(0).args[0];

      expect(message).to.have.property('blocks');
      expect(message).to.have.property('thread_ts', '1234567890.123456');

      // Check for the section block with org onboarding text
      const sectionBlock = message.blocks.find((block) => block.type === 'section');
      expect(sectionBlock).to.exist;
      expect(sectionBlock.text.text).to.include('LLMO IMS Org Onboarding');
      expect(sectionBlock.text.text).to.include('IMS organization onboarding process');

      // Check for the actions block with the button
      const actionsBlock = message.blocks.find((block) => block.type === 'actions');
      expect(actionsBlock).to.exist;
      expect(actionsBlock.elements).to.have.length(1);

      const button = actionsBlock.elements[0];
      expect(button.type).to.equal('button');
      expect(button.text.text).to.equal('Start Onboarding');
      expect(button.action_id).to.equal('start_llmo_org_onboarding');
      expect(button.value).to.equal('org_onboarding');
      expect(button.style).to.equal('primary');
    });

    it('should show usage when invalid URL provided', async () => {
      await command.handleExecution(['invalid-url'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        'Usage: _onboard-llmo [site url]_',
      );
    });

    it('should show onboarding button for new site URL', async () => {
      // Mock Site.findByBaseURL to return null (site doesn't exist)
      mockDataAccess.Site.findByBaseURL.resolves(null);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      const message = slackContext.say.getCall(0).args[0];

      expect(message).to.have.property('blocks');
      expect(message).to.have.property('thread_ts', '1234567890.123456');

      // Check for the section block with onboarding text
      const sectionBlock = message.blocks.find((block) => block.type === 'section');
      expect(sectionBlock).to.exist;
      expect(sectionBlock.text.text).to.include('LLMO Onboarding');

      // Check for the actions block with the button
      const actionsBlock = message.blocks.find((block) => block.type === 'actions');
      expect(actionsBlock).to.exist;
      expect(actionsBlock.elements).to.have.length(1);

      const button = actionsBlock.elements[0];
      expect(button.type).to.equal('button');
      expect(button.text.text).to.equal('Start Onboarding');
      expect(button.action_id).to.equal('start_llmo_onboarding');
      expect(button.value).to.equal('https://example.com');
      expect(button.style).to.equal('primary');
    });

    it('should show reonboarding options for existing site with LLMO brand', async () => {
      // Mock existing site with LLMO brand
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getOrganizationId: sinon.stub().returns('org123'),
        getConfig: sinon.stub().returns({
          getLlmoBrand: sinon.stub().returns('Test Brand'),
        }),
      };
      mockDataAccess.Site.findByBaseURL.resolves(mockSite);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      const message = slackContext.say.getCall(0).args[0];

      expect(message).to.have.property('blocks');
      expect(message).to.have.property('thread_ts', '1234567890.123456');

      // Check for the section block with reonboarding text
      const sectionBlock = message.blocks.find((block) => block.type === 'section');
      expect(sectionBlock).to.exist;
      expect(sectionBlock.text.text).to.include('Site Already Onboarded');
      expect(sectionBlock.text.text).to.include('Test Brand');

      // Check for the actions block with two buttons
      const actionsBlock = message.blocks.find((block) => block.type === 'actions');
      expect(actionsBlock).to.exist;
      expect(actionsBlock.elements).to.have.length(2);

      const addEntitlementsButton = actionsBlock.elements[0];
      expect(addEntitlementsButton.type).to.equal('button');
      expect(addEntitlementsButton.text.text).to.equal('Add Entitlements');
      expect(addEntitlementsButton.action_id).to.equal('add_entitlements_action');
      expect(addEntitlementsButton.style).to.equal('primary');

      const updateOrgButton = actionsBlock.elements[1];
      expect(updateOrgButton.type).to.equal('button');
      expect(updateOrgButton.text.text).to.equal('Update IMS Org');
      expect(updateOrgButton.action_id).to.equal('update_org_action');

      // Check that button values contain the necessary metadata
      const addEntitlementsValue = JSON.parse(addEntitlementsButton.value);
      expect(addEntitlementsValue.brandURL).to.equal('https://example.com');
      expect(addEntitlementsValue.siteId).to.equal('site123');
      expect(addEntitlementsValue.existingBrand).to.equal('Test Brand');

      const updateOrgValue = JSON.parse(updateOrgButton.value);
      expect(updateOrgValue.brandURL).to.equal('https://example.com');
      expect(updateOrgValue.siteId).to.equal('site123');
      expect(updateOrgValue.currentOrgId).to.equal('org123');
    });

    it('should show onboarding button for existing site without LLMO brand', async () => {
      // Mock existing site without LLMO brand
      const mockSite = {
        getId: sinon.stub().returns('site123'),
        getConfig: sinon.stub().returns({
          getLlmoBrand: sinon.stub().returns(null),
        }),
      };
      mockDataAccess.Site.findByBaseURL.resolves(mockSite);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      const message = slackContext.say.getCall(0).args[0];

      // Check for the section block with onboarding text for existing site
      const sectionBlock = message.blocks.find((block) => block.type === 'section');
      expect(sectionBlock).to.exist;
      expect(sectionBlock.text.text).to.include('LLMO Onboarding');

      // Check for the actions block with the button
      const actionsBlock = message.blocks.find((block) => block.type === 'actions');
      expect(actionsBlock).to.exist;
      expect(actionsBlock.elements).to.have.length(1);

      const button = actionsBlock.elements[0];
      expect(button.type).to.equal('button');
      expect(button.text.text).to.equal('Start Onboarding');
      expect(button.action_id).to.equal('start_llmo_onboarding');
      expect(button.value).to.equal('https://example.com');
      expect(button.style).to.equal('primary');
    });

    it('should handle errors gracefully', async () => {
      const error = new Error('Unexpected error');
      // Mock the say function to reject on the first call (the error case)
      slackContext.say.onFirstCall().rejects(error);

      await command.handleExecution(['https://example.com'], slackContext);

      expect(mockLog.error).to.have.been.calledWith('Error in LLMO onboarding:', error);
    });

    it('should normalize URLs correctly', async () => {
      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledOnce;
      const message = slackContext.say.getCall(0).args[0];
      const button = message.blocks.find((block) => block.type === 'actions').elements[0];
      expect(button.value).to.equal('https://example.com');
    });
  });
});
