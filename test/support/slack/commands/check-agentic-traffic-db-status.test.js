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

import CheckAgenticTrafficDbStatusCommand from '../../../../src/support/slack/commands/check-agentic-traffic-db-status.js';

use(sinonChai);

describe('CheckAgenticTrafficDbStatusCommand', () => {
  let context;
  let slackContext;
  let postgrestStub;
  let configStub;

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
  const makeAudit = (auditResult) => ({
    getAuditResult: () => auditResult,
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
    };
    chain.select.returns(chain);
    chain.in.returns(chain);
    chain.eq.returns(chain);
    chain.order.resolves(result);
    return chain;
  };

  beforeEach(() => {
    postgrestStub = { from: sinon.stub() };
    configStub = { isHandlerEnabledForSite: sinon.stub().returns(true) };

    context = {
      dataAccess: {
        Site: { all: sinon.stub().resolves([]) },
        Configuration: { findLatest: sinon.stub().resolves(configStub) },
        services: { postgrestClient: postgrestStub },
      },
      log: { error: sinon.stub(), warn: sinon.stub() },
    };

    slackContext = { say: sinon.stub().resolves() };
  });

  afterEach(() => {
    sinon.restore();
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
      ':warning: Invalid date format. Use YYYY-MM-DD.',
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

  // ─── Per-site audit status paths ──────────────────────────────────────────

  it('reports no-audit for a site with no latest audit record', async () => {
    context.dataAccess.Site.all.resolves([makeSite('site-1', 'https://example.com', null)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('No audit record found');
    expect(output).to.include('https://example.com');
  });

  it('reports no-audit when the audit has no dailyAgenticExport field', async () => {
    const audit = makeAudit({ someOtherField: true });
    context.dataAccess.Site.all.resolves([makeSite('site-2', 'https://other.com', audit)]);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('No audit record found');
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
      data: [{
        correlation_id: 'batch-proj',
        scope_prefix: 'site-pr',
        output_count: 200,
        projected_at: '2026-04-22T08:30:00Z',
        skipped: false,
      }],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Projected');
    expect(output).to.include('https://projected.com');
    expect(output).to.include('200');
    expect(output).to.include('2026-04-22 08:30');
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

  it('handles projection_audit query error gracefully and treats site as pending', async () => {
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
    // Site is in pending because no projection data was found
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Pending');
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

  it('skips projection_audit query when the postgrest client is unavailable', async () => {
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

    // Site appears as pending since projection wasn't checked
    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Pending');
  });

  it('skips projection_audit query when postgrest client has no from method', async () => {
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
    expect(output).to.include('Pending');
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

  it('chunks output when the full report exceeds the Slack message limit', async () => {
    // 50 sites with no audit → generates a long "No audit record found" section
    const sites = Array.from({ length: 50 }, (_, i) => ({
      getId: () => `site-${i}`,
      getBaseURL: () => `https://very-long-url-for-site-number-${i}-that-pads-the-output.example.com`,
      getLatestAuditByAuditType: sinon.stub().resolves(null),
    }));
    context.dataAccess.Site.all.resolves(sites);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    // Expect more than 2 say() calls (header + chunks)
    expect(slackContext.say.callCount).to.be.greaterThan(2);
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

    context.dataAccess.Site.all.resolves([
      projectedSite, pendingSite, skippedSite, failedSite,
    ]);

    // Only batch-a is projected; batch-b has no row
    const chain = makePostgrestChain({
      data: [{
        correlation_id: 'batch-a',
        scope_prefix: 'site-proj',
        output_count: 100,
        projected_at: '2026-04-22T10:00:00Z',
        skipped: false,
      }],
      error: null,
    });
    postgrestStub.from.returns(chain);

    const cmd = CheckAgenticTrafficDbStatusCommand(context);
    await cmd.handleExecution(['2026-04-22'], slackContext);

    const output = slackContext.say.args.flat().join('\n');
    expect(output).to.include('Projected: *1*');
    expect(output).to.include('Pending: *1*');
    expect(output).to.include('Skipped: *1*');
    expect(output).to.include('Failed: *1*');
    expect(output).to.include('(4 sites total)');
  });
});
