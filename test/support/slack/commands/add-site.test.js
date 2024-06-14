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

import chai from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import nock from 'nock';
import { createSite } from '@adobe/spacecat-shared-data-access/src/models/site.js';
import AddSiteCommand from '../../../../src/support/slack/commands/add-site.js';

chai.use(sinonChai);
const { expect } = chai;

const validHelixDom = '<!doctype html><html lang="en"><head></head><body><header></header><main><div></div></main></body></html>';

describe('AddSiteCommand', () => {
  let context;
  let slackContext;
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
    context = {
      dataAccess: dataAccessStub,
      log: console,
      sqs: sqsStub,
      env: { AUDIT_JOBS_QUEUE_URL: 'testQueueUrl' },
    };
    slackContext = { say: sinon.spy() };
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
    beforeEach(() => {
      nock.cleanAll();
    });

    it('handles valid input and adds a new site', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect', message: 'rainy weather' });

      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves(createSite({ baseURL, deliveryType: 'other' }));

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.addSite).to.have.been.calledWith({ baseURL: 'https://example.com', deliveryType: 'other', isLive: false });
      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });

    it('warns when an invalid site base URL is provided', async () => {
      const args = [''];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site base URL.')).to.be.true;
      expect(dataAccessStub.addSite.notCalled).to.be.true;
    });

    it('informs when the site is already added', async () => {
      dataAccessStub.getSiteByBaseURL.resolves({});

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(":x: 'https://example.com' was already added before. You can run _@spacecat get site https://example.com_")).to.be.true;
      expect(dataAccessStub.addSite.notCalled).to.be.true;
    });

    it('handles error during site addition', async () => {
      nock('https://example.com')
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect', message: 'rainy weather' });
      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves(null);

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: Problem adding the site. Please contact the admins.')).to.be.true;
    });

    it('sends an audit message after adding the site', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect', message: 'rainy weather' });
      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves(createSite({ baseURL, deliveryType: 'other' }));

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.addSite).to.have.been.calledWith({ baseURL: 'https://example.com', deliveryType: 'other', isLive: false });
      expect(sqsStub.sendMessage.called).to.be.true;
    });

    it('does not trigger audit after adding site when audits are disabled', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect', message: 'rainy weather' });
      dataAccessStub.getSiteByBaseURL.resolves(null);
      const site = createSite({ baseURL, deliveryType: 'other' });
      dataAccessStub.addSite.resolves(site);

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.addSite).to.have.been.calledWith({ baseURL: 'https://example.com', deliveryType: 'other', isLive: false });
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('does not trigger audit after adding site when audit type is disabled', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect', message: 'rainy weather' });
      dataAccessStub.getSiteByBaseURL.resolves(null);
      const site = createSite({ baseURL, deliveryType: 'other' });
      dataAccessStub.addSite.resolves(site);

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.addSite).to.have.been.calledWith({ baseURL: 'https://example.com', deliveryType: 'other', isLive: false });
      expect(sqsStub.sendMessage.called).to.be.false;
    });

    it('reports when an error occurs', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .replyWithError({ code: 'ECONNREFUSED', syscall: 'connect', message: 'rainy weather' });
      dataAccessStub.getSiteByBaseURL.rejects(new Error('test error'));

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: test error')).to.be.true;
    });

    it('adds an aem_edge site', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .reply(200, validHelixDom);

      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves(createSite({ baseURL, deliveryType: 'aem_edge', isLive: true }));

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.addSite).to.have.been.calledWith({ baseURL: 'https://example.com', deliveryType: 'aem_edge', isLive: true });
      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });

    it('adds an aem_cs site', async () => {
      const baseURL = 'https://example.com';
      nock(baseURL)
        .get('/')
        .times(2)
        .reply(200, '<html><head><link rel="shortcut icon" href="/content/dam/some-company/favicon.ico"></script></head></html>');
      nock(baseURL)
        .get('/index.plain.html')
        .reply(404);

      dataAccessStub.getSiteByBaseURL.resolves(null);
      dataAccessStub.addSite.resolves(createSite({ baseURL, deliveryType: 'aem_cs' }));

      const args = ['example.com'];
      const command = AddSiteCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.getSiteByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.addSite).to.have.been.calledWith({ baseURL: 'https://example.com', deliveryType: 'aem_cs', isLive: false });
      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });
  });
});
