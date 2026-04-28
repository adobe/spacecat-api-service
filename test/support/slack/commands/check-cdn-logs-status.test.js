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
  const OTHER_SITE_ID = '22222222-3333-4444-5555-555555555555';
  const MISSING_SITE_ID = '33333333-4444-5555-6666-555555555555';
  const DISABLED_SITE_ID = '44444444-5555-6666-7777-555555555555';

  const makeSite = (id, url, llmoConfig = {}) => ({
    getId: () => id,
    getBaseURL: () => url,
    getConfig: () => ({
      getLlmoConfig: () => llmoConfig,
      getLlmoCdnBucketConfig: () => llmoConfig.cdnBucketConfig,
    }),
  });

  const makeS3ListResponse = (hours, nextToken) => ({
    CommonPrefixes: hours.map((h) => ({ Prefix: `aggregated/site-1/2026/04/21/${h}/` })),
    NextContinuationToken: nextToken,
  });

  const attachSlackFileClient = () => {
    nock('https://slack-upload.test').post('/cdn-report').reply(200);
    slackContext.channelId = 'C123';
    slackContext.threadTs = '123.456';
    slackContext.client = {
      files: {
        getUploadURLExternal: sinon.stub().resolves({
          ok: true,
          upload_url: 'https://slack-upload.test/cdn-report',
          file_id: 'F123',
        }),
        completeUploadExternal: sinon.stub().resolves({ ok: true }),
      },
    };
  };

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
        Site: {
          all: sinon.stub(),
          findById: sinon.stub().resolves(null),
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
    nock.cleanAll();
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
      sinon.match(':warning: Unrecognized argument. Expected YYYY-MM-DD or siteId=<UUID>.'),
    );
  });

  it('warns when date passes regex but is not a real date (NaN)', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-99-99'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match(':warning: Invalid date format. Use YYYY-MM-DD.'),
    );
  });

  it('warns when date matches regex but is not a real UTC calendar date', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-02-30'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match(':warning: Invalid date format. Use YYYY-MM-DD.'),
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when the requested traffic date is in the future', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2099-01-01'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Cannot check a future traffic date.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when siteId is empty', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['siteId='], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: siteId must not be empty.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when siteId key is not a UUID', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['siteId=foo`<!channel>'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match(':warning: Invalid siteId. Expected UUID.'),
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).not.to.have.been.called;
  });

  it('warns when duplicate date arguments are provided', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-20', '2026-04-21'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match(':warning: Duplicate date argument.'),
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when duplicate siteId arguments are provided', async () => {
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution([TARGET_SITE_ID, `siteId=${OTHER_SITE_ID}`], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      sinon.match(':warning: Duplicate siteId argument.'),
    );
    expect(context.dataAccess.Site.findById).not.to.have.been.called;
  });

  it('ignores empty argument tokens and uses the default date', async () => {
    context.dataAccess.Site.all.resolves([]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(false),
    });
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution([''], slackContext);

    const firstArg = slackContext.say.getCall(0).args[0];
    expect(firstArg).to.include(':hourglass_flowing_sand:');
  });

  it('uses yesterday as the target date when no argument is provided', async () => {
    context.dataAccess.Site.all.resolves([]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(false),
    });
    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution([], slackContext);
    // Reaches the hourglass message, confirming the else-branch (yesterday) was taken
    const firstArg = slackContext.say.getCall(0).args[0];
    expect(firstArg).to.include(':hourglass_flowing_sand:');
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

  it('filters the check to one requested siteId', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://target.com');
    context.dataAccess.Site.findById.resolves(targetSite);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'cloudflare' } } });
    s3SendStub.resolves({
      CommonPrefixes: [{ Prefix: `aggregated/${TARGET_SITE_ID}/2026/04/21/23/` }],
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', `siteId=${TARGET_SITE_ID}`], slackContext);

    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).to.have.been.calledWith(TARGET_SITE_ID);
    expect(s3SendStub).to.have.been.calledOnce;
    expect(s3SendStub.firstCall.args[0].params.Prefix)
      .to.equal(`aggregated/${TARGET_SITE_ID}/2026/04/21/`);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include(`for site \`${TARGET_SITE_ID}\``);
    expect(output).to.include('Complete: *1*');
    expect(output).to.include('(1 total sites)');
  });

  it('accepts a bare site UUID as single-site scope', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://uuid-target.com');
    context.dataAccess.Site.findById.resolves(targetSite);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'cloudflare' } } });
    s3SendStub.resolves({
      CommonPrefixes: [{ Prefix: `aggregated/${TARGET_SITE_ID}/2026/04/21/23/` }],
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', TARGET_SITE_ID], slackContext);

    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).to.have.been.calledWith(TARGET_SITE_ID);
    expect(s3SendStub).to.have.been.calledOnce;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include(`for site \`${TARGET_SITE_ID}\``);
    expect(output).to.include('Complete: *1*');
  });

  it('reports when the requested CDN status siteId is not found', async () => {
    context.dataAccess.Site.findById.resolves(null);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', `siteId=${MISSING_SITE_ID}`], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      `:warning: No site found with siteId \`${MISSING_SITE_ID}\`.`,
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(s3SendStub).not.to.have.been.called;
  });

  it('reports when the requested site does not have cdn-logs-analysis enabled', async () => {
    context.dataAccess.Site.findById.resolves(makeSite(DISABLED_SITE_ID, 'https://example.com'));
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(false),
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', `siteId=${DISABLED_SITE_ID}`], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      `:information_source: Site \`${DISABLED_SITE_ID}\` does not have cdn-logs-analysis enabled.`,
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(s3SendStub).not.to.have.been.called;
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

  it('handles S3 response without CommonPrefixes (uses empty fallback)', async () => {
    const site = makeSite('site-ncp', 'https://no-cp.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    // Response has no CommonPrefixes key → undefined || [] fallback
    s3SendStub.resolves({});

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    // All 24 hours missing → site is incomplete
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *1*');
  });

  it('paginates S3 listing when NextContinuationToken is present', async () => {
    const site = makeSite('site-pg', 'https://paginated.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });

    // First page: hours 00-11, with a continuation token
    const firstHalf = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, '0'));
    // Second page: hours 12-23, no continuation token
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

    // Two pages → all 24 hours collected → site is complete
    expect(s3SendStub.callCount).to.equal(2);
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Complete: *1*');
  });

  it('reports missing hours for hourly provider when some hours absent', async () => {
    const site = makeSite('site-1', 'https://fastly-site.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });

    // Only hours 00-10 present → 13 missing (> 6, triggers truncation)
    const presentHours = Array.from({ length: 11 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.resolves(makeS3ListResponse(presentHours));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const summaryCall = slackContext.say.args.find((a) => a[0].includes('Incomplete: *1*'));
    expect(summaryCall).to.exist;
    expect(summaryCall[0]).to.include('fastly-site.com');
  });

  it('shows all missing hours when <= 6 are absent (no truncation)', async () => {
    // Use a fastly site with only the last 3 hours missing (21-23 missing → 3 missing, <= 6)
    const site = makeSite('site-few', 'https://few-missing.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'akamai' } } });

    // Hours 00-20 present (21 hours), 21-23 missing (3 hours)
    const presentHours = Array.from({ length: 21 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.resolves({
      CommonPrefixes: presentHours.map((h) => ({
        Prefix: `aggregated/site-few/2026/04/21/${h}/`,
      })),
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *1*');
    // All missing hours shown inline, not truncated
    expect(output).to.include('21, 22, 23');
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

  it('detects CloudFront and FrontDoor provider families from provider names', async () => {
    const cloudfrontSite = makeSite('site-cloudfront', 'https://cloudfront-site.com');
    const frontdoorSite = makeSite('site-frontdoor', 'https://frontdoor-site.com');
    context.dataAccess.Site.all.resolves([cloudfrontSite, frontdoorSite]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub
      .onFirstCall().resolves({ config: { cdnBucketConfig: { cdnProvider: 'Amazon CloudFront' } } })
      .onSecondCall().resolves({ config: { cdnBucketConfig: { cdnProvider: 'Azure FrontDoor' } } });
    const allHours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.callsFake((command) => Promise.resolve({
      CommonPrefixes: allHours.map((h) => ({ Prefix: `${command.params.Prefix}${h}/` })),
    }));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Complete: *2*');
  });

  it('reports incomplete daily-only site with [daily-only] tag when hour 23 is absent', async () => {
    // imperva site missing hour 23 → 1 missing hour (≤ 6, shows all inline)
    // also exercises the isDailyOnly [daily-only] provider tag
    const site = makeSite('site-imp', 'https://imperva-site.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'imperva' } } });
    // No hour 23 → missing = ['23']
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *1*');
    expect(output).to.include('[daily-only]');
    expect(output).to.include('imperva');
  });

  it('treats BYOCDN Cloudflare as a daily-only provider family', async () => {
    const site = makeSite('site-bcf', 'https://byocdn-cloudflare.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'byocdn-cloudflare' } } });
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('byocdn-cloudflare => cloudflare [daily-only]');
    expect(output).to.include('present: 0/1');
  });

  it('falls back to site detectedCdn when the S3 LLMO config has no provider', async () => {
    const site = makeSite('site-det', 'https://detected-cdn.com', { detectedCdn: 'byocdn-imperva' });
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: {} });
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('byocdn-imperva => imperva [daily-only]');
    expect(output).to.include('present: 0/1');
  });

  it('uses the site CDN region when resolving the aggregate bucket', async () => {
    const site = makeSite('site-region', 'https://regional.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({
      config: { cdnBucketConfig: { cdnProvider: 'fastly', region: 'eu-west-1' } },
    });
    const allHours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    s3SendStub.resolves({
      CommonPrefixes: allHours.map((h) => ({
        Prefix: `aggregated/site-region/2026/04/21/${h}/`,
      })),
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(s3SendStub.firstCall.args[0].params.Bucket)
      .to.equal('spacecat-ci-cdn-logs-aggregates-eu-west-1');
  });

  it('treats unknown provider as hourly (all 24 hours expected)', async () => {
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
    // unknown provider → 24 hours expected → all missing
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *2*');
    expect(output).to.include('LLMO config unavailable for *2* sites');
    expect(output).to.include('config unavailable, using fallback');
  });

  it('uses singular wording for one unavailable LLMO config', async () => {
    const site = makeSite('site-one-config-fail', 'https://one-config-fail.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.rejects(new Error('config unavailable'));
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('LLMO config unavailable for *1* site;');
  });

  it('falls back to unknown provider when config has no cdnProvider field', async () => {
    // readConfig succeeds but cdnBucketConfig.cdnProvider is absent → raw is falsy → 'unknown'
    const site = makeSite('site-noraw', 'https://noraw.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: {} } });
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    // unknown (fallback) → all 24 hours expected → incomplete
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *1*');
  });

  it('uses safe fallback config when a site has no config accessor', async () => {
    const site = {
      getId: () => 'site-noconfig',
      getBaseURL: () => 'https://noconfig.com',
    };
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: {} });
    s3SendStub.resolves({ CommonPrefixes: [] });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Incomplete: *1*');
    expect(output).to.include('https://noconfig.com');
  });

  it('uses default region and environment when env vars are absent', async () => {
    context.env = {}; // no AWS_REGION, no AWS_ENV → triggers || fallbacks
    context.dataAccess.Site.all.resolves([]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(false),
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    // Bucket name in hourglass message uses 'prod' and 'us-east-1' defaults
    const firstArg = slackContext.say.getCall(0).args[0];
    expect(firstArg).to.include('spacecat-prod-cdn-logs-aggregates-us-east-1');
  });

  it('uses us-east-1 as the per-site bucket region when config and env omit region', async () => {
    context.env = {};
    const site = makeSite('site-default-region', 'https://default-region.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'cloudflare' } } });
    s3SendStub.resolves({
      CommonPrefixes: [{ Prefix: 'aggregated/site-default-region/2026/04/21/23/' }],
    });

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(s3SendStub.firstCall.args[0].params.Bucket)
      .to.equal('spacecat-prod-cdn-logs-aggregates-us-east-1');
  });

  it('reports per-site S3 error in the errors section', async () => {
    const site = makeSite('site-err', 'https://s3error.com');
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    // S3 listing throws → triggers per-site catch block
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

  it('chunks output when report exceeds the Slack message limit', async () => {
    // 30 sites, all incomplete with many missing hours → long report
    const sites = Array.from({ length: 30 }, (_, i) => makeSite(
      `site-${i}`,
      `https://very-long-site-url-that-pads-output-number-${i}.example.com`,
    ));
    context.dataAccess.Site.all.resolves(sites);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    // Return only 2 hours → 22 missing → each site produces a long line
    s3SendStub.resolves(makeS3ListResponse(['00', '01']));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    // Multiple say() calls due to chunking
    expect(slackContext.say.callCount).to.be.greaterThan(2);
    expect(slackContext.say.args.flat().every((message) => message.length <= 2800)).to.be.true;
  });

  it('splits a single oversized report line when file upload is unavailable', async () => {
    const site = makeSite('site-long-line', `https://${'a'.repeat(6200)}.example.com`);
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    s3SendStub.resolves(makeS3ListResponse(['00', '01']));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(slackContext.say.callCount).to.be.greaterThan(3);
    expect(slackContext.say.args.flat().every((message) => message.length <= 2800)).to.be.true;
  });

  it('uploads long all-site reports as a Slack file when a file client is available', async () => {
    attachSlackFileClient();
    const sites = Array.from({ length: 30 }, (_, i) => makeSite(
      `site-${i}`,
      `https://very-long-site-url-that-pads-output-number-${i}.example.com`,
    ));
    context.dataAccess.Site.all.resolves(sites);
    context.dataAccess.Configuration.findLatest.resolves({
      isHandlerEnabledForSite: sinon.stub().returns(true),
    });

    readConfigStub.resolves({ config: { cdnBucketConfig: { cdnProvider: 'fastly' } } });
    s3SendStub.resolves(makeS3ListResponse(['00', '01']));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(slackContext.client.files.getUploadURLExternal).to.have.been.calledOnce;
    expect(slackContext.client.files.completeUploadExternal).to.have.been.calledOnce;
    expect(slackContext.client.files.completeUploadExternal.firstCall.args[0].initial_comment)
      .to.equal('CDN logs aggregate status report for 2026-04-21');
  });

  it('handles unexpected top-level errors gracefully', async () => {
    context.dataAccess.Site.all.rejects(new Error('DB connection failed'));

    const cmd = CheckCdnLogsStatusCommand(context);
    await cmd.handleExecution(['2026-04-21'], slackContext);

    expect(context.log.error).to.have.been.called;
  });
});
