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
import esmock from 'esmock';

use(sinonChai);

describe('OnboardCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let parseCSVStub;
  let baseURL;
  let OnboardCommand;
  let imsClientStub;

  beforeEach(async () => {
    const configuration = {
      enableHandlerForSite: sinon.stub(),
      save: sinon.stub().resolves(),
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
        getId: sinon.stub(),
      },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    imsClientStub = {
      getImsOrganizationDetails: sinon.stub(),
    };
    context = {
      dataAccess: dataAccessStub,
      log: console,
      sqs: sqsStub,
      env: {
        AUDIT_JOBS_QUEUE_URL: 'testQueueUrl',
        token: 'test-token',
      },
      imsClient: imsClientStub,
    };
    slackContext = {
      say: sinon.spy(), files: [], client: { files: [] },
    };
    slackContext.botToken = 'test-token';

    parseCSVStub = sinon.stub().resolves([]);
    OnboardCommand = await esmock(
      '../../../../src/support/slack/commands/onboard.js',
      {
        '../../../../src/utils/slack/base.js': { parseCSV: parseCSVStub },
      },
    );
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(OnboardCommand);
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

  describe('Single-Site Onboarding', () => {
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
      imsClientStub.getImsOrganizationDetails.resolves({ orgName: 'Mock IMS Org' });
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
      expect(imsClientStub.getImsOrganizationDetails.calledWith('000000000000000000000000@AdobeOrg')).to.be.true;
      expect(dataAccessStub.Organization.create.calledWith({ name: 'Mock IMS Org', imsOrgId: '000000000000000000000000@AdobeOrg' })).to.be.true;
      expect(dataAccessStub.Site.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(dataAccessStub.Site.create).to.have.been.calledWith({
        baseURL: 'https://example.com',
        deliveryType: 'other',
        isLive: false,
        organizationId: '123',
      });
      expect(slackContext.say.calledWith(':white_check_mark: A new organization has been created. Organization ID: 123 Organization name: new-org IMS Org ID: 000000000000000000000000@AdobeOrg.')).to.be.true;
      expect(slackContext.say.calledWith(sinon.match.string)).to.be.true;
    });

    it('warns when an invalid site base URL is provided', async () => {
      const args = ['', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid site base URL')).to.be.true;
    });

    it('warns when an invalid IMS Org ID is provided', async () => {
      const args = ['example.com', ''];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid IMS Org ID')).to.be.true;
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
      imsClientStub.getImsOrganizationDetails.resolves({ orgName: 'Mock IMS Org' });
      dataAccessStub.Organization.create.rejects(new Error('failed to create organization'));

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: failed to create organization')).to.be.true;
      expect(dataAccessStub.Organization.findByImsOrgId.calledWith('000000000000000000000000@AdobeOrg')).to.be.true;
      expect(imsClientStub.getImsOrganizationDetails.calledWith('000000000000000000000000@AdobeOrg')).to.be.true;
      expect(dataAccessStub.Organization.create.calledWith({ name: 'Mock IMS Org', imsOrgId: '000000000000000000000000@AdobeOrg' })).to.be.true;
      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: failed to create organization')).to.be.true;
    });

    it('handles error when a site failed to be added', async () => {
      nock(baseURL).get('/').replyWithError('rainy weather');
      dataAccessStub.Organization.findByImsOrgId.resolves({
        getId: sinon.stub().returns('existing-org-123'),
      });
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.rejects(new Error('failed to add the site'));

      const args = ['example.com', '000000000000000000000000@AdobeOrg'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);
      expect(slackContext.say.calledWithMatch(/:x: \*Errors:\* failed to add the site/)).to.be.true;
    });
  });

  describe('Batch Onboarding from CSV', () => {
    beforeEach(() => {
      slackContext.files = [{ name: 'test.csv', url_private: 'https://mock-csv.com' }];
      slackContext.botToken = 'test-token';
    });

    it('handles batch onboarding with valid CSV', async () => {
      const mockCSVData = [
        ['https://example1.com', '000000000000000000000000@AdobeOrg'],
        ['https://example2.com', '000000000000000000000000@AdobeOrg'],
      ];

      parseCSVStub.withArgs('https://mock-csv.com', 'test-token').resolves(mockCSVData);

      dataAccessStub.Organization.findByImsOrgId.resolves({ organizationId: 'existing-org-123' });
      dataAccessStub.Organization.create.resolves(null);
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.resolves({});

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':gear: Processing CSV file with profile *default*...')).to.be.true;
      expect(parseCSVStub.calledWith(slackContext.files[0], 'test-token')).to.be.true;
      await expect(command.handleExecution(args, slackContext)).to.not.be.rejected;
    });

    it('rejects CSV with invalid data', async () => {
      parseCSVStub.resolves([]);

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No valid rows found in the CSV file. Please check the format.')).to.be.true;
    });

    it('warns when multiple CSV files are uploaded', async () => {
      slackContext.files = [
        { name: 'test1.csv', url_private: 'https://mock-csv.com/1' },
        { name: 'test2.csv', url_private: 'https://mock-csv.com/2' },
      ];

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please upload only *one* CSV file at a time.')).to.be.true;
    });

    it('warns when a non-CSV file is uploaded', async () => {
      slackContext.files = [{ name: 'test.txt', url_private: 'https://mock-file.com' }];

      const args = ['default'];
      const command = OnboardCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: Please upload a *valid* CSV file.')).to.be.true;
    });
  });

  afterEach(() => {
    sinon.restore();
  });
});
