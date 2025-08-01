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
    slackContext = { say: sinon.spy() };
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

    it('updates site with existing Spacecat org if found', async () => {
      const mockSite = {
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      siteStub.findByBaseURL.resolves(mockSite);

      const mockOrg = {
        getId: () => 'existingOrgId',
      };
      organizationStub.findByImsOrgId.resolves(mockOrg);

      const args = ['example.com', 'existingImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(siteStub.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(organizationStub.findByImsOrgId.calledWith('existingImsOrgId')).to.be.true;
      expect(mockSite.setOrganizationId.calledWith('existingOrgId')).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
      expect(slackContext.say.calledWithMatch(/Successfully updated site/)).to.be.true;
    });

    it('creates a new Spacecat org if none is found in DB and IMS org is found via imsClient', async () => {
      const mockSite = {
        setOrganizationId: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      siteStub.findByBaseURL.resolves(mockSite);
      organizationStub.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves({ orgName: 'Mock IMS Org' });

      const mockNewOrg = {
        getId: () => 'newOrgId',
        save: sinon.stub().resolves(),
      };
      organizationStub.create.returns(mockNewOrg);

      const args = ['example.com', 'newImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(siteStub.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(organizationStub.findByImsOrgId.calledWith('newImsOrgId')).to.be.true;
      expect(imsClientStub.getImsOrganizationDetails.calledWith('newImsOrgId')).to.be.true;
      expect(organizationStub.create.calledWith({
        name: 'Mock IMS Org',
        imsOrgId: 'newImsOrgId',
      })).to.be.true;
      expect(mockNewOrg.save.calledOnce).to.be.true;
      expect(mockSite.setOrganizationId.calledWith('newOrgId')).to.be.true;
      expect(mockSite.save.calledOnce).to.be.true;
      expect(slackContext.say.calledWithMatch(/Successfully \*created\* a new Spacecat org/)).to.be.true;
    });

    it('informs user if IMS org cannot be found via imsClient', async () => {
      const mockSite = {};
      siteStub.findByBaseURL.resolves(mockSite);

      organizationStub.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.resolves(undefined);

      const args = ['example.com', 'unknownImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(imsClientStub.getImsOrganizationDetails.calledWith('unknownImsOrgId')).to.be.true;
      expect(slackContext.say.calledWithMatch(/Could not find an IMS org/)).to.be.true;
      expect(organizationStub.create.notCalled).to.be.true;
    });

    it('handles IMS client errors gracefully', async () => {
      const mockSite = {};
      siteStub.findByBaseURL.resolves(mockSite);

      organizationStub.findByImsOrgId.resolves(null);
      imsClientStub.getImsOrganizationDetails.rejects(new Error('Test IMS Error'));

      const args = ['example.com', 'badImsOrgId'];
      await command.handleExecution(args, slackContext);

      expect(imsClientStub.getImsOrganizationDetails.calledWith('badImsOrgId')).to.be.true;
      expect(slackContext.say.calledWithMatch(/Could not find an IMS org with the ID \*badImsOrgId\*/)).to.be.true;
      expect(organizationStub.create.notCalled).to.be.true;
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
