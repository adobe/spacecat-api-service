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
import nock from 'nock';

use(sinonChai);

describe('CheckCdnLogsStatusCommand', () => {
  let context;
  let slackContext;
  let CheckCdnLogsStatusCommand;
  let readConfigStub;
  let s3SendStub;
  const TARGET_SITE_ID = '11111111-2222-3333-4444-555555555555';
  const MISSING_SITE_ID = '33333333-4444-5555-6666-555555555555';

  const makeSite = (id, url, llmoConfig = {}) => ({
    getId: () => id,
    getBaseURL: () => url,
    getConfig: () => ({
      getLlmoConfig: () => llmoConfig,
      getLlmoCdnBucketConfig: () => llmoConfig.cdnBucketConfig,
    }),
  });

  const makeS3ListResponse = (hours) => ({
    CommonPrefixes: hours.map((h) => ({ Prefix: `aggregated/site-1/2026/04/21/${h}/` })),
  });

  beforeEach(async function () {
    this.timeout(30000);
    readConfigStub = sinon.stub();
    s3SendStub = sinon.stub();

    CheckCdnLogsStatusCommand = (await esmock(
      '../../../../src/support/slack/commands/check-cdn-logs-status.js',
      {
        '@adobe/spacecat-shared-utils': {
          llmoConfig: { readConfig: readConfigStub },
        },
        '@aws-sdk/client-s3': {
          ListObjectsV2Command: class ListObjectsV2Command {
            constructor(params) { this.params = params; }
          },
        },
      },
    )).default;

    context = {
      dataAccess: {
        Site: {
          all: sinon.stub(),
          findById: sinon.stub().resolves(null),
          findByBaseURL: sinon.stub().resolves(null),
        },
        Configuration: { findLatest: sinon.stub() },
      },
      log: { error: sinon.stub(), warn: sinon.stub() },
      s3: {
        s3Client: { send: s3SendStub },
        s3Bucket: 'test-bucket',
      },
      env: { AWS_REGION: 'us-east-1', AWS_ENV: 'ci' },
    };
    slackContext = { say: sinon.stub().resolves() };
  });

  afterEach(() => {
    sinon.restore();
    nock.cleanAll();
  });

  it('uses yesterday as the target date when no argument is provided', async () => {
    context.dataAccess.Site.all.resolves([]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(false),
    });
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution([], slackContext);
    expect(slackContext.say.getCall(0).args[0]).to.include(':hourglass_flowing_sand:');
  });

  it('reports when S3 client is not available', async () => {
    context.s3 = null;
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(sinon.match(':x: S3 client not available'));
  });

  it('reports when no sites have cdn-logs-analysis enabled', async () => {
    context.dataAccess.Site.all.resolves([]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(false),
    });
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match('No sites have cdn-logs-analysis enabled'),
    );
  });

  it('filters the check to one requested baseUrl', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://base-url.example.com');
    context.dataAccess.Site.findByBaseURL.resolves(targetSite);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'cloudflare' } } });
    s3SendStub.resolves({
      CommonPrefixes: [{ Prefix: `aggregated/${TARGET_SITE_ID}/2026/04/21/23/` }],
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', 'baseUrl=https://base-url.example.com'], slackContext);

    expect(context.dataAccess.Site.all).not.to.have.been.called;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('for site `https://base-url.example.com`');
    expect(output).to.include('Complete: *1*');
  });

  it('reports when the requested CDN status siteId is not found', async () => {
    context.dataAccess.Site.findById.resolves(null);
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', `siteId=${MISSING_SITE_ID}`], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      `:warning: No site found with siteId \`${MISSING_SITE_ID}\`.`,
    );
    expect(s3SendStub).not.to.have.been.called;
  });

  it('shows complete status when all expected hours present for fastly (hourly) site', async () => {
    const site = makeSite('site-1', 'https://fastly-site.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    const allHours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.resolves(makeS3ListResponse(allHours));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const summaryCall = slackContext.say.args.find((a) => a[0].includes('Complete: *1*'));
    expect(summaryCall).to.exist;
    expect(summaryCall[0]).to.include('Incomplete: *0*');
  });

  it('reports missing hours for hourly provider when some hours absent', async () => {
    const site = makeSite('site-1', 'https://fastly-site.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    const presentHours = Array.from({ length: 11 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.resolves(makeS3ListResponse(presentHours));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const summaryCall = slackContext.say.args.find((a) => a[0].includes('Incomplete: *1*'));
    expect(summaryCall).to.exist;
    expect(summaryCall[0]).to.include('fastly-site.com');
  });

  it('paginates S3 listing when NextContinuationToken is present', async () => {
    const site = makeSite('site-pg', 'https://paginated.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });

    const firstHalf = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, '0'));
    const secondHalf = Array.from({ length: 12 }, (_, i) => String(i + 12).padStart(2, '0'));
    s3SendStub
      .onFirstCall().resolves({
        CommonPrefixes: firstHalf.map((h) => ({ Prefix: `aggregated/site-pg/2026/04/21/${h}/` })),
        NextContinuationToken: 'page2-token',
      })
      .onSecondCall().resolves({
        CommonPrefixes: secondHalf.map((h) => ({ Prefix: `aggregated/site-pg/2026/04/21/${h}/` })),
        NextContinuationToken: undefined,
      });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(s3SendStub.callCount).to.equal(2);
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Complete: *1*');
  });

  it('shows complete for cloudflare (daily-only) site when hour 23 is present', async () => {
    const site = makeSite('site-cf', 'https://cloudflare-site.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'cloudflare' } } });
    s3SendStub.resolves({
      CommonPrefixes: [{ Prefix: 'aggregated/site-cf/2026/04/21/23/' }],
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const summaryCall = slackContext.say.args.find((a) => a[0].includes('Complete: *1*'));
    expect(summaryCall).to.exist;
  });

  it('treats unknown provider as hourly and warns when LLMO config is unavailable', async () => {
    const site = makeSite('site-u', 'https://unknown-cdn.com');
    const secondSite = makeSite('site-u2', 'https://unknown-cdn-2.com');
    context.dataAccess.Site.all.resolves([site, secondSite]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.rejects(new Error('config not found'));
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(context.log.warn).to.have.been.calledWith(
      sinon.match('LLMO config read failed for site site-u'),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *2*');
    expect(output).to.include('LLMO config unavailable for *2* sites');
  });

  it('reports per-site S3 error in the errors section', async () => {
    const site = makeSite('site-err', 'https://s3error.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });
    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    s3SendStub.rejects(new Error('AccessDenied'));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(context.log.warn).to.have.been.calledWith(
      sinon.match('CDN logs status check failed for site site-err'),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Sites with errors');
    expect(output).to.include('AccessDenied');
  });

  it('handles unexpected top-level errors gracefully', async () => {
    context.dataAccess.Site.all.rejects(new Error('DB connection failed'));
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);
    expect(context.log.error).to.have.been.called;
  });
});
