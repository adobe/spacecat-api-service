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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('ToggleBrandClaimsCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let postgrestClientStub;
  let getBrandBySiteStub;
  let updateBrandStub;
  let ToggleBrandClaimsCommand;

  const SITE_ID = 'b2c3d4e5-6789-01ab-cdef-2345678901ab';
  const BRAND = { id: 'a1b2c3d4-5678-90ab-cdef-1234567890ab', name: 'Acme', baseUrl: 'https://acme.com' };

  before(async () => {
    getBrandBySiteStub = sinon.stub();
    updateBrandStub = sinon.stub();

    ToggleBrandClaimsCommand = await esmock(
      '../../../../src/support/slack/commands/toggle-brand-claims.js',
      {
        '../../../../src/support/brands-storage.js': {
          getBrandBySite: getBrandBySiteStub,
          updateBrand: updateBrandStub,
        },
      },
    );
  });

  beforeEach(() => {
    getBrandBySiteStub.reset();
    updateBrandStub.reset();

    postgrestClientStub = { from: sinon.stub() };
    const mockSite = {
      getId: sinon.stub().returns(SITE_ID),
      getOrganizationId: sinon.stub().returns('org-1'),
      getBaseURL: sinon.stub().returns('https://acme.com'),
    };
    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub().resolves(mockSite),
        findById: sinon.stub().resolves(mockSite),
      },
      services: { postgrestClient: postgrestClientStub },
    };
    context = { dataAccess: dataAccessStub, log: console };
    slackContext = { say: sinon.spy(), user: 'U123' };
  });

  describe('Initialization', () => {
    it('initializes with base command properties', () => {
      const command = ToggleBrandClaimsCommand(context);
      expect(command.id).to.equal('toggle-brand-claims');
      expect(command.name).to.equal('Toggle Brand Claims');
      expect(command.phrases).to.deep.equal(['brand-claims']);
    });
  });

  describe('Handle Execution', () => {
    it('enables brand claims for the site\'s brand', async () => {
      getBrandBySiteStub.resolves(BRAND);
      updateBrandStub.resolves({ id: BRAND.id });

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'on'], slackContext);

      expect(getBrandBySiteStub).to.have.been.calledWith('org-1', SITE_ID, postgrestClientStub);
      expect(updateBrandStub).to.have.been.calledOnce;
      const updateArgs = updateBrandStub.firstCall.args[0];
      expect(updateArgs.brandId).to.equal(BRAND.id);
      expect(updateArgs.updates).to.deep.equal({ brandClaimsEnabled: true });
      expect(updateArgs.updatedBy).to.equal('slack:U123');
      expect(slackContext.say.calledWithMatch(/Brand claims \*enabled\* for brand "Acme"/)).to.be.true;
    });

    it('disables brand claims for the site\'s brand', async () => {
      getBrandBySiteStub.resolves(BRAND);
      updateBrandStub.resolves({ id: BRAND.id });

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'off'], slackContext);

      const updateArgs = updateBrandStub.firstCall.args[0];
      expect(updateArgs.updates).to.deep.equal({ brandClaimsEnabled: false });
      expect(slackContext.say.calledWithMatch(/Brand claims \*disabled\* for brand "Acme"/)).to.be.true;
    });

    it('resolves the site by ID when the input is not a URL', async () => {
      getBrandBySiteStub.resolves(BRAND);
      updateBrandStub.resolves({ id: BRAND.id });

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution([SITE_ID, 'on'], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith(SITE_ID);
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
      expect(updateBrandStub).to.have.been.calledOnce;
    });

    it('warns when no site input is provided', async () => {
      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWithMatch(/Please provide a valid site base URL or site ID/)).to.be.true;
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('warns when the on/off argument is missing or invalid', async () => {
      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'maybe'], slackContext);

      expect(slackContext.say.calledWithMatch(/Please specify `on` or `off`/)).to.be.true;
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('informs the user when no site is found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['unknownsite.com', 'on'], slackContext);

      expect(slackContext.say.calledWithMatch(/No site found with base URL/)).to.be.true;
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('errors when the postgrest client is unavailable', async () => {
      dataAccessStub.services.postgrestClient = { from: undefined };

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'on'], slackContext);

      expect(slackContext.say.calledWithMatch(/Brand storage is not available/)).to.be.true;
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('warns when the site maps to no active brand', async () => {
      getBrandBySiteStub.resolves(null);

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'on'], slackContext);

      expect(slackContext.say.calledWithMatch(/No active brand is mapped/)).to.be.true;
      expect(updateBrandStub).to.not.have.been.called;
    });

    it('reports when the brand update affects no row', async () => {
      getBrandBySiteStub.resolves(BRAND);
      updateBrandStub.resolves(null);

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'on'], slackContext);

      expect(slackContext.say.calledWithMatch(/Could not update brand "Acme"/)).to.be.true;
    });

    it('falls back to a generic updatedBy when no Slack user is present', async () => {
      getBrandBySiteStub.resolves(BRAND);
      updateBrandStub.resolves({ id: BRAND.id });
      slackContext.user = undefined;

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'on'], slackContext);

      expect(updateBrandStub.firstCall.args[0].updatedBy).to.equal('slack');
    });

    it('handles errors during execution', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test Error'));

      const command = ToggleBrandClaimsCommand(context);
      await command.handleExecution(['acme.com', 'on'], slackContext);

      expect(slackContext.say.calledWithMatch(/Something went wrong: Test Error/)).to.be.true;
    });
  });
});
