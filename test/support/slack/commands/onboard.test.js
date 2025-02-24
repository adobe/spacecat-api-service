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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import nock from 'nock';

import OnboardCommand from '../../../../src/support/slack/commands/onboard.js';

use(sinonChai);

describe('OnboardCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let baseURL;

  beforeEach(() => {
    const configuration = {
      enableHandlerForSite: sinon.stub(),
    };
    baseURL = 'https://example.com';

    dataAccessStub = {
      Configuration: {
        findLatest: sinon.stub().resolves(configuration),
      },
      Site: {
        create: sinon.stub(),
        findByBaseURL: sinon.stub(),
      },
      Organization: {
        create: sinon.stub(),
        findByImsOrgId: sinon.stub(),
      },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: console,
      sqs: sqsStub,
      env: {
        AUDIT_JOBS_QUEUE_URL: 'testQueueUrl',
        DEFAULT_ORGANIZATION_ID: 'default',
      },
    };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = OnboardCommand(context);
      expect(command.id).to.equal('onboard-site');
      expect(command.name).to.equal('Onboard Site(s)');
      expect(command.description).to.equal(
        'Onboards a new site (or batch of sites from CSV) to Success Studio.',
      );
      expect(command.phrases).to.deep.equal(['onboard site', 'onboard sites']);
    });
  });

  describe('Handle Execution Method', () => {
    beforeEach(() => {
      nock.cleanAll();
    });

    it('handles valid input and adds a new site', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');

      const mockOrganization = {
        getId: sinon.stub().returns('123'),
        getName: sinon.stub().returns('new-org'),
      };

      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      dataAccessStub.Organization.create.resolves(mockOrganization);
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.resolves({
        getBaseURL: () => baseURL,
        getDeliveryType: () => 'other',
        getIsLive: () => true,
      });

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.Organization.findByImsOrgId.calledWith('000000000000000000000000@AdobeOrg')).to.be.true;
      expect(dataAccessStub.Organization.create.calledWith(context)).to.be.true;
      expect(dataAccessStub.Site.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        deliveryType: 'other',
        isLive: false,
        organizationId: 'default',
      });
      expect(slackContext.say.calledWith(':white_check_mark: A new organization has been created. Organization ID: 123 Organization name: new-org IMS Org ID: 000000000000000000000000@AdobeOrg.')).to.be.true;
      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });

    it('warns when an invalid site base URL is provided', async () => {
      const args = ['', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid site base URL.')).to.be.true;
    });

    it('warns when an invalid IMS Org ID is provided', async () => {
      const args = ['example.com', ''];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please provide a valid IMS Org ID.')).to.be.true;
    });

    it('does not create a new organization if one already exists for the given IMS Org ID', async () => {
      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.Organization.findByImsOrgId.calledWith('000000000000000000000000@AdobeOrg')).to.be.true;
      expect(dataAccessStub.Organization.create.notCalled).to.be.true;
    });

    it('does not create a site if one already exists', async () => {
      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });
      dataAccessStub.Site.findByBaseURL.resolves({});

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.Site.create.notCalled).to.be.true;
    });

    it('handles error when a new organization failed to be created', async () => {
      dataAccessStub.Organization.findByImsOrgId.resolves(null);
      dataAccessStub.Organization.create.rejects(new Error('failed to create organization'));

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(dataAccessStub.Organization.findByImsOrgId.calledWith('000000000000000000000000@AdobeOrg')).to.be.true;
      expect(dataAccessStub.Organization.create.calledWith(context)).to.be.true;
      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: failed to create organization')).to.be.true;
    });

    it('handles error when a site failed to be added', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');
      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.rejects(new Error('failed to add the site'));

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);
      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: failed to add the site')).to.be.true;
    });
  });
});
