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

import sinon from 'sinon';
import { expect } from 'chai';
import AssignCwvTemplateGroupsCommand from '../../../../src/support/slack/commands/assign-cwv-template-groups.js';

const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
const ERROR_MESSAGE_PREFIX = ':x: ';

describe('AssignCwvTemplateGroups', () => {
  const sandbox = sinon.createSandbox();

  const site = {
    // getId: () => 'site0',
    // getBaseURL: () => 'https://site0.com',
    // getDeliveryType: () => 'aem_edge',
    getConfig: () => ({ test: 'value' }),
  };

  let configurationMock;
  let dataAccessMock;
  let logMock;
  let contextMock;
  let slackContextMock;
  const exceptsAtBadRequest = () => {
    expect(
      configurationMock.save.called,
      'Expected updateConfiguration to not be called, but it was',
    ).to.be.false;
  };

  beforeEach(async () => {
    configurationMock = {
      getVersion: sandbox.stub(),
      getJobs: sandbox.stub(),
      getHandlers: sandbox.stub().returns(),
      getQueues: sandbox.stub(),
      save: sandbox.stub(),
    };

    dataAccessMock = {
      Site: {
        findByBaseURL: sandbox.stub().resolves(),
      },
    };

    logMock = {
      error: sandbox.stub(),
    };

    contextMock = {
      log: logMock,
      dataAccess: dataAccessMock,
      env: {
        SLACK_BOT_TOKEN: 'mock-token',
      },
    };

    slackContextMock = {
      say: sinon.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('Assign Template-Based Page Groups', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = AssignCwvTemplateGroupsCommand(contextMock);
    const args = ['https://site0.com'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.getSiteByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
    expect(
      slackContextMock.say.calledWith(`${SUCCESS_MESSAGE_PREFIX}${JSON.stringify({ test: 'value' }, null, 2)}`),
      'Expected Slack message to be sent confirming "some_audit" was enabled for "https://site0.com", but it was not',
    ).to.be.true;
  });

  it('if site base URL without scheme should be added "https://"', async () => {
    dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(site);

    const command = AssignCwvTemplateGroupsCommand(contextMock);
    const args = ['site0.com'];
    await command.handleExecution(args, slackContextMock);

    expect(
      dataAccessMock.Site.findByBaseURL.calledWith('https://site0.com'),
      'Expected dataAccess.getSiteByBaseURL to be called with "https://site0.com", but it was not',
    ).to.be.true;
  });

  describe('Internal errors', () => {
    it('error during execution', async () => {
      const error = new Error('Test error');
      dataAccessMock.Site.findByBaseURL.rejects(error);

      const command = AssignCwvTemplateGroupsCommand(contextMock);
      const args = ['http://site0.com'];
      await command.handleExecution(args, slackContextMock);

      expect(
        contextMock.log.error.calledWith(error),
        'Expected log.error to be called with the provided error, but it was not',
      ).to.be.true;
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}An error occurred while trying to automatically group pages by URL pattern: Test error.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}An error occurred while trying to automatically group pages by URL pattern: Test error."`,
      ).to.be.true;
    });
  });

  describe('Bad Request Errors', () => {
    it('if "baseURL" is not provided', async () => {
      const command = AssignCwvTemplateGroupsCommand(contextMock);
      const args = [''];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if "baseURL" has wrong site format', async () => {
      const command = AssignCwvTemplateGroupsCommand(contextMock);
      const args = ['wrong_site_format'];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.`),
        `Expected say method to be called with error message "${ERROR_MESSAGE_PREFIX}The site URL is missing or in the wrong format.", but it was not called with that message.`,
      ).to.be.true;
    });

    it('if a site is not found', async () => {
      const baseURL = 'https://site0.com';
      dataAccessMock.Site.findByBaseURL.withArgs('https://site0.com').resolves(null);

      const command = AssignCwvTemplateGroupsCommand(contextMock);
      const args = [baseURL];

      await command.handleExecution(args, slackContextMock);

      exceptsAtBadRequest();
      expect(
        slackContextMock.say.calledWith(`${ERROR_MESSAGE_PREFIX}Site with baseURL "${baseURL}" not found.`),
        'Expected slackContextMock.say to be called with the specified error message, but it was not.',
      ).to.be.true;
    });
  });
});
