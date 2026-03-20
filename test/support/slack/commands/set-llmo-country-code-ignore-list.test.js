/*
 * Copyright 2026 Adobe. All rights reserved.
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
import esmock from 'esmock';

use(sinonChai);

describe('SetLlmoCountryCodeIgnoreListCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let SetLlmoCountryCodeIgnoreListCommand;
  let toDynamoItemStub;

  beforeEach(async () => {
    toDynamoItemStub = sinon.stub().returns({ llmo: { countryCodeIgnoreList: [] } });

    SetLlmoCountryCodeIgnoreListCommand = await esmock(
      '../../../../src/support/slack/commands/set-llmo-country-code-ignore-list.js',
      {
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: toDynamoItemStub },
        },
      },
    );

    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub(),
        findById: sinon.stub(),
      },
    };
    context = { dataAccess: dataAccessStub, log: { error: sinon.stub() } };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization', () => {
    it('initializes correctly with base command properties', () => {
      const command = SetLlmoCountryCodeIgnoreListCommand(context);
      expect(command.id).to.equal('set-llmo-country-code-ignore-list');
      expect(command.name).to.equal('Set LLMO Country Code Ignore List');
      expect(command.phrases).to.deep.equal(['set-country-code-ignore-list']);
    });
  });

  describe('Handle Execution Method', () => {
    it('sets ignore list with valid baseURL and codes', async () => {
      const mockConfig = {
        updateLlmoCountryCodeIgnoreList: sinon.stub(),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution(['example.com', 'PS,AD'], slackContext);

      expect(dataAccessStub.Site.findByBaseURL).to.have.been.calledWith('https://example.com');
      expect(mockConfig.updateLlmoCountryCodeIgnoreList).to.have.been.calledWith(['PS', 'AD']);
      expect(toDynamoItemStub).to.have.been.calledWith(mockConfig);
      expect(mockSite.setConfig).to.have.been.calledOnce;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(slackContext.say).to.have.been.calledWithMatch(/Updated country code ignore list/);
    });

    it('clears ignore list when no codes provided', async () => {
      const mockConfig = {
        updateLlmoCountryCodeIgnoreList: sinon.stub(),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(mockConfig.updateLlmoCountryCodeIgnoreList).to.have.been.calledWith([]);
      expect(slackContext.say).to.have.been.calledWithMatch(/empty — cleared/);
    });

    it('warns when no site input provided', async () => {
      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Please provide a valid site base URL or site ID.');
    });

    it('looks up site by ID when input is not a valid URL', async () => {
      const mockConfig = {
        updateLlmoCountryCodeIgnoreList: sinon.stub(),
      };
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findById.resolves(mockSite);

      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution(['some-site-id', 'PS'], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith('some-site-id');
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
      expect(mockConfig.updateLlmoCountryCodeIgnoreList).to.have.been.calledWith(['PS']);
    });

    it('reports site not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution(['unknownsite.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/No site found/);
    });

    it('rejects codes that are not 2 characters', async () => {
      const mockSite = {
        getBaseURL: sinon.stub().returns('https://example.com'),
        getConfig: sinon.stub(),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };
      dataAccessStub.Site.findByBaseURL.resolves(mockSite);

      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution(['example.com', 'PS,ABC,X'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/Invalid country codes.*ABC, X/);
      expect(mockSite.save).to.not.have.been.called;
    });

    it('handles errors during execution', async () => {
      dataAccessStub.Site.findByBaseURL.throws(new Error('Test Error'));

      const command = SetLlmoCountryCodeIgnoreListCommand(context);

      await command.handleExecution(['example.com', 'PS'], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/Oops! Something went wrong: Test Error/);
    });
  });
});
