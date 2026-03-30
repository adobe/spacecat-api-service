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
import { SFNClient } from '@aws-sdk/client-sfn';
import {
  resolvePayload,
  deltaEnableImports,
  deltaEnableAudits,
  enqueueSiteJobs,
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
    getImports: () => importsState,
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
    save: sinon.stub().resolves(),
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
      ...(dataAccessOverrides || {}),
    },
    sqs: { sendMessage: sinon.stub().resolves() },
    s3: {
      s3Client: { send: sinon.stub().resolves() },
      s3Bucket: 'test-bucket',
      PutObjectCommand: MockPutObjectCommand,
      GetObjectCommand: MockGetObjectCommand,
      ListObjectsV2Command: MockListObjectsV2Command,
    },
    env: {
      AUDIT_JOBS_QUEUE_URL: 'audit-queue-url',
      INSIGHTS_TEARDOWN_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:teardown',
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
    it('resolves plg-full preset with defaults', () => {
      const result = resolvePayload({ preset: 'plg-full' });
      expect(result.imports.types).to.deep.equal(PRESETS['plg-full'].imports.types);
      expect(result.audits.types).to.deep.equal(PRESETS['plg-full'].audits.types);
      expect(result.teardownDelaySeconds).to.equal(14400);
    });

    it('uses explicit types over preset', () => {
      const result = resolvePayload({
        preset: 'plg-full',
        imports: { types: ['top-pages'] },
        audits: { types: ['lhs-mobile'] },
      });
      expect(result.imports.types).to.deep.equal(['top-pages']);
      expect(result.audits.types).to.deep.equal(['lhs-mobile']);
    });

    it('uses empty arrays when no preset and no explicit types', () => {
      const result = resolvePayload({});
      expect(result.imports.types).to.deep.equal([]);
      expect(result.audits.types).to.deep.equal([]);
      expect(result.imports.trafficAnalysisWeeks).to.equal(0);
    });

    it('defaults trafficAnalysisWeeks when traffic-analysis is requested without weeks', () => {
      const result = resolvePayload({ imports: { types: ['traffic-analysis'] } });
      expect(result.imports.trafficAnalysisWeeks).to.equal(5);
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

    it('resolves plg-full traffic-analysis options from optionsByImportType', () => {
      const result = resolvePayload({ preset: 'plg-full' });
      expect(result.imports.types).to.include('traffic-analysis');
      expect(result.imports.trafficAnalysisWeeks).to.equal(5);
      expect(result.imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(5);
    });

    it('body optionsByImportType overrides preset traffic-analysis backfillWeeks', () => {
      const result = resolvePayload({
        preset: 'plg-full',
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
        preset: 'plg-full',
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

    it('uses explicit trafficAnalysisWeeks', () => {
      const result = resolvePayload({ imports: { trafficAnalysisWeeks: 3 } });
      expect(result.imports.trafficAnalysisWeeks).to.equal(3);
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
      const resolved = resolvePayload({ imports: { types: [], trafficAnalysisWeeks: 3 } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      const trafficEntries = result.enqueued.imports.filter((e) => e.type === 'traffic-analysis');
      expect(trafficEntries).to.have.length(3);
    });

    it('enqueues traffic-analysis import and default backfill when only type is traffic-analysis', async () => {
      const ctx = createMockContext();
      const config = createMockConfiguration();
      const resolved = resolvePayload({ imports: { types: ['traffic-analysis'] } });

      const result = await enqueueSiteJobs('s-1', resolved, config, ctx);

      const trafficEntries = result.enqueued.imports.filter((e) => e.type === 'traffic-analysis');
      expect(trafficEntries).to.have.length(6); // one import run + 5 default backfill weeks
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
      const resolved = resolvePayload({ imports: { types: [], trafficAnalysisWeeks: 2 } });

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

    it('single-site plg-full sends full onboard-shaped SFN input', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { preset: 'plg-full' }, ctx);

      expect(sfnSendStub).to.have.been.called;
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input).to.have.keys(
        'cwvDemoSuggestionsJob',
        'opportunityStatusJob',
        'disableImportAndAuditJob',
        'demoURLJob',
        'workflowWaitTime',
      );
      expect(input.disableImportAndAuditJob.type).to.equal('disable-import-audit-processor');
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

      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.workflowWaitTime).to.equal(7200);
    });

    it('uses fallback state machine ARN when primary teardown ARNs unset', async () => {
      const ctx = createMockContext();
      delete ctx.env.EPHEMERAL_RUN_TEARDOWN_STATE_MACHINE_ARN;
      delete ctx.env.INSIGHTS_TEARDOWN_STATE_MACHINE_ARN;
      ctx.env.ONBOARD_WORKFLOW_STATE_MACHINE_ARN = 'arn:fallback';
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { imports: { types: ['top-pages'] } }, ctx);

      const cmd = sfnSendStub.firstCall.args[0];
      expect(cmd.input.stateMachineArn).to.equal('arn:fallback');
    });

    it('logs and skips SFN teardown when site has no organization', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      site.getOrganizationId = () => null;
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);

      await runEphemeralRunBatch(['s-1'], { imports: { types: ['top-pages'] } }, ctx);

      expect(sfnSendStub).to.not.have.been.called;
      expect(ctx.log.error).to.have.been.calledWithMatch(/no organization/);
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
      const ids = Array.from({ length: 600 }, (_, i) => `s-${i}`);

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

    it('schedules single onboard-shaped teardown when only imports were enabled', async () => {
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
      expect(input.disableImportAndAuditJob.taskContext.auditTypes).to.deep.equal([]);
      expect(input.disableImportAndAuditJob.taskContext.importTypes).to.include('top-pages');
    });

    it('schedules single onboard-shaped teardown when only audits were enabled', async () => {
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
      expect(input.disableImportAndAuditJob.taskContext.importTypes).to.deep.equal([]);
      expect(input.disableImportAndAuditJob.taskContext.auditTypes).to.include('lhs-mobile');
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
      const input = JSON.parse(sfnSendStub.firstCall.args[0].input.input);
      expect(input.workflowWaitTime).to.equal(3600);
    });

    it('handles teardown scheduling failure gracefully', async () => {
      const ctx = createMockContext();
      const site = createMockSite();
      const config = createMockConfiguration();
      ctx.dataAccess.Site.findById.resolves(site);
      ctx.dataAccess.Configuration.findLatest.resolves(config);
      sfnSendStub.rejects(new Error('SFN down'));

      await runEphemeralRunBatch(['s-1'], { preset: 'plg-full' }, ctx);

      expect(ctx.log.error).to.have.been.called;
    });
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('constants', () => {
    it('exports PRESETS with plg-full', () => {
      expect(PRESETS).to.have.property('plg-full');
      expect(PRESETS['plg-full'].imports.types).to.be.an('array').that.is.not.empty;
      expect(PRESETS['plg-full'].imports.optionsByImportType).to.be.an('object');
      expect(PRESETS['plg-full'].imports.optionsByImportType['traffic-analysis'].backfillWeeks).to.equal(5);
      expect(PRESETS['plg-full'].audits.types).to.be.an('array').that.is.not.empty;
    });

    it('exports MAX_BATCH_SITES', () => {
      expect(MAX_BATCH_SITES).to.equal(600);
    });
  });
});
