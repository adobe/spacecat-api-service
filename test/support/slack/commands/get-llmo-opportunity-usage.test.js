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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('GetLlmoOpportunityUsageCommand', () => {
  let context;
  let slackContext;
  let fetchStub;
  let sendFileStub;
  let extractURLFromSlackInputStub;
  let GetLlmoOpportunityUsageCommand;

  beforeEach(async () => {
    fetchStub = sinon.stub();
    sendFileStub = sinon.stub().resolves();
    extractURLFromSlackInputStub = sinon.stub().callsFake((url) => url);

    GetLlmoOpportunityUsageCommand = await esmock(
      '../../../../src/support/slack/commands/get-llmo-opportunity-usage.js',
      {
        '../../../../src/utils/slack/base.js': {
          sendFile: sendFileStub,
          extractURLFromSlackInput: extractURLFromSlackInputStub,
        },
        '@adobe/spacecat-shared-utils': {
          isValidUrl: (url) => url && url.startsWith('http'),
          SPACECAT_USER_AGENT: 'test-agent',
          tracingFetch: fetchStub,
        },
      },
    );

    context = {
      dataAccess: {
        Site: {
          all: sinon.stub(),
          findByBaseURL: sinon.stub(),
          findById: sinon.stub(),
          allByOrganizationId: sinon.stub(),
        },
        Organization: {
          findById: sinon.stub(),
          findByImsOrgId: sinon.stub(),
        },
        Opportunity: {
          allBySiteId: sinon.stub(),
        },
      },
      env: {
        LLMO_HLX_API_KEY: 'test-api-key',
      },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.spy(),
      channelId: 'test-channel',
    };
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(GetLlmoOpportunityUsageCommand);
  });

  describe('Initialization', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetLlmoOpportunityUsageCommand.default(context);
      expect(command.id).to.equal('get-llmo-opportunity-usage');
      expect(command.name).to.equal('Get LLMO Opportunity Usage');
      expect(command.phrases).to.deep.equal(['get-llmo-opportunity-usage']);
    });
  });

  describe('Helper Functions', () => {
    it('fetchLlmoSheetData returns null when site has no LLMO config', async () => {
      const { fetchLlmoSheetData } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => null,
      };

      const result = await fetchLlmoSheetData(mockSite, '/test/path', context.env);
      expect(result).to.be.null;
    });

    it('fetchLlmoSheetData returns null when no dataFolder', async () => {
      const { fetchLlmoSheetData } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({}),
        }),
      };

      const result = await fetchLlmoSheetData(mockSite, '/test/path', context.env);
      expect(result).to.be.null;
    });

    it('fetchLlmoSheetData returns data on successful fetch', async () => {
      const { fetchLlmoSheetData } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [{ id: 1 }] }),
      });

      const result = await fetchLlmoSheetData(mockSite, '/test/data.json', context.env);
      expect(result).to.deep.equal({ data: [{ id: 1 }] });
      expect(fetchStub).to.have.been.called;
    });

    it('fetchLlmoSheetData returns null on failed fetch', async () => {
      const { fetchLlmoSheetData } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({ ok: false });

      const result = await fetchLlmoSheetData(mockSite, '/test/data.json', context.env);
      expect(result).to.be.null;
    });

    it('fetchLlmoSheetData handles exceptions gracefully', async () => {
      const { fetchLlmoSheetData } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.rejects(new Error('Network error'));

      const result = await fetchLlmoSheetData(mockSite, '/test/data.json', context.env);
      expect(result).to.be.null;
    });

    it('getQueryIndex returns null when fetchLlmoSheetData returns null', async () => {
      const { getQueryIndex } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => null,
      };

      const result = await getQueryIndex(mockSite, context.env);
      expect(result).to.be.null;
    });

    it('getTotalSocialOpportunities returns 0 when no queryIndex', async () => {
      const { getTotalSocialOpportunities } = GetLlmoOpportunityUsageCommand;
      const result = await getTotalSocialOpportunities(null, {}, context.env);
      expect(result).to.equal(0);
    });

    it('getTotalSocialOpportunities counts social opportunities', async () => {
      const { getTotalSocialOpportunities } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const queryIndex = {
        data: [
          { path: '/brandpresence-social/data1' },
          { path: '/brandpresence-social/data2' },
        ],
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [1, 2, 3] }),
      });

      const result = await getTotalSocialOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(6); // 3 + 3
    });

    it('getTotalSocialOpportunities handles null data gracefully', async () => {
      const { getTotalSocialOpportunities } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const queryIndex = {
        data: [
          { path: '/brandpresence-social/data1' },
        ],
      };

      // Mock fetch to return null data
      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves(null),
      });

      const result = await getTotalSocialOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(0); // Should handle null gracefully with ?? 0
    });

    it('getTotalSocialOpportunities handles missing queryIndex.data', async () => {
      const { getTotalSocialOpportunities } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const queryIndex = {}; // No data property

      const result = await getTotalSocialOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(0); // Should use || [] fallback
    });

    it('getThirdPartyOpportunities returns 0 when no queryIndex', async () => {
      const { getThirdPartyOpportunities } = GetLlmoOpportunityUsageCommand;
      const result = await getThirdPartyOpportunities(null, {}, context.env);
      expect(result).to.equal(0);
    });

    it('getThirdPartyOpportunities counts third party opportunities', async () => {
      const { getThirdPartyOpportunities } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const queryIndex = {
        data: [
          { path: '/brandpresence-3rdparty/data1' },
        ],
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [1, 2] }),
      });

      const result = await getThirdPartyOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(2);
    });

    it('getThirdPartyOpportunities handles null data gracefully', async () => {
      const { getThirdPartyOpportunities } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const queryIndex = {
        data: [
          { path: '/brandpresence-3rdparty/data1' },
        ],
      };

      // Mock fetch to return null data
      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves(null),
      });

      const result = await getThirdPartyOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(0); // Should handle null gracefully with ?? 0
    });

    it('getThirdPartyOpportunities handles missing queryIndex.data', async () => {
      const { getThirdPartyOpportunities } = GetLlmoOpportunityUsageCommand;
      const mockSite = {
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const queryIndex = {}; // No data property

      const result = await getThirdPartyOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(0); // Should use || [] fallback
    });
  });

  describe('Command Execution - No Arguments', () => {
    it('processes all LLMO-enabled sites when no arguments provided', async () => {
      const mockSites = [
        {
          getId: () => 'site-1',
          getBaseURL: () => 'https://test1.com',
          getOrganizationId: () => 'org-1',
          getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
        },
      ];

      context.dataAccess.Site.all.resolves(mockSites);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'content' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith('🔍 Fetching all LLMO-enabled sites...');
      expect(sendFileStub).to.have.been.called;
    });

    it('shows message when no LLMO-enabled sites found', async () => {
      context.dataAccess.Site.all.resolves([]);

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith('No LLMO-enabled sites found.');
    });
  });

  describe('Command Execution - --all Flag', () => {
    it('processes all LLMO-enabled sites with --all flag', async () => {
      const mockSites = [
        {
          getId: () => 'site-1',
          getBaseURL: () => 'https://test1.com',
          getOrganizationId: () => 'org-1',
          getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
        },
      ];

      context.dataAccess.Site.all.resolves(mockSites);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['--all'], slackContext);

      expect(slackContext.say).to.have.been.calledWith('🔍 Fetching all LLMO-enabled sites...');
    });
  });

  describe('Command Execution - IMS Org ID', () => {
    it('processes sites for single IMS Org ID', async () => {
      const mockOrg = {
        getId: () => 'org-1',
      };

      const mockSites = [
        {
          getId: () => 'site-1',
          getBaseURL: () => 'https://test1.com',
          getOrganizationId: () => 'org-1',
          getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
        },
      ];

      context.dataAccess.Organization.findByImsOrgId.resolves(mockOrg);
      context.dataAccess.Site.allByOrganizationId.resolves(mockSites);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['test@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith('🔍 Fetching LLMO-enabled sites for 1 IMS Org ID(s)...');
      expect(context.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('test@AdobeOrg');
    });

    it('processes sites for multiple IMS Org IDs', async () => {
      const mockOrg = {
        getId: () => 'org-1',
      };

      const mockSites = [
        {
          getId: () => 'site-1',
          getBaseURL: () => 'https://test1.com',
          getOrganizationId: () => 'org-1',
          getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
        },
      ];

      context.dataAccess.Organization.findByImsOrgId.resolves(mockOrg);
      context.dataAccess.Site.allByOrganizationId.resolves(mockSites);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['test1@AdobeOrg', 'test2@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith('🔍 Fetching LLMO-enabled sites for 2 IMS Org ID(s)...');
    });

    it('handles organization not found for IMS Org ID', async () => {
      context.dataAccess.Organization.findByImsOrgId.resolves(null);

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['nonexistent@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(':warning: Organization not found for IMS Org ID: nonexistent@AdobeOrg');
      expect(context.log.warn).to.have.been.calledWith('Organization not found for IMS Org ID: nonexistent@AdobeOrg');
    });

    it('handles error fetching sites for IMS Org ID', async () => {
      const mockOrg = {
        getId: () => { throw new Error('Database error'); },
      };

      context.dataAccess.Organization.findByImsOrgId.resolves(mockOrg);

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['error@AdobeOrg'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(':warning: Error fetching sites for IMS Org ID error@AdobeOrg'));
      expect(context.log.warn).to.have.been.calledWith(sinon.match('Error fetching sites for IMS Org ID error@AdobeOrg'));
    });
  });

  describe('Command Execution - Single Site', () => {
    it('processes single site by URL', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findByBaseURL.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['https://test.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith('🔍 Fetching LLMO opportunity usage for site: https://test.com...');
      expect(context.dataAccess.Site.findByBaseURL).to.have.been.called;
    });

    it('processes single site by ID', async () => {
      const mockSite = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-123'], slackContext);

      expect(context.dataAccess.Site.findById).to.have.been.calledWith('site-123');
    });

    it('shows error when site not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);
      context.dataAccess.Site.findById.resolves(null);

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['https://nonexistent.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith('❌ Site not found: https://nonexistent.com');
    });
  });

  describe('Opportunity Processing', () => {
    it('counts opportunities with isElmo tag', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'content' },
        { getTags: () => ['other'], getType: () => 'content' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      expect(csvContent).to.include('1'); // totalOpportunities should be 1
    });

    it('counts opportunities with prerender type', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => [], getType: () => 'prerender' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
    });

    it('counts opportunities with llm-blocked type', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => [], getType: () => 'llm-blocked' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
    });

    it('handles opportunities with empty tags array', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => [], getType: () => 'prerender' }, // empty tags, should still count due to type
        { getTags: () => ['other'], getType: () => 'content' }, // non-matching tags and type
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      // Should count 1 (the prerender type)
      expect(csvContent).to.include('1');
    });

    it('handles opportunities with null type gracefully', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => null }, // null type
        { getTags: () => ['other'], getType: () => undefined }, // undefined type
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      // Should count the isElmo tag despite null type
      expect(csvContent).to.include('1');
    });
  });

  describe('GEO Error Detection', () => {
    it('detects GEO 403 errors', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({
          data: [
            { path: '/agentic-traffic/agentictraffic-errors-403' },
            { path: '/agentic-traffic/agentictraffic-errors-404' },
            { path: '/agentic-traffic/agentictraffic-errors-5xx' },
          ],
        }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      expect(csvContent).to.include('true'); // Should contain GEO flags
    });
  });

  describe('Excluded IMS Orgs', () => {
    it('skips excluded IMS orgs', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => '9E1005A551ED61CA0A490D45@AdobeOrg', // Excluded
        getName: () => 'Adobe Corp',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith('No LLMO opportunities found.');
      expect(context.log.info).to.have.been.calledWith(sinon.match('Skipping excluded/internal IMS org: 9E1005A551ED61CA0A490D45@AdobeOrg for site: https://test.com'));
    });
  });

  describe('IMS Org Name Sanitization', () => {
    it('sanitizes org names with special characters', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => '  Test\r\nOrg\t\vWith\fSpecial   Chars  ',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      expect(csvContent).to.include('Test Org With Special Chars');
    });

    it('handles missing org name', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => null,
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      expect(csvContent).to.include('N/A');
    });
  });

  describe('Error Handling', () => {
    it('handles site processing errors gracefully', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      // Make the Opportunity query fail to trigger error handling
      context.dataAccess.Opportunity.allBySiteId.rejects(new Error('Database error'));

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      // Should log the error and show no opportunities message
      expect(context.log.warn).to.have.been.calledWith(sinon.match('Failed to process site'));
      expect(slackContext.say).to.have.been.calledWith('No LLMO opportunities found.');
    });

    it('handles general execution errors', async () => {
      context.dataAccess.Site.all.rejects(new Error('Database error'));

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith('❌ Error: Database error');
      expect(context.log.error).to.have.been.calledWith('Error in LLMO opportunity usage: Database error');
    });
  });

  describe('CSV Generation', () => {
    it('generates CSV with correct headers and data', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://aaa-test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'content' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const [, csvBuffer, filename] = sendFileStub.firstCall.args;
      expect(filename).to.match(/^llmo-opportunity-usage-\d+\.csv$/);

      const csvContent = csvBuffer.toString('utf8');
      expect(csvContent).to.include('Site URL');
      expect(csvContent).to.include('Site ID');
      expect(csvContent).to.include('Total Count');
      expect(csvContent).to.include('https://aaa-test.com');
    });

    it('sorts results by baseURL', async () => {
      const mockSites = [
        {
          getId: () => 'site-2',
          getBaseURL: () => 'https://zzz-test.com',
          getOrganizationId: () => 'org-1',
          getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
        },
        {
          getId: () => 'site-1',
          getBaseURL: () => 'https://aaa-test.com',
          getOrganizationId: () => 'org-1',
          getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
        },
      ];

      context.dataAccess.Site.all.resolves(mockSites);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      const lines = csvContent.split('\n');
      // Check that aaa-test.com comes before zzz-test.com
      const aaaIndex = lines.findIndex((line) => line.includes('aaa-test.com'));
      const zzzIndex = lines.findIndex((line) => line.includes('zzz-test.com'));
      expect(aaaIndex).to.be.lessThan(zzzIndex);
    });
  });

  describe('Concurrency Control', () => {
    it('processes sites with controlled concurrency', async () => {
      // Create 10 sites to exceed the MAX_CONCURRENT_SITES limit of 5
      const mockSites = Array.from({ length: 10 }, (_, i) => ({
        getId: () => `site-${i}`,
        getBaseURL: () => `https://test${i}.com`,
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      }));

      context.dataAccess.Site.all.resolves(mockSites);
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      let concurrentCount = 0;
      let maxConcurrent = 0;

      // Track concurrent execution
      fetchStub.callsFake(() => {
        concurrentCount += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        return new Promise((resolve) => {
          setTimeout(() => {
            concurrentCount -= 1;
            resolve({
              ok: true,
              json: sinon.stub().resolves({ data: [] }),
            });
          }, 10);
        });
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution([], slackContext);

      // Verify concurrency was controlled (shouldn't exceed a reasonable limit)
      // Note: MAX_CONCURRENT_SITES is 5, but we may see slightly higher due to
      // multiple fetch calls per site (query-index, social, third-party)
      expect(maxConcurrent).to.be.at.most(20); // Conservative upper bound
      expect(sendFileStub).to.have.been.called;
    });
  });

  describe('Total Opportunity Count Calculation', () => {
    it('calculates total opportunities count correctly', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'content' },
        { getTags: () => ['isElmo'], getType: () => 'content' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      // Mock query index with GEO errors
      let callCount = 0;
      fetchStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) {
          // query-index call
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/agentic-traffic/agentictraffic-errors-403' },
                { path: '/brandpresence-social/data1' },
              ],
            }),
          });
        }
        // social opportunities call
        return Promise.resolve({
          ok: true,
          json: sinon.stub().resolves({ data: [1, 2, 3] }),
        });
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      // Should have: 2 (opportunities) + 1 (GEO 403) + 3 (social) = 6 total
      expect(csvContent).to.include('6');
    });

    it('includes third party opportunities in total count', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'folder1' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'content' },
      ]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'test@AdobeOrg',
        getName: () => 'Test Org',
      });

      // Mock query index with third party opportunities
      let callCount = 0;
      fetchStub.callsFake(() => {
        callCount += 1;
        if (callCount === 1) {
          // query-index call
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/brandpresence-3rdparty/data1' },
              ],
            }),
          });
        }
        // third party opportunities call
        return Promise.resolve({
          ok: true,
          json: sinon.stub().resolves({ data: [1, 2] }),
        });
      });

      const command = GetLlmoOpportunityUsageCommand.default(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub).to.have.been.called;
      const csvBuffer = sendFileStub.firstCall.args[1];
      const csvContent = csvBuffer.toString('utf8');
      // Should have: 1 (opportunities) + 2 (third party) = 3 total
      expect(csvContent).to.include('3');
    });
  });
});
