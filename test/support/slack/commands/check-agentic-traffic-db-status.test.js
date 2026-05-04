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
import nock from 'nock';

import CheckAgenticTrafficDbStatusCommand from '../../../../src/support/slack/commands/check-agentic-traffic-db-status.js';

use(sinonChai);

describe('CheckAgenticTrafficDbStatusCommand', () => {
  let context;
  let slackContext;
  let postgrestStub;
  let configStub;
  const IMPORT_HANDLER = 'wrpc_import_agentic_traffic';
  const DAILY_REFRESH_HANDLER = 'wrpc_refresh_agentic_traffic_daily';
  const WEEKLY_REFRESH_HANDLER = 'wrpc_refresh_agentic_traffic_weekly';
  const TARGET_SITE_ID = '11111111-2222-3333-4444-555555555555';
  const OTHER_SITE_ID = '22222222-3333-4444-5555-555555555555';
  const MISSING_SITE_ID = '33333333-4444-5555-6666-555555555555';
  const DISABLED_SITE_ID = '44444444-5555-6666-7777-555555555555';

  /**
   * Build a minimal site mock. Pass `null` for latestAuditReturnValue to
   * simulate a site with no stored audit; pass an object to simulate an audit
   * record (with an optional `getAuditResult` method or a raw `auditResult`
   * property depending on how auditRecord is shaped).
   */
  const makeSite = (id, baseURL, latestAuditReturnValue) => ({
    getId: () => id,
    getBaseURL: () => baseURL,
    getLatestAuditByAuditType: sinon.stub().resolves(latestAuditReturnValue),
  });

  /** Wrap an auditResult object in the standard Active-Record style audit mock. */
  const makeAudit = (auditResult, auditedAt) => ({
    getAuditResult: () => auditResult,
    ...(auditedAt ? { getAuditedAt: () => auditedAt } : {}),
  });

  /**
   * Build the PostgREST fluent-query chain stub that resolves at `.order()`.
   * The `result` parameter is the resolved value `{ data, error }`.
   */
  const makePostgrestChain = (result) => {
    const chain = {
      select: sinon.stub(),
      in: sinon.stub(),
      eq: sinon.stub(),
      order: sinon.stub(),
      limit: sinon.stub(),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    chain.select.returns(chain);
    chain.in.returns(chain);
    chain.eq.returns(chain);
    chain.order.returns(chain);
    chain.limit.resolves(result);
    return chain;
  };

  const makeProjectionRow = ({
    correlationId = 'batch-1',
    handlerName = IMPORT_HANDLER,
    outputCount = 100,
    projectedAt = '2026-04-22T08:30:00Z',
    skipped = false,
    metadata = null,
    scopePrefix = 'site-1',
  } = {}) => ({
    correlation_id: correlationId,
    scope_prefix: scopePrefix,
    handler_name: handlerName,
    output_count: outputCount,
    projected_at: projectedAt,
    skipped,
    metadata,
  });

  const attachSlackClient = () => {
    slackContext.channelId = 'C123';
    slackContext.threadTs = '123.456';
    slackContext.client = {
      files: {
        getUploadURLExternal: sinon.stub().resolves({
          ok: true,
          upload_url: 'https://slack-upload.test/agentic-report',
          file_id: 'F123',
        }),
        completeUploadExternal: sinon.stub().resolves({ ok: true }),
      },
    };
  };

  beforeEach(() => {
    postgrestStub = { from: sinon.stub() };
    configStub = { isHandlerEnabledForSite: sinon.stub().returns(true) };

    context = {
      dataAccess: {
        Site: {
          all: sinon.stub().resolves([]),
          findById: sinon.stub().resolves(null),
        },
        Configuration: { findLatest: sinon.stub().resolves(configStub) },
        services: { postgrestClient: postgrestStub },
      },
      log: { error: sinon.stub(), warn: sinon.stub() },
    };

    postgrestStub.from.returns(makePostgrestChain({ data: [], error: null }));
    slackContext = { say: sinon.stub().resolves() };
  });

  afterEach(() => {
    sinon.restore();
    nock.cleanAll();
  });

  // ─── Metadata ────────────────────────────────────────────────────────────

  it('has the correct id and phrases', () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    expect(cmd.id).to.equal('check-agentic-traffic-db-status');
    expect(cmd.accepts('check agentic traffic db status')).to.be.true;
  });

  // ─── Date argument validation ─────────────────────────────────────────────

  it('warns on invalid date format that fails the regex', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['not-a-date'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Unrecognized argument. Expected YYYY-MM-DD or siteId=<UUID>.',
    );
  });

  it('warns when date matches regex but produces NaN', async () => {
    // '2026-99-99' passes \d{4}-\d{2}-\d{2} but new Date returns Invalid Date
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-99-99'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Invalid date format. Use YYYY-MM-DD.',
    );
  });

  it('warns when date matches regex but is not a real UTC calendar date', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-02-30'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Invalid date format. Use YYYY-MM-DD.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when the requested traffic date is in the future', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2099-01-01'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Cannot check a future traffic date.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when siteId is empty', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['siteId='], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: siteId must not be empty.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when siteId key is not a UUID', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['siteId=foo`<!channel>'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Invalid siteId. Expected UUID.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).not.to.have.been.called;
  });

  it('warns when duplicate date arguments are provided', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-21', '2026-04-22'], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Duplicate date argument.',
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
  });

  it('warns when duplicate siteId arguments are provided', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution([TARGET_SITE_ID, `siteId=${OTHER_SITE_ID}`], slackContext);
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Duplicate siteId argument.',
    );
    expect(context.dataAccess.Site.findById).not.to.have.been.called;
  });

  it('accepts a bare site UUID as single-site scope', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://uuid-target.com', null);
    context.dataAccess.Site.findById.resolves(targetSite);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', TARGET_SITE_ID], slackContext);

    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).to.have.been.calledWith(TARGET_SITE_ID);
    expect(targetSite.getLatestAuditByAuditType).to.have.been.calledOnce;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include(`for site \`${TARGET_SITE_ID}\``);
    expect(output).to.include('https://uuid-target.com');
  });

  it('ignores empty argument tokens and uses the default date', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution([''], slackContext);

    const firstArg = slackContext.say.getCall(0).args[0];
    expect(firstArg).to.include(':hourglass_flowing_sand:');
  });

  it('uses yesterday as the target date when no argument is provided', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution([], slackContext);

    // The first say call must mention the hourglass emoji (status check message)
    const firstArg = slackContext.say.getCall(0).args[0];
    expect(firstArg).to.include(':hourglass_flowing_sand:');
  });

  // ─── No enabled sites ─────────────────────────────────────────────────────

  it('reports when no sites have cdn-logs-report enabled', async () => {
    configStub.isHandlerEnabledForSite.returns(false);
    context.dataAccess.Site.all.resolves([
      makeSite('site-1', 'https://example.com', null),
    ]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('No sites have cdn-logs-report enabled');
  });

  it('filters the check to one requested siteId', async () => {
    const targetSite = makeSite(TARGET_SITE_ID, 'https://target.com', makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-target',
        rowCount: 50,
        classificationCount: 10,
      },
    }));
    context.dataAccess.Site.findById.resolves(targetSite);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-target',
          scopePrefix: TARGET_SITE_ID,
          outputCount: 60,
        }),
        makeProjectionRow({
          correlationId: 'batch-target:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: TARGET_SITE_ID,
          outputCount: 20,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', `siteId=${TARGET_SITE_ID}`], slackContext);

    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(context.dataAccess.Site.findById).to.have.been.calledWith(TARGET_SITE_ID);
    expect(targetSite.getLatestAuditByAuditType).to.have.been.calledOnce;
    expect(chain.in.firstCall.args[1]).to.deep.equal([
      'batch-target',
      'batch-target:daily-refresh',
      'batch-target:weekly-refresh',
    ]);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include(`for site \`${TARGET_SITE_ID}\``);
    expect(output).to.include('https://target.com');
    expect(output).to.include('Sites checked: *1*');
  });

  it('reports when the requested siteId is not found', async () => {
    context.dataAccess.Site.findById.resolves(null);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', `siteId=${MISSING_SITE_ID}`], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      `:warning: No site found with siteId \`${MISSING_SITE_ID}\`.`,
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('reports when the requested site does not have cdn-logs-report enabled', async () => {
    configStub.isHandlerEnabledForSite.returns(false);
    context.dataAccess.Site.findById.resolves(makeSite(DISABLED_SITE_ID, 'https://example.com', null));

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22', `siteId=${DISABLED_SITE_ID}`], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      `:information_source: Site \`${DISABLED_SITE_ID}\` does not have cdn-logs-report enabled.`,
    );
    expect(context.dataAccess.Site.all).not.to.have.been.called;
    expect(postgrestStub.from).not.to.have.been.called;
  });

  // ─── Per-site audit status paths ──────────────────────────────────────────

  it('reports no-audit for a site with no latest audit record', async () => {
    context.dataAccess.Site.all.resolves([makeSite('site-1', 'https://example.com', null)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('No audit record found');
    expect(output).to.include('https://example.com');
  });

  it('reports audit-without-export when the audit has no daily agentic export details', async () => {
    const audit = { getAuditResult: sinon.stub().returns(null) };
    context.dataAccess.Site.all.resolves([makeSite('site-2', 'https://other.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Audit without export details: *1*');
    expect(output).to.include('Audit found without daily agentic export details');
    expect(output).to.not.include('No audit record found');
    expect(output).to.include('https://other.com');
  });

  it('falls back to latestAudit.auditResult when getAuditResult is not a function', async () => {
    // Simulate an older audit record that stores auditResult as a plain property
    const auditWithoutMethod = {
      auditResult: {
        dailyAgenticExport: {
          success: true,
          trafficDate: '2026-04-22',
          batchId: 'batch-fallback',
          rowCount: 10,
          classificationCount: 2,
        },
      },
    };
    context.dataAccess.Site.all.resolves([
      makeSite('site-fb', 'https://fallback.com', auditWithoutMethod),
    ]);

    const chain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    // Site appears as pending (exported but no projection row)
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Pending');
    expect(output).to.include('batch-fallback');
  });

  it('reports skipped for a site whose export was skipped (no traffic data)', async () => {
    const audit = makeAudit({
      dailyAgenticExport: { skipped: true, success: true, trafficDate: '2026-04-22' },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-s', 'https://skipped.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Skipped');
    expect(output).to.include('https://skipped.com');
  });

  it('reports export-failed for a site whose export returned an error message', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: false,
        trafficDate: '2026-04-22',
        error: 'athena query timed out',
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-f', 'https://failed.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Export failures');
    expect(output).to.include('athena query timed out');
  });

  it('shows "unknown error" when export-failed has no error detail', async () => {
    const audit = makeAudit({
      dailyAgenticExport: { success: false, trafficDate: '2026-04-22' },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-ue', 'https://unk.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('unknown error');
  });

  it('reports date-mismatch when the latest audit covers a different date', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-21', // ← different from target 2026-04-22
        batchId: 'batch-old',
        rowCount: 80,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-dm', 'https://mismatch.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('different date');
    expect(output).to.include('2026-04-21');
    expect(output).to.include('https://mismatch.com');
  });

  it('uses the audit matching the requested traffic date when newer audits exist', async () => {
    const newerAudit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-23',
        batchId: 'batch-newer',
        rowCount: 999,
      },
    });
    const requestedDateAudit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-requested',
        rowCount: 120,
        classificationCount: 12,
      },
    });
    const site = makeSite('site-date-scope', 'https://date-scope.com', newerAudit);
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Audit = {
      allBySiteIdAndAuditType: sinon.stub().resolves([newerAudit, requestedDateAudit]),
    };

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-requested',
          scopePrefix: 'site-date-scope',
        }),
        makeProjectionRow({
          correlationId: 'batch-requested:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-date-scope',
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.dataAccess.Audit.allBySiteIdAndAuditType).to.have.been.calledWith(
      'site-date-scope',
      'cdn-logs-report',
      { order: 'desc', limit: 50 },
    );
    expect(site.getLatestAuditByAuditType).not.to.have.been.called;
    expect(chain.in.firstCall.args[1]).to.deep.equal([
      'batch-requested',
      'batch-requested:daily-refresh',
      'batch-requested:weekly-refresh',
    ]);
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready');
    expect(output).to.not.include('different date');
    expect(output).to.not.include('batch-newer');
  });

  it('uses dailyAgenticExports array entries to find the requested traffic date', async () => {
    const weeklyAudit = makeAudit({
      dailyAgenticExports: [
        {
          success: true,
          trafficDate: '2026-04-21',
          batchId: 'batch-array-old',
          rowCount: 20,
        },
        {
          success: true,
          trafficDate: '2026-04-22',
          batchId: 'batch-array-requested',
          rowCount: 120,
          classificationCount: 12,
        },
      ],
    });
    const site = makeSite('site-array-date', 'https://array-date.com', null);
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Audit = {
      allBySiteIdAndAuditType: sinon.stub().resolves([weeklyAudit]),
    };

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-array-requested',
          scopePrefix: 'site-array-date',
          outputCount: 132,
        }),
        makeProjectionRow({
          correlationId: 'batch-array-requested:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-array-date',
          outputCount: 40,
          metadata: { dailyRefreshDates: ['2026-04-22'] },
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(chain.in.firstCall.args[1]).to.deep.equal([
      'batch-array-requested',
      'batch-array-requested:daily-refresh',
      'batch-array-requested:weekly-refresh',
    ]);
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready: *1*');
    expect(output).to.include('120 traffic rows / 12 classifications');
    expect(output).to.not.include('batch-array-old');
    expect(output).to.not.include('No audit record found');
  });

  it('falls back to the newest fetched audit when no fetched audit matches the requested traffic date', async () => {
    const latestAudit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-23',
        batchId: 'batch-newest',
        rowCount: 999,
      },
    });
    const site = makeSite('site-latest-fallback', 'https://latest-fallback.com', null);
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Audit = {
      allBySiteIdAndAuditType: sinon.stub().resolves([latestAudit]),
    };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(site.getLatestAuditByAuditType).not.to.have.been.called;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Latest audit is for a different date');
    expect(output).to.include('latest export was for 2026-04-23');
  });

  it('reports no-audit when the date-scoped audit lookup returns no rows', async () => {
    const site = makeSite('site-empty-audits', 'https://empty-audits.com', null);
    context.dataAccess.Site.all.resolves([site]);
    context.dataAccess.Audit = {
      allBySiteIdAndAuditType: sinon.stub().resolves(null),
    };

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(site.getLatestAuditByAuditType).not.to.have.been.called;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('No audit record found');
    expect(output).to.include('https://empty-audits.com');
  });

  // ─── Projection status ────────────────────────────────────────────────────

  it('reports pending for an exported site not yet found in projection_audit', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-pend',
        rowCount: 150,
        classificationCount: 40,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-p', 'https://pending.com', audit)]);

    // projection_audit returns no matching row
    const chain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Pending');
    expect(output).to.include('batch-pend');
    expect(output).to.include('150');
  });

  it('does not mark an old traffic date stale when a DB backfill audit ran recently', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-28T12:00:00Z').getTime());
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-15',
        batchId: 'batch-recent-backfill',
        rowCount: 150,
        classificationCount: 40,
      },
    }, '2026-04-28T11:30:00Z');
    context.dataAccess.Site.all.resolves([makeSite('site-rb', 'https://recent-backfill.com', audit)]);

    const chain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-15'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('import daily: pending');
    expect(output).not.to.include('import daily: stale pending');
  });

  it('ignores projection rows whose scope_prefix belongs to another site', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-scope-mismatch',
        rowCount: 88,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-sm', 'https://scope-mismatch.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-scope-mismatch',
          scopePrefix: 'other-site',
          outputCount: 99,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.warn).to.have.been.calledWith(
      sinon.match('Ignoring projection_audit row with mismatched scope_prefix'),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Import Pending: *1*');
    expect(output).to.include('batch-scope-mismatch');
  });

  it('reports exported sites that are missing batchId', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-nb', 'https://no-batch.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Missing batchId: *1*');
    expect(output).to.include('Export missing batchId');
    expect(output).to.include('unknown traffic rows');
  });

  it('keeps import pending fresh when the audit timestamp is invalid', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-22T13:00:00Z').getTime());
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-invalid-audit-time',
        rowCount: 12,
      },
    }, 'not-a-date');
    context.dataAccess.Site.all.resolves([makeSite('site-it', 'https://invalid-time.com', audit)]);

    const chain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('import daily: pending');
    expect(output).not.to.include('import daily: stale pending');
  });

  it('marks missing raw import as stale pending after the lag threshold', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-22T13:00:00Z').getTime());
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-stale-import',
        rowCount: 150,
        classificationCount: 40,
      },
    }, '2026-04-22T08:30:00Z');
    context.dataAccess.Site.all.resolves([makeSite('site-sp', 'https://stale-pending.com', audit)]);

    const chain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Stale Pending: *1*');
    expect(output).to.include('import daily: stale pending (>4h)');
    expect(output).to.include('batch-stale-import');
  });

  it('shows weekly refresh waiting on import for closed Sunday import pending sites', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-19',
        batchId: 'batch-sunday-pending',
        rowCount: 150,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-sw', 'https://sunday-pending.com', audit)]);

    const chain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-19'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('weekly refresh: waiting on import');
    expect(output).to.include('batch-sunday-pending');
  });

  it('reports projected for an exported site whose batchId is in projection_audit', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-proj',
        rowCount: 200,
        classificationCount: 55,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-pr', 'https://projected.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-proj',
          scopePrefix: 'site-pr',
          outputCount: 255,
          projectedAt: '2026-04-22T08:30:00Z',
        }),
        makeProjectionRow({
          correlationId: 'batch-proj:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-pr',
          outputCount: 80,
          projectedAt: '2026-04-22T08:35:00Z',
          metadata: { dailyRefreshDates: ['2026-04-22'], dailyRefreshRows: 80 },
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready');
    expect(output).to.include('https://projected.com');
    expect(output).to.include('255');
    expect(output).to.include('daily refresh: projected (80 rows (2026-04-22))');
    expect(output).to.include('2026-04-22 08:30');
  });

  it('checks projection_audit directly when batchId is provided', async () => {
    const site = makeSite(TARGET_SITE_ID, 'https://wknd.site', null);
    context.dataAccess.Site.findById.resolves(site);
    const batchId = '7c12d8c3-d845-43c0-bc09-aec50f96f38b';

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: batchId,
          scopePrefix: TARGET_SITE_ID,
          outputCount: 46,
          projectedAt: '2026-05-04T10:07:14.098Z',
        }),
        makeProjectionRow({
          correlationId: `${batchId}:daily-refresh`,
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: TARGET_SITE_ID,
          outputCount: 29,
          projectedAt: '2026-05-04T10:07:14.740Z',
          metadata: { dailyRefreshDates: ['2026-05-03'], dailyRefreshRows: 29 },
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution([`batchId=${batchId}`], slackContext);

    expect(context.dataAccess.Configuration.findLatest).not.to.have.been.called;
    expect(chain.in.firstCall.args).to.deep.equal([
      'correlation_id',
      [batchId, `${batchId}:daily-refresh`, `${batchId}:weekly-refresh`],
    ]);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include(`Agentic Traffic Projection Status — ${batchId}`);
    expect(output).to.include('Outcome: *RAW_IMPORT_AND_DAILY_REFRESH_PROJECTED*');
    expect(output).to.include('baseURL: `https://wknd.site`');
    expect(output).to.include('raw import: projected (46 rows at 2026-05-04 10:07)');
    expect(output).to.include('daily refresh: projected (29 rows (2026-05-03))');
  });

  it('warns when duplicate batchId arguments are provided', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-a', 'batchId=batch-b'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(':warning: Duplicate batchId argument.');
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('warns when batchId is empty or malformed', async () => {
    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId='], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: Invalid batchId. Expected a non-empty correlation ID.',
    );
    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('reports projection_audit query errors for direct batchId checks', async () => {
    const chain = makePostgrestChain({
      data: null,
      error: { message: 'projection unavailable' },
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-error'], slackContext);

    expect(context.log.warn).to.have.been.calledWith(
      sinon.match('projection_audit batchId query failed'),
    );
    expect(slackContext.say).to.have.been.calledWith(
      ':warning: projection_audit query failed: projection unavailable',
    );
  });

  it('reports unavailable PostgREST for direct batchId checks', async () => {
    context.dataAccess.services = {};

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-unavailable'], slackContext);

    expect(slackContext.say).to.have.been.calledWith(
      ':warning: PostgREST client is unavailable; cannot check projection_audit.',
    );
  });

  it('reports raw-import-only direct batchId checks', async () => {
    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-raw-only',
          scopePrefix: TARGET_SITE_ID,
          outputCount: 10,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);
    context.dataAccess.Site.findById.rejects(new Error('lookup failed'));

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-raw-only'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *RAW_IMPORT_PROJECTED*');
    expect(output).to.include(`siteId: \`${TARGET_SITE_ID}\``);
    expect(output).to.include('daily refresh: pending');
  });

  it('reports no rows for direct batchId checks with an unknown batch', async () => {
    const chain = makePostgrestChain({ data: null, error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-missing'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *IMPORT_NOT_FOUND*');
    expect(output).to.include('siteId: unknown');
    expect(output).to.include('Rows found: *0*');
  });

  it('uses refresh rows to show siteId in direct batchId checks when raw import is missing', async () => {
    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-refresh-only:weekly-refresh',
          handlerName: WEEKLY_REFRESH_HANDLER,
          scopePrefix: TARGET_SITE_ID,
          outputCount: 4,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-refresh-only'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *IMPORT_NOT_FOUND*');
    expect(output).to.include(`siteId: \`${TARGET_SITE_ID}\``);
    expect(output).to.include('weekly refresh: projected (4 rows)');
  });

  it('uses daily refresh rows to show siteId in direct batchId checks when raw import is missing', async () => {
    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-daily-only:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: TARGET_SITE_ID,
          outputCount: 7,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['batchId=batch-daily-only'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Outcome: *IMPORT_NOT_FOUND*');
    expect(output).to.include(`siteId: \`${TARGET_SITE_ID}\``);
    expect(output).to.include('daily refresh: projected (7 rows)');
  });

  it('batches projection_audit correlation ID lookups for large all-site checks', async () => {
    const sites = Array.from({ length: 26 }, (_, i) => makeSite(
      `site-batch-${i}`,
      `https://batch-${i}.com`,
      makeAudit({
        dailyAgenticExport: {
          success: true,
          trafficDate: '2026-04-22',
          batchId: `batch-${i}`,
          rowCount: 10,
        },
      }),
    ));
    context.dataAccess.Site.all.resolves(sites);

    const firstChain = makePostgrestChain({ data: [], error: null });
    const secondChain = makePostgrestChain({ data: [], error: null });
    postgrestStub.from.onFirstCall().returns(firstChain);
    postgrestStub.from.onSecondCall().returns(secondChain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(postgrestStub.from).to.have.been.calledTwice;
    expect(firstChain.in.firstCall.args[1]).to.have.length(75);
    expect(secondChain.in.firstCall.args[1]).to.have.length(3);
    expect(firstChain.in.secondCall.args[1]).to.deep.equal([
      IMPORT_HANDLER,
      DAILY_REFRESH_HANDLER,
      WEEKLY_REFRESH_HANDLER,
    ]);
  });

  it('formats missing and invalid projection timestamps explicitly', async () => {
    const missingTimeAudit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-missing-time',
        rowCount: 21,
      },
    });
    const invalidTimeAudit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-invalid-time',
        rowCount: 22,
      },
    });
    context.dataAccess.Site.all.resolves([
      makeSite('site-mt', 'https://missing-time.com', missingTimeAudit),
      makeSite('site-bt', 'https://bad-time.com', invalidTimeAudit),
    ]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-missing-time',
          scopePrefix: 'site-mt',
          projectedAt: null,
        }),
        makeProjectionRow({
          correlationId: 'batch-missing-time:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-mt',
        }),
        makeProjectionRow({
          correlationId: 'batch-invalid-time',
          scopePrefix: 'site-bt',
          projectedAt: 'not-a-time',
        }),
        makeProjectionRow({
          correlationId: 'batch-invalid-time:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-bt',
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('at unknown time');
    expect(output).to.include('at not-a-time');
    expect(output).to.include('21 traffic rows');
  });

  it('reports refresh pending when raw import is projected but daily refresh is missing', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-refresh-pending',
        rowCount: 200,
        classificationCount: 55,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-rp', 'https://refresh-pending.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-refresh-pending',
          scopePrefix: 'site-rp',
          outputCount: 255,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Refresh Pending: *1*');
    expect(output).to.include('missing: daily refresh');
    expect(output).to.include('batch-refresh-pending');
  });

  it('reports skipped daily refresh as refresh pending', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-refresh-skipped',
        rowCount: 200,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-rs', 'https://refresh-skipped.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-refresh-skipped',
          scopePrefix: 'site-rs',
        }),
        makeProjectionRow({
          correlationId: 'batch-refresh-skipped:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-rs',
          skipped: true,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('daily refresh: skipped');
    expect(output).to.include('missing: daily refresh');
  });

  it('marks missing daily refresh as stale pending when raw import is old enough', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-22T13:00:00Z').getTime());
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-refresh-stale',
        rowCount: 200,
        classificationCount: 55,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-rps', 'https://refresh-stale.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-refresh-stale',
          scopePrefix: 'site-rps',
          outputCount: 255,
          projectedAt: '2026-04-22T08:30:00Z',
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Stale Pending: *1*');
    expect(output).to.include('daily refresh: stale pending (>4h)');
    expect(output).to.include('missing: daily refresh (stale)');
  });

  it('checks weekly refresh for closed Sunday exports', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-19',
        batchId: 'batch-sunday',
        rowCount: 120,
        classificationCount: 30,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-sun', 'https://sunday.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-sunday',
          scopePrefix: 'site-sun',
          outputCount: 150,
        }),
        makeProjectionRow({
          correlationId: 'batch-sunday:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-sun',
          outputCount: 42,
          metadata: { dailyRefreshDates: ['2026-04-19'] },
        }),
        makeProjectionRow({
          correlationId: 'batch-sunday:weekly-refresh',
          handlerName: WEEKLY_REFRESH_HANDLER,
          scopePrefix: 'site-sun',
          outputCount: 99,
          metadata: { weeklyRefreshWeeks: ['2026-04-13'] },
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-19'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Refresh weekly: *1/1*');
    expect(output).to.include('weekly refresh: projected (99 rows (2026-04-13))');
  });

  it('marks missing weekly refresh as stale pending for closed Sunday exports', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-04-22T13:00:00Z').getTime());
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-19',
        batchId: 'batch-weekly-stale',
        rowCount: 120,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-ws', 'https://weekly-stale.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-weekly-stale',
          scopePrefix: 'site-ws',
          projectedAt: '2026-04-22T08:30:00Z',
        }),
        makeProjectionRow({
          correlationId: 'batch-weekly-stale:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-ws',
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-19'], slackContext);
    clock.restore();

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Refresh weekly: *0/1*');
    expect(output).to.include('weekly refresh: stale pending (>4h)');
    expect(output).to.include('missing: weekly refresh (stale)');
  });

  it('reports dashboard-ready with daily refresh disabled', async () => {
    context.env = { MYSTICAT_AGENTIC_REFRESH_ENABLED: 'false' };
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-refresh-disabled',
        rowCount: 80,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-rd', 'https://refresh-disabled.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-refresh-disabled',
          scopePrefix: 'site-rd',
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready: *1*');
    expect(output).to.include('daily refresh: disabled');
    expect(output).to.include('Projector refresh enqueue appears disabled');
  });

  it('reports refresh pending with daily refresh disabled when weekly refresh is skipped', async () => {
    context.env = { MYSTICAT_AGENTIC_REFRESH_ENABLED: 'false' };
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-disabled-weekly-skipped',
        rowCount: 80,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-dws', 'https://disabled-weekly-skipped.com', audit)]);

    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-disabled-weekly-skipped',
          scopePrefix: 'site-dws',
        }),
        makeProjectionRow({
          correlationId: 'batch-disabled-weekly-skipped:weekly-refresh',
          handlerName: WEEKLY_REFRESH_HANDLER,
          scopePrefix: 'site-dws',
          skipped: true,
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Refresh Pending: *1*');
    expect(output).to.include('daily refresh: disabled');
    expect(output).to.include('weekly refresh: skipped');
  });

  it('treats null projRows with no error the same as an empty result (|| [] fallback)', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-null-rows',
        rowCount: 60,
        classificationCount: 10,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-nr', 'https://nullrows.com', audit)]);

    // PostgREST returns {data: null, error: null} — exercises the `projRows || []` fallback
    const chain = makePostgrestChain({ data: null, error: null });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    // projectionMap stays empty → site is pending
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Pending');
  });

  it('handles projection_audit query error gracefully and reports projection status as unknown', async () => {
    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-qerr',
        rowCount: 100,
        classificationCount: 20,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-qe', 'https://qerr.com', audit)]);

    const chain = makePostgrestChain({ data: null, error: { message: 'db connection lost' } });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.warn).to.have.been.calledWith(
      sinon.match('projection_audit query failed'),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Unknown: *1*');
    expect(output).to.include('projection audit check: error');
    expect(output).to.include('Import daily: unknown (projection audit check error)');
  });

  it('skips projection_audit query when no sites have exportable batchIds', async () => {
    // Only a skipped site → no exported entries → no batchIds
    const audit = makeAudit({
      dailyAgenticExport: { skipped: true, trafficDate: '2026-04-22' },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-sk', 'https://skip.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(postgrestStub.from).not.to.have.been.called;
  });

  it('reports unknown when the postgrest client is unavailable', async () => {
    context.dataAccess.services = {}; // no postgrestClient

    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-nopg',
        rowCount: 50,
        classificationCount: 5,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-np', 'https://nopg.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Unknown: *1*');
    expect(output).to.include('projection audit check: unavailable');
  });

  it('reports unknown when postgrest client has no from method', async () => {
    context.dataAccess.services = { postgrestClient: {} }; // client present but no .from

    const audit = makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-nofrom',
        rowCount: 30,
        classificationCount: 3,
      },
    });
    context.dataAccess.Site.all.resolves([makeSite('site-nf', 'https://nofrom.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Unknown: *1*');
    expect(output).to.include('projection audit check: unavailable');
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('handles per-site audit fetch errors and reports the site under export failures', async () => {
    const errSite = {
      getId: () => 'site-err',
      getBaseURL: () => 'https://errsite.com',
      getLatestAuditByAuditType: sinon.stub().rejects(new Error('network timeout')),
    };
    context.dataAccess.Site.all.resolves([errSite]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.warn).to.have.been.calledWith(
      sinon.match('Failed to read audit for site site-err'),
    );
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Export failures');
    expect(output).to.include('network timeout');
  });

  it('handles a top-level error gracefully', async () => {
    context.dataAccess.Site.all.rejects(new Error('catastrophic DB failure'));

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(context.log.error).to.have.been.called;
    // postErrorMessage calls say with an error message
    expect(slackContext.say).to.have.been.called;
  });

  // ─── Output chunking ──────────────────────────────────────────────────────

  it('caps long all-site detail lists and points to site-scoped checks', async () => {
    const sites = Array.from({ length: 50 }, (_, i) => ({
      getId: () => `site-${i}`,
      getBaseURL: () => `https://very-long-url-for-site-number-${i}-that-pads-the-output.example.com`,
      getLatestAuditByAuditType: sinon.stub().resolves(null),
    }));
    context.dataAccess.Site.all.resolves(sites);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('No `cdn-logs-report` audit has run for any of the *50* enabled sites');
    expect(output).to.include('… 42 more. Re-run with `siteId=<siteId>` for focused details.');
    expect(output).not.to.include('site-49');
  });

  it('splits a single oversized message line', async () => {
    const sites = [makeSite(
      'site-long-line',
      `https://${'a'.repeat(6200)}.example.com`,
      null,
    )];
    context.dataAccess.Site.all.resolves(sites);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(slackContext.say.callCount).to.be.greaterThan(3);
    expect(slackContext.say.args.flat().every((message) => message.length <= 2800)).to.be.true;
  });

  it('keeps compact all-site output in Slack and uploads the full report when details are omitted', async () => {
    attachSlackClient();
    nock('https://slack-upload.test')
      .post('/agentic-report')
      .reply(200, 'OK');
    const sites = Array.from({ length: 50 }, (_, i) => ({
      getId: () => `site-${i}`,
      getBaseURL: () => `https://very-long-url-for-site-number-${i}-that-pads-the-output.example.com`,
      getLatestAuditByAuditType: sinon.stub().resolves(null),
    }));
    context.dataAccess.Site.all.resolves(sites);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    expect(slackContext.say).to.have.been.called;
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('… 42 more. Re-run with `siteId=<siteId>` for focused details.');
    expect(output).not.to.include('site-49');
    expect(slackContext.client.files.getUploadURLExternal).to.have.been.calledOnce;
    expect(slackContext.client.files.completeUploadExternal).to.have.been.calledOnce;
    expect(slackContext.client.files.getUploadURLExternal.firstCall.args[0].filename)
      .to.equal('agentic-traffic-db-status-2026-04-22.txt');
    expect(slackContext.client.files.completeUploadExternal.firstCall.args[0].files[0].title)
      .to.equal('Agentic Traffic DB Status 2026-04-22');
    expect(nock.isDone()).to.be.true;
  });

  // ─── Mixed status summary ─────────────────────────────────────────────────

  it('shows correct summary counts for projected, pending, skipped, and failed sites', async () => {
    const projectedSite = makeSite('site-proj', 'https://projected.com', makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-a',
        rowCount: 100,
        classificationCount: 20,
      },
    }));
    const pendingSite = makeSite('site-pend', 'https://pending.com', makeAudit({
      dailyAgenticExport: {
        success: true,
        trafficDate: '2026-04-22',
        batchId: 'batch-b',
        rowCount: 75,
        classificationCount: 15,
      },
    }));
    const skippedSite = makeSite('site-skip', 'https://skipped.com', makeAudit({
      dailyAgenticExport: { skipped: true, trafficDate: '2026-04-22' },
    }));
    const failedSite = makeSite('site-fail', 'https://failed.com', makeAudit({
      dailyAgenticExport: { success: false, trafficDate: '2026-04-22', error: 'boom' },
    }));
    const noAuditSite = makeSite('site-no-audit', 'https://no-audit.com', null);

    context.dataAccess.Site.all.resolves([
      projectedSite, pendingSite, skippedSite, failedSite, noAuditSite,
    ]);

    // Only batch-a is projected; batch-b has no row
    const chain = makePostgrestChain({
      data: [
        makeProjectionRow({
          correlationId: 'batch-a',
          scopePrefix: 'site-proj',
          outputCount: 120,
          projectedAt: '2026-04-22T10:00:00Z',
        }),
        makeProjectionRow({
          correlationId: 'batch-a:daily-refresh',
          handlerName: DAILY_REFRESH_HANDLER,
          scopePrefix: 'site-proj',
          outputCount: 45,
          projectedAt: '2026-04-22T10:05:00Z',
        }),
      ],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Dashboard-ready: *1*');
    expect(output).to.include('Import Pending: *1*');
    expect(output).to.include('Skipped: *1*');
    expect(output).to.include('Failed: *1*');
    expect(output).to.include('1 site(s) have no latest audit record');
    expect(output).to.include('Sites checked: *5*');
  });
});
