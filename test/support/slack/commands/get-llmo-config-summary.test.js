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

describe('GetLlmoConfigSummaryCommand', () => {
  let context;
  let slackContext;
  let readConfigStub;
  let sendFileStub;
  let GetLlmoConfigSummaryCommand;

  beforeEach(async () => {
    readConfigStub = sinon.stub();
    sendFileStub = sinon.stub().resolves();

    GetLlmoConfigSummaryCommand = await esmock(
      '../../../../src/support/slack/commands/get-llmo-config-summary.js',
      {
        '../../../../src/utils/slack/base.js': { sendFile: sendFileStub },
        '@adobe/spacecat-shared-utils': {
          llmoConfig: { readConfig: readConfigStub },
          isValidUrl: (url) => url && url.startsWith('http'),
        },
      },
    );

    context = {
      dataAccess: {
        Site: { all: sinon.stub(), findByBaseURL: sinon.stub(), findById: sinon.stub() },
        Organization: { findById: sinon.stub() },
      },
      s3: { s3Client: {}, s3Bucket: 'test-bucket' },
      log: { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
    };
    slackContext = { say: sinon.spy(), channelId: 'test-channel' };
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(GetLlmoConfigSummaryCommand);
  });

  it('initializes correctly', () => {
    const command = GetLlmoConfigSummaryCommand(context);
    expect(command.id).to.equal('get-llmo-config-summary');
    expect(command.phrases).to.include('get-llmo-config-summary');
  });

  it('handles no LLMO sites found', async () => {
    context.dataAccess.Site.all.resolves([]);
    const command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith('No LLMO-enabled sites found.')).to.be.true;
  });

  it('handles site not found by URL and finds site by ID', async () => {
    context.dataAccess.Site.findByBaseURL.resolves(null);
    let command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution(['https://nonexistent.com'], slackContext);
    expect(slackContext.say.calledWith('❌ Site not found: https://nonexistent.com')).to.be.true;

    slackContext.say.resetHistory();
    const mockSite = {
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    };
    context.dataAccess.Site.findById.resolves(mockSite);
    context.dataAccess.Organization.findById.resolves({ getImsOrgId: () => 'valid@AdobeOrg' });
    readConfigStub.resolves({ config: { categories: {} }, exists: true });

    command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution(['site-1'], slackContext);
    expect(slackContext.say.calledWith('🔍 Fetching LLMO configuration for site: site-1...')).to.be.true;
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
    readConfigStub.resolves({ config: { categories: {} }, exists: true });

    const command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);

    expect(slackContext.say.calledWith('No valid LLMO configurations found.')).to.be.true;
    expect(context.log.info.calledWith(sinon.match('Skipping excluded IMS org'))).to.be.true;
  });

  it('successfully generates CSV for valid sites', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    const mockConfig = {
      categories: { cat1: {} },
      topics: { topic1: { prompts: ['prompt1'] } },
      brands: { aliases: ['alias1'] },
      competitors: { competitors: ['comp1'] },
      deleted: { prompts: { deleted1: {} } },
      cdnBucketConfig: { cdnProvider: 'cloudflare' },
    };

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({ getImsOrgId: () => 'valid@AdobeOrg', getName: () => 'Valid Org' });
    readConfigStub.resolves({ config: mockConfig, exists: true });

    const command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
    expect(context.log.info.calledWith(sinon.match('LLMO config summary completed: 1 sites processed'))).to.be.true;
  });

  it('successfully generates CSV for missing IMS org name', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    const mockConfig = {
      categories: { cat1: {} },
      topics: { topic1: { prompts: ['prompt1'] } },
      brands: { aliases: ['alias1'] },
      competitors: { competitors: ['comp1'] },
      deleted: { prompts: { deleted1: {} } },
      cdnBucketConfig: { cdnProvider: 'cloudflare' },
    };

    context.dataAccess.Site.all.resolves(mockSites);
    context.dataAccess.Organization.findById.resolves({ getImsOrgId: () => 'valid@AdobeOrg', getName: () => undefined });
    readConfigStub.resolves({ config: mockConfig, exists: true });

    const command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
    expect(context.log.info.calledWith(sinon.match('LLMO config summary completed: 1 sites processed'))).to.be.true;
  });

  it('handles errors gracefully', async () => {
    context.dataAccess.Site.all.rejects(new Error('Database error'));
    const command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith('❌ Error: Database error')).to.be.true;
  });

  it('handles missing S3 config and edge cases', async () => {
    const mockSites = [{
      getId: () => 'site-1',
      getBaseURL: () => 'https://test.com',
      getOrganizationId: () => 'org-1',
      getConfig: () => ({ getLlmoConfig: () => ({ llmo: true }) }),
    }];

    context.s3 = null;
    context.dataAccess.Site.all.resolves(mockSites);

    let command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith('No valid LLMO configurations found.')).to.be.true;
    expect(context.log.warn.calledWith(sinon.match('Failed to process site'))).to.be.true;

    context.s3 = { s3Client: {}, s3Bucket: 'test-bucket' };
    slackContext.say.resetHistory();
    context.dataAccess.Organization.findById.resolves(null);
    readConfigStub.resolves({ config: null, exists: false });

    command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);
    expect(slackContext.say.calledWith('No valid LLMO configurations found.')).to.be.true;

    slackContext.say.resetHistory();
    context.dataAccess.Organization.findById.resolves({ getImsOrgId: () => 'valid@AdobeOrg', getName: () => 'Valid Org' });
    readConfigStub.resolves({ config: { topics: { topic1: {} } }, exists: true });

    command = GetLlmoConfigSummaryCommand(context);
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

    readConfigStub.resolves({
      config: { categories: { cat1: {} } },
      exists: true,
    });

    context.dataAccess.Organization.findById.resolves({
      getImsOrgId: () => 'valid@AdobeOrg',
      getName: () => 'Valid Org',
    });

    const command = GetLlmoConfigSummaryCommand(context);
    await command.handleExecution([], slackContext);

    expect(sendFileStub.called).to.be.true;
  });
});
