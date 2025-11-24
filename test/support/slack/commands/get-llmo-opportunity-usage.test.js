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
  let sendFileStub;
  let fetchStub;
  let GetLlmoOpportunityUsageCommand;
  let fetchLlmoSheetData;
  let getTotalSocialOpportunities;
  let getThirdPartyOpportunities;
  let getQueryIndex;

  beforeEach(async () => {
    sendFileStub = sinon.stub().resolves();
    fetchStub = sinon.stub();

    const module = await esmock(
      '../../../../src/support/slack/commands/get-llmo-opportunity-usage.js',
      {
        '../../../../src/utils/slack/base.js': {
          sendFile: sendFileStub,
          extractURLFromSlackInput: (url) => url,
        },
        '@adobe/spacecat-shared-utils': {
          isValidUrl: (url) => url && url.startsWith('http'),
          SPACECAT_USER_AGENT: 'TestAgent',
          tracingFetch: fetchStub,
        },
      },
    );

    GetLlmoOpportunityUsageCommand = module.default;
    fetchLlmoSheetData = module.fetchLlmoSheetData;
    getTotalSocialOpportunities = module.getTotalSocialOpportunities;
    getThirdPartyOpportunities = module.getThirdPartyOpportunities;
    getQueryIndex = module.getQueryIndex;

    context = {
      dataAccess: {
        Site: {
          all: sinon.stub(),
          findByBaseURL: sinon.stub(),
          findById: sinon.stub(),
        },
        Organization: { findById: sinon.stub() },
        Opportunity: { allBySiteId: sinon.stub() },
      },
      log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
      env: { LLMO_HLX_API_KEY: 'test-key' },
    };
    slackContext = { say: sinon.spy(), channelId: 'test-channel' };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Command Initialization', () => {
    it('initializes with correct properties', () => {
      const command = GetLlmoOpportunityUsageCommand(context);
      expect(command.id).to.equal('get-llmo-opportunity-usage');
      expect(command.phrases).to.include('get-llmo-opportunity-usage');
    });
  });

  describe('fetchLlmoSheetData', () => {
    it('returns null when site has no LLMO config', async () => {
      const site = {
        getConfig: () => ({ getLlmoConfig: () => null }),
      };
      const result = await fetchLlmoSheetData(site, 'test.json', context.env);
      expect(result).to.be.null;
    });

    it('returns null when dataFolder is missing', async () => {
      const site = {
        getConfig: () => ({ getLlmoConfig: () => ({}) }),
      };
      const result = await fetchLlmoSheetData(site, 'test.json', context.env);
      expect(result).to.be.null;
    });

    it('returns null when fetch fails', async () => {
      const site = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };
      fetchStub.resolves({ ok: false });
      const result = await fetchLlmoSheetData(site, 'test.json', context.env);
      expect(result).to.be.null;
    });

    it('returns data when fetch succeeds', async () => {
      const site = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };
      const mockData = { data: [{ id: 1 }] };
      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves(mockData),
      });
      const result = await fetchLlmoSheetData(site, 'test.json', context.env);
      expect(result).to.deep.equal(mockData);
    });

    it('uses fallback when API key is missing', async () => {
      const site = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };
      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({}),
      });
      await fetchLlmoSheetData(site, 'test.json', {});
      expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal('token hlx_api_key_missing');
    });

    it('returns null on exception', async () => {
      const site = {
        getConfig: () => { throw new Error('Test error'); },
      };
      const result = await fetchLlmoSheetData(site, 'test.json', context.env);
      expect(result).to.be.null;
    });
  });

  describe('handleExecution', () => {
    it('finds site by URL and generates CSV', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.findByBaseURL.resolves(mockSite);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'readability' },
      ]);

      // Mock query index
      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/test/brandpresence-social/social-w01.json' },
                { path: '/test/brandpresence-3rdparty/party-w01.json' },
                { path: '/test/agentic-traffic/agentictraffic-errors-403-w01.json' },
                { path: '/test/agentic-traffic/agentictraffic-errors-404-w01.json' },
                { path: '/test/agentic-traffic/agentictraffic-errors-5xx-w01.json' },
              ],
            }),
          });
        }
        if (url.includes('brandpresence-social') || url.includes('brandpresence-3rdparty')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }, { id: 2 }] }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution(['https://test.com'], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('finds site by ID', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.findById.resolves(mockSite);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution(['site-1'], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles site not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution(['https://notfound.com'], slackContext);

      expect(slackContext.say.calledWith('❌ Site not found: https://notfound.com')).to.be.true;
    });

    it('fetches all LLMO sites when no input provided', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith('🔍 Fetching all LLMO-enabled sites...')).to.be.true;
      expect(sendFileStub.called).to.be.true;
    });

    it('handles no LLMO sites found', async () => {
      context.dataAccess.Site.all.resolves([
        { getConfig: () => ({ getLlmoConfig: () => null }) },
      ]);

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith('No LLMO-enabled sites found.')).to.be.true;
    });

    it('skips excluded IMS orgs', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => '9E1005A551ED61CA0A490D45@AdobeOrg', // Excluded org
        getName: () => 'Excluded Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(context.log.info.calledWith(sinon.match('Skipping excluded IMS org'))).to.be.true;
      expect(slackContext.say.calledWith('No LLMO opportunities found.')).to.be.true;
    });

    it('handles site processing errors', async () => {
      const mockSite = {
        getId: () => { throw new Error('Site error'); },
        getBaseURL: () => 'https://test.com',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith('No LLMO opportunities found.')).to.be.true;
    });

    it('handles opportunities with null tags', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => null, getType: () => 'other' },
        { getTags: () => ['isElmo'], getType: () => 'readability' },
      ]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('counts opportunities with prerender type', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => [], getType: () => 'prerender' },
        { getTags: () => ['isElmo'], getType: () => 'readability' },
      ]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Should count both: 1 prerender + 1 isElmo = 2
      expect(csvContent).to.include(',2,');
    });

    it('counts opportunities with llm-blocked type', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => [], getType: () => 'llm-blocked' },
        { getTags: () => ['isElmo'], getType: () => 'readability' },
      ]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Should count both: 1 llm-blocked + 1 isElmo = 2
      expect(csvContent).to.include(',2,');
    });

    it('counts opportunities with both isElmo tag and prerender type', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'prerender' },
      ]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Should count once (not double-counted): 1
      expect(csvContent).to.include(',1,');
    });

    it('counts mixed opportunity types correctly', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'readability' }, // counted
        { getTags: () => [], getType: () => 'prerender' }, // counted
        { getTags: () => [], getType: () => 'llm-blocked' }, // counted
        { getTags: () => ['isElmo'], getType: () => 'prerender' }, // counted (once)
        { getTags: () => [], getType: () => 'other' }, // not counted
        { getTags: () => ['otherTag'], getType: () => 'readability' }, // not counted
      ]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Should count 4 opportunities total
      expect(csvContent).to.include(',4,');
    });

    it('handles opportunities with null or undefined type', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => null }, // counted (has isElmo)
        { getTags: () => [], getType: () => undefined }, // not counted
        { getTags: () => null, getType: () => null }, // not counted
      ]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Should count only 1 (the one with isElmo tag)
      expect(csvContent).to.include(',1,');
    });

    it('sanitizes org names with special characters', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => ' Org\nWith\tSpecial\rChars  ',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles missing organization name', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => null,
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles null query index', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles top-level execution error', async () => {
      context.dataAccess.Site.all.rejects(new Error('Database error'));

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWith('❌ Error: Database error')).to.be.true;
    });

    it('sorts results by baseURL', async () => {
      const mockSite1 = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://zebra.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };
      const mockSite2 = {
        getId: () => 'site-2',
        getBaseURL: () => 'https://apple.com',
        getOrganizationId: () => 'org-2',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite1, mockSite2]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      // Results should be sorted alphabetically
    });

    it('handles query index with null data property', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      // Return query index with null data
      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: null }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles query index with undefined data property', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      // Return query index without data property
      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({}),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles failed fetches for social and third-party paths', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/test/brandpresence-social/social-w01.json' },
                { path: '/test/brandpresence-3rdparty/party-w01.json' },
              ],
            }),
          });
        }
        // All other fetches fail
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles fetched data with null data property', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/test/brandpresence-social/social-w01.json' },
                { path: '/test/brandpresence-3rdparty/party-w01.json' },
              ],
            }),
          });
        }
        // Return data with null data property
        if (url.includes('brandpresence-social') || url.includes('brandpresence-3rdparty')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: null }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles fetched data with undefined data property', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/test/brandpresence-social/social-w01.json' },
                { path: '/test/brandpresence-3rdparty/party-w01.json' },
              ],
            }),
          });
        }
        // Return data without data property
        if (url.includes('brandpresence-social') || url.includes('brandpresence-3rdparty')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({}),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });

    it('handles mixed successful and failed fetches for social and third-party paths', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test-folder' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      let callCount = 0;
      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/test/brandpresence-social/social-w01.json' },
                { path: '/test/brandpresence-social/social-w02.json' },
                { path: '/test/brandpresence-3rdparty/party-w01.json' },
                { path: '/test/brandpresence-3rdparty/party-w02.json' },
              ],
            }),
          });
        }
        // Alternate between success with data and success with empty data
        if (url.includes('brandpresence-social') || url.includes('brandpresence-3rdparty')) {
          callCount += 1;
          if (callCount % 2 === 0) {
            return Promise.resolve({
              ok: true,
              json: sinon.stub().resolves({ data: [{ id: 1 }] }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({}),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });
  });

  describe('Helper Functions - Edge Cases', () => {
    it('getTotalSocialOpportunities returns 0 for empty query index data', async () => {
      const mockSite = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test' }) }),
      };
      const queryIndex = { data: [] };
      const result = await getTotalSocialOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(0);
    });

    it('getThirdPartyOpportunities returns 0 for empty query index data', async () => {
      const mockSite = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'test' }) }),
      };
      const queryIndex = { data: [] };
      const result = await getThirdPartyOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(0);
    });

    it('getTotalSocialOpportunities correctly handles paths with dataFolder prefix', async () => {
      const mockSite = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };
      const queryIndex = {
        data: [
          { path: '/adobe/brandpresence-social-w28-2025.json' },
        ],
      };

      fetchStub.callsFake((url) => {
        // Verify the URL is constructed correctly without double adobe prefix
        if (url.includes('adobe/brandpresence-social-w28-2025.json')) {
          const urlStr = url.toString();
          // Should not have adobe/adobe
          expect(urlStr).to.not.include('adobe/adobe');
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }, { id: 2 }] }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const result = await getTotalSocialOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(2);
    });

    it('getThirdPartyOpportunities correctly handles paths with dataFolder prefix', async () => {
      const mockSite = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };
      const queryIndex = {
        data: [
          { path: '/adobe/brandpresence-3rdparty.json' },
        ],
      };

      fetchStub.callsFake((url) => {
        if (url.includes('adobe/brandpresence-3rdparty.json')) {
          const urlStr = url.toString();
          expect(urlStr).to.not.include('adobe/adobe');
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const result = await getThirdPartyOpportunities(queryIndex, mockSite, context.env);
      expect(result).to.equal(3);
    });

    it('getQueryIndex handles missing dataFolder gracefully', async () => {
      const mockSite = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: undefined }) }),
      };

      fetchStub.resolves({ ok: false });

      const result = await getQueryIndex(mockSite, context.env);
      expect(result).to.be.null;
    });

    it('getQueryIndex handles null dataFolder gracefully', async () => {
      const mockSite = {
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: null }) }),
      };

      fetchStub.resolves({ ok: false });

      const result = await getQueryIndex(mockSite, context.env);
      expect(result).to.be.null;
    });
  });

  describe('Total Opportunities Count Calculation', () => {
    it('calculates totalOpportunitiesCount with all opportunity types present', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'readability' },
      ]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/adobe/agentic-traffic/agentictraffic-errors-403-w01.json' },
                { path: '/adobe/agentic-traffic/agentictraffic-errors-404-w01.json' },
                { path: '/adobe/agentic-traffic/agentictraffic-errors-5xx-w01.json' },
                { path: '/adobe/brandpresence-social-w01.json' },
                { path: '/adobe/brandpresence-3rdparty.json' },
              ],
            }),
          });
        }
        if (url.includes('brandpresence-social')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }, { id: 2 }] }),
          });
        }
        if (url.includes('brandpresence-3rdparty')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Total should be 1 (Spacecat) + 3 (GEO types) + 2 (social) + 3 (third-party) = 9
      expect(csvContent).to.include('9');
    });

    it('calculates totalOpportunitiesCount with only GEO errors', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'readability' },
        { getTags: () => ['isElmo'], getType: () => 'other' },
      ]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/adobe/agentic-traffic/agentictraffic-errors-403-w01.json' },
                { path: '/adobe/agentic-traffic/agentictraffic-errors-404-w01.json' },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Total should be 2 (Spacecat) + 2 (403 and 404) = 4
      expect(csvContent).to.include(',4\n');
    });

    it('calculates totalOpportunitiesCount with only social opportunities', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'readability' },
        { getTags: () => ['isElmo'], getType: () => 'other' },
        { getTags: () => ['isElmo'], getType: () => 'content' },
      ]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/adobe/brandpresence-social-w01.json' },
              ],
            }),
          });
        }
        if (url.includes('brandpresence-social')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Total should be 3 (Spacecat) + 5 (social) = 8
      expect(csvContent).to.include(',8\n');
    });

    it('calculates totalOpportunitiesCount as 0 when no opportunities exist', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/adobe/other-data.json' },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Total should be 0 (no Spacecat opportunities and no GEO/social/third-party)
      expect(csvContent).to.include(',0\n');
    });

    it('calculates totalOpportunitiesCount with mixed GEO and social/third-party', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'], getType: () => 'readability' },
      ]);

      fetchStub.callsFake((url) => {
        if (url.includes('query-index.json')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({
              data: [
                { path: '/adobe/agentic-traffic/agentictraffic-errors-5xx-w01.json' },
                { path: '/adobe/brandpresence-social-w01.json' },
                { path: '/adobe/brandpresence-3rdparty.json' },
              ],
            }),
          });
        }
        if (url.includes('brandpresence-social')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }] }),
          });
        }
        if (url.includes('brandpresence-3rdparty')) {
          return Promise.resolve({
            ok: true,
            json: sinon.stub().resolves({ data: [{ id: 1 }, { id: 2 }] }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      // Total should be 1 (Spacecat) + 1 (5xx) + 1 (social) + 2 (third-party) = 5
      expect(csvContent).to.include(',5\n');
    });

    it('includes totalOpportunitiesCount in CSV header', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ dataFolder: 'adobe' }) }),
      };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([]);
      fetchStub.resolves({ ok: false });

      const command = GetLlmoOpportunityUsageCommand(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
      const csvContent = sendFileStub.firstCall.args[1].toString();
      expect(csvContent).to.include('Total Count');
    });
  });
});
