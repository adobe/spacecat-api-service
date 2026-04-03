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

/* eslint-env mocha */
/* eslint-disable max-classes-per-file */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import { SFNClient } from '@aws-sdk/client-sfn';
import { Config, DEFAULT_CONFIG } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import {
  resolvePayload,
  deltaEnableImports,
  deltaEnableAudits,
  enqueueSiteJobs,
  buildTeardownWorkflowInput,
  getParentAuditType,
  isScrapeRecent,
  buildOpportunityFreshnessMap,
  getAuditTypesToSkipForSite,
  runEphemeralRunBatch,
  PRESETS,
  MAX_BATCH_SITES,
} from '../../src/support/ephemeral-run-service.js';

use(sinonChai);

class MockPutObjectCommand {
  constructor(p) { this.input = p; }
}
class MockGetObjectCommand {
  constructor(p) { this.input = p; }
}
class MockListObjectsV2Command {
  constructor(p) { this.input = p; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockOrganization(overrides = {}) {
  return {
    getId: () => overrides.spacecatOrgId || 'org-sc-1',
    getImsOrgId: () => overrides.imsOrgId || 'ims-org-test@AdobeOrg',
    ...overrides,
  };
}

function createMockSite(siteId = 's-1', baseURL = 'https://example.com') {
  const importsState = [];
  const siteConfig = {
    getSlackConfig: () => ({}),
    getHandlers: () => ({}),
    getContentAiConfig: () => undefined,
    getImports: () => importsState,
    getFetchConfig: () => ({}),
    getBrandConfig: () => ({}),
    getBrandProfile: () => ({}),
    getCdnLogsConfig: () => ({}),
    getLlmoConfig: () => ({}),
    getTokowakaConfig: () => ({}),
    getEdgeOptimizeConfig: () => ({}),
    getCommerceLlmoConfig: () => ({}),
    enableImport: (type) => importsState.push({ type, enabled: true }),
    disableImport: (type) => {
      const idx = importsState.findIndex((i) => i.type === type);
      if (idx >= 0) importsState.splice(idx, 1);
    },
  };
  return {
    getId: () => siteId,
    getBaseURL: () => baseURL,
    getOrganizationId: () => 'org-sc-1',
    getConfig: () => siteConfig,
    setConfig: sinon.stub().returnsThis(),
    save: sinon.stub().resolves(),
    getSiteTopPagesBySourceAndGeo: sinon.stub().resolves([
      { getUrl: () => `${baseURL}/page1` },
      { getUrl: () => `${baseURL}/page2` },
    ]),
    importsState,
  };
}

function createMockConfiguration() {
  const enabled = new Map();
  return {
    isHandlerEnabledForSite: (type, site) => {
      const key = `${type}:${site.getId()}`;
      return enabled.has(key);
    },
    enableHandlerForSite: (type, site) => {
      enabled.set(`${type}:${site.getId()}`, true);
    },
    disableHandlerForSite: (type, site) => {
      enabled.delete(`${type}:${site.getId()}`);
    },
    save: sinon.stub().resolves(),
    getQueues: () => ({ imports: 'import-queue-url', audits: 'audit-queue-from-config' }),
    _enabled: enabled,
  };
}

function createMockContext(overrides = {}) {
  const { dataAccess: dataAccessOverrides, ...restOverrides } = overrides;
  return {
    dataAccess: {
      Site: { findById: sinon.stub() },
      Configuration: { findLatest: sinon.stub() },
      Organization: { findById: sinon.stub().resolves(createMockOrganization()) },
      LatestAudit: { allBySiteIdAndAuditType: sinon.stub().resolves([]) },
      Opportunity: { allBySiteId: sinon.stub().resolves([]) },
      ...(dataAccessOverrides || {}),
    },
    sqs: { sendMessage: sinon.stub().resolves() },
    scrapeClient: { createScrapeJob: sinon.stub().resolves({ jobId: 'test-scrape-job' }) },
    s3: {
      s3Client: { send: sinon.stub().resolves() },
      s3Bucket: 'test-bucket',
      PutObjectCommand: MockPutObjectCommand,
      GetObjectCommand: MockGetObjectCommand,
      ListObjectsV2Command: MockListObjectsV2Command,
    },
    env: {
      AUDIT_JOBS_QUEUE_URL: 'audit-queue-url',
      EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:teardown',
    },
    log: {
      info: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
      debug: sinon.stub(),
    },
    ...restOverrides,
  };
}

describe('ephemeral-run-service', () => {
  let sfnSendStub;

  beforeEach(() => {
    sfnSendStub = sinon.stub(SFNClient.prototype, 'send').resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // resolvePayload
  // -----------------------------------------------------------------------
  describe('resolvePayload()', () => {
    it('resolves insights-report-default preset with defaults', () => {
      const result = resolvePayload({ preset: 'insights-report-default' });
      expect(result.imports.types).to.deep.equal(PRESETS['insights-report-default'].imports.types);
      expect(result.audits.types).to.deep.equal(PRESETS['insights-report-default'].audits.types);
      expect(result.teardownDelaySeconds).to.equal(14400);
    });

    it('uses explicit types over preset', () => {
      const result = resolvePayload({
        preset: 'insights-report-default',
        imports: { types: ['top-pages'] },
        audits: { types: ['lhs-mobile'] },
      });
      expect(result.imports.types).to.deep.equal(['top-pages']);
      expect(result.audits.types).to.deep.equal(['lhs-mobile']);
    });

    it('falls back to preset import types when body imports.types is null', () => {
      const result = resolvePayload({
        preset: 'insights-report-default',
        imports: { types: null },
      });
      expect(result.imports.types).to.deep.equal(PRESETS['insights-report-default'].imports.types);
    });

    it('uses empty arrays when no preset and no explicit types', () => {
      const result = resolvePayload({});
      expect(result.imports.types).to.deep.equal([]);
      expect(result.audits.types).to.deep.equal([]);
      expect(result.imports.trafficAnalysisWeeks).to.equal(0);
    });

    it('defaults trafficAnalysisWeeks when traffic-analysis is requested without weeks', () => {
      const result = resolvePayload({ imports: { types: ['traffic-analysis'] } });
      expect(result.imports.trafficAnalysisWeeks).to.equal(52);
    });

    it('does not override explicit trafficAnalysisWeeks 0 when traffic-analysis is requested', () => {
      const result = resolvePayload({
        imports: { types: ['traffic-analysis'], trafficAnalysisWeeks: 0 },
      });
      expect(result.imports.trafficAnalysisWeeks).to.equal(0);
    });

    it('does not override explicit optionsByImportType backfillWeeks 0', () => {
      const result = resolvePayload({
        imports: {
          types: ['traffic-analysis'],
          optionsByImportType: {
            'traffic-analysis': { backfillWeeks: 0 },
          },
        },
      });
      expect(result.imports.trafficAnalysisWeeks).to.equal(0);
    });

    it('resolves insights-report-default traffic-analysis options from optionsByImportType', () => {
      const result = resolvePayload({ preset: 'insights-report-default' });
      expect(result.imports.types).to.include('traffic-analysis');
      expect(result.imports.trafficAnalysisWeeks).to.equal(5);
      expect(result.imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(5);
    });

    it('body optionsByImportType overrides preset traffic-analysis backfillWeeks', () => {
      const result = resolvePayload({
        preset: 'insights-report-default',
        imports: {
          optionsByImportType: {
            'traffic-analysis': { backfillWeeks: 12 },
          },
        },
      });
      expect(result.imports.trafficAnalysisWeeks).to.equal(12);
      expect(result.imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(12);
    });

    it('ignores preset traffic-analysis backfill when types omit traffic-analysis', () => {
      const result = resolvePayload({
        preset: 'insights-report-default',
        imports: { types: ['top-pages'] },
      });
      expect(result.imports.trafficAnalysisWeeks).to.equal(0);
    });

    it('clamps teardown delay to max 86400', () => {
      const result = resolvePayload({ teardown: { delaySeconds: 200000 } });
      expect(result.teardownDelaySeconds).to.equal(86400);
    });

    it('clamps negative teardown delay to 0', () => {
      const result = resolvePayload({ teardown: { delaySeconds: -100 } });
      expect(result.teardownDelaySeconds).to.equal(0);
    });

    it('falls through all branches when no preset and body sections are empty objects', () => {
      const result = resolvePayload({ imports: {}, audits: {} });
      expect(result.imports.types).to.deep.equal([]);
      expect(result.audits.types).to.deep.equal([]);
    });

    it('uses explicit trafficAnalysisWeeks when traffic-analysis is in types', () => {
      const result = resolvePayload({ imports: { types: ['traffic-analysis'], trafficAnalysisWeeks: 3 } });
      expect(result.imports.trafficAnalysisWeeks).to.equal(3);
    });

    it('ignores trafficAnalysisWeeks when traffic-analysis is not in types', () => {
      const result = resolvePayload({ imports: { trafficAnalysisWeeks: 3 } });
      expect(result.imports.trafficAnalysisWeeks).to.equal(0);
    });

    it('sets forceRun=false by default', () => {
      const result = resolvePayload({});
      expect(result.forceRun).to.equal(false);
    });

    it('sets forceRun=true when body.forceRun is true', () => {
      const result = resolvePayload({ forceRun: true });
      expect(result.forceRun).to.equal(true);
    });

    it('sets forceRunSiteIds to empty Set by default', () => {
      const result = resolvePayload({});
      expect(result.forceRunSiteIds.size).to.equal(0);
    });

    it('populates forceRunSiteIds from body array', () => {
      const result = resolvePayload({ forceRunSiteIds: ['s-1', 's-2'] });
      expect(result.forceRunSiteIds.has('s-1')).to.equal(true);
      expect(result.forceRunSiteIds.has('s-2')).to.equal(true);
      expect(result.forceRunSiteIds.size).to.equal(2);
    });

    it('ignores non-array forceRunSiteIds', () => {
      const result = resolvePayload({ forceRunSiteIds: 's-1' });
      expect(result.forceRunSiteIds.size).to.equal(0);
    });

    it('defaults scrapeFreshnessDays to 30 when not provided', () => {
      const result = resolvePayload({});
      expect(result.scrapeFreshnessDays).to.equal(30);
    });

    it('defaults opportunityFreshnessDays to 7 when not provided', () => {
      const result = resolvePayload({});
      expect(result.opportunityFreshnessDays).to.equal(7);
    });

    it('accepts custom scrapeFreshnessDays from body.freshness.scrapeDays', () => {
      const result = resolvePayload({ freshness: { scrapeDays: 10 } });
      expect(result.scrapeFreshnessDays).to.equal(10);
    });

    it('accepts custom opportunityFreshnessDays from body.freshness.opportunityDays', () => {
      const result = resolvePayload({ freshness: { opportunityDays: 3 } });
      expect(result.opportunityFreshnessDays).to.equal(3);
    });

    it('ignores non-numeric freshness values and falls back to defaults', () => {
      const result = resolvePayload({ freshness: { scrapeDays: 'ten', opportunityDays: null } });
      expect(result.scrapeFreshnessDays).to.equal(30);
      expect(result.opportunityFreshnessDays).to.equal(7);
    });

    it('legacy trafficAnalysisWeeks wins over optionsByImportType.backfillWeeks when both are provided', () => {
      const result = resolvePayload({
        imports: {
          types: ['traffic-analysis'],
          trafficAnalysisWeeks: 3,
          optionsByImportType: { 'traffic-analysis': { backfillWeeks: 10 } },
        },
      });
      // trafficAnalysisWeeks (legacy) is applied AFTER optionsByImportType merge and overrides it
      expect(result.imports.trafficAnalysisWeeks).to.equal(3);
      expect(result.imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(3);
    });

    it('body optionsByImportType merges with preset — body wins on conflict and custom keys survive', () => {
      const result = resolvePayload({
        preset: 'insights-report-default',
        imports: {
          optionsByImportType: {
            'traffic-analysis': { backfillWeeks: 8, customParam: 'kept' },
          },
        },
      });
      expect(result.imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(8);
      expect(result.imports.optionsByImportType['traffic-analysis'].customParam).to.equal('kept');
    });

    it('teardown delaySeconds: 0 stays 0 (is NOT replaced by default 14400)', () => {
      const result = resolvePayload({ teardown: { delaySeconds: 0 } });
      expect(result.teardownDelaySeconds).to.equal(0);
    });

    it('teardown delaySeconds: 86400 stays at max boundary', () => {
      const result = resolvePayload({ teardown: { delaySeconds: 86400 } });
      expect(result.teardownDelaySeconds).to.equal(86400);
    });

    it('teardown delaySeconds: 86401 clamps to 86400', () => {
      const result = resolvePayload({ teardown: { delaySeconds: 86401 } });
      expect(result.teardownDelaySeconds).to.equal(86400);
    });

    it('forceRun: false (explicit boolean) remains false', () => {
      const result = resolvePayload({ forceRun: false });
      expect(result.forceRun).to.equal(false);
    });

    it('forceRun: "true" (string) is NOT treated as true — strict === true check applies', () => {
      const result = resolvePayload({ forceRun: 'true' });
      expect(result.forceRun).to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // deltaEnableImports
  // -----------------------------------------------------------------------
  describe('deltaEnableImports()', () => {
    it('enables imports not already enabled', () => {
      const site = createMockSite();
      const result = deltaEnableImports(site, ['top-pages', 'code']);
      expect(result.importsEnabled).to.deep.equal(['top-pages', 'code']);
      expect(result.importsAlreadyEnabled).to.deep.equal([]);
    });

    it('skips already enabled imports', () => {
      const site = createMockSite();
      site.importsState.push({ type: 'top-pages', enabled: true });
      const result = deltaEnableImports(site, ['top-pages', 'code']);
      expect(result.importsEnabled).to.deep.equal(['code']);
      expect(result.importsAlreadyEnabled).to.deep.equal(['top-pages']);
    });

    it('handles empty import types', () => {
      const site = createMockSite();
      const result = deltaEnableImports(site, []);
      expect(result.importsEnabled).to.deep.equal([]);
      expect(result.importsAlreadyEnabled).to.deep.equal([]);
    });

    it('treats disabled imports as not enabled', () => {
      const site = createMockSite();
      site.importsState.push({ type: 'top-pages', enabled: false });
      const result = deltaEnableImports(site, ['top-pages']);
      expect(result.importsEnabled).to.deep.equal(['top-pages']);
    });

    it('enables traffic-analysis on real Config (run options are enqueue-only, not passed to enableImport)', () => {
      const siteConfig = Config({ ...DEFAULT_CONFIG, imports: [] });
      const site = { getConfig: () => siteConfig };
      const result = deltaEnableImports(site, ['traffic-analysis']);
      expect(result.importsEnabled).to.deep.equal(['traffic-analysis']);
      const ta = siteConfig.getImports().find((i) => i.type === 'traffic-analysis');
      expect(ta).to.exist;
    });
  });

  // -----------------------------------------------------------------------
  // deltaEnableAudits
  // -----------------------------------------------------------------------
  describe('deltaEnableAudits()', () => {
    it('enables audits not already enabled', () => {
      const config = createMockConfiguration();
      const site = createMockSite();
      const result = deltaEnableAudits(config, site, ['lhs-mobile', 'accessibility']);
      expect(result.auditsEnabled).to.deep.equal(['lhs-mobile', 'accessibility']);
      expect(result.auditsAlreadyEnabled).to.deep.equal([]);
    });

    it('skips already enabled audits', () => {
      const config = createMockConfiguration();
      const site = createMockSite();
      config.enableHandlerForSite('lhs-mobile', site);
      const result = deltaEnableAudits(config, site, ['lhs-mobile', 'accessibility']);
      expect(result.auditsEnabled).to.deep.equal(['accessibility']);
      expect(result.auditsAlreadyEnabled).to.deep.equal(['lhs-mobile']);
    });
  });

  // -----------------------------------------------------------------------
  // enqueueSiteJobs
  // -----------------------------------------------------------------------
  describe('enqueueSiteJobs()', () => {
    it('enqueues imports and audits', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: ['top-pages'] }, audits: { types: ['lhs-mobile'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(result.enqueued.imports).to.have.length(1);
      expect(result.enqueued.audits).to.have.length(1);
      expect(result.skipped).to.be.empty;
      const auditCall = ctx.sqs.sendMessage.getCalls().find((c) => c.args[0] === 'audit-queue-url');
      expect(auditCall).to.exist;
      expect(auditCall.args[1].auditContext).to.deep.equal({
        onDemand: true,
        slackContext: { channelId: '', threadTs: '' },
      });
    });

    it('enqueues traffic analysis backfill', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: ['traffic-analysis'], trafficAnalysisWeeks: 3 } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      const trafficEntries = result.enqueued.imports.filter((e) => e.type === 'traffic-analysis');
      expect(trafficEntries).to.have.length(3);
      expect(trafficEntries[0]).to.have.property('week');
      expect(trafficEntries[0]).to.have.property('year');
    });

    it('enqueues traffic-analysis via backfill only (no duplicate triggerImportRun) when trafficAnalysisWeeks > 0', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: ['traffic-analysis'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      // Only the 52 backfill week entries — no extra triggerImportRun for traffic-analysis
      const trafficEntries = result.enqueued.imports.filter((e) => e.type === 'traffic-analysis');
      expect(trafficEntries).to.have.length(52);
      expect(trafficEntries[0]).to.have.property('week');
      expect(trafficEntries[0]).to.have.property('year');
    });

    it('records skipped imports on failure', async () => {
      const ctx = createMockContext();
      ctx.sqs.sendMessage.rejects(new Error('SQS down'));
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: ['top-pages'] }, audits: { types: [] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(result.skipped).to.have.length(1);
      expect(result.skipped[0].kind).to.equal('import');
    });

    it('records skipped audits on failure', async () => {
      const ctx = createMockContext();
      ctx.sqs.sendMessage.rejects(new Error('SQS down'));
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['lhs-mobile'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(result.skipped).to.have.length(1);
      expect(result.skipped[0].kind).to.equal('audit');
    });

    it('records skipped traffic analysis on failure', async () => {
      const ctx = createMockContext();
      ctx.sqs.sendMessage.rejects(new Error('SQS down'));
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: ['traffic-analysis'], trafficAnalysisWeeks: 2 } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(result.skipped.some((s) => s.type === 'traffic-analysis')).to.be.true;
    });

    it('uses AUDIT_JOBS_QUEUE_URL for audits, not configuration.getQueues().audits', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();

      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['lhs-mobile'] } });
      await enqueueSiteJobs('s-1', resolved, config, ctx);

      const auditCall = ctx.sqs.sendMessage.getCalls().find((c) => c.args[0] === 'audit-queue-url');
      expect(auditCall).to.exist;
      const configQueueCall = ctx.sqs.sendMessage.getCalls().find(
        (c) => c.args[0] === 'audit-queue-from-config',
      );
      expect(configQueueCall).to.be.undefined;
    });

    it('records skipped audits when AUDIT_JOBS_QUEUE_URL is missing', async () => {
      const ctx = createMockContext();
      delete ctx.env.AUDIT_JOBS_QUEUE_URL;
      const config = createMockConfiguration();
      const resolved = resolvePayload({
        imports: { types: [] },
        audits: { types: ['lhs-mobile', 'accessibility'] },
      });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(ctx.log.error).to.have.been.calledWithMatch(/No audit queue URL/);
      expect(result.skipped).to.have.length(2);
      expect(result.skipped.every((s) => s.reason === 'Missing audit jobs queue URL')).to.be.true;
      expect(ctx.sqs.sendMessage).to.not.have.been.called;
    });

    it('normalizes undefined channelId and null threadTs on audit slackContext', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['lhs-mobile'] } });
      await enqueueSiteJobs('s-1', resolved, config, ctx, {
        channelId: undefined,
        threadTs: null,
      });
      const auditCall = ctx.sqs.sendMessage.getCalls().find((c) => c.args[0] === 'audit-queue-url');
      expect(auditCall.args[1].auditContext.slackContext).to.deep.equal({
        channelId: '',
        threadTs: '',
      });
    });

    it('sets onDemand: true in auditContext for all preset audit types', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      const resolved = resolvePayload({ preset: 'insights-report-default' });

      await enqueueSiteJobs('s-1', resolved, config, ctx);

      const auditCalls = ctx.sqs.sendMessage.getCalls().filter((c) => c.args[0] === 'audit-queue-url');
      expect(auditCalls.length).to.be.greaterThan(0);
      auditCalls.forEach((call) => {
        expect(call.args[1].auditContext.onDemand).to.equal(true);
      });
    });

    it('routes scrape-top-pages to ScrapeClient, not AUDIT_JOBS_QUEUE_URL', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(ctx.scrapeClient.createScrapeJob).to.have.been.calledOnce;
      const jobArg = ctx.scrapeClient.createScrapeJob.firstCall.args[0];
      expect(jobArg.processingType).to.equal('default');
      expect(jobArg.urls).to.deep.equal(['https://example.com/page1', 'https://example.com/page2']);
      expect(jobArg.maxScrapeAge).to.equal(0);
      const auditSqsCall = ctx.sqs.sendMessage.getCalls().find((c) => c.args[1]?.type === 'scrape-top-pages');
      expect(auditSqsCall).to.be.undefined;
      expect(result.enqueued.audits).to.deep.equal([{ type: 'scrape-top-pages', status: 'queued' }]);
    });

    it('includes slackContext in scrape job metadata', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      await enqueueSiteJobs('s-1', resolved, config, ctx, { channelId: 'C123', threadTs: '1234.5' });

      const jobArg = ctx.scrapeClient.createScrapeJob.firstCall.args[0];
      expect(jobArg.metaData.slackData).to.deep.equal({ channel: 'C123', thread_ts: '1234.5' });
    });

    it('defaults slackContext channelId and threadTs to empty string when null', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      await enqueueSiteJobs('s-1', resolved, config, ctx, { channelId: null, threadTs: null });

      const jobArg = ctx.scrapeClient.createScrapeJob.firstCall.args[0];
      expect(jobArg.metaData.slackData).to.deep.equal({ channel: '', thread_ts: '' });
    });

    it('skips scrape-top-pages when site is not found', async () => {
      const ctx = createMockContext();
      ctx.dataAccess.Site.findById.resolves(null);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(ctx.scrapeClient.createScrapeJob).to.not.have.been.called;
      expect(result.skipped).to.deep.equal([{ type: 'scrape-top-pages', kind: 'audit', reason: 'Site not found' }]);
    });

    it('skips scrape-top-pages when site has no top pages', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      site.getSiteTopPagesBySourceAndGeo.resolves([]);
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(ctx.scrapeClient.createScrapeJob).to.not.have.been.called;
      expect(result.skipped).to.deep.equal([{ type: 'scrape-top-pages', kind: 'audit', reason: 'No top pages found' }]);
    });

    it('skips scrape-top-pages when getSiteTopPagesBySourceAndGeo returns null', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      site.getSiteTopPagesBySourceAndGeo.resolves(null);
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(ctx.scrapeClient.createScrapeJob).to.not.have.been.called;
      expect(result.skipped).to.deep.equal([{ type: 'scrape-top-pages', kind: 'audit', reason: 'No top pages found' }]);
    });

    it('records error when ScrapeClient.createScrapeJob throws', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.scrapeClient.createScrapeJob.rejects(new Error('scraper unavailable'));
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(result.skipped).to.deep.equal([{ type: 'scrape-top-pages', kind: 'audit', reason: 'scraper unavailable' }]);
    });

    it('enqueues scrape-top-pages via ScrapeClient and other audits via AUDIT_JOBS_QUEUE_URL', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages', 'lhs-mobile'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      expect(ctx.scrapeClient.createScrapeJob).to.have.been.calledOnce;
      const auditSqsCalls = ctx.sqs.sendMessage.getCalls().filter((c) => c.args[0] === 'audit-queue-url');
      expect(auditSqsCalls).to.have.length(1);
      expect(auditSqsCalls[0].args[1].type).to.equal('lhs-mobile');
      expect(result.enqueued.audits.map((a) => a.type)).to.include('scrape-top-pages');
      expect(result.enqueued.audits.map((a) => a.type)).to.include('lhs-mobile');
    });

    it('enqueues traffic-analysis via triggerImportRun (not backfill) when trafficAnalysisWeeks is explicit 0', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      // trafficAnalysisWeeks=0 explicitly: no backfill loop runs, but traffic-analysis in types
      const resolved = resolvePayload({
        imports: { types: ['traffic-analysis'], trafficAnalysisWeeks: 0 },
      });
      expect(resolved.imports.trafficAnalysisWeeks).to.equal(0);

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      // With weeks=0, no backfill entries. traffic-analysis in types → triggerImportRun path.
      const trafficEntries = result.enqueued.imports.filter((e) => e.type === 'traffic-analysis');
      expect(trafficEntries).to.have.length(1);
      // Should be a regular enqueue, not backfill weeks
      expect(trafficEntries[0]).to.not.have.property('week');
    });
  });

  // -----------------------------------------------------------------------
  // enqueueSiteJobs — ScrapeClient.createFrom fallback
  // -----------------------------------------------------------------------
  describe('enqueueSiteJobs() — ScrapeClient.createFrom fallback', () => {
    it('falls back to ScrapeClient.createFrom when scrapeClient is not in context', async () => {
      const mockCreateScrapeJob = sinon.stub().resolves();
      const MockScrapeClient = {
        createFrom: sinon.stub().returns({ createScrapeJob: mockCreateScrapeJob }),
      };

      const { enqueueSiteJobs: enqueueSiteJobsWithMock } = await esmock(
        '../../src/support/ephemeral-run-service.js',
        { '@adobe/spacecat-shared-scrape-client': { ScrapeClient: MockScrapeClient } },
      );

      const ctx = createMockContext();
      delete ctx.scrapeClient;
      const site = createMockSite();
      ctx.dataAccess.Site.findById.resolves(site);
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: [] }, audits: { types: ['scrape-top-pages'] } });

      const result = await enqueueSiteJobsWithMock('s-1', resolved, config, ctx);

      expect(MockScrapeClient.createFrom).to.have.been.calledOnce;
      expect(mockCreateScrapeJob).to.have.been.calledOnce;
      expect(result.enqueued.audits).to.deep.equal([{ type: 'scrape-top-pages', status: 'queued' }]);
    });
  });

  // -----------------------------------------------------------------------
  // buildTeardownWorkflowInput
  // -----------------------------------------------------------------------
  describe('buildTeardownWorkflowInput()', () => {
    const baseSites = [
      {
        siteId: 's-1',
        siteUrl: 'https://example.com',
        importTypes: ['top-pages'],
        auditTypes: ['lhs-mobile'],
      },
    ];

    it('builds bulkDisableJob with sites and taskContext', () => {
      const input = buildTeardownWorkflowInput({
        sites: baseSites,
        slackContext: { channelId: 'C1', threadTs: 't1' },
        workflowWaitTime: 3600,
      });
      expect(input.workflowWaitTime).to.equal(3600);
      expect(input.bulkDisableJob.type).to.equal('bulk-disable-import-audit-processor');
      expect(input.bulkDisableJob.sites).to.deep.equal(baseSites);
      expect(input.bulkDisableJob.taskContext.slackContext).to.deep.equal({
        channelId: 'C1',
        threadTs: 't1',
      });
    });

    it('fills slack with empty strings when slackContext omits channelId and threadTs', () => {
      const input = buildTeardownWorkflowInput({
        sites: baseSites,
        slackContext: {},
        workflowWaitTime: 3600,
      });
      expect(input.bulkDisableJob.taskContext.slackContext).to.deep.equal({
        channelId: '',
        threadTs: '',
      });
    });

    it('defaults scheduledRun to false', () => {
      const input = buildTeardownWorkflowInput({
        sites: baseSites,
        workflowWaitTime: 3600,
      });
      expect(input.bulkDisableJob.taskContext.scheduledRun).to.equal(false);
    });
  });

  // -----------------------------------------------------------------------
  // getParentAuditType
  // -----------------------------------------------------------------------
  describe('getParentAuditType()', () => {
    it('maps -auto-suggest-mystique variant to parent', () => {
      expect(getParentAuditType('alt-text-auto-suggest-mystique')).to.equal('alt-text');
    });

    it('maps -auto-suggest variant to parent', () => {
      expect(getParentAuditType('broken-backlinks-auto-suggest')).to.equal('broken-backlinks');
      expect(getParentAuditType('broken-internal-links-auto-suggest')).to.equal('broken-internal-links');
      expect(getParentAuditType('meta-tags-auto-suggest')).to.equal('meta-tags');
      expect(getParentAuditType('security-vulnerabilities-auto-suggest')).to.equal('security-vulnerabilities');
      expect(getParentAuditType('security-csp-auto-suggest')).to.equal('security-csp');
    });

    it('maps data-collection audits to security-csp parent (lhs-mobile)', () => {
      expect(getParentAuditType('lhs-mobile')).to.equal('security-csp');
    });

    it('returns paid unchanged (paid opportunity mapping is in LOCAL_OPPORTUNITY_MAP, not AUDIT_PARENT_MAP)', () => {
      expect(getParentAuditType('paid')).to.equal('paid');
    });

    it('returns type unchanged when no explicit mapping exists', () => {
      expect(getParentAuditType('cwv')).to.equal('cwv');
      expect(getParentAuditType('meta-tags')).to.equal('meta-tags');
      expect(getParentAuditType('unknown-type')).to.equal('unknown-type');
    });
  });

  // -----------------------------------------------------------------------
  // isScrapeRecent
  // -----------------------------------------------------------------------
  describe('isScrapeRecent()', () => {
    const log = { warn: sinon.stub(), info: sinon.stub() };

    it('returns false when no scrape audit record exists', async () => {
      const LatestAudit = { allBySiteIdAndAuditType: sinon.stub().resolves([]) };
      expect(await isScrapeRecent('s-1', LatestAudit, log)).to.equal(false);
    });

    it('returns false when the scrape record is older than 30 days', async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const LatestAudit = {
        allBySiteIdAndAuditType: sinon.stub().resolves([{ getAuditedAt: () => oldDate }]),
      };
      expect(await isScrapeRecent('s-1', LatestAudit, log)).to.equal(false);
    });

    it('returns true when the scrape record is within 30 days', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const LatestAudit = {
        allBySiteIdAndAuditType: sinon.stub().resolves([{ getAuditedAt: () => recentDate }]),
      };
      expect(await isScrapeRecent('s-1', LatestAudit, log)).to.equal(true);
    });

    it('returns false and warns when the query throws', async () => {
      const warnStub = sinon.stub();
      const LatestAudit = {
        allBySiteIdAndAuditType: sinon.stub().rejects(new Error('DB error')),
      };
      const result = await isScrapeRecent('s-1', LatestAudit, { warn: warnStub, info: sinon.stub() });
      expect(result).to.equal(false);
      expect(warnStub).to.have.been.called;
    });
  });

  // -----------------------------------------------------------------------
  // buildOpportunityFreshnessMap
  // -----------------------------------------------------------------------
  describe('buildOpportunityFreshnessMap()', () => {
    const log = { warn: sinon.stub(), info: sinon.stub() };

    it('returns empty map when site has no opportunities', async () => {
      const Opportunity = { allBySiteId: sinon.stub().resolves([]) };
      const map = await buildOpportunityFreshnessMap('s-1', Opportunity, log);
      expect(map.size).to.equal(0);
    });

    it('builds a map of opportunityType → updatedAt Date', async () => {
      const date = new Date('2026-01-15T00:00:00Z');
      const Opportunity = {
        allBySiteId: sinon.stub().resolves([
          { getType: () => 'cwv', getUpdatedAt: () => date.toISOString() },
        ]),
      };
      const map = await buildOpportunityFreshnessMap('s-1', Opportunity, log);
      expect(map.get('cwv').getTime()).to.equal(date.getTime());
    });

    it('keeps the newest updatedAt when multiple opportunities share a type', async () => {
      const older = new Date('2026-01-01T00:00:00Z');
      const newer = new Date('2026-01-20T00:00:00Z');
      const Opportunity = {
        allBySiteId: sinon.stub().resolves([
          { getType: () => 'cwv', getUpdatedAt: () => older.toISOString() },
          { getType: () => 'cwv', getUpdatedAt: () => newer.toISOString() },
        ]),
      };
      const map = await buildOpportunityFreshnessMap('s-1', Opportunity, log);
      expect(map.get('cwv').getTime()).to.equal(newer.getTime());
    });

    it('returns empty map and warns when the query throws', async () => {
      const warnStub = sinon.stub();
      const Opportunity = { allBySiteId: sinon.stub().rejects(new Error('DB error')) };
      const map = await buildOpportunityFreshnessMap('s-1', Opportunity, { warn: warnStub, info: sinon.stub() });
      expect(map.size).to.equal(0);
      expect(warnStub).to.have.been.called;
    });
  });

  // -----------------------------------------------------------------------
  // getAuditTypesToSkipForSite
  // -----------------------------------------------------------------------
  describe('getAuditTypesToSkipForSite()', () => {
    const log = { warn: sinon.stub(), info: sinon.stub() };

    function makeDataAccess({ scrapeAuditedAt = null, opportunities = [] } = {}) {
      const scrapeRecord = scrapeAuditedAt
        ? [{ getAuditedAt: () => scrapeAuditedAt }]
        : [];
      return {
        LatestAudit: { allBySiteIdAndAuditType: sinon.stub().resolves(scrapeRecord) },
        Opportunity: { allBySiteId: sinon.stub().resolves(opportunities) },
      };
    }

    it('adds scrape-top-pages to skip set when scrape is recent', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({ scrapeAuditedAt: recentDate });
      const skip = await getAuditTypesToSkipForSite('s-1', ['scrape-top-pages'], da, log);
      expect(skip.has('scrape-top-pages')).to.equal(true);
    });

    it('does NOT skip scrape-top-pages when scrape is stale', async () => {
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({ scrapeAuditedAt: oldDate });
      const skip = await getAuditTypesToSkipForSite('s-1', ['scrape-top-pages'], da, log);
      expect(skip.has('scrape-top-pages')).to.equal(false);
    });

    it('adds cwv to skip set when cwv opportunity is fresh', async () => {
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'cwv', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['cwv'], da, log);
      expect(skip.has('cwv')).to.equal(true);
    });

    it('does NOT skip cwv when cwv opportunity is stale', async () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'cwv', getUpdatedAt: () => oldDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['cwv'], da, log);
      expect(skip.has('cwv')).to.equal(false);
    });

    it('skips broken-backlinks-auto-suggest when parent broken-backlinks opportunity is fresh', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'broken-backlinks', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['broken-backlinks-auto-suggest'], da, log);
      expect(skip.has('broken-backlinks-auto-suggest')).to.equal(true);
    });

    it('skips alt-text-auto-suggest-mystique when alt-text opportunity is fresh', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'alt-text', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['alt-text-auto-suggest-mystique'], da, log);
      expect(skip.has('alt-text-auto-suggest-mystique')).to.equal(true);
    });

    it('does NOT skip forms-opportunities when only some mapped opportunities are fresh', async () => {
      // ALL mapped opportunity types must be fresh to skip — missing counts as stale
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [
          { getType: () => 'high-form-views-low-conversions', getUpdatedAt: () => recentDate },
          // other 3 mapped types missing → treated as stale → audit runs
        ],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['forms-opportunities'], da, log);
      expect(skip.has('forms-opportunities')).to.equal(false);
    });

    it('skips accessibility when both a11y-assistive and a11y-color-contrast are fresh', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [
          { getType: () => 'a11y-assistive', getUpdatedAt: () => recentDate },
          { getType: () => 'a11y-color-contrast', getUpdatedAt: () => recentDate },
        ],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['accessibility'], da, log);
      expect(skip.has('accessibility')).to.equal(true);
    });

    it('does NOT skip accessibility when a11y-assistive is fresh but a11y-color-contrast is stale', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [
          { getType: () => 'a11y-assistive', getUpdatedAt: () => recentDate },
          { getType: () => 'a11y-color-contrast', getUpdatedAt: () => oldDate },
        ],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['accessibility'], da, log);
      expect(skip.has('accessibility')).to.equal(false);
    });

    it('does NOT skip accessibility when a11y-assistive is fresh but a11y-color-contrast was never created', async () => {
      // Missing mapped type counts as stale → audit runs
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [
          { getType: () => 'a11y-assistive', getUpdatedAt: () => recentDate },
        ],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['accessibility'], da, log);
      expect(skip.has('accessibility')).to.equal(false);
    });

    it('does NOT skip accessibility when neither a11y opportunity has ever been created', async () => {
      const da = makeDataAccess({ opportunities: [] });
      const skip = await getAuditTypesToSkipForSite('s-1', ['accessibility'], da, log);
      expect(skip.has('accessibility')).to.equal(false);
    });

    it('does NOT skip audit types with no opportunity mapping', async () => {
      // e.g. a custom audit type not in AUDIT_OPPORTUNITY_MAP
      const da = makeDataAccess();
      const skip = await getAuditTypesToSkipForSite('s-1', ['unknown-audit-type'], da, log);
      expect(skip.has('unknown-audit-type')).to.equal(false);
    });

    it('returns empty skip set when no audits are fresh', async () => {
      const da = makeDataAccess();
      const skip = await getAuditTypesToSkipForSite('s-1', ['cwv', 'meta-tags'], da, log);
      expect(skip.size).to.equal(0);
    });

    it('respects custom scrapeFreshnessDays — skips scrape when within custom window', async () => {
      // 10-day-old scrape: stale under default 30d, but inside custom 15d window
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({ scrapeAuditedAt: tenDaysAgo });
      const skip = await getAuditTypesToSkipForSite('s-1', ['scrape-top-pages'], da, log, false, 15);
      expect(skip.has('scrape-top-pages')).to.equal(true);
    });

    it('respects custom scrapeFreshnessDays — runs scrape when outside custom window', async () => {
      // 20-day-old scrape: fresh under default 30d, but outside custom 15d window
      const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({ scrapeAuditedAt: twentyDaysAgo });
      const skip = await getAuditTypesToSkipForSite('s-1', ['scrape-top-pages'], da, log, false, 15);
      expect(skip.has('scrape-top-pages')).to.equal(false);
    });

    it('respects custom opportunityFreshnessDays — skips when within custom window', async () => {
      // 3-day-old opportunity: fresh under default 7d and custom 5d
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'cwv', getUpdatedAt: () => threeDaysAgo }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['cwv'], da, log, false, 30, 5);
      expect(skip.has('cwv')).to.equal(true);
    });

    it('respects custom opportunityFreshnessDays — runs when outside custom window', async () => {
      // 4-day-old opportunity: fresh under default 7d but stale under custom 3d
      const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'cwv', getUpdatedAt: () => fourDaysAgo }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['cwv'], da, log, false, 30, 3);
      expect(skip.has('cwv')).to.equal(false);
    });

    it('skips lhs-mobile when security-csp opportunity is fresh', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'security-csp', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['lhs-mobile', 'cwv'], da, log);
      expect(skip.has('lhs-mobile')).to.equal(true);
      expect(skip.has('cwv')).to.equal(false);
    });

    it('skips paid when consent-banner opportunity is fresh', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'consent-banner', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['paid', 'cwv'], da, log);
      expect(skip.has('paid')).to.equal(true);
      expect(skip.has('cwv')).to.equal(false);
    });

    it('does NOT skip paid when only security-csp opportunity is fresh (paid gates on consent-banner)', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        opportunities: [{ getType: () => 'security-csp', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['paid'], da, log);
      expect(skip.has('paid')).to.equal(false);
    });

    it('returns empty set immediately when forceRun is true', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({
        scrapeAuditedAt: recentDate,
        opportunities: [{ getType: () => 'cwv', getUpdatedAt: () => recentDate }],
      });
      const skip = await getAuditTypesToSkipForSite('s-1', ['scrape-top-pages', 'cwv'], da, log, true);
      expect(skip.size).to.equal(0);
      // dataAccess should not have been queried
      expect(da.LatestAudit.allBySiteIdAndAuditType).to.not.have.been.called;
      expect(da.Opportunity.allBySiteId).to.not.have.been.called;
    });

    it('does not query LatestAudit when scrape-top-pages is not in audit types', async () => {
      const da = makeDataAccess();
      await getAuditTypesToSkipForSite('s-1', ['cwv'], da, log);
      expect(da.LatestAudit.allBySiteIdAndAuditType).to.not.have.been.called;
    });

    it('does not query Opportunity when all audit types have no opportunity mapping', async () => {
      const da = makeDataAccess();
      // unknown-audit-type has no mapping → no opportunity fetch needed
      await getAuditTypesToSkipForSite('s-1', ['unknown-audit-type'], da, log);
      expect(da.Opportunity.allBySiteId).to.not.have.been.called;
    });

    it('queries both LatestAudit and Opportunity when both types are present', async () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const da = makeDataAccess({ scrapeAuditedAt: recentDate });
      await getAuditTypesToSkipForSite('s-1', ['scrape-top-pages', 'cwv'], da, log);
      expect(da.LatestAudit.allBySiteIdAndAuditType).to.have.been.called;
      expect(da.Opportunity.allBySiteId).to.have.been.called;
    });
  });

  // -----------------------------------------------------------------------
  // runEphemeralRunBatch — audit skip integration
  // -----------------------------------------------------------------------
  describe('runEphemeralRunBatch() — audit skip logic', () => {
    it('enables scrape-top-pages in config but does not enqueue it to SQS when scrape is recent', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.dataAccess.LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditedAt: () => recentDate },
      ]);

      await runEphemeralRunBatch(['s-1'], { audits: { types: ['scrape-top-pages', 'cwv'] } }, ctx);

      // scrape-top-pages IS enabled in config (delta-enable still runs)
      expect(config.isHandlerEnabledForSite('scrape-top-pages', site)).to.equal(true);
      // but NOT sent to SQS
      const sqsCalls = ctx.sqs.sendMessage.getCalls().map((c) => c.args[1]?.type);
      expect(sqsCalls).to.not.include('scrape-top-pages');
      // cwv (no fresh opportunity) should still be enabled and enqueued
      expect(config.isHandlerEnabledForSite('cwv', site)).to.equal(true);
      expect(sqsCalls).to.include('cwv');

      // freshnessSkipped written to S3 site result
      const s3Calls = ctx.s3.s3Client.send.getCalls().map((c) => c.args[0]?.input);
      const siteResultCall = s3Calls.find((i) => i?.Key?.includes('/results/'));
      const siteResult = JSON.parse(siteResultCall.Body);
      expect(siteResult.freshnessSkipped).to.deep.equal([
        { type: 'scrape-top-pages', reason: 'scrape-fresh' },
      ]);
    });

    it('enqueues all audits when forceRun is true, ignoring freshness', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.dataAccess.LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditedAt: () => recentDate },
      ]);
      ctx.dataAccess.Opportunity.allBySiteId.resolves([
        { getType: () => 'cwv', getUpdatedAt: () => recentDate },
      ]);

      await runEphemeralRunBatch(
        ['s-1'],
        { audits: { types: ['scrape-top-pages', 'cwv'] }, forceRun: true },
        ctx,
      );

      expect(ctx.scrapeClient.createScrapeJob).to.have.been.called;
      const sqsCalls = ctx.sqs.sendMessage.getCalls().map((c) => c.args[1]?.type);
      expect(sqsCalls).to.not.include('scrape-top-pages');
      expect(sqsCalls).to.include('cwv');
    });

    it('does not enqueue audit to SQS when its opportunity is fresh', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.dataAccess.Opportunity.allBySiteId.resolves([
        { getType: () => 'cwv', getUpdatedAt: () => recentDate },
      ]);

      await runEphemeralRunBatch(['s-1'], { audits: { types: ['cwv', 'meta-tags'] } }, ctx);

      const sqsCalls = ctx.sqs.sendMessage.getCalls().map((c) => c.args[1]?.type);
      expect(sqsCalls).to.not.include('cwv');
      // meta-tags opportunity is not fresh → should be enqueued
      expect(sqsCalls).to.include('meta-tags');
    });

    it('enqueues all audits for a specific site when it appears in forceRunSiteIds', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.dataAccess.LatestAudit.allBySiteIdAndAuditType.resolves([
        { getAuditedAt: () => recentDate },
      ]);
      ctx.dataAccess.Opportunity.allBySiteId.resolves([
        { getType: () => 'cwv', getUpdatedAt: () => recentDate },
      ]);

      await runEphemeralRunBatch(
        ['s-1'],
        { audits: { types: ['scrape-top-pages', 'cwv'] }, forceRunSiteIds: ['s-1'] },
        ctx,
      );

      expect(ctx.scrapeClient.createScrapeJob).to.have.been.called;
      const sqsCalls = ctx.sqs.sendMessage.getCalls().map((c) => c.args[1]?.type);
      expect(sqsCalls).to.not.include('scrape-top-pages');
      expect(sqsCalls).to.include('cwv');
    });

    it('applies freshness skip for sites NOT in forceRunSiteIds', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.dataAccess.Opportunity.allBySiteId.resolves([
        { getType: () => 'cwv', getUpdatedAt: () => recentDate },
      ]);

      // s-1 is NOT in forceRunSiteIds — freshness check applies
      await runEphemeralRunBatch(
        ['s-1'],
        { audits: { types: ['cwv'] }, forceRunSiteIds: ['s-99'] },
        ctx,
      );

      const sqsCalls = ctx.sqs.sendMessage.getCalls().map((c) => c.args[1]?.type);
      expect(sqsCalls).to.not.include('cwv');
    });

    it('global forceRun=true overrides forceRunSiteIds — all sites bypass freshness', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.dataAccess.Opportunity.allBySiteId.resolves([
        { getType: () => 'cwv', getUpdatedAt: () => recentDate },
      ]);

      // forceRun=true, forceRunSiteIds omitted (irrelevant) — all sites still bypass
      await runEphemeralRunBatch(
        ['s-1'],
        { audits: { types: ['cwv'] }, forceRun: true },
        ctx,
      );

      // freshness DB call should not have been made
      expect(ctx.dataAccess.LatestAudit.allBySiteIdAndAuditType).to.not.have.been.called;
      expect(ctx.dataAccess.Opportunity.allBySiteId).to.not.have.been.called;
      const sqsCalls = ctx.sqs.sendMessage.getCalls().map((c) => c.args[1]?.type);
      expect(sqsCalls).to.include('cwv');
    });
  });

  // -----------------------------------------------------------------------
  // runEphemeralRunBatch
  // -----------------------------------------------------------------------
  describe('runEphemeralRunBatch()', () => {
    it('enables imports/audits, enqueues jobs, and schedules teardowns inline', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      const result = await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        audits: { types: ['lhs-mobile'] },
      }, ctx);

      expect(result.batchId).to.be.a('string');
      expect(result.total).to.equal(1);
      expect(site.setConfig).to.have.been.called;
      expect(site.save).to.have.been.called;
      expect(config.save).to.have.been.called;
      // Import jobs enqueued directly
      expect(ctx.sqs.sendMessage).to.have.been.called;
      // Teardown scheduled
      expect(sfnSendStub).to.have.been.called;
      // Site result written to S3
      const putCalls = ctx.s3.s3Client.send.getCalls().filter(
        (c) => c.args[0].input?.Key?.includes('results/s-1.json'),
      );
      expect(putCalls).to.have.length.greaterThan(0);
      const body = JSON.parse(putCalls[0].args[0].input.Body);
      expect(body.status).to.equal('completed');
    });

    it('single-site insights-report-default sends bulk teardown SFN input', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { preset: 'insights-report-default' }, ctx);

      expect(sfnSendStub).to.have.been.called;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input).to.have.keys('bulkDisableJob', 'workflowWaitTime');
      expect(input.bulkDisableJob.type).to.equal('bulk-disable-import-audit-processor');
      expect(input.bulkDisableJob.sites).to.be.an('array').with.length(1);
      expect(input.bulkDisableJob.sites[0].siteId).to.equal('s-1');
    });

    it('does not schedule teardown when nothing is newly enabled', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {}, ctx);

      expect(sfnSendStub).to.not.have.been.called;
    });

    it('uses WORKFLOW_WAIT_TIME_IN_SECONDS when teardown delaySeconds is 0 (imports)', async () => {
      const ctx = createMockContext();
      ctx.env.WORKFLOW_WAIT_TIME_IN_SECONDS = 7200;
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        teardown: { delaySeconds: 0 },
      }, ctx);

      const sfnInput = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(sfnInput.workflowWaitTime).to.equal(7200);
    });

    it('logs when teardown state machine ARN is missing (EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN unset)', async () => {
      const ctx = createMockContext();
      delete ctx.env.EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN;
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { imports: { types: ['top-pages'] } }, ctx);

      expect(sfnSendStub).to.not.have.been.called;
      expect(ctx.log.error).to.have.been.calledWithMatch(/failed to schedule teardown/);
    });

    it('deduplicates siteIds', async () => {
      const ctx = createMockContext();
      ctx.dataAccess.Site.findById.resolves(createMockSite());
      ctx.dataAccess.Configuration.findLatest.resolves(createMockConfiguration());

      const result = await runEphemeralRunBatch(['s-1', 's-1', 's-2'], {}, ctx);

      expect(result.total).to.equal(2);
    });

    it('caps at MAX_BATCH_SITES', async () => {
      const ctx = createMockContext();
      ctx.dataAccess.Site.findById.resolves(createMockSite());
      ctx.dataAccess.Configuration.findLatest.resolves(createMockConfiguration());
      const ids = Array.from({ length: MAX_BATCH_SITES + 1 }, (_, i) => `s-${i}`);

      const result = await runEphemeralRunBatch(ids, {}, ctx);

      expect(result.total).to.equal(MAX_BATCH_SITES);
    });

    it('writes not_found for missing sites', async () => {
      const ctx = createMockContext();
      ctx.dataAccess.Site.findById.resolves(null);
      ctx.dataAccess.Configuration.findLatest.resolves(createMockConfiguration());

      await runEphemeralRunBatch(['s-missing'], {}, ctx);

      const putCall = ctx.s3.s3Client.send.getCalls().find(
        (c) => c.args[0].input?.Key?.includes('results/s-missing.json'),
      );
      expect(putCall).to.exist;
      const body = JSON.parse(putCall.args[0].input.Body);
      expect(body.status).to.equal('not_found');
    });

    it('rolls back imports when config save fails', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      config.save.rejects(new Error('DB down'));
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      const result = await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
      }, ctx);

      expect(result.batchId).to.be.a('string');
      // site.save called twice: once for enable, once for rollback
      expect(site.save.callCount).to.be.greaterThanOrEqual(2);
    });

    it('handles rollback failure when config save and site rollback both fail', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      config.save.rejects(new Error('DB down'));
      site.save.onFirstCall().resolves();
      site.save.onSecondCall().rejects(new Error('Rollback failed'));
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
      }, ctx);

      const rollbackError = ctx.log.error.getCalls().find(
        (c) => c.args[0].includes('rollback'),
      );
      expect(rollbackError).to.exist;
    });

    it('handles site enable failure gracefully', async () => {
      const ctx = createMockContext();
      ctx.dataAccess.Site.findById.rejects(new Error('DB error'));
      ctx.dataAccess.Configuration.findLatest.resolves(createMockConfiguration());

      await runEphemeralRunBatch(['s-1'], {}, ctx);

      expect(ctx.s3.s3Client.send).to.have.been.called;
      const putCall = ctx.s3.s3Client.send.getCalls().find(
        (c) => c.args[0].input?.Key?.includes('results/s-1.json'),
      );
      expect(putCall).to.exist;
      const body = JSON.parse(putCall.args[0].input.Body);
      expect(body.status).to.equal('failed');
      expect(body.error.code).to.equal('SETUP_FAILURE');
      expect(body.error.details).to.equal('DB error');
    });

    it('writes SETUP_FAILURE details when thrown value is not an Error', async () => {
      const ctx = createMockContext();
      ctx.dataAccess.Site.findById.rejects('lookup failed');
      ctx.dataAccess.Configuration.findLatest.resolves(createMockConfiguration());

      await runEphemeralRunBatch(['s-1'], {}, ctx);

      const putCall = ctx.s3.s3Client.send.getCalls().find(
        (c) => c.args[0].input?.Key?.includes('results/s-1.json'),
      );
      const body = JSON.parse(putCall.args[0].input.Body);
      expect(body.error.details).to.equal('lookup failed');
    });

    it('handles enqueue failure gracefully and writes failed result', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.sqs.sendMessage.rejects(new Error('SQS down'));

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
      }, ctx);

      expect(ctx.log.error).to.have.been.called;
    });

    it('writes ENQUEUE_FAILURE when enqueueSiteJobs throws (e.g. log.error rethrows in inner catch)', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      ctx.sqs.sendMessage.rejects(new Error('SQS down'));
      ctx.log.error = sinon.stub().callsFake((msg) => {
        if (String(msg).includes('Failed to enqueue import')) {
          throw new Error('inner catch could not log');
        }
      });

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
      }, ctx);

      expect(ctx.log.error).to.have.been.calledWithMatch(/failed to enqueue jobs for site/);

      const putCall = ctx.s3.s3Client.send.getCalls().find(
        (c) => c.args[0].input?.Key?.includes('results/s-1.json'),
      );
      expect(putCall).to.exist;
      const body = JSON.parse(putCall.args[0].input.Body);
      expect(body.status).to.equal('failed');
      expect(body.error.code).to.equal('ENQUEUE_FAILURE');
    });

    it('uses env channelId and threadTs for SFN workflow and audit enqueue', async () => {
      const ctx = createMockContext();
      ctx.env.EPHEMERAL_RUN_WORKFLOW_SLACK_CHANNEL_ID = 'C-env';
      ctx.env.EPHEMERAL_RUN_WORKFLOW_SLACK_THREAD_TS = 'ts-env';
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        audits: { types: ['lhs-mobile'] },
      }, ctx);

      const auditCall = ctx.sqs.sendMessage.getCalls().find((c) => c.args[0] === 'audit-queue-url');
      expect(auditCall).to.exist;
      expect(auditCall.args[1].auditContext.slackContext).to.deep.equal({
        channelId: 'C-env',
        threadTs: 'ts-env',
      });

      expect(sfnSendStub).to.have.been.calledOnce;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.bulkDisableJob.taskContext.slackContext).to.deep.equal({
        channelId: 'C-env',
        threadTs: 'ts-env',
      });
    });

    it('uses INSIGHTS_WORKFLOW_SLACK_THREAD_TS when ephemeral thread env is unset', async () => {
      const ctx = createMockContext();
      delete ctx.env.EPHEMERAL_RUN_WORKFLOW_SLACK_THREAD_TS;
      ctx.env.INSIGHTS_WORKFLOW_SLACK_THREAD_TS = 'ts-insights';
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { audits: { types: ['lhs-mobile'] } }, ctx);

      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.bulkDisableJob.taskContext.slackContext.threadTs).to.equal('ts-insights');
    });

    it('payload slack field overrides env slack context', async () => {
      const ctx = createMockContext();
      ctx.env.EPHEMERAL_RUN_WORKFLOW_SLACK_CHANNEL_ID = 'C-env';
      ctx.env.EPHEMERAL_RUN_WORKFLOW_SLACK_THREAD_TS = 'ts-env';
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        audits: { types: ['lhs-mobile'] },
        slack: { channelId: 'C-payload', threadTs: 'ts-payload' },
      }, ctx);

      const auditCall = ctx.sqs.sendMessage.getCalls().find((c) => c.args[0] === 'audit-queue-url');
      expect(auditCall).to.exist;
      expect(auditCall.args[1].auditContext.slackContext).to.deep.equal({
        channelId: 'C-payload',
        threadTs: 'ts-payload',
      });

      expect(sfnSendStub).to.have.been.calledOnce;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.bulkDisableJob.taskContext.slackContext).to.deep.equal({
        channelId: 'C-payload',
        threadTs: 'ts-payload',
      });
    });

    it('uses EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN for teardown', async () => {
      const ctx = createMockContext();
      ctx.env.EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN = 'arn:aws:states:ephemeral';
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { audits: { types: ['lhs-mobile'] } }, ctx);

      expect(sfnSendStub.firstCall.args[0].input.stateMachineArn).to.equal('arn:aws:states:ephemeral');
    });

    it('logs when teardown delay resolves to a non-finite workflow wait time', async () => {
      const ctx = createMockContext();
      ctx.env.WORKFLOW_WAIT_TIME_IN_SECONDS = 3600;
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        teardown: { delaySeconds: NaN },
      }, ctx);

      expect(ctx.log.error).to.have.been.calledWithMatch(/failed to schedule teardown/);
    });

    it('schedules single bulk teardown when only imports were enabled', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        audits: { types: [] },
      }, ctx);

      expect(sfnSendStub).to.have.been.calledOnce;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.bulkDisableJob.sites[0].auditTypes).to.deep.equal([]);
      expect(input.bulkDisableJob.sites[0].importTypes).to.include('top-pages');
    });

    it('schedules single bulk teardown when only audits were enabled', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: [] },
        audits: { types: ['lhs-mobile'] },
      }, ctx);

      expect(sfnSendStub).to.have.been.calledOnce;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.bulkDisableJob.sites[0].importTypes).to.deep.equal([]);
      expect(input.bulkDisableJob.sites[0].auditTypes).to.include('lhs-mobile');
    });

    it('uses WORKFLOW_WAIT_TIME_IN_SECONDS for batch teardown when delay is 0', async () => {
      const ctx = createMockContext();
      ctx.env.WORKFLOW_WAIT_TIME_IN_SECONDS = 3600;
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        audits: { types: ['lhs-mobile'] },
        teardown: { delaySeconds: 0 },
      }, ctx);

      expect(sfnSendStub).to.have.been.calledOnce;
      const sfnInput = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(sfnInput.workflowWaitTime).to.equal(3600);
    });

    it('handles teardown scheduling failure gracefully', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      sfnSendStub.rejects(new Error('SFN down'));

      await runEphemeralRunBatch(['s-1'], { preset: 'insights-report-default' }, ctx);

      expect(ctx.log.error).to.have.been.called;
    });

    it('logs when delaySeconds is 0 but WORKFLOW_WAIT_TIME_IN_SECONDS is unset', async () => {
      const ctx = createMockContext();
      delete ctx.env.WORKFLOW_WAIT_TIME_IN_SECONDS;
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        teardown: { delaySeconds: 0 },
      }, ctx);

      expect(ctx.log.error).to.have.been.calledWithMatch(/failed to schedule teardown/);
    });

    it('logs when WORKFLOW_WAIT_TIME_IN_SECONDS is not a finite wait time', async () => {
      const ctx = createMockContext();
      ctx.env.WORKFLOW_WAIT_TIME_IN_SECONDS = 'not-a-number';
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], {
        imports: { types: ['top-pages'] },
        teardown: { delaySeconds: 0 },
      }, ctx);

      expect(ctx.log.error).to.have.been.calledWithMatch(/failed to schedule teardown/);
    });

    it('teardown sites list includes only newly-enabled sites — already-enabled sites excluded', async () => {
      const ctx = createMockContext();
      // site1 has top-pages already enabled → deltaEnableImports returns importsEnabled=[]
      const site1 = createMockSite('s-1', 'https://site1.com');
      site1.importsState.push({ type: 'top-pages', enabled: true });
      // site2 has nothing enabled → deltaEnableImports returns importsEnabled=['top-pages']
      const site2 = createMockSite('s-2', 'https://site2.com');
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById
        .onFirstCall().resolves(site1)
        .onSecondCall().resolves(site2);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1', 's-2'], { imports: { types: ['top-pages'] } }, ctx);

      expect(sfnSendStub).to.have.been.calledOnce;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      const teardownSites = input.bulkDisableJob.sites;
      // only site2 should appear — site1 was already enabled (importsEnabled=[])
      expect(teardownSites).to.have.length(1);
      expect(teardownSites[0].siteId).to.equal('s-2');
    });
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('constants', () => {
    it('exports PRESETS with insights-report-default', () => {
      expect(PRESETS).to.have.property('insights-report-default');
      expect(PRESETS['insights-report-default'].imports.types).to.be.an('array').that.is.not.empty;
      expect(PRESETS['insights-report-default'].imports.optionsByImportType).to.be.an('object');
      expect(PRESETS['insights-report-default'].imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(5);
      expect(PRESETS['insights-report-default'].audits.types).to.be.an('array').that.is.not.empty;
    });

    it('exports MAX_BATCH_SITES', () => {
      expect(MAX_BATCH_SITES).to.equal(1000);
    });
  });
});
