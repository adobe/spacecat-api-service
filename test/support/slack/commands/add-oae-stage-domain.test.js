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

describe('AddOaeStageDomainCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let AddOaeStageDomainCommand;
  let toDynamoItemStub;
  let tokowakaClientStub;

  // extractURLFromSlackInput strips www. so 'www.example.com' → 'https://example.com'
  const PROD_SITE_INPUT = 'www.example.com';
  const PROD_SITE_URL = 'https://example.com';
  const PROD_SITE_ID = 'prod-site-id-123';
  const STAGE_DOMAIN = 'staging.otherdomain.com';
  const STAGE_BASE_URL = 'https://staging.otherdomain.com';

  before(async function () {
    this.timeout(30000);

    toDynamoItemStub = sinon.stub().returns({ edgeOptimize: {} });
    tokowakaClientStub = {
      fetchMetaconfig: sinon.stub(),
      createMetaconfig: sinon.stub(),
      updateMetaconfig: sinon.stub(),
    };

    AddOaeStageDomainCommand = await esmock(
      '../../../../src/support/slack/commands/add-oae-stage-domain.js',
      {
        '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
          Config: { toDynamoItem: toDynamoItemStub },
        },
        '@adobe/spacecat-shared-tokowaka-client': {
          default: { createFrom: () => tokowakaClientStub },
          calculateForwardedHost: sinon.stub(),
        },
      },
    );
  });

  beforeEach(() => {
    toDynamoItemStub.reset();
    toDynamoItemStub.returns({ edgeOptimize: {} });
    tokowakaClientStub.fetchMetaconfig.reset();
    tokowakaClientStub.createMetaconfig.reset();
    tokowakaClientStub.updateMetaconfig.reset();

    dataAccessStub = {
      Site: {
        findByBaseURL: sinon.stub(),
        findById: sinon.stub(),
        create: sinon.stub(),
      },
    };

    context = {
      dataAccess: dataAccessStub,
      log: { error: sinon.stub() },
      env: {},
    };

    slackContext = { say: sinon.stub() };
  });

  describe('Initialization', () => {
    it('initializes with correct id, name, and phrases', () => {
      const command = AddOaeStageDomainCommand(context);
      expect(command.id).to.equal('add-oae-stage-domain');
      expect(command.name).to.equal('Add OAE Stage Domain');
      expect(command.phrases).to.deep.equal(['add-oae-stage-domain']);
    });
  });

  describe('handleExecution', () => {
    let mockProdSite;
    let mockStageSite;
    let mockConfig;

    beforeEach(() => {
      mockConfig = {
        getEdgeOptimizeConfig: sinon.stub().returns({}),
        updateEdgeOptimizeConfig: sinon.stub(),
      };

      mockProdSite = {
        getBaseURL: sinon.stub().returns(PROD_SITE_URL),
        getOrganizationId: sinon.stub().returns('org-id-456'),
        getConfig: sinon.stub().returns(mockConfig),
        setConfig: sinon.stub(),
        save: sinon.stub(),
      };

      mockStageSite = {
        getId: sinon.stub().returns('stage-site-id-789'),
        getBaseURL: sinon.stub().returns(STAGE_BASE_URL),
        getOrganizationId: sinon.stub().returns('org-id-456'),
      };
    });

    it('returns usage when site input is missing', async () => {
      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([], slackContext);
      expect(slackContext.say).to.have.been.calledWithMatch(/Usage:/);
    });

    it('returns usage when domains arg is missing', async () => {
      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT], slackContext);
      expect(slackContext.say).to.have.been.calledWithMatch(/Usage:/);
    });

    it('warns when domains arg contains only commas or whitespace', async () => {
      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, ',,,'], slackContext);
      expect(slackContext.say).to.have.been.calledWithMatch(/Please provide at least one staging domain/);
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
    });

    it('warns and returns when extra space-separated args are present', async () => {
      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN, 'stage2.other.com'], slackContext);
      expect(slackContext.say).to.have.been.calledWithMatch(/Too many arguments/);
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
    });

    it('warns and returns when a staging domain is not a valid URL', async () => {
      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, 'notadomain,staging.valid.com'], slackContext);
      expect(slackContext.say).to.have.been.calledWithMatch(/Invalid domain/);
      expect(dataAccessStub.Site.findByBaseURL).to.not.have.been.called;
    });

    it('throws and reports error when stage domain exists under a different org', async () => {
      const foreignStageSite = {
        getId: sinon.stub().returns('foreign-stage-id'),
        getOrganizationId: sinon.stub().returns('different-org-id'),
      };
      dataAccessStub.Site.findByBaseURL.callsFake((url) => {
        if (url === PROD_SITE_URL) {
          return Promise.resolve(mockProdSite);
        }
        if (url === STAGE_BASE_URL) {
          return Promise.resolve(foreignStageSite);
        }
        return Promise.resolve(null);
      });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/different organization/);
      expect(dataAccessStub.Site.create).to.not.have.been.called;
      expect(mockProdSite.save).to.not.have.been.called;
    });

    it('reports site not found when prod site does not exist', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/No site found/);
    });

    it('creates metaconfig for a new stage site when no existing metaconfig', async () => {
      dataAccessStub.Site.findByBaseURL.callsFake((url) => Promise.resolve(
        url === PROD_SITE_URL ? mockProdSite : null,
      ));
      dataAccessStub.Site.create.resolves(mockStageSite);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: ['key1'], domain: STAGE_DOMAIN });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      expect(dataAccessStub.Site.create).to.have.been.calledWith({
        baseURL: STAGE_BASE_URL,
        organizationId: 'org-id-456',
      });
      expect(tokowakaClientStub.createMetaconfig).to.have.been.calledWith(
        STAGE_BASE_URL,
        'stage-site-id-789',
        { tokowakaEnabled: true },
        { lastModifiedBy: 'slack-add-oae-stage-domain', isStageDomain: true },
      );
      expect(mockConfig.updateEdgeOptimizeConfig).to.have.been.calledWith(
        sinon.match({ stagingDomains: sinon.match.array }),
      );
      expect(mockProdSite.save).to.have.been.calledOnce;
      expect(slackContext.say).to.have.been.calledWithMatch(/Successfully onboarded 1 stage domain/);
    });

    it('throws and reports error when createMetaconfig returns no API keys', async () => {
      dataAccessStub.Site.findByBaseURL.callsFake((url) => Promise.resolve(
        url === PROD_SITE_URL ? mockProdSite : null,
      ));
      dataAccessStub.Site.create.resolves(mockStageSite);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: [] });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      expect(context.log.error).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWithMatch(/Failed to provision API key/);
      expect(mockProdSite.save).to.not.have.been.called;
    });

    it('updates metaconfig for an existing stage site with existing metaconfig', async () => {
      const existingMetaconfig = { apiKeys: ['existing-key'] };
      const updatedMetaconfig = { apiKeys: ['existing-key', 'new-key'] };

      dataAccessStub.Site.findByBaseURL.callsFake((url) => {
        if (url === PROD_SITE_URL) {
          return Promise.resolve(mockProdSite);
        }
        if (url === STAGE_BASE_URL) {
          return Promise.resolve(mockStageSite);
        }
        return Promise.resolve(null);
      });
      tokowakaClientStub.fetchMetaconfig
        .onFirstCall().resolves(existingMetaconfig)
        .onSecondCall().resolves(updatedMetaconfig);
      tokowakaClientStub.updateMetaconfig.resolves();

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      expect(dataAccessStub.Site.create).to.not.have.been.called;
      expect(tokowakaClientStub.updateMetaconfig).to.have.been.calledWith(
        STAGE_BASE_URL,
        'stage-site-id-789',
        {},
        { lastModifiedBy: 'slack-add-oae-stage-domain', isStageDomain: true },
      );
      expect(slackContext.say).to.have.been.calledWithMatch(/Successfully onboarded 1 stage domain/);
    });

    it('allows stage domain with a different registered domain than prod (no base-domain check)', async () => {
      // staging.completely-different.io has a different registered domain from example.com —
      // the API would reject this, but the Slack command must allow it.
      const crossDomain = 'staging.completely-different.io';
      const crossBaseURL = 'https://staging.completely-different.io';
      const mockCrossSite = {
        getId: sinon.stub().returns('cross-site-id'),
        getBaseURL: sinon.stub().returns(crossBaseURL),
      };

      dataAccessStub.Site.findByBaseURL.callsFake((url) => Promise.resolve(
        url === PROD_SITE_URL ? mockProdSite : null,
      ));
      dataAccessStub.Site.create.resolves(mockCrossSite);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: ['key1'] });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, crossDomain], slackContext);

      expect(slackContext.say).to.have.been.calledWithMatch(/Successfully onboarded 1 stage domain/);
    });

    it('handles multiple comma-separated staging domains', async () => {
      const secondDomain = 'stage2.otherdomain.com';
      const secondBaseURL = 'https://stage2.otherdomain.com';
      const mockStageSite2 = {
        getId: sinon.stub().returns('stage-site-id-2'),
        getBaseURL: sinon.stub().returns(secondBaseURL),
      };

      dataAccessStub.Site.findByBaseURL.callsFake((url) => Promise.resolve(
        url === PROD_SITE_URL ? mockProdSite : null,
      ));
      dataAccessStub.Site.create
        .onFirstCall().resolves(mockStageSite)
        .onSecondCall().resolves(mockStageSite2);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: ['key1'] });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, `${STAGE_DOMAIN},${secondDomain}`], slackContext);

      expect(dataAccessStub.Site.create).to.have.been.calledTwice;
      expect(slackContext.say).to.have.been.calledWithMatch(/Successfully onboarded 2 stage domain/);
    });

    it('merges new staging domains with existing ones', async () => {
      const existingEntry = { domain: 'existing.example.com', id: 'existing-id' };
      mockConfig.getEdgeOptimizeConfig.returns({
        stagingDomains: [existingEntry],
      });

      dataAccessStub.Site.findByBaseURL.callsFake((url) => Promise.resolve(
        url === PROD_SITE_URL ? mockProdSite : null,
      ));
      dataAccessStub.Site.create.resolves(mockStageSite);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: ['key1'] });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      const updateCall = mockConfig.updateEdgeOptimizeConfig.firstCall.args[0];
      expect(updateCall.stagingDomains).to.have.lengthOf(2);
      expect(updateCall.stagingDomains.map((e) => e.domain)).to.include.members([
        'existing.example.com',
        STAGE_DOMAIN,
      ]);
    });

    it('handles null edgeOptimizeConfig gracefully', async () => {
      mockConfig.getEdgeOptimizeConfig.returns(null);

      dataAccessStub.Site.findByBaseURL.callsFake((url) => Promise.resolve(
        url === PROD_SITE_URL ? mockProdSite : null,
      ));
      dataAccessStub.Site.create.resolves(mockStageSite);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: ['key1'] });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      const updateCall = mockConfig.updateEdgeOptimizeConfig.firstCall.args[0];
      expect(updateCall.stagingDomains).to.have.lengthOf(1);
      expect(slackContext.say).to.have.been.calledWithMatch(/Successfully onboarded 1 stage domain/);
    });

    it('looks up site by ID when input is not a valid URL', async () => {
      dataAccessStub.Site.findById.resolves(mockProdSite);
      dataAccessStub.Site.findByBaseURL.resolves(null);
      dataAccessStub.Site.create.resolves(mockStageSite);
      tokowakaClientStub.fetchMetaconfig.resolves(null);
      tokowakaClientStub.createMetaconfig.resolves({ apiKeys: ['key1'] });

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_ID, STAGE_DOMAIN], slackContext);

      expect(dataAccessStub.Site.findById).to.have.been.calledWith(PROD_SITE_ID);
      expect(slackContext.say).to.have.been.calledWithMatch(/Successfully onboarded/);
    });

    it('handles errors during execution', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('DB connection failed'));

      const command = AddOaeStageDomainCommand(context);
      await command.handleExecution([PROD_SITE_INPUT, STAGE_DOMAIN], slackContext);

      expect(context.log.error).to.have.been.called;
      expect(slackContext.say).to.have.been.calledWithMatch(/Oops! Something went wrong/);
    });
  });
});
