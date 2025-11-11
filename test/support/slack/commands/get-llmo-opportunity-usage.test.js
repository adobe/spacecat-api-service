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
  let GetLlmoOpportunityUsageCommand;

  beforeEach(async () => {
    sendFileStub = sinon.stub().resolves();

    GetLlmoOpportunityUsageCommand = await esmock(
      '../../../../src/support/slack/commands/get-llmo-opportunity-usage.js',
      {
        '../../../../src/utils/slack/base.js': { sendFile: sendFileStub },
        '@adobe/spacecat-shared-utils': {
          isValidUrl: (url) => url && url.startsWith('http'),
        },
      },
    );

    context = {
      dataAccess: {
        Site: { all: sinon.stub(), findByBaseURL: sinon.stub(), findById: sinon.stub() },
        Organization: { findById: sinon.stub() },
        Opportunity: { allBySiteId: sinon.stub() },
      },
      log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
    };
    slackContext = { say: sinon.spy(), channelId: 'test-channel' };
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(GetLlmoOpportunityUsageCommand);
  });

  it('initializes correctly', () => {
    const command = GetLlmoOpportunityUsageCommand(context);
    expect(command.id).to.equal('get-llmo-opportunity-usage');
    expect(command.phrases).to.include('get-llmo-opportunity-usage');
  });

  it('handles no LLMO sites found', async () => {
    context.dataAccess.Site.all.resolves([]);
    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith('No LLMO-enabled sites found.')).to.be.true;
  });

  it('handles site not found by URL', async () => {
    context.dataAccess.Site.findByBaseURL.resolves(null);
    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution(['https://nonexistent.com'], slackContext);
    expect(slackContext.say.calledWith('❌ Site not found: https://nonexistent.com')).to.be.true;
  });

  it('finds site by ID and counts opportunities', async () => {
    const mockSite = {
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    };

    const mockOpportunities = [
      { getTags: () => ['isElmo', 'seo'] },
      { getTags: () => ['performance'] },
      { getTags: () => ['isElmo', 'content'] },
    ];

    context.dataAccess.Site.findById.resolves(mockSite);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => 'Valid Org',
    });
    context.dataAccess.Opportunity.allBySiteId.resolves(mockOpportunities);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution(['site-1'], slackContext);

    expect(slackContext.say.calledWith('🔍 Fetching LLMO opportunity usage for site: site-1...')).to.be.true;
    expect(sendFileStub.called).to.be.true;
  });

  it('excludes IMS orgs and processes errors gracefully', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => '9E1005A551ED61CA0A490D45@AdobeOrg', // Excluded org
      getName: () => 'Excluded Org',
    });
    context.dataAccess.Opportunity.allBySiteId.resolves([]);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(slackContext.say.calledWith('No LLMO opportunities found.')).to.be.true;
    expect(context.log.info.calledWith(sinon.match('Skipping excluded IMS org'))).to.be.true;
  });

  it('successfully generates CSV for valid sites with LLMO opportunities', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    const mockOpportunities = [
      { getTags: () => ['isElmo', 'seo'] },
      { getTags: () => ['isElmo', 'performance'] },
      { getTags: () => ['content'] }, // Not an LLMO opportunity
    ];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => 'Valid Org',
    });
    context.dataAccess.Opportunity.allBySiteId.resolves(mockOpportunities);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
    expect(context.log.info.calledWith(sinon.match('LLMO opportunity usage completed: 1 sites processed'))).to.be.true;
  });

  it('handles opportunities with no tags', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    const mockOpportunities = [
      { getTags: () => null }, // No tags
      { getTags: () => [] }, // Empty tags
      { getTags: () => ['isElmo'] }, // Valid LLMO opportunity
    ];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => 'Valid Org',
    });
    context.dataAccess.Opportunity.allBySiteId.resolves(mockOpportunities);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
  });

  it('successfully generates CSV for missing IMS org name', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    const mockOpportunities = [
      { getTags: () => ['isElmo'] },
    ];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => undefined,
    });
    context.dataAccess.Opportunity.allBySiteId.resolves(mockOpportunities);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
    expect(context.log.info.calledWith(sinon.match('LLMO opportunity usage completed: 1 sites processed'))).to.be.true;
  });

  it('successfully generates CSV for IMS Org names with special characters', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    const mockOpportunities = [
      { getTags: () => ['isElmo'] },
    ];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => ' Valid Org\nWith\nSpecial\nCharacters  and extra spaces',
    });
    context.dataAccess.Opportunity.allBySiteId.resolves(mockOpportunities);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
    expect(context.log.info.calledWith(sinon.match('LLMO opportunity usage completed: 1 sites processed'))).to.be.true;
  });

  it('handles errors gracefully', async () => {
    context.dataAccess.Site.all.rejects(new Error('Database error'));
    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith('❌ Error: Database error')).to.be.true;
  });

  it('handles missing organization', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves(null);
    context.dataAccess.Opportunity.allBySiteId.resolves([]);

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
  });

  it('handles promise rejection in parallel processing', async () => {
    const mockSites = [
      {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test1.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
      },
      {
        getId: () => { throw new Error('Site ID error'); },
        getBaseURL: () => 'https://test2.com',
        getOrganizationId: () => 'org-2',
        getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
      },
    ];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Opportunity.allBySiteId.resolves([
      { getTags: () => ['isElmo'] },
    ]);
    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => 'Valid Org',
    });

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
  });

  it('handles opportunity fetch errors for specific sites', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Opportunity.allBySiteId.rejects(new Error('Opportunity fetch error'));

    const command = GetLlmoOpportunityUsageCommand(context);
    await command.handleExecution([], slackContext);

    expect(context.log.warn.calledWith(sinon.match('Failed to process site'))).to.be.true;
    expect(slackContext.say.calledWith('No LLMO opportunities found.')).to.be.true;
  });

  describe('fetchLlmoSheetData', () => {
    let fetchStub;
    let fetchLlmoSheetData;

    beforeEach(async () => {
      fetchStub = sinon.stub();

      const module = await esmock(
        '../../../../src/support/slack/commands/get-llmo-opportunity-usage.js',
        {
          '../../../../src/utils/slack/base.js': { sendFile: sinon.stub() },
          '@adobe/spacecat-shared-utils': {
            isValidUrl: (url) => url && url.startsWith('http'),
            SPACECAT_USER_AGENT: 'TestAgent',
            tracingFetch: fetchStub,
          },
        },
      );

      fetchLlmoSheetData = module.fetchLlmoSheetData;
    });

    it('successfully fetches sheet data', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const mockData = { data: [{ id: 1, name: 'test' }] };
      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves(mockData),
      });

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      const result = await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      expect(result).to.deep.equal(mockData);
      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.include('test-folder/opportunities.json');
    });

    it('returns null when site has no LLMO config', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({ getLlmoConfig: () => null }),
      };

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      const result = await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      expect(result).to.be.null;
      expect(fetchStub.called).to.be.false;
    });

    it('returns null when site config is missing', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => null,
      };

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      const result = await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      expect(result).to.be.null;
      expect(fetchStub.called).to.be.false;
    });

    it('returns null when dataFolder is missing', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: null }),
        }),
      };

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      const result = await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      expect(result).to.be.null;
      expect(fetchStub.called).to.be.false;
    });

    it('returns null when fetch fails', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      const result = await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      expect(result).to.be.null;
    });

    it('returns null when fetch throws an error', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.rejects(new Error('Network error'));

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      const result = await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      expect(result).to.be.null;
    });

    it('uses correct authorization header', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const env = { LLMO_HLX_API_KEY: 'secret-key-123' };
      await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      const fetchArgs = fetchStub.firstCall.args[1];
      expect(fetchArgs.headers.Authorization).to.equal('token secret-key-123');
    });

    it('constructs correct URL with nested path', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const env = { LLMO_HLX_API_KEY: 'test-key' };
      await fetchLlmoSheetData(mockSite, 'agentic-traffic/errors.json', env);

      expect(fetchStub.firstCall.args[0]).to.include('test-folder/agentic-traffic/errors.json');
    });

    it('uses fallback authorization when LLMO_HLX_API_KEY is missing', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const env = {}; // No LLMO_HLX_API_KEY
      await fetchLlmoSheetData(mockSite, 'opportunities.json', env);

      const fetchArgs = fetchStub.firstCall.args[1];
      expect(fetchArgs.headers.Authorization).to.equal('token hlx_api_key_missing');
    });
  });

  describe('getTechnicalGEO404Opportunities', () => {
    let fetchStub;
    let GetLlmoOpportunityUsageCommandMocked;

    beforeEach(async () => {
      fetchStub = sinon.stub();

      GetLlmoOpportunityUsageCommandMocked = await esmock(
        '../../../../src/support/slack/commands/get-llmo-opportunity-usage.js',
        {
          '../../../../src/utils/slack/base.js': { sendFile: sendFileStub },
          '@adobe/spacecat-shared-utils': {
            isValidUrl: (url) => url && url.startsWith('http'),
            SPACECAT_USER_AGENT: 'TestAgent',
            tracingFetch: fetchStub,
          },
        },
      );

      // getTechnicalGEO404Opportunities is not exported,
      // so we test it indirectly through command execution
    });

    it('includes technical GEO 404 opportunities in CSV output', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      const mockData = {
        data: [
          { url: '/page1', status: 404 },
          { url: '/page2', status: 404 },
          { url: '/page3', status: 404 },
        ],
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves(mockData),
      });

      const env = { LLMO_HLX_API_KEY: 'test-key' };

      // Test through the command execution since getTechnicalGEO404Opportunities
      // is not directly exported
      const mockSites = [mockSite];
      context.dataAccess.Site.all.resolves(mockSites);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'] },
      ]);
      context.env = env;

      const command = GetLlmoOpportunityUsageCommandMocked(context);
      await command.handleExecution([], slackContext);

      // Verify the fetch was called for the technical GEO 404 opportunities
      const fetchCalls = fetchStub.getCalls();
      const geo404Call = fetchCalls.find((call) => call.args[0] && call.args[0].includes('agentictraffic-errors-403'));
      expect(geo404Call).to.exist;
      expect(sendFileStub.called).to.be.true;
    });

    it('handles unavailable sheet data gracefully', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      // Mock fetch to fail for sheet data
      fetchStub.resolves({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const env = { LLMO_HLX_API_KEY: 'test-key' };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'] },
      ]);
      context.env = env;

      const command = GetLlmoOpportunityUsageCommandMocked(context);
      await command.handleExecution([], slackContext);

      // Should still complete without crashing and generate CSV with null geo404 data
      expect(sendFileStub.called).to.be.true;
    });

    it('handles empty data array gracefully', async () => {
      const mockSite = {
        getId: () => 'site-1',
        getBaseURL: () => 'https://test.com',
        getOrganizationId: () => 'org-1',
        getConfig: () => ({
          getLlmoConfig: () => ({ dataFolder: 'test-folder' }),
        }),
      };

      fetchStub.resolves({
        ok: true,
        json: sinon.stub().resolves({ data: [] }),
      });

      const env = { LLMO_HLX_API_KEY: 'test-key' };

      context.dataAccess.Site.all.resolves([mockSite]);
      context.dataAccess.Organization.findById.resolves({
        getImsOrgId: () => 'valid@AdobeOrg',
        getName: () => 'Test Org',
      });
      context.dataAccess.Opportunity.allBySiteId.resolves([
        { getTags: () => ['isElmo'] },
      ]);
      context.env = env;

      const command = GetLlmoOpportunityUsageCommandMocked(context);
      await command.handleExecution([], slackContext);

      expect(sendFileStub.called).to.be.true;
    });
  });
});
