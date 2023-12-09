/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { expect } from 'chai';
import sinon from 'sinon';

import AddSiteCommand from '../../../../src/support/slack/commands/add-site.js';

describe('AddSiteCommand', () => {
  let context;
  let say;
  let dataAccessStub;
  let sqsStub;

  beforeEach(() => {
    dataAccessStub = {
      getSiteByBaseURL: sinon.stub(),
      addSite: sinon.stub(),
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = { dataAccess: dataAccessStub, sqs: sqsStub, env: { AUDIT_JOBS_QUEUE_URL: 'testQueueUrl' } };
    say = sinon.stub();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = AddSiteCommand(context);
      expect(command.id).to.equal('add-site');
      expect(command.name).to.equal('Add Site');
      expect(command.description).to.equal('Adds a new site to track.');
      expect(command.phrases).to.deep.equal(['add site']);
    });
  });

  describe('Handle Execution Method', () => {
    it('handles valid input and adds a new site', async () => {
      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves({ getId: () => '123' });

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, say);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('example.com')).to.be.true;
      expect(dataAccessStub.addSite.calledOnce).to.be.true;
      expect(say.calledWith(sinon.match.string)).to.be.true;
    });

    it('warns when an invalid site domain is provided', async () => {
      const args = [''];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, say);

      expect(say.calledWith(':warning: Please provide a valid site domain.')).to.be.true;
    });

    it('informs when the site is already added', async () => {
      dataAccessStub.getSiteByBaseURL.resolves({});

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, say);

      expect(say.calledWith(":x: 'example.com' was already added before. You can run _@spacecat get site example.com_")).to.be.true;
    });

    it('handles error during site addition', async () => {
      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves(null);

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, say);

      expect(say.calledWith(':x: Problem adding the site. Please contact the admins.')).to.be.true;
    });

    it('sends an audit message after adding the site', async () => {
      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves({ getId: () => '123' });

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, say);

      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('reports when an error occurs', async () => {
      dataAccessStub.getSiteByBaseURL.rejects(new Error('test error'));

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, say);

      expect(say.calledWith(':nuclear-warning: Oops! Something went wrong: test error')).to.be.true;
    });
  });
});
