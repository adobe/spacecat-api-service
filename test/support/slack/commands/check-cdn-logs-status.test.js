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

describe('CheckCdnLogsStatusCommand', () => {
  let context;
  let slackContext;
  let CheckCdnLogsStatusCommand;
  let readConfigStub;
  let s3SendStub;

  const makeSite = (id, url) => ({
    getId: () => id,
    getBaseURL: () => url,
  });

  const makeS3ListResponse = (hours) => ({
    CommonPrefixes: hours.map((h) => ({ Prefix: `aggregated/site-1/2026/04/21/${h}/` })),
    NextContinuationToken: undefined,
  });

  beforeEach(async () => {
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
        Site: { all: sinon.stub() },
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
  });

  it('has the correct id and phrases', () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    expect(cmd.id).to.equal('check-cdn-logs-status');
    expect(cmd.accepts('check cdn logs status')).to.be.true;
  });

  it('rejects invalid date format', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['bad-date'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match(':warning: Invalid date format. Use YYYY-MM-DD.'),
    );
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

  it('shows complete status when all expected hours present for fastly (hourly) site', async () => {
    const site = makeSite('site-1', 'https://fastly-site.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });

    // Return all 24 hours present
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

    // Only hours 00-10 present
    const presentHours = Array.from({ length: 11 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.resolves(makeS3ListResponse(presentHours));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const summaryCall = slackContext.say.args.find((a) => a[0].includes('Incomplete: *1*'));
    expect(summaryCall).to.exist;
    expect(summaryCall[0]).to.include('fastly-site.com');
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

  it('treats unknown provider as hourly (all 24 hours expected)', async () => {
    const site = makeSite('site-u', 'https://unknown-cdn.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.rejects(new Error('config not found'));
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    // unknown provider → 24 hours expected → all missing
    const summaryCall = slackContext.say.args.find((a) => a[0].includes('Incomplete: *1*'));
    expect(summaryCall).to.exist;
  });

  it('handles unexpected errors gracefully', async () => {
    context.dataAccess.Site.all.rejects(new Error('DB connection failed'));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(context.log.error).to.have.been.called;
  });
});
