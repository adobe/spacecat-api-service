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
});
